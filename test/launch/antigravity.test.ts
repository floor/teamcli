import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { readFoldMark, readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { rulesLine } from '../../src/launch/rules-file.ts';
import { rulesText, type RulesInput } from '../../src/launch/rules.ts';
import { downPlan, upPlan } from '../../src/launch/plan.ts';
import { pass, newMemory } from '../../src/watch/pass.ts';
import { emptySession } from '../../src/state.ts';
import { stateOf } from '../../src/commands/down.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { agyMismatchedFrame, wordWrap } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.2.16/${name}.txt`, import.meta.url), 'utf8');

const antigravity = profileFor('antigravity');
if (!antigravity) throw new Error('antigravity has no profile');

describe('Antigravity launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(launchCommand(antigravity, 'agy --model gemini-3.8-flash-high', 'Rules.')).toBe('AGENT_UNATTENDED=1 agy --model gemini-3.8-flash-high --dangerously-skip-permissions');
    expect(antigravity.rulesOption).toBeNull();
    expect(antigravity.loginCheck).toEqual(['models']);
    expect(antigravity.loginHint).toBe('agy');
    expect(antigravity.exit).toBe('/exit');
    expect(antigravity.exitClear).toBe('ctrl+u');
    expect(versionVerdict('1.2.16', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.2.18', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.3.5', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.4.0', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.4.1', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.4.2', antigravity.tested)).toBe('tested');
    expect(versionVerdict('1.4.3', antigravity.tested)).toBe('newer');
    expect(versionVerdict('1.2.10', antigravity.tested)).toBe('older');
  });

  test.each([
    ['idle', 'idle'],
    ['unsent', 'unsent'],
    ['working', 'working'],
    ['rules-accepted', 'idle'],
    ['trust', 'trust'],
    ['permission', 'permission'],
    ['exit-typed', 'unsent'],
    ['exit', 'unknown'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('antigravity', fixture(file)).kind).toBe(kind);
  });
  test('a permission dialog with a running turn beside it is still permission, not working', () => {
    // The turn's "Generating..." line stays visible while the dialog is up: the dialog shape is
    // read first, as for claude-code.
    const screen = fixture('permission').replace('Command\n', 'Command\n⣯  Generating...\n');
    expect(readScreen('antigravity', screen).kind).toBe('permission');
  });

  test('working screen witnesses recognise thinking preview, tool execution, and active command execution', () => {
    // Thinking preview with spinner
    const thinking = fixture('idle').replace('─────────────────────────────────────────────────────\n>', '⣟  The request involves running a sleep 4 command...\n─────────────────────────────────────────────────────\n>');
    expect(readScreen('antigravity', thinking).kind).toBe('working');

    // Tool execution with spinner and running command
    const toolRun = fixture('idle').replace('─────────────────────────────────────────────────────\n>', '○ Thought for 3.5s\n● Running (sleep 4)\n⢿  Running command...\n─────────────────────────────────────────────────────\n>');
    expect(readScreen('antigravity', toolRun).kind).toBe('working');

    // Active tool execution without spinner
    const activeTool = fixture('idle').replace('─────────────────────────────────────────────────────\n>', '● Running (sleep 4)\n─────────────────────────────────────────────────────\n>');
    expect(readScreen('antigravity', activeTool).kind).toBe('working');

    // Token streaming with Generating indicator
    const streaming = fixture('idle').replace('─────────────────────────────────────────────────────\n>', '⣻  Generating...\n─────────────────────────────────────────────────────\n>');
    expect(readScreen('antigravity', streaming).kind).toBe('working');
  });

  test('the exit screen with slash-menu and esc to cancel footer reads unsent, not working', () => {
    // Right after typing /exit, the screen carries the slash completion popup with the esc footer.
    // Because esc to cancel is chrome and omitted from working rules, it correctly evaluates as unsent.
    const exitScreen = fixture('exit-typed');
    expect(exitScreen).toContain('esc to cancel');
    expect(readScreen('antigravity', exitScreen).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', '/exit', exitScreen)).toBe(true);
  });

  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [
      undefined,
      '❯\n',
      '>\n',
      'Welcome to Antigravity\nSign in to continue',
      'Do you allow this command?\n> 1. Yes\nEnter to confirm',
    ]) {
      expect(readScreen('antigravity', screen).kind).toBe('unknown');
    }
    expect(readScreen('antigravity', fixture('idle').replace('? for shortcuts               Gemini 3.8 Flash · high', 'new footer')).kind).toBe('unknown');
  });

  test('a quoted trust or permission dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('antigravity', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('antigravity', fixture('permission') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('antigravity', fixture('idle').replace('─────────────────────────────────────────────────────\n>', '─────────────────────────────────────────────────────\n>\n  unsent second line')).kind).toBe('unsent');
  });

  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(antigravity.modelOf('agy --model gemini-4-argon-low')).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(antigravity.modelOf('agy --model gemini-4-argon-medium')).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(antigravity.modelOf('agy --model gemini-4-argon-high')).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(antigravity.modelOf('agy --model=gemini-3.1-pro-low')).toEqual({ model: 'Gemini Pro', version: '3.1' });
    expect(antigravity.modelOf('agy --model unknown-model')).toBeNull();
    expect(antigravity.modelOf('agy')).toBeNull();
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-medium')).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(antigravity.modelOf('agy --model gemini-3.7-flash-high')).toEqual({ model: 'Gemini Flash', version: '3.7' });
    expect(antigravity.modelOf('agy --model gemini-3.8-flash-high --model gemini-3.1-pro-low')).toEqual({ model: 'Gemini Pro', version: '3.1' });
    expect(runningModel('antigravity', fixture('idle'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('antigravity', fixture('rules-accepted'))).toEqual({ model: 'Gemini Flash', version: '3.8' });
    expect(runningModel('antigravity', fixture('trust'))).toBeNull();
    const idle135 = readFileSync(new URL('../fixtures/antigravity/1.3.5/idle.txt', import.meta.url), 'utf8');
    expect(runningModel('antigravity', idle135)).toEqual({ model: 'Gemini Argon', version: '4' });
  });

  test('1.3.5 captures keep the same dialog kinds', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.3.5/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('antigravity', current('trust')).kind).toBe('trust');
    expect(readScreen('antigravity', current('idle')).kind).toBe('idle');
    expect(readScreen('antigravity', current('working')).kind).toBe('working');
    expect(readScreen('antigravity', current('question')).kind).toBe('question');
    expect(readScreen('antigravity', current('permission')).kind).toBe('permission');
    expect(readScreen('antigravity', current('exit')).kind).toBe('unknown');
  });

  test('1.4.1 captures keep the same dialog kinds', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.4.1/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('antigravity', current('trust')).kind).toBe('trust');
    expect(readScreen('antigravity', current('idle')).kind).toBe('idle');
    expect(readScreen('antigravity', current('unsent')).kind).toBe('unsent');
    expect(readScreen('antigravity', current('working')).kind).toBe('working');
    expect(readScreen('antigravity', current('question')).kind).toBe('question');
    expect(readScreen('antigravity', current('permission')).kind).toBe('permission');
    expect(readScreen('antigravity', current('exit')).kind).toBe('unknown');
    // Its footer still names the running model.
    expect(runningModel('antigravity', current('idle'))).toEqual({ model: 'Gemini Argon', version: '4' });
  });

  test('1.4.2 captures keep the same dialog kinds and the model row a turn leaves', () => {
    const current = (name: string) => readFileSync(new URL(`../fixtures/antigravity/1.4.2/${name}.txt`, import.meta.url), 'utf8');
    expect(readScreen('antigravity', current('trust')).kind).toBe('trust');
    expect(readScreen('antigravity', current('idle')).kind).toBe('idle');
    expect(readScreen('antigravity', current('unsent')).kind).toBe('unsent');
    expect(readScreen('antigravity', current('working')).kind).toBe('working');
    expect(readScreen('antigravity', current('question')).kind).toBe('question');
    expect(readScreen('antigravity', current('permission')).kind).toBe('permission');
    expect(readScreen('antigravity', current('exit')).kind).toBe('unknown');
    // The folder is the profile's ceiling. As on 1.4.0, the fresh idle footer carries no model
    // row; the model row appears under the box once a turn has run.
    expect(profileFor('antigravity')?.tested.to).toBe('1.4.2');
    expect(runningModel('antigravity', current('idle'))).toBeNull();
    expect(runningModel('antigravity', current('unsent'))).toEqual({ model: 'Gemini Argon', version: '4' });
    expect(runningModel('antigravity', current('working'))).toEqual({ model: 'Gemini Argon', version: '4' });
  });

  test('the plan delivers the one line through the guarded path, never a config file', () => {
    const line = rulesLine('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/gemini.md', '5e1d0a9c4b2f');
    const plan = upPlan({
      root: '.',
      session: 'scratch',
      sessionRunning: true,
      watchAlive: true,
      watchLabel: 'Watch · scratch',
      seats: [{ name: 'gemini', cli: 'antigravity', launch: 'agy', cwd: '.', label: 'gemini', stopped: false, rules: 'Rules.',
        repairLine: '`team remove gemini --keep` then `team add gemini`',
        rulesFile: { path: '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/gemini.md', line } }],
    });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({ do: 'deliver', cli: 'antigravity', rules: 'Rules.', line, seconds: 90 });
    const deliverStep = plan.find((step) => step.do?.do === 'deliver');
    expect(deliverStep?.kind === 'run' ? deliverStep.argv.at(-1) : undefined).toBe(line);
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });

  test('a recorded conversation resumes with --conversation=<id> on the seat launch line', () => {
    // The id is the registry's reach.agent_session. A typical agy seat, and a wrapper that
    // forwards its arguments, both carry the measured flag.
    const id = 'b4b1b021-e8af-4213-9b7e-470b233b712f';
    const seat = {
      name: 'gemini', cli: 'antigravity', cwd: '.', label: 'gemini', stopped: false, rules: 'Rules.',
      repairLine: '`team remove gemini --keep` then `team add gemini`',
    };
    const commandOf = (launch: string, resume: { resume?: string; registry?: { launch: string; model: string; version: string; sessionId?: string } }): string => {
      const plan = upPlan({
        root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
        seats: [{ ...seat, launch, ...resume }],
      });
      const step = plan.find((item) => item.do?.do === 'launch');
      return step?.do?.do === 'launch' ? step.do.command : '';
    };
    expect(commandOf('agy', { registry: { launch: 'agy', model: 'Gemini Flash', version: '3.8', sessionId: id } }))
      .toBe(`AGENT_UNATTENDED=1 agy --conversation=${id} --dangerously-skip-permissions`);
    expect(commandOf('zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro', { resume: id }))
      .toBe(`AGENT_UNATTENDED=1 zsh /Users/owner/as-floor.sh agy --model gemini-3.1-pro --conversation=${id} --dangerously-skip-permissions`);
    expect(commandOf('zsh -lc "agy --model gemini-3.1-pro"', { resume: id }))
      .toBe(`AGENT_UNATTENDED=1 zsh -lc "agy --model gemini-3.1-pro --conversation=${id}" --dangerously-skip-permissions`);
  });
  test('a message seat whose rules file has no typeable path is refused before anything is typed', () => {
    const plan = upPlan({
      root: '.', session: 'scratch', sessionRunning: true, watchAlive: true, watchLabel: 'Watch · scratch',
      seats: [{ name: 'gemini', cli: 'antigravity', launch: 'agy', cwd: '.', label: 'gemini', stopped: false, rules: 'Rules.',
        repairLine: '`team remove gemini --keep` then `team add gemini`',
        rulesRefusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" }],
    });
    expect(plan.some((step) => step.do?.do === 'deliver')).toBe(false);
    expect(plan.find((step) => step.kind === 'skip')?.text).toBe(
      "gemini: would refuse: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
    );
  });
});

