import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { profileFor } from '../../src/profiles/index.ts';
import { launchCommand, versionVerdict } from '../../src/profiles/profile.ts';
import { classify, classifyComposer, readScreen } from '../../src/watch/screen.ts';
import { runningModel } from '../../src/status/statusline.ts';
import { boxHoldsText, deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { rulesLine } from '../../src/launch/rules-file.ts';
import { upPlan } from '../../src/launch/plan.ts';
import { SAMPLE_RULES, wordWrap } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

const codex = profileFor('codex');
if (!codex) throw new Error('codex has no profile');

describe('Codex launch and captured screens', () => {
  test('unattended flags are launch arguments; rules are a first message', () => {
    expect(launchCommand(codex, 'codex -m gpt-6-sol', 'Rules.')).toBe('AGENT_UNATTENDED=1 codex -m gpt-6-sol -a never -s danger-full-access --no-daemon --no-alt-screen');
    expect(codex.rulesOption).toBeNull();
    expect(codex.loginCheck).toEqual(['login', 'status']);
    expect(codex.exit).toBe('/exit');
    expect(versionVerdict('codex-cli 0.157.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.160.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.161.0', codex.tested)).toBe('tested');
    expect(versionVerdict('codex-cli 0.162.0', codex.tested)).toBe('newer');
  });
  test.each([
    ['idle', 'idle'], ['unsent', 'unsent'], ['working', 'working'],
    ['typed-two-lines', 'unsent'], ['pasted-two-lines', 'unsent'], ['second-line-glyph', 'unsent'],
    ['second-line-gt', 'unsent'], ['wrapped-line', 'unsent'], ['blank-middle', 'unsent'],
    ['rules-accepted', 'idle'], ['startup', 'vendor notice'], ['startup-loading', 'unknown'], ['trust', 'trust'],
    ['exit-typed', 'unsent'], ['exit', 'unknown'], ['permission', 'permission'],
  ] as const)('%s capture has %s composer shape', (file, kind) => {
    // A working screen never permits input, even if herdr's status has not caught up.
    expect(readScreen('codex', fixture(file)).kind).toBe(kind);
  });
  test('a permission dialog above the pinned status line is the dialog, not unsent text', () => {
    // `permission-pinned` is constructed, not captured: the captured dialog with the captured
    // status line below it (see the fixtures README). Read before the fix: `unsent` — the
    // composer took the choice line for an input prompt, and the floor's markers missed the
    // dialog's lower-case `esc to cancel` below it.
    const pinned = fixture('permission-pinned');
    expect(classify('codex', pinned.split('\n')).kind).toBe('permission');
    expect(readScreen('codex', pinned).kind).toBe('permission');
    // The composer alone never says idle or unsent on the dialog either: `deliverRules` waits
    // on that reading after the paste.
    expect(classifyComposer('codex', pinned.split('\n')).kind).toBe('unknown');
  });
  test('a trust dialog with a running turn beside it is still trust, not working', () => {
    // The turn's own status line stays on the pane while the dialog is up: the dialog shape is
    // read first, as for claude-code.
    const screen = fixture('trust').replace(
      '› 1. Trust and continue',
      '• Working (0s • esc to interrupt)\n\n› 1. Trust and continue',
    );
    expect(readScreen('codex', screen).kind).toBe('trust');
  });
  test('permission takes precedence over a running turn and requires an active footer', () => {
    const captured = fixture('permission');
    const working = captured.replace('› 1. Yes', '• Working (0s • esc to interrupt)\n\n› 1. Yes');
    expect(readScreen('codex', working).kind).toBe('permission');
    expect(readScreen('codex', captured + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', captured.replace('Press enter to confirm or esc to cancel', '')).kind).toBe('unknown');
  });
  test('unknown, shell and unobserved dialogs never count as idle', () => {
    for (const screen of [undefined, '❯\n', '›\n', 'Welcome to Codex\nSign in to continue', 'Do you allow this command?\n› 1. Yes\nEnter to confirm']) {
      expect(readScreen('codex', screen).kind).toBe('unknown');
    }
    expect(readScreen('codex', fixture('idle').replace('GPT-5.6-Terra medium ·', 'new footer')).kind).toBe('unknown');
  });
  test('a quoted trust dialog is not an active dialog, and multiline input is not empty', () => {
    expect(readScreen('codex', fixture('trust') + fixture('rules-accepted')).kind).toBe('idle');
    expect(readScreen('codex', fixture('idle').replace('› Ask Codex to do anything', '›\n  unsent second line')).kind).toBe('unsent');
  });
  test('launch model ids and the captured footer map to separate model and version fields', () => {
    expect(codex.modelOf('codex -m gpt-6-sol -c model_reasoning_effort=high')).toEqual({ model: 'GPT Sol', version: '6' });
    expect(codex.modelOf('codex --model=gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m gpt-6-sol -m gpt-5.6-terra')).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(codex.modelOf('codex -m unknown')).toBeNull();
    expect(codex.modelOf('launcher')).toBeNull();
    expect(runningModel('codex', fixture('idle'))).toEqual({ model: 'GPT Terra', version: '5.6' });
    expect(runningModel('codex', fixture('trust'))).toBeNull();
  });
  test('the plan delivers the one line through the guarded path, never a config file', () => {
    const line = rulesLine('/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/coder.md', '5e1d0a9c4b2f');
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true,
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesFile: { path: '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/coder.md', line } }] });
    expect(plan.find((step) => step.do?.do === 'deliver')?.do).toMatchObject({ do: 'deliver', cli: 'codex', rules: 'Rules.', line, seconds: 90 });
    const deliverStep = plan.find((step) => step.do?.do === 'deliver');
    expect(deliverStep?.kind === 'run' ? deliverStep.argv.at(-1) : undefined).toBe(line);
    expect(plan.some((step) => step.do?.do === 'ready')).toBe(false);
  });
  test('a message seat whose rules file has no typeable path is refused before anything is typed', () => {
    const plan = upPlan({ root: '.', session: 'scratch', sessionRunning: true, watchAlive: true,
      seats: [{ name: 'coder', cli: 'codex', launch: 'codex', cwd: '.', label: 'coder', stopped: false, rules: 'Rules.',
        repairLine: '`team remove coder --keep` then `team add coder`',
        rulesRefusal: "its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -" }] });
    expect(plan.some((step) => step.do?.do === 'deliver')).toBe(false);
    expect(plan.find((step) => step.kind === 'skip')?.text).toBe(
      "coder: would refuse: its rules file's path can't be typed safely: the read-back can't prove a path outside letters, digits and . _ / @ + -",
    );
  });
});

