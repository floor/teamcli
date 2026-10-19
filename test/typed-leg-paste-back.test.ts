import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDraft, deliverTrigger, draftNote, type DeliverHost } from '../src/send/deliver.ts';
import { claudeBox } from './helpers.ts';

// The typed leg's side of the unsent-text rule: the person's draft is copied beside the drop,
// the trigger typed and submitted, and the draft pasted back — or, where the screen says the
// paste cannot land, the copy stays and the answer names it. These pin the working-turn
// refusal, the copy that is never overwritten, and the paste surfaces that do not draw the
// text back.

const FIXTURES = join(import.meta.dir, 'fixtures');
const claudeCapture = (name: string): string =>
  readFileSync(join(FIXTURES, 'claude-code', '2.1.289', name), 'utf8').replace(/\r\n/g, '\n');
const codexWorking = (): string =>
  readFileSync(join(FIXTURES, 'codex', '0.161.0', 'working.txt'), 'utf8').replace(/\r\n/g, '\n');

const DROP_ID = '9a57c0de-3b1f-4c2a-8d6e-0f1a2b3c4d5e';

/** A drop path in a throwaway folder: the draft's copy sits beside it, as the delivery keeps it. */
function sidecar(): { line: string; copy: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'team-typed-leg-'));
  return {
    line: `Read ${join(dir, DROP_ID)} and do that.`,
    copy: join(dir, `${DROP_ID}.draft`),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Box = {
  /** The screen the person left: their draft in the composer. */
  screen: string;
  /** The draft's rows, as the box draws them once a key lands. */
  draft: string;
  /** A running turn, as herdr reports it before the Enter. */
  working?: boolean;
  /** What the screen draws once the draft is pasted; by default the box holds the text. */
  afterPaste?: (pasted: string) => string;
  /** The screens read after the Enter, in order; the last one repeats. */
  afterEnter?: readonly string[];
  /** What the box holds once the trigger is submitted, when another writer put text there. */
  afterEnterBox?: string;
  /** A screen the pane keeps drawing for this many reads after the Enter: the lagging redraw
   *  that shows the trigger after it left (the late clear). Then the live box is read. */
  lateClear?: { reads: number; screen: string };
  /** Reads that fail after the Enter for this many reads: a redraw in progress. */
  unreadReads?: number;
};

/** A pane with one composer that follows the keys, the typed trigger and the paste, with the
 *  screen after the Enter drawn by the caller where a test needs it to differ. */
function boxCli(behaviour: Box): DeliverHost & { typed: string[]; keys: string[] } {
  let box = behaviour.draft;
  let touched = false;
  let submitted = false;
  let pasted: string | undefined;
  const typed: string[] = [];
  const keys: string[] = [];
  const postEnter = [...(behaviour.afterEnter ?? [])];
  let unreadLeft = behaviour.unreadReads ?? 0;
  let lateLeft = behaviour.lateClear?.reads ?? 0;
  return {
    typed,
    keys,
    typeText: (_pane: string, text: string): boolean => {
      typed.push(text);
      touched = true;
      const fold = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (fold === null) {
        box = text;
        return true;
      }
      const text_ = fold[1] ?? '';
      if (behaviour.afterPaste === undefined) box = text_;
      else pasted = behaviour.afterPaste(text_);
      return true;
    },
    pressEnter: (): boolean => {
      box = behaviour.afterEnterBox ?? '';
      submitted = true;
      return true;
    },
    status: (): string => (behaviour.working === true || submitted ? 'working' : 'idle'),
    wait: async (): Promise<void> => {},
    readAnsi: (): string => {
      if (submitted && postEnter.length > 0) {
        return postEnter.length > 1 ? (postEnter.shift() as string) : (postEnter[0] as string);
      }
      if (submitted && unreadLeft > 0) {
        unreadLeft -= 1;
        return undefined as unknown as string;
      }
      if (submitted && lateLeft > 0) {
        lateLeft -= 1;
        return behaviour.lateClear?.screen as string;
      }
      if (!touched) return behaviour.screen;
      if (pasted !== undefined) return pasted;
      return claudeBox(box);
    },
    sendKey: (_pane: string, key: string): boolean => {
      keys.push(key);
      touched = true;
      box = '';
      return true;
    },
  };
}

describe('a draft moved for a delivery', () => {
  test('a working turn on a CLI with no mid-turn clear key is held, and its box is left as it is', async () => {
    const side = sidecar();
    try {
      // The codex profile declares `mid_turn: false` and carries no clear key for a running
      // turn, so a draft drawn under one is never cleared with the idle screen's keys.
      const rows = codexWorking().split('\n');
      const at = rows.findIndex((row) => row.startsWith('› Ask Codex'));
      rows.splice(at, 1, '› Fix the parser', '  before the release.');
      const cli = boxCli({ screen: rows.join('\n'), draft: '', working: true });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'codex');
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(
        'the composer already holds unsent text while the seat is working, and this CLI has no key measured to clear it there; it was left as it is',
      );
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(side.copy)).toBe(false);
    } finally {
      side.cleanup();
    }
  });

  test('a copy holding other words is never overwritten: the delivery is held and the box left as it is', async () => {
    const side = sidecar();
    try {
      writeFileSync(side.copy, 'an earlier delivery left these words\n');
      const draft = 'Fix the parser';
      const cli = boxCli({ screen: claudeBox(draft), draft });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(
        `the composer already holds unsent text, and a different copy already sits at ${side.copy}; the box was left as it is`,
      );
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      // The older copy keeps its words, whatever the box now holds.
      expect(readFileSync(side.copy, 'utf8')).toBe('an earlier delivery left these words\n');
    } finally {
      side.cleanup();
    }
  });
});

