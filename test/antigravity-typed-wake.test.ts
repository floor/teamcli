// The antigravity typed wake, read on the captured 1.4.12 frames in
// test/fixtures/antigravity/1.4.12/: the empty idle box, the same box under a compacted
// transcript, the braille spinner row of a running turn, and the `/exit` completion frame whose
// box holds `/exit`. The gate is the profile's own screens: nothing is typed unless two reads
// showed the empty idle prompt. A box that already holds exactly the line is not prompted and nothing is typed. The completion frame is a box holding other text, so it refuses.
// The scenes below script the pane; no CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen, screenData, screenWord, type Screen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const FIXTURES_142 = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2');
const FIXTURES_1216 = join(import.meta.dir, 'fixtures', 'antigravity', '1.2.16');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const IDLE_COMPACTED = readFileSync(join(FIXTURES, 'idle-compacted.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const EXIT_UNSENT = readFileSync(join(FIXTURES, 'exit-completion-unsent.txt'), 'utf8');
const FEEDBACK_SURVEY = readFileSync(join(FIXTURES, 'feedback-survey.txt'), 'utf8');
const SURVEY_PROMPT = "  How's the CLI experience so far? Help us improve:";
const SURVEY_CHOICES = '  [1] Good  [2] Fine  [3] Bad  [0] Skip';
const BARE_FEEDBACK_SURVEY = [
  '● Explored 1 file (implementer.md)',
  '  ready',
  '',
  SURVEY_PROMPT,
  SURVEY_CHOICES,
].join('\n');
const PERMISSION_DIALOG = readFileSync(join(FIXTURES_142, 'permission.txt'), 'utf8');
const QUESTION_DIALOG = readFileSync(join(FIXTURES_142, 'question.txt'), 'utf8');
const TRUST_DIALOG = readFileSync(join(FIXTURES_142, 'trust.txt'), 'utf8');
const CONFIRMATION_DIALOG = readFileSync(join(FIXTURES_1216, 'question-unsent-54.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The captured idle frame with `text` drawn in its empty input row: the `>` row between the
 *  box's two rules, never the transcript's own prompt line above them. The function form keeps
 *  `text`'s own characters literal, and puts the captured rule row back unchanged. */
function holding(text: string): string {
  return IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

/** The same frame with one extra row under the typed line, inside the box, before the closing rule. */
function holdingUnder(text: string, under: string): string {
  return IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n  ${under}\n${rule}\n`);
}

const TASKS_HINT = '/tasks shows your open tasks';

/** The captured working frame with `text` still in the composer. The spinner row keeps the
 *  screen working; the composer read is unsent while the line sits there. */
function workingHolding(text: string): string {
  return WORKING.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it.
 *  The trigger a send composes is not known until the send runs, so a scene that wants the box
 *  to read back the line draws the text the wake itself typed. `wait` costs nothing. */
function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[], keys: readonly string[]) => string | null,
  options: { typeOk?: boolean; enterOk?: boolean; keyOk?: boolean; key?: boolean; promptOk?: boolean } = {},
): { host: TypedWakeHost; typed: string[]; prompts: string[]; keys: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const prompts: string[] = [];
  const keys: string[] = [];
  const state = { enters: 0, prompts: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters + state.prompts, prompts.length > 0 ? prompts : typed, keys),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return options.typeOk ?? true;
    },
    enter: () => {
      state.enters += 1;
      return options.enterOk ?? true;
    },
    prompt: (_pane: string, text: string) => {
      prompts.push(text);
      state.prompts += 1;
      return options.promptOk ?? true;
    },
    wait: async () => {},
  };
  if (options.key !== false) {
    host.key = (_pane: string, key: string) => {
      keys.push(key);
      return options.keyOk ?? true;
    };
  }
  return {
    host,
    typed,
    prompts,
    keys,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

describe('the 1.4.12 frames the wake reads back', () => {
  test('the profile declares the wake, and the captured frames read as the gate needs', () => {
    expect(profileFor('antigravity')?.typedWake).toBe('screen');
    expect(readScreen('antigravity', IDLE).kind).toBe('idle');
    // A compacted transcript under the same box is still the empty idle prompt.
    expect(readScreen('antigravity', IDLE_COMPACTED).kind).toBe('idle');
    // A running turn: the braille spinner row is the acknowledgement.
    expect(readScreen('antigravity', WORKING).kind).toBe('working');
    // The `/exit` completion frame is a box holding text, never the empty prompt: its completion
    // row sits below the box's closing rule and the box itself holds `/exit`.
    expect(readScreen('antigravity', EXIT_UNSENT).kind).toBe('unsent');
    expect(readBox('antigravity', EXIT_UNSENT)).toMatchObject({ first: '/exit', rows: [] });
    expect(boxHoldsText('antigravity', LINE, EXIT_UNSENT)).toBe(false);
    // The trigger drawn into the captured idle box reads back as exactly that line.
    expect(readScreen('antigravity', holding(LINE)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, holding(LINE))).toBe(true);
    // The post-turn feedback survey at the bottom of the pane reads as a known dialog whose
    // single answer is '0' (Skip).
    expect((screenData('antigravity') as { feedbackSurvey?: { skipKey?: string } } | null)?.feedbackSurvey?.skipKey).toBe('0');
    expect(readScreen('antigravity', FEEDBACK_SURVEY).kind as string).toBe('feedback survey');
    expect(readScreen('antigravity', BARE_FEEDBACK_SURVEY).kind as string).toBe('feedback survey');
    expect(readScreen('antigravity', `${BARE_FEEDBACK_SURVEY}\n\n\n`).kind as string).toBe('feedback survey');
    expect(screenWord(readScreen('antigravity', FEEDBACK_SURVEY))).toBe('blocked');
  });

  test('only the exact two survey rows at the bottom of the pane match; transcript quotes and partial or altered rows never match', () => {
    expect(readScreen('antigravity', FEEDBACK_SURVEY).kind as string).toBe('feedback survey');
    expect(readScreen('antigravity', BARE_FEEDBACK_SURVEY).kind as string).toBe('feedback survey');
    // Quoted in the transcript above an idle or unsent composer box.
    const quotedAboveIdle = IDLE.replace('  ready\n', `  ready\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}\n`);
    expect(readScreen('antigravity', quotedAboveIdle).kind).toBe('idle');
    const quotedAboveUnsent = holding(LINE).replace('  ready\n', `  ready\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}\n`);
    expect(readScreen('antigravity', quotedAboveUnsent).kind).toBe('unsent');

    // Followed by any other non-blank transcript row at the bottom of the pane.
    expect(readScreen('antigravity', `${BARE_FEEDBACK_SURVEY}\n  Done.`).kind).toBe('unknown');
    expect(readScreen('antigravity', `${FEEDBACK_SURVEY.trimEnd()}\n  Done.`).kind).toBe('unknown');

    // Separated by a blank row, reversed, single-line, or altered options/wording.
    expect(readScreen('antigravity', `● Done.\n${SURVEY_PROMPT}\n\n${SURVEY_CHOICES}`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n${SURVEY_CHOICES}\n${SURVEY_PROMPT}`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n${SURVEY_PROMPT}`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n${SURVEY_CHOICES}`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n${SURVEY_PROMPT.trim()} ${SURVEY_CHOICES.trim()}`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n${SURVEY_PROMPT}\n  [1] Good  [2] Fine  [3] Bad`).kind).toBe('unknown');
    expect(readScreen('antigravity', `● Done.\n  How's the CLI experience so far?\n${SURVEY_CHOICES}`).kind).toBe('unknown');

    // Caution stages (working, permission, question, trust, confirmation) keep their own reading.
    expect(readScreen('antigravity', `${WORKING}\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}`).kind).toBe('working');
    expect(readScreen('antigravity', `${PERMISSION_DIALOG}\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}`).kind).toBe('permission');
    expect(readScreen('antigravity', `${QUESTION_DIALOG}\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}`).kind).toBe('question');
    expect(readScreen('antigravity', `${TRUST_DIALOG}\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}`).kind).toBe('trust');
    expect(readScreen('antigravity', `${CONFIRMATION_DIALOG}\n${SURVEY_PROMPT}\n${SURVEY_CHOICES}`).kind).toBe('confirmation');
  });
});

