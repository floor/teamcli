// The owner-only commands that had no owner-seat door on a machine whose owner seat is pinned from
// another machine — an entity's own record (`team config set <entity>.root` and the other entity
// keys) and the machine daemon (`team daemon install|restart|uninstall|fault-watch`) — now take
// `--request` and `--approval <id>`, carried as files like any other request. And several requests
// travel in one file, signed with one card and one user-presence prompt, each keeping its own
// answer, window and single use. Every scene is synthetic: fake credential stores, temporary
// homes and repositories, a fake service manager; no terminal host is started.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_TERMINAL_REASON, type Caller } from '../src/caller.ts';
import { ownerActionHash, readOwnerActionRecord, type OwnerActionRecord } from '../src/client/owner-action.ts';
import { OWNER_ANSWER_BATCH_FORMAT, OWNER_REQUEST_BATCH_FORMAT, type OwnerAnswerBatchFile, type OwnerRequestBatchFile, type OwnerRequestFile } from '../src/client/owner-carry.ts';
import { exportOwnerSeat, pinOwnerSeat, type SignedOwnerSeatExport } from '../src/client/owner-pin.ts';
import { registerOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runConfig } from '../src/commands/config.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { runSetup } from '../src/commands/setup.ts';
import type { ServiceManager } from '../src/daemon/service.ts';
import { entitiesPath } from '../src/entities.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { keyOf } from '../src/store/keys.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-14T10:00:00Z');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const raw = (key: KeyObject) => {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
};

/** A credential store whose every user-presence prompt is counted. With `many`, it signs several
 *  messages under one prompt, as the helper's `sign-many` does. */
function fakeStore(many: boolean): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const prompts: string[] = [];
  const signWith = (label: string, message: Buffer) => cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex');
  return {
    name: 'fake-credential-store',
    prompts,
    available: () => true,
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: raw(pair.publicKey) };
    },
    publicKey: (label) => (keys.has(label) ? { ok: true, publicKey: raw(keys.get(label)!.publicKey) } : { ok: false, why: 'no key' }),
    sign: (label, message, reason) => {
      prompts.push(reason);
      return keys.has(label) ? { ok: true, signature: signWith(label, message) } : { ok: false, why: 'no key' };
    },
    ...(many ? {
      signMany: (label: string, messages: readonly Buffer[], reason: string) => {
        prompts.push(reason);
        return keys.has(label) ? { ok: true as const, signatures: messages.map((message) => signWith(label, message)) } : { ok: false as const, why: 'no key' };
      },
    } : {}),
    pinSet: () => ({ ok: true }),
    pinGet: () => ({ ok: false, why: 'no pin' }),
  };
}

function tempBase(label: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `owner-gaps-${label}-`)));
  made.push(base);
  return base;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Gaps', GIT_AUTHOR_EMAIL: 'gaps@example.invalid', GIT_COMMITTER_NAME: 'Gaps', GIT_COMMITTER_EMAIL: 'gaps@example.invalid' },
  });
}

/** The machine that holds the owner's signers: one owner seat, one signer `mac`, accepted by policy. */
function signerMachine(many = true) {
  const home = join(tempBase('mac'), 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  keyOf(home);
  const store = fakeStore(many);
  const seat = registerOwnerSeat(home, { team: 'floor', signer: 'mac' }, store, NOW);
  if (!seat.ok) throw new Error(seat.why);
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
  return { home, store };
}

/** A machine with no owner signer, its owner seat pinned from the signer machine. */
function pinnedMachine(signed: SignedOwnerSeatExport, name: string) {
  const home = tempBase(name);
  const root = join(home, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const pinned = pinOwnerSeat(home, signed, NOW, { name });
  if (!pinned.ok) throw new Error(pinned.why);
  return { home, root, machine: pinned.machine };
}

const TERMINAL: Caller = { kind: 'unplaced', reason: PINNED_TERMINAL_REASON, pinned: true };
const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };

type Scene = { mac: ReturnType<typeof signerMachine>; server: ReturnType<typeof pinnedMachine>; files: string };

function scene(many = true, name = 'server'): Scene {
  const mac = signerMachine(many);
  const exported = exportOwnerSeat(mac.home, mac.store, NOW);
  if (!exported.ok) throw new Error(exported.why);
  const server = pinnedMachine(exported.signed, name);
  // The export's own prompt is the pin's, not an answer's: each scene counts answers from here.
  mac.store.prompts.length = 0;
  return { mac, server, files: tempBase('files') };
}

function idOf(out: string): string {
  const id = /owner-seat request (oa_[0-9a-f]{24}) recorded/.exec(out)?.[1];
  if (id === undefined) throw new Error(`no request id in ${out}`);
  return id;
}

/** The fake service manager a daemon scene changes: it records each call and touches nothing. */
function fakeService(): ServiceManager & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'system-service-manager',
    calls,
    unitPath: (home) => join(home, 'unit'),
    plan: (home, program) => ({ unitPath: join(home, 'unit'), program: [program.execPath, program.entry, 'daemon', 'run'] }),
    job: () => null,
    unit: () => null,
    install: (home) => { calls.push('install'); return { ok: true, unitPath: join(home, 'unit') }; },
    uninstall: (home) => { calls.push('uninstall'); return { ok: true, unitPath: join(home, 'unit'), removed: true }; },
    restart: () => { calls.push('restart'); return { ok: false, reason: 'refused', why: 'not in this scene', detail: null }; },
  } as ServiceManager & { calls: string[] };
}

