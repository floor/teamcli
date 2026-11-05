// Independent verification of the flake-fix on the same-pane relaunch wait
// (src/launch/execute.ts). The own-line path is the real relaunch step followed by a plain
// launch in the recorded pane, then the idle wait. The pane, its screen, its foreground and
// the clock are synthetic. No live host, CLI, or process signal is invoked.
import { expect, test } from 'bun:test';
import type { HerdrAgent } from '../src/herdr.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { recordText } from '../src/launch/progress.ts';

const LINE = 'claude --model claude-sonnet-5-5 fixture-launch-line';
const LONG = `claude --model claude-sonnet-5-5 ${'fixture-standing-rule '.repeat(16)}reply-ready`;
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const TALK = 'fixture-session';
const PROMPT = '~ >';
const IDLE_SCREEN = 'fixture stand-in is up\n>\n';
const OLD_SHELL = 700;
const OLD_CLI = 900;
const NEW_SHELL = 710;
const NEW_CLI = 910;

/** A wrap whose last row holds fewer than the 24 characters the tail check reads, and whose
 *  middle row is wider than the pane excerpt. The tail spans those two rows. */
const splitEcho = (command: string): string =>
  `${PROMPT} ${command.slice(0, 40)}\n${command.slice(40, -10)}\n${command.slice(-10)}\n`;

type Phase = 'cli' | 'shell' | 'typed' | 'running';

type World = {
  screen: () => string | null;
  classify: () => ScreenKind;
  foreground: () => string[] | null;
  shellBack: () => boolean | null;
  agents?: () => HerdrAgent[] | null;
  process?: () => { shell: number; foreground: number[] };
  type?: () => boolean;
  run?: (command: string) => void;
  press?: () => boolean;
};

function sceneOf(world: World) {
  let clock = 0;
  const presses: number[] = [];
  const finals: string[] = [];
  const logs: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: (_session, _pane, command) => {
      world.run?.(command);
      return true;
    },
    typeLine: () => false,
    ...(world.type === undefined ? {} : { typeText: () => world.type!() }),
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => world.agents?.() ?? [],
    workspacePanes: () => [PANE],
    processInfo: () => world.process?.() ?? ({ shell: NEW_SHELL, foreground: [NEW_SHELL] }),
    classify: () => world.classify(),
    paneText: () => world.screen(),
    foreground: () => world.foreground(),
    shellBack: () => world.shellBack(),
    agentStatus: () => null,
    ...(world.press === undefined ? {} : {
      pressEnter: () => {
        presses.push(clock);
        return world.press!();
      },
    }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: (line) => {
      finals.push(line);
    },
    final: (seat, record) => {
      finals.push(recordText(seat, record));
    },
    log: (_seat, line) => {
      logs.push(line);
    },
  };
  return { host, presses, finals, logs, at: () => clock };
}

function idleAndRename(command: string, seconds: number): Step[] {
  return [
    {
      kind: 'wait',
      text: 'until the seat shows its idle prompt',
      do: {
        do: 'idle',
        seat: SEAT,
        label: SEAT,
        cli: 'claude-code',
        seconds,
        command,
        pane: PANE,
        workspace: SPACE,
        repairLine: 'team remove worker',
      },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'rename', seat: SEAT, label: SEAT, cli: 'claude-code', seconds, rules: 'option', pane: PANE },
    },
  ];
}

/** The own-line relaunch: exit the restored CLI, then launch in that pane with no reuse flag. */
function ownLineSteps(): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'relaunch',
        seat: SEAT,
        cli: 'claude-code',
        pane: PANE,
        workspace: SPACE,
        launched: { shell: OLD_SHELL, cli: [OLD_CLI] },
        session: TALK,
      },
    },
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
        cli: 'claude-code',
        cwd: '.',
      },
    },
    ...idleAndRename(LINE, 90),
  ];
}

function reuseSteps(command: string): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch',
        seat: SEAT,
        label: SEAT,
        command,
        pane: PANE,
        workspace: SPACE,
        reuse: { shell: NEW_SHELL, cli: [NEW_CLI] },
        cli: 'claude-code',
        cwd: '.',
      },
    },
    ...idleAndRename(command, 90),
  ];
}

const said = (finals: string[]): string => finals.join('\n');

const listed = (phase: Phase): HerdrAgent => phase === 'cli' || phase === 'running'
  ? {
      name: phase === 'running' ? SEAT : null,
      agent: 'claude',
      pane: PANE,
      workspace: SPACE,
      status: 'idle',
      cwd: null,
      session: TALK,
    }
  : { name: null, agent: null, pane: PANE, workspace: SPACE, status: 'unknown', cwd: null };

test('an own-line relaunch whose first Enter never lands is pressed once more at 12 s and reaches ready', async () => {
  let phase: Phase = 'cli';
  let typed: string | null = null;
  const scene = sceneOf({
    type: () => true,
    run: (command) => {
      typed = command;
      phase = 'typed';
    },
    press: () => {
      phase = phase === 'cli' ? 'shell' : 'running';
      return true;
    },
    agents: () => [listed(phase)],
    process: () => (phase === 'cli' || phase === 'running'
      ? { shell: NEW_SHELL, foreground: [NEW_CLI] }
      : { shell: NEW_SHELL, foreground: [NEW_SHELL] }),
    screen: () => {
      if (phase === 'cli') return '>\n';
      if (phase === 'shell') return `${PROMPT}\n`;
      if (phase === 'typed') return typed !== null ? `${PROMPT} ${typed}\n` : `${PROMPT}\n`;
      return IDLE_SCREEN;
    },
    classify: () => (phase === 'cli' || phase === 'running' ? 'idle' : 'unknown'),
    foreground: () => (phase === 'cli' || phase === 'running' ? ['claude'] : ['fixture-shell']),
    shellBack: () => phase === 'shell' || phase === 'typed',
  });
  await executePlan(ownLineSteps(), SESSION, scene.host);
  expect(scene.presses).toEqual([0, 12_000]);
  expect(scene.logs.some((line) => line.includes('pressed Enter again'))).toBe(true);
  expect(said(scene.finals)).toContain(`${SEAT}: ready`);
  expect(said(scene.finals)).not.toContain('shows no CLI prompt');
});

test('a long line whose wrap splits the tail across two rows is still read as sitting, and pressed once', async () => {
  let typed: string | null = null;
  let running = false;
  const scene = sceneOf({
    run: (command) => {
      typed = command;
    },
    press: () => {
      running = true;
      return true;
    },
    screen: () => (running ? IDLE_SCREEN : typed !== null ? splitEcho(typed) : `${PROMPT}\n`),
    classify: () => (running ? 'idle' : 'unknown'),
    foreground: () => (running ? ['claude'] : ['fixture-shell']),
    shellBack: () => !running,
  });
  await executePlan(reuseSteps(LONG), SESSION, scene.host);
  expect(scene.presses).toEqual([12_000]);
  expect(said(scene.finals)).toContain(`${SEAT}: ready`);
  expect(said(scene.finals)).not.toContain('shows no CLI prompt');
  expect(LONG.slice(40, -10).length).toBeGreaterThan(200);
  expect(LONG.slice(-10).length).toBeLessThan(24);
});