describe('the antigravity typed wake: the profile’s own screens gate the keys', () => {
  test('two idle reads, one line, one Enter on the captured frames: the spinner row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after the agent prompt', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen that still holds the line is not delivered until the box empties', async () => {
    const held = workingHolding(LINE);
    expect(readScreen('antigravity', held).kind).toBe('working');
    expect(boxHoldsText('antigravity', LINE, held)).toBe(true);
    let post = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      post += 1;
      return post < 3 ? held : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', { ...FAST, verifyMs: 3 });
    expect(post).toBe(3);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after the agent prompt', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen that keeps the line through the bound is not delivered', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? workingHolding(LINE) : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the working screen showed with the line still in the box after the agent prompt; the line was not submitted',
    });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a drawn line that one Enter leaves unsent is submitted again, and the line is not retyped', async () => {
    const drawn = holding(LINE);
    let settleReads = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) {
        settleReads += 1;
        return settleReads === 1 ? holding('Read') : drawn;
      }
      return enters === 1 ? drawn : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(settleReads).toBe(0);
    expect(readScreen('antigravity', drawn).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, drawn)).toBe(true);
    expect(out).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('the compacted-transcript idle frame still types: a long transcript is not a refusal', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE_COMPACTED : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out.delivered).toBe(true);
    expect(out.tries).toBe(1);
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working pane is never typed into', async () => {
    const pane = wakeFake(() => WORKING);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('the exit-completion frame refuses before a key: its box holds /exit', async () => {
    const pane = wakeFake(() => EXIT_UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a second read that shows the exit-completion frame stops the wake before any key', async () => {
    const pane = wakeFake((read) => (read === 0 ? IDLE : EXIT_UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a box that already holds the line is not prompted and nothing is typed', async () => {
    const held = holding(LINE);
    expect(readScreen('antigravity', held).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, held)).toBe(true);
    const pane = wakeFake(() => held);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the box already held the line; the agent prompt was not sent and nothing was typed',
    });
    expect(pane.prompts).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(pane.keys).toEqual([]);
  });

  test('the typed line plus the exact tasks hint row is submitted', async () => {
    const drawn = holdingUnder(LINE, TASKS_HINT);
    expect(readScreen('antigravity', drawn).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, drawn)).toBe(true);
    const pane = wakeFake((read, enters) => (read < 2 ? IDLE : enters > 0 ? WORKING : drawn));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after the agent prompt', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('the typed line plus a row that only starts like the tasks hint gets no Enter', async () => {
    const drawn = holdingUnder(LINE, `${TASKS_HINT} now`);
    expect(boxHoldsText('antigravity', LINE, drawn)).toBe(false);
    const pane = wakeFake((read) => (read < 2 ? IDLE : drawn));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a sitting line plus the exact tasks hint row is not prompted and nothing is typed', async () => {
    const drawn = holdingUnder(LINE, TASKS_HINT);
    expect(readScreen('antigravity', drawn).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, drawn)).toBe(true);
    const pane = wakeFake(() => drawn);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the box already held the line; the agent prompt was not sent and nothing was typed',
    });
    expect(pane.prompts).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(pane.keys).toEqual([]);
  });

  test('a sitting line whose second read is other text gets no Enter', async () => {
    const held = holding(LINE);
    const pane = wakeFake((read) => (read === 0 ? held : EXIT_UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out.delivered).toBe(false);
    expect(out.tries).toBe(0);
    expect(out.typed).toBe(false);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('an exit-completion frame drawn after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : EXIT_UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(boxHoldsText('antigravity', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt', submittedAt: expect.any(Number) });
    expect(spacesOnly.prompts).toEqual([LINE]);
    expect(spacesOnly.typed).toEqual([]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(readScreen('antigravity', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(internalSpaces.prompts).toEqual([LINE]);
    expect(internalSpaces.typed).toEqual([]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('a box with partial text refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    expect(readScreen('antigravity', holding(prefix)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, holding(prefix))).toBe(false);
    expect(boxHoldsText('antigravity', LINE, holding(suffix))).toBe(false);

    const beforeKey = wakeFake(() => holding(prefix));
    const outBefore = await deliverTypedWake(beforeKey.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outBefore).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(beforeKey.typed).toEqual([]);
    expect(beforeKey.enters).toBe(0);

    const afterPrefix = wakeFake((read) => (read < 2 ? IDLE : holding(prefix)));
    const outPrefix = await deliverTypedWake(afterPrefix.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outPrefix).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(afterPrefix.prompts).toEqual([LINE]);
    expect(afterPrefix.typed).toEqual([]);
    expect(afterPrefix.enters).toBe(0);

    const afterSuffix = wakeFake((read) => (read < 2 ? IDLE : holding(suffix)));
    const outSuffix = await deliverTypedWake(afterSuffix.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outSuffix).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
    expect(afterSuffix.prompts).toEqual([LINE]);
    expect(afterSuffix.typed).toEqual([]);
    expect(afterSuffix.enters).toBe(0);
  });

  test('captured dialog frames (permission, question, trust, confirmation) refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['permission', PERMISSION_DIALOG],
      ['question', QUESTION_DIALOG],
      ['trust', TRUST_DIALOG],
      ['confirmation', CONFIRMATION_DIALOG],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('antigravity', frame).kind).toBe(kind);
      expect(boxHoldsText('antigravity', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 1, reason: 'no working screen showed after the agent prompt' });
      expect(afterType.keys).toEqual([]);
      expect(afterType.prompts).toEqual([LINE]);
      expect(afterType.typed).toEqual([]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('the feedback survey is answered once with 0 (Skip), then two idle reads and guarded Enter deliver', async () => {
    for (const survey of [FEEDBACK_SURVEY, BARE_FEEDBACK_SURVEY]) {
      const screens = [survey, IDLE, IDLE, WORKING];
      const pane = wakeFake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
      const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after the agent prompt', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
      expect(pane.keys).toEqual(['0']);
      expect(pane.prompts).toEqual([LINE]);
      expect(pane.typed).toEqual([]);
      expect(pane.enters).toBe(0);
    }
  });

  test('the feedback survey is never answered a second time if 0 does not reveal an empty idle prompt', async () => {
    // Still showing the feedback survey after '0'.
    const staysSurvey = wakeFake(() => FEEDBACK_SURVEY);
    const outStays = await deliverTypedWake(staysSurvey.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outStays).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read feedback survey after the skip key, not an empty idle prompt; no wake line was typed',
    });
    expect(staysSurvey.keys).toEqual(['0']);
    expect(staysSurvey.typed).toEqual([]);
    expect(staysSurvey.enters).toBe(0);

    // Reveals an unsent draft after '0'.
    const revealsDraft = wakeFake((read) => (read === 0 ? FEEDBACK_SURVEY : holding('an owner draft')));
    const outDraft = await deliverTypedWake(revealsDraft.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outDraft).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read unsent after the skip key, not an empty idle prompt; no wake line was typed',
    });
    expect(revealsDraft.keys).toEqual(['0']);
    expect(revealsDraft.typed).toEqual([]);
    expect(revealsDraft.enters).toBe(0);

    // Second idle read after '0' is not idle.
    const secondNotIdle = wakeFake((read) => (read === 0 ? FEEDBACK_SURVEY : read === 1 ? IDLE : FEEDBACK_SURVEY));
    const outSecond = await deliverTypedWake(secondNotIdle.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outSecond).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the screen read feedback survey on the second idle read, not an empty idle prompt; nothing was typed',
    });
    expect(secondNotIdle.keys).toEqual(['0']);
    expect(secondNotIdle.typed).toEqual([]);
    expect(secondNotIdle.enters).toBe(0);

    // Host without key binding or key rejected refuses without typing.
    const unbound = wakeFake(() => FEEDBACK_SURVEY, { key: false });
    const outUnbound = await deliverTypedWake(unbound.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outUnbound).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the screen is at a feedback survey and no skip key is bound; nothing was typed',
    });
    expect(unbound.keys).toEqual([]);
    expect(unbound.typed).toEqual([]);
    expect(unbound.enters).toBe(0);

    const rejected = wakeFake(() => FEEDBACK_SURVEY, { keyOk: false });
    const outRejected = await deliverTypedWake(rejected.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outRejected).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the pane did not take the skip key; nothing was typed',
    });
    expect(rejected.keys).toEqual(['0']);
    expect(rejected.typed).toEqual([]);
    expect(rejected.enters).toBe(0);
  });
});

