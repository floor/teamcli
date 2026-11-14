// The owner page draws an owner-action card from the request record itself — never from the inbox
// copy beside it, which any process of the account can write — and signs only the request the card
// showed: the page sends the card's parameter hash with the answer, and a request that no longer
// has it is not asked for a challenge and not signed. The signer is a fake credential store and a
// simulated passkey; the page is served on a free port of 127.0.0.1; homes are temporary.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { actionArgsHash, admitOwnerAction, approveOwnerAction, createOwnerActionRequest, ownerActionHash, type OwnerActionRecord } from '../src/client/owner-action.ts';
import { ownerSeatInbox, readOwnerSeat, registerOwnerSeat, signOwnerAnswer, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionRequestsFolder, approveTeamCreate, createTeamCreateRequest } from '../src/client/team-create.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { OWNER_PAGE_HTML, REQUEST_PAGE_HTML, serveOwnerPage } from '../src/security/owner-page.ts';
import { keyOf } from '../src/store/keys.ts';

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

function phone() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = Buffer.from('iphone-credential-0002').toString('base64url');
  const assert = (challenge: string) => {
    const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 7])]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' }));
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' });
    return { credentialId, authenticatorData: authData.toString('base64url'), clientDataJSON: clientData.toString('base64url'), signature: signature.toString('base64url') };
  };
  return { credentialId, assert, spki: (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url') };
}

type Card = { id: string; title: string; description: string; scope?: string; details?: string; text: string; shown?: string };

async function page() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'owner-page-shown-')));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  expect(registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
  const served = await serveOwnerPage({ home, store, port: 0 });
  servers.push(served.server);
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://localhost:${served.port}${path}?t=${served.token}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> };
  };
  const p = phone();
  const o = await call('POST', '/api/register/options');
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: o.body.challenge, origin: 'http://localhost' })).toString('base64url');
  expect((await call('POST', '/api/register', { signer: 'iphone', credentialId: p.credentialId, publicKey: p.spki, clientDataJSON })).status).toBe(200);
  expect(writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: new Date() }).ok).toBe(true);
  const cards = async (): Promise<Card[]> => (await call('GET', '/api/state')).body.requests as Card[];
  return { base, home, store, call, p, cards };
}

/** A development-mode request on this machine, for `words` (`set off`, `set local-fast`). */
function devModeRequest(home: string, base: string, words: string[]) {
  const made = createOwnerActionRequest(home, { actions: ['development-mode'], root: join(base, 'repo'), team: 'floor', head: null, args: { 'development-mode': words }, requestedBy: 'seat:helper' }, new Date());
  if (!made.ok) throw new Error(made.why);
  return made.record;
}

