// A machine whose accounts share one owner (Linux): the owner's administrator account and one
// unprivileged account per entity. The pin and the machine record sit in a system folder only the
// administrator writes, the ledger in a folder only the owner helper's user writes, and an
// approval is spent only by the helper, for the account the system's privilege tool names. Every
// scene uses temporary folders and this test's own uid as "the administrator" and "the helper's
// user", since a test cannot make folders another user owns; the helper is run in-process with
// the identity the privilege tool would give it. The macOS roots are checked to be unchanged.
import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { actionArgsHash, admitOwnerAction, approveOwnerAction, createOwnerActionRequest, ownerActionHash, readOwnerActionRecord, type OwnerActionRecord } from '../src/client/owner-action.ts';
import { acceptCarriedAnswer, ownerRequestFile, signCarriedRequest, type OwnerAnswerFile } from '../src/client/owner-carry.ts';
import { ownerMachinePinned, ownerStateOf, ownerStateRootsForTests, productionOwnerStateRoots, type OwnerStateRoots } from '../src/client/owner-pin-path.ts';
import { claimInLedger, exportOwnerSeat, ledgerSpent, localOwnerSeatFingerprint, pinOwnerSeat, readOwnerPin, type SignedOwnerSeatExport } from '../src/client/owner-pin.ts';
import { judgeSpend, OWNER_SPEND_FORMAT, ownerSpendRunnerForTests, runOwnerSpend, verdictLine, type SpendRunner } from '../src/client/owner-spend.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf } from '../src/store/keys.ts';
import { SUITE_OWNER_STATE_ROOTS } from './preload/team-config-source.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const LATER = (ms: number) => new Date(NOW.getTime() + ms);
const UID = process.getuid?.() ?? 0;
const ACCOUNT_UIDS: Record<string, number> = { floor: 5001, studio: 5002 };
const made: string[] = [];
afterEach(() => {
  ownerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  ownerSpendRunnerForTests(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `owner-shared-${label}-`)));
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

/** The signer machine (the Mac), under the suite's roots: one seat, one device key `mac`. */
function signerMachine() {
  ownerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  const home = join(temp('mac'), 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  if (!registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW).ok) throw new Error('seat');
  if (!writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: NOW }).ok) throw new Error('policy');
  const exported = exportOwnerSeat(home, store, NOW);
  if (!exported.ok) throw new Error(exported.why);
  return { home, store, exported: exported.signed };
}

/** A shared machine's system folder as the install leaves it, and the roots that read it. */
function sharedMachine(options: { helper?: boolean; ledger?: boolean } = {}) {
  const base = temp('linux');
  const system = join(base, 'etc', 'teamcli');
  const ledger = join(base, 'var', 'lib', 'teamcli-owner', 'ledger');
  mkdirSync(system, { recursive: true, mode: 0o755 });
  chmodSync(system, 0o755);
  if (options.helper !== false) writeFileSync(join(system, 'owner-helper.json'), `${JSON.stringify({ format: 'team-owner-helper-v1', user: 'teamcli-owner', uid: UID })}\n`, { mode: 0o644 });
  if (options.ledger !== false) {
    mkdirSync(ledger, { recursive: true, mode: 0o755 });
    chmodSync(ledger, 0o755);
  }
  const homes: Record<string, string> = { floor: join(base, 'home', 'floor'), studio: join(base, 'home', 'studio') };
  for (const home of Object.values(homes)) mkdirSync(join(home, '.config', 'team'), { recursive: true });
  let account = 'floor';
  const roots: OwnerStateRoots = { system, account: () => 'none', systemOwner: UID, shared: { ledger, account: () => account } };
  const use = (name: string) => {
    account = name;
    ownerStateRootsForTests(roots);
  };
  return { base, system, ledger, homes, roots, use };
}

/** The helper, run in-process as the privilege tool would start it for the current account. */
function helperRunner(account: () => string, at: () => Date, sent: string[] = []): SpendRunner {
  return (stdin) => {
    sent.push(stdin);
    const name = account();
    const verdict = runOwnerSpend({
      stdin,
      env: { SUDO_UID: String(ACCOUNT_UIDS[name]), SUDO_USER: name },
      uid: UID,
      now: at(),
      nameOf: (uid) => Object.keys(ACCOUNT_UIDS).find((key) => ACCOUNT_UIDS[key] === uid) ?? null,
    });
    return { status: verdict.ok ? 0 : 1, stdout: verdictLine(verdict) };
  };
}

