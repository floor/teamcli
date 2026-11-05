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
const OTHER_SEAT = 'fixture-other-seat';

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

function world(input: {
  takeAfter: number;
  stopOnFirstSleep?: boolean;
  agents?: { name: string; pane: string }[];
}): {
  host: Host;
  closing: () => boolean;
  trace: {
    renames: () => number;
    renamesAt: () => number[];
    records: Recorded[];
    said: string[];
    clock: () => number;
  };
} {
  let clock = 0;
  let renames = 0;
  let closing = false;
  const renamesAt: number[] = [];
  const records: Recorded[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      renamesAt.push(clock);
      renames += 1;
      return renames > input.takeAfter;
    },
    ...(input.agents === undefined
      ? {}
      : {
          agentList: () => input.agents!.map((agent) => ({
            name: agent.name,
            agent: 'claude',
            pane: agent.pane,
            workspace: SPACE,
            status: 'idle',
            cwd: '/work/acme',
          })),
        }),
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
    trace: { renames: () => renames, renamesAt: () => [...renamesAt], records, said, clock: () => clock },
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

test('the retry waits before it asks again, so the next call is not on the same tick', async () => {
  const made = world({ takeAfter: 3 });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  const at = made.trace.renamesAt();
  const refused = at[1];
  const retried = at[2];
  if (refused === undefined || retried === undefined) throw new Error('the retry never called the host');
  expect(retried - refused).toBeGreaterThan(0);
  expect(made.trace.clock()).toBeLessThanOrEqual(BUDGET_MS);
});

test('a pane named for another seat is never renamed', async () => {
  const made = world({
    takeAfter: 0,
    agents: [{ name: OTHER_SEAT, pane: PANE }],
  });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.trace.renames()).toBe(0);
  expect(ready(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
  expect(made.trace.clock()).toBeLessThanOrEqual(BUDGET_MS);
});

test('a stop during the rename retry keeps the stage the create recorded', async () => {
  const made = world({ takeAfter: Number.POSITIVE_INFINITY, stopOnFirstSleep: true });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.closing()).toBe(true);
  expect(made.trace.records.length).toBeGreaterThan(0);
  expect(made.trace.records.every((record) => record.stage === 'launched')).toBe(true);
  expect(made.trace.said.join('')).not.toContain('was not named in time');
  expect(made.trace.renames()).toBe(2);
  expect(made.trace.clock()).toBe(250);
  expect(made.trace.clock()).toBeLessThan(BUDGET_MS);
});