describe('a draft the screen cannot copy faithfully', () => {
  test('a multi-row draft is held untouched on send and refused by the restart read alike', async () => {
    const side = sidecar();
    try {
      const draft = 'Fix the parser\nbefore the release.';
      const screen = claudeBox(draft);
      const cli = boxCli({ screen, draft });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(
        'the composer already holds unsent text over more than one drawn row, where a soft wrap cannot be told from a newline; it was left as it is',
      );
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(side.copy)).toBe(false);
      // The read `restart` makes before it closes the pane refuses the same drawing, so that leg
      // leaves the box as it is too.
      expect(captureDraft('claude-code', screen)).toEqual({
        why: 'over more than one drawn row, where a soft wrap cannot be told from a newline',
      });
    } finally {
      side.cleanup();
    }
  });

  test('a one-line draft the composer word-wraps is the same drawing, and held the same way', async () => {
    const side = sidecar();
    try {
      // Two rows at the box's indent: what the composer draws for a wrapped line, which the
      // screen cannot tell from a line break the person made.
      const wrapped = 'Please check the staging deployment logs for the\nbilling service before handing the parser over.';
      const cli = boxCli({ screen: claudeBox(wrapped), draft: wrapped });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('held');
      expect(result.reason).toContain('over more than one drawn row');
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(side.copy)).toBe(false);
    } finally {
      side.cleanup();
    }
  });
});

describe('a draft pasted back', () => {
  const one = 'Fix the parser';

  test('a one-row draft is copied, pasted back, and the copy removed on the verified read', async () => {
    const side = sidecar();
    try {
      const cli = boxCli({ screen: claudeBox(one), draft: one });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      // The trigger, then one bracketed paste of the draft — never the text typed key by key.
      expect(cli.typed).toEqual([side.line, `\x1b[200~${one}\x1b[201~`]);
      expect(existsSync(side.copy)).toBe(false);
      // The receipt every leg carries once the text is back in the box.
      expect(draftNote(result.draft!)).toBe('the unsent text was pasted back');
    } finally {
      side.cleanup();
    }
  });

  test('a paste the box never draws back keeps its copy and names it, and the delivery stands', async () => {
    const side = sidecar();
    try {
      const one = 'Fix the parser';
      const cli = boxCli({
        screen: claudeBox(one),
        draft: one,
        afterPaste: () => claudeBox('Fix the par'),
      });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({
        restored: false,
        copy: side.copy,
        note: 'the pasted text did not read back as its rows',
      });
      expect(readFileSync(side.copy, 'utf8')).toBe(one);
    } finally {
      side.cleanup();
    }
  });

  test('a dialog that takes the box after the Enter is never pasted into, and the copy is named', async () => {
    const side = sidecar();
    try {
      const one = 'Fix the parser';
      const permission = claudeCapture('permission-read-wide-ansi.txt');
      // The first read after the Enter shows the box empty; the next ones show the dialog.
      const cli = boxCli({ screen: claudeBox(one), draft: one, afterEnter: ['', permission] });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('unreachable');
      expect(result.dialog).toBe('permission');
      expect(result.reason).toBe('not reached; the screen reads permission');
      expect(result.draft).toEqual({
        restored: false,
        copy: side.copy,
        note: 'the screen reads permission; nothing was pasted back',
      });
      // Nothing was pasted into the dialog: the only text typed was the trigger.
      expect(cli.typed).toEqual([side.line]);
      expect(readFileSync(side.copy, 'utf8')).toBe(one);
    } finally {
      side.cleanup();
    }
  });
});

describe('a delivered exit still owes the owner the text', () => {
  const one = 'Fix the parser';

  test('a clear that lands after the leave check is restored before the verdict', async () => {
    const side = sidecar();
    try {
      // The pane keeps drawing the trigger for the leave check's read; the empty redraw lands
      // only after it, inside the verify window. The delivered exit restores there.
      const cli = boxCli({
        screen: claudeBox(one),
        draft: one,
        lateClear: { reads: 1, screen: claudeBox(side.line) },
      });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      expect(draftNote(result.draft!)).toBe('the unsent text was pasted back');
      expect(cli.typed).toEqual([side.line, `\x1b[200~${one}\x1b[201~`]);
      expect(existsSync(side.copy)).toBe(false);
    } finally {
      side.cleanup();
    }
  });

  test('reads that fail right after the Enter are waited out, and the text still goes back', async () => {
    const side = sidecar();
    try {
      // A redraw in progress reads unread through the leave check and the verify window; the
      // restore gives the box its own window rather than leaving the copy behind.
      const cli = boxCli({ screen: claudeBox(one), draft: one, unreadReads: 3 });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      expect(cli.typed).toEqual([side.line, `\x1b[200~${one}\x1b[201~`]);
      expect(existsSync(side.copy)).toBe(false);
    } finally {
      side.cleanup();
    }
  });

  test('a box holding other words is never typed over: the copy stays and the receipt names it', async () => {
    const side = sidecar();
    try {
      const cli = boxCli({ screen: claudeBox(one), draft: one, afterEnterBox: 'someone else is typing' });
      const result = await deliverTrigger(cli, 'w1:p1', side.line, 'claude-code');
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({
        restored: false,
        copy: side.copy,
        note: 'the box held other text when the trigger left; nothing was pasted back',
      });
      // Only the trigger was typed: the other writer's words were left alone.
      expect(cli.typed).toEqual([side.line]);
      expect(readFileSync(side.copy, 'utf8')).toBe(one);
      expect(draftNote(result.draft!)).toBe(`the unsent text could not be put back; its copy is at ${side.copy}`);
    } finally {
      side.cleanup();
    }
  });
});
