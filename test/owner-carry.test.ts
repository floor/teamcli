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
import { admitOwnerAction, approveOwnerAction, ownerActionHash, readOwnerActionRecord, type OwnerActionRecord } from '../src/client/owner-action.ts';
import type { OwnerAnswerFile, OwnerRequestFile } from '../src/client/owner-carry.ts';
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
