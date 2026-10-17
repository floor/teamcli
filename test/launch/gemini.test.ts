// The gemini CLI's launch line and its captured screens (0.64.0). This pins what the profile
// (src/profiles/gemini.yaml) makes of the captures under test/fixtures/gemini/0.64.0 — how each
// reads, what its box holds, how status_model reads the footer, and that `down` can exit a seat —
// and that `up` delivers rules as the first message.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import {
  launchCommand,
  resolveEffortOverride,
  resolveModelOverride,
  versionVerdict,
  withLaunchOverrides,
} from '../../src/profiles/profile.ts';
import { classifyComposer, readScreen, screenData } from '../../src/watch/screen.ts';
import { boxHoldsText, deliverRules, type Delivery } from '../../src/launch/deliver.ts';
import { type ExitIo, typeExit } from '../../src/commands/down.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { runningModel } from '../../src/status/statusline.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/gemini/0.64.0/${name}.txt`, import.meta.url), 'utf8');

const gemini = profileFor('gemini');
if (!gemini) throw new Error('gemini has no profile');

describe('Gemini CLI launch and captured screens', () => {
  test('unattended flags ride the launch line, rules are first-message, and the seat reads its own shape', () => {
    expect(launchCommand(gemini, 'gemini', 'Rules.')).toBe('AGENT_UNATTENDED=1 gemini --approval-mode yolo');
    expect(launchCommand(gemini, 'gemini -m gemini-3-pro', 'Rules.')).toBe(
      'AGENT_UNATTENDED=1 gemini -m gemini-3-pro --approval-mode yolo',
    );
    expect(gemini.rulesOption).toBeNull();
    expect(gemini.loginCheck).toBeNull();
    expect(gemini.loginHint).toBe('gemini');
    expect(gemini.exit).toBe('/exit');
    expect(gemini.exitClear).toBe('ctrl+c');
    expect(gemini.exitConfirm).toBeNull();
    expect(gemini.idleTimeout).toBe(90);
    expect(gemini.exitTimeout).toBe(30);
    expect(gemini.startupReads).toEqual([
      { path: 'GEMINI.md', directory: false },
      { path: '.gemini/settings.json', directory: false },
    ]);
    expect(screenData('gemini')).toBeDefined();
  });

  test('a version is placed against the tested range', () => {
    expect(versionVerdict('0.64.0', gemini.tested)).toBe('tested');
    expect(versionVerdict('0.65.0', gemini.tested)).toBe('newer');
    expect(versionVerdict('0.63.0', gemini.tested)).toBe('older');
    expect(versionVerdict('dev build', gemini.tested)).toBe('unread');
  });

  test('a launch model id maps through -m or --model, and overrides replace either flag', () => {
    expect(gemini.modelOf('gemini -m gemini-3-pro')).toEqual({ model: 'Gemini Pro', version: '3' });
    expect(gemini.modelOf('gemini --model gemini-3-flash')).toEqual({ model: 'Gemini Flash', version: '3' });
    expect(gemini.modelOf('gemini --model=gemini-3.1-pro-preview')).toEqual({ model: 'Gemini Pro', version: '3.1' });
    expect(gemini.modelOf('gemini -m gemini-2.5-flash-lite')).toEqual({ model: 'Gemini Flash', version: '2.5' });
    expect(gemini.modelOf('gemini')).toBeNull();
    expect(gemini.modelOf('gemini -m unknown-model')).toBeNull();

    expect(resolveModelOverride(gemini, 'Gemini Pro 3')).toEqual({
      id: 'gemini-3-pro',
      model: 'Gemini Pro',
      version: '3',
    });
    expect(withLaunchOverrides(gemini, 'gemini', { modelId: 'gemini-3-pro' })).toBe('gemini -m gemini-3-pro');
    expect(withLaunchOverrides(gemini, 'gemini -m gemini-2.5-flash', { modelId: 'gemini-3-pro' })).toBe(
      'gemini -m gemini-3-pro',
    );
    expect(withLaunchOverrides(gemini, 'gemini --model gemini-2.5-flash', { modelId: 'gemini-3-pro' })).toBe(
      'gemini --model gemini-3-pro',
    );
    expect(resolveEffortOverride('gemini', 'google', 'high')).toEqual({
      error: 'gemini does not take an --effort flag on launch',
    });
  });

  test.each([
    ['idle', 'idle', 'idle'],
    ['unsent', 'unsent', 'unsent'],
    ['rules-line', 'unsent', 'unsent'],
    ['rules-accepted', 'idle', 'idle'],
    ['working', 'working', 'idle'],
    ['permission', 'permission', 'unknown'],
    ['question', 'question', 'unknown'],
    ['trust', 'trust', 'unknown'],
    ['rate-limit', 'rate limit', 'unknown'],
    ['exit-typed', 'unsent', 'unsent'],
    ['exit', 'unknown', 'unknown'],
  ] as const)('%s reads %s, its composer %s', (file, kind, composer) => {
    const text = fixture(file);
    expect(readScreen('gemini', text).kind).toBe(kind);
    expect(classifyComposer('gemini', text.split('\n')).kind).toBe(composer);
  });

  test('status_model reads the model off the composer footer', () => {
    for (const file of ['idle', 'unsent', 'rules-line', 'rules-accepted', 'working', 'exit-typed'] as const) {
      expect(runningModel('gemini', fixture(file))).toEqual({ model: 'Gemini Pro', version: '3' });
    }
    for (const file of ['trust', 'permission', 'question', 'rate-limit', 'exit'] as const) {
      expect(runningModel('gemini', fixture(file))).toBeNull();
    }
  });

  test('one-row and wrapped multi-row texts read back from the half-block composer box', () => {
    expect(boxHoldsText('gemini', 'RULES_RECEIVED', fixture('unsent'))).toBe(true);
    expect(boxHoldsText('gemini', 'RULES_RECEIVED!', fixture('unsent'))).toBe(false);
    expect(boxHoldsText('gemini', '/exit', fixture('exit-typed'))).toBe(true);
    const rulesLine =
      'Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/lead.md (`5e1d0a9c4b2f`); those are your standing rules for this session. Reply ready and wait for your brief.';
    expect(boxHoldsText('gemini', rulesLine, fixture('rules-line'))).toBe(true);
    expect(boxHoldsText('gemini', 'anything', fixture('exit'))).toBe(false);
  });
});

describe('Gemini CLI exit typing', () => {
  function exitPane() {
    let typed = false;
    let drawn = false;
    let clock = 1_000_000;
    const sent: { key: string; holds: boolean }[] = [];
    const types: string[] = [];
    const screen = () => (typed && drawn ? fixture('exit-typed') : fixture('idle'));
    const send = (key: string) => {
      sent.push({ key, holds: boxHoldsText('gemini', '/exit', screen()) });
      return true;
    };
    const io: ExitIo = {
      typeText: (line) => {
        types.push(line);
        typed = true;
        return true;
      },
      sendKey: send,
      pressEnter: () => send('enter'),
      screen,
      status: () => 'idle',
      foreground: () => ['gemini'],
      sleep: async (ms) => {
        drawn = true;
        clock += ms;
      },
      now: () => clock,
    };
    return { io, sent, types };
  }

  test('the exit text is typed once into the idle box and entered on the drawing that holds it', async () => {
    const pane = exitPane();
    expect(await typeExit(pane.io, 'gemini', '/exit')).toBe(true);
    expect(pane.types).toEqual(['/exit']);
    expect(pane.sent).toEqual([{ key: 'enter', holds: true }]);
  });

  test('a box left holding /exit from an earlier stop is cleared with ctrl+c first, then typed and entered', async () => {
    let cleared = false;
    let typed = false;
    let drawn = false;
    let clock = 1_000_000;
    const sent: { key: string; holds: boolean }[] = [];
    const types: string[] = [];
    const screen = () => (!cleared || !drawn ? fixture('exit-typed') : typed ? fixture('exit-typed') : fixture('idle'));
    const io: ExitIo = {
      typeText: (line) => {
        types.push(line);
        typed = true;
        return true;
      },
      sendKey: (key) => {
        sent.push({ key, holds: boxHoldsText('gemini', '/exit', screen()) });
        if (key === 'ctrl+c') cleared = true;
        return true;
      },
      pressEnter: () => {
        sent.push({ key: 'enter', holds: boxHoldsText('gemini', '/exit', screen()) });
        return true;
      },
      screen,
      status: () => 'idle',
      foreground: () => ['gemini'],
      sleep: async (ms) => {
        drawn = true;
        clock += ms;
      },
      now: () => clock,
    };
    expect(await typeExit(io, 'gemini', '/exit')).toBe(true);
    expect(sent).toEqual([
      { key: 'ctrl+c', holds: true },
      { key: 'enter', holds: true },
    ]);
    expect(types).toEqual(['/exit']);
  });
});

describe('the plan launches gemini and delivers its rules as the first message', () => {
  test('the launch command carries --approval-mode yolo and the plan delivers and waits for ready', () => {
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      seats: [
        {
          name: 'gemini',
          cli: 'gemini',
          launch: 'gemini -m gemini-3-pro',
          cwd: '.',
          label: 'gemini',
          stopped: false,
          rules: 'Rules.',
          rulesFile: { path: '/home/owner/.config/team/demo/rules/gemini.md', line: 'Read /home/owner/.config/team/demo/rules/gemini.md' },
          repairLine: '`team remove gemini --keep` then `team add gemini`',
        },
      ],
    });
    expect(plan.find((step) => step.do?.do === 'launch')?.do).toMatchObject({
      do: 'launch',
      seat: 'gemini',
      command: 'AGENT_UNATTENDED=1 gemini -m gemini-3-pro --approval-mode yolo',
    });
    expect(plan.find((step) => step.do?.do === 'idle')?.do).toMatchObject({ do: 'idle', cli: 'gemini', seconds: 90 });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({
      do: 'deliver',
      seat: 'gemini',
      cli: 'gemini',
      line: 'Read /home/owner/.config/team/demo/rules/gemini.md',
    });
  });

  test('deliverRules types the rules line into the idle box, verifies the wrapped rows, and confirms working after Enter', async () => {
    const rulesLine =
      'Read /home/owner/.config/team/demo-3f9c2a8e1d7b/rules/lead.md (`5e1d0a9c4b2f`); those are your standing rules for this session. Reply ready and wait for your brief.';
    let typed = false;
    let entered = false;
    let clock = 1_000_000;
    const calls: string[] = [];
    const io: Delivery = {
      screen: () => (entered ? fixture('working') : typed ? fixture('rules-line') : fixture('idle')),
      status: () => (entered ? 'working' : 'idle'),
      type: (value) => {
        calls.push(value);
        typed = true;
        return true;
      },
      enter: () => {
        calls.push('enter');
        entered = true;
        return true;
      },
      file: () => true,
      foreground: () => ['gemini'],
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    expect(await deliverRules('gemini', rulesLine, 30, io)).toBe(true);
    expect(calls).toEqual([rulesLine, 'enter']);
  });
});
