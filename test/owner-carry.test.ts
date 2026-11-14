// Owner requests carried as files between a machine whose owner seat is pinned and the machine that
// holds the owner's signers: the request is exported, signed with the same card as any other,
// carried back, verified against the pin, and the command runs once with `--approval`. Every
// refusal is a scene: another machine, an expired request, a replayed id, a tampered answer or
// request, and the signer machine running the request itself. The signer is a fake credential
// store; homes, repositories and pane names are synthetic, and no terminal host is started.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_TERMINAL_REASON, type Caller } from '../src/caller.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { actionArgsHash, admitOwnerAction, approveOwnerAction, createOwnerActionRequest, ownerActionHash, readOwnerActionRecord, type OwnerActionParams, type OwnerActionRecord } from '../src/client/owner-action.ts';
import type { OwnerAnswerFile, OwnerRequestFile } from '../src/client/owner-carry.ts';
import { generalDoor, PINNED_GENERAL_REFUSAL } from '../src/client/general-door.ts';
import { readGeneralGrant } from '../src/client/general-grant.ts';
import { ownerAuthorized } from '../src/approve/owner-token.ts';
import { runDevelopmentMode } from '../src/commands/development-mode.ts';
import { readDevelopmentMode } from '../src/development_mode.ts';
import { ownerSeatPinFile } from '../src/client/owner-pin-path.ts';
import { exportOwnerSeat, pinOwnerSeat, type SignedOwnerSeatExport } from '../src/client/owner-pin.ts';
import { ownerSeatInbox, registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionApprovalsFolder, actionRequestsFolder } from '../src/client/team-create.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runImport } from '../src/commands/import.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { readStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const LATER = (ms: number) => new Date(NOW.getTime() + ms);
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

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

function tempBase(label: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `owner-carry-${label}-`)));
  made.push(base);
  return base;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Carry', GIT_AUTHOR_EMAIL: 'carry@example.invalid', GIT_COMMITTER_NAME: 'Carry', GIT_COMMITTER_EMAIL: 'carry@example.invalid' },
  });
}

/** The signer machine: one owner seat, one Secure Enclave signer `mac`, accepted by policy. */
function signerMachine() {
  const home = join(tempBase('mac'), 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore();
  const seat = registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW);
  if (!seat.ok) throw new Error(seat.why);
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
  return { home, store };
}

/** A machine with no owner signer, holding team `acme` in a repository, its seat `lead` placed. */
function pinnedMachine(signed: SignedOwnerSeatExport, name: string) {
  const home = tempBase(name);
  const root = join(home, 'repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  const lobby = resolveLobby(home, { entity: 'acme' });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
entity: acme
session: acme
coordinator: lead
operator: ops
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops' };
  });
  const pinned = pinOwnerSeat(home, signed, NOW, { name });
  if (!pinned.ok) throw new Error(pinned.why);
  return { home, root, machine: pinned.machine };
}

const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
const TERMINAL: Caller = { kind: 'unplaced', reason: PINNED_TERMINAL_REASON, pinned: true };

/** One whole scene: the signer machine, its export, and one pinned machine with a recorded request. */
async function scene(name = 'server') {
  const mac = signerMachine();
  const exported = exportOwnerSeat(mac.home, mac.store, NOW);
  if (!exported.ok) throw new Error(exported.why);
  const server = pinnedMachine(exported.signed, name);
  const asked = testIo(server.root, LEAD);
  expect(await runImport(['--request'], asked, { home: server.home, now: () => NOW }), asked.err).toBe(0);
  const id = /owner-seat request (oa_[0-9a-f]{24}) recorded/.exec(asked.out)?.[1];
  if (id === undefined) throw new Error(`no request id in ${asked.out}`);
  return { mac, server, id, exported: exported.signed, files: tempBase('files') };
}

async function exportRequest(s: Awaited<ReturnType<typeof scene>>, at: Date = NOW): Promise<{ code: number; path: string; io: ReturnType<typeof testIo> }> {
  const path = join(s.files, `request-${at.getTime()}.json`);
  const io = testIo(s.server.root, TERMINAL);
  const code = await runApprovals(['export', s.id, '--out', path], io, { home: s.server.home, now: () => at });
  return { code, path, io };
}

