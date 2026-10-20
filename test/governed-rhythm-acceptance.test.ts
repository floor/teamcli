// Acceptance: the watch-rhythm policy in force, over the actual hosted runner and the daemon's
// own fixed heartbeat. This is a new follow-up on the rhythm commit, not a rerun of the hosted
// lifecycle scenes: nothing here re-tests tick seriality, route isolation, standby or stop.
//
// 1. Governed rhythm + fixed heartbeat. A team-level signed `watch-rhythm: night@60` is written
//    into the scratch home and read back through the real policy chain. The actual daemon hosts
//    one route whose runner is the production `hostedWatchRun`, with reads standing in for herdr
//    and every mutating source closed. The explicit 60s sweep is final: the second pass is
//    released at exactly +60s, not +720s, while the preset's factor only scales the six waits.
//    The daemon heartbeat is the real fixed interval at a small test cadence; it stamps its
//    own persisted clock through the whole governed wait, and `daemonHealth` answers with that
//    root's running watch before the rhythm releases the pass. The same daemon close ends it.
// 2. An unreadable chain suppresses governed work while reading continues. The same team file
//    carries an unsigned `policies:` watch-rhythm, which makes the chain unknown. With an admitted
//    sender wired and open effects, the passes still cycle at the verified file's reading cadence
//    but call the sender zero times and mutate nothing. The control rewrites the file without the
//    unsigned declaration: the same sender is called once, on the same fixture.
// 3. Legacy normalization control. A verified file's 5s interval is clamped to the 10s sweep
//    floor, the watch cycles at 10s and the normalization line is said once.
//
// No live service, no pane action, no typing: every mutating source in the base is a recorder.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon, type MachineDaemon, type StartMachineDaemonResult } from '../src/daemon/host.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { routeOf, type HostedRoute } from '../src/daemon/routes.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { createHostedWatch, type HostedWatch } from '../src/daemon/watch.ts';
import { hostedWatchRun } from '../src/daemon/watch-run.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { emptySession, updateState } from '../src/state.ts';
import { forgetIdleEpisodes, type WorkPush, type WorkPushRequest } from '../src/watch/dispatch.ts';
import { watchInForceWithPace, watchPaceNotes, watchPaceOf, type WatchPace } from '../src/watch/rhythm.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';

const SESSION = 'acme';
const SEAT = 'deepseek-acme';
const PANE = 'first:pane';
const START = Date.parse('2026-10-20T03:00:00Z');
const THRESHOLD_MS = 300_000;
const HEARTBEAT_MS = 20;
const VERSION = '0.5.3-governed-rhythm-acceptance';

const TEAM = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
watch:
  interval: 10s
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: deepseek-acme
    label: deepseek-acme
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
`;

const QUEUE = `- id: t1
  title: first queued slice
- id: t2
  title: second queued slice
- id: t3
  title: third queued slice
`;

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

let base: string;
let root: string;
let home: string;
let clock: number;
let teamText: string;

type Spies = { typed: number; entered: number; keys: number; notified: number; paneRuns: number };

function spies(): Spies {
  return { typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 };
}

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function route(): HostedRoute {
  return routeOf(root, 'acme', SESSION, ['lead', SEAT]);
}

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:pane`, workspace, status, cwd: null };
}

function live(workerStatus = 'idle'): Live {
  const agents = [agent('lead', 'lead', 'working'), agent(SEAT, 'first', workerStatus)];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'lead:pane': IDLE, [PANE]: IDLE },
  };
}

/** The read sources a hosted pass runs over; every mutating source records the call. */
function baseSources(spy: Spies): WatchSources {
  return {
    live: () => live(),
    machine: () => fine,
    standing: () => verifiedOf(teamOf(teamText), teamText, root, new Date(clock)),
    readChecks: () => [],
    screen: () => IDLE,
    status: () => 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => {
      spy.typed += 1;
      return false;
    },
    pressEnter: () => {
      spy.entered += 1;
      return false;
    },
    sendKey: () => {
      spy.keys += 1;
      return false;
    },
    paneRun: () => {
      spy.paneRuns += 1;
      return false;
    },
    sleep: async () => {},
    notify: () => {
      spy.notified += 1;
    },
    now: () => new Date(clock),
    wait: async () => false,
    alive: () => false,
    pid: 4242,
    home,
  };
}

