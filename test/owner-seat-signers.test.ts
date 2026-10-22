// The owner seat with several signers (mac-keystore and webauthn, neither preferred), the
// owner-signers policy, and owner-seat approval of `team init`. Synthetic homes and repositories;
// a fake credential store and a simulated passkey stand in for the system ones.

import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addOwnerSigner, ownerSignerLabel, ownerSeatAnswerBytes, ownerSeatFile, ownerSeatInbox, registerOwnerSeat, verifyOwnerAnswer, webauthnChallenge, type OwnerSeatAnswer, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionApprovalsFolder, actionAuditFolder, actionRequestsFolder } from '../src/client/team-create.ts';
import { runInit } from '../src/commands/init.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { acceptOwnerSigner, acceptedSigners, readOwnerSeat } from '../src/client/owner-seat.ts';
import { runGrant } from '../src/commands/grant.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf, messageKeyOf, signDomain } from '../src/store/keys.ts';

const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

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
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: raw(pair.publicKey) };
    },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message) => (keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' }),
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

/** A simulated passkey: a P-256 credential producing WebAuthn assertions over a challenge. */
function passkey(rpId: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKey: raw(pair.publicKey),
    assert: (answer: OwnerSeatAnswer, flags = 0x05) => {
      const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: webauthnChallenge(answer), origin: `https://${rpId}` }));
      const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex');
      return { authenticator_data: authData.toString('base64url'), client_data_json: clientData.toString('base64url'), signature };
    },
  };
}

