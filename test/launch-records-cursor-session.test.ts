// The launch records the conversation herdr reports for a Cursor seat.
//
// Herdr names a live agent by kind, and Cursor's kind is `cursor` while the process it runs is
// `cursor-agent` (measured 2026-11-05 on herdr 0.7.1 against a live Grok 4.7 seat: the pane's
// `agent` read `cursor`, and its `agent_session` carried `source: "herdr:cursor"`). The launch's
// attribution guard compared that kind with the profile's process names alone, so it discarded
// every session herdr reported for a Cursor seat: the seat's state and registry record never
// named the conversation the pane runs, and after a host restore nothing tied the live pane to
// the launch — `team status` could only read it as `restored, not launched by team`.
//
// The scene is the plan `executePlan` really runs, on a synthetic pane, process reading and
// agent list: no live herdr, no CLI and no pane id from this machine. The second scene keeps the
// guard honest: a reading herdr attributes to another CLI is still never this seat's session.
import { expect, test } from 'bun:test';
import type { HerdrAgent } from '../src/herdr.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';

const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const LINE = 'cursor-agent --model grok-4.7-high --force --sandbox disabled';
const LIVE_SESSION = 'fixture-session-grok';
const SHELL = 710;
const CLI = 910;
// The ready frame a Cursor pane draws: the input row, the composer's status row, the workspace.
const IDLE_SCREEN = `  → Plan, search, build anything\n  Grok 4.7 256K High                 Run Everything\n  ~/fixture\n`;

type World = {
  agent: string | null;
  session: string | undefined;
};

function sceneOf(world: World) {
  let clock = 0;
  const records: { seat: string; patch: Parameters<Host['record']>[1] }[] = [];
  const finals: string[] = [];
  const listed = (): HerdrAgent => ({
    name: SEAT,
    agent: world.agent,
    pane: PANE,
    workspace: SPACE,
    status: 'idle',
    cwd: null,
    ...(world.session === undefined ? {} : { session: world.session }),
  });
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: () => true,
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => [listed()],
    workspacePanes: () => [PANE],
    processInfo: () => ({ shell: SHELL, foreground: [CLI] }),
    classify: (): ScreenKind => 'idle',
    paneText: () => IDLE_SCREEN,
    foreground: () => ['cursor-agent'],
    shellBack: () => false,
    agentStatus: () => null,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: (seat, patch) => {
      records.push({ seat, patch });
    },
    running: () => {},
    drop: () => {},
    say: (line) => {
      finals.push(line);
    },
    final: (seat, record) => {
      finals.push(`${seat}: ${record.kind}`);
    },
    log: () => {},
  };
  return { host, records, finals };
}

/** A Cursor seat's launch: the line runs in a new pane, then the idle wait and the naming. */
function launchSteps(): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch',
        seat: SEAT,
        label: SEAT,
        command: LINE,
        pane: PANE,
        workspace: SPACE,
        cli: 'cursor',
        cwd: '.',
      },
    },
    {
      kind: 'wait',
      text: 'until the seat shows its idle prompt',
      do: {
        do: 'idle',
        seat: SEAT,
        label: SEAT,
        cli: 'cursor',
        seconds: 90,
        command: LINE,
        pane: PANE,
        workspace: SPACE,
        repairLine: 'team remove worker',
      },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'rename', seat: SEAT, label: SEAT, cli: 'cursor', seconds: 90, rules: 'option', pane: PANE },
    },
  ];
}

const sessionsRecorded = (records: { patch: { agent_session?: string } }[]): (string | undefined)[] =>
  records.map((entry) => entry.patch.agent_session).filter((id) => id !== undefined);

test("a Cursor seat's launch records the session herdr reports for it", async () => {
  const scene = sceneOf({ agent: 'cursor', session: LIVE_SESSION });
  await executePlan(launchSteps(), SESSION, scene.host);
  // The idle record and the named record both carry it: the state keeps the conversation beside
  // the process identity, and a restore can then tie the pane to the seat.
  expect(scene.records.some((entry) => entry.patch.stage === 'launched')).toBe(true);
  expect(scene.records.some((entry) => entry.patch.stage === 'named')).toBe(true);
  const recorded = sessionsRecorded(scene.records);
  expect(recorded.length).toBeGreaterThanOrEqual(2);
  expect([...new Set(recorded)]).toEqual([LIVE_SESSION]);
  expect(scene.records.find((entry) => entry.patch.stage === 'named')?.patch.agent_session).toBe(LIVE_SESSION);
  expect(scene.finals).toContain(`${SEAT}: ready`);
});

test("a reading herdr attributes to another CLI is never this seat's session", async () => {
  const scene = sceneOf({ agent: 'codex', session: 'fixture-session-other' });
  await executePlan(launchSteps(), SESSION, scene.host);
  expect(sessionsRecorded(scene.records)).toEqual([]);
});