/** The captured idle frame once `text` sits in the box: the bare prompt row replaced, the text's
 *  first line after the prompt, every later line at the column the `unsent` capture draws
 *  continuation rows in — two columns, the prompt's own width (see the fixtures README). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('\n>\n', `\n${body}\n`);
}

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['agy'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Antigravity rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a shorter first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('an ordinary box whose rows are the typed line hard-wrapped is entered', async () => {
    // No Antigravity capture shows its composer wrapping an ordinary line — a long paste folds —
    // so no wrap is modelled for it: the box rows must read back as the typed line laid out in
    // order, the continuation at the prompt row's two columns, and then the Enter is the paste's.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const chunks: string[] = [];
    for (let at = 0; at < long.length; at += 53) chunks.push(long.slice(at, at + 53));
    expect(chunks.length).toBeGreaterThan(1);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(chunks.join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([long, 'Enter']);
  });

  test('a hard-wrapped box with one character changed gets no Enter', async () => {
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const changed = long.replace('reply ready', 'reply reidy');
    const chunks: string[] = [];
    for (let at = 0; at < changed.length; at += 53) chunks.push(changed.slice(at, at + 53));
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(chunks.join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a word-wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of the typed line: the pane draws one only where
    // the text itself has a blank line, and this line has none.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const rows = wordWrap(long, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed([firstRow, '', ...rest].join('\n'))); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a trailing blank row after the word-wrapped line gets no Enter', async () => {
    // No capture shows Antigravity drawing an empty row of its own inside the box — idle.txt's
    // composer is the bare `>` row and unsent.txt's rows sit directly between the rules — so a
    // trailing blank row is never the pane's frame: it is a row the text does not have.
    const long = 'These are standing rules, not a task: reply ready and wait for your brief.';
    const rows = wordWrap(long, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const body = [`> ${firstRow}`, ...rest.map((row) => `  ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('\n>\n', `\n${body}\n`);
    expect(boxHoldsText('antigravity', long, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('antigravity', long, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([long]);
  });

  test('a blank line the typed text itself has is refused: a blank row is never the text\'s', async () => {
    // A blank row was the pane's drawing of a blank line the text had, when texts could hold
    // newlines. A row break may stand for at most one space, never a newline, so the blank row
    // never reads back and there is no Enter.
    const typed = 'Rules.\n\nMore rules.';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('antigravity', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });

  test('two spaces typed, one shown, gets no Enter', async () => {
    // The shared read refuses a box showing a single space where the typed text has two: the
    // wrap did not add or drop it.
    expect(boxHoldsText('antigravity', 'alpha  beta', boxed('alpha beta'))).toBe(false);
  });

  test('a boxed multi-line paste no longer reads back: typed, not sent', async () => {
    // A row break may stand for at most one space, never the newline between the lines, so a
    // multi-line text never verifies and the Enter is never the delivery's to send.
    const d = delivery();
    expect(await deliverRules('antigravity', 'Rules.\nOne more line.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.\nOne more line.']);
  });

  test.each(['trust', 'permission', 'unsent', 'exit', 'working'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working');
    d.status('idle');
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a trust question appearing after paste gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('trust'); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a dialog arriving at the final re-read gets no Enter', async () => {
    const d = delivery();
    let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'trust' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });

  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    }
  });

  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery();
    let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
  });
});

// The rules a lane seat was given, as `up` renders them: the fixture below is this text folded
// in agy's composer at 54 columns (see the fixtures README).
const RULES_INPUT: RulesInput = {
  orchestrator: 'floor-30',
  rules: [
    'Work only on the brief in front of you, and skip nothing in it.',
    'Never push: your `ready` file is the hand-off.',
    'Never run `gh`, and never touch `CHANGELOG.md`.',
    'Write the result file beside the brief, then `ready <sha>`.',
  ],
  signature: {
    commit: 'Agent: DeepSeek V4.1 Flash · implementer',
    pullRequest: 'Agent: DeepSeek V4.1 Flash · implementer',
    commitPosition: 'last-line',
  },
  workspace: { mode: 'worktree', protected: [], branch: 'fix/agy-rules-fold' },
};
const RULES = rulesText(RULES_INPUT, 'message');

/** A pane idle before the paste, the given folded pane after it, working after Enter. */
function foldedPane(edit: (screen: string) => string = (screen) => screen) {
  const d = delivery();
  let pasted = false;
  let entered = false;
  d.io.screen = () => (entered ? fixture('working') : pasted ? edit(fixture('folded-rules')) : fixture('idle'));
  d.io.type = (text) => { d.calls.push(text); pasted = true; return true; };
  d.io.enter = () => { d.calls.push('Enter'); entered = true; d.status('working'); return true; };
  return d;
}

