// The naming step's contract: one rename call, one retry, and each answer read back from the
// host's agent list. Herdr refuses a rename while a managed launch is pending, and a pane the
// list does not show under the seat's name is not named — a call that says it worked but leaves
// no listed name ends at launched with the reason reported, never at ready. The retry waits for
// herdr to detect the pane as an agent first. A pane the host has begun naming for another seat
// is never renamed, and a host that starts closing keeps the stage the seat had.
//
// Every pane, workspace, process reading and clock here is a synthetic fixture: no live terminal
// host, CLI or pane is read.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';

const SESSION = 'rename-scene';
const SEAT = 'alpha';
const OTHER_SEAT = 'beta';
const PANE = 'pane-fresh';
const WORKSPACE = 'workspace-fresh';

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

type Recorded = { seat: string; stage: string };

/** One agent as the host lists it. */
type ListedAgent = {
  name: string | null;
  agent: string;
  pane: string;
  workspace: string;
  status: string;
  cwd: string;
  session: string;
};

type WorldOptions = {
  /** Refuse this many rename calls before the host takes one. */
  refusals?: number;
  /** A taken rename never puts the name in the host's list: the host says yes, the list stays bare. */
  nameStaysUnlisted?: boolean;
  /** The pane joins the agent list at this clock reading; before it, detection is pending. */
  listedAt?: number;
  /** The host lists the pane under another seat's name from the start. */
  namedForOther?: boolean;
  /** Flip the host's closing flag when this many rename calls have been refused. */
  closeOnRefusal?: number;
};

/** A host whose agent list is the only readable name, over a clock the waits advance. */
function world(opts: WorldOptions = {}): {
  host: Host;
  trace: {
    renames: () => number;
    renamesAt: () => number[];
    records: Recorded[];
    said: string[];
    clock: () => number;
    isClosing: () => boolean;
  };
} {
  let clock = 0;
  let renames = 0;
  let closing = false;
  let name: string | null = opts.namedForOther === true ? OTHER_SEAT : null;
  const renamesAt: number[] = [];
  const records: Recorded[] = [];
  const said: string[] = [];

  const listed = (): boolean => clock >= (opts.listedAt ?? 0);
  const entry = (): ListedAgent => ({
    name,
    agent: 'claude',
    pane: PANE,
    workspace: WORKSPACE,
    status: 'idle',
    cwd: '/work/acme',
    session: SESSION,
  });

  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      renamesAt.push(clock);
      renames += 1;
      if (opts.namedForOther === true) return true;
      const took = renames > (opts.refusals ?? 0);
      if (!took && opts.closeOnRefusal !== undefined && renames >= opts.closeOnRefusal) closing = true;
      if (took && opts.nameStaysUnlisted !== true) name = SEAT;
      return took;
    },
    // The pane is listed with no name once detection has run; before it, the list has no pane.
    agentList: () => (listed() ? [entry()] : []),
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => (listed() ? [PANE] : []),
    // The CLI is the pane's foreground process: the outer detection wait is over as soon as it is
    // read, whatever the agent list says. The retry's own detection wait reads the list alone.
    foreground: () => ['claude'],
    classify: () => 'idle',
    sleep: async (ms) => {
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
    trace: {
      renames: () => renames,
      renamesAt: () => [...renamesAt],
      records,
      said,
      clock: () => clock,
      isClosing: () => closing,
    },
  };
}

const stages = (trace: { records: Recorded[] }): string[] => trace.records.map((record) => record.stage);

test('a refused rename is retried once, and the listed name makes the seat ready', async () => {
  const made = world({ refusals: 1 });
  await executePlan(plan(), SESSION, made.host);

  // The first call is refused and the retry is taken: two calls, no more. The name is in the
  // host's list after the retry, so the seat records named and ready.
  expect(made.trace.renames()).toBe(2);
  expect(stages(made.trace).includes('named')).toBe(true);
  expect(made.trace.records.filter((record) => record.stage === 'ready').map((record) => record.seat)).toEqual([SEAT]);
  expect(made.trace.said.join('')).not.toContain('was not listed after the rename');
});

test('a rename the host accepts but never lists is left at launched, with one reported line', async () => {
  const made = world({ nameStaysUnlisted: true });
  await executePlan(plan(), SESSION, made.host);

  // Both answers said yes; neither left the name in the host's list. That is not a name, so the
  // seat keeps the stage the create recorded and says why exactly once.
  expect(made.trace.renames()).toBe(2);
  expect(stages(made.trace).includes('named')).toBe(false);
  expect(stages(made.trace)).not.toContain('ready');
  expect(stages(made.trace).every((stage) => stage === 'launched')).toBe(true);
  const said = made.trace.said.filter((line) => line.includes('its name was not listed after the rename; left at launched'));
  expect(said).toHaveLength(1);
});

test('the retry waits for the host to detect the pane before it asks again', async () => {
  const made = world({ refusals: 1, listedAt: 1000 });
  await executePlan(plan(), SESSION, made.host);

  const at = made.trace.renamesAt();
  const first = at[0];
  const retry = at[1];
  if (first === undefined || retry === undefined) throw new Error('the retry never called the host');
  // The outer wait ends on the pane's foreground process; the retry's wait reads the list, which
  // only lists the pane once detection has run. The retry is not asked before that.
  expect(retry - first).toBeGreaterThanOrEqual(1000);
  expect(made.trace.records.filter((record) => record.stage === 'ready').map((record) => record.seat)).toEqual([SEAT]);
});

test('a pane the host names for another seat is never renamed', async () => {
  const made = world({ namedForOther: true });
  await executePlan(plan(), SESSION, made.host);

  // Not one call: the pane is another seat's, and a rename would take it.
  expect(made.trace.renames()).toBe(0);
  expect(stages(made.trace)).not.toContain('named');
  expect(made.trace.records.filter((record) => record.stage === 'ready')).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
});

test('a stop while the naming waits aborts instead of reporting the seat unnamed', async () => {
  const made = world({ refusals: Number.POSITIVE_INFINITY, closeOnRefusal: 1 });
  await executePlan(plan(), SESSION, made.host, { isClosing: () => made.trace.isClosing() });

  // The host started closing on the first refused call: the naming ends as a cancelled wait,
  // exactly as a stop during the first wait does, and the seat keeps the stage it had. It is
  // never reported as a seat that ran out of naming time.
  expect(made.trace.isClosing()).toBe(true);
  expect(made.trace.said.join('')).not.toContain('was not listed after the rename');
  expect(made.trace.said.join('')).not.toContain('left at launched');
  expect(made.trace.records.length).toBeGreaterThan(0);
  expect(stages(made.trace).every((stage) => stage === 'launched')).toBe(true);
});
