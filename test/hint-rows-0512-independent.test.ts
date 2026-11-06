// Independent verification of fix/hint-rows-0512 (6f63dba48):
// 1. In both the Antigravity and Muse profiles, each exact /tasks hint row reads as an empty box
//    and the typed wake types into it and submits on the working screen.
// 2. Each exact /tasks hint row plus extra words, and `/tasks shows the queue`, stay unsent and
//    are never typed over on either the first or the second pre-wake read.
// 3. A real draft (single-line or multi-line, plain or styled) is never wiped or submitted over.
// Fakes only; single test file; throwaway HOME.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';
import { fixtureBase } from './helpers.ts';

const AGY_FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const AGY_IDLE = readFileSync(join(AGY_FIXTURES, 'idle.txt'), 'utf8');
const AGY_WORKING = readFileSync(join(AGY_FIXTURES, 'working-synthetic.txt'), 'utf8');

const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const MUSE_PLAIN = readFileSync(join(MUSE_FIXTURES, 'goal-hint-synthetic.txt'), 'utf8');
const MUSE_DIM = readFileSync(join(MUSE_FIXTURES, 'goal-hint-dim.txt'), 'utf8');
const MUSE_TASKS_DIM = readFileSync(join(MUSE_FIXTURES, 'tasks-hint-dim.txt'), 'utf8');
const MUSE_UNSENT = readFileSync(join(MUSE_FIXTURES, 'unsent-synthetic.txt'), 'utf8');
const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');

const OPEN_HINT = '/tasks shows your open tasks';
const WORKFLOWS_HINT = '/tasks shows workflows, subagents and terminals in one place';
const QUEUE_DRAFT = '/tasks shows the queue';
const WAKE_LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

const ORIGINAL_HOME = process.env.HOME;
let scratchBase: string | null = null;

