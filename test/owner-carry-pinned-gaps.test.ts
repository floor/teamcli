// The owner-only commands that had no owner-seat door on a machine whose owner seat is pinned from
// another machine — an entity's own record (`team config set <entity>.root` and the other entity
// keys) and the machine daemon (`team daemon install|restart|uninstall|fault-watch`) — now take
// `--request` and `--approval <id>`, carried as files like any other request, each signed on its
// own over a card that shows its exact change. Every scene is synthetic: fake credential stores, temporary
// homes and repositories, a fake service manager; no terminal host is started.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_TERMINAL_REASON, type Caller } from '../src/caller.ts';
import { ownerActionHash, readOwnerActionRecord, type OwnerActionRecord } from '../src/client/owner-action.ts';
import { cardPrompt, cardWhole, ownerActionCard, PROMPT_MAX, shortDigest } from '../src/client/approval-card.ts';
import type { OwnerRequestFile } from '../src/client/owner-carry.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { exportOwnerSeat, pinOwnerSeat, type SignedOwnerSeatExport } from '../src/client/owner-pin.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runConfig } from '../src/commands/config.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { runSetup } from '../src/commands/setup.ts';
import type { ServiceManager, ServiceProgram } from '../src/daemon/service.ts';
import type { DaemonHealth } from '../src/daemon/health.ts';
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

/** A credential store whose every user-presence prompt is counted. */
function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const prompts: string[] = [];
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
      return keys.has(label) ? { ok: true, signature: cryptoSign('sha256', message, { key: keys.get(label)!.privateKey, dsaEncoding: 'der' }).toString('hex') } : { ok: false, why: 'no key' };
    },
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

