// The current prompt after a turn that ended: the approved field note
// (briefs-0.5.4/claude-code-stale-error-above-ready-prompt-20261021.txt, sha256 f1fb5444…) records
// an API Error line, then the turn's own `done` line, then an idle prompt — and the watch and
// send still read the old error and held. The note is a trimmed record, not a classifiable pane:
// its labelled divider is not the unbroken rule the Claude Code profile documents, so every pane
// here is authored from the profile's documented shapes (the `─` rules, the `❯` prompt row, the
// status and bypass footers) and the transcript rows are independently written; nothing is copied
// from a builder fixture. The contract these panes pin: an error with a turn-end after it is
// history, and the composer under it is the current screen; an error with no turn-end after it is
// still the dialog. Every pane stays inside the classifier's last-20 window, so a pane cannot
// pass by cropping the old error away.
import { describe, expect, test } from 'bun:test';
import { stateOf } from '../src/commands/down.ts';
import { deliverTrigger, dialogKind, type DeliverHost } from '../src/send/deliver.ts';
import { classify, classifyComposer, readScreen } from '../src/watch/screen.ts';

const LOST = 'API Error: Connection lost mid-response. The response above may be incomplete.';
const DONE = '✻ Sautéed for 8m 33s · done 8:51 PM';
const RULE = '─'.repeat(53);
const STATUS =
  '  no-git · …/lobbies/teamcli · deepseek-flash · S: $167.1 ⣿⣤⣀⣀⣀ 27% · L: 13% (15m) · W: 97% (-11.9%) (25h5m)';
const BYPASS = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const PROMPT_ECHO = '❯ From orchestrator@teamcli: run team drops --read --seat documentarist --session teamcli and do that.';

/** The box the profile documents, with `text` on its prompt row: an unbroken rule at the pane's
 *  first column, the prompt, the closing rule, then the status and bypass footers. */
function box(text = ''): string[] {
  return [RULE, `❯ ${text}`, RULE, STATUS, BYPASS];
}

/** A constructed pane: the transcript rows above, then a documented composer. The classifier reads
 *  the last 20 rows, so a pane longer than that would hide the very error under test; the builder
 *  refuses one rather than let a read pass by cropping. */
function pane(above: string[], text = ''): string {
  const rows = [...above, ...box(text)];
  if (rows.length > 20) throw new Error(`a ${String(rows.length)}-row pane would be cropped by the last-20 window`);
  return rows.join('\n');
}

