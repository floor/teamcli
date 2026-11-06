import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen } from '../src/watch/screen.ts';

const AGY_FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const AGY_IDLE = readFileSync(join(AGY_FIXTURES, 'idle.txt'), 'utf8');
const AGY_WORKING = readFileSync(join(AGY_FIXTURES, 'working-synthetic.txt'), 'utf8');

const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const MUSE_PLAIN_GOAL = readFileSync(join(MUSE_FIXTURES, 'goal-hint-synthetic.txt'), 'utf8');
const MUSE_DIM_GOAL = readFileSync(join(MUSE_FIXTURES, 'goal-hint-dim.txt'), 'utf8');
const MUSE_DIM_LOOP = readFileSync(join(MUSE_FIXTURES, 'loop-hint-dim.txt'), 'utf8');
const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');

const OPEN_HINT = '/tasks shows your open tasks';
const WORKFLOWS_HINT = '/tasks shows workflows, subagents and terminals in one place';
const WAKE_LINE = 'Read /t/mail/msg-01 and act on it.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function agyRow(text: string): string {
  return AGY_IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

function musePlain(text: string): string {
  return MUSE_PLAIN_GOAL.replace('❯ /goal pins a session objective with a progress bar', `❯ ${text}`);
}

function museDim(text: string): string {
  return MUSE_DIM_GOAL.replace('/goal pins a session objective with a progress bar', text);
}

function museColored(text: string, sgr = '\u001b[38;5;245m'): string {
  return MUSE_DIM_GOAL
    .replace('/goal pins a session objective with a progress bar', text)
    .replace('\u001b[2m', sgr);
}

