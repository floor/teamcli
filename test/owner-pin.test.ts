// The owner seat pinned from another machine: the export on the signer machine, the pin on a
// machine with no owner signer, the fingerprint both print, the re-pin rules, and the machine a
// request names once its machine is pinned. The signer is a fake credential store (P-256 keys in
// memory) and a simulated passkey; no Secure Enclave is reached and no terminal host is started.
// Homes are temporary. The terminal rule itself is test/pinned-terminal.test.ts.
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_TERMINAL_REASON, type Caller } from '../src/caller.ts';
import { createOwnerActionRequest, ownerActionHash, type OwnerActionParams } from '../src/client/owner-action.ts';
import { machineFile, ownerPinPresent, ownerSeatPinFile } from '../src/client/owner-pin-path.ts';
import {
  exportOwnerSeat,
  fingerprintText,
  ownerSeatExportBytes,
  ownerSeatExportChallenge,
  ownerSeatFingerprint,
  pinOwnerSeat,
  readOwnerPin,
  requestMachineProblem,
  verifyOwnerSeatExport,
  verifyPinnedOwnerAnswer,
  type SignedOwnerSeatExport,
} from '../src/client/owner-pin.ts';
import { addOwnerSigner, ownerSeatAnswerBytes, registerOwnerSeat, type OwnerSeatAnswer, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runOwnerSeat } from '../src/commands/owner-seat.ts';
import { runSetup } from '../src/commands/setup.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

/** A credential store with keys in memory. `reasons` records every user-presence prompt it was asked to show. */
function fakeStore(): OwnerSeatKeyStore & { reasons: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const reasons: string[] = [];
  return {
    name: 'fake-credential-store',
    reasons,
    available: () => true,
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: raw(pair.publicKey) };
    },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message, reason) => {
      reasons.push(reason);
      return keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' };
    },
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

/** A simulated passkey on relying party `rpId`: WebAuthn assertions over a challenge. */
function passkey(rpId: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const assert = (challenge: string, flags = 0x05) => {
    const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: `http://${rpId}:7391` }));
    const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex');
    return { authenticator_data: authData.toString('base64url'), client_data_json: clientData.toString('base64url'), signature };
  };
  return { publicKey: raw(pair.publicKey), assert };
}