describe('the typed-newline captures (Codex)', () => {
  // Real captures (see the fixtures README): 2026-10-04, plain `codex --no-daemon`,
  // 163 by 47 — a two-line text typed with the CLI's newline key (Ctrl+J), a two-line text
  // in one write, a second line beginning with the prompt glyph and one with `>`, a long
  // line that wraps, and three lines with a blank middle. Every later line of the person's
  // text is drawn at the continuation column, two; none at the prompt column. They stay as
  // documentation of the continuation column; a row break may stand for at most one space,
  // never a newline, so no multi-line text reads back — the delivery is one line, and
  // nothing types a multi-line text.
  test.each([
    ['typed-two-lines', 'first typed line of the sample\nsecond typed line of the sample'],
    ['pasted-two-lines', 'first pasted line of the sample\nsecond pasted line of the sample'],
    ['second-line-glyph', 'the reply follows\n› quoted line beginning with the prompt glyph'],
    ['second-line-gt', 'a plain reply follows\n> line beginning with a greater-than sign'],
    ['blank-middle', 'first line above the blank\n\nthird line below the blank'],
  ] as const)('%s reads unsent, and its multi-line text no longer reads back', (file, text) => {
    expect(readScreen('codex', fixture(file)).kind).toBe('unsent');
    expect(boxHoldsText('codex', text, fixture(file))).toBe(false);
  });
  test('wrapped-line reads unsent and holds exactly its one line', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
    expect(readScreen('codex', fixture('wrapped-line')).kind).toBe('unsent');
    expect(boxHoldsText('codex', text, fixture('wrapped-line'))).toBe(true);
    expect(boxHoldsText('codex', `${text} more`, fixture('wrapped-line'))).toBe(false);
  });
});