/** The administrator's first pin into the set-up system folder. */
function pinShared(m: ReturnType<typeof sharedMachine>, signed: SignedOwnerSeatExport) {
  m.use('floor');
  const pinned = pinOwnerSeat(m.homes.floor!, signed, NOW, { name: 'server' });
  if (!pinned.ok) throw new Error(pinned.why);
  return pinned;
}

/** One request made by `account` on the shared machine, carried to the signer, answered, carried back. */
function answeredRequest(m: ReturnType<typeof sharedMachine>, mac: ReturnType<typeof signerMachine>, account: string, word = 'oui', repo = 'repo') {
  const home = m.homes[account]!;
  const root = join(home, repo);
  mkdirSync(root, { recursive: true });
  const store = fakeStore();
  m.use(account);
  const asked = createOwnerActionRequest(home, { actions: ['team-import'], root, team: 'acme', head: null, args: { 'team-import': [] }, requestedBy: 'lead' }, NOW);
  if (!asked.ok) throw new Error(asked.why);
  const id = asked.record.request_id;
  const file = ownerRequestFile(home, id, store, NOW);
  if (!file.ok) throw new Error(file.why);
  ownerStateRootsForTests(SUITE_OWNER_STATE_ROOTS);
  const signed = signCarriedRequest(mac.home, file.file, mac.store, NOW, (record) => {
    const answered = approveOwnerAction(mac.home, record.request_id, word, mac.store, NOW);
    return answered.ok ? { ok: true } : answered;
  }, localOwnerSeatFingerprint(mac.home, NOW));
  if (!signed.ok || signed.kind !== 'answered') throw new Error(signed.ok ? 'waiting' : signed.why);
  m.use(account);
  return { home, root, store, id, record: asked.record, answerFile: signed.file };
}

describe('the macOS roots are the ones before shared machines', () => {
  test('darwin: the system folder when present, else the account home; no shared ledger, and no account in requests', () => {
    const mac = productionOwnerStateRoots('darwin');
    expect(mac.system).toBe('/etc/teamcli');
    expect(mac.systemOwner).toBe(0);
    expect(mac.shared).toBeUndefined();
    expect(mac.account(undefined)).toEqual({ home: userInfo().homedir });
    expect(mac.account('/some/other/home')).toEqual({ home: userInfo().homedir });
    const linux = productionOwnerStateRoots('linux');
    expect(linux.system).toBe('/etc/teamcli');
    expect(linux.shared?.ledger).toBe('/var/lib/teamcli-owner/ledger');

    // The same rule over folders this test owns: an account home with nothing reads as never
    // pinned, a pin goes to that home, and a request there names the machine but no account.
    const signer = signerMachine();
    const account = temp('mac-account');
    mkdirSync(join(account, '.config', 'team'), { recursive: true });
    ownerStateRootsForTests({ ...mac, system: join(temp('no-etc'), 'teamcli'), account: () => ({ home: account }) });
    expect(ownerStateOf().kind).toBe('none');
    expect(ownerMachinePinned()).toBe(false);
    const pinned = pinOwnerSeat(account, signer.exported, NOW);
    expect(pinned.ok && pinned.place).toBe('account');
    const state = ownerStateOf();
    expect(state.kind === 'present' && state.place.kind).toBe('account');
    expect(state.kind === 'present' && state.place.shared).toBeUndefined();
    expect((lstatSync(join(account, '.config', 'team', 'owner-seat-pin.json')).mode & 0o777)).toBe(0o600);
    const root = join(account, 'repo');
    mkdirSync(root);
    const asked = createOwnerActionRequest(account, { actions: ['team-import'], root, team: 'acme', head: null, args: { 'team-import': [] }, requestedBy: 'lead' }, NOW);
    expect(asked.ok).toBe(true);
    if (asked.ok) {
      expect(asked.record.params.machine).toBeDefined();
      expect(asked.record.params.account).toBeUndefined();
      // The hash is the one a request without the field always had.
      const { account: _none, ...before } = asked.record.params;
      expect(ownerActionHash(before)).toBe(asked.record.params_sha256);
    }
    // The account's own ledger is still written by the account, as before.
    expect(claimInLedger(account, 'oa_0123456789abcdef01234567', 'team-import', NOW).ok).toBe(true);
  });
});

