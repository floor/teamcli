import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { boxHoldsText, deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';
import { profileFor } from '../../src/profiles/profile.ts';
import { readScreen } from '../../src/watch/screen.ts';
import { claudeBox } from '../helpers.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/claude-code/2.1.289/${name}.txt`, import.meta.url), 'utf8');
const current = (name: string) => readFileSync(new URL(`../fixtures/claude-code/2.1.302/${name}.txt`, import.meta.url), 'utf8');

/** The window the pane shows while a turn runs: the box back to empty, the footer's own line
 *  saying so. `deliverRules` observes this after the Enter. */
const busy = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5 · esc to interrupt\n`;

function delivery() {
  let raw = fixture('idle-suggestion-plain');
  let status = 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery tests prove the line, not the file
    // The paste renders as the box the CLI draws for its text.
    type(text) { calls.push(text); raw = claudeBox(text); return true; },
    enter() { calls.push('Enter'); raw = busy; status = 'working'; return true; },
    foreground: () => ['claude'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { io, calls, refusals, showText: (screen: string) => { raw = screen; } };
}

const ROGUE = '─'.repeat(40);

describe('Claude Code rules delivery', () => {
  test('no pane messaging, the rules line is never typed; was: recognised idle, pasted text, then observed working with empty input', async () => {
    const d = delivery();
    const retired = await deliverRules('claude-code', 'Rules.', 1, d.io);
    expect(retired).toBe(false);
  });

  test('the captured typed box reads back as its text and is entered', () => {
    // unsent-typed-ansi.txt: the box as the pane drew it for "Fix the" — both rules are
    // unbroken runs of ─ from the pane's first column, and the closing one is the window's
    // last rule row, the footers under it.
    expect(boxHoldsText('claude-code', 'Fix the', fixture('unsent-typed-ansi'))).toBe(true);
  });

  test('no pane messaging, the rules line is never typed; was: a rule-looking row after the wrapped text gets no Enter', async () => {
    // The round-5 reproduction: the box shows the two text rows, then one more indented row
    // of forty ─ before its closing rule. The pane draws content rows at the text's own
    // column, and the box's closing rule is the window's last rule row — an unbroken run from
    // the pane's first column, the opening rule's own width. The extra row is neither, so the
    // box is not the typed text.
    const typed = 'alpha beta\ngamma delta';
    const screen = claudeBox([...typed.split('\n'), ROGUE].join('\n'));
    expect(boxHoldsText('claude-code', typed, screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    const retired = await deliverRules('claude-code', typed, 1, d.io);
    expect(retired).toBe(false);
  });

  test('no pane messaging, the rules line is never typed; was: a rule-looking row between two text rows gets no Enter', async () => {
    // The box shows the typed row, then a rule-looking row, then another text row. However the
    // row under the rule-looking one reads, that row is content the typed text does not have.
    const typed = 'alpha beta';
    const screen = claudeBox([typed, ROGUE, 'gamma delta'].join('\n'));
    expect(boxHoldsText('claude-code', typed, screen)).toBe(false);
    // The text that owns both text rows is not this box either: the row between them is not
    // the text's own.
    expect(boxHoldsText('claude-code', 'alpha beta\ngamma delta', screen)).toBe(false);
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(screen); return true; };
    const retired = await deliverRules('claude-code', typed, 1, d.io);
    expect(retired).toBe(false);
  });

  test('no pane messaging, the rules line is never typed; was: a box holding a person\'s own text gets no Enter', async () => {
    const d = delivery();
    d.io.type = (text) => { d.calls.push(text); d.showText(claudeBox('Other rules.')); return true; };
    const retired = await deliverRules('claude-code', 'Rules.', 1, d.io);
    expect(retired).toBe(false);
  });
});

describe('the prompt-glyph continuation row', () => {
  // The person's box holds their own text, then a continuation row at the content column
  // carrying only the CLI's prompt glyph. The input row is the box's first row under its
  // opening rule (unsent-typed-ansi.txt draws the prompt row there), never the last row whose
  // content begins with a glyph — a continuation row at the content column is content, and the
  // text above the input row is never dropped from the read.
  const GLYPH = '❯';

  test('the box reads unsent, never idle: the person\'s text is in it', () => {
    expect(readScreen('claude-code', claudeBox(`person text\n${GLYPH}`)).kind).toBe('unsent');
  });

  test('the read-back after typing refuses: the box holds the person\'s row too', () => {
    // The pane appends the typed text after the glyph: `person text` / `> Rules.`. The box is
    // not the typed text alone, so no read-back is this delivery's to trust.
    const shown = claudeBox(`person text\n${GLYPH} Rules.`);
    expect(boxHoldsText('claude-code', 'Rules.', shown)).toBe(false);
  });

  test('a full delivery records no Enter', async () => {
    const d = delivery();
    d.showText(claudeBox(`person text\n${GLYPH}`));
    d.io.type = (text) => { d.calls.push(text); d.showText(claudeBox(`person text\n${GLYPH} ${text}`)); return true; };
    expect(await deliverRules('claude-code', 'Rules.', 1, d.io)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test('the glyph row in the middle, a glyph row with text after it, and two glyph rows all leave the text above them in the box', () => {
    // The glyph row in the middle of a three-row box: the rows below it are still the
    // person's, and neither row alone reads back as the box.
    const middle = claudeBox(`person text\n${GLYPH}\nanother line of theirs`);
    expect(readScreen('claude-code', middle).kind).toBe('unsent');
    expect(boxHoldsText('claude-code', 'another line of theirs', middle)).toBe(false);
    // A glyph row followed by text (`> quoted` at the content column): it is one content row,
    // not a second prompt row, so the box does not read back as `quoted`.
    const quoted = claudeBox(`person text\n${GLYPH} quoted`);
    expect(boxHoldsText('claude-code', 'quoted', quoted)).toBe(false);
    // Two glyph rows: the person's text is above both, and the box stays unsent.
    const two = claudeBox(`person text\n${GLYPH}\n${GLYPH}`);
    expect(readScreen('claude-code', two).kind).toBe('unsent');
    expect(boxHoldsText('claude-code', 'Rules.', claudeBox(`person text\n${GLYPH}\n${GLYPH} Rules.`))).toBe(false);
  });
});

describe('Claude Code 2.1.302 captures', () => {
  test('the captures the launch reads are the profile\'s tested ceiling', () => {
    const profile = profileFor('claude-code');
    if (profile === null) throw new Error('the claude-code profile is gone');
    expect(profile.tested.to).toBe('2.1.302');
  });

  test('trust, idle, unsent, working, question, permission and exit read as those kinds', () => {
    expect(readScreen('claude-code', current('trust')).kind).toBe('trust');
    expect(readScreen('claude-code', current('idle')).kind).toBe('idle');
    expect(readScreen('claude-code', current('unsent')).kind).toBe('unsent');
    expect(readScreen('claude-code', current('working')).kind).toBe('working');
    expect(readScreen('claude-code', current('question')).kind).toBe('question');
    expect(readScreen('claude-code', current('permission')).kind).toBe('permission');
    expect(readScreen('claude-code', current('exit')).kind).toBe('unknown');
  });
});