/** The captured idle frame once `text` sits in the box: the placeholder row replaced, the text's
 *  first line after the prompt, every later line at the column the captures draw continuation
 *  rows in — two columns, the prompt's own width (see the fixtures README). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('› Ask Codex to do anything', body);
}

// The rules message the real capture holds, as team composed it: its lines sat at column zero,
// and Codex drew each later line through its own prompt column (see the fixtures README).
const CAPTURED_MESSAGE = [
  'Rules for this session, from the team file:',
  '- Do not use tools or edit files.',
  '- Do not change trust or configuration.',
  '- Reply only RULES_RECEIVED, then wait.',
].join('\n');

function delivery(initial = 'idle') {
  let raw = fixture(initial);
  let status = initial === 'working' ? 'working' : 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw, status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = boxed(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    foreground: () => ['codex'],
    now: () => clock, sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (name: string) => { raw = fixture(name); }, showText: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery', () => {
  test('recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });
  test('the captured multi-line box is not the text any more: typed, not sent', async () => {
    // The real capture, with the message as team once composed it. A row break may stand for at
    // most one space, never the newline between the lines, so the box never verifies and the
    // Enter is never the delivery's to send.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', CAPTURED_MESSAGE, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([CAPTURED_MESSAGE]);
    expect(d.refusals.at(-1)?.stop).toBe('read-back');
  });
  test('a box holding a person\'s own text gets no Enter', async () => {
    // The captured rules box against a different first message: the box is not the typed text.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('unsent'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with one character changed gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules!')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('the typed text with more below it gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed('Rules.\nand a line of their own')); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a box whose rows are the typed line word-wrapped on the pane is entered', async () => {
    // No Codex capture shows its composer wrapping a line, so no wrap is modelled for it: the
    // box rows must read back as the typed line laid out in order — the words that fit, the rest
    // continued at the prompt row's two columns — and then the Enter is the paste's.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    expect(rows.length).toBeGreaterThan(1);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(rows.join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([line, 'Enter']);
  });
  test('a word-wrapped box with one character changed gets no Enter', async () => {
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const changed = line.replace('signature', 'signatvre');
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(wordWrap(changed, 53 - 2).join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a word-wrapped box with a blank row between its rows gets no Enter', async () => {
    // An empty continuation row is not part of the wrapped line: the pane draws one only where
    // the text itself has a blank line, and this line has none.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed([firstRow, '', ...rest].join('\n'))); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('a blank line the typed text itself has is refused: a blank row is never the text\'s', async () => {
    // A blank row was the pane's drawing of a blank line the text had, when texts could hold
    // newlines. A row break may stand for at most one space, never a newline, so the blank row
    // never reads back and there is no Enter.
    const typed = 'Rules.\n\nMore rules.';
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(typed)); return true; };
    expect(await deliverRules('codex', typed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([typed]);
  });
  test('a trailing blank row after the word-wrapped line gets no Enter', async () => {
    // One empty row of the pane's own sits under the text — idle.txt and unsent.txt show it
    // between the text and the status line, and it is the box's frame, not content. A second
    // empty row is a row the text does not have: someone pressed a newline after it.
    const line = 'End every commit message and every pull request body with your signature, given below.';
    const rows = wordWrap(line, 53 - 2);
    const [firstRow = '', ...rest] = rows;
    const body = [`› ${firstRow}`, ...rest.map((row) => `  ${row}`), ''].join('\n');
    const screen = fixture('idle').replace('› Ask Codex to do anything', body);
    expect(boxHoldsText('codex', line, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    expect(await deliverRules('codex', line, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([line]);
  });
  test('two spaces typed, one shown, gets no Enter', async () => {
    // The shared read refuses a box that shows a single space where the typed text has two: the
    // wrap did not add or drop it. Every profile without a captured wrap reads the same way.
    expect(boxHoldsText('codex', 'alpha  beta', boxed('alpha beta'))).toBe(false);
  });
  test.each(['permission', 'trust', 'startup', 'unsent', 'exit', 'working'])('types nothing at %s', async (screen) => {
    const d = delivery(screen);
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test('a vendor notice at the first frame is refused at once, not waited out', async () => {
    // The reading is the first read's, and the refusal follows it before any wait: without the
    // vendor-notice branch the loop would poll the same screen to the deadline and report the
    // same reading from there. No sleep, no text, no key.
    const d = delivery('startup');
    let naps = 0;
    const napping = d.io.sleep;
    d.io.sleep = async (ms) => { naps++; return napping(ms); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(naps).toBe(0);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.kind).toBe('vendor notice');
  });
  test('working screen with a stale idle status still receives nothing', async () => {
    const d = delivery('working'); d.status('idle');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
  test.each(['trust', 'permission'])('a %s dialog appearing after paste gets no Enter', async (dialog) => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show(dialog); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test.each(['trust', 'permission'])('a %s dialog arriving at the final re-read gets no Enter', async (dialog) => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? dialog : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line appearing after paste gets no Enter', async () => {
    // Read before the fix: the dialog was `unsent` to both re-reads below, so the paste looked
    // submitted and the Enter went to the dialog's first choice.
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.show('permission-pinned'); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a permission dialog above the pinned status line arriving at the final re-read gets no Enter', async () => {
    const d = delivery(); let reads = 0;
    d.io.screen = () => fixture(++reads === 3 ? 'permission-pinned' : reads === 1 ? 'idle' : 'unsent');
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual(['Rules.']);
  });
  test('a swallowed Enter, working with pasted input, and a failed Enter are not delivery', async () => {
    for (const state of ['idle', 'working', 'failed']) {
      const d = delivery();
      d.io.enter = () => { d.status(state); return state !== 'failed'; };
      expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    }
  });
  test('a paste that has not rendered is awaited, never submitted blind', async () => {
    const d = delivery(); let clock = 0;
    d.io.type = () => true;
    d.io.now = () => clock;
    d.io.sleep = async (ms) => { clock += ms; d.showText(boxed('Rules.')); };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
  });
});

describe('the prompt-glyph continuation row (Codex)', () => {
  // The person's box holds their own text, then a continuation row at the content column
  // carrying only the prompt glyph. The input row is the row carrying the prompt at the
  // captures' own column — unsent.txt draws `›` at the pane's first column and content at the
  // second — never the last row whose content begins with a glyph.
  const GLYPH = '›';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('codex', boxed(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `› Rules.`.
    expect(boxHoldsText('codex', 'Rules.', boxed(`person text\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(boxed(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(boxed(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a glyph row with text after it and two glyph rows all leave the text above them in the box', () => {
    // `› quoted` at the content column is one content row, not a second prompt row.
    expect(boxHoldsText('codex', 'quoted', boxed(`person text\n${GLYPH} quoted`))).toBe(false);
    // Two glyph rows: the person's text is above both, and the box stays unsent.
    expect(readScreen('codex', boxed(`person text\n${GLYPH}\n${GLYPH}`)).kind).toBe('unsent');
    expect(boxHoldsText('codex', 'Rules.', boxed(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });

  test('a second glyph row at the prompt column fails closed: never idle, never entered', async () => {
    // The 0.2.1 boundary: the person's text on the input row and a second row carrying the
    // prompt at that same column (column 0, where unsent.txt draws the input and exit-typed.txt
    // keeps its menu row). The input row is the first prompt row after the frame boundary above
    // the box; continuations are drawn indented — two columns — and the transcript's `› …` rows
    // keep a blank row above the input, so a prompt row after the input is a shape no capture
    // explains, and the read is `unknown`: nothing is typed into it and no Enter is sent. Read
    // by its lowest row the box was idle; the paste went after the second glyph, the read-back
    // held only the typed text, and the Enter submitted both.
    const at = (typed = '') => fixture('idle')
      .replace('› Ask Codex to do anything', `› person text\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('the box\'s top frame (Codex)', () => {
  // What every capture draws directly above the input row: blank rows of the pane's own — one
  // in exit-typed.txt (row 20 above `› /exit`), two in idle.txt and unsent.txt (rows 13-14) —
  // and above that gap the transcript's last row, whatever it is (idle.txt's `  limit left.`
  // prose, exit-typed.txt's own `/exit` menu row). No capture draws a prompt row against a
  // non-blank row, so the top frame is the gap itself: the input row is the lowest prompt row
  // above the status line, and the row above it must be blank.
  //
  // A prompt row on the far side of the gap is the transcript's echo of the person's own sent
  // message, not a row of the box: working.txt (row 12) and rules-accepted.txt (rows 10-13)
  // draw the echo `› Rules for this session…` at column zero with the spinner or the response
  // between it and the frame, and every row of a person's box is drawn indented — unsent.txt's
  // wrapped continuations at column two, exit-typed.txt's alike — so no row of a box carries
  // the glyph at the prompt column across the gap. Reading the echo as a live row made every
  // post-send idle seat `unknown`, a seat that could then never be dispatched to or nudged;
  // the empty input row under the frame reads `idle`, exactly as main reads it. Codex's
  // typed-newline captures (typed-two-lines.txt, pasted-two-lines.txt, second-line-glyph.txt,
  // second-line-gt.txt, wrapped-line.txt, blank-middle.txt — see the fixtures README)
  // prove the continuation column, two: every later row of the person's box is drawn indented,
  // even one that begins with the prompt glyph; none is drawn at the prompt column. No shipped
  // capture shows the direct echo layout — something always sits between the echo and the
  // frame — so the constructed screens below stand in for it.
  const shaped = (body: string) => fixture('idle').replace('› Ask Codex to do anything', body);

  test('the transcript\'s echo over the gap leaves the empty box idle, and the typed text reads back exactly', async () => {
    // The routine post-send layout: the person's sent message echoed at the prompt column, the
    // captured blank frame, the empty input row. It reads `idle` on every reader and rules
    // delivery types and enters; the read-back holds exactly the typed text.
    const at = (typed = '') => shaped(`› person text\n\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('idle');
    expect(classify('codex', at().split('\n')).kind).toBe('idle');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('idle');
    expect(readScreen('codex', at('Rules.')).kind).toBe('unsent');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(true);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Rules.', 'Enter']);
  });

  test('two and three blank rows above the input read the same', () => {
    for (const gap of ['\n\n\n', '\n\n\n\n']) {
      expect(readScreen('codex', shaped(`› person text${gap}›`)).kind).toBe('idle');
    }
  });

  test('agent output between the echo and the frame reads idle', () => {
    // rules-accepted.txt in full: the echo at rows 10-13, `• RULES_RECEIVED` and the timestamp
    // between it and the frame, the empty input row last. The real capture, read as it always
    // was, with the new rule taking nothing from it.
    expect(readScreen('codex', fixture('rules-accepted')).kind).toBe('idle');
  });

  test('a second prompt row pressed against the one above it fails closed', async () => {
    // Round 1's must-fix, unchanged: no blank row separates the person's row from the later
    // prompt, so the row above the lowest prompt is not the frame and the input row cannot be
    // shown to be the box's top. Nothing is typed and Enter is not sent.
    const at = (typed = '') => shaped(`› person text\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a blank row, a continuation row, then a prompt fails closed', () => {
    // Nothing between the person's first row and the later prompt explains it: the row the
    // captures draw directly above an input row is blank, and this one carries content.
    const at = shaped('› person text\n\n  more of theirs\n›');
    expect(readScreen('codex', at).kind).toBe('unknown');
    expect(classifyComposer('codex', at.split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', shaped('› person text\n\n  more of theirs\n› Rules.'))).toBe(false);
  });

  test('a window starting inside the box fails closed', async () => {
    // The reviewer's second must-fix: the input row scrolled out, a visible indented
    // continuation, then `›`. Read from the lowest prompt row the box was idle; the rows
    // above it — a continuation the captures only draw inside a box — were discarded. The
    // row directly above the prompt is not blank here, so it is not an input row.
    const at = (typed = '') => shaped(`  person-owned visible continuation\n›${typed === '' ? '' : ` ${typed}`}`);
    expect(readScreen('codex', at()).kind).toBe('unknown');
    expect(classify('codex', at().split('\n')).kind).toBe('unknown');
    expect(classifyComposer('codex', at().split('\n')).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', at('Rules.'))).toBe(false);
    const d = delivery();
    d.showText(at());
    d.io.type = (text) => { d.calls.push(text); d.showText(at(text)); return true; };
    expect(await deliverRules('codex', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('a window whose top frame scrolled off reads unknown', () => {
    // Only the prompt and the status line visible: the gap every capture draws above the
    // input row is not in the window, so the row cannot be shown to be the box's top — it
    // may be a caret line of a box whose first rows scrolled off. No real idle/unsent
    // capture is this shape: every one keeps the status line last with the box under its
    // transcript, so the crop never starts at the prompt.
    const lines = fixture('idle').split('\n');
    const at = lines.findIndex((line) => line === '› Ask Codex to do anything');
    const only = lines.slice(at).join('\n');
    expect(readScreen('codex', only).kind).toBe('unknown');
    const held = only.replace('› Ask Codex to do anything', '› Rules.');
    expect(readScreen('codex', held).kind).toBe('unknown');
    expect(boxHoldsText('codex', 'Rules.', held)).toBe(false);
  });

  test('the real exit-typed capture keeps its box: its menu row sits above the frame, not in the box', () => {
    // The guard the two must-fixes must not break: exit-typed.txt draws `› /exit  exit Codex`
    // (the menu), a blank row, then `› /exit` — the same prompt-blank-prompt shape the
    // constructed must-fixes use, but the lowest prompt row holds the person's text, so it is
    // the input row and the menu row above the frame is read as nothing.
    const screen = fixture('exit-typed');
    expect(readScreen('codex', screen).kind).toBe('unsent');
    expect(boxHoldsText('codex', '/exit', screen)).toBe(true);
    expect(boxHoldsText('codex', 'Rules.', screen)).toBe(false);
  });
});

// The captures taken on 2026-10-05 at 54 by 23, the pane `up` creates (codex-cli 0.160.0, the
// flags the fixtures README names). The captures of the whole message stay as documentation
// of the box's own limits; the delivery itself is the one line of rules-line.txt.
const capture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.160.0/${name}.txt`, import.meta.url), 'utf8');

/** The fitted texts these captures were typed with: numbered rows of a sample line, one row
 *  per drawn row at the pane's 50 content columns. */