describe('the card is the record, and the record signed is the card shown', () => {
  test('a forged inbox summary is never what the page shows: the card is drawn from the request record', async () => {
    const s = await page();
    const record = devModeRequest(s.home, s.base, ['set', 'local-fast']);
    // The inbox copy, rewritten to say "off": the page must not show it.
    const inbox = join(ownerSeatInbox(s.home), `${record.request_id}.json`);
    const message = JSON.parse(readFileSync(inbox, 'utf8')) as { summary: { words: Record<string, string[]> }; text: string };
    message.summary = { ...message.summary, words: { 'development-mode': ['set', 'off'] } };
    message.text = 'Request: turn development mode off';
    writeFileSync(inbox, JSON.stringify(message));
    const [card] = await s.cards();
    expect(card!.id).toBe(record.request_id);
    expect(card!.shown).toBe(record.params_sha256);
    expect(card!.title).toBe('Turn on fast local development');
    expect(card!.text).not.toContain('turn development mode off');
    expect(card!.details).toContain('set local-fast');
  });

  test('a record whose words do not hash to its arguments is shown as unreadable and cannot be asked for a challenge', async () => {
    const s = await page();
    const record = devModeRequest(s.home, s.base, ['set', 'off']);
    const forged: OwnerActionRecord = JSON.parse(JSON.stringify(record));
    forged.params.args['development-mode'] = actionArgsHash('development-mode', ['set', 'local-fast']);
    forged.params_sha256 = ownerActionHash(forged.params);
    writeFileSync(join(actionRequestsFolder(s.home), `${record.request_id}.json`), JSON.stringify(forged));
    const [card] = await s.cards();
    expect(card!.description).toContain('cannot be read');
    expect(card!.shown).toBeUndefined();
    const ch = await s.call('POST', '/api/team-create/challenge', { id: record.request_id, word: 'oui', credentialId: s.p.credentialId, shown: forged.params_sha256 });
    expect(ch.status).not.toBe(200);
    expect(existsSync(join(actionRequestsFolder(s.home), `${record.request_id}.seat-answer.json`))).toBe(false);
  });

  test('the shown hash is required, and a request that changed since it was shown is not asked or signed', async () => {
    const s = await page();
    const off = devModeRequest(s.home, s.base, ['set', 'off']);
    const [card] = await s.cards();
    expect(card!.shown).toBe(off.params_sha256);
    // No hash at all: refused, nothing issued.
    expect((await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'oui', credentialId: s.p.credentialId })).status).toBe(409);
    // The request swapped for a valid one under the same id after the card was shown.
    const swapped = createOwnerActionRequest(s.home, { actions: ['development-mode'], root: join(s.base, 'other'), team: 'floor', head: null, args: { 'development-mode': ['set', 'local-fast'] }, requestedBy: 'seat:helper' }, new Date());
    if (!swapped.ok) throw new Error(swapped.why);
    const path = join(actionRequestsFolder(s.home), `${off.request_id}.json`);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ ...swapped.record, request_id: off.request_id }));
    const changed = await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'oui', credentialId: s.p.credentialId, shown: card!.shown });
    expect(changed.status).toBe(409);
    expect(String(changed.body.error)).toContain('changed since it was shown');
    // Back as it was shown: a challenge is issued; then swapped again before the answer.
    writeFileSync(path, original);
    const ch = await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'oui', credentialId: s.p.credentialId, shown: card!.shown });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    writeFileSync(path, JSON.stringify({ ...swapped.record, request_id: off.request_id }));
    const done = await s.call('POST', '/api/team-create/answer', { ...s.p.assert(String(ch.body.challenge)), id: off.request_id, word: 'oui' });
    expect(done.status).toBe(409);
    expect(existsSync(join(actionRequestsFolder(s.home), `${off.request_id}.seat-answer.json`))).toBe(false);
    // The request as shown, answered end to end: the answer admits exactly the words shown.
    writeFileSync(path, original);
    const again = await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'oui', credentialId: s.p.credentialId, shown: card!.shown });
    expect(again.status).toBe(200);
    const answered = await s.call('POST', '/api/team-create/answer', { ...s.p.assert(String(again.body.challenge)), id: off.request_id, word: 'oui' });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const ask = { action: 'development-mode' as const, root: join(s.base, 'repo'), team: 'floor', head: null, claim: false };
    expect(admitOwnerAction(s.home, off.request_id, { ...ask, words: ['set', 'local-fast'] }, s.store, new Date()).ok).toBe(false);
    expect(admitOwnerAction(s.home, off.request_id, { ...ask, words: ['set', 'off'] }, s.store, new Date()).ok).toBe(true);
  });

  test('a later answer is held to the shown hash too', async () => {
    const s = await page();
    const off = devModeRequest(s.home, s.base, ['set', 'off']);
    const [card] = await s.cards();
    const path = join(actionRequestsFolder(s.home), `${off.request_id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as OwnerActionRecord;
    const reason = { ...record, params: { ...record.params, reason: 'moved' } };
    // The reason is not hashed: the same hash, a later answer is asked as before.
    writeFileSync(path, JSON.stringify(reason));
    expect((await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'later', credentialId: s.p.credentialId, shown: card!.shown })).status).toBe(200);
    const other = devModeRequest(s.home, s.base, ['set', 'local-fast']);
    writeFileSync(path, JSON.stringify({ ...other, request_id: off.request_id }));
    expect((await s.call('POST', '/api/team-create/challenge', { id: off.request_id, word: 'later', credentialId: s.p.credentialId, shown: card!.shown })).status).toBe(409);
  });

  test('a team-create request swapped after it was shown signs nothing: the answer is drawn from the one read it checks', async () => {
    const s = await page();
    const repo = (name: string): string => {
      const root = join(s.base, 'code', name);
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      return root;
    };
    const a = createTeamCreateRequest(s.home, repo('alpha'), null, new Date());
    const b = createTeamCreateRequest(s.home, repo('beta'), null, new Date());
    if (!a.ok || !b.ok) throw new Error('team requests');
    const path = join(actionRequestsFolder(s.home), `${a.record.request_id}.json`);
    const original = readFileSync(path, 'utf8');
    // Repository B's request under A's id, after A's card was shown: a valid record, another hash.
    writeFileSync(path, JSON.stringify({ ...b.record, request_id: a.record.request_id }));
    const prompts = s.store.prompts.length;
    for (const signer of ['mac', 'iphone']) {
      const swapped = approveTeamCreate(s.home, a.record.request_id, 'oui', s.store, new Date(), { signer, expect: a.record.params_sha256 });
      expect(swapped.ok, signer).toBe(false);
      if (!swapped.ok) expect(swapped.why).toContain('changed since it was shown');
    }
    expect(s.store.prompts.length).toBe(prompts);
    expect(existsSync(join(actionRequestsFolder(s.home), `${a.record.request_id}.seat-answer.json`))).toBe(false);
    // The request as shown: one prompt, its card naming repository A's team.
    writeFileSync(path, original);
    expect(approveTeamCreate(s.home, a.record.request_id, 'oui', s.store, new Date(), { signer: 'mac', expect: a.record.params_sha256 })).toMatchObject({ ok: true, choice: 'once' });
    expect(s.store.prompts.length).toBe(prompts + 1);
    expect(s.store.prompts.at(-1)).toContain('alpha');
  });

  test('a request with its words removed (window kept, hash recomputed) is refused before any prompt, on every path', async () => {
    const s = await page();
    const record = devModeRequest(s.home, s.base, ['set', 'off']);
    const stripped: OwnerActionRecord = JSON.parse(JSON.stringify(record));
    delete stripped.params.words;
    stripped.params_sha256 = ownerActionHash(stripped.params);
    expect(stripped.params.window).toEqual({ created: record.created, expires_at: record.expires_at });
    writeFileSync(join(actionRequestsFolder(s.home), `${record.request_id}.json`), JSON.stringify(stripped));
    const prompts = s.store.prompts.length;
    // The device key (team init --approve-as-owner-seat, team approvals sign): refused.
    const touch = approveOwnerAction(s.home, record.request_id, 'oui', s.store, new Date(), { signer: 'mac' });
    expect(touch.ok).toBe(false);
    if (!touch.ok) expect(touch.why).toContain('carries no argument words');
    // The page's passkey: the card reads, but no challenge is issued for it.
    const [card] = await s.cards();
    expect(card!.shown).toBe(stripped.params_sha256);
    const ch = await s.call('POST', '/api/team-create/challenge', { id: record.request_id, word: 'oui', credentialId: s.p.credentialId, shown: card!.shown });
    expect(ch.status).toBe(400);
    expect(String(ch.body.error)).toContain('carries no argument words');
    expect(ch.body.challenge).toBeUndefined();
    expect(s.store.prompts.length).toBe(prompts);
    expect(existsSync(join(actionRequestsFolder(s.home), `${record.request_id}.seat-answer.json`))).toBe(false);
    // An answer that already exists for such a request still verifies when it runs.
    const seat = readOwnerSeat(s.home)!;
    const answer = { kind: 'owner-action' as const, request_id: record.request_id, params_sha256: stripped.params_sha256, choice: 'once' as const, team: seat.team, seat: 'owner' as const, at: new Date().toISOString() };
    const signed = signOwnerAnswer(s.home, answer, 'mac', s.store, 'an answer given before');
    if (!signed.ok) throw new Error(signed.why);
    writeFileSync(join(actionRequestsFolder(s.home), `${record.request_id}.seat-answer.json`), JSON.stringify(signed.signed));
    const ask = { action: 'development-mode' as const, root: join(s.base, 'repo'), team: 'floor', head: null, words: ['set', 'off'], claim: false };
    expect(admitOwnerAction(s.home, record.request_id, ask, s.store, new Date())).toMatchObject({ ok: true, via: 'owner-seat' });
  });

  test('both page scripts send the card\'s hash with every answer they ask for', () => {
    expect(OWNER_PAGE_HTML).toContain('shown: card.shown');
    expect(REQUEST_PAGE_HTML).toContain("post('challenge', { session: S.session, word, credentialId: passkey.credential_id, shown: S.request.shown })");
    expect(REQUEST_PAGE_HTML).toContain("post('touch-id', { session: S.session, word, shown: S.request.shown })");
  });
});
