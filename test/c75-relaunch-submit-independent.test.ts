// C7.5 acceptance flake, item 7's own-line relaunch: after the launch line is handed to a
// restored pane, its shell can leave the typed line unread for seconds (the tty's echo sits on
// the screen) and an Enter the host sent can be lost, leaving the line at the prompt with the
// shell in front. These scenes drive a relaunch's launch and idle steps over a synthetic pane:
// the wait must confirm the line was submitted, give a line that still sits at its prompt one
// more Enter under the typed-wake guard, and judge the end of the launch from the pane's
// foreground rather than an echo budget.
//
// All terminal readings, screens and clocks are synthetic; no live terminal host, CLI or
// process signal is invoked.
import { describe, expect, test } from 'bun:test';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { recordText } from '../src/launch/progress.ts';

const LINE = "claude --model claude-opus-5-5 'Read /x/rules/team.md (sha256 1f2e3d4c5b6a): your standing rules; reply ready.'";
const PANE = 'pane-restored';
const WS = 'ws-restored';
const SHELL = 700;
const CLI = 900;
const PROMPT = '~ ❯';
const IDLE_SCREEN = 'stand-in is up\n❯\n';

/** The line's echo as a wrapped launch line draws it: the head on the prompt row, the tail on
 *  the row below, exactly the way a 4 KB line fills the screen while the shell has not read it.
 *  The pane echoes the command it was actually handed, session id and all, not the plan's line. */
const wrappedEcho = (command: string): string => `${PROMPT} ${command.slice(0, 60)}\n${command.slice(60)}\n`;
const unsentEcho = (command: string): string => `${PROMPT} ${command}\n`;

type World = {
  /** What the pane shows right now; null is an unreadable pane. */
  screen: () => string | null;
  classify: () => ScreenKind;
  foreground: () => string[] | null;
  shellBack: () => boolean | null;
  /** What `pane run` does — by default it only puts the line on the screen as typed. It is
   *  handed the command the host really typed, session id and all. */
  run?: (command: string) => void;
  /** What a second Enter does; its presence puts `pressEnter` on the host. */
  press?: () => boolean;
};

function sceneOf(world: World) {
  const start = 1_000;
  let clock = start;
  const presses: number[] = [];
  const finals: string[] = [];
  const logs: string[] = [];
  const host: Host = {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: PANE, workspace: WS }),
    paneRun: (_session, _pane, command) => {
      world.run?.(command);
      return true;
    },
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => [],
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
    log: (_who, what) => {
      logs.push(what);
    },
  };
  return { host, presses, finals, logs, start, at: () => clock };
}

/** Item 7's relaunch: a launch in the recorded pane with its restored identity, the idle wait,
 *  then the rename that ends the seat at ready. */
function stepsOf(seconds = 90): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch', seat: 'worker', label: 'worker', command: LINE, pane: PANE,
        workspace: WS, reuse: { shell: SHELL, cli: [CLI] }, cli: 'claude-code', cwd: '/x/acme',
      },
    },
    {
      kind: 'wait',
      text: 'until worker shows its idle prompt',
      do: {
        do: 'idle', seat: 'worker', label: 'worker', cli: 'claude-code', seconds,
        command: LINE, pane: PANE, workspace: WS,
        repairLine: '`team remove worker --keep` then `team add worker`',
      },
    },
    {
      kind: 'run',
      argv: [],
      do: { do: 'rename', seat: 'worker', label: 'worker', cli: 'claude-code', seconds, rules: 'option', pane: PANE },
    },
  ];
}