function makeWakeHarness(screenAt: (readIndex: number, enters: number, typed: readonly string[]) => string): {
  host: TypedWakeHost;
  typed: string[];
  readonly enters: number;
} {
  const typed: string[] = [];
  let reads = 0;
  let enters = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters, typed),
    type: (_pane, text) => {
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

describe('independent verification of exact /tasks hint rows in Antigravity and Muse', () => {
  test('in both Antigravity and Muse profiles, the two exact /tasks hint rows read as idle with an empty box and deliverTypedWake types into them', async () => {
    for (const hint of [OPEN_HINT, WORKFLOWS_HINT]) {
      // Antigravity: exact hint reads idle, box is null, and wake types into it
      const agyScreen = agyRow(hint);
      expect(readScreen('antigravity', agyScreen).kind).toBe('idle');
      expect(readBox('antigravity', agyScreen)).toBeNull();
      expect(boxHoldsText('antigravity', hint, agyScreen)).toBe(false);

      const agyWake = makeWakeHarness((readIdx, enters, typed) =>
        enters > 0 ? AGY_WORKING : readIdx < 2 ? agyScreen : agyRow(typed[typed.length - 1] ?? ''),
      );
      const agyOut = await deliverTypedWake(agyWake.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
      expect(agyOut).toEqual({
        delivered: true,
        typed: true,
        tries: 1,
        reason: 'the working screen showed after 1 Enter',
        submittedAt: expect.any(Number),
        workingAt: expect.any(Number),
      });
      expect(agyWake.typed).toEqual([WAKE_LINE]);
      expect(agyWake.enters).toBe(1);

      // Muse (plain and dim ANSI): exact hint reads idle, box is null, and wake types into it
      for (const museScreen of [musePlain(hint), museDim(hint)]) {
        expect(readScreen('muse', museScreen).kind).toBe('idle');
        expect(readBox('muse', museScreen)).toBeNull();
        expect(boxHoldsText('muse', hint, museScreen)).toBe(false);

        const museWake = makeWakeHarness((readIdx, enters, typed) =>
          enters > 0 ? MUSE_WORKING : readIdx < 2 ? museScreen : musePlain(typed[typed.length - 1] ?? ''),
        );
        const museOut = await deliverTypedWake(museWake.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
        expect(museOut).toEqual({
          delivered: true,
          typed: true,
          tries: 1,
          reason: 'the working screen showed after 1 Enter',
          submittedAt: expect.any(Number),
          workingAt: expect.any(Number),
        });
        expect(museWake.typed).toEqual([WAKE_LINE]);
        expect(museWake.enters).toBe(1);
      }
    }
  });

  test('in both profiles, either exact /tasks hint row plus extra words stays unsent and refuses a typed wake', async () => {
    for (const hint of [OPEN_HINT, WORKFLOWS_HINT]) {
      for (const draft of [`${hint} now`, `${hint} --all`, `${hint} ?`, `check ${hint}`]) {
        // Antigravity
        const agyDraft = agyRow(draft);
        expect(readScreen('antigravity', agyDraft).kind).toBe('unsent');
        expect(readBox('antigravity', agyDraft)?.first).toBe(draft);
        expect(boxHoldsText('antigravity', draft, agyDraft)).toBe(true);

        const agyWake = makeWakeHarness(() => agyDraft);
        const agyRes = await deliverTypedWake(agyWake.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST);
        expect(agyRes.delivered).toBe(false);
        expect(agyRes.typed).toBe(false);
        expect(agyWake.typed).toEqual([]);
        expect(agyWake.enters).toBe(0);

        // Muse (plain)
        const museDraft = musePlain(draft);
        expect(readScreen('muse', museDraft).kind).toBe('unsent');
        expect(readBox('muse', museDraft)?.first).toBe(draft);
        expect(boxHoldsText('muse', draft, museDraft)).toBe(true);

        const museWake = makeWakeHarness(() => museDraft);
        const museRes = await deliverTypedWake(museWake.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
        expect(museRes.delivered).toBe(false);
        expect(museRes.typed).toBe(false);
        expect(museWake.typed).toEqual([]);
        expect(museWake.enters).toBe(0);
      }
    }
  });

  test('/tasks shows the queue and other non-exact /tasks prefixes stay unsent in both Antigravity and Muse', async () => {
    const drafts = [
      '/tasks shows the queue',
      '/tasks',
      '/tasks shows',
      '/tasks shows your',
      '/tasks shows workflows',
      '/tasks list',
    ];

    for (const draft of drafts) {
      const agyDraft = agyRow(draft);
      expect(readScreen('antigravity', agyDraft).kind).toBe('unsent');
      expect(readBox('antigravity', agyDraft)?.first).toBe(draft);
      expect(boxHoldsText('antigravity', draft, agyDraft)).toBe(true);

      const museDraft = musePlain(draft);
      expect(readScreen('muse', museDraft).kind).toBe('unsent');
      expect(readBox('muse', museDraft)?.first).toBe(draft);
      expect(boxHoldsText('muse', draft, museDraft)).toBe(true);
    }

    // Wake specifically refuses to overwrite `/tasks shows the queue` in both profiles
    const agyQueueWake = makeWakeHarness(() => agyRow('/tasks shows the queue'));
    expect((await deliverTypedWake(agyQueueWake.host, 'pane-agy', WAKE_LINE, 'antigravity', FAST)).typed).toBe(false);
    expect(agyQueueWake.typed).toEqual([]);

    const museQueueWake = makeWakeHarness(() => musePlain('/tasks shows the queue'));
    expect((await deliverTypedWake(museQueueWake.host, 'pane-muse', WAKE_LINE, 'muse', FAST)).typed).toBe(false);
    expect(museQueueWake.typed).toEqual([]);
  });

  test('Muse all-faint rows read idle, while plain rows and non-faint coloured rows stay unsent', async () => {
    // 1. Faint `/command <words>` hints in Muse read as idle
    expect(readScreen('muse', MUSE_DIM_GOAL).kind).toBe('idle');
    expect(readScreen('muse', MUSE_DIM_LOOP).kind).toBe('idle');
    for (const faintSlashHint of [
      '/compact summarizes the conversation to free context',
      '/plan outlines the steps before editing files',
      '/tasks shows the queue',
    ]) {
      const dimScreen = museDim(faintSlashHint);
      expect(readScreen('muse', dimScreen).kind).toBe('idle');
      expect(readBox('muse', dimScreen)).toBeNull();
      expect(boxHoldsText('muse', faintSlashHint, dimScreen)).toBe(false);
    }

    // Wake types into a faint Muse `/loop ...` slash-hint screen
    const loopWake = makeWakeHarness((readIdx, enters, typed) =>
      enters > 0 ? MUSE_WORKING : readIdx < 2 ? MUSE_DIM_LOOP : musePlain(typed[typed.length - 1] ?? ''),
    );
    const loopOut = await deliverTypedWake(loopWake.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
    expect(loopOut).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(loopWake.typed).toEqual([WAKE_LINE]);

    // 2. An all-faint row is the empty box, prose and a bare command included.
    for (const faintRow of ['/tasks', '/exit', 'plain words in dim']) {
      const dimHint = museDim(faintRow);
      expect(readScreen('muse', dimHint).kind).toBe('idle');
      expect(readBox('muse', dimHint)).toBeNull();
      expect(boxHoldsText('muse', faintRow, dimHint)).toBe(false);
    }

    // 3. Plain non-hint rows AND exact hint words rendered in Muse colour (SGR colour without faint \x1b[2m) stay unsent
    for (const sgr of ['\u001b[38;5;245m', '\u001b[36m', '\u001b[32m']) {
      for (const text of [
        'Check the current build status',
        '/tasks shows the queue',
        '/goal ship the release',
        OPEN_HINT,
        WORKFLOWS_HINT,
      ]) {
        const coloredScreen = museColored(text, sgr);
        expect(readScreen('muse', coloredScreen).kind).toBe('unsent');
        expect(readBox('muse', coloredScreen)?.first).toBe(text);
        expect(boxHoldsText('muse', text, coloredScreen)).toBe(true);

        const coloredWake = makeWakeHarness(() => coloredScreen);
        const res = await deliverTypedWake(coloredWake.host, 'pane-muse', WAKE_LINE, 'muse', FAST);
        expect(res.delivered).toBe(false);
        expect(res.typed).toBe(false);
        expect(coloredWake.typed).toEqual([]);
      }
    }
  });
});