async function sign(s: Awaited<ReturnType<typeof scene>>, request: string, word: string | null, at: Date = NOW): Promise<{ code: number; path: string; io: ReturnType<typeof testIo> }> {
  const path = join(s.files, `answer-${at.getTime()}-${Math.random().toString(16).slice(2)}.json`);
  const io = testIo(s.mac.home);
  const code = await runApprovals(['sign', '--from', request, '--out', path, ...(word === null ? [] : ['--answer', word])], io, { home: s.mac.home, now: () => at, ownerSeatStore: s.mac.store });
  return { code, path, io };
}

async function answer(home: string, cwd: string, path: string, at: Date = NOW): Promise<{ code: number; io: ReturnType<typeof testIo> }> {
  const io = testIo(cwd, TERMINAL);
  const code = await runApprovals(['answer', '--from', path], io, { home, now: () => at });
  return { code, io };
}

/** Whether `team import` made the repository's team file the registry's record. */
function registered(home: string, root: string): boolean {
  return readStoredTeamConfig(home, teamIdOf(root)) !== null;
}

describe('a request carried to the signer machine and its answer carried back', () => {
  test('export, sign with the card, answer, then --approval runs the import once', async () => {
    const s = await scene();
    // The pinned machine's terminal is not the owner: a plain import is refused.
    const bare = testIo(s.server.root, TERMINAL);
    expect(await runImport([], bare, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(registered(s.server.home, s.server.root)).toBe(false);

    const request = await exportRequest(s);
    expect(request.code, request.io.err).toBe(0);
    const file = JSON.parse(readFileSync(request.path, 'utf8')) as OwnerRequestFile;
    expect(file.machine).toEqual({ id: s.server.machine.id, name: 'server' });
    expect(file.request.params.machine).toEqual(file.machine);

    // On the signer machine: the request is recorded as a foreign card, the Touch ID card names
    // the machine, and the answer file is written.
    const signed = await sign(s, request.path, 'oui');
    expect(signed.code, signed.io.err).toBe(0);
    expect(signed.io.out).toContain('answered once by mac');
    expect(s.mac.store.reasons.at(-1)).toContain('on server');
    expect(readdirSync(ownerSeatInbox(s.mac.home))).toContain(`${s.id}.json`);
    // The signer machine never runs the request itself.
    const onMac = admitOwnerAction(s.mac.home, s.id, { action: 'team-import', root: file.request.params.root, team: 'acme', head: file.request.params.head, words: [], claim: true }, s.mac.store, NOW);
    expect(onMac.ok).toBe(false);
    if (!onMac.ok) expect(onMac.why).toContain('runs only there');
    // An `always` rule is never kept on the signer machine for another machine's request.
    expect(existsSync(join(actionApprovalsFolder(s.mac.home), `${s.id}.json`))).toBe(false);

    const answered = await answer(s.server.home, s.server.root, signed.path);
    expect(answered.code, answered.io.err).toBe(0);
    expect(answered.io.out).toContain('verified against the pinned owner seat');

    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => LATER(60_000) }), run.err + run.out).toBe(0);
    expect(registered(s.server.home, s.server.root)).toBe(true);

    // Single use: the same id, the same answer, refused.
    const again = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], again, { home: s.server.home, now: () => LATER(90_000) })).toBe(1);
    expect(again.err + again.out).toContain('single-use');
    const replayed = await answer(s.server.home, s.server.root, signed.path, LATER(120_000));
    expect(replayed.code).toBe(1);
  });

  test('a request made on the signer machine never joins a card carried from another machine', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    expect((await sign(s, request.path, null)).code).toBe(0);
    const foreign = readFileSync(join(actionRequestsFolder(s.mac.home), `${s.id}.json`), 'utf8');
    expect(JSON.parse(foreign).join).toBeUndefined();
    const carried = (JSON.parse(readFileSync(request.path, 'utf8')) as OwnerRequestFile).request;
    // The same folder, team and HEAD, asked on the signer machine at once: its own card.
    const local = createOwnerActionRequest(s.mac.home, { actions: ['team-import'], root: carried.params.root, team: 'acme', head: carried.params.head, args: { 'team-import': [] }, requestedBy: 'probe' }, NOW);
    expect(local.ok).toBe(true);
    if (local.ok) {
      expect(local.record.request_id).not.toBe(s.id);
      expect(local.record.params.machine).toBeUndefined();
    }
    expect(readFileSync(join(actionRequestsFolder(s.mac.home), `${s.id}.json`), 'utf8')).toBe(foreign);
  });

  test('a card answered on the owner page: sign with no answer waits, then writes the page\'s answer', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const waiting = await sign(s, request.path, null);
    expect(waiting.code, waiting.io.err).toBe(0);
    expect(waiting.io.out).toContain('is on the owner page');
    expect(existsSync(waiting.path)).toBe(false);
    // The owner answers on the page; the page's route is the same answer function.
    expect(approveOwnerAction(s.mac.home, s.id, 'oui', s.mac.store, NOW).ok).toBe(true);
    const written = await sign(s, request.path, null);
    expect(written.code, written.io.err).toBe(0);
    expect(existsSync(written.path)).toBe(true);
    expect((await answer(s.server.home, s.server.root, written.path)).code).toBe(0);
  });

  test('a denial is carried back and admits nothing', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'non');
    expect(signed.code, signed.io.err).toBe(0);
    const answered = await answer(s.server.home, s.server.root, signed.path);
    expect(answered.code).toBe(0);
    expect(answered.io.out).toContain('denied');
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(registered(s.server.home, s.server.root)).toBe(false);
  });
});

