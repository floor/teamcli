// Muse 1.4.14 draws its rotating composer hints in a grey foreground instead of faint. The
// profile declares that foreground, and an input row that matches no equals line is read as the
// empty box only when every visible character after the prompt is that one colour. This is the
// builder-6 scene of 2026-11-05: the hint read as an unsent draft, so no wake was ever typed.
// The frame is a sanitized derivative of the captured 1.4.14 idle box (test/fixtures/muse/1.4.14)
// with the live pane's hint row; no pane id or account text is in it.
//
// Fail-closed cases, as agreed for careful review: typed blue stays text, an undeclared colour
// stays text, a mixed-colour row stays text, a bold word stays text, an inverse cell stays text,
// and a plain unstyled row keeps the equals-list fallback. A faint row is idle as before.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse');
const HINT_FRAME = readFileSync(join(FIXTURES, '1.4.14', 'hint-grey-synthetic.txt'), 'utf8');
const FAINT_GOAL = readFileSync(join(FIXTURES, '1.4.11', 'goal-hint-dim.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, '1.4.11', 'working-synthetic.txt'), 'utf8');

const HINT_TEXT = 'Ask to monitor a running build or log and get pinged on changes';
const PROMPT_BLUE = '\x1b[0m\x1b[38;2;90;160;255m❯ \x1b[0m';
const HINT_ROW = `${PROMPT_BLUE}\x1b[38;2;103;108;116m${HINT_TEXT}\x1b[0m`;
const TRIGGER_LINE = 'Read /t/mail/msg-01 and act on it.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The same 1.4.14 box with its input row replaced, so only the row's own bytes differ. */
function withInputRow(row: string): string {
  return HINT_FRAME.replace(HINT_ROW, row);
}

function makeWakeHost(
  screenAt: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return enters;
    },
  };
}

describe('Muse 1.4.14 grey hint (builder-6 scene)', () => {
  test('the declared hint foreground reads as the empty box, and a wake types into it', async () => {
    expect(HINT_FRAME).toContain(HINT_ROW);
    expect(readScreen('muse', HINT_FRAME).kind).toBe('idle');
    expect(classifyComposer('muse', HINT_FRAME.split('\n')).kind).toBe('idle');
    expect(readBox('muse', HINT_FRAME)).toBeNull();
    expect(boxHoldsText('muse', HINT_TEXT, HINT_FRAME)).toBe(false);

    const typed = withInputRow(`${PROMPT_BLUE}\x1b[38;2;90;160;255m${TRIGGER_LINE}\x1b[0m`);
    const wake = makeWakeHost((read, enters) => (enters > 0 ? WORKING : read < 2 ? HINT_FRAME : typed));
    const out = await deliverTypedWake(wake.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(wake.typed).toEqual([TRIGGER_LINE]);
    expect(wake.enters).toBe(1);
  });

  test('an undeclared colour, a mixed row, a bold word and an inverse cell stay text', () => {
    const cases: Array<{ label: string; row: string }> = [
      { label: 'typed blue (1.4.14 draws typed text in 38;2;90;160;255)', row: `${PROMPT_BLUE}\x1b[38;2;90;160;255m${HINT_TEXT}\x1b[0m` },
      { label: 'grey SGR 90 is not the declared colour', row: `${PROMPT_BLUE}\x1b[90m${HINT_TEXT}\x1b[0m` },
      { label: '256-colour grey is not the declared colour', row: `${PROMPT_BLUE}\x1b[38;5;244m${HINT_TEXT}\x1b[0m` },
      { label: 'mixed colours in one row', row: `${PROMPT_BLUE}\x1b[38;2;103;108;116mAsk to monitor a \x1b[38;2;120;125;130mrunning build or log and get pinged on changes\x1b[0m` },
      { label: 'a bold word in the declared colour', row: `${PROMPT_BLUE}\x1b[1;38;2;103;108;116m${HINT_TEXT}\x1b[0m` },
      { label: 'an inverse cell in the declared colour', row: `${PROMPT_BLUE}\x1b[38;2;103;108;116mAsk to \x1b[7mm\x1b[27monitor a running build or log and get pinged on changes\x1b[0m` },
    ];
    for (const item of cases) {
      const frame = withInputRow(item.row);
      expect(readScreen('muse', frame).kind).toBe('unsent');
      expect(classifyComposer('muse', frame.split('\n')).kind).toBe('unsent');
      expect(readBox('muse', frame)?.first).toBe(HINT_TEXT);
      expect(boxHoldsText('muse', HINT_TEXT, frame)).toBe(true);
    }
  });

  test('a plain unstyled row still goes by the equals list, so unlisted prose stays text', () => {
    const frame = withInputRow(`❯ ${HINT_TEXT}`);
    expect(readScreen('muse', frame).kind).toBe('unsent');
    expect(readBox('muse', frame)?.first).toBe(HINT_TEXT);
    expect(boxHoldsText('muse', HINT_TEXT, frame)).toBe(true);
  });

  test('a faint /goal hint is still the empty box', () => {
    expect(readScreen('muse', FAINT_GOAL).kind).toBe('idle');
    expect(readBox('muse', FAINT_GOAL)).toBeNull();
  });

  test('a wake never types when the second read shows a typed blue draft', async () => {
    const draft = withInputRow(`${PROMPT_BLUE}\x1b[38;2;90;160;255mship the patch\x1b[0m`);
    const wake = makeWakeHost((read) => (read === 0 ? HINT_FRAME : draft));
    const out = await deliverTypedWake(wake.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed',
    });
    expect(wake.typed).toEqual([]);
    expect(wake.enters).toBe(0);
  });
});
