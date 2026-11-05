// C7.5 item 10: the agent rename is retried inside the naming wait.
//
// The terminal host refuses a rename while the agent's startup is still pending, and only takes
// one for a pane it currently lists as an agent. So the pane's foreground process can name the
// CLI — the wait is over — before the host will take the name, and one refused call must not end
// the seat. The retry keeps the same wait's budget, on a short backoff, and reports it only when
// the wait itself runs out. A pane the host names for another seat is never renamed, and a host
// that starts closing drops the naming without dropping the seat.
//
// Every pane, workspace, process reading and clock here is a synthetic fixture: no live terminal
// host, CLI or pane is read.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';

const SESSION = 'rename-scene';
const SEAT = 'alpha';
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

/** The budget the plan itself gives the naming wait, read from its own rename step: the retry
 *  spends this and never more, whatever the profile's idle timeout is set to. */
function namingSeconds(): number {
  const op = plan().flatMap((step) => (step.do?.do === 'rename' ? [step.do] : []))[0];
  if (op === undefined) throw new Error('the plan has no rename op to measure');
  return op.seconds;
}

const WAIT_SECONDS = namingSeconds();

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
  /** What the host lists as its agents; the naming guard reads it before every rename. */
  agents?: ListedAgent[];
  /** Flip the host's closing flag once this many rename calls have been refused. */
  closeOnRefusal?: number;
};

/** A host that refuses the first `refusals` rename calls and takes every one after. The create
 *  step makes the first call, so a refusal there is part of the same startup the retry covers. */
function world(refusals: number, opts: WorldOptions = {}): {
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
  const renamesAt: number[] = [];
  const records: Recorded[] = [];
  const said: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      renamesAt.push(clock);
      renames += 1;
      const took = renames > refusals;
      if (!took && opts.closeOnRefusal !== undefined && renames >= opts.closeOnRefusal) closing = true;
      return took;
    },
    ...(opts.agents === undefined ? {} : { agentList: () => opts.agents ?? null }),
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    // The CLI is the pane's foreground process: the idle wait is over as soon as it is read.
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

test('a rename refused while the agent starts is retried until the host takes it', async () => {
  const made = world(3);
  await executePlan(plan(), SESSION, made.host);

  // The create step's call, the naming wait's first call and one retry were refused; a later
  // retry took the name. The retry waited between attempts rather than spinning.
  expect(made.trace.renames()).toBeGreaterThanOrEqual(4);
  expect(made.trace.records.filter((record) => record.stage === 'ready').map((record) => record.seat)).toEqual([SEAT]);
  expect(made.trace.said.join('')).not.toContain('was not named in time');
  // And it landed inside the plan's own naming wait, not after it.
  expect(made.trace.clock()).toBeGreaterThan(0);
  expect(made.trace.clock()).toBeLessThan(WAIT_SECONDS * 1000);
});

test('a host that never takes the name is retried until the wait ends, and says so', async () => {
  const made = world(Number.POSITIVE_INFINITY);
  await executePlan(plan(), SESSION, made.host);

  // More than the create call and one naming attempt: the retry kept trying to the end.
  expect(made.trace.renames()).toBeGreaterThan(2);
  expect(made.trace.said.join('')).toContain('was not named in time; left at launched');
  expect(made.trace.clock()).toBeLessThanOrEqual(WAIT_SECONDS * 1000);
});

test('the retry after a refusal waits for its backoff instead of calling again at once', async () => {
  const made = world(3);
  await executePlan(plan(), SESSION, made.host);

  const at = made.trace.renamesAt();
  // at[0] is the create call, at[1] the naming wait's first call; the retry that follows that
  // refusal must come after a pause, never on the same tick.
  const firstNaming = at[1];
  const firstRetry = at[2];
  if (firstNaming === undefined || firstRetry === undefined) throw new Error('the retry never called the host');
  expect(firstRetry - firstNaming).toBeGreaterThan(0);
});

test('a pane the host names for another seat is never renamed', async () => {
  const made = world(0, {
    agents: [{ name: 'beta', agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: '/work/acme', session: SESSION }],
  });
  await executePlan(plan(), SESSION, made.host);

  // Not at create and not after the wait: the pane is another seat's, and a rename would take it.
  expect(made.trace.renames()).toBe(0);
  expect(made.trace.records.filter((record) => record.stage === 'ready')).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
});

test('a stop while the rename is retried aborts instead of reporting the seat unnamed', async () => {
  const made = world(Number.POSITIVE_INFINITY, { closeOnRefusal: 2 });
  await executePlan(plan(), SESSION, made.host, { isClosing: () => made.trace.isClosing() });

  // The host started closing on the first refused naming call: the naming ends as a cancelled
  // wait, exactly as a stop during the first wait does, and the seat keeps the stage it had
  // (the create's). It is never reported as a seat that ran out of naming time.
  expect(made.trace.said.join('')).not.toContain('was not named in time');
  expect(made.trace.said.join('')).not.toContain('left at launched');
  // The seat never leaves the stage the create recorded.
  expect(made.trace.records.length).toBeGreaterThan(0);
  expect(made.trace.records.every((record) => record.stage === 'launched')).toBe(true);
});