const ENDED = [PROMPT_ECHO, '  Thought for 17s, ran 4 shell commands', `⏺ ${LOST}`, DONE];
const afterCompletion = pane(ENDED);
const immediateError = pane([PROMPT_ECHO, `⏺ ${LOST}`]);
const completionBeforeError = pane(['✻ Sautéed for 2s · done 5:25 PM', `⏺ ${LOST}`]);
const newErrorAfterCompletion = pane([`⏺ ${LOST}`, DONE, `⏺ ${LOST}`]);
const oldErrorTwoTurnsUp = pane([
  '❯ run the first check',
  '⏺ First check passed.',
  '',
  `⏺ ${LOST}`,
  '',
  '✻ Sautéed for 2s · done 5:25 PM',
  '',
  '❯ run the second check',
  '⏺ Second check passed.',
]);
const quotedCompletion = pane([
  `⏺ ${LOST}`,
  '⏺ The seat once printed ✻ Sautéed for 8m 33s · done 8:51 PM in its scrollback.',
]);
const malformedDone = pane([`⏺ ${LOST}`, '✻ Sautéed for 8m 33s · done']);
const truncatedDone = pane([`⏺ ${LOST}`, '✻ Sautéed for 8m 33s · done 8:51 P']);
const quotedPrompt = pane([`⏺ ${LOST}`, '❯']);
const doneTypedInBox = pane([`⏺ ${LOST}`], DONE);
const historicalErrorUnsent = pane([`⏺ ${LOST}`, DONE], 'finish the coverage run');
const historicalErrorWorking = pane([`⏺ ${LOST}`, DONE, '✽ Mustering… (0s · thinking with high effort)']);
// The captured rate-limit screen (fixtures/claude-code/rate-limit.txt) keeps its documented
// composer frame under the error rows, so the constructed pane carries that same frame.
const rateLimitAfterCompletion = [
  `⏺ ${LOST}`,
  DONE,
  'API Error: Request rejected (429)',
  'Usage limit reached',
  'Your limit will reset at 11:00',
  ...box(),
].join('\n');
const permissionAfterCompletion = [
  `⏺ ${LOST}`,
  DONE,
  '⏺ Write(synthetic-note.txt)',
  RULE,
  ' Create file',
  ' Do you want to create synthetic-note.txt?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel · Tab to amend',
].join('\n');
const trustAfterCompletion = [
  `⏺ ${LOST}`,
  DONE,
  ' Quick safety check: Is this a project you created or',
  ' one you trust?',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');
// The approved rows as the note records them: metadata and rule rows trimmed, the divider
// shortened and labelled by the note. The label is not a composer rule, so this is neither a
// captured pane nor a constructed one — it is the note's own record, and the read may never take
// it for a ready prompt.
const trimmedSnapshot = [
  PROMPT_ECHO,
  '  Thought for 17s, ran 4 shell commands',
  `⏺ ${LOST}`,
  DONE,
  '──────────────────────────────────────────── document ─',
  '❯',
  STATUS,
  BYPASS,
].join('\n');

const CARRIES_LOST = [
  afterCompletion,
  immediateError,
  completionBeforeError,
  newErrorAfterCompletion,
  oldErrorTwoTurnsUp,
  quotedCompletion,
  malformedDone,
  truncatedDone,
  quotedPrompt,
  doneTypedInBox,
  historicalErrorUnsent,
  historicalErrorWorking,
  rateLimitAfterCompletion,
  permissionAfterCompletion,
  trustAfterCompletion,
  trimmedSnapshot,
];

/** A send host whose pane reads one screen before the typing, one while the line sits in its box,
 *  and one after Enter: `working`, with the delivered turn running. The delivery's own status and
 *  screen reads are the shipped ones — only the pane is fake. */
type FakeHost = DeliverHost & { log: { typed: string[]; enters: number } };

function fakeHost(screens: { before: string; typed: (line: string) => string; after: string }): FakeHost {
  let phase: 'before' | 'typed' | 'after' = 'before';
  const log = { typed: [] as string[], enters: 0 };
  return {
    typeText: (_pane, text) => {
      log.typed.push(text);
      phase = 'typed';
      return true;
    },
    pressEnter: () => {
      log.enters += 1;
      phase = 'after';
      return true;
    },
    status: () => (phase === 'after' ? 'working' : 'idle'),
    wait: async () => {},
    readAnsi: (): string =>
      phase === 'before' ? screens.before : phase === 'typed' ? screens.typed(log.typed[log.typed.length - 1] ?? '') : screens.after,
    log,
  };
}

const SEND_LINE = 'Run team drops --read --seat documentarist --session teamcli and do that.';

describe('the constructed composer frame is the documented one', () => {
  test('an empty box with no transcript above it reads as an empty ready prompt', () => {
    const empty = pane([]);
    expect(readScreen('claude-code', empty)).toEqual({ kind: 'idle' });
    expect(classify('claude-code', empty.split('\n'))).toEqual({ kind: 'idle' });
    expect(classifyComposer('claude-code', empty.split('\n')).kind).toBe('idle');
    expect(dialogKind('claude-code', empty)).toBeNull();
  });

  test('every constructed pane keeps its error inside the classifier window', () => {
    for (const screen of CARRIES_LOST) {
      const rows = screen.split('\n');
      expect(rows.length).toBeLessThanOrEqual(20);
      expect(rows.some((row) => row.includes(LOST))).toBe(true);
    }
  });
});

describe('a turn-end after the error makes the prompt current', () => {
  test('the historical error is not the dialog: every reader agrees the prompt is ready', () => {
    expect(readScreen('claude-code', afterCompletion)).toEqual({ kind: 'idle' });
    expect(classify('claude-code', afterCompletion.split('\n'))).toEqual({ kind: 'idle' });
    expect(classifyComposer('claude-code', afterCompletion.split('\n')).kind).toBe('idle');
    expect(dialogKind('claude-code', afterCompletion)).toBeNull();
    expect(stateOf('idle', readScreen('claude-code', afterCompletion), 'claude-code')).toBe('free');
  });

  test('a send types into that prompt instead of refusing it as a dialog', async () => {
    const host = fakeHost({
      before: afterCompletion,
      typed: (line) => pane(ENDED, line),
      after: historicalErrorWorking,
    });
    const result = await deliverTrigger(host, 'pane-1', SEND_LINE, 'claude-code');
    expect(result.outcome).toBe('delivered');
    expect(result.evidence).toBe('status');
    expect(host.log.typed).toEqual([SEND_LINE]);
    expect(host.log.enters).toBe(1);
  });
});

describe('an error without a later turn-end is still the dialog', () => {
  test('the immediate error above an empty box keeps the prompt blocked', () => {
    expect(readScreen('claude-code', immediateError)).toEqual({ kind: 'provider error' });
    expect(classify('claude-code', immediateError.split('\n'))).toEqual({ kind: 'provider error' });
    expect(classifyComposer('claude-code', immediateError.split('\n')).kind).toBe('unknown');
    expect(dialogKind('claude-code', immediateError)).toBe('provider error');
    expect(stateOf('idle', readScreen('claude-code', immediateError), 'claude-code')).toBe('blocked');
  });

  test('a send refuses that pane and types nothing', async () => {
    const host = fakeHost({ before: immediateError, typed: () => immediateError, after: immediateError });
    const result = await deliverTrigger(host, 'pane-1', SEND_LINE, 'claude-code');
    expect(result.outcome).toBe('unreachable');
    expect(result.dialog).toBe('provider error');
    expect(host.log.typed).toEqual([]);
    expect(host.log.enters).toBe(0);
  });

  test('a turn-end before a fresh error does not dismiss the fresh error', () => {
    expect(readScreen('claude-code', completionBeforeError)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', completionBeforeError)).toBe('provider error');
  });

  test('a new error after a completion is the live one', () => {
    expect(readScreen('claude-code', newErrorAfterCompletion)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', newErrorAfterCompletion)).toBe('provider error');
  });

  test('an error two turns up is not the current prompt', () => {
    expect(readScreen('claude-code', oldErrorTwoTurnsUp)).toEqual({ kind: 'idle' });
    expect(dialogKind('claude-code', oldErrorTwoTurnsUp)).toBeNull();
  });
});

describe('only the turn-end line qualifies, never completion-shaped text', () => {
  test('quoted completion prose after the error does not dismiss it', () => {
    expect(readScreen('claude-code', quotedCompletion)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', quotedCompletion)).toBe('provider error');
  });

  test('a malformed turn-end does not dismiss the error', () => {
    expect(readScreen('claude-code', malformedDone)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', malformedDone)).toBe('provider error');
  });

  test('a truncated turn-end does not dismiss the error', () => {
    expect(readScreen('claude-code', truncatedDone)).toEqual({ kind: 'provider error' });
    expect(dialogKind('claude-code', truncatedDone)).toBe('provider error');
  });

  test('a quoted bare prompt row is not proof of a current ready prompt', () => {
    expect(readScreen('claude-code', quotedPrompt)).toEqual({ kind: 'provider error' });
    expect(classifyComposer('claude-code', quotedPrompt.split('\n')).kind).toBe('unknown');
    expect(dialogKind('claude-code', quotedPrompt)).toBe('provider error');
  });

  test('a done-shaped line typed in the box does not dismiss the error', () => {
    expect(readScreen('claude-code', doneTypedInBox)).toEqual({ kind: 'provider error' });
    expect(classifyComposer('claude-code', doneTypedInBox.split('\n')).kind).toBe('unknown');
    expect(dialogKind('claude-code', doneTypedInBox)).toBe('provider error');
  });
});

describe('the current non-empty screen is read after a turn-end', () => {
  test('a historical error above an unsent box leaves the box unsent', () => {
    expect(readScreen('claude-code', historicalErrorUnsent)).toEqual({ kind: 'unsent' });
    expect(classifyComposer('claude-code', historicalErrorUnsent.split('\n')).kind).toBe('unsent');
    expect(dialogKind('claude-code', historicalErrorUnsent)).toBeNull();
    expect(stateOf('idle', readScreen('claude-code', historicalErrorUnsent), 'claude-code')).toBe('unsent');
  });

  test('a historical error above a running turn leaves the turn working', () => {
    expect(readScreen('claude-code', historicalErrorWorking)).toEqual({ kind: 'working' });
    expect(classify('claude-code', historicalErrorWorking.split('\n'))).toEqual({ kind: 'working' });
    expect(dialogKind('claude-code', historicalErrorWorking)).toBeNull();
    // herdr can lag the pane; the pane's own row is the working turn.
    expect(stateOf('idle', readScreen('claude-code', historicalErrorWorking), 'claude-code')).toBe('working');
  });
});

describe('dialogs after a turn-end keep their own reading', () => {
  test('a rate-limit screen after the turn-end is read as the rate limit', () => {
    expect(readScreen('claude-code', rateLimitAfterCompletion)).toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } });
    expect(dialogKind('claude-code', rateLimitAfterCompletion)).toBe('rate limit');
  });

  test('a permission dialog after the turn-end is still the permission dialog', () => {
    expect(readScreen('claude-code', permissionAfterCompletion)).toEqual({ kind: 'permission' });
    expect(dialogKind('claude-code', permissionAfterCompletion)).toBe('permission');
  });

  test('a trust question after the turn-end is still the trust question', () => {
    expect(readScreen('claude-code', trustAfterCompletion)).toEqual({ kind: 'trust' });
    expect(dialogKind('claude-code', trustAfterCompletion)).toBe('trust');
  });
});

describe('an uncertain frame is never a ready prompt', () => {
  test('the trimmed note rows are not a classifiable ready frame', () => {
    const kind = readScreen('claude-code', trimmedSnapshot).kind;
    expect(kind === 'idle' || kind === 'unsent').toBe(false);
    expect(classifyComposer('claude-code', trimmedSnapshot.split('\n')).kind).toBe('unknown');
  });

  test('a prompt-sized row with no composer frame is not a ready prompt', () => {
    const framedNothing = [PROMPT_ECHO, `⏺ ${LOST}`].join('\n');
    expect(classifyComposer('claude-code', framedNothing.split('\n')).kind).toBe('unknown');
    expect(readScreen('claude-code', framedNothing)).toEqual({ kind: 'provider error' });
  });
});