describe('refusals', () => {
  test('another machine: the answer, and the request copied there with it, are refused', async () => {
    const s = await scene();
    const other = pinnedMachine(s.exported, 'other');
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'oui');
    expect(signed.code).toBe(0);
    // The other machine holds no such request.
    expect((await answer(other.home, other.root, signed.path)).code).toBe(1);
    // An agent copies the request record there too: it names the first machine, so it is refused.
    mkdirSync(actionRequestsFolder(other.home), { recursive: true });
    copyFileSync(join(actionRequestsFolder(s.server.home), `${s.id}.json`), join(actionRequestsFolder(other.home), `${s.id}.json`));
    const copied = await answer(other.home, other.root, signed.path);
    expect(copied.code).toBe(1);
    expect(copied.io.err).toContain(`is for machine server (${s.server.machine.id}), not this one`);
    // And the signed answer copied beside it admits nothing there either.
    const file = JSON.parse(readFileSync(signed.path, 'utf8')) as OwnerAnswerFile;
    writeFileSync(join(actionRequestsFolder(other.home), `${s.id}.seat-answer.json`), JSON.stringify(file.answer));
    const run = testIo(other.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: other.home, now: () => NOW })).toBe(1);
    expect(run.err + run.out).toContain('not this one');
    expect(registered(other.home, other.root)).toBe(false);
  });

  test('a request made before the pin, naming no machine, is never answered on the pinned machine', async () => {
    const s = await scene();
    const record = readOwnerActionRecord(s.server.home, s.id) as OwnerActionRecord;
    const unbound = { ...record.params };
    delete unbound.machine;
    const legacy = { ...record, request_id: 'oa_00000000000000000000beef', params: unbound, params_sha256: ownerActionHash(unbound) };
    writeFileSync(join(actionRequestsFolder(s.server.home), `${legacy.request_id}.json`), JSON.stringify(legacy));
    const io = testIo(s.server.root, TERMINAL);
    expect(await runApprovals(['export', legacy.request_id, '--out', join(s.files, 'legacy.json')], io, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(io.err).toContain('names no machine');
  });

  test('expired: the export, the signature and the answer each refuse past the window', async () => {
    const s = await scene();
    const late = LATER(16 * 60_000);
    expect((await exportRequest(s, late)).code).toBe(1);
    const request = await exportRequest(s);
    expect(request.code).toBe(0);
    const tooLate = await sign(s, request.path, 'oui', late);
    expect(tooLate.code).toBe(1);
    expect(tooLate.io.err).toContain('expired');
    const signed = await sign(s, request.path, 'oui');
    expect(signed.code).toBe(0);
    const answered = await answer(s.server.home, s.server.root, signed.path, late);
    expect(answered.code).toBe(1);
    expect(answered.io.err).toContain('expired');
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => late })).toBe(1);
  });

  test('a replayed id: one answer file imported twice, and an old answer renamed onto a new request', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'oui');
    expect((await answer(s.server.home, s.server.root, signed.path)).code).toBe(0);
    const twice = await answer(s.server.home, s.server.root, signed.path);
    expect(twice.code).toBe(1);
    expect(twice.io.err).toContain('already answered');
    // A second request on the same machine; the first answer, renamed to its id, is refused.
    const asked = testIo(s.server.root, LEAD);
    expect(await runImport(['--request'], asked, { home: s.server.home, now: () => LATER(1000) })).toBe(0);
    const second = /owner-seat request (oa_[0-9a-f]{24}) recorded/.exec(asked.out)![1]!;
    expect(second).not.toBe(s.id);
    const file = JSON.parse(readFileSync(signed.path, 'utf8')) as OwnerAnswerFile;
    const renamed = join(s.files, 'renamed.json');
    writeFileSync(renamed, JSON.stringify({ ...file, request_id: second }));
    const replay = await answer(s.server.home, s.server.root, renamed, LATER(2000));
    expect(replay.code).toBe(1);
    expect(replay.io.err).toContain('not bound to request');
    const retargeted = join(s.files, 'retargeted.json');
    writeFileSync(retargeted, JSON.stringify({ ...file, request_id: second, answer: { ...file.answer, owner_seat_answer: { ...file.answer.owner_seat_answer, request_id: second } } }));
    expect((await answer(s.server.home, s.server.root, retargeted, LATER(2000))).code).toBe(1);
  });

  test('a tampered answer is refused: its choice, its hash, its signature, its signer', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'non');
    const file = JSON.parse(readFileSync(signed.path, 'utf8')) as OwnerAnswerFile;
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const changes: Array<(f: OwnerAnswerFile) => void> = [
      (f) => { f.answer.owner_seat_answer.choice = 'once'; },
      (f) => { f.answer.owner_seat_answer.params_sha256 = 'b'.repeat(64); },
      (f) => { f.answer.signature = `${f.answer.signature.slice(0, -2)}00`; },
      (f) => { f.answer.signature = cryptoSign('sha256', Buffer.from('anything'), { key: other.privateKey, dsaEncoding: 'der' }).toString('hex'); },
      (f) => { f.answer.signer = 'phone'; },
      (f) => { f.answer.owner_seat_answer.team = 'other'; },
    ];
    for (const [index, change] of changes.entries()) {
      const copy = JSON.parse(JSON.stringify(file)) as OwnerAnswerFile;
      change(copy);
      const path = join(s.files, `tampered-${index}.json`);
      writeFileSync(path, JSON.stringify(copy));
      const result = await answer(s.server.home, s.server.root, path);
      expect(result.code, `change ${index}`).toBe(1);
    }
    expect(existsSync(join(actionRequestsFolder(s.server.home), `${s.id}.seat-answer.json`))).toBe(false);
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => NOW })).toBe(1);
  });

  test('a tampered request: refused on the signer machine, and an answer to a rewritten one is refused where it runs', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const file = JSON.parse(readFileSync(request.path, 'utf8')) as OwnerRequestFile;
    // Changed words without a new hash: the signer machine refuses it.
    const broken = JSON.parse(JSON.stringify(file)) as OwnerRequestFile;
    broken.request.params.words = { 'team-import': ['--other'] };
    const brokenPath = join(s.files, 'broken.json');
    writeFileSync(brokenPath, JSON.stringify(broken));
    expect((await sign(s, brokenPath, 'oui')).code).toBe(1);
    // Rewritten with a recomputed hash (an agent widening the ask): the owner may sign the card it
    // shows, but the machine that holds the real request refuses the answer.
    const rewritten = JSON.parse(JSON.stringify(file)) as OwnerRequestFile;
    rewritten.request.params.root = '/elsewhere';
    rewritten.request.params_sha256 = ownerActionHash(rewritten.request.params);
    const rewrittenPath = join(s.files, 'rewritten.json');
    writeFileSync(rewrittenPath, JSON.stringify(rewritten));
    const signed = await sign(s, rewrittenPath, 'oui');
    expect(signed.code, signed.io.err).toBe(0);
    const answered = await answer(s.server.home, s.server.root, signed.path);
    expect(answered.code).toBe(1);
    expect(answered.io.err).toContain('not bound to request');
    // A request file whose machine was changed alone: refused before any card.
    const moved = JSON.parse(JSON.stringify(file)) as OwnerRequestFile;
    moved.machine = { id: 'm_000000000000000000000000', name: 'server' };
    const movedPath = join(s.files, 'moved.json');
    writeFileSync(movedPath, JSON.stringify(moved));
    expect((await sign(s, movedPath, 'oui')).code).toBe(1);
  });

  test('the pinned machine cannot sign, and the signer machine cannot export or take an answer', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const onServer = testIo(s.server.root, TERMINAL);
    expect(await runApprovals(['sign', '--from', request.path, '--out', join(s.files, 'x.json'), '--answer', 'oui'], onServer, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(onServer.err).toContain('holds no owner signer');
    const onMac = testIo(s.mac.home);
    expect(await runApprovals(['export', s.id, '--out', join(s.files, 'y.json')], onMac, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
    const signed = await sign(s, request.path, 'oui');
    expect((await answer(s.mac.home, s.mac.home, signed.path)).code).toBe(1);
  });

  test('invocation: each carrying verb takes only its own options', async () => {
    const home = tempBase('usage');
    for (const argv of [['export', 'oa_0123456789abcdef01234567'], ['sign', '--from', 'a.json'], ['answer'], ['answer', '--from', 'a', '--out', 'b'], ['list', '--out', 'x'], ['export', 'oa_0123456789abcdef01234567', '--out', 'x', '--request']]) {
      const io = testIo(home);
      expect(await runApprovals(argv, io, { home, now: () => NOW }), argv.join(' ')).toBe(2);
    }
  });

  test('an answer file is never written over an existing file', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const taken = join(s.files, 'taken.json');
    writeFileSync(taken, 'keep\n');
    const io = testIo(s.mac.home);
    expect(await runApprovals(['sign', '--from', request.path, '--out', taken, '--answer', 'oui'], io, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
    expect(readFileSync(taken, 'utf8')).toBe('keep\n');
  });
});

describe('the signed window (review finding 5)', () => {
  test('a changed expiry or creation is refused when the answer is recorded and when it runs', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'oui');
    expect(signed.code, signed.io.err).toBe(0);
    const path = join(actionRequestsFolder(s.server.home), `${s.id}.json`);
    const original = readFileSync(path, 'utf8');
    const record = JSON.parse(original) as OwnerActionRecord;
    expect(record.params.window).toEqual({ created: record.created, expires_at: record.expires_at });
    // The record's own expiry moved to never, the signed window left as it was.
    writeFileSync(path, JSON.stringify({ ...record, expires_at: null }));
    const moved = await answer(s.server.home, s.server.root, signed.path);
    expect(moved.code).toBe(1);
    expect(moved.io.err).toContain('not the one it was signed with');
    // Both moved, the hash recomputed: never-expiring is refused, and so is a longer window.
    const widened: OwnerActionRecord = { ...record, expires_at: null, params: { ...record.params, window: { created: record.created, expires_at: null } } };
    widened.params_sha256 = ownerActionHash(widened.params);
    writeFileSync(path, JSON.stringify(widened));
    expect((await answer(s.server.home, s.server.root, signed.path)).code).toBe(1);
    const later = LATER(60 * 60_000).toISOString();
    const stretched: OwnerActionRecord = { ...record, expires_at: later, params: { ...record.params, window: { created: record.created, expires_at: later } } };
    stretched.params_sha256 = ownerActionHash(stretched.params);
    writeFileSync(path, JSON.stringify(stretched));
    const longer = await answer(s.server.home, s.server.root, signed.path);
    expect(longer.code).toBe(1);
    expect(longer.io.err).toContain('longer than');
    // The true record takes the answer; a window moved after that is refused when it runs.
    writeFileSync(path, original);
    expect((await answer(s.server.home, s.server.root, signed.path)).code).toBe(0);
    writeFileSync(path, JSON.stringify({ ...record, expires_at: later }));
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => LATER(20 * 60_000) })).toBe(1);
    expect(run.err + run.out).toContain('not the one it was signed with');
    writeFileSync(path, original);
    const late = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], late, { home: s.server.home, now: () => LATER(20 * 60_000) })).toBe(1);
    expect(late.err + late.out).toContain('expired');
    expect(registered(s.server.home, s.server.root)).toBe(false);
  });

  test('a carried request longer than the default window is refused before its card is shown', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const file = JSON.parse(readFileSync(request.path, 'utf8')) as OwnerRequestFile;
    const later = LATER(60 * 60_000).toISOString();
    file.request.expires_at = later;
    file.request.params.window = { created: file.request.created, expires_at: later };
    file.request.params_sha256 = ownerActionHash(file.request.params);
    const longer = join(s.files, 'longer.json');
    writeFileSync(longer, JSON.stringify(file));
    const before = s.mac.store.reasons.length;
    const refused = await sign(s, longer, 'oui');
    expect(refused.code).toBe(1);
    expect(refused.io.err).toContain('longer than');
    expect(s.mac.store.reasons.length).toBe(before);
    expect(existsSync(join(actionRequestsFolder(s.mac.home), `${s.id}.json`))).toBe(false);
  });

  test('a record from before the window: refused on a pinned machine, read as before on a machine with a local owner', async () => {
    const s = await scene();
    const path = join(actionRequestsFolder(s.server.home), `${s.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as OwnerActionRecord;
    const params: OwnerActionParams = { ...record.params };
    delete params.window;
    writeFileSync(path, JSON.stringify({ ...record, params, params_sha256: ownerActionHash(params) }));
    const io = testIo(s.server.root, TERMINAL);
    expect(await runApprovals(['export', s.id, '--out', join(s.files, 'old.json')], io, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(io.err).toContain('carries no signed answer window');

    // On the signer machine, a request recorded before the window existed answers and runs as before.
    const root = join(s.mac.home, 'repo');
    const made = createOwnerActionRequest(s.mac.home, { actions: ['team-up'], root, team: 'floor', head: null, args: { 'team-up': [] }, requestedBy: 'probe' }, NOW);
    if (!made.ok) throw new Error(made.why);
    const localPath = join(actionRequestsFolder(s.mac.home), `${made.record.request_id}.json`);
    const localParams: OwnerActionParams = { ...made.record.params };
    delete localParams.window;
    writeFileSync(localPath, JSON.stringify({ ...made.record, params: localParams, params_sha256: ownerActionHash(localParams) }));
    expect(approveOwnerAction(s.mac.home, made.record.request_id, 'oui', s.mac.store, NOW)).toMatchObject({ ok: true, choice: 'once' });
    expect(admitOwnerAction(s.mac.home, made.record.request_id, { action: 'team-up', root, team: 'floor', head: null, words: [], claim: true }, s.mac.store, LATER(60_000))).toMatchObject({ ok: true, via: 'owner-seat' });
  });
});

describe('the words a card shows are the words it admits (review finding 8)', () => {
  test('a carried request whose argument hash is not the hash of its words, or that carries no words, is refused before any card', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const file = JSON.parse(readFileSync(request.path, 'utf8')) as OwnerRequestFile;
    const before = s.mac.store.reasons.length;
    // Shows one argument list, admits another (the empty one the server will run), hash recomputed.
    const shown = JSON.parse(JSON.stringify(file)) as OwnerRequestFile;
    shown.request.params.words = { 'team-import': ['--file', 'shown.yaml'] };
    shown.request.params_sha256 = ownerActionHash(shown.request.params);
    const shownPath = join(s.files, 'shown.json');
    writeFileSync(shownPath, JSON.stringify(shown));
    const mismatch = await sign(s, shownPath, 'oui');
    expect(mismatch.code).toBe(1);
    expect(mismatch.io.err).toContain('are not the words it shows');
    // No words at all, hash recomputed.
    const bare = JSON.parse(JSON.stringify(file)) as OwnerRequestFile;
    delete bare.request.params.words;
    bare.request.params_sha256 = ownerActionHash(bare.request.params);
    const barePath = join(s.files, 'bare.json');
    writeFileSync(barePath, JSON.stringify(bare));
    const wordless = await sign(s, barePath, 'oui');
    expect(wordless.code).toBe(1);
    expect(wordless.io.err).toContain('carries no argument words');
    expect(s.mac.store.reasons.length).toBe(before);
    expect(existsSync(join(actionRequestsFolder(s.mac.home), `${s.id}.json`))).toBe(false);
    // The same forgery written into the pinned machine's own record is refused where it runs.
    writeFileSync(join(actionRequestsFolder(s.server.home), `${s.id}.json`), JSON.stringify(shown.request));
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => NOW })).toBe(1);
    expect(run.err + run.out).toContain('are not the words it shows');
  });

  test('the same gap on a machine with a local owner: a record showing "set off" while admitting "set local-fast" is never signed or run', () => {
    const mac = signerMachine();
    const root = join(mac.home, 'repo');
    const made = createOwnerActionRequest(mac.home, { actions: ['development-mode'], root, team: 'floor', head: null, args: { 'development-mode': ['set', 'off'] }, requestedBy: 'probe' }, NOW);
    if (!made.ok) throw new Error(made.why);
    const path = join(actionRequestsFolder(mac.home), `${made.record.request_id}.json`);
    const forged: OwnerActionRecord = JSON.parse(JSON.stringify(made.record));
    forged.params.args['development-mode'] = actionArgsHash('development-mode', ['set', 'local-fast']);
    forged.params_sha256 = ownerActionHash(forged.params);
    writeFileSync(path, JSON.stringify(forged));
    const before = mac.store.reasons.length;
    const answered = approveOwnerAction(mac.home, made.record.request_id, 'oui', mac.store, NOW);
    expect(answered.ok).toBe(false);
    if (!answered.ok) expect(answered.why).toContain('are not the words it shows');
    expect(mac.store.reasons.length).toBe(before);
    expect(admitOwnerAction(mac.home, made.record.request_id, { action: 'development-mode', root, team: 'floor', head: null, words: ['set', 'local-fast'], claim: true }, mac.store, NOW).ok).toBe(false);
  });
});

describe('owner elevations a pinned machine refuses (review findings 3 and 4)', () => {
  test('the general door refuses any line that carries a grant, and no grant verifies there', async () => {
    const s = await scene();
    const io = testIo(s.server.root);
    io.env = { HOME: s.server.home };
    const lines: Array<[string, string[]]> = [
      ['policy', ['set', 'x', 'y', '--general', 'g.json', '--key', 'k.key']],
      ['status', ['--general', 'g.json', '--key', 'k.key']],
      ['up', ['--general', 'g.json']],
      ['config', ['set', 'a', 'b', '--general', 'g.json']],
    ];
    for (const [name, rest] of lines) {
      const door = generalDoor(name, [...rest], io);
      expect(door.kind, name).toBe('refused');
      if (door.kind === 'refused') expect(door.why).toBe(PINNED_GENERAL_REFUSAL);
    }
    const read = readGeneralGrant(s.server.home, join(s.files, 'none.json'));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.why).toContain('does not stand in for the owner');
    // A machine with a local owner keeps its door: the same line is judged on the grant itself.
    const local = testIo(s.mac.home);
    local.env = { HOME: s.mac.home };
    const door = generalDoor('status', ['--general', join(s.files, 'none.json'), '--key', 'k.key'], local);
    expect(door.kind === 'refused' ? door.why : '').not.toBe(PINNED_GENERAL_REFUSAL);
  });

  test('the owner-authorization fingerprint admits nothing on a pinned machine', async () => {
    const home = join(tempBase('token'), 'home');
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    keyOf(home);
    const show = testIo(home);
    expect(await runDevelopmentMode(['set', 'local-fast', '--show'], show, { home })).toBe(0);
    const fingerprint = /Owner-authorization fingerprint: ([0-9a-f]+)/.exec(show.out)?.[1];
    if (fingerprint === undefined) throw new Error(show.out);
    expect(ownerAuthorized({ TEAM_OWNER_APPROVAL: fingerprint }, fingerprint, home)).toBe(true);
    writeFileSync(ownerSeatPinFile(home), 'pinned');
    expect(ownerAuthorized({ TEAM_OWNER_APPROVAL: fingerprint }, fingerprint, home)).toBe(false);
    const token = testIo(home);
    token.env = { TEAM_OWNER_APPROVAL: fingerprint };
    expect(await runDevelopmentMode(['set', 'local-fast'], token, { home, now: NOW })).toBe(1);
    expect(token.err).toContain('only the owner switches the machine development mode');
    expect(readDevelopmentMode(home).kind).not.toBe('set');
  });
});

describe('the ledger spends a carried approval (where the account split will move it)', () => {
  test('the run is spent in the ledger the resolver names, not beside the request', async () => {
    const s = await scene();
    const request = await exportRequest(s);
    const signed = await sign(s, request.path, 'oui');
    expect((await answer(s.server.home, s.server.root, signed.path)).code).toBe(0);
    const run = testIo(s.server.root, TERMINAL);
    expect(await runImport(['--approval', s.id], run, { home: s.server.home, now: () => LATER(60_000) }), run.err).toBe(0);
    expect(existsSync(join(s.server.home, '.config', 'team', 'owner-ledger', `${s.id}.team-import`))).toBe(true);
    expect(readdirSync(actionRequestsFolder(s.server.home)).some((name) => name.startsWith(`${s.id}.used-`))).toBe(false);
  });
});