describe('Antigravity folded rules paste', () => {
  // The captures of a folded whole message stay as documentation of the fold; the delivery
  // is one line, which the box draws whole, so the fold path in delivery is gone: a folded
  // box is never verified, whatever its marker says, and never entered.
  test('a folded box never verifies: the line is typed, not sent', async () => {
    const d = foldedPane();
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
    expect(d.refusals.at(-1)?.stop).toBe('read-back');
    expect(d.refusals.at(-1)?.typed).toBe(true);
    expect(refusalReport(d.refusals.at(-1)!)).toContain("the read-back didn't match");
  });

  test('a prompt-marked fold reads unsent and still never verifies', async () => {
    const marked = (screen: string) => screen.replace('↑ 21 more lines', '> ↑ 21 more lines');
    expect(readScreen('antigravity', marked(fixture('folded-rules'))).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', RULES, marked(fixture('folded-rules')))).toBe(false);
    const d = foldedPane(marked);
    expect(await deliverRules('antigravity', RULES, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([RULES]);
  });

  test('the one line is far shorter than the fold: its box never shows a marker', () => {
    expect(readFoldMark('antigravity', fixture('rules-line'))).toBe(false);
    expect(boxHoldsText('antigravity', rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f'), fixture('rules-line'))).toBe(true);
  });
});

describe('Antigravity permission prompt in watch and down', () => {
  test('the screen classifier reads permission as blocked, never idle or unsent', () => {
    const screen = readScreen('antigravity', fixture('permission'));
    expect(screen.kind).toBe('permission');
    expect(screen.kind).not.toBe('idle');
    expect(screen.kind).not.toBe('unsent');
  });

  test('watch reports an Antigravity seat at a permission prompt to the owner', () => {
    const memory = newMemory();
    const parsed = validateTeamFile(`
format: 1
project: test
workspace:
  mode: shared
coordinator: gemini
operator: gemini
seats:
  - role: implementer
    name: gemini
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy
`);
    if (!parsed.ok) throw new Error('invalid team file');
    const teamFile = parsed.team;
    const result = pass({
      team: teamFile, watch: teamFile.watch,
      state: emptySession(),
      live: {
        running: true,
        agents: [{ name: 'gemini', agent: 'agy', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
        workspaces: [{ id: 'w1', label: 'gemini' }],
        screens: { 'w1:p1': fixture('permission') },
      },
      machine: { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 },
      now: 0,
      memory,
    });
    expect(result.reports).toEqual([{
      key: 'blocked:gemini',
      text: "gemini waits at a permission prompt: its owner's to answer",
      to: 'owner',
    }]);
  });

  test('down treats an Antigravity seat at a permission prompt as blocked and types nothing', () => {
    const screen = readScreen('antigravity', fixture('permission'));
    expect(stateOf('idle', screen)).toBe('blocked');
    expect(stateOf('done', screen)).toBe('blocked');

    const plan = downPlan({
      session: 'test-session',
      seats: [{
        name: 'gemini',
        cli: 'antigravity',
        pane: 'w1:p1',
        workspace: 'w1',
        state: stateOf('idle', screen),
      }],
      keep: [],
      extra: 0,
      watchPid: null,
    });
    expect(plan.find((step) => step.kind === 'skip' && step.text.includes('gemini'))).toEqual({
      kind: 'skip',
      text: 'gemini: is blocked at a prompt, which `team` never answers; left running',
    });
    expect(plan.some((step) => step.do?.do === 'type')).toBe(false);
  });
});

describe('the prompt-glyph continuation row (Antigravity)', () => {
  // The person's box holds their own text, then a continuation row at the content column
  // carrying only the prompt glyph. The input row is the box's first row under its opening
  // rule — unsent.txt draws `>` there, at the pane's first column — never the last row whose
  // content begins with a glyph.
  const GLYPH = '>';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('antigravity', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `> Rules.`.
    expect(boxHoldsText('antigravity', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    expect(boxHoldsText('antigravity', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    expect(readScreen('antigravity', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });
});

describe('the two-rule frame whose rules differ in width (Antigravity)', () => {
  // The captures draw the box's two rules at one width — idle.txt draws both at 53 columns,
  // folded-rules.txt at 54 — so a window whose rules differ is not that frame: the box the
  // read-back compares against the typed text cannot be established, and the read fails
  // closed. The closing rule is redrawn one column shorter (52) or longer (54) than the
  // opening, and the opening rule one shorter instead.
  test.each(['close-short', 'close-long', 'open-short'] as const)('%s: the screen reads unknown, bare or holding the typed text', (shape) => {
    expect(readScreen('antigravity', agyMismatchedFrame(shape)).kind).toBe('unknown');
    expect(readScreen('antigravity', agyMismatchedFrame(shape, 'Rules.')).kind).toBe('unknown');
    expect(boxHoldsText('antigravity', 'Rules.', agyMismatchedFrame(shape, 'Rules.'))).toBe(false);
  });

  test.each(['close-short', 'close-long', 'open-short'] as const)('%s: a full delivery types nothing and sends nothing', async (shape) => {
    const d = delivery();
    d.showText(agyMismatchedFrame(shape));
    d.io.type = (text) => { d.calls.push(text); d.showText(agyMismatchedFrame(shape, text)); return true; };
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

// The line the 2026-10-05 capture holds, as `team` composes it: the same path and hash the
// fixtures README names, through the function that builds it. The box hard-wraps it mid-word
// into five rows; the break after `Read` hides the line's own single space, and every other
// break — mid-word, mid-path, mid-hash — hides nothing at all.
const CAPTURED_PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md';
const capturedLine = rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f');

describe('Antigravity rules delivery of the one line (1.2.16 capture)', () => {
  test('the captured line reads unsent and holds exactly the line', () => {
    const screen = fixture('rules-line');
    expect(readScreen('antigravity', screen).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', capturedLine, screen)).toBe(true);
    // Anything the seat might hold instead: one character more, the line without its final
    // full stop, another seat's path, an older hash of the same rules.
    expect(boxHoldsText('antigravity', `${capturedLine} again`, screen)).toBe(false);
    expect(boxHoldsText('antigravity', capturedLine.slice(0, -1), screen)).toBe(false);
    expect(boxHoldsText('antigravity', rulesLine(CAPTURED_PATH.replace('implementer', 'scribe'), '5e1d0a9c4b2f'), screen)).toBe(false);
    expect(boxHoldsText('antigravity', rulesLine(CAPTURED_PATH, '4d0c9f8b3a2e'), screen)).toBe(false);
  });

  test('the line is typed once at an empty prompt, read back row by row, and entered once', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(text === capturedLine ? fixture('rules-line') : boxed(text)); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test.each([
    ['in the path', ['3f9c2a8e1d7b', '3f9c2a8e1d7c']],
    ['in the hash', ['5e1d0a9c4b2f', '5e1d0a9c4b2e']],
    ['in a word of the line', ['your standing', 'your stunding']],
    ['in the final full stop', ['your brief.', 'your brief!']],
  ] as const)('one character changed %s gets no Enter', async (what, [from, to]) => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(fixture('rules-line').replace(from, to)); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.typed).toBe(true);
    expect(why?.sent).toBe(false);
    expect(why?.row).not.toBeNull();
    expect(why?.cleared).toBeUndefined();
    expect(refusalReport(why!)).toContain("the read-back didn't match");
    expect(refusalReport(why!)).toContain('the line sits in its box, unsent');
  });

  test('a row of the line with one character more than the line has gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(fixture('rules-line').replace('your brief.', 'your brief. x')); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
  });

  test('the line with one character more than the box shows gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(fixture('rules-line')); return true; };
    expect(await deliverRules('antigravity', `${capturedLine} x`, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([`${capturedLine} x`]);
  });

  test('two spaces in the line where the row break hides one get no Enter', async () => {
    // The captured break after `Read` hides the line's single space. A line with two spaces
    // there draws the same rows — the read-back refuses it: a break may stand for exactly one
    // space, never a run of them.
    const doubled = capturedLine.replace('Read /home', 'Read  /home');
    expect(boxHoldsText('antigravity', doubled, fixture('rules-line'))).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(fixture('rules-line')); return true; };
    expect(await deliverRules('antigravity', doubled, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([doubled]);
  });

  test('a tab in the line gets no Enter', async () => {
    const tabbed = capturedLine.replace('Read ', 'Read\t');
    expect(boxHoldsText('antigravity', tabbed, fixture('rules-line'))).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(fixture('rules-line')); return true; };
    expect(await deliverRules('antigravity', tabbed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([tabbed]);
  });

  test('a trust dialog at the final re-read gets no Enter', async () => {
    // The other way round: the line reads back in the loop, and the re-read that immediately
    // precedes the Enter sees the dialog — so the Enter is never pressed into it.
    const d = delivery();
    d.io.type = (text) => {
      d.calls.push(text);
      let reads = 0;
      d.io.screen = () => (++reads <= 1 ? fixture('rules-line') : fixture('trust'));
      return true;
    };
    const keys: string[] = [];
    d.io.key = (name) => { keys.push(name); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(keys).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.sent).toBe(false);
    expect(why?.kind).toBe('trust');
    expect(why?.cleared).toBeUndefined();
  });

  test('the file changing after it was written gets no Enter', async () => {
    // The line read back as its own rows; between that and the key, the file at its path no
    // longer holds the text whose hash the line names. Nothing is sent, and the report says
    // the file changed — the seat is never pointed at a file team cannot vouch for.
    const d = delivery();
    d.io.file = () => false;
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('file-changed');
    expect(why?.sent).toBe(false);
    expect(refusalReport(why!)).toBe('rules typed, not sent: the rules file changed after it was written');
  });

  test('a seat mid-turn is reported as working; nothing is typed', async () => {
    const d = delivery();
    d.status('working');
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('working');
    expect(refusalReport(why!)).toBe('rules not confirmed: the seat is working; run up again when it is idle');
  });

  test('a box already holding the person\'s own text is left alone', async () => {
    const d = delivery();
    d.showText(boxed('the person\'s own message'));
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('leftover');
    expect(refusalReport(why!)).toContain('its box already holds text that is not the rules line');
  });

  test('a box already holding this CLI\'s exit text is named for its owner, not typed onto', async () => {
    // An earlier stop typed `/exit` and never confirmed it. This run did not type it, so the
    // clearing key is named and not sent.
    const d = delivery();
    const keys: string[] = [];
    d.io.key = (name) => { keys.push(name); return true; };
    d.showText(fixture('exit-typed'));
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(keys).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('leftover');
    expect(refusalReport(why!)).toBe(
      "rules not typed: its box already holds this CLI's exit text (/exit), unsent from an earlier stop; "
      + 'press Ctrl+U in its pane to clear it, then run up again',
    );
  });

  test('a resumed seat whose box already holds the line is verified and entered, never typed onto', async () => {
    const d = delivery();
    d.showText(fixture('rules-line'));
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Enter']);
  });

  test('a resumed seat whose box holds another seat\'s line is refused, nothing typed', async () => {
    // This CLI breaks the path mid-word (`…rules/im` / `plementer.md`), so the seat name itself
    // spans a row break; the other line is made by changing the path's project segment, which
    // one row holds whole. Any line but today's is leftover, never typed onto.
    const d = delivery();
    d.showText(fixture('rules-line').replace('demo-3f9c2a8e1d7b', 'demo-3f9c2a8e1d7c'));
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('leftover');
  });

  test('a resumed seat with an empty box is typed once, verified and sent', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(text === capturedLine ? fixture('rules-line') : boxed(text)); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test('the 1.3.5 rules box reads unsent and holds the line', () => {
    const screen = readFileSync(new URL('../fixtures/antigravity/1.3.5/rules-line.txt', import.meta.url), 'utf8');
    expect(readScreen('antigravity', screen).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', capturedLine, screen)).toBe(true);
  });

  test('the 1.3.5 rules box is read back and entered', async () => {
    const screen = readFileSync(new URL('../fixtures/antigravity/1.3.5/rules-line.txt', import.meta.url), 'utf8');
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(text === capturedLine ? screen : boxed(text)); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test('a mismatched read-back clears the line this run typed', async () => {
    const d = delivery();
    const keys: string[] = [];
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      return true;
    };
    d.io.key = (name) => { keys.push(name); d.show('idle'); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(keys).toEqual(['ctrl+u']);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.sent).toBe(false);
    expect(why?.cleared).toBe('yes');
    expect(refusalReport(why!)).toBe(
      "rules typed, not sent: the read-back didn't match; the line team typed was cleared (Ctrl+U); run up again",
    );
  });

  test('a clearing key the pane does not take leaves the line', async () => {
    const d = delivery();
    const keys: string[] = [];
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      return true;
    };
    d.io.key = (name) => { keys.push(name); return false; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(keys).toEqual(['ctrl+u']);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.cleared).toBe('undelivered');
    expect(refusalReport(why!)).toBe(
      "rules typed, not sent: the read-back didn't match; the clearing key (Ctrl+U) was not delivered; "
      + 'the line sits in its box, unsent: press Enter in its pane to send it, or clear the box (Ctrl+U), then run up again',
    );
  });

  test('a clearing key that leaves the box unsent names the reading', async () => {
    const d = delivery();
    const keys: string[] = [];
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      return true;
    };
    d.io.key = (name) => { keys.push(name); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(keys).toEqual(['ctrl+u']);
    const why = d.refusals.at(-1);
    expect(why?.cleared).toBe('stayed');
    expect(why?.kind).toBe('unsent');
    expect(refusalReport(why!)).toContain('the clearing key (Ctrl+U) left the screen reading unsent');
  });

  test('a box already holding someone else\'s text is not cleared', async () => {
    const d = delivery();
    const keys: string[] = [];
    d.io.key = (name) => { keys.push(name); return true; };
    d.showText(boxed('the person\'s own message'));
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(keys).toEqual([]);
  });

  test('a resumed line that then changes is not cleared', async () => {
    // The box already held today's line, so this run typed nothing. A later row that is not
    // the line's own is a read-back stop, and the key stays unsent.
    const d = delivery();
    const keys: string[] = [];
    let reads = 0;
    d.io.screen = () => {
      reads += 1;
      return reads <= 2 ? fixture('rules-line') : fixture('rules-line').replace('your brief.', 'your brief!');
    };
    d.io.key = (name) => { keys.push(name); d.show('idle'); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(keys).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('read-back');
    expect(d.refusals.at(-1)?.cleared).toBeUndefined();
  });
});

/** A scripted host whose pane starts at the wrapper's shell: `zsh` in front, a shell prompt
 *  drawn, herdr with no agent to report. The CLI takes the pane at `upAt`, drawing `first` as
 *  its first frame and reporting idle. Typing while the shell still holds the pane throws:
 *  nothing may be typed into the wrapper's shell. */
describe('Antigravity rules delivery through a wrapper', () => {
  const SHELL = 'Last login: Mon Oct  5 09:12:44 on ttys011\n~/Code/acme % ';

  function wrapper(upAt: number, first: 'idle' | 'trust' = 'idle') {
    let clock = 0;
    let up = false;
    let status: string | null = null;
    let raw: string | null = null; // the CLI's frames once it is up; the wrapper's shell before
    const calls: string[] = [];
    const refusals: Refusal[] = [];
    const io: Delivery = {
      screen: () => raw ?? SHELL,
      status: () => status,
      report: (why) => { refusals.push(why); },
      file: () => true, // the delivery tests prove the line, not the file
      type(text) {
        if (raw === null) throw new Error('typed into the wrapper\'s shell');
        calls.push(text);
        raw = boxed(text);
        return true;
      },
      enter() {
        calls.push('Enter');
        raw = fixture('working');
        status = 'working';
        return true;
      },
      foreground: () => (raw === null ? ['zsh'] : ['agy']),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (!up && clock >= upAt) {
          up = true;
          raw = fixture(first);
          status = 'idle'; // herdr reports a prompt, even a dialog, as idle
        }
      },
    };
    return { io, calls, refusals, at: () => clock };
  }

  test('the line is delivered once the CLI takes the pane off the wrapper\'s shell', async () => {
    // The wrapper's shell holds the pane for 350 ms; the CLI then draws its idle box. Nothing
    // is typed before that — `type` would throw — and the delivery reads the box and sends.
    const d = wrapper(350);
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
    expect(d.at()).toBeGreaterThanOrEqual(350);
  });

  test('a CLI that never takes the pane gives up at the deadline, saying the CLI never appeared', async () => {
    const d = wrapper(Number.POSITIVE_INFINITY);
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toEqual([{ stop: 'launch', typed: false, sent: false, kind: 'unknown', row: null, clearKey: 'ctrl+u' }]);
    expect(d.at()).toBe(1000); // the whole second, not a refusal at the first poll
    expect(refusalReport(d.refusals[0]!)).toContain(
      'the CLI never appeared as its pane\'s foreground process (the screen read unknown)',
    );
  });

  test('a live CLI whose frame never becomes the idle box gives up on the reading it saw', async () => {
    // The process is the CLI from the first poll, but the frame it draws is never a box this
    // version recognises: the wait runs out and the refusal names the reading.
    let clock = 0;
    const refusals: Refusal[] = [];
    const io: Delivery = {
      screen: () => SHELL,
      status: () => 'idle',
      report: (why) => { refusals.push(why); },
      file: () => true,
      type: () => { throw new Error('nothing may be typed'); },
      enter: () => false,
      foreground: () => ['agy'],
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    };
    expect(await deliverRules('antigravity', 'Rules.', 1, io)).toBe(false);
    expect(refusals).toEqual([{ stop: 'screen', typed: false, sent: false, kind: 'unknown', row: null, clearKey: 'ctrl+u' }]);
  });

  test('a dialog at the CLI\'s first frame is refused at once, nothing typed', async () => {
    // The wrapper's shell gives way to the CLI's trust dialog: the delivery refuses the moment
    // the dialog is read, without waiting the deadline out.
    const d = wrapper(100, 'trust');
    expect(await deliverRules('antigravity', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals).toEqual([{ stop: 'screen', typed: false, sent: false, kind: 'trust', row: null, clearKey: 'ctrl+u' }]);
    expect(d.at()).toBe(100);
  });
});
