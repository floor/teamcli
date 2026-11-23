// A general grant on a shared server whose owner seat is pinned: the same grant, signed by the
// pinned signer on the other machine, carried like an approval and checked at every use. Every scene uses temporary folders, a fake credential store and the helper run
// in-process, with this test's own uid standing for the administrator and the helper's user.
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { ownerActionCard } from '../src/client/approval-card.ts';
import { generalDoor, PINNED_GENERAL_REFUSAL } from '../src/client/general-door.ts';
import { GENERAL_GRANT_DOMAIN, generalGrantPath, issueOwnerGeneralGrant } from '../src/client/general-grant.ts';
import { actionArgsHash, approveOwnerAction, ownerActionHash, readOwnerActionRecord } from '../src/client/owner-action.ts';
import { acceptCarriedAnswer, ownerRequestFile, signCarriedRequest } from '../src/client/owner-carry.ts';
import type { OwnerStateRoots } from '../src/client/owner-pin-path.ts';
import { exportOwnerSeat, localOwnerSeatFingerprint, pinOwnerSeat, type SignedOwnerSeatExport } from '../src/client/owner-pin.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runOwnerSpend, verdictLine } from '../src/client/owner-spend.ts';
import { revokePinnedGrant } from '../src/client/pinned-grant.ts';
import { newClientKeyPair, readClientPrivateKey, writeClientKeyFiles } from '../src/client/records.ts';
import { runClient } from '../src/commands/client.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf, keyState, signDomain, type Json } from '../src/store/keys.ts';
import { fixtureBase, testIo } from './helpers.ts';
import { setOwnerHelperForTests } from './helpers/owner-helper-exec.ts';
import { setOwnerStateRootsForTests } from './helpers/owner-state-roots.ts';
import { SUITE_OWNER_STATE_ROOTS } from './preload/team-config-source.ts';

