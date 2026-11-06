// The naming scenes the design asks for: the create step names nothing, the rename step names once
// and proves the name from the host's agent list, a list that never shows the name leaves the seat
// at launched with one reported line, a pane another seat owns is never renamed, and an adopted
// pane whose rename is not listed is not recorded ready. Pane ids, names, processes and the clock
// are synthetic; no live host, CLI or pane is read.
import { expect, test } from 'bun:test';
import { executePlan, type Host } from '../src/launch/execute.ts';
import { upPlan, type Step, type UpSeat } from '../src/launch/plan.ts';

const SESSION = 'naming-scene';
const SEAT = 'alpha';
const OTHER_SEAT = 'beta';
const PANE = 'fixture-pane-one';
const WORKSPACE = 'fixture-workspace';
const SHELL = 7001;
const CLI = 7002;

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

function upSteps(): Step[] {
  return upPlan({
    root: '/work/acme',
    session: SESSION,
    sessionRunning: true,
    seats: [seat()],
    watchLabel: `Watch · ${SESSION}`,
    startWatch: false,
  });
}

/** Scene E's plan: one adopt step, as `team up` builds it for a pane the host restored without
 *  its name. The record proves a conversation-less pane running the declared CLI. */
function adoptSteps(): Step[] {
  return [{
    kind: 'run',
    argv: [],
    do: {
      do: 'adopt',
      seat: SEAT,
      cli: 'claude-code',
      pane: PANE,
      workspace: WORKSPACE,
      launched: { shell: SHELL, cli: [7003] },
      recordedLaunched: { shell: SHELL, cli: [CLI] },
    },
  }];
}

type Recorded = { seat: string; stage: string };
type Event = { kind: 'record'; stage: string } | { kind: 'rename' } | { kind: 'list' };

/** A host whose agent list is its only name, over a clock its waits advance. `nameOf` decides
 *  what the list shows at each reading, given whether a rename has been taken yet. */
function world(input: {
  nameOf?: (state: { taken: boolean; renames: number }) => string | null;
  refusals?: number;
  process?: { shell: number; foreground: number[] } | null;
} = {}): {
  host: Host;
  trace: { renames: () => number; records: Recorded[]; events: Event[]; said: string[]; clock: () => number };
} {
  let clock = 0;
  let renames = 0;
  let taken = false;
  const records: Recorded[] = [];
  const events: Event[] = [];
  const said: string[] = [];
  const nameOf = input.nameOf ?? ((state: { taken: boolean }) => (state.taken ? SEAT : null));

  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WORKSPACE }),
    paneRun: () => true,
    typeLine: async () => false,
    renameAgent: () => {
      events.push({ kind: 'rename' });
      renames += 1;
      taken = renames > (input.refusals ?? 0);
      return taken;
    },
    agentList: () => {
      events.push({ kind: 'list' });
      return [{
        name: nameOf({ taken, renames }),
        agent: 'claude',
        pane: PANE,
        workspace: WORKSPACE,
        status: 'idle',
        cwd: '/work/acme',
      }];
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    foreground: () => ['claude'],
    processInfo: () => input.process ?? null,
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
  return { host, trace: { renames: () => renames, records, events, said, clock: () => clock } };
}

const readySeats = (records: Recorded[]): string[] =>
  records.filter((record) => record.stage === 'ready').map((record) => record.seat);

test('A: a rename the host takes but never lists leaves the seat at launched, said once', async () => {
  const made = world({ nameOf: () => null });
  await executePlan(upSteps(), SESSION, made.host);

  expect(made.trace.renames()).toBe(2);
  expect(made.trace.records.some((record) => record.stage === 'named')).toBe(false);
  expect(readySeats(made.trace.records)).toEqual([]);
  const said = made.trace.said.filter((line) => line.includes('its name was not listed after the rename; left at launched'));
  expect(said).toHaveLength(1);
});

test('C: the create step names nothing; the rename step names once and reads the list back', async () => {
  const made = world();
  await executePlan(upSteps(), SESSION, made.host);

  expect(made.trace.renames()).toBe(1);
  const events = made.trace.events;
  const renameAt = events.findIndex((event) => event.kind === 'rename');
  const launchedAt = events.findIndex((event) => event.kind === 'record' && event.stage === 'launched');
  expect(launchedAt).toBeGreaterThanOrEqual(0);
  expect(renameAt).toBeGreaterThan(launchedAt);
  expect(events.slice(renameAt + 1).some((event) => event.kind === 'list')).toBe(true);
  expect(readySeats(made.trace.records)).toEqual([SEAT]);
});

test('D: a pane the list already names for another seat is never renamed', async () => {
  const made = world({ nameOf: () => OTHER_SEAT });
  await executePlan(upSteps(), SESSION, made.host);

  expect(made.trace.renames()).toBe(0);
  expect(readySeats(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
});

test('D: a rename the list answers with another name stops at that seat, after one call', async () => {
  const made = world({ nameOf: (state) => (state.taken ? OTHER_SEAT : null) });
  await executePlan(upSteps(), SESSION, made.host);

  // The first call was taken but the list answered another name: the step never calls again, and
  // the seat is left out naming the seat the pane belongs to.
  expect(made.trace.renames()).toBe(1);
  expect(readySeats(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane is named for another seat; left at launched');
});

test('E: an adopted pane whose rename is not listed is not recorded ready', async () => {
  const made = world({
    nameOf: () => null,
    process: { shell: SHELL, foreground: [7003] },
  });
  await executePlan(adoptSteps(), SESSION, made.host);

  expect(made.trace.renames()).toBe(1);
  expect(readySeats(made.trace.records)).toEqual([]);
  expect(made.trace.said.join('')).toContain('its pane was not named; left as the host restored it');
});
