import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsOther, boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, MAX_WAKE_ENTERS, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { composeMessageLine } from '../src/settings/message-display.ts';
import { listedPlaceholderEquals, readBox, readScreen, type ReadClock, type ScreenOptions } from '../src/watch/screen.ts';

const AGY_DIR = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const AGY_142_DIR = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2');
const AGY_IDLE = readFileSync(join(AGY_DIR, 'idle.txt'), 'utf8');
const AGY_IDLE_COMPACTED = readFileSync(join(AGY_DIR, 'idle-compacted.txt'), 'utf8');
const AGY_WORKING = readFileSync(join(AGY_DIR, 'working-synthetic.txt'), 'utf8');
const AGY_EXIT_UNSENT = readFileSync(join(AGY_DIR, 'exit-completion-unsent.txt'), 'utf8');
const AGY_PERMISSION = readFileSync(join(AGY_142_DIR, 'permission.txt'), 'utf8');

const CURSOR_DIR = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const CURSOR_1014_DIR = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.14');
const CURSOR_IDLE = readFileSync(join(CURSOR_DIR, 'idle.txt'), 'utf8');
const CURSOR_UNSENT = readFileSync(join(CURSOR_DIR, 'unsent.txt'), 'utf8');
const CURSOR_WORKING = readFileSync(join(CURSOR_DIR, 'working.txt'), 'utf8');
const CURSOR_PERMISSION = readFileSync(join(CURSOR_1014_DIR, 'permission.txt'), 'utf8');

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

// The screen reader spends a real 100 ms budget when no clock is handed in. A frozen clock
// and an explicit budget make every read in this file finish on the seam, including the
// reads deliverTypedWake makes through Date.now. Nothing here waits on the wall clock.
const FROZEN = 1_763_000_000_000;
const CLOCK: ReadClock = { now: () => FROZEN, budgetMs: 60_000 };
const READ: ScreenOptions = { clock: CLOCK };
const realNow = Date.now;

beforeEach(() => {
  Date.now = CLOCK.now;
});
afterEach(() => {
  Date.now = realNow;
});

function readScreenAt(cli: string, screen: string) {
  return readScreen(cli, screen, CLOCK);
}

function readBoxAt(cli: string, screen: string) {
  return readBox(cli, screen, READ);
}

function holdsText(cli: string, text: string, screen: string) {
  return boxHoldsText(cli, text, screen, READ);
}

function holdsOther(cli: string, text: string, screen: string) {
  return boxHoldsOther(cli, text, screen, READ);
}

const WAKE_LINE = composeMessageLine(
  'Message from owner (owner@acme): hello',
  'Read it with: call inbox_check now.',
)!;

