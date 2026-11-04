// The owner list takes a "later" answer: a signed deferral hides a card until its return time,
// gives the returned card one more full answer window, and leaves a plain note for a blocked
// team's lead. These scenes are red first: the base build has no deferral, so every scene below
// fails at its first deferral until the record and its one deadline helper exist.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordDir, runMessages } from '../src/commands/messages.ts';
import { admitOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionRequestsFolder, admitTeamCreate, createTeamCreateRequest } from '../src/client/team-create.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { OWNER_PAGE_HTML, serveOwnerPage } from '../src/security/owner-page.ts';
import { verifyRecord } from '../src/send/record.ts';
import { keyOf, messageKeyOf } from '../src/store/keys.ts';
import { recordAt, testIo } from './helpers.ts';

const T0 = new Date('2026-11-04T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TTL_MS = 15 * MINUTE;
/** The ceiling the orchestrator's condition puts on a deferral: created_at + 7 days. */
const CAP_MS = 7 * DAY;

const made: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const b of made) rmSync(b, { recursive: true, force: true });
});

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  return {
    prompts,
    name: 'fake-credential-store',
    available: () => true,
    create: (label) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message, reason) => { prompts.push(reason); return keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }; },
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

/** A simulated platform passkey for rp `localhost`. */
function phone() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = Buffer.from('iphone-credential-0001').toString('base64url');
  const assert = (challenge: string) => {
    const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 7])]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' }));
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' });
    return { credentialId, authenticatorData: authData.toString('base64url'), clientDataJSON: clientData.toString('base64url'), signature: signature.toString('base64url') };
  };
  return { pair, credentialId, assert, spki: (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url') };
}

type Phone = ReturnType<typeof phone>;

/** The page on port 0 with an injected clock: every offset below is measured from T0. */
async function setup() {
  const base = realpathSync(mkdtempSync(join(process.cwd(), '.owner-later-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  const registered = registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store);
  if (!registered.ok) throw new Error(registered.why);
  let clock = T0.getTime();
  const now = () => new Date(clock);
  const page = await serveOwnerPage({ home, store, port: 0, now });
  servers.push(page.server);
  const call = async (method: string, path: string, body?: unknown, opts: { token?: string } = {}) => {
    const r = await fetch(`http://localhost:${page.port}${path}?t=${opts.token ?? page.token}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
  };
  return {
    base,
    home,
    store,
    page,
    call,
    now,
    at: (offset: number) => { clock = T0.getTime() + offset; },
  };
}

type Page = Awaited<ReturnType<typeof setup>>;
type CallResult = Awaited<ReturnType<Page['call']>>;

type LaterPayload = {
  kind: 'grant' | 'team-create' | 'owner-action';
  request_id: string;
  params_sha256: string;
  until: string;
  word: string;
  team: string | null;
  seat: 'owner';
  at: string;
};

type SignedLater = {
  owner_seat_later: LaterPayload;
  signer: string;
  signature: string;
  webauthn?: { authenticator_data: string; client_data_json: string };
};

type Assertion = { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };

type SeatModule = {
  ownerSeatLaterBytes: (later: LaterPayload) => Buffer;
  signOwnerLater: (home: string, later: LaterPayload, created: string, signer: string | undefined, store: OwnerSeatKeyStore, reason: string, assertion?: { authenticator_data: string; client_data_json: string; signature: string }) => { ok: true; signed: SignedLater } | { ok: false; why: string };
  verifyOwnerLater: (home: string, signed: SignedLater, store: OwnerSeatKeyStore, now?: Date) => { ok: true; later: LaterPayload } | { ok: false; why: string };
};

/** The signed later record is slice 2; until it exists the scene fails with this sentence. */
async function seatModule(): Promise<SeatModule> {
  const mod = (await import('../src/client/owner-seat.ts')) as unknown as Partial<SeatModule>;
  for (const name of ['ownerSeatLaterBytes', 'signOwnerLater', 'verifyOwnerLater'] as const) {
    if (typeof mod[name] !== 'function') throw new Error(`owner-seat.ts does not export ${name} yet: the signed later record is not built`);
  }
  return mod as SeatModule;
}

async function registerPhone(s: Page, p: Phone): Promise<CallResult> {
  const o = await s.call('POST', '/api/register/options');
  expect(o.status).toBe(200);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.body.challenge, origin: 'http://localhost' })).toString('base64url');
  return s.call('POST', '/api/register', { signer: 'iphone', credentialId: p.credentialId, publicKey: p.spki, clientDataJSON });
}

async function ready(s: Page): Promise<Phone> {
  const p = phone();
  const reg = await registerPhone(s, p);
  if (reg.status !== 200) throw new Error(`passkey registration refused: ${JSON.stringify(reg.body)}`);
  const wrote = writePolicySet(s.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: s.now() });
  if (!wrote.ok) throw new Error(wrote.why);
  return p;
}

function challenge(s: Page, p: Phone, id: string, word: string): Promise<CallResult> {
  return s.call('POST', '/api/team-create/challenge', { id, word, credentialId: p.credentialId });
}

async function answerWord(s: Page, p: Phone, id: string, word: string): Promise<{ probe: CallResult; done: CallResult | null }> {
  const probe = await challenge(s, p, id, word);
  if (probe.status !== 200) return { probe, done: null };
  const result = p.assert(String(probe.body.challenge));
  const done = await s.call('POST', '/api/team-create/answer', { ...result, id, word });
  return { probe, done };
}

async function deferOnce(s: Page, p: Phone, id: string): Promise<CallResult> {
  const { probe, done } = await answerWord(s, p, id, 'later');
  if (probe.status !== 200) throw new Error(`later refused at the challenge: ${probe.status} ${JSON.stringify(probe.body)}`);
  if (done === null) throw new Error('the challenge issued no answer');
  if (done.status !== 200) throw new Error(`later refused: ${done.status} ${JSON.stringify(done.body)}`);
  return done;
}

async function listed(s: Page): Promise<string[]> {
  const state = await s.call('GET', '/api/state');
  return (state.body.requests as Array<{ id: string }>).map((r) => r.id);
}

function tcRequest(s: Page, label = 'docs'): { root: string; id: string; params_sha256: string } {
  const root = join(s.base, 'code', label);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const created = createTeamCreateRequest(s.home, root, null, s.now());
  if (!created.ok) throw new Error(created.why);
  return { root, id: created.record.request_id, params_sha256: created.record.params_sha256 };
}

function oaRequest(s: Page, team: string, label: string): { root: string; id: string; params_sha256: string } {
  const root = join(s.base, 'code', label);
  mkdirSync(root, { recursive: true });
  const created = createOwnerActionRequest(s.home, { actions: ['team-up'], root, team, head: null, args: {}, requestedBy: 'seat:iris' }, s.now());
  if (!created.ok) throw new Error(created.why);
  return { root, id: created.record.request_id, params_sha256: created.record.params_sha256 };
}

const askOf = (root: string, team: string) => ({ action: 'team-up' as const, root, team, head: null, words: [], claim: false });

function laterOf(id: string, params: string, until: Date, team: string | null, at: Date): LaterPayload {
  return {
    kind: id.startsWith('oa_') ? 'owner-action' : 'team-create',
    request_id: id,
    params_sha256: params,
    until: until.toISOString(),
    word: 'later',
    team,
    seat: 'owner',
    at: at.toISOString(),
  };
}

const laterPath = (s: Page, id: string) => join(actionRequestsFolder(s.home), `${id}.later.json`);

function plant(s: Page, id: string, value: unknown): void {
  writeFileSync(laterPath(s, id), `${JSON.stringify(value, null, 2)}\n`);
}

/** A later record signed by the phone, exactly as a deferral at the page would sign it. */
async function handSign(s: Page, p: Phone, later: LaterPayload): Promise<SignedLater> {
  const seat = await seatModule();
  const challengeText = createHash('sha256').update(seat.ownerSeatLaterBytes(later)).digest('base64url');
  const assertion = p.assert(challengeText);
  return {
    owner_seat_later: later,
    signer: 'iphone',
    signature: Buffer.from(assertion.signature, 'base64url').toString('hex'),
    webauthn: { authenticator_data: assertion.authenticatorData, client_data_json: assertion.clientDataJSON },
  };
}

const TEAM_FILE = `format: 1
project: demo
coordinator: lead
operator: lead
session: demo
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** A registry team `demo` whose lead is `lead`, for the blocked-team note. */
function teamFixture(s: Page): { root: string; id: string } {
  const root = join(s.base, 'demo-team');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_FILE);
  const id = teamIdOf(root);
  writeFileSync(join(s.home, '.config', 'team', 'teams.yaml'), `teams:
  "${id}":
    project: demo
    project_id: null
    entity: demo
    session: demo
    root: ${root}
    lobby: ${join(s.base, 'lobby')}
    roster:
      - { agent: agt_111122223333, seat: lead, role: coordinator, leads: true }
      - { agent: agt_444455556666, seat: worker, role: builder }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }
`);
  return { root, id };
}

/** The note files in a drop folder: a record's name holds no dot; a receipt's does. */
const noteNames = (folder: string) => {
  try {
    return readdirSync(folder).filter((name) => !name.includes('.'));
  } catch {
    return [];
  }
};

describe('owner list: the later answer', () => {
  test('the word table: later is four hours, tomorrow and each weekday are 08:00 local', async () => {
    const mod = (await import('../src/client/emission.ts')) as unknown as { deferUntilOf?: (word: string, from: Date, zone?: string) => Date | null };
    const table = mod.deferUntilOf;
    if (table === undefined) throw new Error('emission.ts does not export deferUntilOf yet: the later words are not parsed');
    const from = new Date('2026-11-04T10:00:00.000Z');
    const iso = (value: Date | null) => value?.toISOString() ?? null;
    expect(iso(table('later', from, 'UTC'))).toBe('2026-11-04T14:00:00.000Z');
    expect(iso(table(' Later ', from, 'UTC'))).toBe('2026-11-04T14:00:00.000Z');
    expect(iso(table('tomorrow', from, 'UTC'))).toBe('2026-11-05T08:00:00.000Z');
    const days: Array<[string, string]> = [
      ['thursday', '2026-11-05T08:00:00.000Z'],
      ['friday', '2026-11-06T08:00:00.000Z'],
      ['saturday', '2026-11-07T08:00:00.000Z'],
      ['sunday', '2026-11-08T08:00:00.000Z'],
      ['monday', '2026-11-09T08:00:00.000Z'],
      ['tuesday', '2026-11-10T08:00:00.000Z'],
      ['wednesday', '2026-11-11T08:00:00.000Z'],
    ];
    for (const [word, want] of days) expect(iso(table(word, from, 'UTC'))).toBe(want);
    // A weekday word before that day's 08:00 means today, not a week from now.
    expect(iso(table('wednesday', new Date('2026-11-04T07:00:00.000Z'), 'UTC'))).toBe('2026-11-04T08:00:00.000Z');
    expect(table('someday', from, 'UTC')).toBeNull();
    expect(table('today', from, 'UTC')).toBeNull();
    // The table never reaches past the cap the orchestrator set.
    for (const word of ['later', 'tomorrow', ...days.map(([word]) => word)]) {
      expect(table(word, from, 'UTC')!.getTime()).toBeLessThanOrEqual(from.getTime() + CAP_MS);
    }
  });

  test('a later answer hides the card, returns it by itself and answers it past fifteen minutes', async () => {
    const s = await setup();
    const p = await ready(s);
    const tc = tcRequest(s);
    expect(await listed(s)).toEqual([tc.id]);
    const state = await s.call('GET', '/api/state');
    const card = (state.body.requests as Array<{ id: string; defer?: Record<string, string> }>)[0]!;
    expect(card.id).toBe(tc.id);
    // The card offers the three words and the exact return instant of the default one.
    expect(card.defer?.later).toBe(new Date(T0.getTime() + 4 * HOUR).toISOString());
    expect(OWNER_PAGE_HTML).toContain('data-w="later"');
    expect(OWNER_PAGE_HTML).toContain('data-w="tomorrow"');
    expect(OWNER_PAGE_HTML).toContain('data-w="monday"');
    expect(OWNER_PAGE_HTML).toContain('>Later<');

    const until = new Date(T0.getTime() + 4 * HOUR);
    const done = await deferOnce(s, p, tc.id);
    expect(done.body).toMatchObject({ ok: true, choice: 'later', until: until.toISOString() });

    // The record is a signed deferral, never an answer.
    const path = laterPath(s, tc.id);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(actionRequestsFolder(s.home), `${tc.id}.seat-answer.json`))).toBe(false);
    const seat = await seatModule();
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SignedLater;
    const verified = seat.verifyOwnerLater(s.home, parsed, s.store, s.now());
    if (!verified.ok) throw new Error(verified.why);
    expect(verified.later).toMatchObject({ kind: 'team-create', request_id: tc.id, params_sha256: tc.params_sha256, until: until.toISOString(), word: 'later', seat: 'owner' });

    // Hidden a minute later, and still hidden a second before the return.
    s.at(MINUTE);
    expect(await listed(s)).toEqual([]);
    s.at(4 * HOUR - 1000);
    expect(await listed(s)).toEqual([]);

    // Back by itself at the return instant.
    s.at(4 * HOUR);
    expect(await listed(s)).toEqual([tc.id]);
    expect((await challenge(s, p, tc.id, 'oui')).status).toBe(200);

    // One normal answer window after the return, then expired again.
    s.at(4 * HOUR + TTL_MS + MINUTE);
    const late = await challenge(s, p, tc.id, 'oui');
    expect(late.status).toBe(400);
    expect(String(late.body.error)).toContain('expired at');

    // The returned card is answerable although its original fifteen minutes are long gone.
    s.at(4 * HOUR);
    expect(await listed(s)).toEqual([tc.id]);
    const { done: answered } = await answerWord(s, p, tc.id, 'oui');
    expect(answered?.status).toBe(200);
    expect(existsSync(join(actionRequestsFolder(s.home), `${tc.id}.seat-answer.json`))).toBe(true);
    expect(admitTeamCreate(s.home, tc.id, tc.root, s.store, s.now())).toMatchObject({ ok: true, via: 'owner-seat', signer: 'iphone' });
  });

  test('a deferral is not an answer: nothing is approved, denied or spent', async () => {
    const s = await setup();
    const p = await ready(s);
    const tc = tcRequest(s);
    await deferOnce(s, p, tc.id);
    const folder = actionRequestsFolder(s.home);
    expect(existsSync(join(folder, `${tc.id}.seat-answer.json`))).toBe(false);
    expect(existsSync(join(folder, `${tc.id}.answer.json`))).toBe(false);
    expect(existsSync(join(folder, `${tc.id}.used`))).toBe(false);
    const seat = await seatModule();
    const parsed = JSON.parse(readFileSync(laterPath(s, tc.id), 'utf8')) as SignedLater;
    const verified = seat.verifyOwnerLater(s.home, parsed, s.store, s.now());
    if (!verified.ok) throw new Error(verified.why);
    expect(verified.later).toMatchObject({ kind: 'team-create', request_id: tc.id, params_sha256: tc.params_sha256, seat: 'owner' });
    expect(verified.later.team).toBeNull();
    const refused = admitTeamCreate(s.home, tc.id, tc.root, s.store, s.now());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('no verified owner-seat answer');
  });

  test('a forged, misbound or already-past later record hides nothing', async () => {
    const s = await setup();
    const p = await ready(s);
    const a = tcRequest(s, 'alpha');
    const b = tcRequest(s, 'beta');
    const until = new Date(T0.getTime() + 4 * HOUR);
    s.at(MINUTE);

    // Not a record at all.
    writeFileSync(laterPath(s, a.id), 'not a record\n');
    expect(await listed(s)).toEqual([a.id, b.id]);

    // A record-shaped file with no signature.
    plant(s, a.id, { owner_seat_later: laterOf(a.id, a.params_sha256, until, null, s.now()), signer: 'iphone', signature: '' });
    expect(await listed(s)).toEqual([a.id, b.id]);

    // A genuine signature, but bound to another request.
    plant(s, a.id, await handSign(s, p, laterOf(b.id, b.params_sha256, until, null, s.now())));
    expect(await listed(s)).toEqual([a.id, b.id]);

    // A genuine signature over another parameters hash.
    plant(s, a.id, await handSign(s, p, laterOf(a.id, 'f'.repeat(64), until, null, s.now())));
    expect(await listed(s)).toEqual([a.id, b.id]);

    // A genuine signature whose return instant is already past: it hides nothing and extends nothing.
    plant(s, a.id, await handSign(s, p, laterOf(a.id, a.params_sha256, new Date(T0.getTime() - HOUR), null, s.now())));
    expect(await listed(s)).toEqual([a.id, b.id]);
  });

  test('an expired item cannot be deferred, an unknown word names the words, and the cap refuses at sign time', async () => {
    const s = await setup();
    const p = await ready(s);
    const tc = tcRequest(s);
    s.at(TTL_MS + MINUTE);
    const late = await challenge(s, p, tc.id, 'later');
    expect(late.status).toBe(400);
    expect(String(late.body.error)).toContain('expired at');

    s.at(0);
    const second = tcRequest(s, 'docs-b');
    const someday = await challenge(s, p, second.id, 'someday');
    expect(someday.status).toBe(400);
    expect(String(someday.body.error)).toContain('later');
    expect(String(someday.body.error)).toContain('tomorrow');
    expect(String(someday.body.error)).toContain('monday');

    // A future word whose value would pass the cap is refused before any signature is made.
    const seat = await seatModule();
    const over = laterOf(second.id, second.params_sha256, new Date(T0.getTime() + CAP_MS + MINUTE), null, s.now());
    const refused = seat.signOwnerLater(s.home, over, new Date(T0.getTime() + MINUTE).toISOString(), 'iphone', s.store, 'later');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('7-day cap');
    expect(existsSync(laterPath(s, second.id))).toBe(false);
  });

  test('a stored later record past the cap hides until the cap and no further', async () => {
    const s = await setup();
    const p = await ready(s);
    const tc = tcRequest(s);
    // Signed by the owner's own passkey, so only the read-time cap can bound it.
    const until = new Date(T0.getTime() + 8 * DAY);
    const signed = await handSign(s, p, laterOf(tc.id, tc.params_sha256, until, null, s.now()));
    plant(s, tc.id, signed);
    const seat = await seatModule();
    const verified = seat.verifyOwnerLater(s.home, signed, s.store, s.now());
    if (!verified.ok) throw new Error(verified.why);
    expect(verified.later.until).toBe(until.toISOString());

    s.at(CAP_MS - MINUTE);
    expect(await listed(s)).toEqual([]);
    s.at(CAP_MS + MINUTE);
    expect(await listed(s)).toEqual([tc.id]);
    s.at(CAP_MS + TTL_MS + MINUTE);
    const late = await challenge(s, p, tc.id, 'oui');
    expect(late.status).toBe(400);
    expect(String(late.body.error)).toContain('expired at');

    s.at(CAP_MS + MINUTE);
    const { done } = await answerWord(s, p, tc.id, 'oui');
    expect(done?.status).toBe(200);
    expect(admitTeamCreate(s.home, tc.id, tc.root, s.store, s.now())).toMatchObject({ ok: true, via: 'owner-seat' });
  });

  test('the owner-action reader honours the extension and a forged record extends nothing', async () => {
    const s = await setup();
    const p = await ready(s);
    const oa = oaRequest(s, 'demo', 'work');
    expect(await listed(s)).toEqual([oa.id]);
    await deferOnce(s, p, oa.id);
    s.at(MINUTE);
    expect(await listed(s)).toEqual([]);
    s.at(4 * HOUR);
    expect(await listed(s)).toEqual([oa.id]);
    const { done } = await answerWord(s, p, oa.id, 'oui');
    expect(done?.status).toBe(200);
    expect(admitOwnerAction(s.home, oa.id, askOf(oa.root, 'demo'), s.store, s.now())).toMatchObject({ ok: true, via: 'owner-seat', signer: 'iphone' });

    // A second card a seat tries to defer by hand: the unsigned file hides nothing and extends nothing.
    s.at(0);
    const second = oaRequest(s, 'demo', 'work-two');
    plant(s, second.id, { owner_seat_later: laterOf(second.id, second.params_sha256, new Date(T0.getTime() + 4 * HOUR), 'demo', s.now()), signer: 'iphone', signature: '' });
    s.at(MINUTE);
    expect(await listed(s)).toEqual([second.id]);
    s.at(TTL_MS + 5 * MINUTE);
    expect(await listed(s)).toEqual([]);
    const { probe, done: refused } = await answerWord(s, p, second.id, 'oui');
    expect(probe.status).toBe(400);
    expect(String(probe.body.error)).toContain('expired at');
    expect(refused).toBeNull();
    const admit = admitOwnerAction(s.home, second.id, askOf(second.root, 'demo'), s.store, s.now());
    expect(admit.ok).toBe(false);
    if (!admit.ok) expect(admit.why).toContain('expired');
  });

  test('deferring a blocked team card leaves one verifiable note its lead reader shows as the owner page', async () => {
    const s = await setup();
    const p = await ready(s);
    const team = teamFixture(s);
    const oa = oaRequest(s, 'demo', 'work');
    const until = new Date(T0.getTime() + 4 * HOUR);
    const done = await deferOnce(s, p, oa.id);
    expect(done.body.until).toBe(until.toISOString());
    expect(String(done.body.notice ?? '')).toContain('lead of demo');

    const folder = recordDir(team.root, 'demo', 'lead');
    const notes = noteNames(folder);
    expect(notes).toHaveLength(1);
    const note = recordAt(join(folder, notes[0]!));
    expect(verifyRecord(note, messageKeyOf(s.home))).toBe(true);
    expect(note.payload).toMatchObject({
      from: 'owner page',
      from_id: null,
      rule: 'owner page',
      to: 'lead',
      root: team.root,
      session: 'demo',
      message_kind: 'blocked',
    });
    expect(note.payload.body).toContain(oa.id);
    expect(note.payload.body).toContain(until.toISOString());

    // The lead's own reader surfaces the note, named as the owner page; `blocked` waits on nothing.
    const io = testIo(team.root, { kind: 'owner' });
    expect(await runMessages([], io, { home: s.home, now: () => s.now() })).toBe(0);
    expect(io.out).toContain('owner page');
    expect(io.out).toContain(oa.id);
    expect(noteNames(folder)).toHaveLength(1);

    // A team-create deferral names no team yet: no note, and the answer says why.
    s.at(0);
    const tc = tcRequest(s);
    const tcDone = await deferOnce(s, p, tc.id);
    expect(String(tcDone.body.notice ?? '')).toContain('no team is blocked yet');
    expect(noteNames(folder)).toHaveLength(1);

    // An unresolvable team keeps the deferral and reports the missing lead.
    s.at(0);
    const ghost = oaRequest(s, 'ghost', 'ghost-work');
    const ghostDone = await deferOnce(s, p, ghost.id);
    expect(String(ghostDone.body.notice ?? '')).toContain('ghost');
    expect(String(ghostDone.body.notice ?? '')).toContain('no lead was told');
    const seat = await seatModule();
    const ghostLater = JSON.parse(readFileSync(laterPath(s, ghost.id), 'utf8')) as SignedLater;
    const verified = seat.verifyOwnerLater(s.home, ghostLater, s.store, s.now());
    if (!verified.ok) throw new Error(verified.why);
    expect(verified.later.team).toBe('ghost');
    expect(noteNames(folder)).toHaveLength(1);
  });
});