describe('a relaunch whose Enters do not land is not left silently at launched', () => {
  test('a dropped first Enter is pressed again once the line has sat past the unread window, and the seat reaches ready', async () => {
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
      screen: () => (running ? IDLE_SCREEN : typed !== null ? wrappedEcho(typed) : `${PROMPT}\n`),
      classify: () => (running ? 'idle' : 'unknown'),
      foreground: () => (running ? ['claude'] : ['fixture-shell']),
      shellBack: () => !running,
    });
    await executePlan(stepsOf(), 'acme', scene.host);
    expect(scene.presses).toHaveLength(1);
    // The unread echo was captured at 8.9 s to 10.3 s; the second Enter goes after that
    // window, not at once and not after the old 24 s echo budget.
    expect(scene.presses[0]! - scene.start).toBeGreaterThanOrEqual(10_000);
    expect(scene.presses[0]! - scene.start).toBeLessThanOrEqual(20_000);
    expect(scene.finals.join('\n')).toContain('worker: ready');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
    expect(scene.logs.some((line) => line.includes('pressed Enter again'))).toBe(true);
  });

  test('a second Enter that does not land either is pressed exactly once, and the wait times out instead of saying the CLI ended', async () => {
    let typed: string | null = null;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      screen: () => (typed !== null ? unsentEcho(typed) : `${PROMPT}\n`),
      classify: () => 'unknown',
      foreground: () => ['fixture-shell'],
      shellBack: () => true,
    });
    await executePlan(stepsOf(), 'acme', scene.host);
    expect(scene.presses).toHaveLength(1);
    const said = scene.finals.join('\n');
    expect(said).toContain('worker: left out: timeout');
    expect(said).not.toContain('shows no CLI prompt');
    // The deadline is the report: the line never left the prompt.
    expect(scene.at() - scene.start).toBeGreaterThanOrEqual(90_000);
  });
});

describe('the end of a relaunch is judged by the foreground, not a fixed echo budget', () => {
  test('a launch line that ran and left the shell is reported ended once the foreground says so', async () => {
    let typed: string | null = null;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      screen: () => (typed !== null ? `${PROMPT} ${typed}\nzsh: command not found: claude\n${PROMPT}\n` : `${PROMPT}\n`),
      classify: () => 'unknown',
      foreground: () => ['fixture-shell'],
      shellBack: () => true,
    });
    await executePlan(stepsOf(), 'acme', scene.host);
    const said = scene.finals.join('\n');
    expect(said).toContain('worker: left out: its pane has been back at its shell for');
    expect(said).toContain('shows no CLI prompt; left at launched');
    // The old verdict waited out 24 s of echo before saying this; the foreground read is the
    // evidence, so the report comes as soon as the shell has held the pane after the line ran.
    expect(scene.at() - scene.start).toBeLessThan(12_000);
    // A line that left its prompt is submitted: no Enter is typed into the shell for it.
    expect(scene.presses).toEqual([]);
  });

  test('a slow shell that reads the line inside the unread window is waited out with no second Enter', async () => {
    let typed: string | null = null;
    let polls = 0;
    const started = (): boolean => polls > 5;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      screen: () => (started() ? IDLE_SCREEN : typed !== null ? wrappedEcho(typed) : `${PROMPT}\n`),
      classify: () => {
        polls += 1;
        return started() ? 'idle' : 'unknown';
      },
      foreground: () => (started() ? ['claude'] : ['fixture-shell']),
      shellBack: () => !started(),
    });
    await executePlan(stepsOf(), 'acme', scene.host);
    expect(scene.presses).toEqual([]);
    expect(scene.finals.join('\n')).toContain('worker: ready');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
  });

  test('a line whose echo cannot be found is never given an Enter, and the wait times out', async () => {
    // A pane read that shows no echo of the launch line is a box that cannot be read: pressing
    // Enter into it would be typing blind.
    const scene = sceneOf({
      run: () => {},
      press: () => true,
      screen: () => 'restarted\n~ ❯\n',
      classify: () => 'unknown',
      foreground: () => ['fixture-shell'],
      shellBack: () => true,
    });
    await executePlan(stepsOf(20), 'acme', scene.host);
    expect(scene.presses).toEqual([]);
    expect(scene.finals.join('\n')).toContain('worker: left out: timeout');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
  });

  test('a line that sits while a process is in front of the pane gets no Enter, and the wait times out', async () => {
    // The guard is the shell itself: the launch line is only pressed again while the pane's own
    // shell is what is in front of it.
    let typed: string | null = null;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      screen: () => (typed !== null ? unsentEcho(typed) : `${PROMPT}\n`),
      classify: () => 'unknown',
      foreground: () => ['fixture-shell'],
      shellBack: () => false,
    });
    await executePlan(stepsOf(20), 'acme', scene.host);
    expect(scene.presses).toEqual([]);
    expect(scene.finals.join('\n')).toContain('worker: left out: timeout');
  });
});
