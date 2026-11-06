// Independent verification of the same-pane relaunch submit wait (src/launch/execute.ts).
// The launch and idle steps are the real ones. The pane, its screen, its foreground and the
// clock are synthetic. No live host, CLI, or process signal is invoked.
import { expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { recordText } from '../src/launch/progress.ts';

const LINE = 'claude --model claude-sonnet-5-5 fixture-launch-line';
const SESSION = 'acme';
const SEAT = 'worker';
const PANE = 'fixture-pane-one';
const SPACE = 'fixture-space';
const SHELL = 700;
const CLI = 900;
const PROMPT = '~ >';
const IDLE_SCREEN = 'fixture stand-in is up\n>\n';

const atPrompt = (command: string): string => `${PROMPT} ${command}\n`;

type World = {
  screen: () => string | null;
  classify: () => ScreenKind;
  foreground: () => string[] | null;
  shellBack: () => boolean | null;
  run?: (command: string) => void;
  press?: () => boolean;
};

function sceneOf(world: World) {
  let clock = 0;
  // A host that takes a rename lists the pane under the seat's name afterwards, as herdr does;
  // the naming step proves that listed name before the seat can reach ready.
  let named = false;
  const presses: number[] = [];
  const finals: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: SPACE }),
    paneRun: (_session, _pane, command) => {
      world.run?.(command);
      return true;
    },
    typeLine: () => false,
    renameAgent: () => {
      named = true;
      return true;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => (named
      ? [{ name: SEAT, agent: 'claude', pane: PANE, workspace: SPACE, status: 'idle', cwd: null }]
      : []),
    workspacePanes: () => [PANE],
    processInfo: () => ({ shell: SHELL, foreground: [SHELL] }),
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
    log: () => {},
  };
  return { host, presses, finals, at: () => clock };
}

function stepsOf(seconds: number, reuse: boolean): Step[] {
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
        cli: 'claude-code',
        cwd: '.',
        ...(reuse ? { reuse: { shell: SHELL, cli: [CLI] } } : {}),
      },
    },
    {
      kind: 'wait',
      text: 'until the seat shows its idle prompt',
      do: {
        do: 'idle',
        seat: SEAT,
        label: SEAT,
        cli: 'claude-code',
        seconds,
        command: LINE,
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

const said = (finals: string[]): string => finals.join('\n');

test('a dropped first Enter is pressed once more at 12 s and the seat reaches ready', async () => {
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
    screen: () => (running ? IDLE_SCREEN : typed !== null ? atPrompt(typed) : `${PROMPT}\n`),
    classify: () => (running ? 'idle' : 'unknown'),
    foreground: () => (running ? ['claude'] : ['fixture-shell']),
    shellBack: () => !running,
  });
  await executePlan(stepsOf(90, true), SESSION, scene.host);
  expect(scene.presses).toEqual([12_000]);
  expect(said(scene.finals)).toContain(`${SEAT}: ready`);
  expect(said(scene.finals)).not.toContain('shows no CLI prompt');
});

test('a slow shell that executes at 10 s gets no extra Enter', async () => {
  let typed: string | null = null;
  let clock = 0;
  const scene = sceneOf({
    run: (command) => {
      typed = command;
    },
    press: () => true,
    screen: () => (clock >= 10_000 ? IDLE_SCREEN : typed !== null ? atPrompt(typed) : `${PROMPT}\n`),
    classify: () => (clock >= 10_000 ? 'idle' : 'unknown'),
    foreground: () => (clock >= 10_000 ? ['claude'] : ['fixture-shell']),
    shellBack: () => clock < 10_000,
  });
  const host = scene.host;
  const sleep = host.sleep.bind(host);
  host.sleep = async (ms) => {
    await sleep(ms);
    clock = scene.at();
  };
  await executePlan(stepsOf(90, true), SESSION, host);
  expect(scene.presses).toEqual([]);
  expect(said(scene.finals)).toContain(`${SEAT}: ready`);
  expect(scene.at()).toBe(10_000);
});

test('a pane whose echo was never seen gets no key', async () => {
  const scene = sceneOf({
    run: () => {},
    press: () => true,
    screen: () => 'restarted\n~ >\n',
    classify: () => 'unknown',
    foreground: () => ['fixture-shell'],
    shellBack: () => true,
  });
  await executePlan(stepsOf(20, true), SESSION, scene.host);
  expect(scene.presses).toEqual([]);
  expect(said(scene.finals)).toContain(`${SEAT}: left out: timeout`);
  expect(scene.at()).toBe(20_000);
});

test('an unreadable pane gets no key', async () => {
  const scene = sceneOf({
    run: () => {},
    press: () => true,
    screen: () => null,
    classify: () => 'unknown',
    foreground: () => ['fixture-shell'],
    shellBack: () => true,
  });
  await executePlan(stepsOf(20, true), SESSION, scene.host);
  expect(scene.presses).toEqual([]);
  expect(said(scene.finals)).toContain(`${SEAT}: left out: timeout`);
  expect(scene.at()).toBe(20_000);
});

test('a live CLI in front of the pane gets no key', async () => {
  let typed: string | null = null;
  const scene = sceneOf({
    run: (command) => {
      typed = command;
    },
    press: () => true,
    screen: () => (typed !== null ? atPrompt(typed) : `${PROMPT}\n`),
    classify: () => 'unknown',
    foreground: () => ['claude'],
    shellBack: () => false,
  });
  await executePlan(stepsOf(20, true), SESSION, scene.host);
  expect(scene.presses).toEqual([]);
  expect(said(scene.finals)).toContain(`${SEAT}: left out: timeout`);
});

test('a fresh launch keeps the echo budget and types no extra Enter', async () => {
  const scene = sceneOf({
    press: () => true,
    screen: () => `${PROMPT} ${LINE}\nfixture-shell: the line was read\n`,
    classify: () => 'unknown',
    foreground: () => ['fixture-shell'],
    shellBack: () => true,
  });
  await executePlan(stepsOf(90, false), SESSION, scene.host);
  expect(scene.presses).toEqual([]);
  expect(said(scene.finals)).toContain('its pane has been back at its shell for');
  expect(said(scene.finals)).toContain('shows no CLI prompt; left at launched');
  expect(scene.at()).toBe(24_000);
});