/** The production binding: the shared watch loop inside a host, over the recording reads. */
function runHosted(options: {
  pushWork?: WorkPush;
  effects?: 'blocked' | 'open';
  spy: Spies;
  log?: (text: string) => void;
}): HostedWatch {
  return createHostedWatch({
    route: route(),
    now: () => new Date(clock),
    run: hostedWatchRun({
      route: route(),
      log: options.log ?? (() => {}),
      base: baseSources(options.spy),
      pid: 4242,
      ...(options.pushWork !== undefined ? { pushWork: options.pushWork } : {}),
    }),
    ...(options.effects !== undefined ? { effects: options.effects } : {}),
  });
}

function pushRecorder(): { push: WorkPush; pushed: WorkPushRequest[] } {
  const pushed: WorkPushRequest[] = [];
  const push: WorkPush = async (request) => {
    pushed.push(request);
    return { ok: true, outcome: 'delivered' };
  };
  return { push, pushed };
}

function paceOf(now = new Date(clock)): WatchPace {
  const team = teamOf(teamText);
  return watchPaceOf({
    team,
    root,
    home,
    standing: verifiedOf(team, teamText, root, now),
    now,
  });
}

function persistedHeartbeat(): string | null {
  const read = readDaemonState(home);
  return read.kind === 'ok' ? read.state.heartbeatAt : null;
}

async function waitUntil(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the hosted watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets a resolved continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-governed-rhythm-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'acme\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first'], { cwd: root });
  teamText = TEAM;
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), QUEUE);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: PANE, last_active: new Date(START - THRESHOLD_MS - 5_000).toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'lead:pane', last_active: new Date(START).toISOString() };
  });
  clock = START;
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

