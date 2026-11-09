// A hand-run team watch, in a pane, is a read-only view of the daemon's watch. It prints
// the daemon's line and writes nothing: the state file and the log stay as they were.
// The daemon's own takeover of a dead pane record is a different caller, covered below.
// Liveness and the process verdict come from the watch sources.
// Homes and pane names are synthetic. No signal is sent and no CLI is started.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { activateDeadPaneWatch, runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T12:00:00Z');
const OLD_PID = 5151;
const OLD_PANE = 'pane-old';
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

type Verdict = { pane: 'gone' | 'watch' | 'shell'; pidLive: boolean };

function open(verdict: Verdict): { root: string; dir: string; home: string; file: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'watch-takeover-')));
  made.push(home);
  const root = join(home, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  chmodSync(lobbyDir(home), 0o700);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(dir, 'team.yaml');
  const text = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${root}
  - ${lobbyDir(home)}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: maker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  const processes: PaneProcesses | null = verdict.pane === 'gone'
    ? null
    : { shell: 11, foreground: [OLD_PID] };
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watchdog = { file, pane: OLD_PANE };
    session.watch = { pid: OLD_PID, heartbeat: NOW.toISOString(), pane: OLD_PANE };
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.maker = { stage: 'ready', pane: 'pane-maker' };
  });
  return { root, dir, home, file };
}

function sources(scene: { home: string; root: string }, verdict: Verdict, startedBy?: 'up' | 'daemon'): WatchSources {
  const processes: PaneProcesses | null = verdict.pane === 'gone'
    ? null
    : { shell: 11, foreground: [OLD_PID] };
  return {
    live: () => ({
      running: true,
      agents: verdict.pane === 'gone'
        ? []
        : [{ name: 'lead', agent: 'claude', pane: OLD_PANE, workspace: 'ws-old', status: 'idle', cwd: scene.root }],
      workspaces: verdict.pane === 'gone' ? [] : [{ id: 'ws-old', label: 'old' }],
      screens: {},
      processes: (processes === null ? {} : { [OLD_PANE]: processes }) as Record<string, PaneProcesses | null>,
    }),
    machine: () => ({ loadPerCore: 0, memoryFree: 100, diskFree: 1e12, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }),
    standing: () => ({ kind: 'none' }) as Standing,
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => (verdict.pane === 'watch' ? ['team'] : verdict.pane === 'shell' ? ['zsh'] : null),
    processes: (_session, pane) => (pane === OLD_PANE ? processes : null),
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => NOW,
    wait: async () => false,
    alive: (pid) => verdict.pidLive && pid === OLD_PID,
    pid: 4242,
    home: scene.home,
    ownPane: () => ({ pane: 'pane-lead', workspace: 'ws-lead' }),
    ...(startedBy === undefined ? {} : { startedBy }),
  };
}

function recordText(dir: string): string {
  return readFileSync(join(dir, 'team.state.json'), 'utf8');
}

const DAEMON_LINE = 'team watch: the daemon does not host session acme\n';

async function expectPaneView(
  scene: { dir: string },
  io: ReturnType<typeof testIo>,
  src: WatchSources,
): Promise<void> {
  const before = recordText(scene.dir);
  const code = await runWatch(['--session', 'acme'], io, src);
  expect(code, io.err + io.out).toBe(0);
  expect(io.out).toBe(DAEMON_LINE);
  expect(io.err).toBe('');
  expect(recordText(scene.dir)).toBe(before);
  expect(existsSync(join(scene.dir, LOG_FILE))).toBe(false);
}

test('a lead watch in a pane prints the daemon line and writes nothing when the recorded pane is gone', async () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  await expectPaneView(scene, io, sources(scene, { pane: 'gone', pidLive: false }));
  expect(readState(scene.dir).sessions.acme?.watchdog).toEqual({ file: scene.file, pane: OLD_PANE });
});

test('a lead watch in a pane prints the daemon line and writes nothing while a live watch is recorded', async () => {
  const scene = open({ pane: 'watch', pidLive: true });
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  await expectPaneView(scene, io, sources(scene, { pane: 'watch', pidLive: true }));
  expect(readState(scene.dir).sessions.acme?.watchdog).toEqual({ file: scene.file, pane: OLD_PANE });
});

test('a pane watch prints the daemon line and writes nothing when the recorded pane is only a shell', async () => {
  const shell = { pane: 'shell' as const, pidLive: false };
  const lead = open(shell);
  const leadIo = testIo(lead.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  await expectPaneView(lead, leadIo, sources(lead, shell));

  const up = open(shell);
  const upIo = testIo(up.root, { kind: 'pane', pane: 'pane-up', session: 'acme' });
  await expectPaneView(up, upIo, sources(up, shell, 'up'));

  const daemon = open(shell);
  const daemonIo = testIo(daemon.root, { kind: 'daemon' });
  await expectPaneView(daemon, daemonIo, sources(daemon, shell, 'daemon'));
});

test('a seat that is not the lead prints the daemon line and writes nothing on a dead record', async () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const io = testIo(scene.root, { kind: 'seat', name: 'maker', pane: 'pane-maker', session: 'acme' });
  await expectPaneView(scene, io, sources(scene, { pane: 'gone', pidLive: false }));
  expect(readState(scene.dir).sessions.acme?.watchdog?.pane).toBe(OLD_PANE);
});