function home(label: string) {
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.owner-signers-${label}-`)));
  made.push(base);
  const h = join(base, 'home');
  mkdirSync(join(h, '.config', 'team'), { recursive: true });
  keyOf(h);
  return { base, home: h };
}

function repo(base: string, name: string): string {
  const root = join(base, 'code', name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return root;
}

function io(cwd: string): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return { io: { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd, env: {}, stdinIsTTY: false }, out: () => out, err: () => err };
}

function allowSigners(h: string, names: string[]): void {
  const wrote = writePolicySet(h, { level: 'entity', target: 'floor', name: 'owner-signers', value: names }, { now: new Date() });
  if (!wrote.ok) throw new Error(wrote.why);
}

const answerOf = (id: string, choice: OwnerSeatAnswer['choice'] = 'once'): OwnerSeatAnswer => ({ kind: 'grant', request_id: id, params_sha256: 'a'.repeat(64), choice, team: 'floor', seat: 'owner', at: new Date().toISOString() });

describe('several owner signers, none preferred', () => {
  test('mac-keystore and webauthn signers each verify; the policy chooses which are accepted', () => {
    const h = home('signers');
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    const phone = passkey('owner.example');
    expect(addOwnerSigner(h.home, { signer: 'phone', type: 'webauthn', publicKey: phone.publicKey, credentialId: 'Y3JlZGVudGlhbC1pZA', rpId: 'owner.example' }, store).ok).toBe(true);
    const a = answerOf('gr_000000000000000000000001');
    const macSig = (store.sign(ownerSignerLabel(h.home, 'floor', 'mac'), ownerSeatAnswerBytes(a), 'r') as { signature: string }).signature;
    const assertion = phone.assert(a);
    const viaMac = { owner_seat_answer: a, signer: 'mac', signature: macSig };
    const viaPhone = { owner_seat_answer: a, signer: 'phone', signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } };
    // No owner-signers policy: fail closed, no fallback to every registered signer (approvals.md rule 6).
    for (const unset of [viaMac, viaPhone]) {
      const refused = verifyOwnerAnswer(h.home, unset, store);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.why).toContain('run: team policy set entity owner-signers mac,phone --entity floor');
    }
    allowSigners(h.home, ['mac', 'phone']);
    expect(verifyOwnerAnswer(h.home, viaMac, store).ok).toBe(true);
    expect(verifyOwnerAnswer(h.home, viaPhone, store).ok).toBe(true);
    // A passkey assertion over another answer, without user presence, or for another relying party fails.
    expect(verifyOwnerAnswer(h.home, { ...viaPhone, owner_seat_answer: answerOf('gr_000000000000000000000002') }, store).ok).toBe(false);
    const noPresence = phone.assert(a, 0x00);
    expect(verifyOwnerAnswer(h.home, { ...viaPhone, signature: noPresence.signature, webauthn: { authenticator_data: noPresence.authenticator_data, client_data_json: noPresence.client_data_json } }, store).ok).toBe(false);
    // Policy: only the phone.
    const wrote = writePolicySet(h.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['phone'] }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    const refusedMac = verifyOwnerAnswer(h.home, viaMac, store);
    expect(refusedMac.ok).toBe(false);
    if (!refusedMac.ok) expect(refusedMac.why).toContain('not accepted by the owner-signers policy');
    expect(verifyOwnerAnswer(h.home, viaPhone, store).ok).toBe(true);
  });

  test("the owner-signers policy read is the request's entity, not the owner seat's", () => {
    const h = home('entity');
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    allowSigners(h.home, ['mac']);
    const a = answerOf('gr_000000000000000000000004');
    const viaMac = { owner_seat_answer: a, signer: 'mac', signature: (store.sign(ownerSignerLabel(h.home, 'floor', 'mac'), ownerSeatAnswerBytes(a), 'r') as { signature: string }).signature };
    expect(verifyOwnerAnswer(h.home, viaMac, store, new Date(), 'floor').ok).toBe(true);
    const other = verifyOwnerAnswer(h.home, viaMac, store, new Date(), 'acme');
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.why).toContain('entity "acme"');
  });

  test('a swapped passkey key in the record fails its pin; an unavailable store fails closed', () => {
    const h = home('pin');
    const store = fakeStore();
    registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store);
    const phone = passkey('owner.example');
    addOwnerSigner(h.home, { signer: 'phone', type: 'webauthn', publicKey: phone.publicKey, credentialId: 'Y3JlZGVudGlhbC1pZA', rpId: 'owner.example' }, store);
    allowSigners(h.home, ['mac', 'phone']);
    const attacker = passkey('owner.example');
    const record = JSON.parse(readFileSync(ownerSeatFile(h.home), 'utf8'));
    record.signers[1].public_key = attacker.publicKey;
    writeFileSync(ownerSeatFile(h.home), JSON.stringify(record));
    const a = answerOf('gr_000000000000000000000003');
    const forged = attacker.assert(a);
    const result = verifyOwnerAnswer(h.home, { owner_seat_answer: a, signer: 'phone', signature: forged.signature, webauthn: { authenticator_data: forged.authenticator_data, client_data_json: forged.client_data_json } }, store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain('does not match the key in the credential store');
    const closed = verifyOwnerAnswer(h.home, { owner_seat_answer: a, signer: 'mac', signature: '00' }, { ...store, available: () => false });
    expect(closed.ok).toBe(false);
  });
});

describe('acceptOwnerSigner: registering a signer is the explicit step that makes it accepted', () => {
  test('no policy: writes the signer; then appends; idempotent; the request entity is the one written', () => {
    const h = home('accept');
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    const record = readOwnerSeat(h.home)!;
    const before = acceptedSigners(h.home, record);
    expect('missing' in before && before.missing).toBe(true);
    expect(acceptOwnerSigner(h.home, 'floor', 'mac')).toEqual({ ok: true, names: ['mac'] });
    expect(acceptOwnerSigner(h.home, 'floor', 'phone')).toEqual({ ok: true, names: ['mac', 'phone'] });
    expect(acceptOwnerSigner(h.home, 'floor', 'phone')).toEqual({ ok: true, names: ['mac', 'phone'] });
    expect(acceptedSigners(h.home, record)).toEqual({ names: ['mac', 'phone'], source: 'policy' });
    // Another entity is untouched.
    const other = acceptedSigners(h.home, record, new Date(), 'acme');
    expect('missing' in other && other.missing).toBe(true);
  });

  test('a policy that does not verify is never overwritten', () => {
    const h = home('accept-tamper');
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    allowSigners(h.home, ['mac']);
    const files = execFileSync('grep', ['-rl', 'owner-signers', join(h.home, '.config')]).toString().trim().split('\n');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) writeFileSync(file, readFileSync(file, 'utf8').replace(/[0-9a-f]{128}/g, (sig) => (sig[0] === '0' ? '1' : '0') + sig.slice(1)));
    const snapshot = files.map((f) => readFileSync(f, 'utf8'));
    const result = acceptOwnerSigner(h.home, 'floor', 'phone');
    expect(result.ok).toBe(false);
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(snapshot);
  });

  test('the owner-terminal commands --add-owner-seat and --add-owner-signer set owner-signers and say so', async () => {
    const h = home('accept-cli');
    const store = fakeStore();
    const owner = () => {
      const c = io(h.base);
      return { c, io: { ...c.io, caller: { kind: 'owner' } } as Io };
    };
    const seat = owner();
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], seat.io, { home: h.home, ownerSeatStore: store })).toBe(0);
    expect(seat.c.out()).toContain('owner-signers (entity floor): mac');
    const phone = passkey('owner.example');
    const add = owner();
    expect(await runGrant(['--add-owner-signer', '--signer', 'phone', '--type', 'webauthn', '--signer-public-key', phone.publicKey, '--credential-id', 'Y3JlZGVudGlhbC1pZA', '--rp-id', 'owner.example'], add.io, { home: h.home, ownerSeatStore: store })).toBe(0);
    expect(add.c.out()).toContain('owner-signers (entity floor): mac, phone');
    expect(acceptedSigners(h.home, readOwnerSeat(h.home)!)).toEqual({ names: ['mac', 'phone'], source: 'policy' });
    // A non-owner caller changes nothing.
    const agent = io(h.base);
    expect(await runGrant(['--add-owner-signer', '--signer', 'evil', '--type', 'mac-keystore'], { ...agent.io, caller: { kind: 'seat', name: 'x', pane: 'w1:p1' } } as Io, { home: h.home, ownerSeatStore: store })).not.toBe(0);
    expect(acceptedSigners(h.home, readOwnerSeat(h.home)!)).toEqual({ names: ['mac', 'phone'], source: 'policy' });
  });
});

describe('credential-store labels', () => {
  test('two homes registering the same team and signer use two keys', () => {
    const a = home('label-a');
    const b = home('label-b');
    const store = fakeStore();
    expect(ownerSignerLabel(a.home, 'floor', 'mac')).not.toBe(ownerSignerLabel(b.home, 'floor', 'mac'));
    expect(registerOwnerSeat(a.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    expect(registerOwnerSeat(b.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    expect(JSON.parse(readFileSync(ownerSeatFile(a.home), 'utf8')).signers[0].label).toMatch(/^owner-floor-mac-[0-9a-f]{8}$/);
  });
});

describe('team policy set entity owner-signers from the command line', () => {
  test('one name or a comma-separated list is accepted and read back as a list', async () => {
    const h = home('cli');
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    const owner = (): Io => ({ ...io(h.base).io, caller: { kind: 'owner' } } as Io);
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac', '--entity', 'floor'], owner(), { home: h.home })).toBe(0);
    const record = readOwnerSeat(h.home)!;
    expect(acceptedSigners(h.home, record)).toEqual({ names: ['mac'], source: 'policy' });
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac,phone', '--entity', 'floor'], owner(), { home: h.home })).toBe(0);
    expect(acceptedSigners(h.home, record)).toEqual({ names: ['mac', 'phone'], source: 'policy' });
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'mac,mac', '--entity', 'floor'], owner(), { home: h.home })).not.toBe(0);
    expect(await runPolicy(['set', 'entity', 'owner-signers', 'Bad Name', '--entity', 'floor'], owner(), { home: h.home })).not.toBe(0);
    // approval-rule-ttl from the command line: days, 90 at most.
    expect(await runPolicy(['set', 'entity', 'approval-rule-ttl', '60', '--entity', 'floor'], owner(), { home: h.home })).toBe(0);
    expect(await runPolicy(['set', 'entity', 'approval-rule-ttl', '45d', '--entity', 'floor'], owner(), { home: h.home })).toBe(0);
    expect(await runPolicy(['set', 'entity', 'approval-rule-ttl', '91', '--entity', 'floor'], owner(), { home: h.home })).not.toBe(0);
  });
});

describe('team init approved by the owner seat', () => {
  function setup(label: string) {
    const h = home(label);
    const store = fakeStore();
    expect(registerOwnerSeat(h.home, { team: 'floor', signer: 'mac' }, store).ok).toBe(true);
    allowSigners(h.home, ['mac']);
    const sources = (now?: Date) => ({ loggedIn: () => true, ownerSeatStore: store, ...(now ? { now: () => now } : {}) });
    const run = async (cwd: string, argv: string[], now?: Date) => {
      const c = io(cwd);
      const code = await runInit(argv, c.io, h.home, undefined, sources(now));
      return { code, out: c.out(), err: c.err(), json: argv.includes('--json') && c.out().trim().startsWith('{') ? JSON.parse(c.out()) : null };
    };
    return { ...h, store, run };
  }

  test('a non-owner request lands in the owner seat inbox; execute needs the signed answer; once is single-use', async () => {
    const s = setup('init-ok');
    const root = repo(s.base, 'docs');
    expect((await s.run(root, [])).code).toBe(1);
    const req = await s.run(root, ['--request', '--json']);
    expect(req.code).toBe(0);
    const id = req.json.request_id as string;
    expect(req.json.text).toContain(`Team request ${id}: Create team "docs"`);
    expect(readdirSync(ownerSeatInbox(s.home))).toEqual([`${id}.json`]);
    const early = await s.run(root, ['--execute', id]);
    expect(early.code).toBe(1);
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
    expect((await s.run(root, ['--approve-as-owner-seat', id, 'oui'])).code).toBe(0);
    const done = await s.run(root, ['--execute', id]);
    expect(done.code).toBe(0);
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(true);
    const audit = JSON.parse(readFileSync(join(actionAuditFolder(s.home), `${id}.json`), 'utf8'));
    expect(audit).toMatchObject({ via: 'owner-seat', signer: 'mac', kind: 'team-create' });
    const again = repo(s.base, 'docs2');
    expect((await s.run(again, ['--execute', id])).code).toBe(1);
  });

  test('a forged answer dropped first never blocks the owner seat answer', async () => {
    const s = setup('init-squat');
    const root = repo(s.base, 'squat');
    const req = await s.run(root, ['--request', '--json']);
    const id = req.json.request_id as string;
    writeFileSync(join(actionRequestsFolder(s.home), `${id}.seat-answer.json`), '{"owner_seat_answer":{},"signer":"mac","signature":"00"}');
    expect((await s.run(root, ['--approve-as-owner-seat', id, 'oui'])).code).toBe(0);
    expect((await s.run(root, ['--approve-as-owner-seat', id, 'oui'])).code).toBe(1);
    expect((await s.run(root, ['--execute', id])).code).toBe(0);
  });

  test('another key, the shared message key, another id, another repository, an expired request and a deny are refused', async () => {
    const s = setup('init-refuse');
    const root = repo(s.base, 'docs');
    const id1 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(s.home), `${id1}.json`), 'utf8'));
    const answer: OwnerSeatAnswer = { kind: 'team-create', request_id: id1, params_sha256: record.params_sha256, choice: 'once', team: 'floor', seat: 'owner', at: new Date().toISOString() };
    const other = fakeStore();
    other.create('x');
    writeFileSync(join(actionRequestsFolder(s.home), `${id1}.seat-answer.json`), JSON.stringify({ owner_seat_answer: answer, signer: 'mac', signature: (other.sign('x', ownerSeatAnswerBytes(answer), 'r') as { signature: string }).signature }));
    expect((await s.run(root, ['--execute', id1])).code).toBe(1);
    const id2 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    const record2 = JSON.parse(readFileSync(join(actionRequestsFolder(s.home), `${id2}.json`), 'utf8'));
    const answer2 = { ...answer, request_id: id2, params_sha256: record2.params_sha256 };
    writeFileSync(join(actionRequestsFolder(s.home), `${id2}.seat-answer.json`), JSON.stringify({ owner_seat_answer: answer2, signer: 'mac', signature: signDomain('team-owner-seat-answer-v2\n', answer2, messageKeyOf(s.home)) }));
    expect((await s.run(root, ['--execute', id2])).code).toBe(1);
    const id3 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    const id4 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(root, ['--approve-as-owner-seat', id3, 'oui'])).code).toBe(0);
    writeFileSync(join(actionRequestsFolder(s.home), `${id4}.seat-answer.json`), readFileSync(join(actionRequestsFolder(s.home), `${id3}.seat-answer.json`)));
    const moved = await s.run(root, ['--execute', id4]);
    expect(moved.code).toBe(1);
    expect(moved.err).toContain('not bound');
    const elsewhere = repo(s.base, 'elsewhere');
    expect((await s.run(elsewhere, ['--execute', id3])).code).toBe(1);
    const id5 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(root, ['--approve-as-owner-seat', id5, 'oui'])).code).toBe(0);
    expect((await s.run(root, ['--execute', id5], new Date(Date.now() + 16 * 60 * 1000))).code).toBe(1);
    const id6 = (await s.run(root, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(root, ['--approve-as-owner-seat', id6, 'non'])).code).toBe(0);
    expect((await s.run(root, ['--execute', id6])).code).toBe(1);
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(false);
  });

  test('a forged rule file dropped first is replaced by the real always rule', async () => {
    const s = setup('init-rule-squat');
    const first = repo(s.base, 'docs');
    const id = (await s.run(first, ['--request', '--json'])).json.request_id as string;
    mkdirSync(actionApprovalsFolder(s.home), { recursive: true });
    writeFileSync(join(actionApprovalsFolder(s.home), `${id}.json`), 'forged');
    expect((await s.run(first, ['--approve-as-owner-seat', id, 'always'])).code).toBe(0);
    const list = await s.run(first, ['--approvals', '--json']);
    expect(list.json.rules).toHaveLength(1);
    expect(list.json.ignored).toEqual([]);
  });

  test('a team-create rule lives for approval-rule-ttl: listed and used before it, ignored after', async () => {
    const s = setup('init-ttl');
    const first = repo(s.base, 'docs');
    const id = (await s.run(first, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(first, ['--approve-as-owner-seat', id, 'always'])).code).toBe(0);
    expect((await s.run(first, ['--execute', id])).code).toBe(0);
    const at = (days: number) => new Date(Date.now() + days * 86_400_000);
    expect((await s.run(first, ['--approvals', '--json'], at(29))).json.rules).toHaveLength(1);
    const late = await s.run(first, ['--approvals', '--json'], at(31));
    expect(late.json.rules).toHaveLength(0);
    expect(late.json.ignored).toEqual([id]);
    const old = repo(s.base, 'old');
    const oid = (await s.run(old, ['--request', '--json'], at(31))).json.request_id as string;
    expect((await s.run(old, ['--execute', oid], at(31))).code).toBe(1);
    const fresh = repo(s.base, 'fresh');
    const fid = (await s.run(fresh, ['--request', '--json'], at(29))).json.request_id as string;
    expect((await s.run(fresh, ['--execute', fid], at(29))).code).toBe(0);
  });

  test('always stores a signed team-create rule for the parent folder; a sibling is auto-approved and audited; revoke stops it', async () => {
    const s = setup('init-always');
    const first = repo(s.base, 'docs');
    const id = (await s.run(first, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(first, ['--approve-as-owner-seat', id, 'always'])).code).toBe(0);
    expect((await s.run(first, ['--execute', id])).code).toBe(0);
    const list = await s.run(first, ['--approvals', '--json']);
    expect(list.json.rules).toHaveLength(1);
    expect(list.json.rules[0]).toMatchObject({ rule_id: id, kind: 'team-create' });
    const sibling = repo(s.base, 'notes');
    const sid = (await s.run(sibling, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(sibling, ['--execute', sid])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(actionAuditFolder(s.home), `${sid}.json`), 'utf8'))).toMatchObject({ via: 'rule', rule_id: id });
    // A rule whose file is edited is ignored.
    const rulePath = join(actionApprovalsFolder(s.home), `${id}.json`);
    const original = readFileSync(rulePath, 'utf8');
    writeFileSync(rulePath, original.replace(/"scope": "[^"]*"/, '"scope": "/"'));
    expect((await s.run(first, ['--approvals', '--json'])).json.ignored).toEqual([id]);
    writeFileSync(rulePath, original);
    expect((await s.run(first, ['--revoke-approval', id])).code).toBe(0);
    const third = repo(s.base, 'more');
    const tid = (await s.run(third, ['--request', '--json'])).json.request_id as string;
    expect((await s.run(third, ['--execute', tid])).code).toBe(1);
  });

  test('with no owner seat a request is refused', async () => {
    const h = home('init-noseat');
    const root = repo(h.base, 'docs');
    const c = io(root);
    expect(await runInit(['--request'], c.io, h.home, undefined, { loggedIn: () => true, ownerSeatStore: fakeStore() })).toBe(1);
    expect(c.err()).toContain('no owner seat');
  });
});