const NOW = new Date();
const DAY = 86_400_000;
const UID = process.getuid?.() ?? 0;
const ACCOUNT_UIDS: Record<string, number> = { floor: 5001, studio: 5002 };
const base = realpathSync(fixtureBase('.pinned-grant-'));
let serial = 0;
const fresh = (label: string): string => {
  const dir = join(base, `${label}-${serial++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
afterEach(() => {
  setOwnerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  setOwnerHelperForTests(null);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

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

function signerMachine() {
  setOwnerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  const home = join(fresh('mac'), 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  if (!registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW).ok) throw new Error('seat');
  if (!writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: NOW }).ok) throw new Error('policy');
  const exported = exportOwnerSeat(home, store, NOW);
  if (!exported.ok) throw new Error(exported.why);
  return { home, store, exported: exported.signed };
}
type Mac = ReturnType<typeof signerMachine>;

function sharedMachine(signed: SignedOwnerSeatExport, name = 'server') {
  const at = fresh('linux');
  const system = join(at, 'etc', 'teamcli');
  const ledger = join(at, 'var', 'lib', 'teamcli-owner', 'ledger');
  for (const dir of [system, ledger]) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
  }
  writeFileSync(join(system, 'owner-helper.json'), `${JSON.stringify({ format: 'team-owner-helper-v1', user: 'teamcli-owner', uid: UID })}\n`, { mode: 0o644 });
  const homes: Record<string, string> = { floor: join(at, 'home', 'floor'), studio: join(at, 'home', 'studio') };
  for (const home of Object.values(homes)) mkdirSync(join(home, '.config', 'team'), { recursive: true });
  let account = 'floor';
  const roots: OwnerStateRoots = { system, account: () => 'none', systemOwner: UID, shared: { ledger, account: () => account } };
  const use = (who: string) => {
    account = who;
    setOwnerStateRootsForTests(roots);
    setOwnerHelperForTests((stdin) => {
      const verdict = runOwnerSpend({
        stdin,
        env: { SUDO_UID: String(ACCOUNT_UIDS[account]), SUDO_USER: account },
        uid: UID,
        clock: () => new Date(),
        nameOf: (uid) => Object.keys(ACCOUNT_UIDS).find((key) => ACCOUNT_UIDS[key] === uid) ?? null,
      });
      return { status: verdict.ok ? 0 : 1, stdout: verdictLine(verdict) };
    });
  };
  use('floor');
  const pinned = pinOwnerSeat(homes.floor!, signed, NOW, { name });
  if (!pinned.ok) throw new Error(pinned.why);
  return { system, ledger, homes, use };
}
type Machine = ReturnType<typeof sharedMachine>;

const AGENT: Caller = { kind: 'seat', name: 'lead', pane: 'p1', session: 'acme' };

function repo(home: string): string {
  const root = join(home, 'acme');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  return realpathSync(root);
}

function holderKey(home: string, name = 'ops') {
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', name), pair);
  if (!written.ok) throw new Error(written.why);
  return written;
}

function client(home: string, cwd: string, argv: string[], store: OwnerSeatKeyStore, caller: Caller = AGENT) {
  const io = testIo(cwd, caller);
  io.env = { HOME: home };
  const code = runClient(argv, io, home, store);
  return { code, out: io.out, err: io.err };
}

/** The whole route: key on the server, request, carried, one signature, answer, issue. */
function issued(m: Machine, mac: Mac, extra: string[] = ['--days', '7'], heldKey?: ReturnType<typeof holderKey>) {
  m.use('floor');
  const home = m.homes.floor!;
  const root = repo(home);
  const key = heldKey ?? holderKey(home);
  const store = fakeStore();
  const line = ['general-grant', '--to', 'ops', '--public-key', key.pubPath, ...extra];
  const asked = client(home, root, [...line, '--request'], store);
  expect(asked.code, asked.err).toBe(0);
  const id = /request (oa_[0-9a-f]{24})/.exec(asked.out)?.[1] ?? '';
  const file = ownerRequestFile(home, id, store, new Date());
  if (!file.ok) throw new Error(file.why);
  setOwnerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  const signed = signCarriedRequest(mac.home, file.file, mac.store, new Date(), (record) => {
    const answered = approveOwnerAction(mac.home, record.request_id, 'oui', mac.store, new Date());
    return answered.ok ? { ok: true } : answered;
  }, localOwnerSeatFingerprint(mac.home, new Date()));
  if (!signed.ok || signed.kind !== 'answered') throw new Error(signed.ok ? 'waiting' : signed.why);
  m.use('floor');
  const accepted = acceptCarriedAnswer(home, signed.file, store, new Date());
  if (!accepted.ok) throw new Error(accepted.why);
  const done = client(home, root, [...line, '--approval', id], store);
  expect(done.code, done.err).toBe(0);
  const grantId = `gg_${id.slice(3)}`;
  return { id, grantId, home, root, key, store, line, path: generalGrantPath(home, grantId) };
}

type Held = { home: string; root: string; path: string; key: { keyPath: string } };
function door(g: Held, name = 'down', at: Date = new Date()) {
  const io = testIo(g.root);
  io.env = { HOME: g.home };
  return generalDoor(name, ['--general', g.path, '--key', g.key.keyPath], io, at);
}

function edited(g: { path: string }, change: (file: any) => void): string {
  const file = JSON.parse(readFileSync(g.path, 'utf8'));
  change(file);
  const path = `${g.path}.edited.json`;
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
  return path;
}

describe('a general grant signed by the pinned signer', () => {
  test('it admits an owner action on a pinned machine that holds no owner key', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const admitted = door(g);
    expect(admitted.kind).toBe('admitted');
    if (admitted.kind === 'admitted') expect(admitted.io.caller).toEqual({ kind: 'owner' });
    expect(keyState(g.home).kind).toBe('missing');
  });

  test('its card names what it grants', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac, ['--ops', 'down,up', '--days', '3']);
    const record = readOwnerActionRecord(g.home, g.id);
    if (typeof record === 'string') throw new Error(record);
    const card = ownerActionCard(record.params);
    for (const word of ['"ops"', 'ops down, up', '3 days']) expect(card.change).toContain(word);
  });

  test('op rules stay the ordinary ones: a listed grant covers only its ops', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac, ['--ops', 'down', '--days', '7']);
    expect(door(g, 'down').kind).toBe('admitted');
    const other = door(g, 'restart');
    expect(other.kind === 'refused' && other.why).toContain('does not cover restart');
  });

  test('a grant signed with the account key is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const pair = newClientKeyPair();
    const own = issueOwnerGeneralGrant(g.home, { clientId: 'self', publicKey: pair.publicKey, entities: ['*'], ops: ['*'], mayIssue: true, expires: new Date(Date.now() + DAY) });
    if (!own.ok) throw new Error(own.why);
    const refused = door({ ...g, path: own.path });
    expect(refused.kind === 'refused' && refused.why).toBe(PINNED_GENERAL_REFUSAL);
  });

  test('a forged signature is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const forged = edited(g, (file) => {
      const signature: string = file.owner_answer.answer.signature;
      file.owner_answer.answer.signature = `${signature.slice(0, -2)}${signature.endsWith('00') ? '11' : '00'}`;
    });
    expect(door({ ...g, path: forged }).kind).toBe('refused');
  });

  test('an edited grant or edited signed words are refused, even with the hash redone', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac, ['--ops', 'down', '--days', '7']);
    const widened = edited(g, (file) => { file.general_grant.ops = ['*']; });
    const one = door({ ...g, path: widened }, 'restart');
    expect(one.kind === 'refused' && one.why).toContain('not what the owner signed');
    const longer = edited(g, (file) => { file.general_grant.expires = new Date(Date.now() + 90 * DAY).toISOString(); });
    expect(door({ ...g, path: longer }).kind).toBe('refused');
    const words = edited(g, (file) => {
      const params = file.owner_answer.record.params;
      const list = params.words['team-general-grant'] as string[];
      list[list.findIndex((word) => word.startsWith('ops='))] = 'ops=*';
      params.args['team-general-grant'] = actionArgsHash('team-general-grant', list);
      file.owner_answer.record.params_sha256 = ownerActionHash(params);
      file.general_grant.ops = ['*'];
    });
    const two = door({ ...g, path: words }, 'restart');
    expect(two.kind === 'refused' && two.why).toContain('not bound');
  });

  test('an expired grant is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    expect(door(g, 'down', new Date(NOW.getTime() + 6 * DAY)).kind).toBe('admitted');
    const late = door(g, 'down', new Date(NOW.getTime() + 8 * DAY));
    expect(late.kind === 'refused' && late.why).toContain('has expired');
  });

  test('a revoked grant is refused, with the grants under it; only the administrator revokes', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac, ['--may-issue', '--days', '7']);
    const childKey = holderKey(g.home, 'child');
    const made = client(g.home, g.root, ['general-grant', '--to', 'child', '--public-key', childKey.pubPath, '--ops', 'down', '--days', '1', '--via', g.path, '--key', g.key.keyPath], g.store, { kind: 'unplaced', reason: 'a client shell', pinned: true });
    expect(made.code, made.err).toBe(0);
    const childPath = /grant file: (.+)/.exec(made.out)![1]!;
    const child = { ...g, path: childPath, key: childKey };
    expect(door(child).kind).toBe('admitted');
    expect(revokePinnedGrant(g.home, g.grantId, new Date(), UID + 1).ok).toBe(false);
    expect(revokePinnedGrant(g.home, g.grantId, new Date(), UID)).toEqual({ ok: true, already: false });
    const refused = door(g);
    expect(refused.kind === 'refused' && refused.why).toContain('revoked');
    expect(door(child).kind).toBe('refused');
  });

  test('a grant on another machine is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const other = sharedMachine(mac.exported, 'other');
    other.use('floor');
    const refused = door(g);
    expect(refused.kind === 'refused' && refused.why).toContain('not for this machine');
  });

  test('a grant under another account is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    m.use('studio');
    const studio = m.homes.studio!;
    const keyDir = join(studio, '.config', 'team-client', 'ops');
    mkdirSync(join(studio, '.config', 'team-client'), { recursive: true });
    cpSync(join(g.home, '.config', 'team-client', 'ops'), keyDir, { recursive: true });
    const refused = door({ home: studio, root: repo(studio), path: g.path, key: { keyPath: join(keyDir, 'client.key') } });
    expect(refused.kind === 'refused' && refused.why).toContain('not for account studio');
  });

  test('a signed record the helper never spent admits nothing, and an answer issues once', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const replay = client(g.home, g.root, [...g.line, '--approval', g.id], g.store);
    expect(replay.code).toBe(1);
    expect(replay.err).toContain('single-use');
    rmSync(join(m.ledger, 'floor', `${g.id}.team-general-grant`));
    const unspent = door(g);
    expect(unspent.kind === 'refused' && unspent.why).toContain('never spent');
  });

  test('a valid grant of the same holder cannot stand in for a child\'s revoked parent', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const first = issued(m, mac, ['--may-issue', '--days', '7']);
    const second = issued(m, mac, ['--may-issue', '--days', '7'], first.key);
    const childKey = holderKey(first.home, 'child');
    const made = client(first.home, first.root, ['general-grant', '--to', 'child', '--public-key', childKey.pubPath, '--ops', 'down', '--days', '1', '--via', first.path, '--key', first.key.keyPath], first.store, { kind: 'unplaced', reason: 'a client shell', pinned: true });
    expect(made.code, made.err).toBe(0);
    const child = { ...first, path: /grant file: (.+)/.exec(made.out)![1]!, key: childKey };
    expect(door(child).kind).toBe('admitted');
    expect(revokePinnedGrant(first.home, first.grantId, new Date(), UID).ok).toBe(true);
    writeFileSync(first.path, readFileSync(second.path));
    const refused = door(child);
    expect(refused.kind === 'refused' && refused.why).toContain('is not the parent it names');
  });

  test('a holder whose grant may not issue cannot sign a child that verifies', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    const held = readClientPrivateKey(g.home, g.key.keyPath);
    if (!held.ok) throw new Error(held.why);
    const childKey = holderKey(g.home, 'child');
    const pub = (JSON.parse(readFileSync(childKey.pubPath, 'utf8')) as { public_key: string }).public_key;
    const child = { grant_id: 'gg_0123456789abcdef01234567', client_id: 'child', public_key: pub, entities: ['*'], ops: ['down'], may_issue: false, parent: g.grantId, issued: new Date().toISOString(), expires: new Date(Date.now() + DAY).toISOString() };
    const signature = signDomain(GENERAL_GRANT_DOMAIN, { general_grant: child } as unknown as Json, createPrivateKey(held.privatePem));
    const path = generalGrantPath(g.home, child.grant_id);
    writeFileSync(path, JSON.stringify({ general_grant: child, signature }), { mode: 0o600 });
    const refused = door({ ...g, path, key: childKey });
    expect(refused.kind === 'refused' && refused.why).toContain('may not issue');
  });

  test('the ledger entry must record this exact spend: an incomplete or different one admits nothing', () => {
    const mac = signerMachine();
    const m = sharedMachine(mac.exported);
    const g = issued(m, mac);
    expect(door(g).kind).toBe('admitted');
    const path = join(m.ledger, 'floor', `${g.id}.team-general-grant`);
    const whole = readFileSync(path, 'utf8');
    const entry = JSON.parse(whole) as Record<string, unknown>;
    const without = (name: string) => JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== name)));
    const cases = [
      '', whole.slice(0, 20),
      ...['request_id', 'action', 'params_sha256', 'account', 'signer', 'at'].map(without),
      JSON.stringify({ ...entry, request_id: 'oa_000000000000000000000000' }),
      JSON.stringify({ ...entry, action: 'team-up' }),
      JSON.stringify({ ...entry, params_sha256: '0'.repeat(64) }),
      JSON.stringify({ ...entry, account: 'studio' }),
      JSON.stringify({ ...entry, signer: 'other' }),
      JSON.stringify({ ...entry, at: new Date(Date.now() + 16 * 60_000).toISOString() }),
      JSON.stringify({ ...entry, at: new Date(Date.now() - 60 * 60_000).toISOString() }),
    ];
    for (const text of cases) {
      writeFileSync(path, text);
      const refused = door(g);
      expect(refused.kind === 'refused' && refused.why, text).toContain('never spent');
    }
    writeFileSync(path, whole);
    expect(door(g).kind).toBe('admitted');
  });
});
