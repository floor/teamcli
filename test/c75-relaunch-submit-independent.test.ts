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
import type { HerdrAgent } from '../src/herdr.ts';
import { executePlan, type Host, type ScreenKind } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { recordText } from '../src/launch/progress.ts';

const LINE = "claude --model claude-opus-5-5 'Read /x/rules/team.md (sha256 1f2e3d4c5b6a): your standing rules; reply ready.'";
const LONG_LINE = `claude --model claude-opus-5-5 'Read /x/rules/team.md: ${'standing rules; '.repeat(18)}reply ready.'`;
const PANE = 'pane-restored';
const WS = 'ws-restored';
const SHELL = 700;
const CLI = 900;
const PROMPT = '~ ❯';
const IDLE_SCREEN = 'stand-in is up\n❯\n';
const OLD_SHELL = 410;
const OLD_CLI = 411;
const NEW_SHELL = 420;
const NEW_CLI = 421;
const SES = 'ses_c75relaunch';

/** The line's echo as a wrapped launch line draws it: the head on the prompt row, the tail on
 *  the row below, exactly the way a 4 KB line fills the screen while the shell has not read it.
 *  The pane echoes the command it was actually handed, session id and all, not the plan's line. */
const wrappedEcho = (command: string): string => `${PROMPT} ${command.slice(0, 60)}\n${command.slice(60)}\n`;
const unsentEcho = (command: string): string => `${PROMPT} ${command}\n`;
/** A wrap whose last row holds fewer than the 24 characters the tail check reads: the line's
 *  tail spans the last two rows, as a 4 KB line's own wrap often does. */
const shortTailEcho = (command: string): string =>
  `${PROMPT} ${command.slice(0, 40)}\n${command.slice(40, -10)}\n${command.slice(-10)}\n`;

type World = {
  /** What the pane shows right now; null is an unreadable pane. */
  screen: () => string | null;
  classify: () => ScreenKind;
  foreground: () => string[] | null;
  shellBack: () => boolean | null;
  /** Herdr's agent list; an empty session unless the scene needs a name on the pane. */
  agents?: () => HerdrAgent[] | null;
  /** The pane's process reading; its own bare shell unless the scene says otherwise. */
  process?: () => { shell: number; foreground: number[] };
  /** Types the bare CLI's exit word; false when the scene refuses it. */
  type?: () => boolean;
  /** What `pane run` does — by default it only puts the line on the screen as typed. It is
   *  handed the command the host really typed, session id and all. */
  run?: (command: string) => void;
  /** What a press does; its presence puts `pressEnter` on the host. */
  press?: () => boolean;
};