describe('the watch-rhythm policy under the hosted runner', () => {
  test('a signed night@60 sets the pass cadence while the daemon heartbeat keeps its own', async () => {
    const wrote = writePolicySet(home, {
      level: 'team',
      target: root,
      teamRoot: root,
      name: 'watch-rhythm',
      value: 'night@60',
    }, { now: new Date(START - 86_400_000) });
    expect(wrote.ok).toBe(true);

    // The real chain resolves the signed value, and the explicit sweep is final while the
    // preset factor scales only the six waits.
    const team = teamOf(TEAM);
    const standing = verifiedOf(team, TEAM, root, new Date(START));
    const pace = watchPaceOf({ team, root, home, standing, now: new Date(START) });
    expect(pace).toMatchObject({ preset: 'night', sweepSeconds: 60, source: 'team', normalized: null });
    expect(pace.unknown).toBeUndefined();
    expect(pace.setAside).toContainEqual({ setting: 'watch.interval', declared: 10, by: 'team' });
    const inForce = watchInForceWithPace(standing, team, pace);
    expect(inForce.interval).toBe(60);
    expect(inForce.idleFirst).toBe(Math.min(86_400, Math.max(1, Math.round(team.watch.idleFirst * 12))));
    expect(inForce.nudgeWait).toBe(Math.min(86_400, Math.max(1, Math.round(team.watch.nudgeWait * 12))));

    const spy = spies();
    const lines: string[] = [];
    let started: StartMachineDaemonResult | null = null;
    let daemon: MachineDaemon | null = null;
    try {
      started = await startMachineDaemon({
        home,
        roots: [root],
        startedBy: 'manual',
        version: VERSION,
        now: () => new Date(clock),
        heartbeatMs: HEARTBEAT_MS,
        watchHosting: true,
        hostedWatch: (hostedRoute, log) => ({
          run: hostedWatchRun({
            route: hostedRoute,
            log: (text) => {
              lines.push(text);
              log(text);
            },
            base: baseSources(spy),
            pid: 4242,
          }),
        }),
      });
      expect(started.kind).toBe('serving');
      if (started.kind !== 'serving') return;
      daemon = started.daemon;

      // The first pass completes at START and the loop waits the signed 60s.
      await waitUntil(() => daemon?.roots[0]?.watch?.cycles === 1);
      expect(daemon.roots[0]?.watch).toMatchObject({ phase: 'running', cycles: 1, failures: 0 });
      expect(lines.some((line) => line.includes('every 60s'))).toBe(true);
      expect(lines.some((line) => line.includes('every 10s'))).toBe(false);

      // A clock move just short of the sweep is stamped by the real heartbeat and releases
      // nothing; a health request still answers with the root's running watch.
      clock = START + 59_999;
      const shortStamp = new Date(clock).toISOString();
      await waitUntil(() => persistedHeartbeat() === shortStamp);
      const health = await daemonHealth(home);
      expect(health.probe.state).toBe('answered');
      expect(health.state).toBe('running');
      expect(health.roots.find((entry) => entry.root === root)?.watch).toMatchObject({
        team: 'acme',
        session: SESSION,
        phase: 'running',
        cycles: 1,
        effects: 'blocked',
        required: true,
      });
      await flush();
      expect(daemon.roots[0]?.watch?.cycles).toBe(1);

      // The signed sweep releases the next pass at exactly +60s, never at its factor product.
      clock = START + 60_000;
      await waitUntil(() => daemon?.roots[0]?.watch?.cycles === 2);
      expect(daemon.roots[0]?.watch?.lastCycleAt).toBe(new Date(START + 60_000).toISOString());

      // Every mutating source stayed closed and untouched.
      expect(spy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });
    } finally {
      await daemon?.close();
    }
    expect(daemon?.roots[0]?.watch).toMatchObject({ phase: 'stopped', why: 'the daemon is closing' });
    expect(existsSync(daemonSocketPath(home))).toBe(false);
  });

  test('an unreadable chain holds the sender while the reading cadence keeps cycling', async () => {
    teamText = `${TEAM}policies:\n  watch-rhythm: dormant\n`;
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText);

    // The chain is unknown, and the fallback still names the verified file's reading cadence.
    const held = paceOf();
    expect(held.unknown).toBeDefined();
    expect(held).toMatchObject({ source: 'file', sweepSeconds: 10 });
    expect(watchPaceNotes(held)[0]).toContain('automated work, nudges and escalations are held');

    const spy = spies();
    const sent = pushRecorder();
    const host = runHosted({ pushWork: sent.push, effects: 'open', spy });
    try {
      // The pass still runs and cycles; nothing reaches the sender.
      await waitUntil(() => host.state().cycles === 1 && host.state().phase === 'running');
      await flush();
      expect(sent.pushed).toHaveLength(0);
      expect(spy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });

      clock += 10_000;
      host.tick(new Date(clock));
      await waitUntil(() => host.state().cycles === 2);
      expect(sent.pushed).toHaveLength(0);
    } finally {
      await host.stop('the scenario ends');
    }

    // Control: the same fixture with the unsigned declaration removed pushes once, so the
    // silence above is the unreadable chain and not a fixture that never had work to send.
    teamText = TEAM;
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText);
    forgetIdleEpisodes();
    const controlSpy = spies();
    const control = pushRecorder();
    const readable = runHosted({ pushWork: control.push, effects: 'open', spy: controlSpy });
    try {
      await waitUntil(() => control.pushed.length === 1);
      expect(control.pushed[0]).toMatchObject({ seat: SEAT, pane: PANE, cli: 'claude-code' });
      expect(controlSpy).toEqual({ typed: 0, entered: 0, keys: 0, notified: 0, paneRuns: 0 });
    } finally {
      await readable.stop('the scenario ends');
    }
  });

  test('a legacy 5s interval normalizes to the 10s floor and the watch sweeps there', async () => {
    teamText = TEAM.replace('interval: 10s', 'interval: 5s');
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText);

    const pace = paceOf();
    expect(pace).toMatchObject({
      preset: 'normal',
      sweepSeconds: 10,
      source: 'file',
      normalized: { field: 'watch.interval', declared: 5, used: 10 },
    });
    expect(watchPaceNotes(pace)).toEqual([
      'watch.interval 5s is below the 10s sweep floor; sweeping every 10s',
    ]);

    const spy = spies();
    const lines: string[] = [];
    const host = runHosted({ spy, log: (text) => lines.push(text) });
    try {
      await waitUntil(() => host.state().cycles === 1);
      const firstCycle = host.state().lastCycleAt;
      expect(firstCycle).toBe(new Date(START).toISOString());
      expect(lines.some((line) => line.includes('every 10s'))).toBe(true);
      expect(lines.some((line) => line.includes('every 5s'))).toBe(false);

      clock = START + 9_999;
      host.tick(new Date(clock));
      await flush();
      expect(host.state().cycles).toBe(1);

      clock = START + 10_000;
      host.tick(new Date(clock));
      await waitUntil(() => host.state().cycles === 2);
      expect(host.state().lastCycleAt).toBe(new Date(START + 10_000).toISOString());
      // Said once across both passes, not once per pass.
      expect(lines.filter((line) => line.includes('sweeping every 10s'))).toHaveLength(1);
    } finally {
      await host.stop('the scenario ends');
    }
  });
});
