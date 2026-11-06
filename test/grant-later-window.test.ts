// The grant reader under a later answer: a deferral signed at the owner page hides the pending
// request, returns it by itself and lets the returned card be answered although its original
// fifteen minutes are gone — and an unsigned or misbound later file extends nothing. Red first.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { approveAsOwnerSeat, executePendingGrant, grantRequestsFolder } from '../src/client/emission.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { runGrant } from '../src/commands/grant.ts';
import { recordDir } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { serveOwnerPage } from '../src/security/owner-page.ts';
import { verifyRecord } from '../src/send/record.ts';
import { keyOf, messageKeyOf } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { fixtureBase, recordAt } from './helpers.ts';

const T0 = new Date('2026-11-04T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TTL_MS = 15 * MINUTE;
const TEAM_ID = 'cccccccccccc';

const made: string[] = [];
const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const b of made) rmSync(b, { recursive: true, force: true });
});

const seat = (name: string, extra = '') => `  - role: ${name === 'orchestrator' ? 'orchestrator' : 'builder'}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
${extra}`;

/** The grant-emission fixture: one registered team, one client with a key pair, no CLI. */
function world() {
  const base = fixtureBase('.grant-later-');
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'floor');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), 'floor:\n  clients:\n    grok-bot:\n      seats: [orchestrator, architect]\n');
  const text = `format: 1\nproject: floor\noperator: steward\nworkspace:\n  mode: shared\nseats:\n${seat('orchestrator', '    leads: true\n')}${seat('architect')}${seat('steward')}`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  keyOf(home);
  const agent = (name: string) => registerAgent(home, {
    name,
    signing: { model: 'M', version: '1', role: name },
    lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: TEAM_ID, seat: name, session: 'floor', pane: 'lead-pane', address: join(base, 'x.sock') },
    mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const orch = agent('orchestrator');
  const architect = agent('architect');
  const steward = agent('steward');
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), `teams:
  "${TEAM_ID}":
    project: floor
    project_id: null
    entity: floor
    session: floor
    root: ${root}
    lobby: ${join(base, 'lobby')}
    roster:
      - { agent: ${orch.id}, seat: orchestrator, role: orchestrator, leads: true }
      - { agent: ${architect.id}, seat: architect, role: builder }
      - { agent: ${steward.id}, seat: steward, role: builder }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" }
`);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('floor', root, home), { approval: approvalOf(checked.team, root, T0), file: text }, [], home);
  const pair = newClientKeyPair();
  const dir = clientKeyDir(home, 'grok-bot');
  const files = writeClientKeyFiles(dir, pair);
  if (!files.ok) throw new Error(files.why);
  return { base, home, root, grok: { pair, dir, keyPath: files.keyPath, pubPath: files.pubPath } };
}

type World = ReturnType<typeof world>;

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

function fakeStore(): OwnerSeatKeyStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  return {
    name: 'fake-credential-store',
    available: () => true,
    create: (label) => { const p = generateKeyPairSync('ec', { namedCurve: 'P-256' }); keys.set(label, p); return { ok: true, publicKey: raw(p.publicKey) }; },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message) => (keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }),
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

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

/** A registered client request on a conversational entity, plus the live owner page. */
async function stage() {
  const w = world();
  const store = fakeStore();
  const registered = registerOwnerSeat(w.home, { team: 'floor', signer: 'mac' }, store);
  if (!registered.ok) throw new Error(registered.why);
  const wrote = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'grant-emission', value: 'conversational' }, { now: T0 });
  if (!wrote.ok) throw new Error(wrote.why);
  let clock = T0.getTime();
  const now = () => new Date(clock);
  const page = await serveOwnerPage({ home: w.home, store, port: 0, now });
  servers.push(page.server);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://localhost:${page.port}${path}?t=${page.token}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
  };
  const p = phone();
  const options = await call('POST', '/api/register/options');
  if (options.status !== 200) throw new Error(`register options refused: ${JSON.stringify(options.body)}`);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.body.challenge, origin: 'http://localhost' })).toString('base64url');
  const registeredPhone = await call('POST', '/api/register', { signer: 'iphone', credentialId: p.credentialId, publicKey: p.spki, clientDataJSON });
  if (registeredPhone.status !== 200) throw new Error(`passkey registration refused: ${JSON.stringify(registeredPhone.body)}`);
  const signers = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: T0 });
  if (!signers.ok) throw new Error(signers.why);
  return { ...w, store, p, call, now, at: (offset: number) => { clock = T0.getTime() + offset; } };
}

type Stage = Awaited<ReturnType<typeof stage>>;
type CallResult = Awaited<ReturnType<Stage['call']>>;

function capture(w: World): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, cwd: w.root, env: {}, stdinIsTTY: false };
  return { io, out: () => out, err: () => err };
}

/** One recorded client-grant request, delivered to the owner seat's inbox. */
async function requestGrant(w: World, now: Date, extra: string[] = []): Promise<string> {
  const io = capture(w);
  const code = await runGrant(
    ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--request', ...extra, '--json'],
    io.io,
    { home: w.home, notify: () => false, now },
  );
  if (code !== 0) throw new Error(`the grant request failed (${code}): ${io.out()} ${io.err()}`);
  const parsed = JSON.parse(io.out()) as { target?: unknown };
  if (typeof parsed.target !== 'string') throw new Error(`the grant request printed no target: ${io.out()}`);
  return parsed.target;
}