describe('a missing or unprotected system folder refuses: never unpinned, never the terminal as owner', () => {
  test('no system folder, no helper record, no ledger, or no pin yet: refused for every account', () => {
    const signer = signerMachine();
    const linux = productionOwnerStateRoots('linux');
    const home = temp('acct');
    ownerStateRootsForTests({ ...linux, system: join(temp('missing'), 'teamcli'), shared: { ledger: join(temp('missing-ledger'), 'ledger'), account: () => 'floor' } });
    expect(ownerStateOf().kind).toBe('refused');
    expect(ownerMachinePinned()).toBe(true);
    expect(ownerMachinePinned(home)).toBe(true);
    expect(readOwnerPin(home).kind).toBe('refused');
    // Even the administrator cannot pin into a folder the install has not set up.
    expect(pinOwnerSeat(home, signer.exported, NOW).ok).toBe(false);

    for (const missing of [{ helper: false }, { ledger: false }]) {
      const m = sharedMachine(missing);
      m.use('floor');
      const state = ownerStateOf();
      expect(state.kind).toBe('refused');
      if (state.kind === 'refused') expect(state.setup).toBeUndefined();
      expect(ownerMachinePinned()).toBe(true);
    }
    // Set up, but nothing pinned yet: refused, and the administrator's first pin may go there.
    const m = sharedMachine();
    m.use('floor');
    const unpinned = ownerStateOf();
    expect(unpinned.kind).toBe('refused');
    if (unpinned.kind === 'refused') expect(unpinned.setup?.dir).toBe(m.system);
    expect(readOwnerPin(m.homes.floor!).kind).toBe('refused');
  });

  test('an unprotected folder, pin, helper record, ledger or account ledger refuses', () => {
    const signer = signerMachine();
    const m = sharedMachine();
    pinShared(m, signer.exported);
    m.use('floor');
    expect(ownerStateOf().kind).toBe('present');
    const flips: Array<[string, number, number]> = [
      [m.system, 0o775, 0o755],
      [join(m.system, 'owner-seat-pin.json'), 0o666, 0o644],
      [join(m.system, 'machine.json'), 0o664, 0o644],
      [join(m.system, 'owner-helper.json'), 0o646, 0o644],
      [m.ledger, 0o777, 0o755],
    ];
    for (const [path, open, closed] of flips) {
      chmodSync(path, open);
      expect(ownerStateOf().kind, path).toBe('refused');
      expect(readOwnerPin(m.homes.floor!).kind).toBe('refused');
      chmodSync(path, closed);
      expect(ownerStateOf().kind).toBe('present');
    }
    mkdirSync(join(m.ledger, 'floor'), { mode: 0o777 });
    chmodSync(join(m.ledger, 'floor'), 0o777);
    expect(ownerStateOf().kind).toBe('refused');
    // A ledger another user owns than the one the helper's record names.
    chmodSync(join(m.ledger, 'floor'), 0o755);
    writeFileSync(join(m.system, 'owner-helper.json'), `${JSON.stringify({ format: 'team-owner-helper-v1', user: 'teamcli-owner', uid: UID + 1 })}\n`);
    expect(ownerStateOf().kind).toBe('refused');
    // A system folder the administrator does not own.
    ownerStateRootsForTests({ ...m.roots, systemOwner: UID + 1 });
    expect(ownerStateOf().kind).toBe('refused');
  });
});

