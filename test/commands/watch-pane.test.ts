import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { approvalOf } from '../../src/approve/approval.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import { runWatch, type WatchSources } from '../../src/commands/watch.ts';
import { ownWatchPane } from '../../src/watch/pane.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { setHerdrRun } from '../../src/herdr.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { writeApproval, storePath } from '../../src/store/store.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { capturedPaneEntry, capturedProcessInfo, capturedWorkspaceEntry, claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const NOW = new Date('2026-10-03T14:02:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const REMOVE_FILE = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let base: string;
let root: string;
let home: string;
let hangup: { pid: number } | null = null;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-watch-pane-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});

afterEach(() => {
  setHerdrRun(null);
  if (hangup) {
    try { process.kill(hangup.pid, 'SIGTERM'); } catch { /* already gone */ }
    hangup = null;
  }
  rmSync(base, { recursive: true, force: true });
});

describe('the watch and its pane', () => {
  test('a watch that recorded its pane ends when that pane is gone', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
    let seen = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources(3, {
      ownPane: () => (++seen === 1 ? { pane: 'w9:p1', workspace: 'w9' } : 'gone'),
    }));
    expect(code).toBe(0);
    expect(seen).toBe(3);
    expect(io.out).toContain('the watch\'s pane is gone; the watch ends with it');
    expect(io.out).toContain('the watch of "acme-web" stopped');
    expect(readState(join(root, '.agents')).sessions['acme-web']?.watch).toBeUndefined();
  });

  test('gone once, then found: keeps running', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
    let seen = 0;
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources(3, {
      ownPane: () => (++seen === 2 ? 'gone' : { pane: 'w9:p1', workspace: 'w9' }),
    }));
    expect(code).toBe(0);
    expect(seen).toBe(3);
    expect(io.out).not.toContain('pane is gone');
    expect(io.out).toContain('the watch of "acme-web" stopped');
  });

  test('a watch that never recorded a pane keeps running', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), EXAMPLE);
    const io = testIo(root, { kind: 'owner' });
    const code = await runWatch(FILE, io, watchSources(1, { ownPane: () => 'gone' }));
    expect(code).toBe(0);
    expect(io.out).not.toContain('pane is gone');
    expect(io.out).toContain('the watch of "acme-web" stopped');
  });

  test('own pane is the one whose shell is this process\'s parent', () => {
    setHerdrRun((args) => {
      if (args[0] === 'workspace' && args[1] === 'list') {
        return { workspaces: [capturedWorkspaceEntry('w9', 'Watch · acme-web'), capturedWorkspaceEntry('w1', 'seat')] };
      }
      if (args[0] === 'pane' && args[1] === 'list' && args[3] === 'w9') {
        return { panes: [capturedPaneEntry('w9:p1', 'w9')] };
      }
      if (args[0] === 'pane' && args[1] === 'list') return { panes: [capturedPaneEntry('w1:p1', 'w1')] };
      if (args[0] === 'pane' && args[1] === 'process-info' && args[3] === 'w9:p1') {
        return { process_info: capturedProcessInfo('w9:p1', process.ppid, process.pid) };
      }
      return { process_info: capturedProcessInfo('w1:p1', 1) };
    });
    expect(ownWatchPane('acme-web', process.pid)).toEqual({ pane: 'w9:p1', workspace: 'w9' });
    setHerdrRun((args) => {
      if (args[0] === 'workspace') return { workspaces: [capturedWorkspaceEntry('w1', 'seat')] };
      if (args[0] === 'pane' && args[1] === 'list') return { panes: [capturedPaneEntry('w1:p1', 'w1')] };
      return { process_info: capturedProcessInfo('w1:p1', 1) };
    });
    expect(ownWatchPane('acme-web', process.pid)).toBe('gone');
  });

  test('a hangup during the wait clears the watch record', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), REMOVE_FILE);
    const ready = join(base, 'ready');
    const outPath = join(base, 'out.json');
    const watchModule = new URL('../../src/commands/watch.ts', import.meta.url).pathname;
    const waitModule = new URL('../../src/wait.ts', import.meta.url).pathname;
    const program = `
      import { writeFileSync } from 'node:fs';
      import { runWatch } from ${JSON.stringify(watchModule)};
      import { waitOrStop } from ${JSON.stringify(waitModule)};
      const root = ${JSON.stringify(root)};
      const home = ${JSON.stringify(home)};
      const ready = ${JSON.stringify(ready)};
      const outPath = ${JSON.stringify(outPath)};
      let out = '';
      let err = '';
      const code = await runWatch(['--file', '.agents/team.yaml'], {
        stdout: (text) => { out += text; },
        stderr: (text) => { err += text; },
        cwd: root,
        env: { HOME: home },
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      }, {
        live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
        machine: () => (${JSON.stringify(fine)}),
        standing: () => ({ kind: 'none' }),
        readChecks: () => [],
        screen: () => '',
        status: () => 'idle',
        foreground: () => [],
        typeText: () => true,
        pressEnter: () => true,
        sleep: async () => {},
        notify: () => {},
        now: () => new Date(${JSON.stringify(NOW.toISOString())}),
        wait: (seconds) => {
          const pending = waitOrStop(seconds);
          writeFileSync(ready, 'ready');
          return pending;
        },
        alive: () => false,
        pid: process.pid,
        ownPane: () => ({ pane: 'w9:p1', workspace: 'w9' }),
        home,
      });
      writeFileSync(outPath, JSON.stringify({ code, out, err }));
      process.exit(code);
    `;
    const child = Bun.spawn(['bun', '-e', program], {
      cwd: root,
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    hangup = child;
    const deadline = Date.now() + 15_000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`child exited ${child.exitCode} before the wait: ${stderr}`);
      }
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('child never reached the wait');
      }
      await Bun.sleep(20);
    }
    const recorded = readState(join(root, '.agents')).sessions.acme?.watch;
    expect(recorded?.pid).toBe(child.pid);
    expect(recorded).toMatchObject({ pane: 'w9:p1', workspace: 'w9' });
    process.kill(child.pid, 'SIGHUP');
    const code = await child.exited;
    expect(code).toBe(0);
    expect(readState(join(root, '.agents')).sessions.acme?.watch).toBeUndefined();
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as { out: string };
    expect(written.out).toContain('the watch of "acme" stopped');
  });
});

