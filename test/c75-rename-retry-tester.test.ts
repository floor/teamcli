// Independent verification of C7.5 item 10: a refused agent rename is retried inside the naming
// wait (src/launch/execute.ts). The plan is the real up plan. The host, its clock and its
// rename answers are synthetic. No live host, CLI, or process signal is invoked.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';

const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';

function seat(): UpSeat {
  return {
    name: SEAT,
    cli: 'claude-code',
    launch: 'claude --model claude-sonnet-5-5',
    cwd: '.',
    label: SEAT,
    repairLine: '',
    stopped: false,
    rules: '',
  };
}

function plan(): Step[] {
  return upPlan({
    root: '/work/acme',
    session: SESSION,
    sessionRunning: true,
    seats: [seat()],
    watchLabel: `Watch · ${SESSION}`,
    startWatch: false,
  });
}

function namingMs(): number {
  const op = plan().flatMap((step) => (step.do?.do === 'rename' ? [step.do] : []))[0];
  if (op === undefined) throw new Error('the plan has no rename step');
  return op.seconds * 1000;
}

const BUDGET_MS = namingMs();

type Recorded = { seat: string; stage: string };

function world(input: { takeAfter: number; stopOnFirstSleep?: boolean }): {
  host: Host;
  closing: () => boolean;
  trace: { renames: () => number; records: Recorded[]; said: string[]; clock: () => number };
} {
  let clock = 0;
  let renames = 0;
  let closing = false;
  const records: Recorded[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      renames += 1;
      return renames > input.takeAfter;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['claude'],
    classify: () => 'idle',
    sleep: async (ms) => {
      if (input.stopOnFirstSleep === true && !closing) closing = true;
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: (name, patch) => {
      records.push({ seat: name, stage: patch.stage });
    },
    running: () => {},
    drop: () => {},
    say: (line) => {
      said.push(line);
    },
    log: () => {},
  };
  return {
    host,
    closing: () => closing,
    trace: { renames: () => renames, records, said, clock: () => clock },
  };
}

const ready = (records: Recorded[]): string[] =>
  records.filter((record) => record.stage === 'ready').map((record) => record.seat);

test('a rename refused a few times is retried until the host takes it', async () => {
  const made = world({ takeAfter: 3 });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.trace.renames()).toBe(4);
  expect(ready(made.trace.records)).toEqual([SEAT]);
  expect(made.trace.said.join('')).not.toContain('was not named in time');
  expect(made.trace.clock()).toBeGreaterThan(0);
  expect(made.trace.clock()).toBeLessThan(BUDGET_MS);
});

test('a host that never takes the name is retried until the wait ends', async () => {
  const made = world({ takeAfter: Number.POSITIVE_INFINITY });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.trace.renames()).toBeGreaterThan(2);
  expect(ready(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('was not named in time; left at launched');
  expect(made.trace.clock()).toBe(BUDGET_MS);
});

test('a stop during the rename retry aborts before the wait runs out', async () => {
  const made = world({ takeAfter: Number.POSITIVE_INFINITY, stopOnFirstSleep: true });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.closing()).toBe(true);
  expect(ready(made.trace.records)).toEqual([]);
  expect(made.trace.renames()).toBe(3);
  expect(made.trace.clock()).toBe(250);
  expect(made.trace.clock()).toBeLessThan(BUDGET_MS);
});
