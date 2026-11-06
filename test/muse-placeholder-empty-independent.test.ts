import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBMIT_ENTER } from '../src/herdr.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const TOP_RULE =
  '── Voice input (⌥ + v to start) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';
const BOTTOM_RULE =
  '───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────';

const TRIGGER_LINE = 'Read /t/mail/msg-01 and act on it.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function museFrame(inputRow: string, extraRows: string[] = []): string {
  const body = [inputRow, ...extraRows].join('\n');
  return [
    '',
    '  Muse Code 1.4.11',
    '',
    '  Skills: 56 loaded · 2 warnings (ctrl+o to expand)',
    '',
    TOP_RULE,
    body,
    BOTTOM_RULE,
    '  muse-wonder-full-1.0 · high · ~/fixture/project · YOLO',
    '',
  ].join('\n');
}

function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

function makeWakeHost(
  screenAt: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
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
    get reads() {
      return reads;
    },
  };
}

describe('muse faint placeholder vs non-faint draft (independent verification)', () => {
  test('faint (SGR 2) hint rows — prose, slash, inverse-cursor-prefixed, and wrapped multi-row — read as empty idle boxes', () => {
    const proseA = 'Ask to monitor a running build or log and get pinged on changes';
    const proseB = 'Describe the bug or paste a stack trace to investigate';
    const slashA = '/tasks shows workflows, subagents and terminals in one place';
    const slashB = '/compact summarizes the conversation to free context';

    const cases: Array<{ label: string; frame: string; text: string }> = [
      {
        label: 'whole line faint prose hint (SGR 2..0)',
        frame: museFrame(`\x1b[2m❯ ${proseA}\x1b[0m`),
        text: proseA,
      },
      {
        label: 'prompt plain + faint prose hint lifted with SGR 22',
        frame: museFrame(`❯ \x1b[2m${proseB}\x1b[22m`),
        text: proseB,
      },
      {
        label: 'inverse-video cursor on first hint char followed by faint remainder',
        frame: museFrame(`❯ \x1b[7mD\x1b[27;2mescribe the bug or paste a stack trace to investigate\x1b[0m`),
        text: proseB,
      },
      {
        label: 'faint /tasks hint',
        frame: museFrame(`\x1b[2m❯ ${slashA}\x1b[0m`),
        text: slashA,
      },
      {
        label: 'faint /compact hint',
        frame: museFrame(`❯ \x1b[2m${slashB}\x1b[0m`),
        text: slashB,
      },
      {
        label: 'wrapped two-row faint hint where both input and continuation rows are all-faint',
        frame: museFrame(`❯ \x1b[2m${proseA}\x1b[0m`, ['\x1b[2m  when the build finishes\x1b[0m']),
        text: `${proseA} when the build finishes`,
      },
    ];

    for (const item of cases) {
      expect(readScreen('muse', item.frame).kind).toBe('idle');
      expect(classifyComposer('muse', item.frame.split('\n')).kind).toBe('idle');
      expect(readBox('muse', item.frame)).toBeNull();
      expect(boxHoldsText('muse', item.text, item.frame)).toBe(false);
    }
  });

  test('plain unstyled text and undeclared grey SGR text (90, 38;5;n, 38;2;r;g;b) never read empty and preserve the draft', () => {
    const prose = 'Ask to monitor a running build or log and get pinged on changes';
    const shortDraft = 'fix the race in router delivery';

    const nonFaintFrames: Array<{ label: string; frame: string; expectedFirst: string }> = [
      {
        label: 'plain unstyled prose (proves equals list was not extended with rotating prose)',
        frame: museFrame(`❯ ${prose}`),
        expectedFirst: prose,
      },
      {
        label: 'bright-black / grey SGR 90 prose',
        frame: museFrame(`\x1b[90m❯ ${prose}\x1b[0m`),
        expectedFirst: prose,
      },
      {
        label: '256-color grey SGR 38;5;244 after prompt',
        frame: museFrame(`❯ \x1b[38;5;244m${prose}\x1b[0m`),
        expectedFirst: prose,
      },
      {
        label: '256-color index 2 (SGR 38;5;2 sub-param 2 must not be mistaken for faint SGR 2)',
        frame: museFrame(`❯ \x1b[38;5;2m${shortDraft}\x1b[0m`),
        expectedFirst: shortDraft,
      },
      {
        label: 'truecolor RGB grey SGR 38;2;120;125;130 is not the declared hint colour',
        frame: museFrame(`\x1b[38;2;120;125;130m❯ ${prose}\x1b[0m`),
        expectedFirst: prose,
      },
      {
        label: 'truecolor RGB with 2s in channels (SGR 38;2;2;2;2 must not trigger faint)',
        frame: museFrame(`❯ \x1b[38;2;2;2;2m${shortDraft}\x1b[0m`),
        expectedFirst: shortDraft,
      },
      {
        label: 'bold SGR 1 on equals-listed /goal text',
        frame: museFrame(`❯ \x1b[1m/goal pins a session objective with a progress bar\x1b[0m`),
        expectedFirst: '/goal pins a session objective with a progress bar',
      },
    ];

    for (const item of nonFaintFrames) {
      expect(readScreen('muse', item.frame).kind).toBe('unsent');
      expect(classifyComposer('muse', item.frame.split('\n')).kind).toBe('unsent');
      const box = readBox('muse', item.frame);
      expect(box).not.toBeNull();
      expect(box?.first).toBe(item.expectedFirst);
      expect(boxHoldsText('muse', item.expectedFirst, item.frame)).toBe(true);
    }

    // The one grey the profile declares as Muse 1.4.14's rotating hint foreground is the empty
    // box even though it is not faint: the declared colour is the reading, and its own scene
    // (muse-hint-colour.test.ts) covers the captured 1.4.14 frame.
    const declared = museFrame(`\x1b[38;2;103;108;116m❯ ${prose}\x1b[0m`);
    expect(readScreen('muse', declared).kind).toBe('idle');
    expect(readBox('muse', declared)).toBeNull();
    expect(boxHoldsText('muse', prose, declared)).toBe(false);
  });

  test('partially faint rows or faint input with non-faint continuation row read as unsent (never empty)', () => {
    // 1. Faint prefix lifted via SGR 22 before user-typed words on the same line
    const partialLine = museFrame('❯ \x1b[2m/goal \x1b[22mship 0.5.12');
    expect(readScreen('muse', partialLine).kind).toBe('unsent');
    expect(readBox('muse', partialLine)?.first).toBe('/goal ship 0.5.12');
    expect(boxHoldsText('muse', '/goal ship 0.5.12', partialLine)).toBe(true);

    // 2. Faint first char lifted via SGR 0 before the rest of the draft
    const liftedZero = museFrame('❯ \x1b[2mA\x1b[0msk to monitor a running build');
    expect(readScreen('muse', liftedZero).kind).toBe('unsent');
    expect(readBox('muse', liftedZero)?.first).toBe('Ask to monitor a running build');

    // 3. All-faint input row followed by a non-faint second row inside the box
    const mixedRows = museFrame(
      '❯ \x1b[2mAsk to monitor a running build\x1b[0m',
      ['\x1b[90m  draft continuation line\x1b[0m'],
    );
    expect(readScreen('muse', mixedRows).kind).toBe('unsent');
    expect(readBox('muse', mixedRows)).not.toBeNull();
  });

  test('a listed equals placeholder in the declared grey reads idle, while an undeclared grey is a draft, and the typed wake types into the declared one', async () => {
    const goal = '/goal pins a session objective with a progress bar';
    const grey = museFrame(`❯ \x1b[90m${goal}\x1b[0m`);
    const truecolor = museFrame(`❯ \x1b[38;2;103;108;116m${goal}\x1b[0m`);
    const draft = museFrame(`❯ \x1b[90m${goal} now\x1b[0m`);
    const mixed = museFrame(`❯ \x1b[90m/goal pins\x1b[0m \x1b[38;2;103;108;116ma session objective with a progress bar\x1b[0m`);
    const cursor = museFrame(`❯ \x1b[90m/goal \x1b[7mp\x1b[27mins a session objective with a progress bar\x1b[0m`);
    const grokEdge = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'idle-ansi.txt'), 'utf8');
    expect(readScreen('muse', grey).kind).toBe('unsent');
    expect(boxHoldsText('muse', goal, grey)).toBe(true);
    expect(readScreen('muse', truecolor).kind).toBe('idle');
    expect(readScreen('grok', grokEdge).kind).toBe('idle');
    expect(readScreen('muse', draft).kind).toBe('unsent');
    expect(readScreen('muse', mixed).kind).toBe('unsent');
    expect(readScreen('muse', cursor).kind).toBe('unsent');
    expect(boxHoldsText('muse', `${goal} now`, draft)).toBe(true);

    const wake = makeWakeHost((read, enters) => (enters > 0 ? WORKING : read < 2 ? truecolor : holding(TRIGGER_LINE)));
    const out = await deliverTypedWake(wake.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
    });
    expect(wake.typed).toEqual([TRIGGER_LINE]);
    expect(wake.enters).toBe(1);
  });

  test('deliverTypedWake: faint hints allow wake delivery, while plain or grey non-faint drafts are never wiped or sent', async () => {
    const prose = 'Ask to monitor a running build or log and get pinged on changes';
    const faintProse = museFrame(`\x1b[2m❯ ${prose}\x1b[0m`);
    const faintSlash = museFrame('\x1b[2m❯ /tasks shows workflows, subagents and terminals in one place\x1b[0m');

    // 1. Faint prose hint on read 0 and read 1 -> types trigger line and presses Enter once
    const wakeProse = makeWakeHost((read, enters) =>
      enters > 0 ? WORKING : read < 2 ? faintProse : holding(TRIGGER_LINE),
    );
    const resProse = await deliverTypedWake(wakeProse.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(resProse).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
    });
    expect(wakeProse.typed).toEqual([TRIGGER_LINE]);
    expect(wakeProse.enters).toBe(1);

    // 2. Rotating from faint prose hint on read 0 to faint slash hint on read 1 -> still empty idle on both reads, delivers
    const wakeRotated = makeWakeHost((read, enters) => {
      if (enters > 0) return WORKING;
      if (read === 0) return faintProse;
      if (read === 1) return faintSlash;
      return holding(TRIGGER_LINE);
    });
    const resRotated = await deliverTypedWake(wakeRotated.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(resRotated.delivered).toBe(true);
    expect(wakeRotated.typed).toEqual([TRIGGER_LINE]);
    expect(wakeRotated.enters).toBe(1);

    // 3. Grey non-faint text (SGR 90, 38;5;244, an undeclared 38;2;r;g;b) or plain draft on first read -> refuses before typing anything
    const draftFrames = [
      museFrame(`❯ ${prose}`),
      museFrame(`\x1b[90m❯ ${prose}\x1b[0m`),
      museFrame(`❯ \x1b[38;5;244m${prose}\x1b[0m`),
      museFrame(`\x1b[38;2;120;125;130m❯ ${prose}\x1b[0m`),
      museFrame('❯ \x1b[2m/goal \x1b[22mkeep this draft safe'),
    ];

    for (const draftFrame of draftFrames) {
      const refusedHost = makeWakeHost(() => draftFrame);
      const out = await deliverTypedWake(refusedHost.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
      expect(out).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(refusedHost.typed).toEqual([]);
      expect(refusedHost.enters).toBe(0);
    }

    // 4. Faint hint on read 0, then user starts typing an undeclared grey/plain draft on read 1 -> refuses on second read without typing
    const secondReadDraft = makeWakeHost((read) =>
      read === 0 ? faintProse : museFrame(`\x1b[38;2;120;125;130m❯ ${prose}\x1b[0m`),
    );
    const outSecond = await deliverTypedWake(secondReadDraft.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(outSecond).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed',
    });
    expect(secondReadDraft.typed).toEqual([]);
    expect(secondReadDraft.enters).toBe(0);
  });

  test('herdr 0.9.5 SUBMIT_ENTER, two-equal-reads Enter settle, and 80-char single-row cap (d6bd28e0d)', async () => {
    expect(SUBMIT_ENTER).toBe('enter');

    // 1. 80-char cap: exactly 80 chars fits on one row and is typed/submitted; 81 chars or any newline
    // is refused BEFORE any read, type, or enter.
    const exact80 = `Read /t/mail/${'a'.repeat(80 - 'Read /t/mail/'.length)}`;
    expect(exact80.length).toBe(80);
    const host80 = makeWakeHost((read, enters) =>
      enters > 0 ? WORKING : read < 2 ? IDLE : holding(exact80),
    );
    const out80 = await deliverTypedWake(host80.host, 'pane-1', exact80, 'muse', FAST);
    expect(out80).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
    });
    expect(host80.typed).toEqual([exact80]);
    expect(host80.enters).toBe(1);

    const over81 = 'x'.repeat(81);
    const host81 = makeWakeHost(() => IDLE);
    const out81 = await deliverTypedWake(host81.host, 'pane-1', over81, 'muse', FAST);
    expect(out81).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the line does not fit 80 characters on one row; nothing was typed',
    });
    expect(host81.reads).toBe(0);
    expect(host81.typed).toEqual([]);
    expect(host81.enters).toBe(0);

    const withNewline = 'Read /t/mail/msg-01\nand act on it.';
    const hostNl = makeWakeHost(() => IDLE);
    const outNl = await deliverTypedWake(hostNl.host, 'pane-1', withNewline, 'muse', FAST);
    expect(outNl).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the line does not fit 80 characters on one row; nothing was typed',
    });
    expect(hostNl.reads).toBe(0);
    expect(hostNl.typed).toEqual([]);
    expect(hostNl.enters).toBe(0);

    // 2. Enter settle: while the row is still drawing (`Read` -> `Read /t/mail` -> full TRIGGER_LINE twice),
    // Enter is withheld until two consecutive post-type reads match the settled row.
    let postTypeReads = 0;
    const drawingHost = makeWakeHost((read, enters) => {
      if (read < 2) return IDLE;
      if (enters > 0) return WORKING;
      postTypeReads += 1;
      if (postTypeReads === 1) return holding('Read');
      if (postTypeReads === 2) return holding('Read /t/mail');
      return holding(TRIGGER_LINE);
    });
    const outDrawing = await deliverTypedWake(drawingHost.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    // postTypeReads 1 ('Read'), 2 ('Read /t/mail'), 3 (TRIGGER_LINE first time), 4 (TRIGGER_LINE second matching time -> Enter!)
    expect(postTypeReads).toBe(4);
    expect(outDrawing).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
    });
    expect(drawingHost.typed).toEqual([TRIGGER_LINE]);
    expect(drawingHost.enters).toBe(1);

    // 3. Unsettled line: if the screen keeps changing on every read even while holding TRIGGER_LINE,
    // no Enter is ever pressed (`the drawn line did not settle; no Enter was pressed`).
    let unsettledCount = 0;
    const unsettledHost = makeWakeHost((read) => {
      if (read < 2) return IDLE;
      unsettledCount += 1;
      return `${holding(TRIGGER_LINE)}${' '.repeat(unsettledCount)}`;
    });
    const outUnsettled = await deliverTypedWake(unsettledHost.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(outUnsettled).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'the drawn line did not settle; no Enter was pressed',
    });
    expect(unsettledHost.enters).toBe(0);
  });
});