/** Draws `text` (and optional extra rows under it) into the Antigravity 1.4.12 idle composer box. */
function agyBox(text: string, extraRows: readonly string[] = [], base = AGY_IDLE): string {
  const under = extraRows.map((row) => (row === '' ? '' : `  ${row}`)).join('\n');
  const body = extraRows.length === 0 ? `> ${text}` : `> ${text}\n${under}`;
  return base.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n${body}\n${rule}\n`);
}

/** Draws `text` into the Antigravity 1.4.12 working frame's composer box. */
function agyWorkingWithBox(text: string): string {
  return AGY_WORKING.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

/** Draws `text` (and optional extra rows at column 4 under it) into the Cursor 2026.10.22 composer box. */
function cursorBox(text: string, extraRows: readonly string[] = []): string {
  const base = CURSOR_UNSENT.replace(/Fix the failing test\s*/, () => text);
  if (extraRows.length === 0) return base;
  const lines = base.split('\n');
  const promptIdx = lines.findIndex((line) => line.includes(`→ ${text}`));
  const extraStyled = extraRows.map((row) => (row === '' ? '' : `    ${row}`));
  lines.splice(promptIdx + 1, 0, ...extraStyled);
  return lines.join('\n');
}

/** Draws `text` into the Cursor 2026.10.22 working frame's follow-up composer row. */
function cursorWorkingWithBox(text: string): string {
  const lines = CURSOR_WORKING.split('\n');
  const row = lines.findIndex((line) => line.includes('follow-up'));
  lines[row] =
    ` \u001b[0m\u001b[48;2;21;21;21m → ${text}\u001b[0m\u001b[48;2;21;21;21m                  \u001b[0m\u001b[2m\u001b[48;2;21;21;21mctrl+c to stop\u001b[0m\u001b[48;2;21;21;21m \u001b[0m`;
  return lines.join('\n');
}

function makeFakeHost(
  screenAt: (readIndex: number, enters: number, typed: readonly string[]) => string | null,
  options: { typeOk?: boolean; enterOk?: boolean } = {},
): {
  host: TypedWakeHost;
  typed: string[];
  enters: number;
  reads: number;
  waits: number[];
} {
  const typed: string[] = [];
  const waits: number[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return options.typeOk ?? true;
    },
    enter: () => {
      enters += 1;
      return options.enterOk ?? true;
    },
    wait: async (ms: number) => {
      waits.push(ms);
    },
  };
  return {
    host,
    typed,
    waits,
    get enters() {
      return enters;
    },
    get reads() {
      return reads;
    },
  };
}

describe('independent C7.3 verification: fix/wake-held-line (bc55d76a5)', () => {
  test('1. a sitting wake line in the Cursor and Antigravity boxes is submitted with Enter, typing nothing', async () => {
    expect(WAKE_LINE).toBe(
      'Message from owner (owner@acme): hello Read it with: call inbox_check now.',
    );
    expect(WAKE_LINE.length).toBeLessThanOrEqual(80);

    // Antigravity: sitting line is read twice, never typed again, submitted with 1 Enter.
    const agyHeld = agyBox(WAKE_LINE);
    expect(readScreenAt('antigravity', agyHeld).kind).toBe('unsent');
    expect(holdsText('antigravity', WAKE_LINE, agyHeld)).toBe(true);
    expect(holdsOther('antigravity', WAKE_LINE, agyHeld)).toBeNull();

    const agyScene = makeFakeHost((_read, enters) => (enters > 0 ? AGY_WORKING : agyHeld));
    const agyRes = await deliverTypedWake(agyScene.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
    expect(agyRes).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(agyScene.typed).toEqual([]);
    expect(agyScene.enters).toBe(1);

    // Antigravity: even if the transcript above the box changes between read 1 and read 2,
    // both reads still hold the exact wake line, so Enter is pressed without typing.
    const agyHeldCompacted = agyBox(WAKE_LINE, [], AGY_IDLE_COMPACTED);
    const agyTranscriptChanged = makeFakeHost((read, enters) => {
      if (enters > 0) return AGY_WORKING;
      return read === 0 ? agyHeld : agyHeldCompacted;
    });
    const agyChangedRes = await deliverTypedWake(
      agyTranscriptChanged.host,
      'pane-agy',
      WAKE_LINE,
      'antigravity',
      FAST,
    );
    expect(agyChangedRes).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(agyTranscriptChanged.typed).toEqual([]);
    expect(agyTranscriptChanged.enters).toBe(1);

    // Cursor: sitting line is read twice, never typed again, submitted with 1 Enter.
    const cursorHeld = cursorBox(WAKE_LINE);
    expect(readScreenAt('cursor', cursorHeld).kind).toBe('unsent');
    expect(holdsText('cursor', WAKE_LINE, cursorHeld)).toBe(true);
    expect(holdsOther('cursor', WAKE_LINE, cursorHeld)).toBeNull();

    const cursorScene = makeFakeHost((_read, enters) => (enters > 0 ? CURSOR_WORKING : cursorHeld));
    const cursorRes = await deliverTypedWake(
      cursorScene.host,
      'pane-cursor',
      WAKE_LINE,
      'cursor',
      FAST,
    );
    expect(cursorRes).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(cursorScene.typed).toEqual([]);
    expect(cursorScene.enters).toBe(1);

    // Cursor: a sitting wake line wrapped at a word boundary across two rows in the box is also
    // recognised as the exact wake line and submitted with Enter, typing nothing.
    const splitAt = WAKE_LINE.indexOf('Read it with:');
    const firstRow = WAKE_LINE.slice(0, splitAt - 1);
    const secondRow = WAKE_LINE.slice(splitAt);
    const cursorWrapped = cursorBox(firstRow, [secondRow]);
    expect(readScreenAt('cursor', cursorWrapped).kind).toBe('unsent');
    expect(holdsText('cursor', WAKE_LINE, cursorWrapped)).toBe(true);

    const cursorWrappedScene = makeFakeHost((_read, enters) =>
      enters > 0 ? CURSOR_WORKING : cursorWrapped,
    );
    const cursorWrappedRes = await deliverTypedWake(
      cursorWrappedScene.host,
      'pane-cursor',
      WAKE_LINE,
      'cursor',
      FAST,
    );
    expect(cursorWrappedRes).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(cursorWrappedScene.typed).toEqual([]);
    expect(cursorWrappedScene.enters).toBe(1);

    // Both CLIs: if the first Enter does not submit the sitting line, a second Enter submits it
    // without ever typing the line again.
    for (const [cli, held, working] of [
      ['antigravity', agyHeld, AGY_WORKING],
      ['cursor', cursorHeld, CURSOR_WORKING],
    ] as const) {
      const retryScene = makeFakeHost((_read, enters) => (enters >= 2 ? working : held));
      const retryRes = await deliverTypedWake(retryScene.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(retryRes).toEqual({
        delivered: true,
        typed: true,
        tries: 2,
        reason: 'the working screen showed after 2 Enters',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(retryScene.typed).toEqual([]);
      expect(retryScene.enters).toBe(2);
    }
  });

  test('2. a sitting line plus the exact hint row is submitted; plus a row that only starts like the hint, it is not', async () => {
    const agyHints = listedPlaceholderEquals('antigravity');
    expect(agyHints).toEqual([
      '/tasks shows your open tasks',
      '/tasks shows workflows, subagents and terminals in one place',
    ]);
    const cursorHints = listedPlaceholderEquals('cursor');
    expect(cursorHints).toEqual(['Plan, search, build anything', 'Add a follow-up']);

    // 2a. Antigravity: every exact listed hint row under a sitting wake line is submitted with Enter, typing nothing.
    for (const hint of agyHints) {
      const withExactHint = agyBox(WAKE_LINE, [hint]);
      expect(readScreenAt('antigravity', withExactHint).kind).toBe('unsent');
      expect(readBoxAt('antigravity', withExactHint)).toMatchObject({
        first: WAKE_LINE,
        rows: [`  ${hint}`],
      });
      expect(holdsText('antigravity', WAKE_LINE, withExactHint)).toBe(true);
      expect(holdsOther('antigravity', WAKE_LINE, withExactHint)).toBeNull();

      const sittingScene = makeFakeHost((_read, enters) =>
        enters > 0 ? AGY_WORKING : withExactHint,
      );
      const sittingOut = await deliverTypedWake(
        sittingScene.host,
        'pane-agy',
        WAKE_LINE,
        'antigravity',
        FAST,
      );
      expect(sittingOut).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(sittingScene.typed).toEqual([]);
      expect(sittingScene.enters).toBe(1);

      // Freshly typed line that draws with the exact hint row under it is also submitted.
      const typedScene = makeFakeHost((read, enters) =>
        read < 2 ? AGY_IDLE : enters > 0 ? AGY_WORKING : withExactHint,
      );
      const typedOut = await deliverTypedWake(
        typedScene.host,
        'pane-agy',
        WAKE_LINE,
        'antigravity',
        FAST,
      );
      expect(typedOut).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(typedScene.typed).toEqual([WAKE_LINE]);
      expect(typedScene.enters).toBe(1);
    }

    // 2b. Cursor: every exact listed placeholder row under a sitting wake line is submitted with Enter, typing nothing.
    for (const hint of cursorHints) {
      const withExactHint = cursorBox(WAKE_LINE, [hint]);
      expect(readScreenAt('cursor', withExactHint).kind).toBe('unsent');
      expect(holdsText('cursor', WAKE_LINE, withExactHint)).toBe(true);
      expect(holdsOther('cursor', WAKE_LINE, withExactHint)).toBeNull();

      const sittingScene = makeFakeHost((_read, enters) =>
        enters > 0 ? CURSOR_WORKING : withExactHint,
      );
      const sittingOut = await deliverTypedWake(
        sittingScene.host,
        'pane-cursor',
        WAKE_LINE,
        'cursor',
        FAST,
      );
      expect(sittingOut).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(sittingScene.typed).toEqual([]);
      expect(sittingScene.enters).toBe(1);
    }

    // 2c. Rows that only start like the hint (or are prefixes of the hint) are NEVER submitted.
    const agyPrefixRows = [
      '/tasks shows your open tasks now',
      '/tasks shows your open tasks — press enter',
      '/tasks shows workflows, subagents and terminals in one place today',
      '/tasks shows your open',
      '/tasks',
    ];
    for (const badRow of agyPrefixRows) {
      const frame = agyBox(WAKE_LINE, [badRow]);
      expect(readScreenAt('antigravity', frame).kind).toBe('unsent');
      expect(holdsText('antigravity', WAKE_LINE, frame)).toBe(false);
      expect(holdsOther('antigravity', WAKE_LINE, frame)).toBe(badRow);

      // Present on first read -> refuses immediately, types nothing, presses no Enter.
      const openScene = makeFakeHost(() => frame);
      const openOut = await deliverTypedWake(
        openScene.host,
        'pane-agy',
        WAKE_LINE,
        'antigravity',
        FAST,
      );
      expect(openOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(openScene.typed).toEqual([]);
      expect(openScene.enters).toBe(0);

      // Appears on second read after a clean sitting line -> refuses before Enter, types nothing.
      const secondScene = makeFakeHost((read) => (read === 0 ? agyBox(WAKE_LINE) : frame));
      const secondOut = await deliverTypedWake(
        secondScene.host,
        'pane-agy',
        WAKE_LINE,
        'antigravity',
        FAST,
      );
      expect(secondOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the box held text other than the line between the two looks; no Enter was pressed',
      });
      expect(secondScene.typed).toEqual([]);
      expect(secondScene.enters).toBe(0);

      // Appears after typing into an idle box -> refuses before Enter.
      const afterTypeScene = makeFakeHost((read) => (read < 2 ? AGY_IDLE : frame));
      const afterTypeOut = await deliverTypedWake(
        afterTypeScene.host,
        'pane-agy',
        WAKE_LINE,
        'antigravity',
        FAST,
      );
      expect(afterTypeOut).toEqual({
        delivered: false,
        typed: true,
        tries: 0,
        reason: 'the box held text other than the line after the line was typed; no Enter was pressed',
      });
      expect(afterTypeScene.typed).toEqual([WAKE_LINE]);
      expect(afterTypeScene.enters).toBe(0);
    }

    const cursorPrefixRows = [
      'Plan, search, build anything else',
      'Plan, search, build',
      'Add a follow-up question',
      'Add a follow-up now',
    ];
    for (const badRow of cursorPrefixRows) {
      const frame = cursorBox(WAKE_LINE, [badRow]);
      expect(readScreenAt('cursor', frame).kind).toBe('unsent');
      expect(holdsText('cursor', WAKE_LINE, frame)).toBe(false);
      expect(holdsOther('cursor', WAKE_LINE, frame)).toBe(badRow);

      const openScene = makeFakeHost(() => frame);
      const openOut = await deliverTypedWake(
        openScene.host,
        'pane-cursor',
        WAKE_LINE,
        'cursor',
        FAST,
      );
      expect(openOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(openScene.typed).toEqual([]);
      expect(openScene.enters).toBe(0);

      const secondScene = makeFakeHost((read) => (read === 0 ? cursorBox(WAKE_LINE) : frame));
      const secondOut = await deliverTypedWake(
        secondScene.host,
        'pane-cursor',
        WAKE_LINE,
        'cursor',
        FAST,
      );
      expect(secondOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the box held text other than the line between the two looks; no Enter was pressed',
      });
      expect(secondScene.typed).toEqual([]);
      expect(secondScene.enters).toBe(0);
    }
  });

  test('3. any other text in the box is never submitted or typed over', async () => {
    const otherDrafts = [
      'Fix the failing test',
      '/exit',
      'Message from bob (bob@acme): other message Read it with: call inbox_check now.',
      WAKE_LINE.slice(0, 25),
      WAKE_LINE.slice(10),
      WAKE_LINE.replace(' ', '  '),
    ];

    for (const draft of otherDrafts) {
      for (const [cli, idle, makeBox, heldWake] of [
        ['antigravity', AGY_IDLE, (t: string) => agyBox(t), agyBox(WAKE_LINE)],
        ['cursor', CURSOR_IDLE, (t: string) => cursorBox(t), cursorBox(WAKE_LINE)],
      ] as const) {
        const draftFrame = makeBox(draft);
        expect(readScreenAt(cli, draftFrame).kind).toBe('unsent');
        expect(holdsText(cli, WAKE_LINE, draftFrame)).toBe(false);

        // 1. Draft present on first read: nothing typed, no Enter pressed.
        const firstRead = makeFakeHost(() => draftFrame);
        const outFirst = await deliverTypedWake(firstRead.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
        expect(outFirst).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
        });
        expect(firstRead.typed).toEqual([]);
        expect(firstRead.enters).toBe(0);

        // 2. Draft appears on second read after an idle first read: nothing typed, no Enter pressed.
        const secondRead = makeFakeHost((read) => (read === 0 ? idle : draftFrame));
        const outSecond = await deliverTypedWake(
          secondRead.host,
          `pane-${cli}`,
          WAKE_LINE,
          cli,
          FAST,
        );
        expect(outSecond).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed',
        });
        expect(secondRead.typed).toEqual([]);
        expect(secondRead.enters).toBe(0);

        // 3. Sitting wake line on first read replaced by other text on second read: no Enter pressed.
        const replacedBeforeEnter = makeFakeHost((read) => (read === 0 ? heldWake : draftFrame));
        const outReplaced = await deliverTypedWake(
          replacedBeforeEnter.host,
          `pane-${cli}`,
          WAKE_LINE,
          cli,
          FAST,
        );
        expect(outReplaced).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the box held text other than the line between the two looks; no Enter was pressed',
        });
        expect(replacedBeforeEnter.typed).toEqual([]);
        expect(replacedBeforeEnter.enters).toBe(0);

        // 4. Sitting wake line takes 1 Enter, then changes to other text: no second Enter is pressed.
        const replacedAfterFirstEnter = makeFakeHost((_read, enters) =>
          enters === 0 ? heldWake : draftFrame,
        );
        const outAfterEnter = await deliverTypedWake(
          replacedAfterFirstEnter.host,
          `pane-${cli}`,
          WAKE_LINE,
          cli,
          FAST,
        );
        expect(outAfterEnter).toEqual({
          delivered: false,
          typed: true,
          tries: 1,
          reason: 'the box held text other than the line and no working screen showed',
        });
        expect(replacedAfterFirstEnter.typed).toEqual([]);
        expect(replacedAfterFirstEnter.enters).toBe(1);
      }
    }

    // Antigravity's captured `/exit` completion screen is also never typed over or submitted.
    const exitScene = makeFakeHost(() => AGY_EXIT_UNSENT);
    expect(await deliverTypedWake(exitScene.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST)).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
    });
    expect(exitScene.typed).toEqual([]);
    expect(exitScene.enters).toBe(0);
  });

  test('4. the trigger line with extra words is not submitted', async () => {
    const extraSameRowVariants = [
      `${WAKE_LINE} now`,
      `${WAKE_LINE} please`,
      `urgent: ${WAKE_LINE}`,
      WAKE_LINE.replace('call inbox_check now.', 'call inbox_check now please.'),
    ];

    for (const [cli, idle, makeBox, heldWake] of [
      ['antigravity', AGY_IDLE, (t: string, extra?: string[]) => agyBox(t, extra), agyBox(WAKE_LINE)],
      ['cursor', CURSOR_IDLE, (t: string, extra?: string[]) => cursorBox(t, extra), cursorBox(WAKE_LINE)],
    ] as const) {
      // 4a. Extra words on the same row.
      for (const withExtraWords of extraSameRowVariants) {
        const frame = makeBox(withExtraWords);
        expect(readScreenAt(cli, frame).kind).toBe('unsent');
        expect(holdsText(cli, WAKE_LINE, frame)).toBe(false);

        // Sitting at the start -> refused on first read, nothing typed, no Enter.
        const startScene = makeFakeHost(() => frame);
        const startOut = await deliverTypedWake(startScene.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
        expect(startOut).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
        });
        expect(startScene.typed).toEqual([]);
        expect(startScene.enters).toBe(0);

        // Appearing on second read after clean sitting wake line -> refused before Enter.
        const secondScene = makeFakeHost((read) => (read === 0 ? heldWake : frame));
        const secondOut = await deliverTypedWake(
          secondScene.host,
          `pane-${cli}`,
          WAKE_LINE,
          cli,
          FAST,
        );
        expect(secondOut).toEqual({
          delivered: false,
          typed: false,
          tries: 0,
          reason: 'the box held text other than the line between the two looks; no Enter was pressed',
        });
        expect(secondScene.typed).toEqual([]);
        expect(secondScene.enters).toBe(0);

        // Appearing after typing into an idle box -> refused before Enter.
        const afterTypeScene = makeFakeHost((read) => (read < 2 ? idle : frame));
        const afterTypeOut = await deliverTypedWake(
          afterTypeScene.host,
          `pane-${cli}`,
          WAKE_LINE,
          cli,
          FAST,
        );
        expect(afterTypeOut).toEqual({
          delivered: false,
          typed: true,
          tries: 0,
          reason: 'the box held text other than the line after the line was typed; no Enter was pressed',
        });
        expect(afterTypeScene.typed).toEqual([WAKE_LINE]);
        expect(afterTypeScene.enters).toBe(0);
      }

      // 4b. Exact trigger line on row 1 plus extra words on row 2 inside the box.
      const extraSecondRow = makeBox(WAKE_LINE, ['and run the tests']);
      expect(readScreenAt(cli, extraSecondRow).kind).toBe('unsent');
      expect(holdsText(cli, WAKE_LINE, extraSecondRow)).toBe(false);
      expect(holdsOther(cli, WAKE_LINE, extraSecondRow)).toBe('and run the tests');

      const rowScene = makeFakeHost(() => extraSecondRow);
      const rowOut = await deliverTypedWake(rowScene.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(rowOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(rowScene.typed).toEqual([]);
      expect(rowScene.enters).toBe(0);
    }
  });

  test('5. delivery is claimed only when the working screen shows (with the line no longer in the box)', async () => {
    for (const [cli, idle, heldWake, working, workingHoldingWake, permissionDialog] of [
      [
        'antigravity',
        AGY_IDLE,
        agyBox(WAKE_LINE),
        AGY_WORKING,
        agyWorkingWithBox(WAKE_LINE),
        AGY_PERMISSION,
      ],
      [
        'cursor',
        CURSOR_IDLE,
        cursorBox(WAKE_LINE),
        CURSOR_WORKING,
        cursorWorkingWithBox(WAKE_LINE),
        CURSOR_PERMISSION,
      ],
    ] as const) {
      // 5a. Sitting line stays in the box across all MAX_WAKE_ENTERS (3) Enters with no working screen.
      const stuckUnsent = makeFakeHost(() => heldWake);
      const outStuck = await deliverTypedWake(stuckUnsent.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(outStuck).toEqual({
        delivered: false,
        typed: true,
        tries: MAX_WAKE_ENTERS,
        reason: `the line stayed in the box through ${String(MAX_WAKE_ENTERS)} Enters and no working screen showed`,
      });
      expect(stuckUnsent.typed).toEqual([]);
      expect(stuckUnsent.enters).toBe(MAX_WAKE_ENTERS);

      // 5b. Enter empties the box to idle, but no working screen ever shows.
      const goesIdle = makeFakeHost((_read, enters) => (enters > 0 ? idle : heldWake));
      const outIdle = await deliverTypedWake(goesIdle.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(outIdle).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'the screen read idle and no working screen showed',
        submittedAt: expect.any(Number),
      });
      expect(goesIdle.typed).toEqual([]);
      expect(goesIdle.enters).toBe(1);

      // 5c. Working screen shows after Enter, but the box still holds the wake line through verifyMs.
      expect(readScreenAt(cli, workingHoldingWake).kind).toBe('working');
      expect(holdsText(cli, WAKE_LINE, workingHoldingWake)).toBe(true);
      const workingStillHeld = makeFakeHost((_read, enters) =>
        enters > 0 ? workingHoldingWake : heldWake,
      );
      const outWorkingHeld = await deliverTypedWake(
        workingStillHeld.host,
        `pane-${cli}`,
        WAKE_LINE,
        cli,
        { ...FAST, verifyMs: 3 },
      );
      expect(outWorkingHeld).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason:
          'the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
      });
      expect(workingStillHeld.typed).toEqual([]);
      expect(workingStillHeld.enters).toBe(1);

      // 5d. Working screen initially holds the wake line after Enter, then empties before verifyMs runs out -> delivered!
      let postEnterPolls = 0;
      const workingThenEmpties = makeFakeHost((_read, enters) => {
        if (enters === 0) return heldWake;
        postEnterPolls += 1;
        return postEnterPolls < 3 ? workingHoldingWake : working;
      });
      const outEmpties = await deliverTypedWake(
        workingThenEmpties.host,
        `pane-${cli}`,
        WAKE_LINE,
        cli,
        { ...FAST, verifyMs: 4 },
      );
      expect(postEnterPolls).toBe(3);
      expect(outEmpties).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(workingThenEmpties.typed).toEqual([]);
      expect(workingThenEmpties.enters).toBe(1);

      // 5e. Working screen shows on the second read BEFORE any Enter was pressed -> not claimed as delivered!
      const workingBeforeEnter = makeFakeHost((read) => (read === 0 ? heldWake : working));
      const outBeforeEnter = await deliverTypedWake(
        workingBeforeEnter.host,
        `pane-${cli}`,
        WAKE_LINE,
        cli,
        FAST,
      );
      expect(outBeforeEnter).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason:
          'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
      });
      expect(workingBeforeEnter.typed).toEqual([]);
      expect(workingBeforeEnter.enters).toBe(0);

      // 5f. After Enter, screen shows a permission dialog or becomes unreadable -> never claimed as delivered.
      const showsPermission = makeFakeHost((_read, enters) =>
        enters > 0 ? permissionDialog : heldWake,
      );
      const outPerm = await deliverTypedWake(
        showsPermission.host,
        `pane-${cli}`,
        WAKE_LINE,
        cli,
        FAST,
      );
      expect(outPerm).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'the screen read permission and no working screen showed',
      });
      expect(showsPermission.typed).toEqual([]);
      expect(showsPermission.enters).toBe(1);

      const goesNull = makeFakeHost((_read, enters) => (enters > 0 ? null : heldWake));
      const outNull = await deliverTypedWake(goesNull.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(outNull).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'the screen could not be read and no working screen showed; no further Enter was pressed',
      });
      expect(goesNull.typed).toEqual([]);
      expect(goesNull.enters).toBe(1);
    }
  });
});