describe('remove --keep', () => {
  test('closes the seat workspace and leaves the watch workspace alone', async () => {
    const dir = root;
    writeFileSync(join(dir, '.agents/team.yaml'), REMOVE_FILE);
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    const loaded = loadTeamFile(dir);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: REMOVE_FILE },
      loaded.team.seats,
      home,
    );
    const closed: string[] = [];
    let sent = false;
    let box = claudeBox('');
    let clock = NOW.getTime();
    const launch: DownLaunch = {
      typeText: (_session, _pane, text) => { box = claudeBox(text); return true; },
      sendKey: () => { box = claudeBox(''); return true; },
      pressEnter: () => { sent = true; return true; },
      agentPanes: () => ['w1:p1'],
      closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
      stopSession: () => false,
      deleteSession: () => false,
      kill: () => false,
      sleep: async (ms) => { clock += ms; },
      now: () => new Date(clock),
    };
    const sources: RemoveSources = {
      home,
      sessionRunning: () => true,
      agents: () => [{ name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => box,
      status: () => 'idle',
      now: () => new Date(clock),
      sleep: async (ms) => { clock += ms; },
      launch,
      foreground: () => (sent ? [] : ['claude']),
    };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions.acme ??= emptySession()).watch = {
        pid: process.pid, heartbeat: NOW.toISOString(), pane: 'w9:p1', workspace: 'w9',
      };
    });
    const removed = testIo(dir, { kind: 'owner' });
    const removedCode = await runRemove(['worker', '--keep', '--file', join(dir, '.agents/team.yaml')], removed, sources);
    expect({ code: removedCode, err: removed.err, out: removed.out }).toMatchObject({ code: 0 });
    expect(closed).toEqual(['w1']);
    expect(readState(join(dir, '.agents')).sessions.acme?.watch).toMatchObject({ pane: 'w9:p1', workspace: 'w9' });
  });
});

function watchSources(passes: number, over: Partial<WatchSources>): WatchSources {
  let left = passes;
  let clock = NOW.getTime();
  const file = join(root, '.agents/team.yaml');
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    machine: () => fine,
    standing: (project) => {
      const text = readFileSync(file, 'utf8');
      const parsed = validateTeamFile(text);
      return parsed.ok ? verifiedOf(parsed.team, text, project) : { kind: 'none' };
    },
    readChecks: () => [],
    screen: () => '',
    status: () => 'idle',
    foreground: () => [],
    typeText: () => true,
    pressEnter: () => true,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock),
    wait: async (seconds) => { clock += seconds * 1000; return --left > 0; },
    alive: () => false,
    pid: 4242,
    ...over,
  };
}
