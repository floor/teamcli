// The one resolver for a pinned machine's owner state — the pin, the machine record and the
// approval ledger — with roots of its own in place of the suite's: a system folder read first when
// it is present and protected, then the account's own home whatever home a command passes, and
// every state it cannot read or trust refused, never read as unpinned. Folders are temporary; the
// "administrator" is this test's own uid, since a test cannot make a folder the system's own.
import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerMachinePinned, ownerStateOf, ownerStateRootsForTests, type OwnerStateRoots } from '../src/client/owner-pin-path.ts';
import { claimInLedger, exportOwnerSeat, ledgerSpent, pinOwnerSeat, readMachine, readOwnerPin } from '../src/client/owner-pin.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf } from '../src/store/keys.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const UID = process.getuid?.() ?? 0;
const made: string[] = [];
const SUITE: OwnerStateRoots = { system: null, account: (given) => given ?? null, systemOwner: UID };
afterEach(() => {
  ownerStateRootsForTests(SUITE);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `owner-state-${label}-`)));
  made.push(dir);
  return dir;
}

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

function fakeStore(): OwnerSeatKeyStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
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
    pinSet: () => ({ ok: true }),
    pinGet: () => ({ ok: false, why: 'no pin' }),
  };
}

/** An export from a signer machine, made under the suite's roots (the signer machine is never pinned). */
function anExport(label: string) {
  const home = join(temp(label), 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  if (!registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW).ok) throw new Error('seat');
  if (!writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: NOW }).ok) throw new Error('policy');
  const made = exportOwnerSeat(home, store, NOW);
  if (!made.ok) throw new Error(made.why);
  return made;
}

/** The process's own rule, with folders this test owns: a system folder, and one account home. */
function realRoots(system: string | null, account: string, owner = UID): void {
  ownerStateRootsForTests({ system, account: () => account, systemOwner: owner });
}

describe('the account home, whatever home a command passes', () => {
  test('a pin in the account home governs; a home a command names elsewhere changes nothing', () => {
    const exported = anExport('account');
    const account = temp('acct');
    mkdirSync(join(account, '.config', 'team'), { recursive: true });
    const elsewhere = temp('elsewhere');
    realRoots(null, account);
    expect(ownerMachinePinned(elsewhere)).toBe(false);
    expect(pinOwnerSeat(elsewhere, exported.signed, NOW).ok).toBe(true);
    // Written to the account home, not to the home the call named.
    expect(existsSync(join(account, '.config', 'team', 'owner-seat-pin.json'))).toBe(true);
    expect(existsSync(join(elsewhere, '.config', 'team', 'owner-seat-pin.json'))).toBe(false);
    expect(ownerMachinePinned(elsewhere)).toBe(true);
    expect(ownerMachinePinned(undefined)).toBe(true);
    expect(readOwnerPin('/any/other/home').kind).toBe('pinned');
    // A pin planted in the home a command names is never read.
    ownerStateRootsForTests(SUITE);
    const planted = anExport('planted');
    expect(pinOwnerSeat(elsewhere, planted.signed, NOW).ok).toBe(true);
    realRoots(null, account);
    const pin = readOwnerPin(elsewhere);
    expect(pin.kind === 'pinned' && pin.fingerprint).toBe(exported.fingerprint);
  });

  test('a parent that is not a folder, and an account home the user database does not answer, are not read as a pin', () => {
    const account = temp('notdir');
    mkdirSync(join(account, '.config'), { recursive: true });
    writeFileSync(join(account, '.config', 'team'), 'a file where the folder was');
    realRoots(null, account);
    expect(ownerStateOf().kind).toBe('refused');
    expect(ownerMachinePinned()).toBe(true);
    expect(readOwnerPin(account).kind).toBe('refused');
    ownerStateRootsForTests({ system: null, account: () => null, systemOwner: UID });
    expect(ownerStateOf()).toEqual({ kind: 'none', write: null });
    const exported = anExport('nohome');
    ownerStateRootsForTests({ system: null, account: () => null, systemOwner: UID });
    expect(pinOwnerSeat(account, exported.signed, NOW).ok).toBe(false);
  });
});