const fitted = (rows: number) => Array.from({ length: rows }, (_, i) => `row ${i + 1} of the fitted sample text`).join('\n');

/** A box Codex draws for `text` at those 50 columns: the line word-wrapped, the first row after
 *  the prompt, the rest at the two-column continuation column (the typed-newline captures). */
function drawn(text: string): string {
  const [first = '', ...rest] = wordWrap(text, 50);
  return [`› ${first}`, ...rest.map((row) => `  ${row}`)].join('\n');
}

test('the box limits: 16 rows read back, 17 and more read unknown', () => {
  // rules-fit-16.txt is the tallest box whose input row, frame and status row all fit the
  // reading window; from 17 rows the window starts at the input row itself and the core reads
  // unknown, however complete the screen looks (rules-fit-17.txt) — and at 19 the pane's own
  // scroll begins (rules-fit-19.txt is complete but unknown, rules-fit-20.txt has dropped its
  // first typed row). The whole rules message drew 30 rows at 50 columns (rules-scrolled.txt),
  // which is why the rules now travel as a file and one line.
  for (const rows of [5, 12, 16]) {
    expect(readScreen('codex', capture(`rules-fit-${rows}`)).kind).toBe('unsent');
  }
  for (const rows of [17, 19, 20]) {
    expect(readScreen('codex', capture(`rules-fit-${rows}`)).kind).toBe('unknown');
  }
  expect(readScreen('codex', capture('rules-scrolled')).kind).toBe('unknown');
  // The fitted texts are multi-line, and a row break may stand for at most one space, never
  // a newline: no multi-line text reads back at any height, and nothing types one. The
  // captures stay as documentation of the window's edge.
  for (const rows of [5, 12, 16, 17, 19, 20]) {
    expect(boxHoldsText('codex', fitted(rows), capture(`rules-fit-${rows}`))).toBe(false);
  }
  expect(boxHoldsText('codex', SAMPLE_RULES, capture('rules-scrolled'))).toBe(false);
  // A pane after a sent and answered turn reads the same (rules-part-16-after-reply.txt).
  expect(readScreen('codex', capture('rules-part-16-after-reply')).kind).toBe('unsent');
  expect(boxHoldsText('codex', fitted(16), capture('rules-part-16-after-reply'))).toBe(false);
});