function sceneOf(world: World) {
  const start = 1_000;
  let clock = start;
  // A host that takes a rename lists the pane under the seat's name afterwards, as herdr does;
  // the naming step proves that listed name before the seat can reach ready.
  let named = false;
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
    renameAgent: () => {
      named = true;
      return true;
    },
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [PANE],
    agentList: () => world.agents?.() ?? (named
      ? [{ name: 'worker', agent: 'claude', pane: PANE, workspace: WS, status: 'idle', cwd: null }]
      : []),
    workspacePanes: () => [PANE],
    processInfo: () => world.process?.() ?? ({ shell: SHELL, foreground: [SHELL] }),
    classify: () => world.classify(),
    paneText: () => world.screen(),
    foreground: () => world.foreground(),
    shellBack: () => world.shellBack(),
    agentStatus: () => null,
    ...(world.type === undefined ? {} : { typeText: () => world.type!() }),
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

/** Item 2's relaunch: a launch in the recorded pane with its restored identity, the idle wait,
 *  then the rename that ends the seat at ready. */
function stepsOf(seconds = 90, command = LINE): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch', seat: 'worker', label: 'worker', command, pane: PANE,
        workspace: WS, reuse: { shell: SHELL, cli: [CLI] }, cli: 'claude-code', cwd: '/x/acme',
      },
    },
    {
      kind: 'wait',
      text: 'until worker shows its idle prompt',
      do: {
        do: 'idle', seat: 'worker', label: 'worker', cli: 'claude-code', seconds,
        command, pane: PANE, workspace: WS,
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

/** Item 7's own-line (and item 11's endpoint) relaunch: the exit is typed into the restored
 *  bare CLI in its recorded pane, the launch step after it runs the seat's line there with no
 *  `reuse` flag, then the idle wait and the rename. */
function relaunchSteps(seconds = 90): Step[] {
  return [
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'relaunch', seat: 'worker', cli: 'claude-code', pane: PANE, workspace: WS,
        launched: { shell: OLD_SHELL, cli: [OLD_CLI] }, session: SES,
      },
    },
    {
      kind: 'run',
      argv: [],
      do: {
        do: 'launch', seat: 'worker', label: 'worker', command: LINE, pane: PANE,
        workspace: WS, cli: 'claude-code', cwd: '/x/acme',
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

describe('an own-line relaunch launches in the same pane, so its wait reads it that way', () => {
  test('the exit, the launch line and a dropped first Enter: the seat still reaches ready', async () => {
    // The full item 7 path: the restored bare CLI is exited in its recorded pane, the launch
    // step after it runs the seat's own line there with no `reuse` flag, and the idle wait
    // that follows must give the unsubmitted line its one more Enter — not wait out an echo
    // budget and call the CLI ended.
    type Phase = 'cli' | 'bare' | 'typed' | 'running';
    let phase: Phase = 'cli';
    let typed: string | null = null;
    const scene = sceneOf({
      type: () => true,
      run: (command) => {
        typed = command;
        phase = 'typed';
      },
      press: () => {
        phase = phase === 'cli' ? 'bare' : 'running';
        return true;
      },
      agents: () => (phase === 'cli'
        ? [{ name: null, agent: 'claude', pane: PANE, workspace: WS, status: 'idle', cwd: null, session: SES }]
        : phase === 'running'
          ? [{ name: 'worker', agent: 'claude', pane: PANE, workspace: WS, status: 'idle', cwd: null, session: SES }]
          : [{ name: null, agent: null, pane: PANE, workspace: WS, status: 'unknown', cwd: null }]),
      process: () => (phase === 'cli' || phase === 'running'
        ? { shell: NEW_SHELL, foreground: [NEW_CLI] }
        : { shell: NEW_SHELL, foreground: [NEW_SHELL] }),
      screen: () => {
        if (phase === 'cli') return '❯\n';
        if (phase === 'bare') return `${PROMPT}\n`;
        if (phase === 'typed') return typed !== null ? wrappedEcho(typed) : `${PROMPT}\n`;
        return IDLE_SCREEN;
      },
      classify: () => (phase === 'running' || phase === 'cli' ? 'idle' : 'unknown'),
      foreground: () => (phase === 'cli' || phase === 'running' ? ['claude'] : ['zsh']),
      shellBack: () => phase === 'bare' || phase === 'typed',
    });
    await executePlan(relaunchSteps(), 'acme', scene.host);
    // The exit's own Enter comes first, in the relaunch step; the second is the wait's.
    expect(scene.presses).toHaveLength(2);
    expect(scene.presses[1]! - scene.start).toBeGreaterThanOrEqual(10_000);
    expect(scene.presses[1]! - scene.start).toBeLessThanOrEqual(20_000);
    expect(scene.finals.join('\n')).toContain('worker: ready');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
    expect(scene.logs.some((line) => line.includes('pressed Enter again'))).toBe(true);
  });
});

describe('a wrapped echo is read from its rows, not from one truncated row', () => {
  test('a last row holding fewer than the tail characters still reads as sitting at the prompt', async () => {
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
      screen: () => (running ? IDLE_SCREEN : typed !== null ? shortTailEcho(typed) : `${PROMPT}\n`),
      classify: () => (running ? 'idle' : 'unknown'),
      foreground: () => (running ? ['claude'] : ['zsh']),
      shellBack: () => !running,
    });
    await executePlan(stepsOf(), 'acme', scene.host);
    expect(scene.presses).toHaveLength(1);
    expect(scene.presses[0]! - scene.start).toBeGreaterThanOrEqual(10_000);
    expect(scene.finals.join('\n')).toContain('worker: ready');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
  });

  test('a row wider than the 200-character pane excerpt is read whole by the wait', async () => {
    // The last row of this wrap is wider than `plainPaneText`'s excerpt, which appends an
    // ellipsis and cuts the line's tail off: the wait's own reading must not be that excerpt.
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
      foreground: () => (running ? ['claude'] : ['zsh']),
      shellBack: () => !running,
    });
    await executePlan(stepsOf(60, LONG_LINE), 'acme', scene.host);
    expect(scene.presses).toHaveLength(1);
    expect(scene.finals.join('\n')).toContain('worker: ready');
    expect(scene.finals.join('\n')).not.toContain('shows no CLI prompt');
  });
});

describe('the extra Enter is guarded by the pane, not only by the box', () => {
  test('a pane named for another seat is never typed into', async () => {
    let typed: string | null = null;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      agents: () => (typed === null
        ? []
        : [{ name: 'intruder', agent: 'claude', pane: PANE, workspace: WS, status: 'idle', cwd: null }]),
      screen: () => (typed !== null ? wrappedEcho(typed) : `${PROMPT}\n`),
      classify: () => 'unknown',
      foreground: () => ['zsh'],
      shellBack: () => true,
    });
    await executePlan(stepsOf(20), 'acme', scene.host);
    expect(scene.presses).toEqual([]);
    expect(scene.finals.join('\n')).toContain('worker: left out: timeout');
  });

  test('a pane that lists another process beside its shell is never typed into', async () => {
    let typed: string | null = null;
    const scene = sceneOf({
      run: (command) => {
        typed = command;
      },
      press: () => true,
      process: () => (typed === null
        ? { shell: SHELL, foreground: [SHELL] }
        : { shell: SHELL, foreground: [SHELL, CLI] }),
      screen: () => (typed !== null ? wrappedEcho(typed) : `${PROMPT}\n`),
      classify: () => 'unknown',
      foreground: () => ['zsh'],
      shellBack: () => true,
    });
    await executePlan(stepsOf(20), 'acme', scene.host);
    expect(scene.presses).toEqual([]);
    expect(scene.finals.join('\n')).toContain('worker: left out: timeout');
  });
});
