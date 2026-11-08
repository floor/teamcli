// A dead watch record can be taken over by the placed lead. The recorded pane is gone and
// its pid is not a live team watch: the record is rewritten, the audit line is written
// before the watch starts, and the watch starts. A recorded pane that is still running
// team watch, with a live pid, refuses a second watch with the message a second watch
// gets today, and the record stays as it was. A seat that is not the lead is refused
// on a dead record. Liveness and the process verdict come from the watch sources.
// Homes and pane names are synthetic. No signal is sent and no CLI is started.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { emptySession, LOG_FILE, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval, type Standing } from '../src/store/store.ts';
import type { PaneProcesses } from '../src/herdr.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T12:00:00Z');
const OLD_PID = 5151;
const OLD_PANE = 'pane-old';
const TODAY = 'only the watch this session records may read the file up recorded';
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

test('a gone pane and a dead pid let the lead take the watch over', async () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  const code = await runWatch(['--session', 'acme'], io, sources(scene, { pane: 'gone', pidLive: false }));
  expect(code, io.err + io.out).toBe(0);
  const watchdog = readState(scene.dir).sessions.acme?.watchdog;
  expect(watchdog?.file).toBe(scene.file);
  expect(watchdog?.pane === 'pane-lead' || watchdog?.pane === undefined).toBe(true);
  expect(watchdog?.pane).not.toBe(OLD_PANE);
  const log = readFileSync(join(scene.dir, LOG_FILE), 'utf8');
  const audit = log.indexOf('watch record taken over from pane-old: gone');
  const start = log.indexOf('watching the session');
  expect(audit).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(audit);
  expect(io.out).toContain('watching the session');
});

test('a live pane running team watch refuses a second watch and keeps the record', async () => {
  const scene = open({ pane: 'watch', pidLive: true });
  const before = recordText(scene.dir);
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  const code = await runWatch(['--session', 'acme'], io, sources(scene, { pane: 'watch', pidLive: true }));
  expect(code, io.err + io.out).toBe(1);
  expect(io.err + io.out).toContain(TODAY);
  expect(io.err + io.out).toContain('this call is lead');
  expect(recordText(scene.dir)).toBe(before);
  expect(readState(scene.dir).sessions.acme?.watchdog).toEqual({ file: scene.file, pane: OLD_PANE });
});

test('a pane that is only a shell lets the lead, up, and the daemon take the watch over', async () => {
  const shell = { pane: 'shell' as const, pidLive: false };
  const lead = open(shell);
  const leadIo = testIo(lead.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  expect(await runWatch(['--session', 'acme'], leadIo, sources(lead, shell)), leadIo.err + leadIo.out).toBe(0);
  expect(readState(lead.dir).sessions.acme?.watchdog).toEqual({ file: lead.file, pane: 'pane-lead' });
  const leadLog = readFileSync(join(lead.dir, LOG_FILE), 'utf8');
  expect(leadLog.indexOf('watch record taken over from pane-old: no watch running')).toBeGreaterThanOrEqual(0);
  expect(leadLog.indexOf('watching the session')).toBeGreaterThan(leadLog.indexOf('watch record taken over from pane-old: no watch running'));

  const up = open(shell);
  const upIo = testIo(up.root, { kind: 'pane', pane: 'pane-up', session: 'acme' });
  expect(await runWatch(['--session', 'acme'], upIo, sources(up, shell, 'up')), upIo.err + upIo.out).toBe(0);
  expect(readState(up.dir).sessions.acme?.watchdog).toEqual({ file: up.file, pane: 'pane-up' });
  expect(readFileSync(join(up.dir, LOG_FILE), 'utf8')).toContain('watch record taken over from pane-old: no watch running');

  const daemon = open(shell);
  const daemonIo = testIo(daemon.root, { kind: 'daemon' });
  expect(await runWatch(['--session', 'acme'], daemonIo, sources(daemon, shell, 'daemon')), daemonIo.err + daemonIo.out).toBe(0);
  expect(readState(daemon.dir).sessions.acme?.watchdog).toEqual({ file: daemon.file });
  expect(readFileSync(join(daemon.dir, LOG_FILE), 'utf8')).toContain('watch record taken over from pane-old: no watch running');
});

test('a seat that is not the lead is refused on a dead record', async () => {
  const scene = open({ pane: 'gone', pidLive: false });
  const before = recordText(scene.dir);
  const io = testIo(scene.root, { kind: 'seat', name: 'maker', pane: 'pane-maker', session: 'acme' });
  const code = await runWatch(['--session', 'acme'], io, sources(scene, { pane: 'gone', pidLive: false }));
  expect(code, io.err + io.out).toBe(1);
  expect(io.err + io.out).not.toContain('watch record taken over');
  expect(recordText(scene.dir)).toBe(before);
  expect(readState(scene.dir).sessions.acme?.watchdog?.pane).toBe(OLD_PANE);
});