const configOn = (s: Scene, argv: string[], caller: Caller = TERMINAL) => {
  const io = testIo(s.server.root, caller);
  return runConfig(argv, io, { home: s.server.home, now: () => NOW }).then((code) => ({ code, io }));
};

const daemonOn = (s: Scene, argv: string[], service: ServiceManager, caller: Caller = TERMINAL) => {
  const io = testIo(s.server.root, caller);
  return runDaemon(argv, io, { home: s.server.home, accountHome: s.server.home, service, now: () => NOW }).then((code) => ({ code, io }));
};

async function carry(s: Scene, ids: string[], word: string | null = 'oui'): Promise<{ request: string; answer: string; signIo: ReturnType<typeof testIo> }> {
  const request = join(s.files, `request-${Math.random().toString(16).slice(2)}.json`);
  const exported = testIo(s.server.root, TERMINAL);
  expect(await runApprovals(['export', ...ids, '--out', request], exported, { home: s.server.home, now: () => NOW }), exported.err).toBe(0);
  const answer = join(s.files, `answer-${Math.random().toString(16).slice(2)}.json`);
  const signIo = testIo(s.mac.home);
  expect(await runApprovals(['sign', '--from', request, '--out', answer, ...(word === null ? [] : ['--answer', word])], signIo, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store }), signIo.err).toBe(0);
  return { request, answer, signIo };
}

async function answerOn(s: Scene, path: string): Promise<{ code: number; io: ReturnType<typeof testIo> }> {
  const io = testIo(s.server.root, TERMINAL);
  const code = await runApprovals(['answer', '--from', path], io, { home: s.server.home, now: () => NOW });
  return { code, io };
}

const entitiesText = (home: string): string => (existsSync(entitiesPath(home)) ? readFileSync(entitiesPath(home), 'utf8') : '');