describe('team send: the antigravity typed wake', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  /** An antigravity seat with no declared order: the build's own default (`mcp-inbox, typed,
   *  drop`) is the walk these scenes read. */
  function agyWorld() {
    const made = world(null, [{ name: 'agy', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
    cleanups.push(made.cleanup);
    return made;
  }

  test('an antigravity seat is woken by one typed trigger, and the send is delivered', async () => {
    const made = agyWorld();
    // The send composes the trigger itself, so the box reads back whatever the wake typed.
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'hello'], io, host)).toBe(0);
    // The closing line ends with the record's id; the scene's subject is the outcome, not the id.
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nagy: delivered (typed wake)\n');
    // One agent prompt, no typed line and no Enter. The line names the seat's own read path,
    // never the body: antigravity has no inbox_check tool, so the hint says to run team drops.
    expect(pane.prompts).toEqual(['Message from owner (owner@acme): hello Read it with: run team drops --read']);
    expect(pane.prompts[0]!.length).toBeLessThanOrEqual(80);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    // The record was written under the seat lock before the line was typed.
    const drops = join(made.dir, 'send-drops', 'acme', 'agy');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'delivered (typed wake)', via: 'typed' });
      // `mcp-inbox` is not a delivery leg in this build (src/send/walk-cascade.ts): the inbox is
      // the store's reader, and a declared `mcp-inbox` word is reported as skipped, never
      // recorded in `failed`. The typed leg took the send, so nothing behind it failed.
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('an exit-completion frame leaves the message in the bus inbox, and the sender is told so', async () => {
    const made = agyWorld();
    const pane = wakeFake(() => EXIT_UNSENT);
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'hello'], io, host)).toBe(0);
    expect(io.out).toContain('agy: queued, not woken');
    expect(io.out).toContain('the typed wake failed (the first read showed unsent, not an empty idle prompt; nothing was typed)');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'queued, not woken', via: 'drop' });
      // The declared `mcp-inbox` word is skipped, not a failure; the typed leg is the one that
      // refused, and the drop leg then took the send.
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed unsent, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('a dialog frame in team send leaves the message in the bus inbox and types nothing', async () => {
    const made = agyWorld();
    const pane = wakeFake(() => PERMISSION_DIALOG);
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'hello'], io, host)).toBe(0);
    expect(io.out).toContain('agy: queued, not woken');
    expect(io.out).toContain('the typed wake failed (the first read showed permission, not an empty idle prompt; nothing was typed)');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'queued, not woken', via: 'drop' });
      // As above: the skipped `mcp-inbox` word is no failure, and the dialog is what refused the
      // typed leg.
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed permission, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('a feedback survey frame in team send is skipped once with 0, then woken and delivered', async () => {
    const made = agyWorld();
    const pane = wakeFake((_read, enters, typed, keys) => {
      if (enters > 0) return WORKING;
      if (typed.length > 0) return holding(typed[typed.length - 1] ?? '');
      if (keys.length > 0) return IDLE;
      return FEEDBACK_SURVEY;
    });
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nagy: delivered (typed wake)\n');
    expect(pane.keys).toEqual(['0']);
    expect(pane.prompts).toEqual(['Message from owner (owner@acme): hello Read it with: run team drops --read']);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a long summary and multi-line body on Antigravity truncates the header to fit <= 80 chars, keeps run team drops --read whole, and never types the body', async () => {
    const made = agyWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const longBody = `SUMMARY-${'G'.repeat(120)}\nSECOND-LINE-BODY-SECRET\nTHIRD-LINE-BODY-SECRET`;
    const io = owner(made.root);
    expect(await runSend(['agy', longBody], io, host)).toBe(0);
    expect(pane.prompts).toHaveLength(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const typedLine = pane.prompts[0]!;
    expect(typedLine.length).toBe(80);
    expect(typedLine.endsWith(' Read it with: run team drops --read')).toBe(true);
    expect(typedLine.startsWith('Message from owner (owner@acme): SUMMARY-')).toBe(true);
    expect(typedLine).not.toContain('\n');
    expect(typedLine).not.toContain('SECOND-LINE-BODY-SECRET');
    expect(typedLine).not.toContain('THIRD-LINE-BODY-SECRET');
    const drops = join(made.dir, 'send-drops', 'acme', 'agy');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed(longBody));
  });

  test('independent adversarial: line held while working through bound in send is not delivered, never retyped, and message stays unread; box cleared or partial line mid-poll refuses', async () => {
    // 1. Line held while working through the bound in `runSend` -> not delivered, never retyped, message still unread.
    const made = agyWorld();
    const pane = wakeFake((read, enters, typed) => {
      if (read < 2) return IDLE;
      const line = typed[typed.length - 1] ?? '';
      return enters === 0 ? holding(line) : workingHolding(line);
    });
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'check held'], io, host)).toBe(0);
    expect(io.out).toContain('agy: queued, not woken (drop, 0 ms); queued; the typed wake failed (the working screen showed with the line still in the box after the agent prompt; the line was not submitted)');
    expect(pane.prompts).toHaveLength(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const drops = join(made.dir, 'send-drops', 'acme', 'agy');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    const msgId = records[0]!;
    expect(existsSync(join(drops, `${msgId}.read.json`))).toBe(false);
    expect(listUnread(drops, { to: 'agy', root: made.root, session: 'acme' }, host.home).map((m) => m.id)).toEqual([msgId]);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the working screen showed with the line still in the box after the agent prompt; the line was not submitted',
      ]);
    }

    // 2. Box cleared by someone else mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees IDLE).
    let clearPoll = 0;
    const clearedMidPoll = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      clearPoll += 1;
      return clearPoll <= 2 ? workingHolding(LINE) : IDLE;
    });
    const outCleared = await deliverTypedWake(clearedMidPoll.host, 'pane-1', LINE, 'antigravity', { ...FAST, verifyMs: 4 });
    expect(outCleared).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'no working screen showed after the agent prompt',
      submittedAt: expect.any(Number),
    });
    expect(clearedMidPoll.prompts).toEqual([LINE]);
    expect(clearedMidPoll.typed).toEqual([]);
    expect(clearedMidPoll.enters).toBe(0);

    // 3. A partial line left mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees holding(partial)).
    for (const partial of [LINE.slice(0, 12), LINE.slice(5)]) {
      let partialPoll = 0;
      const partialMidPoll = wakeFake((read, enters) => {
        if (read < 2) return IDLE;
        if (enters === 0) return holding(LINE);
        partialPoll += 1;
        return partialPoll <= 2 ? workingHolding(LINE) : holding(partial);
      });
      const outPartial = await deliverTypedWake(partialMidPoll.host, 'pane-1', LINE, 'antigravity', { ...FAST, verifyMs: 4 });
      expect(outPartial).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'no working screen showed after the agent prompt',
      });
      expect(partialMidPoll.prompts).toEqual([LINE]);
      expect(partialMidPoll.typed).toEqual([]);
      expect(partialMidPoll.enters).toBe(0);
    }
  });
});
