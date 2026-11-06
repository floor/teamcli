// Independent verification of the naming step after the create-step rename was removed: the
// create step names nothing, the rename step names once and reads the host's agent list back,
// and one refused call earns one retry after herdr has detected the pane. A host that says yes
// while its list stays bare has not named the seat: it is left at launched with the reason said
// once. A pane the host lists for another seat is never renamed, and a stop keeps the stage the
// create recorded. The plan is the real up plan; the host, its clock and its answers are
// synthetic. No live host, CLI, or process signal is invoked.
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

type Recorded = { seat: string; stage: string };
type Event = { kind: 'record'; stage: string } | { kind: 'rename' } | { kind: 'list' };

type WorldOptions = {
  refusals?: number;
  nameStaysUnlisted?: boolean;
  listedAt?: number;
  namedForOther?: boolean;
  closeOnRefusal?: number;
};

function world(opts: WorldOptions = {}): {
  host: Host;
  closing: () => boolean;
  trace: {
    renames: () => number;
    renamesAt: () => number[];
    records: Recorded[];
    events: Event[];
    said: string[];
    clock: () => number;
  };
} {
  let clock = 0;
  let renames = 0;
  let closing = false;
  let name: string | null = opts.namedForOther === true ? OTHER_SEAT : null;
  const renamesAt: number[] = [];
  const records: Recorded[] = [];
  const events: Event[] = [];
  const said: string[] = [];

  const listed = (): boolean => clock >= (opts.listedAt ?? 0);

  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      events.push({ kind: 'rename' });
      renamesAt.push(clock);
      renames += 1;
      if (opts.namedForOther === true) return true;
      const took = renames > (opts.refusals ?? 0);
      if (!took && opts.closeOnRefusal !== undefined && renames >= opts.closeOnRefusal) closing = true;
      if (took && opts.nameStaysUnlisted !== true) name = SEAT;
      return took;
    },
    agentList: () => {
      events.push({ kind: 'list' });
      return listed()
        ? [{
            name,
            agent: 'claude',
            pane: PANE,
            workspace: SPACE,
            status: 'idle',
            cwd: '/work/acme',
          }]
        : [];
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => (listed() ? [PANE] : []),
    foreground: () => ['claude'],
    classify: () => 'idle',
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: (name, patch) => {
      records.push({ seat: name, stage: patch.stage });
      events.push({ kind: 'record', stage: patch.stage });
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
    trace: { renames: () => renames, renamesAt: () => [...renamesAt], records, events, said, clock: () => clock },
  };
}

const readySeats = (records: Recorded[]): string[] =>
  records.filter((record) => record.stage === 'ready').map((record) => record.seat);

test('the create step names nothing; the rename step names once and reads the list back', async () => {
  const made = world();
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  // One call, and it comes after the create's launched record: nothing tried to name the bare
  // pane at create. The list is read again after the call, which is where the name is proved.
  expect(made.trace.renames()).toBe(1);
  const events = made.trace.events;
  const renameAt = events.findIndex((event) => event.kind === 'rename');
  const launchedAt = events.findIndex((event) => event.kind === 'record' && event.stage === 'launched');
  expect(launchedAt).toBeGreaterThanOrEqual(0);
  expect(renameAt).toBeGreaterThan(launchedAt);
  expect(events.slice(renameAt + 1).some((event) => event.kind === 'list')).toBe(true);
  expect(readySeats(made.trace.records)).toEqual([SEAT]);
});

test('a refused first call is retried once after detection, and the listed name is ready', async () => {
  const made = world({ refusals: 1, listedAt: 400 });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  // The outer wait ends on the foreground CLI; the retry waits for the list to show the pane,
  // then asks once more. The retry is not asked on the same tick as the refusal.
  expect(made.trace.renames()).toBe(2);
  const at = made.trace.renamesAt();
  const first = at[0];
  const retry = at[1];
  if (first === undefined || retry === undefined) throw new Error('the retry never called the host');
  expect(retry - first).toBeGreaterThanOrEqual(400);
  expect(readySeats(made.trace.records)).toEqual([SEAT]);
});

test('a host that never lists the name is asked exactly twice and the seat is left at launched', async () => {
  const made = world({ nameStaysUnlisted: true });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.trace.renames()).toBe(2);
  expect(readySeats(made.trace.records)).toEqual([]);
  expect(made.trace.records.some((record) => record.stage === 'named')).toBe(false);
  const said = made.trace.said.filter((line) => line.includes('its name was not listed after the rename; left at launched'));
  expect(said).toHaveLength(1);
});

test('a pane named for another seat is never renamed', async () => {
  const made = world({ namedForOther: true });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  expect(made.trace.renames()).toBe(0);
  expect(readySeats(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
});

test('a stop during the naming wait keeps the stage the create recorded', async () => {
  const made = world({ refusals: Number.POSITIVE_INFINITY, closeOnRefusal: 1 });
  await executePlan(plan(), SESSION, made.host, { isClosing: made.closing });

  // The host started closing on the first refused call: the naming ends as a cancelled wait and
  // the seat keeps the stage it had. It is never reported as a seat that ran out of naming time.
  expect(made.closing()).toBe(true);
  expect(made.trace.records.length).toBeGreaterThan(0);
  expect(made.trace.records.every((record) => record.stage === 'launched')).toBe(true);
  expect(made.trace.said.join('')).not.toContain('left at launched');
});