describe("an entity's record on a machine whose owner seat is pinned", () => {
  test('refused without an answer, runs once with a carried answer, refuses the replay', async () => {
    const s = scene();
    // No terminal is the owner here, and a plain set is refused.
    const bare = await configOn(s, ['set', 'acme.root', '~/Code/acme']);
    expect(bare.code).toBe(1);
    expect(entitiesText(s.server.home)).toBe('');

    // A seat records the request; nothing is written.
    const asked = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--request', '--reason', 'first machine'], SEAT);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    expect(asked.io.out).toContain(`then run: team config set acme.root ~/Code/acme --approval ${id}`);
    expect(entitiesText(s.server.home)).toBe('');
    const record = readOwnerActionRecord(s.server.home, id) as OwnerActionRecord;
    expect(record.params.actions).toEqual(['team-entity-config']);
    expect(record.params.machine).toEqual({ id: s.server.machine.id, name: 'server' });
    expect(record.params.team).toBe('acme');

    // Before an answer, --approval is refused and writes nothing.
    const early = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', id], SEAT);
    expect(early.code).toBe(1);
    expect(early.io.err).toContain('has no owner-seat answer yet');

    const carried = await carry(s, [id]);
    // The owner's card names the change and the machine, never a folder.
    expect(s.mac.store.prompts).toHaveLength(1);
    expect(s.mac.store.prompts[0]).toContain("change where an entity's projects sit");
    expect(s.mac.store.prompts[0]).toContain('Entity acme on server');
    expect(s.mac.store.prompts[0]).not.toContain('Code');
    expect((await answerOn(s, carried.answer)).code).toBe(0);

    // An answer for other words admits nothing, and spends nothing.
    const other = await configOn(s, ['set', 'acme.root', '~/Code/other', '--approval', id], SEAT);
    expect(other.code).toBe(1);
    expect(other.io.err).toContain('other team-entity-config arguments');

    const run = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', id], SEAT);
    expect(run.code, run.io.err).toBe(0);
    expect(entitiesText(s.server.home)).toContain('root: ~/Code/acme');

    const replay = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', id], SEAT);
    expect(replay.code).toBe(1);
    expect(replay.io.err).toContain('single-use');
  });

  test('a write that would be refused keeps the answer for a corrected run', async () => {
    const s = scene();
    // names.unique needs an entry the file declares: none does yet.
    const asked = await configOn(s, ['set', 'acme.names.unique', 'team', '--request'], SEAT);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    const carried = await carry(s, [id]);
    expect((await answerOn(s, carried.answer)).code).toBe(0);
    const refused = await configOn(s, ['set', 'acme.names.unique', 'team', '--approval', id], SEAT);
    expect(refused.code).toBe(1);
    expect(refused.io.err).toContain('no entry for entity "acme"');
    // The entry appears; the same answer now runs once.
    writeFileSync(entitiesPath(s.server.home), 'acme:\n  names:\n    unique: entity\n');
    const run = await configOn(s, ['set', 'acme.names.unique', 'team', '--approval', id], SEAT);
    expect(run.code, run.io.err).toBe(0);
    expect(entitiesText(s.server.home)).toContain('unique: team');
  });

  test('the invocation refuses a get, both options at once, and a grant beside an answer', async () => {
    const s = scene();
    expect((await configOn(s, ['get', 'acme.root', '--request'], SEAT)).code).toBe(2);
    expect((await configOn(s, ['set', 'acme.root', '~/x', '--request', '--approval', 'oa_000000000000000000000000'], SEAT)).code).toBe(2);
    expect((await configOn(s, ['set', 'acme.root', '~/x', '--approval', 'oa_000000000000000000000000', '--general', 'g.json', '--key', 'k'], SEAT)).code).toBe(2);
    expect((await configOn(s, ['set', 'acme.root', '~/x', '--reason', 'why'], SEAT)).code).toBe(2);
  });
});