describe('only the administrator writes the pin, and only the helper the ledger', () => {
  test('the administrator pins into the system folder, readable by every account; an entity account cannot pin or spend', () => {
    const signer = signerMachine();
    const m = sharedMachine();
    const pinned = pinShared(m, signer.exported);
    expect(pinned.place).toBe('system');
    for (const name of ['owner-seat-pin.json', 'machine.json']) {
      const stat = lstatSync(join(m.system, name));
      expect(stat.mode & 0o777).toBe(0o644);
    }
    // Nothing went to any account's home.
    expect(existsSync(join(m.homes.floor!, '.config', 'team', 'owner-seat-pin.json'))).toBe(false);
    // Both accounts read the one pin and the one machine record.
    for (const account of ['floor', 'studio']) {
      m.use(account);
      const pin = readOwnerPin(m.homes[account]!);
      expect(pin.kind === 'pinned' && pin.machine.id).toBe(pinned.machine.id);
      const state = ownerStateOf();
      expect(state.kind === 'present' && state.place.ledger).toBe(join(m.ledger, account));
    }
    // A process that is not the administrator cannot pin or re-pin, whatever it passes.
    const before = readFileSync(join(m.system, 'owner-seat-pin.json'), 'utf8');
    ownerStateRootsForTests({ ...m.roots, systemOwner: UID + 1 });
    const other = signerMachine();
    ownerStateRootsForTests({ ...m.roots, systemOwner: UID + 1 });
    expect(pinOwnerSeat(m.homes.floor!, other.exported, NOW).ok).toBe(false);
    expect(readFileSync(join(m.system, 'owner-seat-pin.json'), 'utf8')).toBe(before);
    // The account's own ledger write is refused: the helper alone spends.
    m.use('floor');
    const spent = claimInLedger(m.homes.floor!, 'oa_0123456789abcdef01234567', 'team-import', NOW);
    expect(spent.ok).toBe(false);
    if (!spent.ok) expect(spent.why).toContain('owner helper');
    expect(readdirSync(m.ledger)).toEqual([]);
  });

  test('re-pin rules stay: the same seat changes nothing, a changed seat needs a pinned signer', () => {
    const signer = signerMachine();
    const m = sharedMachine();
    pinShared(m, signer.exported);
    m.use('floor');
    const same = pinOwnerSeat(m.homes.floor!, signer.exported, NOW);
    expect(same.ok && same.kind).toBe('same');
    const stranger = signerMachine();
    m.use('floor');
    const changed = pinOwnerSeat(m.homes.floor!, stranger.exported, NOW);
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.why).toContain('signed by a signer already pinned here');
  });
});

