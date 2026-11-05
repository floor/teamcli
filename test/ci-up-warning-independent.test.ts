// The delivery warning belongs to a run every gate admits, never to a refusal. These scenes are
// independent of builder-2's: a refused `up` — no terminal, a held run lock, a pane no grant
// lists, a client grant that refuses under its own lock — prints only its refusal, and an
// admitted run with a pull-only lead still says the warning. The watch's `started_at` is the
// instant it reaches its loop (so a refused watch reads no source and down's proof matches a real
// watch's start), and its record keeps that first instant.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalOf, verifiedOf } from '../src/approve/approval.ts';
import type { Caller, CallerSources, Process } from '../src/caller.ts';
import { clientGrantPath, clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { readState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { watchLaunchOf, watchStopRead } from '../src/watch/pane.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const WARNING = 'lead is a lead seat and claude-code cannot be woken while it is idle; time-bound work is never dispatched to it';

// One claude-code lead seat and nothing else: the delivery class is the only warning a run of
// this file can carry, so a warning on a refusal's stderr can only be the gate that leaked.
let TEXT = '';
let base = '';
let root = '';
let home = '';
let lobby = '';
let file = '';

// The runner configures no git identity, and the host's own guess is not something a scene can
// rely on: every fixture commit names a synthetic author and committer. A failure keeps git's
// stderr, so the cause is read next time, not guessed.
function git(cwd: string, ...args: string[]): void {
  const env = gitEnv();
  env.GIT_AUTHOR_NAME = 'Fixture';
  env.GIT_AUTHOR_EMAIL = 'fixture@example.invalid';
  env.GIT_COMMITTER_NAME = 'Fixture';
  env.GIT_COMMITTER_EMAIL = 'fixture@example.invalid';
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr === '' ? (error as Error).message : stderr}`);
  }
}

function checked(text: string): TeamFile {
  const result = validateTeamFile(text, { home, root });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ci-up-warning-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  file = join(root, '.agents', 'team.yaml');
  TEXT = `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
rules:
  - Keep every change on a branch.
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, TEXT);
  git(root, 'init', '-q', '-b', 'main');
  const team = checked(TEXT);
  writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root, NOW), file: TEXT }, team.seats, home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// The caller walks the real placement reads: a terminal outside herdr; the same chain with its
// stdin cut (the no-terminal placement); and herdr is never asked, so a run that tried to place
// itself any other way would fail loudly.
const TERMINAL: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }, { pid: 30, name: 'Terminal' }];

function sceneIo(chain: Process[], over: { env?: Record<string, string | undefined>; stdinIsTTY?: boolean } = {}): ReturnType<typeof testIo> {
  const sources: CallerSources = {
    ancestors: () => chain,
    agents: () => { throw new Error('the walk asked herdr for a session'); },
    paneRootPid: () => { throw new Error('the walk asked herdr for a pane root'); },
    env: over.env ?? {},
    stdinIsTTY: over.stdinIsTTY ?? false,
  };
  const io = testIo(root);
  io.callerSources = () => sources;
  return io;
}

const noTerminal = () => sceneIo(TERMINAL);
const atATerminal = () => sceneIo(TERMINAL, { stdinIsTTY: true });

const boom = (what: string) => () => { throw new Error(`past the refusal: ${what}`); };

const LEADS_ROUTE = 'only the owner or a `leads` seat runs this, from a terminal outside herdr or its own pane';
const PLACED_ROUTE = 'only the owner or a placed seat runs this, from a terminal outside herdr or its own pane';

function upSources(over: Partial<UpSources> = {}): UpSources {
  return { sessionRunning: () => false, agents: () => [], home, now: () => NOW, ...over };
}

/** A launch whose every effect is recorded and whose every read is a quiet absence. */
function recordingLaunch(): { launch: Launch; created: () => number } {
  let made = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace() {
      made += 1;
      return { pane: `fixture-pane-${made}`, workspace: `fixture-ws-${made}` };
    },
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => claudeBox(''),
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return { launch, created: () => made };
}

/** The launch an admitted owner run uses: a running session and the seat's panes to read. */
function admittedLaunch(): Launch {
  const panes: string[] = [];
  return {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      panes.push(`fixture-pane-${panes.length + 1}`);
      return { pane: `fixture-pane-${panes.length}`, workspace: `fixture-ws-${panes.length}` };
    },
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes],
    agents: () => [],
    paneText: () => claudeBox(''),
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
}