function tempHome(label: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `owner-pin-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  return home;
}

/** The signer machine: an owner seat with one Secure Enclave signer `mac`, accepted by policy. */
function signerMachine(label: string, options: { phone?: ReturnType<typeof passkey> } = {}) {
  const home = tempHome(label);
  const store = fakeStore();
  const seat = registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW);
  if (!seat.ok) throw new Error(seat.why);
  const names = ['mac'];
  if (options.phone !== undefined) {
    const added = addOwnerSigner(home, { signer: 'phone', type: 'webauthn', publicKey: options.phone.publicKey, credentialId: 'Y3JlZGVudGlhbC1pZA', rpId: 'localhost' }, store, NOW);
    if (!added.ok) throw new Error(added.why);
    names.push('phone');
  }
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: names }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
  return { home, store };
}

function exported(mac: { home: string; store: OwnerSeatKeyStore }, at: Date = NOW): SignedOwnerSeatExport {
  const made = exportOwnerSeat(mac.home, mac.store, at);
  if (!made.ok) throw new Error(made.why);
  return made.signed;
}

const OWNER: Caller = { kind: 'owner' };
const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'p1', session: 'acme' };
const PINNED: Caller = { kind: 'unplaced', reason: PINNED_TERMINAL_REASON, pinned: true };

describe('export and pin', () => {
  test('a round trip: the export verifies, carries public material only, and both sides print one fingerprint', async () => {
    const phone = passkey('localhost');
    const mac = signerMachine('round', { phone });
    const out = join(mac.home, 'owner-seat-export.json');
    const shown = testIo(mac.home);
    expect(await runOwnerSeat(['export', '--out', out], shown, { home: mac.home, store: mac.store, now: () => NOW })).toBe(0);
    const macLine = shown.out.split('\n').find((line) => line.startsWith('fingerprint: '));
    expect(macLine).toBeDefined();
    // The Touch ID card the export is signed under shows the same fingerprint.
    expect(mac.store.reasons.at(-1)).toContain(macLine!.slice('fingerprint: '.length));
    const text = readFileSync(out, 'utf8');
    // Public material only: no private key, in any encoding the fake store could leak.
    expect(text).not.toContain('PRIVATE');
    expect(text).not.toContain('"d"');
    const file = JSON.parse(text) as SignedOwnerSeatExport;
    expect(file.owner_seat_export.signers.map((s) => s.name).sort()).toEqual(['mac', 'phone']);
    expect(file.owner_seat_export.signers.find((s) => s.name === 'phone')).toMatchObject({ type: 'webauthn', credential_id: 'Y3JlZGVudGlhbC1pZA', rp_id: 'localhost' });
    expect(file.owner_seat_export.accepted.sort()).toEqual(['mac', 'phone']);
    expect(verifyOwnerSeatExport(file).ok).toBe(true);

    const server = tempHome('round-server');
    const pinned = testIo(server, OWNER);
    expect(await runOwnerSeat(['pin', '--from', out, '--name', 'server-one'], pinned, { home: server, now: () => NOW })).toBe(0);
    expect(pinned.out).toContain('trust on first use');
    const serverLine = pinned.out.split('\n').find((line) => line.startsWith('fingerprint: '));
    expect(serverLine?.startsWith(macLine!)).toBe(true);
    expect(pinned.out).toContain('a terminal on this machine is not the owner');
    const pin = readOwnerPin(server);
    expect(pin.kind).toBe('pinned');
    if (pin.kind !== 'pinned') return;
    expect(pin.fingerprint).toBe(ownerSeatFingerprint(file.owner_seat_export));
    expect(pin.machine.name).toBe('server-one');
    expect(pin.machine.id).toMatch(/^m_[0-9a-f]{24}$/);
    // The status line names the pin, the fingerprint and the machine.
    const status = testIo(server);
    expect(await runOwnerSeat(['status'], status, { home: server, now: () => NOW })).toBe(0);
    expect(status.out).toContain('pinned from another machine');
    expect(status.out).toContain(fingerprintText(pin.fingerprint));
    expect(status.out).toContain('a terminal here is not the owner');
  });

  test('the first pin is the owner\'s, at a terminal: a seat, a terminal with no tty and a pinned machine\'s terminal are refused', async () => {
    const mac = signerMachine('first');
    const out = join(mac.home, 'export.json');
    writeFileSync(out, JSON.stringify(exported(mac)));
    for (const caller of [LEAD, { kind: 'owner-no-tty' } as Caller, PINNED]) {
      const server = tempHome('first-refused');
      const io = testIo(server, caller);
      expect(await runOwnerSeat(['pin', '--from', out], io, { home: server, now: () => NOW })).toBe(1);
      expect(io.err).toContain("the first pin is the owner's");
      expect(ownerPinPresent(server)).toBe(false);
      expect(existsSync(machineFile(server))).toBe(false);
    }
  });

  test('a tampered export is refused: a changed key, an added signer, a widened accepted list, a foreign signature', () => {
    const mac = signerMachine('tamper', { phone: passkey('localhost') });
    const signed = exported(mac);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const changes: Array<(e: SignedOwnerSeatExport) => void> = [
      (e) => { e.owner_seat_export.signers[0]!.public_key = raw(other.publicKey); },
      (e) => { e.owner_seat_export.signers.push({ name: 'evil', type: 'mac-keystore', public_key: raw(other.publicKey), label: 'evil-label', added: NOW.toISOString() }); },
      (e) => { e.owner_seat_export.accepted = ['mac']; },
      (e) => { e.owner_seat_export.team = 'other'; },
      (e) => { e.signature = cryptoSign('sha256', ownerSeatExportBytes(e.owner_seat_export), { key: other.privateKey, dsaEncoding: 'der' }).toString('hex'); },
      (e) => { e.signer = 'phone'; },
    ];
    for (const change of changes) {
      const copy = JSON.parse(JSON.stringify(signed)) as SignedOwnerSeatExport;
      change(copy);
      expect(verifyOwnerSeatExport(copy).ok).toBe(false);
      const server = tempHome('tamper-server');
      expect(pinOwnerSeat(server, copy, NOW).ok).toBe(false);
      expect(ownerPinPresent(server)).toBe(false);
    }
  });

  test('re-pin: the same set changes nothing; a newer set signed by a pinned signer replaces it; anything else is refused', () => {
    const mac = signerMachine('repin');
    const server = tempHome('repin-server');
    const first = pinOwnerSeat(server, exported(mac), NOW);
    expect(first).toMatchObject({ ok: true, kind: 'pinned', previous: null });
    if (!first.ok) return;
    const pinText = readFileSync(ownerSeatPinFile(server), 'utf8');
    // The same seat exported again later: the same fingerprint, nothing written.
    const again = pinOwnerSeat(server, exported(mac, new Date(NOW.getTime() + 60_000)), new Date(NOW.getTime() + 60_000));
    expect(again).toMatchObject({ ok: true, kind: 'same' });
    expect(readFileSync(ownerSeatPinFile(server), 'utf8')).toBe(pinText);

    // Another owner seat altogether (another key), however new: its signer is not pinned here.
    const stranger = signerMachine('repin-stranger');
    const foreign = pinOwnerSeat(server, exported(stranger, new Date(NOW.getTime() + 120_000)), new Date(NOW.getTime() + 120_000));
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.why).toContain('signed by a signer already pinned here');
    expect(readFileSync(ownerSeatPinFile(server), 'utf8')).toBe(pinText);

    // The owner adds a passkey on the signer machine: a newer export, signed by `mac`, re-pins.
    const phone = passkey('localhost');
    expect(addOwnerSigner(mac.home, { signer: 'phone', type: 'webauthn', publicKey: phone.publicKey, credentialId: 'Y3JlZGVudGlhbC1pZA', rpId: 'localhost' }, mac.store, NOW).ok).toBe(true);
    expect(writePolicySet(mac.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'phone'] }, { now: NOW }).ok).toBe(true);
    const later = new Date(NOW.getTime() + 180_000);
    const wider = exported(mac, later);
    const older = exported(mac, new Date(NOW.getTime() - 60_000));
    // An export of the wider set dated before the pin is not newer: refused.
    const stale = pinOwnerSeat(server, older, later);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.why).toContain('not newer');
    const repinned = pinOwnerSeat(server, wider, later);
    expect(repinned).toMatchObject({ ok: true, kind: 'repinned', previous: first.fingerprint });
    const pin = readOwnerPin(server);
    expect(pin.kind === 'pinned' && pin.body.signers.map((s) => s.name).sort()).toEqual(['mac', 'phone']);
    // The machine record made at the first pin stays: requests keep naming the same machine.
    expect(pin.kind === 'pinned' && first.ok && pin.machine.id).toBe(first.machine.id);
  });

  test('a passkey-signed export verifies under its assertion, and a re-pin by a pinned passkey is admitted', () => {
    const phone = passkey('localhost');
    const mac = signerMachine('passkey', { phone });
    const server = tempHome('passkey-server');
    expect(pinOwnerSeat(server, exported(mac), NOW).ok).toBe(true);
    // A body the owner signs with the passkey (on the owner page, in a later step): the assertion's
    // challenge is the SHA-256 of the export bytes.
    const base = exported(mac, new Date(NOW.getTime() + 60_000)).owner_seat_export;
    const body = { ...base, accepted: ['phone'] };
    const assertion = phone.assert(ownerSeatExportChallenge(body));
    const signed: SignedOwnerSeatExport = { owner_seat_export: body, signer: 'phone', signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } };
    expect(verifyOwnerSeatExport(signed).ok).toBe(true);
    expect(pinOwnerSeat(server, signed, new Date(NOW.getTime() + 60_000))).toMatchObject({ ok: true, kind: 'repinned' });
    // No user presence: the same body, refused.
    const absent = phone.assert(ownerSeatExportChallenge(body), 0x00);
    expect(verifyOwnerSeatExport({ ...signed, signature: absent.signature, webauthn: { authenticator_data: absent.authenticator_data, client_data_json: absent.client_data_json } }).ok).toBe(false);
  });

  test('a machine with its own owner seat never pins, and a pinned machine never exports or registers a seat', async () => {
    const mac = signerMachine('own');
    const other = signerMachine('own-other');
    const onSigner = pinOwnerSeat(mac.home, exported(other), NOW);
    expect(onSigner.ok).toBe(false);
    if (!onSigner.ok) expect(onSigner.why).toContain('owner seat of its own');
    const server = tempHome('own-server');
    expect(pinOwnerSeat(server, exported(mac), NOW).ok).toBe(true);
    const store = fakeStore();
    expect(exportOwnerSeat(server, store, NOW).ok).toBe(false);
    const seat = registerOwnerSeat(server, { team: 'floor', signer: 'local' }, store, NOW);
    expect(seat.ok).toBe(false);
    if (!seat.ok) expect(seat.why).toContain('pinned from another machine');
    const setup = testIo(server, OWNER);
    expect(await runSetup(['--signer', 'touch-id'], setup, { home: server, store, now: () => NOW })).toBe(1);
    expect(setup.err).toContain('pinned from another machine');
  });

  test('a damaged pin is refused, never read as no pin: the terminal stays not the owner and no answer is accepted', () => {
    const mac = signerMachine('damaged');
    const server = tempHome('damaged-server');
    expect(pinOwnerSeat(server, exported(mac), NOW).ok).toBe(true);
    const good = readFileSync(ownerSeatPinFile(server), 'utf8');
    for (const text of ['not json', JSON.stringify({ ...JSON.parse(good), fingerprint: 'f'.repeat(64) }), '{}']) {
      writeFileSync(ownerSeatPinFile(server), text);
      expect(readOwnerPin(server).kind).toBe('refused');
      expect(ownerPinPresent(server)).toBe(true);
      const again = pinOwnerSeat(server, exported(mac), NOW);
      expect(again.ok).toBe(false);
    }
    // A link in the pin's place is no pin either.
    rmSync(ownerSeatPinFile(server));
    symlinkSync(join(server, 'elsewhere.json'), ownerSeatPinFile(server));
    expect(readOwnerPin(server).kind).toBe('refused');
    expect(ownerPinPresent(server)).toBe(true);
  });
});

describe('requests name the pinned machine; a local owner\'s requests are unchanged', () => {
  test('a request on a pinned machine names it, inside the signed hash; one on a local machine names none and hashes as before', () => {
    const mac = signerMachine('names');
    const server = tempHome('names-server');
    const pinned = pinOwnerSeat(server, exported(mac), NOW);
    if (!pinned.ok) throw new Error(pinned.why);
    const input = { actions: ['team-up'] as const, root: join(server, 'repo'), team: 'acme', head: null, args: { 'team-up': [] }, requestedBy: 'lead' };
    const onServer = createOwnerActionRequest(server, { ...input, actions: [...input.actions] }, NOW);
    if (!onServer.ok) throw new Error(onServer.why);
    expect(onServer.record.params.machine).toEqual({ id: pinned.machine.id, name: pinned.machine.name });
    const unbound: OwnerActionParams = { ...onServer.record.params };
    delete unbound.machine;
    expect(ownerActionHash(unbound)).not.toBe(onServer.record.params_sha256);
    expect(requestMachineProblem(server, onServer.record.params.machine, onServer.record.request_id)).toBeNull();
    expect(requestMachineProblem(server, undefined, 'oa_x')).toContain('names no machine');

    const onMac = createOwnerActionRequest(mac.home, { ...input, root: join(mac.home, 'repo'), actions: [...input.actions] }, NOW);
    if (!onMac.ok) throw new Error(onMac.why);
    expect(onMac.record.params.machine).toBeUndefined();
    // The hash a local request had before machines existed: the same fields, in the same order.
    const p = onMac.record.params;
    const words: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    words['team-up'] = [];
    const args: Record<string, string> = Object.create(null) as Record<string, string>;
    args['team-up'] = p.args['team-up']!;
    const before = createHash('sha256').update(JSON.stringify({ kind: p.kind, actions: [...p.actions], root: p.root, team: p.team, head: p.head, args, requested_by: p.requested_by, words }), 'utf8').digest('hex');
    expect(onMac.record.params_sha256).toBe(before);
    expect(requestMachineProblem(mac.home, undefined, onMac.record.request_id)).toBeNull();
    expect(requestMachineProblem(mac.home, onServer.record.params.machine, onServer.record.request_id)).toContain('runs only there');
  });

  test('the pinned answer check: an accepted pinned signer over exactly this answer, for the pinned seat', () => {
    const mac = signerMachine('verify');
    const server = tempHome('verify-server');
    expect(pinOwnerSeat(server, exported(mac), NOW).ok).toBe(true);
    const pin = readOwnerPin(server);
    if (pin.kind !== 'pinned') throw new Error('not pinned');
    const answer: OwnerSeatAnswer = { kind: 'owner-action', request_id: 'oa_0123456789abcdef01234567', params_sha256: 'a'.repeat(64), choice: 'once', team: 'floor', seat: 'owner', at: NOW.toISOString() };
    const label = pin.body.signers[0]!.label;
    const signature = mac.store.sign(label, ownerSeatAnswerBytes(answer), 'test');
    if (!signature.ok) throw new Error(signature.why);
    expect(verifyPinnedOwnerAnswer(pin, { owner_seat_answer: answer, signer: 'mac', signature: signature.signature }).ok).toBe(true);
    expect(verifyPinnedOwnerAnswer(pin, { owner_seat_answer: { ...answer, choice: 'always' }, signer: 'mac', signature: signature.signature }).ok).toBe(false);
    expect(verifyPinnedOwnerAnswer(pin, { owner_seat_answer: { ...answer, team: 'other' }, signer: 'mac', signature: signature.signature }).ok).toBe(false);
    expect(verifyPinnedOwnerAnswer(pin, { owner_seat_answer: answer, signer: 'nobody', signature: signature.signature }).ok).toBe(false);
  });
});