describe('the machine daemon on a machine whose owner seat is pinned', () => {
  test('refused without an answer, runs once with a carried answer, refuses the replay', async () => {
    const s = scene();
    const service = fakeService();
    const bare = await daemonOn(s, ['uninstall'], service);
    expect(bare.code).toBe(1);
    expect(service.calls).toEqual([]);

    const asked = await daemonOn(s, ['uninstall', '--request'], service, SEAT);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    expect(asked.io.out).toContain(`then run: team daemon uninstall --approval ${id}`);
    expect(service.calls).toEqual([]);

    const carried = await carry(s, [id]);
    expect(s.mac.store.prompts[0]).toContain('remove the machine daemon');
    expect(s.mac.store.prompts[0]).toContain('Machine server');
    expect((await answerOn(s, carried.answer)).code).toBe(0);

    // The answer names uninstall: an install with it is refused.
    const install = await daemonOn(s, ['install', '--approval', id], service, SEAT);
    expect(install.code).toBe(1);
    expect(service.calls).toEqual([]);

    const run = await daemonOn(s, ['uninstall', '--approval', id], service, SEAT);
    expect(run.code, run.io.err).toBe(0);
    expect(service.calls).toEqual(['uninstall']);

    const replay = await daemonOn(s, ['uninstall', '--approval', id], service, SEAT);
    expect(replay.code).toBe(1);
    expect(replay.io.err).toContain('single-use');
    expect(service.calls).toEqual(['uninstall']);
  });

  test('a dry run checks the answer and spends nothing', async () => {
    const s = scene();
    const service = fakeService();
    const asked = await daemonOn(s, ['restart', '--dry-run', '--request'], service, SEAT);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    const carried = await carry(s, [id]);
    expect((await answerOn(s, carried.answer)).code).toBe(0);
    // --dry-run is not part of what the answer binds, and twice spends nothing.
    await daemonOn(s, ['restart', '--dry-run', '--approval', id], service, SEAT);
    await daemonOn(s, ['restart', '--dry-run', '--approval', id], service, SEAT);
    expect(service.calls).toEqual([]);
    expect(existsSync(join(actionRequestsFolder(s.server.home), `${id}.used-team-daemon`))).toBe(false);
  });

  test('the request options belong to the owner-gated verbs only', async () => {
    const s = scene();
    const service = fakeService();
    expect((await daemonOn(s, ['status', '--request'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['uninstall', '--request', '--approval', 'oa_000000000000000000000000'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['uninstall', '--reason', 'why'], service, SEAT)).code).toBe(2);
  });
});

describe('several requests carried in one file', () => {
  async function three(s: Scene): Promise<string[]> {
    const service = fakeService();
    const ids: string[] = [];
    for (const argv of [['set', 'acme.root', '~/Code/acme', '--request'], ['set', 'acme.worktrees', '~/Code/acme-trees', '--request']]) {
      const asked = await configOn(s, argv, SEAT);
      expect(asked.code, asked.io.err).toBe(0);
      ids.push(idOf(asked.io.out));
    }
    const daemon = await daemonOn(s, ['uninstall', '--request'], service, SEAT);
    expect(daemon.code, daemon.io.err).toBe(0);
    ids.push(idOf(daemon.io.out));
    return ids;
  }

  test('three requests are signed under one prompt and run one by one, each once', async () => {
    const s = scene(true);
    const ids = await three(s);
    const carried = await carry(s, ids);
    const batch = JSON.parse(readFileSync(carried.request, 'utf8')) as OwnerRequestBatchFile;
    expect(batch.format).toBe(OWNER_REQUEST_BATCH_FORMAT);
    expect(batch.requests.map((one) => one.request_id)).toEqual(ids);
    // One prompt, and it lists all three.
    expect(s.mac.store.prompts).toHaveLength(1);
    expect(s.mac.store.prompts[0]).toContain('3 requests from machine server');
    expect(s.mac.store.prompts[0]).toContain("change where an entity's projects sit");
    expect(s.mac.store.prompts[0]).toContain("change where an entity's worktrees sit");
    expect(s.mac.store.prompts[0]).toContain('remove the machine daemon');
    const answers = JSON.parse(readFileSync(carried.answer, 'utf8')) as OwnerAnswerBatchFile;
    expect(answers.format).toBe(OWNER_ANSWER_BATCH_FORMAT);
    // Each answer is its own signature over its own request.
    expect(new Set(answers.answers.map((one) => one.answer.signature)).size).toBe(3);
    expect(answers.answers.map((one) => one.answer.owner_seat_answer.request_id)).toEqual(ids);

    const answered = await answerOn(s, carried.answer);
    expect(answered.code, answered.io.err).toBe(0);
    for (const id of ids) expect(answered.io.out).toContain(`run its command again with --approval ${id}`);

    const service = fakeService();
    expect((await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', ids[0]!], SEAT)).code).toBe(0);
    expect((await configOn(s, ['set', 'acme.worktrees', '~/Code/acme-trees', '--approval', ids[1]!], SEAT)).code).toBe(0);
    expect((await daemonOn(s, ['uninstall', '--approval', ids[2]!], service, SEAT)).code).toBe(0);
    expect(entitiesText(s.server.home)).toContain('root: ~/Code/acme');
    expect(entitiesText(s.server.home)).toContain('worktrees: ~/Code/acme-trees');
    expect(service.calls).toEqual(['uninstall']);
    // Every member is spent once: each replay is refused on its own.
    expect((await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', ids[0]!], SEAT)).code).toBe(1);
    expect((await daemonOn(s, ['uninstall', '--approval', ids[2]!], service, SEAT)).code).toBe(1);
    // The answer file cannot be recorded twice.
    expect((await answerOn(s, carried.answer)).code).toBe(1);
  });

  test('a store that signs one message at a time prompts once per request and says so', async () => {
    const s = scene(false);
    const ids = await three(s);
    const carried = await carry(s, ids);
    expect(s.mac.store.prompts).toHaveLength(3);
    expect(carried.signIo.out).toContain('each was signed with its own Touch ID');
    expect((await answerOn(s, carried.answer)).code).toBe(0);
  });

  test('a tampered request refuses the whole batch before any prompt, and nothing is recorded', async () => {
    const s = scene();
    const ids = await three(s);
    const request = join(s.files, 'request.json');
    const exported = testIo(s.server.root, TERMINAL);
    expect(await runApprovals(['export', ...ids, '--out', request], exported, { home: s.server.home, now: () => NOW })).toBe(0);
    const batch = JSON.parse(readFileSync(request, 'utf8')) as OwnerRequestBatchFile;
    batch.requests[1]!.params.words!['team-entity-config'] = ['set', 'acme.worktrees', '/'];
    const tampered = join(s.files, 'tampered.json');
    writeFileSync(tampered, JSON.stringify(batch));
    const signIo = testIo(s.mac.home);
    expect(await runApprovals(['sign', '--from', tampered, '--out', join(s.files, 'a.json'), '--answer', 'oui'], signIo, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
    expect(signIo.err).toContain('nothing in the batch is signed');
    expect(s.mac.store.prompts).toHaveLength(0);
    for (const id of ids) expect(typeof readOwnerActionRecord(s.mac.home, id)).toBe('string');
  });

  test('a tampered answer refuses the whole batch, and no member can run', async () => {
    const s = scene();
    const ids = await three(s);
    const carried = await carry(s, ids);
    const answers = JSON.parse(readFileSync(carried.answer, 'utf8')) as OwnerAnswerBatchFile;
    const sig = answers.answers[2]!.answer.signature;
    answers.answers[2]!.answer.signature = `${sig.slice(0, -2)}${sig.endsWith('00') ? '01' : '00'}`;
    const tampered = join(s.files, 'tampered-answer.json');
    writeFileSync(tampered, JSON.stringify(answers));
    const refused = await answerOn(s, tampered);
    expect(refused.code).toBe(1);
    expect(refused.io.err).toContain('no answer in the batch was recorded');
    for (const id of ids) expect(existsSync(join(actionRequestsFolder(s.server.home), `${id}.seat-answer.json`))).toBe(false);
    const run = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--approval', ids[0]!], SEAT);
    expect(run.code).toBe(1);
    expect(run.io.err).toContain('has no owner-seat answer yet');
    // The untouched file still records them all.
    expect((await answerOn(s, carried.answer)).code).toBe(0);
  });

  test('a batch mixing machines or accounts is refused', async () => {
    const s = scene();
    const ids = await three(s);
    const exported = exportOwnerSeat(s.mac.home, s.mac.store, NOW);
    if (!exported.ok) throw new Error(exported.why);
    const other = pinnedMachine(exported.signed, 'second');
    s.mac.store.prompts.length = 0;
    const asked = testIo(other.root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/acme', '--request'], asked, { home: other.home, now: () => NOW })).toBe(0);
    const otherId = idOf(asked.out);

    const request = join(s.files, 'request.json');
    expect(await runApprovals(['export', ...ids, '--out', request], testIo(s.server.root, TERMINAL), { home: s.server.home, now: () => NOW })).toBe(0);
    const batch = JSON.parse(readFileSync(request, 'utf8')) as OwnerRequestBatchFile;
    const single = join(s.files, 'other.json');
    expect(await runApprovals(['export', otherId, '--out', single], testIo(other.root, TERMINAL), { home: other.home, now: () => NOW })).toBe(0);
    const foreign = (JSON.parse(readFileSync(single, 'utf8')) as OwnerRequestFile).request;

    const sign = async (file: OwnerRequestBatchFile): Promise<ReturnType<typeof testIo>> => {
      const path = join(s.files, `mixed-${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(file));
      const io = testIo(s.mac.home);
      expect(await runApprovals(['sign', '--from', path, '--out', `${path}.answer`, '--answer', 'oui'], io, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
      return io;
    };
    const machines = await sign({ ...batch, requests: [batch.requests[0]!, foreign] });
    expect(machines.err).toMatch(/does not name the machine its file names|names another machine/);

    // A member whose own hash is whole but which names another account.
    const params = { ...batch.requests[1]!.params, account: 'other' };
    const accounted: OwnerActionRecord = { ...batch.requests[1]!, params, params_sha256: ownerActionHash(params) };
    const accounts = await sign({ ...batch, requests: [batch.requests[0]!, accounted] });
    expect(accounts.err).toContain('names another account');
    expect(s.mac.store.prompts).toHaveLength(0);

    // A request named twice is refused at export.
    const twice = testIo(s.server.root, TERMINAL);
    expect(await runApprovals(['export', ids[0]!, ids[0]!, '--out', join(s.files, 'twice.json')], twice, { home: s.server.home, now: () => NOW })).toBe(1);
  });
});

describe('a machine with a local owner keeps its behaviour', () => {
  test('one id still exports the single-request format', async () => {
    const s = scene();
    const asked = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--request'], SEAT);
    const id = idOf(asked.io.out);
    const carried = await carry(s, [id]);
    expect((JSON.parse(readFileSync(carried.request, 'utf8')) as { format: string }).format).toBe('team-owner-request-file-v1');
    expect((JSON.parse(readFileSync(carried.answer, 'utf8')) as { format: string }).format).toBe('team-owner-answer-file-v1');
  });

  test("the owner's terminal still sets an entity's root with no request", async () => {
    const mac = signerMachine();
    const io = testIo(mac.home, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.root', '~/Code/acme'], io, { home: mac.home, now: () => NOW }), io.err).toBe(0);
    expect(entitiesText(mac.home)).toContain('root: ~/Code/acme');
  });

  test('a request on the machine that holds the signers names no machine and runs once on its own answer', async () => {
    const mac = signerMachine();
    const root = join(mac.home, 'repo');
    mkdirSync(root, { recursive: true });
    const asked = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/acme', '--request'], asked, { home: mac.home, now: () => NOW }), asked.err).toBe(0);
    const id = idOf(asked.out);
    const record = readOwnerActionRecord(mac.home, id) as OwnerActionRecord;
    expect(record.params.machine).toBeUndefined();
    const { approveOwnerAction } = await import('../src/client/owner-action.ts');
    expect(approveOwnerAction(mac.home, id, 'oui', mac.store, NOW, { signer: 'mac' }).ok).toBe(true);
    const run = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/acme', '--approval', id], run, { home: mac.home, now: () => NOW, ownerSeatStore: mac.store }), run.err).toBe(0);
    const replay = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/acme', '--approval', id], replay, { home: mac.home, now: () => NOW, ownerSeatStore: mac.store })).toBe(1);
  });

  test('setup on a pinned machine refuses and names the carried way', async () => {
    const s = scene();
    const io = testIo(s.server.root, TERMINAL);
    expect(await runSetup(['--signer', 'touch-id'], io, { home: s.server.home })).toBe(1);
    expect(io.err).toContain('keeps no charter of its own');
    expect(io.err).toContain('team approvals export');
  });
});

describe("the credential helper's one-prompt signing", () => {
  test('sign-many returns one signature per message under one prompt; an older helper is said to be older', () => {
    const dir = tempBase('helper');
    // The fake runs under this test's own runtime, whatever is on the PATH.
    const helper = join(dir, 'owner-seat-keystore');
    copyFileSync(join(import.meta.dir, 'fixtures', 'owner-seat', 'fake-keystore.mjs'), join(dir, 'fake-keystore.mjs'));
    writeFileSync(helper, `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'fake-keystore.mjs')}' "$@"\n`);
    chmodSync(helper, 0o700);
    const store = systemOwnerSeatKeyStore(helper);
    const created = store.create('mac');
    if (!created.ok) throw new Error(created.why);
    const messages = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
    const signed = store.signMany!('mac', messages, 'three answers');
    if (!signed.ok) throw new Error(signed.why);
    expect(signed.signatures).toHaveLength(3);
    const point = Buffer.from(created.publicKey, 'hex');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
    for (const [index, message] of messages.entries()) {
      expect(cryptoVerify('sha256', message, { key, dsaEncoding: 'der' }, Buffer.from(signed.signatures[index]!, 'hex'))).toBe(true);
    }
    expect(readFileSync(join(dir, 'prompts.log'), 'utf8').trim().split('\n')).toEqual(['Touch ID: three answers']);
    process.env.FAKE_KEYSTORE_OLD = '1';
    try {
      const old = store.signMany!('mac', messages, 'three answers');
      expect(old).toMatchObject({ ok: false, unsupported: true });
    } finally {
      delete process.env.FAKE_KEYSTORE_OLD;
    }
  });
});