describe('a refused up says only its refusal', () => {
  test('a run with no terminal prints its refusal alone, never the delivery warning', async () => {
    const { launch, created } = recordingLaunch();
    const io = noTerminal();
    const code = await runUp([], io, upSources({ launch }));
    expect(code).toBe(1);
    expect(io.err).toBe(`team up: ${LEADS_ROUTE}\n`);
    expect(io.err).not.toContain('cannot be woken');
    expect(created()).toBe(0);
  });

  test('a run that meets a held run lock prints the lock alone, never the delivery warning', async () => {
    const { launch, created } = recordingLaunch();
    const locks = join(root, '.agents', 'seat-locks', 'acme-web');
    mkdirSync(locks, { recursive: true });
    // A live pid's complete token: the lock is held, not stale, so the run is refused rather
    // than stealing it.
    writeFileSync(join(locks, '.run'), `${process.pid} abcdef012345\n`);
    const io = atATerminal();
    const code = await runUp([], io, upSources({ launch }));
    expect(code).toBe(1);
    expect(io.err).toContain(`team up: another session-mutating run is holding session acme-web (pid ${process.pid}, no start time recorded); try again when it is done\n`);
    expect(io.err).not.toContain('cannot be woken');
    expect(created()).toBe(0);
  });

  test('a dry run refused for a pane no grant lists prints the refusal, never the warning', async () => {
    const io = testIo(root, { kind: 'pane', pane: 'fixture-pane-7', session: 'acme-web' });
    const code = await runUp(['--dry-run'], io, upSources());
    expect(code).toBe(1);
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is it runs in pane acme-web/fixture-pane-7, which no grant lists\n');
    expect(io.out).not.toContain('cannot be woken');
    expect(io.err).toBe('');
  });
});

describe('an admitted up still says the delivery warning', () => {
  test('the owner at a terminal, a pull-only lead: the warning is said and the run goes on', async () => {
    const io = atATerminal();
    const code = await runUp([], io, upSources({ launch: admittedLaunch() }));
    expect(code).toBe(0);
    expect(io.err).toContain(`team up: ${WARNING}\n`);
  });
});