async function listed(s: Stage): Promise<string[]> {
  const state = await s.call('GET', '/api/state');
  return (state.body.requests as Array<{ id: string }>).map((r) => r.id);
}

async function answerWord(s: Stage, p: Phone, id: string, word: string): Promise<{ probe: CallResult; done: CallResult | null }> {
  const probe = await s.call('POST', '/api/team-create/challenge', { id, word, credentialId: p.credentialId });
  if (probe.status !== 200) return { probe, done: null };
  const assertion = p.assert(String(probe.body.challenge));
  const done = await s.call('POST', '/api/team-create/answer', { ...assertion, id, word });
  return { probe, done };
}

async function deferOnce(s: Stage, id: string): Promise<CallResult> {
  const { probe, done } = await answerWord(s, s.p, id, 'later');
  if (probe.status !== 200) throw new Error(`later refused at the challenge: ${probe.status} ${JSON.stringify(probe.body)}`);
  if (done === null) throw new Error('the challenge issued no answer');
  if (done.status !== 200) throw new Error(`later refused: ${done.status} ${JSON.stringify(done.body)}`);
  return done;
}

const sorted = (ids: string[]) => [...ids].sort();

describe('grant reader: the later window', () => {
  test('a later answer extends the grant window, and an unsigned later file extends nothing', async () => {
    const s = await stage();
    const first = await requestGrant(s, s.now());
    const second = await requestGrant(s, s.now());
    expect(sorted(await listed(s))).toEqual(sorted([first, second]));

    // A hand-written, unsigned later file for the second request: it may not hide or extend anything.
    const envelope = JSON.parse(readFileSync(join(grantRequestsFolder(s.home), `${second}.json`), 'utf8')) as { grant_request?: { params_sha256?: string } };
    const unsigned = {
      owner_seat_later: {
        kind: 'grant',
        request_id: second,
        params_sha256: envelope.grant_request?.params_sha256 ?? '',
        until: new Date(T0.getTime() + 4 * HOUR).toISOString(),
        word: 'later',
        team: 'floor',
        seat: 'owner',
        at: s.now().toISOString(),
      },
      signer: 'iphone',
      signature: '',
    };
    writeFileSync(join(grantRequestsFolder(s.home), `${second}.later.json`), `${JSON.stringify(unsigned, null, 2)}\n`);

    // The owner's own deferral of the first request, signed at the page.
    const until = new Date(T0.getTime() + 4 * HOUR);
    const done = await deferOnce(s, first);
    expect(done.body.until).toBe(until.toISOString());
    expect(existsSync(join(grantRequestsFolder(s.home), `${first}.later.json`))).toBe(true);
    expect(existsSync(join(grantRequestsFolder(s.home), `${first}.seat-answer.json`))).toBe(false);

    s.at(MINUTE);
    // The signed record hides the first; the unsigned record hides nothing, so the second stays listed.
    expect(await listed(s)).toEqual([second]);
    s.at(TTL_MS + 5 * MINUTE);
    // The second expired on its own fifteen minutes; the first is still hidden until four hours.
    expect(await listed(s)).toEqual([]);

    // The unsigned record extends nothing: both readers refuse the second as expired.
    const refused = approveAsOwnerSeat(s.home, second, 'oui', s.store, s.now());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('expired at');
    const blocked = executePendingGrant(s.home, { requestId: second }, { now: s.now(), ownerSeatStore: s.store });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.why).toContain('expired');
    expect(existsSync(join(grantRequestsFolder(s.home), `${second}.used`))).toBe(false);

    s.at(4 * HOUR);
    expect(await listed(s)).toEqual([first]);

    // Answered past the original fifteen minutes, and executed by the same extended deadline.
    const { done: answered } = await answerWord(s, s.p, first, 'oui');
    expect(answered?.status).toBe(200);
    const executed = executePendingGrant(s.home, { requestId: first }, { now: s.now(), ownerSeatStore: s.store });
    if (!executed.ok) throw new Error(executed.why);
    expect(executed.adapter).toBe('owner-seat');
    expect(existsSync(join(grantRequestsFolder(s.home), `${first}.used`))).toBe(true);
  });

  test('a grant deferral names the grant\'s team and tells its lead', async () => {
    const s = await stage();
    // A team grant names its team in the request's parameters; the owner page must read it from
    // there, because the card itself carries no team and the blocked lead would never be told.
    const id = await requestGrant(s, s.now(), ['--team', 'floor', '--seat', 'orchestrator']);
    expect(await listed(s)).toEqual([id]);
    const until = new Date(T0.getTime() + 4 * HOUR);
    const done = await deferOnce(s, id);
    expect(done.body.until).toBe(until.toISOString());
    expect(String(done.body.notice ?? '')).toContain('lead of floor');

    const folder = recordDir(s.root, 'floor', 'orchestrator');
    const notes = readdirSync(folder).filter((name) => !name.includes('.'));
    expect(notes).toHaveLength(1);
    const note = recordAt(join(folder, notes[0]!));
    expect(verifyRecord(note, messageKeyOf(s.home))).toBe(true);
    expect(note.payload).toMatchObject({
      from: 'owner page',
      from_id: null,
      rule: 'owner page',
      to: 'orchestrator',
      root: s.root,
      session: 'floor',
      message_kind: 'blocked',
    });
    expect(note.payload.body).toContain(id);
    expect(note.payload.body).toContain(until.toISOString());
  });
});