describe('the system folder, read first when it is present and protected', () => {
  function systemWithPin(owner = UID) {
    const exported = anExport('system');
    const staging = temp('staging');
    mkdirSync(join(staging, '.config', 'team'), { recursive: true });
    // The administrator's own step, done here by hand: the pin and machine record put in place.
    ownerStateRootsForTests({ system: null, account: () => staging, systemOwner: owner });
    if (!pinOwnerSeat(staging, exported.signed, NOW, { name: 'server' }).ok) throw new Error('pin');
    const system = join(temp('etc'), 'teamcli');
    mkdirSync(system, { mode: 0o755 });
    for (const name of ['owner-seat-pin.json', 'machine.json']) writeFileSync(join(system, name), readFileSync(join(staging, '.config', 'team', name)), { mode: 0o644 });
    return { exported, system };
  }

  test('a protected system folder holding a pin is the owner state; the account cannot change it here', () => {
    const other = anExport('other');
    const { exported, system } = systemWithPin();
    const account = temp('acct-sys');
    mkdirSync(join(account, '.config', 'team'), { recursive: true });
    realRoots(system, account);
    const state = ownerStateOf();
    expect(state.kind === 'present' && state.place.kind).toBe('system');
    const pin = readOwnerPin(account);
    expect(pin.kind === 'pinned' && pin.fingerprint).toBe(exported.fingerprint);
    expect(readMachine(account)?.name).toBe('server');
    // A pin in the account home is not read while the system folder holds one.
    expect(pinOwnerSeat(account, other.signed, NOW).ok).toBe(false);
    // The ledger is the system folder's: none exists, and this account makes none there.
    realRoots(system, account);
    const spent = claimInLedger(account, 'oa_0123456789abcdef01234567', 'team-import', NOW);
    expect(spent.ok).toBe(false);
    expect(existsSync(join(system, 'owner-ledger'))).toBe(false);
  });

  test('an unprotected system folder or entry, or one another user owns, refuses everything', () => {
    const { system } = systemWithPin();
    const account = temp('acct-unprotected');
    chmodSync(system, 0o775);
    realRoots(system, account);
    expect(ownerStateOf().kind).toBe('refused');
    expect(ownerMachinePinned()).toBe(true);
    expect(readOwnerPin(account).kind).toBe('refused');
    chmodSync(system, 0o755);
    chmodSync(join(system, 'owner-seat-pin.json'), 0o666);
    expect(ownerStateOf().kind).toBe('refused');
    chmodSync(join(system, 'owner-seat-pin.json'), 0o644);
    expect(ownerStateOf().kind).toBe('present');
    realRoots(system, account, UID + 1);
    expect(ownerStateOf().kind).toBe('refused');
  });

  test('an empty protected system folder leaves the account home in charge', () => {
    const system = join(temp('etc-empty'), 'teamcli');
    mkdirSync(system, { mode: 0o755 });
    const account = temp('acct-empty');
    mkdirSync(join(account, '.config', 'team'), { recursive: true });
    realRoots(system, account);
    expect(ownerStateOf().kind).toBe('none');
    expect(pinOwnerSeat(account, anExport('empty').signed, NOW).ok).toBe(true);
    const state = ownerStateOf();
    expect(state.kind === 'present' && state.place.kind).toBe('account');
  });
});

describe('the ledger', () => {
  test('one entry per request and action, created once, where the resolver keeps the owner state', () => {
    const account = temp('ledger');
    mkdirSync(join(account, '.config', 'team'), { recursive: true });
    realRoots(null, account);
    const id = 'oa_0123456789abcdef01234567';
    expect(claimInLedger(account, id, 'team-import', NOW).ok).toBe(false);
    expect(pinOwnerSeat(account, anExport('ledger-pin').signed, NOW).ok).toBe(true);
    realRoots(null, account);
    expect(ledgerSpent('/elsewhere', id)).toBe(false);
    expect(claimInLedger('/elsewhere', id, 'team-import', NOW).ok).toBe(true);
    expect(existsSync(join(account, '.config', 'team', 'owner-ledger', `${id}.team-import`))).toBe(true);
    expect(ledgerSpent('/elsewhere', id)).toBe(true);
    expect(ledgerSpent('/elsewhere', id, 'team-import')).toBe(true);
    expect(ledgerSpent('/elsewhere', id, 'team-up')).toBe(false);
    const again = claimInLedger(account, id, 'team-import', NOW);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.why).toContain('single-use');
    // A ledger replaced by a file spends nothing more and reads as spent.
    rmSync(join(account, '.config', 'team', 'owner-ledger'), { recursive: true });
    writeFileSync(join(account, '.config', 'team', 'owner-ledger'), 'x');
    expect(claimInLedger(account, id, 'team-up', NOW).ok).toBe(false);
    expect(ledgerSpent(account, id)).toBe(true);
  });
});