function scene(name = 'server'): Scene {
  const mac = signerMachine();
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

/** A checkout holding team `acme`, its lead placed, as an install hosts one. */
function teamCheckout(home: string, name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  const lobby = resolveLobby(home, { entity: 'acme' });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: ${name}
entity: acme
session: ${name}
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
  return root;
}

/** The health reading an install confirms: the daemon it started answers its probe. */
const ANSWERING: DaemonHealth = {
  daemon: 'teamcli',
  socket: '/synthetic/daemon.sock',
  state: 'running',
  running: true,
  pid: 42,
  uid: 501,
  since: '2026-11-01T00:00:00.000Z',
  startedBy: 'system-service-manager',
  version: 'test',
  gitHead: null,
  heartbeatAt: null,
  heartbeatSeconds: null,
  features: null,
  stuck: [],
  roots: [],
  probe: { state: 'answered', at: '2026-11-01T00:00:01.000Z' },
  why: null,
};

/** The fake service manager a daemon scene changes: it records each call and touches nothing. */
function fakeService(): ServiceManager & { calls: string[]; programs: ServiceProgram[] } {
  const calls: string[] = [];
  const programs: ServiceProgram[] = [];
  return {
    kind: 'system-service-manager',
    calls,
    programs,
    unitPath: (home) => join(home, 'unit'),
    plan: (home, program) => ({ unitPath: join(home, 'unit'), program: [program.execPath, program.entry, 'daemon', 'run'] }),
    job: () => null,
    unit: () => null,
    install: (home, program) => { calls.push('install'); programs.push(program); return { ok: true, unitPath: join(home, 'unit') }; },
    uninstall: (home) => { calls.push('uninstall'); return { ok: true, unitPath: join(home, 'unit'), removed: true }; },
    restart: () => { calls.push('restart'); return { ok: false, reason: 'refused', why: 'not in this scene', detail: null }; },
  } as ServiceManager & { calls: string[]; programs: ServiceProgram[] };
}

const configOn = (s: Scene, argv: string[], caller: Caller = TERMINAL) => {
  const io = testIo(s.server.root, caller);
  return runConfig(argv, io, { home: s.server.home, now: () => NOW }).then((code) => ({ code, io }));
};

const daemonOn = (s: Scene, argv: string[], service: ServiceManager, caller: Caller = TERMINAL) => {
  const io = testIo(s.server.root, caller);
  return runDaemon(argv, io, { home: s.server.home, accountHome: s.server.home, service, now: () => NOW }).then((code) => ({ code, io }));
};

async function carry(s: Scene, ids: string[], word: string | null = 'oui', terminal = true): Promise<{ request: string; answer: string; signIo: ReturnType<typeof testIo> }> {
  const request = join(s.files, `request-${Math.random().toString(16).slice(2)}.json`);
  const exported = testIo(s.server.root, TERMINAL);
  expect(await runApprovals(['export', ...ids, '--out', request], exported, { home: s.server.home, now: () => NOW }), exported.err).toBe(0);
  const answer = join(s.files, `answer-${Math.random().toString(16).slice(2)}.json`);
  const signIo = testIo(s.mac.home);
  // The owner signs at a terminal, where the change is shown whole before the prompt.
  if (terminal) signIo.stderrIsTTY = true;
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
    // The owner's card names the change in full: the operation, the key, the exact value and the file.
    expect(s.mac.store.prompts[0]).toContain("change where an entity's projects sit");
    expect(s.mac.store.prompts[0]).toContain('Entity acme on server');
    // The prompt carries the change whole when it fits, else its length and digest; the terminal
    // shows it whole before the prompt either way.
    const whole = `set "acme.root" to "~/Code/acme" in "${entitiesPath(s.server.home)}"`;
    const digest = shortDigest(JSON.stringify({ path: 'acme.root', value: '~/Code/acme', file: entitiesPath(s.server.home) }));
    const prompt = s.mac.store.prompts[0]!;
    expect(prompt.includes(whole) || prompt.includes(`set root to a value of 11 characters, digest ${digest}, shown in full on screen`), prompt).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(carried.signIo.err).toContain(whole);
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
    expect(s.mac.store.prompts[0]).toContain(`uninstall for home "${realpathSync(s.server.home)}"`);
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

  test('an install binds one plan of real paths, runs exactly it, and a dry run spends nothing', async () => {
    const s = scene();
    const service = fakeService();
    const repo = teamCheckout(s.server.home, 'checkout');
    const link = join(s.server.home, 'alias');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(repo, link);
    const sources = { home: s.server.home, accountHome: s.server.home, service, now: () => NOW, program: { execPath: process.execPath, entry: join(s.server.home, 'cli.js') }, health: async () => ANSWERING };
    const run = async (argv: string[]) => { const io = testIo(s.server.home, SEAT); const code = await runDaemon(argv, io, sources); return { code, io }; };
    const asked = await run(['install', '--root', 'alias', '--presence', '--request']);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    const record = readOwnerActionRecord(s.server.home, id) as OwnerActionRecord;
    expect(record.params.words?.['team-daemon']).toEqual(['install', `home=${realpathSync(s.server.home)}`, `root=${realpathSync(repo)}`, 'presence']);
    const carried = await carry(s, [id]);
    expect((await answerOn(s, carried.answer)).code).toBe(0);
    // A dry run checks the answer and spends nothing.
    expect((await run(['install', '--root', 'alias', '--presence', '--dry-run', '--approval', id])).code).toBe(0);
    expect(existsSync(join(actionRequestsFolder(s.server.home), `${id}.used-team-daemon`))).toBe(false);
    // The alias now names another checkout: the plan differs, and the answer admits nothing.
    const other = teamCheckout(s.server.home, 'other');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(link);
    symlinkSync(other, link);
    expect((await run(['install', '--root', 'alias', '--presence', '--approval', id])).code).toBe(1);
    expect(service.calls).toEqual([]);
    unlinkSync(link);
    symlinkSync(repo, link);
    const installed = await run(['install', '--root', 'alias', '--presence', '--approval', id]);
    expect(installed.code, installed.io.err).toBe(0);
    expect(service.calls).toEqual(['install']);
    // The unit hosts the plan's real path, not the alias.
    expect(service.programs.at(-1)?.roots).toEqual([realpathSync(repo)]);
    expect((await run(['install', '--root', 'alias', '--presence', '--approval', id])).code).toBe(1);
  });

  test('a checkout that does not resolve refuses the request', async () => {
    const s = scene();
    const asked = await daemonOn(s, ['install', '--root', join(s.server.home, 'missing'), '--request'], fakeService(), SEAT);
    expect(asked.code).toBe(1);
    expect(asked.io.err).toContain('nothing was recorded or run');
  });

  test('the request options belong to install and uninstall only', async () => {
    const s = scene();
    const service = fakeService();
    expect((await daemonOn(s, ['status', '--request'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['restart', '--request'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['restart', '--approval', 'oa_000000000000000000000000'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['fault-watch', '--root', '.', '--route', 'r', '--request'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['uninstall', '--request', '--approval', 'oa_000000000000000000000000'], service, SEAT)).code).toBe(2);
    expect((await daemonOn(s, ['uninstall', '--reason', 'why'], service, SEAT)).code).toBe(2);
  });
});

describe('an exact change is never bundled, and is shown whole before it is signed', () => {
  test('a request that bundles an entity or daemon action is refused when it is made and when it is signed', async () => {
    const s = scene();
    const { createOwnerActionRequest } = await import('../src/client/owner-action.ts');
    const words = ['set', 'acme.root', '~/x', `file=${entitiesPath(s.server.home)}`];
    const made = createOwnerActionRequest(s.server.home, { actions: ['team-entity-config', 'team-up'], root: s.server.root, team: 'acme', head: null, args: { 'team-entity-config': words, 'team-up': [] }, requestedBy: 'lead' }, NOW);
    expect(made).toMatchObject({ ok: false });
    expect((made as { why: string }).why).toContain('asked for on its own');
    // A carried file whose record bundles one, with every hash whole, is refused before its card.
    const asked = await configOn(s, ['set', 'acme.root', '~/Code/acme', '--request'], SEAT);
    const id = idOf(asked.io.out);
    const request = join(s.files, 'one.json');
    expect(await runApprovals(['export', id, '--out', request], testIo(s.server.root, TERMINAL), { home: s.server.home, now: () => NOW })).toBe(0);
    const file = JSON.parse(readFileSync(request, 'utf8')) as OwnerRequestFile;
    const { actionArgsHash } = await import('../src/client/owner-action.ts');
    const params = { ...file.request.params, actions: [...file.request.params.actions, 'team-up' as const], args: { ...file.request.params.args, 'team-up': actionArgsHash('team-up', []) }, words: { ...file.request.params.words, 'team-up': [] } };
    const bundled = { ...file, request: { ...file.request, params, params_sha256: ownerActionHash(params) } };
    const path = join(s.files, 'bundled.json');
    writeFileSync(path, JSON.stringify(bundled));
    const io = testIo(s.mac.home);
    io.stderrIsTTY = true;
    expect(await runApprovals(['sign', '--from', path, '--out', join(s.files, 'bundled-answer.json'), '--answer', 'oui'], io, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
    expect(io.err).toContain('asked for on its own');
    expect(s.mac.store.prompts).toHaveLength(0);
  });

  test('a change the prompt cannot carry is not signed where it cannot be shown whole', async () => {
    const s = scene();
    const rule = 'every seat keeps its own worktree and never pushes to the main branch without the lead reading the change first';
    const asked = await configOn(s, ['set', 'acme.rules', `[ "${rule}" ]`, '--request'], SEAT);
    const id = idOf(asked.io.out);
    const request = join(s.files, 'request.json');
    expect(await runApprovals(['export', id, '--out', request], testIo(s.server.root, TERMINAL), { home: s.server.home, now: () => NOW })).toBe(0);
    const io = testIo(s.mac.home);
    expect(await runApprovals(['sign', '--from', request, '--out', join(s.files, 'answer.json'), '--answer', 'oui'], io, { home: s.mac.home, now: () => NOW, ownerSeatStore: s.mac.store })).toBe(1);
    expect(io.err).toContain('has no terminal to show it whole');
    expect(s.mac.store.prompts).toHaveLength(0);
    // At a terminal the change is printed whole, then signed.
    const carried = await carry(s, [id]);
    expect(carried.signIo.err).toContain('the confirmation that follows answers request');
    expect(carried.signIo.err).toContain(rule);
    expect(s.mac.store.prompts).toHaveLength(1);
    expect(s.mac.store.prompts[0]).toContain('shown in full on screen');
    expect(s.mac.store.prompts[0]!.length).toBeLessThanOrEqual(PROMPT_MAX);
  });

  test('every untrusted field is quoted, control characters are escaped, and the prompt stays in budget', () => {
    const words = ['set', 'acme.rules', '["one\u001b[31m", "two\nthree"]', 'file=/x/\u0007entities.yaml'];
    const card = ownerActionCard({ actions: ['team-entity-config'], team: 'acme', requested_by: 'lead', words: { 'team-entity-config': words } });
    const whole = cardWhole(card);
    expect(whole).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(whole).toContain('"acme.rules"');
    expect(cardPrompt(card)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(cardPrompt(card).length).toBeLessThanOrEqual(PROMPT_MAX);
    const daemon = ownerActionCard({ actions: ['team-daemon'], team: 'daemon', requested_by: 'lead', words: { 'team-daemon': ['install', 'home=/h', ...Array.from({ length: 12 }, (_, i) => `root=/very/long/checkout/path/number/${i}`), 'presence'] } });
    expect(cardPrompt(daemon).length).toBeLessThanOrEqual(PROMPT_MAX);
    expect(cardPrompt(daemon)).toContain('12 checkouts');
    expect(cardWhole(daemon)).toContain('"/very/long/checkout/path/number/11"');
  });
});

describe('an entity unset that finds nothing still spends its answer', () => {
  test('a missing file reads as done, spends the answer once, and the replay is refused', async () => {
    const s = scene();
    const asked = await configOn(s, ['unset', 'acme.root', '--request'], SEAT);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    const carried = await carry(s, [id]);
    expect((await answerOn(s, carried.answer)).code).toBe(0);
    const run = await configOn(s, ['unset', 'acme.root', '--approval', id], SEAT);
    expect(run.code, run.io.err).toBe(0);
    expect(run.io.out).toContain('nothing changed');
    // A value set later is not removed under the same answer.
    writeFileSync(entitiesPath(s.server.home), 'acme:\n  root: ~/Code/acme\n');
    const replay = await configOn(s, ['unset', 'acme.root', '--approval', id], SEAT);
    expect(replay.code).toBe(1);
    expect(entitiesText(s.server.home)).toContain('root: ~/Code/acme');
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

  test('an entity or daemon request is answered once or denied: always is refused and no rule is kept', async () => {
    const mac = signerMachine();
    const root = join(mac.home, 'repo');
    mkdirSync(root, { recursive: true });
    const asked = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/acme', '--request'], asked, { home: mac.home, now: () => NOW })).toBe(0);
    const id = idOf(asked.out);
    const { approveOwnerAction, listOwnerActionRules } = await import('../src/client/owner-action.ts');
    const always = approveOwnerAction(mac.home, id, 'always', mac.store, NOW, { signer: 'mac' });
    expect(always).toMatchObject({ ok: false });
    expect((always as { why: string }).why).toContain('keeps no standing rule');
    expect(listOwnerActionRules(mac.home, mac.store, NOW).rules).toEqual([]);
    // Another request for the same action, unanswered, never runs on any rule.
    const other = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/other', '--request'], other, { home: mac.home, now: () => NOW })).toBe(0);
    const run = testIo(root, SEAT);
    expect(await runConfig(['set', 'acme.root', '~/Code/other', '--approval', idOf(other.out)], run, { home: mac.home, now: () => NOW, ownerSeatStore: mac.store })).toBe(1);
    expect(run.err).toContain('has no owner-seat answer yet');
  });

  test('a daemon answer binds the resolved targets: another checkout or a relative word read elsewhere admits nothing', async () => {
    const s = scene();
    const service = fakeService();
    const a = join(s.server.home, 'a');
    const b = join(s.server.home, 'b');
    for (const dir of [a, b]) mkdirSync(join(dir, '.agents'), { recursive: true });
    const io = (cwd: string) => testIo(cwd, SEAT);
    const run = (cwd: string, argv: string[]) => { const one = io(cwd); return runDaemon(argv, one, { home: s.server.home, accountHome: s.server.home, service, now: () => NOW }).then((code) => ({ code, io: one })); };
    const asked = await run(s.server.home, ['uninstall', '--home', 'a', '--request']);
    expect(asked.code, asked.io.err).toBe(0);
    const id = idOf(asked.io.out);
    const record = readOwnerActionRecord(s.server.home, id) as OwnerActionRecord;
    expect(record.params.words?.['team-daemon']).toEqual(['uninstall', `home=${realpathSync(a)}`]);
    const carried = await carry(s, [id]);
    expect((await answerOn(s, carried.answer)).code).toBe(0);
    // The same words from another folder name another home: refused, and the manager is untouched.
    expect((await run(b, ['uninstall', '--home', '../a/../b', '--approval', id])).code).toBe(1);
    expect(service.calls).toEqual([]);
    // An option-like value is refused before anything is bound.
    expect((await run(s.server.home, ['uninstall', '--home', '--reason', '--request'])).code).toBe(2);
  });

  test('setup on a pinned machine refuses and names the carried way', async () => {
    const s = scene();
    const io = testIo(s.server.root, TERMINAL);
    expect(await runSetup(['--signer', 'touch-id'], io, { home: s.server.home })).toBe(1);
    expect(io.err).toContain('keeps no charter of its own');
    expect(io.err).toContain('team approvals export');
  });
});