describe('an approval is spent once, by the helper, for the account that asked', () => {
  test('a request names its account; the answer is spent through the helper once, and a replay is refused', () => {
    const mac = signerMachine();
    const m = sharedMachine();
    pinShared(m, mac.exported);
    const r = answeredRequest(m, mac, 'floor');
    expect(r.record.params.account).toBe('floor');
    expect(r.record.params.machine?.name).toBe('server');
    // The account and the machine are inside the hash the owner signed.
    expect(ownerActionHash(r.record.params)).toBe(r.record.params_sha256);
    expect(ownerActionHash({ ...r.record.params, account: 'studio' })).not.toBe(r.record.params_sha256);
    const accepted = acceptCarriedAnswer(r.home, r.answerFile, r.store, NOW);
    expect(accepted.ok, accepted.ok ? '' : accepted.why).toBe(true);

    const account = 'floor';
    const sent: string[] = [];
    ownerSpendRunnerForTests(helperRunner(() => account, () => LATER(60_000), sent));
    const ask = { action: 'team-import' as const, root: r.record.params.root, team: 'acme', head: null, words: [] as string[], claim: true };
    const admitted = admitOwnerAction(r.home, r.id, ask, r.store, LATER(60_000));
    expect(admitted.ok, admitted.ok ? '' : admitted.why).toBe(true);
    expect(sent.length).toBe(1);
    const spend = JSON.parse(sent[0]!) as { record: OwnerActionRecord; ask: { args_sha256: string } };
    expect(spend.record.params_sha256).toBe(r.record.params_sha256);
    expect(spend.ask.args_sha256).toBe(actionArgsHash('team-import', []));
    // Spent in floor's own ledger folder, by the helper.
    expect(readdirSync(join(m.ledger, 'floor'))).toEqual([`${r.id}.team-import`]);
    expect(ledgerSpent(r.home, r.id, 'team-import')).toBe(true);
    // The same id again: refused by the account's own read of the ledger, and by the helper.
    const again = admitOwnerAction(r.home, r.id, ask, r.store, LATER(90_000));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.why).toContain('single-use');
    const direct = helperRunner(() => account, () => LATER(90_000))(sent[0]!);
    expect(direct.status).toBe(1);
    expect(direct.stdout).toContain('single-use');
    // Carried again after the spend: refused.
    const replay = acceptCarriedAnswer(r.home, r.answerFile, r.store, LATER(120_000));
    expect(replay.ok).toBe(false);
  });

  test("account A's answer is refused under account B, on the account's side and by the helper", () => {
    const mac = signerMachine();
    const m = sharedMachine();
    pinShared(m, mac.exported);
    const r = answeredRequest(m, mac, 'floor');
    expect(acceptCarriedAnswer(r.home, r.answerFile, r.store, NOW).ok).toBe(true);
    // studio copies floor's request and answer into its own folder and tries to run them.
    const theirs = m.homes.studio!;
    m.use('studio');
    mkdirSync(actionRequestsFolder(theirs), { recursive: true });
    for (const name of [`${r.id}.json`, `${r.id}.seat-answer.json`]) writeFileSync(join(actionRequestsFolder(theirs), name), readFileSync(join(actionRequestsFolder(r.home), name)));
    const sent: string[] = [];
    ownerSpendRunnerForTests(helperRunner(() => 'studio', () => LATER(60_000), sent));
    const ask = { action: 'team-import' as const, root: r.record.params.root, team: 'acme', head: null, words: [] as string[], claim: true };
    const run = admitOwnerAction(theirs, r.id, ask, r.store, LATER(60_000));
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.why).toContain('account floor');
    const carried = acceptCarriedAnswer(theirs, r.answerFile as OwnerAnswerFile, r.store, NOW);
    expect(carried.ok).toBe(false);
    // Past the account's own check (a changed build, say): the helper refuses it for studio.
    const record = readOwnerActionRecord(r.home, r.id) as OwnerActionRecord;
    const spend = JSON.stringify({ format: OWNER_SPEND_FORMAT, record, answer: r.answerFile.answer, ask: { action: 'team-import', root: record.params.root, team: 'acme', head: null, args_sha256: actionArgsHash('team-import', []) } });
    const refused = helperRunner(() => 'studio', () => LATER(60_000))(spend);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('is for account floor, not studio');
    expect(existsSync(join(m.ledger, 'studio'))).toBe(false);
    // The same spend for floor is accepted: the account is the only difference.
    const accepted = helperRunner(() => 'floor', () => LATER(60_000))(spend);
    expect(accepted.status, accepted.stdout).toBe(0);
  });

  test('the helper refuses an expired, tampered, denied, misdirected or mismatched spend', () => {
    const mac = signerMachine();
    const m = sharedMachine();
    pinShared(m, mac.exported);
    const r = answeredRequest(m, mac, 'floor');
    const pin = readOwnerPin(r.home);
    if (pin.kind !== 'pinned') throw new Error('pin');
    const record = readOwnerActionRecord(r.home, r.id) as OwnerActionRecord;
    const ask = { action: 'team-import', root: record.params.root, team: 'acme', head: null, args_sha256: actionArgsHash('team-import', []) };
    const spend = (over: Record<string, unknown> = {}) => ({ format: OWNER_SPEND_FORMAT, record, answer: r.answerFile.answer, ask, ...over });
    expect(judgeSpend(spend(), pin, 'floor', LATER(60_000)).ok).toBe(true);
    const why = (value: ReturnType<typeof judgeSpend>) => (value.ok ? 'admitted' : value.why);
    expect(why(judgeSpend(spend(), pin, 'floor', LATER(16 * 60_000)))).toContain('expired');
    expect(why(judgeSpend(spend({ record: { ...record, params: { ...record.params, team: 'other' } } }), pin, 'floor', NOW))).toContain('do not match its hash');
    const otherMachine = { ...record.params, machine: { id: 'm_000000000000000000000000', name: 'elsewhere' } };
    expect(why(judgeSpend(spend({ record: { ...record, params: otherMachine, params_sha256: ownerActionHash(otherMachine) } }), pin, 'floor', NOW))).toContain('not for this machine');
    expect(why(judgeSpend(spend({ ask: { ...ask, args_sha256: actionArgsHash('team-import', ['--force']) } }), pin, 'floor', NOW))).toContain('other team-import arguments');
    expect(why(judgeSpend(spend({ ask: { ...ask, action: 'team-up' } }), pin, 'floor', NOW))).toContain('does not approve team-up');
    expect(why(judgeSpend(spend({ ask: { ...ask, root: '/elsewhere' } }), pin, 'floor', NOW))).toContain('not /elsewhere');
    const forged = { ...r.answerFile.answer, signature: '00'.repeat(36) };
    expect(judgeSpend(spend({ answer: forged }), pin, 'floor', NOW).ok).toBe(false);
    // A denial is never spent.
    const denied = answeredRequest(m, mac, 'floor', 'non', 'other-repo');
    const deniedRecord = readOwnerActionRecord(denied.home, denied.id) as OwnerActionRecord;
    expect(why(judgeSpend({ format: OWNER_SPEND_FORMAT, record: deniedRecord, answer: denied.answerFile.answer, ask: { ...ask, root: deniedRecord.params.root } }, pin, 'floor', NOW))).toContain('denied');
  });

  test('the helper spends nothing unless the privilege tool started it as its own user for a known account', () => {
    const mac = signerMachine();
    const m = sharedMachine();
    pinShared(m, mac.exported);
    const r = answeredRequest(m, mac, 'floor');
    const record = readOwnerActionRecord(r.home, r.id) as OwnerActionRecord;
    const stdin = JSON.stringify({ format: OWNER_SPEND_FORMAT, record, answer: r.answerFile.answer, ask: { action: 'team-import', root: record.params.root, team: 'acme', head: null, args_sha256: actionArgsHash('team-import', []) } });
    const nameOf = (uid: number) => Object.keys(ACCOUNT_UIDS).find((key) => ACCOUNT_UIDS[key] === uid) ?? null;
    const base = { stdin, uid: UID, now: LATER(60_000), nameOf };
    const why = (value: ReturnType<typeof runOwnerSpend>) => (value.ok ? 'spent' : value.why);
    // Run directly by the account: its uid is not the helper's.
    expect(why(runOwnerSpend({ ...base, uid: ACCOUNT_UIDS.floor!, env: { SUDO_UID: '5001', SUDO_USER: 'floor' } }))).toContain('runs as teamcli-owner');
    expect(why(runOwnerSpend({ ...base, env: {} }))).toContain('not started for an account');
    expect(why(runOwnerSpend({ ...base, env: { SUDO_UID: '5001', SUDO_USER: 'studio' } }))).toContain('cannot be read from the user database');
    expect(why(runOwnerSpend({ ...base, env: { SUDO_UID: '4242', SUDO_USER: 'floor' } }))).toContain('cannot be read from the user database');
    expect(why(runOwnerSpend({ ...base, env: { SUDO_UID: String(UID), SUDO_USER: 'teamcli-owner' }, nameOf: () => 'teamcli-owner' }))).toContain('not for itself');
    expect(existsSync(join(m.ledger, 'floor'))).toBe(false);
    expect(why(runOwnerSpend({ ...base, env: { SUDO_UID: '5001', SUDO_USER: 'floor' } }))).toBe('spent');
  });

  test("the account runs only on a verdict naming exactly the record it sent", () => {
    const mac = signerMachine();
    const m = sharedMachine();
    pinShared(m, mac.exported);
    const r = answeredRequest(m, mac, 'floor');
    expect(acceptCarriedAnswer(r.home, r.answerFile, r.store, NOW).ok).toBe(true);
    const ask = { action: 'team-import' as const, root: r.record.params.root, team: 'acme', head: null, words: [] as string[], claim: true };
    const verdict = (over: Record<string, unknown>) => (): { status: number; stdout: string } => ({ status: 0, stdout: `${JSON.stringify({ format: 'team-owner-spend-verdict-v1', ok: true, request_id: r.id, action: 'team-import', params_sha256: r.record.params_sha256, account: 'floor', signer: 'mac', ...over })}\n` });
    for (const over of [{ request_id: 'oa_000000000000000000000000' }, { params_sha256: '0'.repeat(64) }, { action: 'team-up' }]) {
      ownerSpendRunnerForTests(verdict(over));
      const run = admitOwnerAction(r.home, r.id, ask, r.store, LATER(60_000));
      expect(run.ok).toBe(false);
      if (!run.ok) expect(run.why).toContain('does not name request');
    }
    ownerSpendRunnerForTests(() => ({ status: 1, stdout: '' }));
    const silent = admitOwnerAction(r.home, r.id, ask, r.store, LATER(60_000));
    expect(silent.ok).toBe(false);
    if (!silent.ok) expect(silent.why).toContain('no verdict');
    ownerSpendRunnerForTests(verdict({}));
    expect(admitOwnerAction(r.home, r.id, ask, r.store, LATER(60_000)).ok).toBe(true);
  });
});