const REAL_NOW = new Date('2026-11-08T14:55:00Z');
const EPOCH = 'watch_0123456789abcdef0123456789abcdef';

type CapturedWatch = {
  watchdog: { file: string };
  watch: { pane: string; heartbeat: string; workspace: string };
};

/** The five captured teams, plus the sanitized session's own watch. `<root>` is this scene's checkout. */
function capturedWatches(root: string): CapturedWatch[] {
  const records = readFileSync(new URL('./fixtures/watch-real-state/real-watch-records.json', import.meta.url), 'utf8').replaceAll('<root>', root);
  const shape = readFileSync(new URL('./fixtures/watch-real-state/real-session-shape.json', import.meta.url), 'utf8').replaceAll('<root>', root);
  const listed = Object.values(JSON.parse(records) as Record<string, CapturedWatch>);
  const session = JSON.parse(shape) as { sessions: { acme: { watch: CapturedWatch['watch'] } } };
  return [
    ...listed,
    { watchdog: { file: join(root, '.agents', 'team.yaml') }, watch: session.sessions.acme.watch },
  ];
}

function plantCaptured(dir: string, record: CapturedWatch, patch?: { heartbeat?: string; pid?: number; epoch?: string }): void {
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watchdog = { file: record.watchdog.file };
    session.watch = {
      pane: record.watch.pane,
      heartbeat: patch?.heartbeat ?? record.watch.heartbeat,
      workspace: record.watch.workspace,
      ...(patch?.pid === undefined ? {} : { pid: patch.pid }),
      ...(patch?.epoch === undefined ? {} : { epoch: patch.epoch }),
    };
  });
}

function daemonSources(
  scene: { home: string; root: string },
  options: { verdict: 'gone' | 'shell'; pidLive?: boolean },
): WatchSources {
  return {
    ...sources(scene, { pane: 'gone', pidLive: false }),
    now: () => REAL_NOW,
    paneVerdict: () => options.verdict,
    watchPidLive: (pid) => options.pidLive === true && pid === OLD_PID,
    alive: (pid) => options.pidLive === true && pid === OLD_PID,
  };
}

test('a daemon hosted watch takes over a stale record instead of standing by', () => {
  const scene = open({ pane: 'gone', pidLive: false });
  for (const record of capturedWatches(scene.root)) {
    for (const verdict of ['shell', 'gone'] as const) {
      plantCaptured(scene.dir, record);
      const seats = JSON.stringify(readState(scene.dir).sessions.acme?.seats);
      rmSync(join(scene.dir, LOG_FILE), { force: true });
      const took = activateDeadPaneWatch(scene.root, 'acme', daemonSources(scene, { verdict }));
      const reason = verdict === 'gone' ? 'gone' : 'shell';
      expect(took).toBe(true);
      const after = readState(scene.dir).sessions.acme;
      expect(after?.watch).toBeUndefined();
      expect(after?.watchdog).toEqual({ file: record.watchdog.file });
      expect(JSON.stringify(after?.seats)).toBe(seats);
      const log = readFileSync(join(scene.dir, LOG_FILE), 'utf8');
      expect(log).toContain(`pane watch ${record.watch.pane} not alive: ${reason}; the daemon's watch is active`);
    }
  }
});

test('a fresh hand-over ten seconds old stays on standby', () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const record = capturedWatches(scene.root)[0];
  if (record === undefined) throw new Error('the captured records are empty');
  plantCaptured(scene.dir, record, { heartbeat: new Date(REAL_NOW.getTime() - 10_000).toISOString() });
  const before = recordText(scene.dir);
  const took = activateDeadPaneWatch(scene.root, 'acme', daemonSources(scene, { verdict: 'shell' }));
  expect(took).toBe(false);
  expect(recordText(scene.dir)).toBe(before);
  expect(existsSync(join(scene.dir, LOG_FILE))).toBe(false);
});

test('a live watch pid stays on standby', () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const record = capturedWatches(scene.root)[0];
  if (record === undefined) throw new Error('the captured records are empty');
  plantCaptured(scene.dir, record, { pid: OLD_PID });
  const before = recordText(scene.dir);
  const took = activateDeadPaneWatch(scene.root, 'acme', daemonSources(scene, { verdict: 'shell', pidLive: true }));
  expect(took).toBe(false);
  expect(recordText(scene.dir)).toBe(before);
  expect(existsSync(join(scene.dir, LOG_FILE))).toBe(false);
});

test('a dead pane watch fenced by a real epoch stays recorded', () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const record = capturedWatches(scene.root)[0];
  if (record === undefined) throw new Error('the captured records are empty');
  plantCaptured(scene.dir, record, { epoch: EPOCH });
  const before = recordText(scene.dir);
  expect(readState(scene.dir).sessions.acme?.watch?.epoch).toBe(EPOCH);
  const took = activateDeadPaneWatch(scene.root, 'acme', daemonSources(scene, { verdict: 'shell' }));
  expect(took).toBe(false);
  expect(recordText(scene.dir)).toBe(before);
  expect(readState(scene.dir).sessions.acme?.watch?.epoch).toBe(EPOCH);
});