describe('a client grant that refuses under the run lock says only its refusal', () => {
  // A client-form world of the shape the grant fixtures build: one team the owner signed for one
  // client key, an isolated HOME whose grants folder is the only place a revocation can live, and
  // a fake launch whose effects are recorded. No herdr, no terminal, no real clock in the run.
  const DAY = 86_400_000;
  const made: string[] = [];
  const realTmp = process.env.TMPDIR;
  afterEach(() => {
    if (realTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmp;
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seat(name: string, role: string, extra: string[] = []): string {
    return [
      `  - role: ${role}`,
      `    name: ${name}`,
      `    label: ${name}`,
      '    cli: claude-code',
      '    vendor: anthropic',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      ...extra,
    ].join('\n');
  }

  function teamText(project: string, baseDir: string, rootDir: string, homeDir: string): string {
    return `format: 1
project: ${project}
coordinator: lead
operator: lead
session: ${project}
trust:
  - ${join(homeDir, '.config', 'team', 'lobby')}
  - ${rootDir}
  - ${join(baseDir, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seat('worker', 'implementer', ['    count: 1'])}
`;
  }

  function repo(baseDir: string, name: string, text: (rootDir: string) => string): string {
    const rootDir = join(baseDir, name);
    mkdirSync(join(rootDir, '.agents'), { recursive: true });
    git(baseDir, 'init', '-q', '--bare', '-b', 'main', join(baseDir, `${name}-remote.git`));
    git(rootDir, 'init', '-q', '-b', 'main');
    writeFileSync(join(rootDir, 'README.md'), `${name}\n`);
    git(rootDir, 'add', 'README.md');
    git(rootDir, 'commit', '-q', '-m', 'first');
    writeFileSync(join(rootDir, '.agents', 'team.yaml'), text(rootDir));
    return rootDir;
  }

  function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
    const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
    const pins = new Map<string, string>();
    const prompts: string[] = [];
    const point = (pair: ReturnType<typeof generateKeyPairSync>) => {
      const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
    };
    return {
      name: 'fake-credential-store', prompts,
      available: () => true,
      pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
      pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
      create: (label) => {
        const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
        keys.set(label, pair);
        return { ok: true, publicKey: point(pair) };
      },
      publicKey: (label) => {
        const pair = keys.get(label);
        return pair ? { ok: true, publicKey: point(pair) } : { ok: false, why: 'no key' };
      },
      sign: (label, message, reason) => {
        prompts.push(reason);
        const pair = keys.get(label);
        if (!pair) return { ok: false, why: 'no key' };
        return { ok: true, signature: cryptoSign('sha256', message, { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex') };
      },
    };
  }

  function world() {
    // The client key may not sit in the OS temp directory: for the test's length the OS temp is
    // a different, empty folder, and the world sits beside it.
    const worldBase = realpathSync(mkdtempSync(join(tmpdir(), 'ci-up-warning-client-')));
    made.push(worldBase);
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ci-up-warning-scratch-')));
    made.push(scratch);
    process.env.TMPDIR = scratch;
    const homeDir = join(worldBase, 'home');
    mkdirSync(join(homeDir, '.config', 'team'), { recursive: true });
    const docs = repo(worldBase, 'docs', (rootDir) => teamText('docs', worldBase, rootDir, homeDir));
    const pair = newClientKeyPair();
    const dir = clientKeyDir(homeDir, 'grok-bot');
    const written = writeClientKeyFiles(dir, pair);
    if (!written.ok) throw new Error(written.why);
    const wrote = writePolicySet(homeDir, { level: 'entity', target: 'floor', name: 'grant-emission', value: 'conversational' }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    return { base: worldBase, home: homeDir, docs, keyPath: written.keyPath, pubPath: written.pubPath, store: fakeStore() };
  }
  type World = ReturnType<typeof world>;

  function capture(w: World, caller?: Caller): { io: Io; out: () => string; err: () => string } {
    let out = '';
    let err = '';
    const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd: w.docs, env: {}, stdinIsTTY: false, ...(caller ? { caller } : {}) };
    return { io, out: () => out, err: () => err };
  }

  async function seated(w: World): Promise<void> {
    const code = await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], capture(w, { kind: 'owner' }).io, { home: w.home, ownerSeatStore: w.store });
    expect(code).toBe(0);
  }

  async function issued(w: World, extra: string[] = []): Promise<{ grantId: string; path: string }> {
    await seated(w);
    const flags = ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.pubPath, '--team', 'docs', '--up', '--request', ...extra, '--json'];
    const asked = capture(w);
    expect(await runGrant(flags, asked.io, { home: w.home, notify: () => false })).toBe(0);
    const id = (JSON.parse(asked.out().trim()) as { target: string }).target;
    const answered = capture(w);
    expect(await runGrant(['--approve-as-owner-seat', id, 'oui'], answered.io, { home: w.home, ownerSeatStore: w.store })).toBe(0);
    const done = capture(w);
    expect(await runGrant(['--execute', id], done.io, { home: w.home, ownerSeatStore: w.store })).toBe(0);
    const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out())![1]!;
    return { grantId, path: clientGrantPath(w.home, grantId) };
  }

  function clientLaunch(): Launch {
    const panes = new Map<string, string>();
    let n = 0;
    return {
      sessionState: () => 'absent',
      startServer: () => true,
      sessionUp: () => false,
      createWorkspace() {
        n += 1;
        panes.set(`fixture-pane-${n}`, claudeBox(''));
        return { pane: `fixture-pane-${n}`, workspace: `fixture-ws-${n}` };
      },
      paneRun: (_session, pane) => { panes.set(pane, claudeBox('')); return true; },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [...panes.keys()],
      agents: () => [],
      paneText: (_session, pane) => panes.get(pane) ?? '',
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    };
  }

  test('the grant verifies at the top and refuses under the lock: only its refusal', async () => {
    const w = world();
    const early = new Date();
    const late = new Date(early.getTime() + 3 * 3_600_000);
    const expires = new Date(early.getTime() + 3_600_000).toISOString();
    const g = await issued(w, ['--expires', expires]);
    // The run's clock: the top verification reads `early` (the grant is live), and every later
    // read — the re-read under the grant lock included — is `late` (the grant has expired).
    let calls = 0;
    const clock = (): Date => (++calls <= 1 ? early : late);
    const io = testIo(w.docs, { kind: 'owner-no-tty' });
    const code = await runUp(['--client', g.path, '--key', w.keyPath], io, {
      sessionRunning: () => false,
      agents: () => [],
      home: w.home,
      now: clock,
      launch: clientLaunch(),
    });
    expect(code).toBe(1);
    // The re-read's sentence: it names the grant and its expiry, and carries no reissue suffix
    // (the top verification's refusal is the one that appends it).
    expect(io.err).toContain(`team up: the up grant ${g.grantId} expired at ${expires}`);
    expect(io.err).not.toContain('the owner issues a new one');
    // The grant verified at the top, so the refusal is the one under the lock — and no delivery
    // warning rides before it.
    expect(io.err).toContain(`client grant ${g.grantId}: grok-bot for team docs`);
    expect(io.err).not.toContain('cannot be woken');
  });
});

describe('the watch reads its start instant after it is admitted', () => {
  test('a refused watch reads no source at all', async () => {
    const throwingWatch: WatchSources = {
      live: boom('the live read'),
      machine: boom('the machine'),
      standing: boom('the store'),
      readChecks: boom('the checks'),
      screen: boom('a screen'),
      status: boom('a status'),
      foreground: boom('a foreground'),
      typeText: boom('a typing'),
      pressEnter: boom('an enter'),
      sleep: async () => { throw new Error('past the refusal: a sleep'); },
      notify: boom('a notice'),
      now: boom('the clock'),
      wait: async () => { throw new Error('past the refusal: a wait'); },
      alive: boom('a pid'),
      pid: 0,
    };
    const io = noTerminal();
    const code = await runWatch([], io, throwingWatch);
    expect(code).toBe(1);
    expect(io.err).toBe(`team watch: ${PLACED_ROUTE}\n`);
  });

  test('an admitted watch records the instant it reached the loop as started_at', async () => {
    let calls = 0;
    let seen: { pid?: number; heartbeat: string; started_at?: string } | undefined;
    const sources: WatchSources = {
      home,
      live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
      machine: () => ({ loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 }),
      standing: (at) => verifiedOf(checked(TEXT), TEXT, at),
      readChecks: () => [],
      screen: () => null,
      status: () => null,
      foreground: () => [],
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => new Date(NOW.getTime() + 1_000 * calls++),
      // The beat has landed by the time the watch waits for its next pass; the record is read
      // here, before the run's own exit removes it.
      wait: async () => {
        seen = readState(join(root, '.agents')).sessions['acme-web']?.watch;
        return false;
      },
      alive: () => false,
      pid: 4242,
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources);
    expect(code).toBe(0);
    expect(seen?.pid).toBe(4242);
    // The first clock read is the admission's, before the first pass reads anything.
    expect(seen?.started_at).toBe(NOW.toISOString());
    expect(Date.parse(seen!.heartbeat)).toBeGreaterThan(NOW.getTime());

    // Down proves a pane-less record by its start instant, under the team's own launch identity:
    // this watch names no file, so its working folder is the folder this team is read from. The
    // record a real watch writes matches a process that started just before that instant, and one
    // that started well after it does not; a record with no instant is never signalled.
    const record = { pid: seen!.pid!, heartbeat: seen!.heartbeat, started_at: seen!.started_at };
    const cli = realpathSync(fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
    const command = `bun ${cli} watch --session acme-web`;
    const launch = watchLaunchOf(file, join(root, '.agents'));
    const recordedAt = Date.parse(record.started_at!);
    const proven = watchStopRead(record, 'acme-web', { alive: () => true, commandOf: () => command, startOf: () => recordedAt - 1_000, cwdOf: () => root }, launch);
    expect(proven).toEqual({ kind: 'proven', pid: 4242 });
    const mismatched = watchStopRead(record, 'acme-web', { alive: () => true, commandOf: () => command, startOf: () => recordedAt + 5_000, cwdOf: () => root }, launch);
    expect(mismatched).toEqual({ kind: 'unproven', pid: 4242, why: 'pid 4242 started at a time its record does not match' });
    const noStart = watchStopRead({ pid: 4242 }, 'acme-web', {
      alive: () => true,
      commandOf: () => command,
      startOf: boom('a start instant a record without one does not have') as unknown as () => number,
      cwdOf: () => root,
    }, launch);
    expect(noStart).toEqual({ kind: 'unproven', pid: 4242, why: 'pid 4242 has no recorded start instant to match' });
  });
});
