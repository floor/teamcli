// The grok CLI's launch line and its captured screens (1.0.50). This pins what the profile
// (src/profiles/grok.yaml) makes of the captures under test/fixtures/grok/1.0.50 — how each
// reads, what its box holds, and that `down` can exit a seat — and that `up` puts the rules on
// the launch line. Every claim about the CLI's own behaviour comes from a run quoted in the
// profile's comments; the fixture README says how each screen was taken.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { canShowModel, launchModelWhenUnread, runningModel } from '../../src/status/statusline.ts';
import { classifyComposer, readScreen, screenData } from '../../src/watch/screen.ts';
import { boxHoldsText } from '../../src/launch/deliver.ts';
import { type ExitIo, typeExit } from '../../src/commands/down.ts';
import { upPlan } from '../../src/launch/plan.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/grok/1.0.50/${name}.txt`, import.meta.url), 'utf8');

const grok = profileFor('grok');
if (!grok) throw new Error('grok has no profile');

describe('Grok launch and captured screens', () => {
  test('unattended flags and the rules ride the launch line, and the seat reads its own shape', () => {
    expect(launchCommand(grok, 'grok', 'Rules.')).toBe('AGENT_UNATTENDED=1 grok --always-approve --rules Rules.');
    expect(launchCommand(grok, 'grok --model grok-4.7-build-fast', "Don't stop.")).toBe(
      "AGENT_UNATTENDED=1 grok --model grok-4.7-build-fast --always-approve --rules 'Don'\\''t stop.'",
    );
    expect(grok.rulesOption).toBe('--rules');
    expect(grok.loginCheck).toEqual(['models']);
    expect(grok.loginHint).toBe('grok login');
    expect(grok.exit).toBe('/exit');
    expect(grok.exitClear).toBe('ctrl+u');
    expect(grok.exitConfirm).toBe(null);
    expect(grok.idleTimeout).toBe(90);
    expect(grok.exitTimeout).toBe(30);
    expect(screenData('grok')).toBeDefined();
  });

  test('a version is placed against the tested range', () => {
    expect(versionVerdict('grok 1.0.50 (c58f321264ba) [stable]', grok.tested)).toBe('tested');
    expect(versionVerdict('grok 1.0.52 (0920c8169e27) [stable]', grok.tested)).toBe('tested');
    expect(versionVerdict('1.0.51', grok.tested)).toBe('tested');
    expect(versionVerdict('1.0.53', grok.tested)).toBe('newer');
    expect(versionVerdict('1.0.49', grok.tested)).toBe('older');
    expect(versionVerdict('dev build', grok.tested)).toBe('unread');
  });

  test('a launch model id maps to the model and version of the box footer', () => {
    expect(grok.modelOf('grok --model grok-4.7-build-fast')).toEqual({ model: 'Grok 4.7 Fast', version: '4.7' });
    expect(grok.modelOf('grok --model grok-4.7')).toEqual({ model: 'Grok 4.7', version: '4.7' });
    expect(grok.modelOf('grok --model GROK-4.5')).toEqual({ model: 'Grok 4.5', version: '4.5' });
    // The ids are version-shaped: a version this capture never saw still maps by shape.
    expect(grok.modelOf('grok --model grok-3')).toEqual({ model: 'Grok 3', version: '3' });
    expect(grok.modelOf('grok')).toBeNull();
    expect(grok.modelOf('grok --model grok-mini')).toBeNull();
  });

  test.each([
    ['idle', 'idle', 'idle'],
    ['idle-ansi', 'idle', 'idle'],
    ['unsent', 'unsent', 'unsent'],
    ['unsent-wrap', 'unsent', 'unsent'],
    ['working-start', 'working', 'idle'],
    ['working-tool', 'working', 'idle'],
    ['after-turn', 'idle', 'idle'],
    ['exit-typed', 'unsent', 'unsent'],
    ['slash-exit', 'unsent', 'unsent'],
    ['slash-menu', 'unsent', 'unsent'],
    ['exit', 'unknown', 'unknown'],
    ['compact-mode', 'unknown', 'unknown'],
  ] as const)('%s reads %s, its composer %s', (file, kind, composer) => {
    const text = fixture(file);
    expect(readScreen('grok', text).kind).toBe(kind);
    expect(classifyComposer('grok', text.split('\n')).kind).toBe(composer);
  });

  test('the slash menu above the box never shadows it: the box stays the box the text is in', () => {
    // exit-typed.txt and slash-menu.txt draw the menu's own full-width rules above the box's
    // opening rule; the box's closing rule is still the last rule row, and the nearest rule
    // above it is the box's own opening one.
    for (const file of ['exit-typed', 'slash-exit'] as const) {
      expect(boxHoldsText('grok', '/exit', fixture(file))).toBe(true);
    }
    expect(boxHoldsText('grok', '/', fixture('slash-menu'))).toBe(true);
  });

  test('1.0.52 captures: the answer widget is a question, and the exit shell is unknown', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/grok/1.0.52/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('grok', current('idle')).kind).toBe('idle');
    expect(readScreen('grok', current('working')).kind).toBe('working');
    expect(readScreen('grok', current('question')).kind).toBe('question');
    expect(readScreen('grok', current('permission')).kind).toBe('question');
    expect(readScreen('grok', current('exit')).kind).toBe('unknown');
    expect(readScreen('grok', current('exit-typed')).kind).toBe('unsent');
  });

  test('a one-row text reads back exactly; the 52-character watch line wraps and never does', () => {
    expect(boxHoldsText('grok', 'RULES_RECEIVED', fixture('unsent'))).toBe(true);
    expect(boxHoldsText('grok', 'RULES_RECEIVED!', fixture('unsent'))).toBe(false);
    // The text the watch types for a nudge is 52 characters: the pane wraps it into a second
    // box row drawn with the left border kept (`  │   team.log`), and a continuation row is
    // never read as the text's own — the nudge is refused, and the watch falls back.
    expect(boxHoldsText('grok', 'Team watch: reports are waiting in .agents/team.log', fixture('unsent-wrap'))).toBe(false);
    // A line that fits one box row reads back whole.
    const line = 'a short watch line';
    expect(readScreen('grok', boxed(line)).kind).toBe('unsent');
    expect(boxHoldsText('grok', line, boxed(line))).toBe(true);
  });

  test('the exit screen and the compact frame permit no input', () => {
    for (const file of ['exit', 'compact-mode'] as const) {
      expect(boxHoldsText('grok', 'anything', fixture(file))).toBe(false);
    }
  });

  test('the closing rule names the model, and a screen that hides it does not', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/grok/1.0.52/${name}.txt`, import.meta.url), 'utf8');
    expect(runningModel('grok', fixture('idle'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', fixture('idle-ansi'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', fixture('compact-mode'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', fixture('working-start'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', fixture('working-tool'))).toEqual({ model: 'Grok Fast', version: '4.7' });
    expect(runningModel('grok', fixture('unsent-wrap'))).toEqual({ model: 'Grok Fast', version: '4.7' });
    expect(runningModel('grok', fixture('exit'))).toBeNull();
    expect(runningModel('grok', current('idle'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', current('working'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', current('exit-typed'))).toEqual({ model: 'Grok', version: '4.7' });
    expect(runningModel('grok', current('question'))).toBeNull();
    expect(runningModel('grok', current('permission'))).toBeNull();
    expect(runningModel('grok', current('exit'))).toBeNull();
    // The welcome line and the build banner sit on the same screens and name no model.
    expect(runningModel('grok', '  Grok 4.7 is here!\n')).toBeNull();
    expect(runningModel('grok', '                        Grok Build  1.0.52 [stable]\n')).toBeNull();
    expect(runningModel('grok', 'Grok 4.7 Fast (high)\nGrok 4.7 (high)\n')).toEqual({ model: 'Grok', version: '4.7' });
    expect(canShowModel({ cli: 'grok', model: 'Grok', version: '4.7' })).toBe(true);
    expect(canShowModel({ cli: 'grok', model: 'Grok Fast', version: '4.7' })).toBe(true);
    expect(canShowModel({ cli: 'grok', model: 'Grok 4.7 Fast', version: '4.7' })).toBe(false);
    expect(canShowModel({ cli: 'grok', model: 'Grok', version: 'dev' })).toBe(false);
    expect(canShowModel({ cli: 'grok', model: 'Grok Mini', version: '4.7' })).toBe(false);
  });

  test("the unread fallback is grok's alone", () => {
    expect(launchModelWhenUnread('grok')).toBe(true);
    for (const cli of ['claude-code', 'codex', 'cursor', 'antigravity']) {
      expect(launchModelWhenUnread(cli)).toBe(false);
    }
  });
});

/** The idle capture with `text` standing in the box: the bare input row replaced by the row the
 *  pane draws for a one-row text — the text after the prompt, padded to the closing edge. The
 *  idle box's input row is `  │ ❯` + 45 spaces + `│`, 51 characters wide (see the fixtures). */
function boxed(text: string, base = fixture('idle')): string {
  const bare = `  │ ❯${' '.repeat(45)}│`;
  const row = `  │ ❯ ${text}`;
  if (row.length + 1 > 51) throw new Error('the text does not fit one box row');
  return base.replace(bare, `${row}${' '.repeat(51 - row.length - 1)}│`);
}

describe('Grok exit typing', () => {
  /** A pane whose screen follows its two captures: the idle box until `/exit` has been typed
   *  and the pane has drawn it — herdr's send returns before the pane renders, so the drawing
   *  is the sleep — and the exit-typed capture from then on. Every key is recorded with the
   *  reading it went out on. */
  function exitPane() {
    let typed = false;
    let drawn = false;
    let clock = 1_000_000;
    const sent: { key: string; holds: boolean }[] = [];
    const types: string[] = [];
    const screen = () => (typed && drawn ? fixture('exit-typed') : fixture('idle'));
    const send = (key: string) => {
      sent.push({ key, holds: boxHoldsText('grok', '/exit', screen()) });
      return true;
    };
    const io: ExitIo = {
      typeText: (line) => { types.push(line); typed = true; return true; },
      sendKey: send,
      pressEnter: () => send('enter'),
      screen,
      status: () => 'idle',
      foreground: () => ['grok'],
      sleep: async (ms) => { drawn = true; clock += ms; },
      now: () => clock,
    };
    return { io, sent, types };
  }

  test('the exit text is typed once into the idle box and entered on the drawing that holds it', async () => {
    const pane = exitPane();
    expect(await typeExit(pane.io, 'grok', '/exit')).toBe(true);
    expect(pane.types).toEqual(['/exit']);
    expect(pane.sent).toEqual([{ key: 'enter', holds: true }]);
  });

  test('a box left holding /exit from an earlier stop is cleared with ctrl+u first, then typed and entered', async () => {
    // The pane starts on the exit-typed capture. The profile's clearing key empties it; the
    // cleared pane is taken to draw the idle box again (the ctrl+u probe's clearing is quoted
    // in the fixtures README), and the text is typed fresh and entered.
    let cleared = false;
    let typed = false;
    let drawn = false;
    let clock = 1_000_000;
    const sent: { key: string; holds: boolean }[] = [];
    const types: string[] = [];
    const screen = () => (!cleared || !drawn ? fixture('exit-typed') : typed ? fixture('exit-typed') : fixture('idle'));
    const io: ExitIo = {
      typeText: (line) => { types.push(line); typed = true; return true; },
      sendKey: (key) => {
        sent.push({ key, holds: boxHoldsText('grok', '/exit', screen()) });
        if (key === 'ctrl+u') cleared = true;
        return true;
      },
      pressEnter: () => {
        sent.push({ key: 'enter', holds: boxHoldsText('grok', '/exit', screen()) });
        return true;
      },
      screen,
      status: () => 'idle',
      foreground: () => ['grok'],
      sleep: async (ms) => { drawn = true; clock += ms; },
      now: () => clock,
    };
    expect(await typeExit(io, 'grok', '/exit')).toBe(true);
    expect(sent).toEqual([{ key: 'ctrl+u', holds: true }, { key: 'enter', holds: true }]);
    expect(types).toEqual(['/exit']);
  });
});

describe('the plan launches grok with its rules on the line', () => {
  test('no first message is typed: the launch command carries the rules and the wait is the profile\'s 90 s', () => {
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'Watch · scratch',
      seats: [{
        name: 'grok',
        cli: 'grok',
        launch: 'grok',
        cwd: '.',
        label: 'grok',
        stopped: false,
        rules: 'Rules.',
        repairLine: '`team remove grok --keep` then `team add grok`',
      }],
    });
    expect(plan.find((step) => step.do?.do === 'launch')?.do).toMatchObject({
      do: 'launch',
      seat: 'grok',
      command: 'AGENT_UNATTENDED=1 grok --always-approve --rules Rules.',
    });
    expect(plan.find((step) => step.do?.do === 'idle')?.do).toMatchObject({ do: 'idle', cli: 'grok', seconds: 90 });
    expect(plan.some((step) => step.do?.do === 'deliver')).toBe(false);
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });

  test('a recorded conversation resumes with -r <id> on the seat launch line', () => {
    // The id is the registry's reach.agent_session. A typical grok seat, a flagged line, and a
    // wrapper that forwards its arguments all carry the measured `-r`.
    const id = '7c2e9a14-6b0d-4f83-9a21-0d5e8c3b71a6';
    const seat = {
      name: 'grok', cli: 'grok', cwd: '.', label: 'grok', stopped: false, rules: 'Rules.',
      repairLine: '`team remove grok --keep` then `team add grok`',
    };
    const commandOf = (launch: string, resume: { resume?: string; registry?: { launch: string; model: string; version: string; sessionId?: string } }): string => {
      const plan = upPlan({
        root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
        seats: [{ ...seat, launch, ...resume }],
      });
      const step = plan.find((item) => item.do?.do === 'launch');
      return step?.do?.do === 'launch' ? step.do.command : '';
    };
    expect(commandOf('grok', { registry: { launch: 'grok', model: 'Grok', version: '4.7', sessionId: id } }))
      .toBe(`AGENT_UNATTENDED=1 grok -r ${id} --always-approve --rules Rules.`);
    expect(commandOf('grok --model grok-4.7', { resume: id }))
      .toBe(`AGENT_UNATTENDED=1 grok --model grok-4.7 -r ${id} --always-approve --rules Rules.`);
    expect(commandOf('zsh /Users/owner/as-floor.sh grok --model grok-4.7', { resume: id }))
      .toBe(`AGENT_UNATTENDED=1 zsh /Users/owner/as-floor.sh grok --model grok-4.7 -r ${id} --always-approve --rules Rules.`);
    expect(commandOf('zsh -lc "grok --model grok-4.7"', { resume: id }))
      .toBe(`AGENT_UNATTENDED=1 zsh -lc "grok --model grok-4.7 -r ${id}" --always-approve --rules Rules.`);
  });
});