beforeEach(() => {
  scratchBase = fixtureBase('hint-rows-0512-independent-');
  const home = join(scratchBase, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (scratchBase !== null) {
    rmSync(scratchBase, { recursive: true, force: true });
    scratchBase = null;
  }
});

/** Places `text` (which may span multiple rows when `rest` is given) into the Antigravity composer box. */
function agyBox(first: string, ...rest: string[]): string {
  const extra = rest.map((line) => `  ${line}`).join('\n');
  const body = extra.length > 0 ? `> ${first}\n${extra}` : `> ${first}`;
  return AGY_IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n${body}\n${rule}\n`);
}

/** Places `text` (and optional continuation rows) into the plain Muse composer box. */
function museBox(first: string, ...rest: string[]): string {
  const extra = rest.map((line) => `  ${line}`).join('\n');
  const body = extra.length > 0 ? `❯ ${first}\n${extra}` : `❯ ${first}`;
  return MUSE_PLAIN.replace('❯ /goal pins a session objective with a progress bar', body);
}

/** Places `text` into the dim-styled Muse composer box. */
function museDimBox(text: string): string {
  return MUSE_DIM.replace('/goal pins a session objective with a progress bar', text);
}

/** Fake pane host whose screen is driven by a callback over `(readIndex, enters, typed)`. */
function scriptedWakeHost(
  screenAt: (readIndex: number, enters: number, typed: readonly string[]) => string,
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screenAt(state.reads++, state.enters, typed),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return state.enters;
    },
    get reads() {
      return state.reads;
    },
  };
}

describe('exact /tasks hint rows read as an empty box and accept a typed wake in both profiles', () => {
  test('Antigravity reads both exact /tasks hint rows as idle with an empty box and types the wake line into each', async () => {
    for (const hint of [OPEN_HINT, WORKFLOWS_HINT]) {
      const screen = agyBox(hint);
      expect(readScreen('antigravity', screen)).toEqual({ kind: 'idle' });
      expect(classifyComposer('antigravity', screen.split('\n'))).toEqual({ kind: 'idle' });
      expect(readBox('antigravity', screen)).toBeNull();
      expect(boxHoldsText('antigravity', hint, screen)).toBe(false);

      const pane = scriptedWakeHost((_read, enters, typed) => {
        if (enters > 0) return AGY_WORKING;
        if (typed.length > 0) return agyBox(typed[typed.length - 1] ?? '');
        return screen;
      });
      const result = await deliverTypedWake(pane.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
      expect(result).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(pane.typed).toEqual([WAKE_LINE]);
      expect(pane.enters).toBe(1);
    }

    // Rotation between the two exact /tasks hints across the two pre-type reads also stays idle and wakes.
    const rotating = scriptedWakeHost((read, enters, typed) => {
      if (enters > 0) return AGY_WORKING;
      if (typed.length > 0) return agyBox(typed[typed.length - 1] ?? '');
      return read === 0 ? agyBox(OPEN_HINT) : agyBox(WORKFLOWS_HINT);
    });
    const rotatedOut = await deliverTypedWake(rotating.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
    expect(rotatedOut).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(rotating.typed).toEqual([WAKE_LINE]);
    expect(rotating.enters).toBe(1);
  });

  test('Muse reads both exact /tasks hint rows (plain and dim) as idle with an empty box and types the wake line into each', async () => {
    expect(readScreen('muse', MUSE_TASKS_DIM)).toEqual({ kind: 'idle' });
    expect(readBox('muse', MUSE_TASKS_DIM)).toBeNull();

    for (const hint of [OPEN_HINT, WORKFLOWS_HINT]) {
      for (const screen of [museBox(hint), museDimBox(hint)]) {
        expect(readScreen('muse', screen)).toEqual({ kind: 'idle' });
        expect(classifyComposer('muse', screen.split('\n'))).toEqual({ kind: 'idle' });
        expect(readBox('muse', screen)).toBeNull();
        expect(boxHoldsText('muse', hint, screen)).toBe(false);

        const pane = scriptedWakeHost((_read, enters, typed) => {
          if (enters > 0) return MUSE_WORKING;
          if (typed.length > 0) return museBox(typed[typed.length - 1] ?? '');
          return screen;
        });
        const result = await deliverTypedWake(pane.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
        expect(result).toEqual({
          delivered: true,
          typed: true,
          tries: 1,
          reason: 'the working screen showed after 1 Enter',
          submittedAt: expect.any(Number),
          workingAt: expect.any(Number),
        });
        expect(pane.typed).toEqual([WAKE_LINE]);
        expect(pane.enters).toBe(1);
      }
    }

    // Rotation between the two plain Muse /tasks hints across the two pre-type reads also stays idle and wakes.
    const rotating = scriptedWakeHost((read, enters, typed) => {
      if (enters > 0) return MUSE_WORKING;
      if (typed.length > 0) return museBox(typed[typed.length - 1] ?? '');
      return read === 0 ? museBox(OPEN_HINT) : museBox(WORKFLOWS_HINT);
    });
    const rotatedOut = await deliverTypedWake(rotating.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
    expect(rotatedOut).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(rotating.typed).toEqual([WAKE_LINE]);
    expect(rotating.enters).toBe(1);
  });
});

describe('exact /tasks hint rows plus extra words and /tasks shows the queue stay unsent and are never typed over', () => {
  const nonPlaceholderRows = [
    `${OPEN_HINT} now`,
    `${OPEN_HINT} --all`,
    `please ${OPEN_HINT}`,
    `${WORKFLOWS_HINT} today`,
    `${WORKFLOWS_HINT} extra`,
    `check ${WORKFLOWS_HINT}`,
    QUEUE_DRAFT,
    '/tasks',
    '/tasks shows',
    '/tasks list',
  ];

  test('Antigravity keeps every hint-plus-extra-words row and /tasks shows the queue as unsent and never types over them', async () => {
    for (const draft of nonPlaceholderRows) {
      const screen = agyBox(draft);
      expect(readScreen('antigravity', screen)).toEqual({ kind: 'unsent' });
      expect(classifyComposer('antigravity', screen.split('\n'))).toEqual({ kind: 'unsent' });
      expect(readBox('antigravity', screen)?.first).toBe(draft);
      expect(boxHoldsText('antigravity', draft, screen)).toBe(true);
      expect(boxHoldsText('antigravity', WAKE_LINE, screen)).toBe(false);

      // Present on first read: refused immediately with nothing typed.
      const firstReadPane = scriptedWakeHost(() => screen);
      const firstOut = await deliverTypedWake(firstReadPane.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
      expect(firstOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(firstReadPane.typed).toEqual([]);
      expect(firstReadPane.enters).toBe(0);
      expect(firstReadPane.reads).toBe(1);

      // Appearing on second read after an initial exact hint row: refused on second read with nothing typed.
      const secondReadPane = scriptedWakeHost((read) => (read === 0 ? agyBox(OPEN_HINT) : screen));
      const secondOut = await deliverTypedWake(secondReadPane.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
      expect(secondOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(secondReadPane.typed).toEqual([]);
      expect(secondReadPane.enters).toBe(0);
      expect(secondReadPane.reads).toBe(2);
    }
  });

  test('Muse keeps every hint-plus-extra-words row, /tasks shows the queue, and one-colour and two-colour undeclared hint words as unsent', async () => {
    for (const draft of nonPlaceholderRows) {
      const screen = museBox(draft);
      expect(readScreen('muse', screen)).toEqual({ kind: 'unsent' });
      expect(classifyComposer('muse', screen.split('\n'))).toEqual({ kind: 'unsent' });
      expect(readBox('muse', screen)?.first).toBe(draft);
      expect(boxHoldsText('muse', draft, screen)).toBe(true);
      expect(boxHoldsText('muse', WAKE_LINE, screen)).toBe(false);

      // Present on first read: refused immediately with nothing typed.
      const firstReadPane = scriptedWakeHost(() => screen);
      const firstOut = await deliverTypedWake(firstReadPane.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
      expect(firstOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(firstReadPane.typed).toEqual([]);
      expect(firstReadPane.enters).toBe(0);
      expect(firstReadPane.reads).toBe(1);

      // Appearing on second read after an initial exact hint row: refused on second read with nothing typed.
      const secondReadPane = scriptedWakeHost((read) => (read === 0 ? museBox(WORKFLOWS_HINT) : screen));
      const secondOut = await deliverTypedWake(secondReadPane.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
      expect(secondOut).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(secondReadPane.typed).toEqual([]);
      expect(secondReadPane.enters).toBe(0);
      expect(secondReadPane.reads).toBe(2);
    }

    // Exact hint words drawn in an undeclared colour in Muse stay unsent text and are never typed
    // over, whether the words are one colour or split across two; only faint text or the declared
    // grey is the empty box.
    for (const hint of [OPEN_HINT, WORKFLOWS_HINT]) {
      const oneColour = museDimBox(hint).replace('\u001b[2m', '\u001b[38;5;245m');
      expect(readScreen('muse', oneColour)).toEqual({ kind: 'unsent' });
      expect(boxHoldsText('muse', hint, oneColour)).toBe(true);

      const splitHint = hint.replace('/tasks shows ', '/tasks shows\u001b[39m ');
      const twoColour = museDimBox(splitHint).replace('\u001b[2m', '\u001b[38;5;245m');
      expect(readScreen('muse', twoColour)).toEqual({ kind: 'unsent' });
      expect(boxHoldsText('muse', hint, twoColour)).toBe(true);
      const pane = scriptedWakeHost(() => twoColour);
      const out = await deliverTypedWake(pane.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
      expect(out).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(pane.typed).toEqual([]);
      expect(pane.enters).toBe(0);
    }
  });
});

describe('a real draft is never wiped or submitted over in either profile', () => {
  test('stateful Antigravity and Muse panes preserve single-line and multi-line drafts untouched across wake attempts', async () => {
    const agyDrafts: { text: string; screen: string }[] = [
      { text: '/goal ship the release', screen: agyBox('/goal ship the release') },
      { text: QUEUE_DRAFT, screen: agyBox(QUEUE_DRAFT) },
      { text: `${OPEN_HINT} and review blockers`, screen: agyBox(`${OPEN_HINT} and review blockers`) },
      {
        text: `${WORKFLOWS_HINT} and keep the draft`,
        screen: agyBox(WORKFLOWS_HINT, 'and keep the draft'),
      },
      {
        text: 'Read rules/implementer.md (sha256 5e1d0a).',
        screen: agyBox('Read rules/implementer.md', '(sha256 5e1d0a).'),
      },
    ];

    for (const draft of agyDrafts) {
      let current = draft.screen;
      const host: TypedWakeHost = {
        read: () => current,
        type: (_pane, text) => {
          current = agyBox(text);
          return true;
        },
        enter: () => {
          current = AGY_WORKING;
          return true;
        },
        wait: async () => {},
      };
      expect(readScreen('antigravity', current)).toEqual({ kind: 'unsent' });
      expect(boxHoldsText('antigravity', draft.text, current)).toBe(true);

      const out = await deliverTypedWake(host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
      expect(out).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      // The draft in the box is byte-for-byte intact and still verified by boxHoldsText.
      expect(current).toBe(draft.screen);
      expect(boxHoldsText('antigravity', draft.text, current)).toBe(true);
    }

    const museDrafts: { text: string; screen: string }[] = [
      { text: '/goal ship the release', screen: museBox('/goal ship the release') },
      { text: QUEUE_DRAFT, screen: museBox(QUEUE_DRAFT) },
      { text: `${WORKFLOWS_HINT} and check status`, screen: museBox(`${WORKFLOWS_HINT} and check status`) },
      {
        text: `${OPEN_HINT} and keep the second line`,
        screen: museBox(OPEN_HINT, 'and keep the second line'),
      },
      {
        text: 'Read rules/implementer.md (sha256 5e1d0a).',
        screen: MUSE_UNSENT,
      },
    ];

    for (const draft of museDrafts) {
      let current = draft.screen;
      const host: TypedWakeHost = {
        read: () => current,
        type: (_pane, text) => {
          current = museBox(text);
          return true;
        },
        enter: () => {
          current = MUSE_WORKING;
          return true;
        },
        wait: async () => {},
      };
      expect(readScreen('muse', current)).toEqual({ kind: 'unsent' });
      expect(boxHoldsText('muse', draft.text, current)).toBe(true);

      const out = await deliverTypedWake(host, 'pane-muse', WAKE_LINE, 'muse', FAST);
      expect(out).toEqual({
        delivered: false,
        typed: false,
        tries: 0,
        reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
      });
      expect(current).toBe(draft.screen);
      expect(boxHoldsText('muse', draft.text, current)).toBe(true);
    }
  });

  test('when the box changes to a user draft after the wake line is typed, no Enter is pressed in either profile', async () => {
    for (const [cli, hintScreen, draftScreen, draftText] of [
      ['antigravity', agyBox(OPEN_HINT), agyBox(QUEUE_DRAFT), QUEUE_DRAFT] as const,
      ['muse', museBox(WORKFLOWS_HINT), museBox(`${WORKFLOWS_HINT} now`), `${WORKFLOWS_HINT} now`] as const,
    ]) {
      const pane = scriptedWakeHost((read) => (read < 2 ? hintScreen : draftScreen));
      const out = await deliverTypedWake(pane.host, `pane-${cli}`, WAKE_LINE, cli, FAST);
      expect(out).toEqual({
        delivered: false,
        typed: true,
        tries: 0,
        reason: 'the box held text other than the line after the line was typed; no Enter was pressed',
      });
      expect(pane.typed).toEqual([WAKE_LINE]);
      expect(pane.enters).toBe(0);
      expect(boxHoldsText(cli, draftText, draftScreen)).toBe(true);
    }
  });
});
