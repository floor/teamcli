// The hosted watch inside a chores child, driven on the actual source: `createChoresWatch`
// builds the shared wrapper under this process (the child), so the epoch it acquires names this
// process and every direct wake the loop would send passes the shared verifier here. The daemon
// half is exercised in the isolation scenes; this file measures the child half alone — one
// scratch checkout, a quiet session, a virtual clock, and the frames the module emits.
//
// Nothing below reads or writes a real home, pane or session: the read sources answer from the
// fixture, and the process-info seam answers from those same sources before the terminal host is
// ever consulted.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WatchSources } from '../src/commands/watch.ts';
import type { ChoresChildRoute } from '../src/daemon/chores/protocol.ts';
import { createChoresWatch } from '../src/daemon/chores/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import type { HostedWatchState } from '../src/watch/hosted.ts';
import type { Machine } from '../src/watch/machine.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T06:00:00Z');
const WIN = '5.5';
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idleScreen = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const CREW = `format: 1
project: acme-web
session: crew
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
`;

let base = '';
let root = '';
let home = '';
let agents = '';
let teamFile = '';

function iso(at: number): string {
  return new Date(at).toISOString();
}

beforeEach(() => {
  forgetIdleEpisodes();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-chores-watch-')));
  root = join(base, 'repo');
  home = join(base, 'home');
  agents = join(root, '.agents');
  teamFile = join(agents, 'team.yaml');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(teamFile, CREW);
  writeFileSync(join(agents, 'queue.yaml'), '- id: t1\n  title: "First"\n');
  updateState(agents, (state) => {
    const session = (state.sessions.crew ??= emptySession());
    session.seats['worker-1'] = { stage: 'ready', last_active: iso(NOW - 10 * MIN) };
  });
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

/** The daemon's own claim, written before its first pass: the route's own team file. */
function bind(): void {
  updateState(agents, (state) => {
    (state.sessions.crew ??= emptySession()).watchdog = { file: teamFile };
  });
}

function record(): { pid?: number; heartbeat?: string; epoch?: string; pane?: string } | undefined {
  return readState(agents).sessions.crew?.watch;
}

/** The token route the daemon writes for a watched root: the validated team content for the
 *  seats, and the team file's path for the watch's own binding. */
function route(): ChoresChildRoute {
  const validated = validateTeamFile(CREW);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return {
    root,
    team: 'acme-web',
    session: 'crew',
    teamFile: validated.team,
    watch: { teamFile, presence: false },
  };
}

/** A quiet session: the terminal host answers, naming no agent and no pane. */
function quietSources(clock: { at: number }): WatchSources {
  return {
    live: () => ({ running: true, agents: [], workspaces: [], screens: {} }),
    machine: () => fine,
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => idleScreen,
    status: () => 'idle',
    foreground: () => ['claude'],
    processes: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sendKey: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => new Date(clock.at),
    wait: async () => false,
    alive: () => true,
    pid: process.pid,
    home,
    statusSource: undefined,
  };
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the child watch');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The child only reports on the daemon's beats, so a scene that needs a pass to have landed
 *  beats until the report shows it. Beating twice at one instant is an ordinary renewal. */
async function beatUntil(
  watch: { beat(root: string, at: Date, presence: null): void },
  clock: { at: number },
  check: () => boolean,
  ms = 3000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    watch.beat(root, new Date(clock.at), null);
    if (check()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the child watch');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the chores child\'s hosted watch', () => {
  test('runs the shared loop as this process, reports every beat and releases its epoch on stop', async () => {
    bind();
    const clock = { at: NOW };
    const reports: { root: string; state: HostedWatchState }[] = [];
    const logs: string[] = [];
    const watch = createChoresWatch({
      routes: [route()],
      log: (text) => logs.push(text),
      report: (one, state) => reports.push({ root: one, state }),
      pulse: () => {},
      faultResult: () => {},
      now: () => new Date(clock.at),
      base: quietSources(clock),
    });
    try {
      // The creation reports the route's own first state before any beat arrives.
      expect(reports[0]?.root).toBe(root);
      expect(reports[0]?.state).toMatchObject({ root, team: 'acme-web', session: 'crew', required: true });
      // The run starts at once; the epoch it captures names this process, so the shared verifier
      // in this process will admit its effects.
      await waitUntil(() => record()?.pid === process.pid);
      expect(typeof record()?.epoch).toBe('string');
      // The pass lands before the first beat; the beat that follows reports it.
      await beatUntil(watch, clock, () => (reports.at(-1)?.state.cycles ?? 0) >= 1);
      expect(reports.at(-1)?.state).toMatchObject({ phase: 'running', cycles: 1, failures: 0, lastCycleOutcome: 'pass' });

      // A beat renews the captured record on this child's own clock and reports the state again.
      clock.at = NOW + 120_000;
      const before = reports.length;
      watch.beat(root, new Date(clock.at), null);
      expect(reports.length).toBe(before + 1);
      expect(reports.at(-1)?.state).toMatchObject({ root, phase: 'running' });
      expect(record()?.heartbeat).toBe(iso(clock.at));

      // A beat this child cannot use is logged, never applied to another route's watch.
      watch.beat(join(base, 'elsewhere'), new Date(clock.at), null);
      watch.beat(root, new Date(Number.NaN), null);
      expect(reports.at(-1)?.state.root).toBe(root);
      expect(logs.some((line) => line.includes('no valid instant'))).toBe(true);
    } finally {
      await watch.stop('the test is done');
    }
    // The run left at its own seam and the record it held is gone.
    expect(record()).toBeUndefined();
  }, 15_000);

  test('a fault ends the run at its seam and answers the writer once, with the state recorded', async () => {
    bind();
    const clock = { at: NOW };
    const reports: HostedWatchState[] = [];
    const results: { root: string; outcome: string; why: string }[] = [];
    const watch = createChoresWatch({
      routes: [route()],
      log: () => {},
      report: (_root, state) => reports.push(state),
      pulse: () => {},
      faultResult: (one, outcome, why) => results.push({ root: one, outcome, why }),
      now: () => new Date(clock.at),
      base: quietSources(clock),
    });
    try {
      // Acquired and in flight before the fault: the diagnostic ends a run, never invents one.
      await waitUntil(() => record()?.pid === process.pid);
      watch.fault(root, 'the test faults the run');
      await waitUntil(() => results.length === 1);
      expect(results[0]).toEqual({ root, outcome: 'left', why: 'the test faults the run' });
      // The failed record crosses the pipe before the answer: a reader that acts on the answer
      // already sees the state it names.
      expect(reports.at(-1)).toMatchObject({
        root,
        phase: 'failed',
        failures: 1,
        lastCycleOutcome: 'failed',
        why: 'the test faults the run',
      });

      // A root this child does not host is refused, and a host already leaving answers once.
      watch.fault(join(base, 'elsewhere'), 'nowhere');
      expect(results.at(-1)).toMatchObject({ outcome: 'refused', why: 'this child hosts no watch for the root' });
    } finally {
      await watch.stop('the test is done');
    }
  }, 15_000);

  test('emits pulse during a pass and cycle when a pass completes', async () => {
    bind();
    const clock = { at: NOW };
    const pulses: { root: string; at: string }[] = [];
    const cycles: { root: string; at: string }[] = [];
    const watch = createChoresWatch({
      routes: [route()],
      log: () => {},
      report: () => {},
      pulse: (one, at) => pulses.push({ root: one, at: at.toISOString() }),
      cycle: (one, at) => cycles.push({ root: one, at: at.toISOString() }),
      faultResult: () => {},
      now: () => new Date(clock.at),
      base: quietSources(clock),
    } as Parameters<typeof createChoresWatch>[0]);
    try {
      await waitUntil(() => cycles.length >= 1);
      expect(pulses.length).toBeGreaterThan(0);
      expect(pulses[0]).toEqual({ root, at: iso(NOW) });
      expect(cycles).toEqual([{ root, at: iso(NOW) }]);
    } finally {
      await watch.stop('the test is done');
    }
  }, 15_000);
});