// The line the 2026-10-05 capture holds, as `team` composes it: the same path and hash the
// fixtures README names, through the function that builds it. The box draws it as four rows,
// word-wrapped; the breaks after `your` and `and` each hide the line's own single space.
const CAPTURED_PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md';
const capturedLine = rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f');

/** A Codex pane 54 by 23 that answers the typed line with the real capture and a submitted line
 *  like the captured turn: the turn paints the pane while it runs. */
function lineDelivery() {
  let raw = capture('idle');
  let status = 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    type(text) {
      calls.push(text);
      raw = text === capturedLine ? capture('rules-line') : drawn(text);
      return true;
    },
    enter() {
      calls.push('Enter');
      raw = fixture('working');
      status = 'working';
      return true;
    },
    foreground: () => ['codex'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, show: (screen: string) => { raw = screen; }, status: (value: string) => { status = value; } };
}

describe('Codex rules delivery of the one line (0.160.0 capture)', () => {
  test('the captured line reads unsent and holds exactly the line', () => {
    const screen = capture('rules-line');
    expect(readScreen('codex', screen).kind).toBe('unsent');
    expect(boxHoldsText('codex', capturedLine, screen)).toBe(true);
    // Anything the seat might hold instead: one character more, the line without its final
    // full stop, another seat's path, an older hash of the same rules.
    expect(boxHoldsText('codex', `${capturedLine} again`, screen)).toBe(false);
    expect(boxHoldsText('codex', capturedLine.slice(0, -1), screen)).toBe(false);
    expect(boxHoldsText('codex', rulesLine(CAPTURED_PATH.replace('implementer', 'scribe'), '5e1d0a9c4b2f'), screen)).toBe(false);
    expect(boxHoldsText('codex', rulesLine(CAPTURED_PATH, '4d0c9f8b3a2e'), screen)).toBe(false);
  });

  test('the line is typed once at an empty prompt, read back row by row, and entered once', async () => {
    const d = lineDelivery();
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });

  test.each([
    ['in the path', ['3f9c2a8e1d7b', '3f9c2a8e1d7c']],
    ['in the hash', ['5e1d0a9c4b2f', '5e1d0a9c4b2e']],
    ['in a word of the line', ['standing rules', 'stunding rules']],
    ['in the final full stop', ['wait for your brief.', 'wait for your brief!']],
  ] as const)('one character changed %s gets no Enter', async (what, [from, to]) => {
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line').replace(from, to)); return true; };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.typed).toBe(true);
    expect(why?.sent).toBe(false);
    expect(why?.row).not.toBeNull();
    expect(refusalReport(why!)).toContain("the read-back didn't match");
  });

  test('a row of the line with one character more than the line has gets no Enter', async () => {
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line').replace('wait for your brief.', 'wait for your brief. x')); return true; };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
  });

  test('the line with one character more than the box shows gets no Enter', async () => {
    // The other way round: the box draws the line's own four rows, and the text claims a
    // fifth the pane never drew.
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', `${capturedLine} x`, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([`${capturedLine} x`]);
  });

  test('two spaces in the line where the row break hides one get no Enter', async () => {
    // The captured break after `your` hides the line's single space. A line with two spaces
    // there draws the same rows — the read-back refuses it: a break may stand for exactly one
    // space, never a run of them.
    const doubled = capturedLine.replace('your standing', 'your  standing');
    expect(boxHoldsText('codex', doubled, capture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', doubled, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([doubled]);
  });

  test('a tab in the line gets no Enter', async () => {
    const tabbed = capturedLine.replace('Read ', 'Read\t');
    expect(boxHoldsText('codex', tabbed, capture('rules-line'))).toBe(false);
    const d = lineDelivery();
    d.io.type = (text) => { d.calls.push(text); d.show(capture('rules-line')); return true; };
    expect(await deliverRules('codex', tabbed, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([tabbed]);
  });

  test('a trust dialog at the final re-read gets no Enter', async () => {
    // The other way round: the line reads back in the loop, and the re-read that immediately
    // precedes the Enter sees the dialog. Without that re-read the Enter goes to the dialog's
    // first choice.
    const d = lineDelivery();
    d.io.type = (text) => {
      d.calls.push(text);
      let reads = 0;
      d.io.screen = () => (++reads <= 1 ? capture('rules-line') : fixture('trust'));
      return true;
    };
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('read-back');
    expect(why?.sent).toBe(false);
    expect(why?.kind).toBe('trust');
  });

  test('the file changing after it was written gets no Enter', async () => {
    // The line read back as its own rows; between that and the key, the file at its path no
    // longer holds the text whose hash the line names. Nothing is sent, and the report says
    // the file changed — the seat is never pointed at a file team cannot vouch for.
    const d = lineDelivery();
    d.io.file = () => false;
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('file-changed');
    expect(why?.sent).toBe(false);
    expect(refusalReport(why!)).toBe('rules typed, not sent: the rules file changed after it was written');
  });

  test('a seat mid-turn is reported as working; nothing is typed', async () => {
    const d = lineDelivery();
    d.status('working');
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('working');
    expect(refusalReport(why!)).toBe('rules not confirmed: the seat is working; run up again when it is idle');
  });

  test('a box already holding the person\'s own text is left alone', async () => {
    const d = lineDelivery();
    d.show(capture('idle').replace('› Ask Codex to do anything', drawn('the person\'s own message')));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    const why = d.refusals.at(-1);
    expect(why?.stop).toBe('leftover');
    expect(refusalReport(why!)).toContain('its box already holds text that is not the rules line');
  });

  test('a resumed seat whose box already holds the line is verified and entered, never typed onto', async () => {
    const d = lineDelivery();
    d.show(capture('rules-line'));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual(['Enter']);
  });

  test('a resumed seat whose box holds another seat\'s line is refused, nothing typed', async () => {
    const d = lineDelivery();
    d.show(capture('rules-line').replace('implementer', 'scribe'));
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
    expect(d.refusals.at(-1)?.stop).toBe('leftover');
  });

  test('a resumed seat with an empty box is typed once, verified and sent', async () => {
    const d = lineDelivery();
    expect(await deliverRules('codex', capturedLine, 1, d.io)).toBe(true);
    expect(d.calls).toEqual([capturedLine, 'Enter']);
  });
});
