import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import type { WatchSources } from '../../src/commands/watch.ts';
import { blocksLaunch, processComm, runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { createHostedWatch } from '../../src/daemon/watch.ts';
import { hostedWatchRun } from '../../src/daemon/watch-run.ts';
import { routeOf } from '../../src/daemon/routes.ts';
import { setHerdrRun, type HerdrAgent } from '../../src/herdr.ts';
import { approvalStanding } from '../../src/store/store.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { forgetIdleEpisodes } from '../../src/watch/dispatch.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { watchLabel } from '../../src/watch/pane.ts';
import { CLAUDE_IDLE, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const NOW = new Date('2026-10-03T14:02:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const IDLE = CLAUDE_IDLE;

let base: string;
let root: string;
let home: string;
let sleeper: ChildProcess | null = null;

function makeExample(basePath: string, rootPath: string): string {
  return EXAMPLE.replace('parked: true', 'stopped: true').replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-pane-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  sleeper = null;
});

afterEach(() => {
  setHerdrRun(null);
  if (sleeper && sleeper.exitCode === null) sleeper.kill();
  sleeper = null;
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

function startSleep(): number {
  sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
  const pid = sleeper.pid;
  if (!pid) throw new Error('sleep did not start');
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('doctor names a watch whose pane is gone', () => {
  test('stop the process, then team up gives it a pane', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
    const approved = testIo(root, { kind: 'owner' });
    expect(await runApprove(FILE, approved, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home })).toBe(0);

    const pid = startSleep();
    const name = processComm(pid);
    expect(name).toBe('sleep');
    const line = `the watch's pane is gone and ${name} (pid ${pid}) is still running: stop it, then run \`team up\``;
    expect(blocksLaunch({ level: 'miss', text: line })).toBe(false);

    const record = () => {
      updateState(join(root, '.agents'), (state) => {
        const session = (state.sessions['acme-web'] ??= emptySession());
        session.watch = { pid, heartbeat: NOW.toISOString(), pane: 'synthetic-ws-9:p1', workspace: 'synthetic-ws-9' };
        session.seats = {
          'claude-coordinator-acme': { stage: 'ready', pane: 'synthetic-ws-1:p1', workspace: 'synthetic-ws-1' },
          'deepseek-acme': { stage: 'ready', pane: 'synthetic-ws-2:p1', workspace: 'synthetic-ws-2' },
          'deepseek-acme-2': { stage: 'ready', pane: 'synthetic-ws-3:p1', workspace: 'synthetic-ws-3' },
        };
      });
    };
    record();
    const running = testIo(root, { kind: 'owner' });
    await runDoctor(FILE, running, doctorSources(pid));
    expect(running.out, running.err).toContain(`MISS  ${line}\n`);
    expect(running.out).not.toContain('ok    the watch is running');

    const held = world();
    const whileAlive = testIo(root, { kind: 'owner' });
    const heldCode = await runUp(FILE, whileAlive, upSources(held, () => true));
    expect({ code: heldCode, err: whileAlive.err, out: whileAlive.out }).toMatchObject({ code: 0 });
    expect(held.creates).not.toContain(watchLabel('acme-web'));

    const stopped = sleeper;
    const exited = new Promise((resolve) => stopped?.once('exit', resolve));
    stopped?.kill();
    await exited;
    sleeper = null;
    record();
    const ended = testIo(root, { kind: 'owner' });
    await runDoctor(FILE, ended, doctorSources(pid));
    expect(ended.out, ended.err).toContain('MISS  the watch ended with its pane: run `team up`\n');
    expect(ended.out).not.toContain('still running');

    const repaired = world();
    const after = testIo(root, { kind: 'owner' });
    const afterCode = await runUp(FILE, after, upSources(repaired, () => false));
    expect({ code: afterCode, err: after.err, out: after.out }).toMatchObject({ code: 0 });
    // Daemon-only watch: `up` plans no watch pane of its own — the daemon hosts the watch.
    expect(repaired.creates).not.toContain(watchLabel('acme-web'));
    expect(after.err).not.toContain('watch: started');

    // The hosted watch is the repair: it takes over the dead pane record — no pane started,
    // the record dropped, the takeover named in the team log — and its passes run.
    forgetIdleEpisodes();
    const hostedAt = new Date(NOW.getTime() + 10 * 60_000); // the planted heartbeat is stale
    const route = routeOf(root, 'acme-web', 'acme-web', ['claude-coordinator-acme', 'codex-acme', 'deepseek-acme', 'grok-acme']);
    const log: string[] = [];
    const watchSources: WatchSources = {
      live: () => ({ running: true, agents: agents(), workspaces: READY.map(([, , id]) => ({ id, label: id })), screens: {} }),
      machine: () => fine,
      standing: (asked) => approvalStanding(asked, home),
      readChecks: () => [],
      screen: () => IDLE,
      status: () => 'idle',
      foreground: () => ['claude'],
      paneVerdict: () => 'gone',
      typeText: () => true,
      pressEnter: () => true,
      sleep: async () => {},
      notify: () => {},
      now: () => hostedAt,
      wait: async () => false,
      alive: () => false,
      pid: 4242,
      home,
    };
    const host = createHostedWatch({
      route,
      now: () => hostedAt,
      effects: 'open',
      run: hostedWatchRun({ route, log: (text) => log.push(text), base: watchSources, pid: 4242 }),
    });
    // A hosted watch has no timer of its own: the pass ends at a heartbeat tick.
    const deadline = Date.now() + 3000;
    let beats = 0;
    while (host.state().cycles < 1) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the hosted watch: ${JSON.stringify(host.state())}`);
      beats += 1;
      host.tick(new Date(hostedAt.getTime() + beats * 130_000));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(host.state().phase).toBe('running');
    expect(host.state().cycles).toBeGreaterThanOrEqual(1);
    expect(readState(join(root, '.agents')).sessions['acme-web']?.watch).toBeUndefined();
    const teamLog = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(teamLog).toContain('pane watch synthetic-ws-9:p1 not alive: gone; the daemon\'s watch is active\n');
    expect(log.some((line) => line.includes('watching the session "acme-web"'))).toBe(true);
    await host.stop('the daemon is closing');
    expect(host.state()).toMatchObject({ phase: 'stopped' });
  });
});

function doctorSources(pid: number): DoctorSources {
  return {
    version: () => '2.1.288 (Claude Code)',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
    watchAlive: (asked) => asked === pid && alive(pid),
    processComm,
    watchPane: () => false,
  };
}

const READY = [
  ['claude-coordinator-acme', 'synthetic-ws-1:p1', 'synthetic-ws-1'],
  ['deepseek-acme', 'synthetic-ws-2:p1', 'synthetic-ws-2'],
  ['deepseek-acme-2', 'synthetic-ws-3:p1', 'synthetic-ws-3'],
] as const;

function agents(): HerdrAgent[] {
  return READY.map(([name, pane, workspace]) => ({
    name, agent: 'claude', pane, workspace, status: 'idle', cwd: null,
  }));
}

function world(): { launch: Launch; creates: string[] } {
  const made = { launch: {} as Launch, creates: [] as string[] };
  let n = 10;
  let clock = NOW.getTime();
  made.launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      n += 1;
      made.creates.push(label);
      return { pane: `synthetic-ws-${n}:p1`, workspace: `synthetic-ws-${n}` };
    },
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents,
    workspacePanes: (_session, workspace) => [`${workspace}:p1`],
    paneText: () => IDLE,
    foreground: () => ['claude'],
    sleep: async (ms) => { clock += ms; },
    now: () => new Date(clock),
  };
  return made;
}

function upSources(made: ReturnType<typeof world>, watchAlive: () => boolean): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents,
    workspaces: () => READY.map(([, , id]) => ({ id, label: id })),
    home,
    now: () => NOW,
    sleep: made.launch.sleep,
    launch: made.launch,
    alive: () => watchAlive(),
    machine: () => fine,
    doctor: {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
    },
  };
}
