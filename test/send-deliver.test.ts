import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKOFF_MS,
  MAX_TRIES,
  VERIFY_TOTAL_MS,
  bindPane,
  captureDraft,
  deliverTrigger,
  dropIdOf,
  dropPathOf,
  showsDrop,
  type DeliverHost,
} from '../src/send/deliver.ts';
import { SETTLE_MS, type NativePane } from '../src/send/native.ts';
import { claudeBox } from './helpers.ts';

// A fake Claude Code box, drawn from the captures the screen reader is pinned to: the idle screen
// with a faint suggestion, and the same screen with its input row replaced.
const FIXTURES = join(import.meta.dir, 'fixtures', 'claude-code', '2.1.289');
const capture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');
// The later captures, taken on claude-code 2.1.303 through herdr 0.7.1: the composer's row shape
// is the same; what they add is a draft of several rows.
const LATER = join(import.meta.dir, 'fixtures', 'claude-code', '2.1.303');
const captureLater = (name: string): string => readFileSync(join(LATER, name), 'utf8').replace(/\r\n/g, '\n');
const IDLE = capture('idle-suggestion-ansi.txt');
const PROMPT = '\u276f\u00a0';
const INPUT_ROW = IDLE.split('\n').findIndex((row) => row.startsWith(PROMPT));
const FAINT = (text: string): string => `\x1b[0m\x1b[2m${text}\x1b[0m`;

function screenWith(row: string, transcript: string[] = []): string {
  const rows = IDLE.split('\n');
  rows[INPUT_ROW] = row;
  transcript.forEach((text, at) => {
    rows[5 + at] = text;
  });
  return rows.join('\n');
}

const DROP_ID = '3f2c9a1e-7b44-4d0a-9c1e-5a6b7c8d9e0f';
const LINE = `Read /tmp/drops/native/${DROP_ID} and do that.`;
const PROFILE = 'claude-code';

type Behaviour = {
  /** What the box draws when it is empty: a faint suggestion, or nothing at all. */
  empty?: 'suggestion' | 'blank';
  /** How many Enters the CLI swallows before one submits; Infinity never submits. */
  swallow?: number;
  /** What the box already holds before anything is typed. */
  preload?: string;
  /** The screen to show instead of the box while it is a dialog. */
  dialog?: string;
  /** The status herdr reports once the seat has taken a line. */
  after?: string;
  /** The box keeps the line even when the seat is working: a line queued behind a turn. */
  keepsLine?: boolean;
  /** The pane refuses the typed text. */
  refusesText?: boolean;
  /** Milliseconds after the Enter before herdr's status moves; Infinity never moves. */
  lagMs?: number;
  /** The transcript rows the pane draws once a line was submitted. */
  transcript?: string[];
  /** The status herdr reports before the seat has taken a line; `working` is a seat mid-turn. */
  statusBefore?: string;
  /** The screen the pane shows once an Enter was pressed, in place of the box. */
  dialogAfterEnter?: string;
  /** The pane cannot be read once an Enter was pressed. */
  unreadAfterEnter?: boolean;
};

/** A seat's pane: one box, one herdr status, every key logged. */
function fakeCli(behaviour: Behaviour = {}): DeliverHost & { typed: string[]; enters: number; waited: number[]; log: string[] } {
  let box = behaviour.preload ?? '';
  let swallowed = 0;
  let submittedAt: number | null = null;
  let clock = 0;
  const typed: string[] = [];
  const waited: number[] = [];
  const log: string[] = [];
  const cli = {
    typed,
    waited,
    log,
    enters: 0,
    typeText: (_pane: string, text: string): boolean => {
      if (behaviour.refusesText) return false;
      typed.push(text);
      box += text;
      log.push(`type:${text}`);
      return true;
    },
    pressEnter: (_pane: string): boolean => {
      cli.enters += 1;
      log.push('enter');
      if (box === '') return true; // an Enter on an empty box submits nothing
      if (swallowed < (behaviour.swallow ?? 0)) {
        swallowed += 1;
        return true;
      }
      submittedAt = clock;
      if (!behaviour.keepsLine) box = '';
      return true;
    },
    status: (_pane: string): string | null => {
      if (submittedAt === null || clock - submittedAt < (behaviour.lagMs ?? 0)) return behaviour.statusBefore ?? 'idle';
      return behaviour.after ?? 'working';
    },
    wait: async (ms: number): Promise<void> => {
      waited.push(ms);
      clock += ms;
    },
    readAnsi: (_pane: string): string | null => {
      if (behaviour.dialog !== undefined) return behaviour.dialog;
      if (cli.enters > 0 && behaviour.dialogAfterEnter !== undefined) return behaviour.dialogAfterEnter;
      if (cli.enters > 0 && behaviour.unreadAfterEnter) return null;
      if (box !== '') return screenWith(`${PROMPT}${box}`);
      const rows = submittedAt === null ? [] : (behaviour.transcript ?? []);
      return screenWith(behaviour.empty === 'blank' ? PROMPT : `${PROMPT}${FAINT('Try "fix typecheck errors"')}`, rows);
    },
  };
  return cli;
}

const settled = (cli: { waited: number[] }): number => cli.waited.reduce((sum, ms) => sum + ms, 0) - SETTLE_MS;

describe('a box that swallows the first Enter', () => {
  test('is pressed again and the delivery is verified', async () => {
    const cli = fakeCli({ swallow: 1 });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('delivered');
    expect(result.tries).toBe(2);
    expect(result.status).toBe('working');
    expect(cli.typed).toEqual([LINE]);
    expect(cli.enters).toBe(2);
  });

  test('a first Enter that works is the only one', async () => {
    const cli = fakeCli();
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1 });
    expect(cli.enters).toBe(1);
  });

  test('two swallowed Enters are still within the three tries', async () => {
    const cli = fakeCli({ swallow: 2 });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 3 });
  });
});

describe('a box that never submits', () => {
  test('is not-submitted, with the text the box holds, after three tries', async () => {
    const cli = fakeCli({ swallow: Infinity });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe(LINE);
    expect(result.tries).toBe(MAX_TRIES);
    expect(cli.enters).toBe(MAX_TRIES);
  });

  test('each try waits longer: one, three, then nine seconds', async () => {
    expect(BACKOFF_MS).toEqual([1000, 3000, 9000]);
    const cli = fakeCli({ swallow: Infinity });
    await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(settled(cli)).toBe(1000 + 3000 + 9000);
  });

  test('a seat working with the line still in the box is not verified', async () => {
    const cli = fakeCli({ keepsLine: true });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe(LINE);
  });

  test('a box that the seat cleared but herdr never called working is delivered as taken, and gets no more Enters', async () => {
    const cli = fakeCli({ after: 'idle' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', evidence: 'taken', prior: 'idle', tries: 1 });
    expect(result.box).toBeUndefined();
    expect(cli.enters).toBe(1);
    expect(settled(cli)).toBe(VERIFY_TOTAL_MS);
  });
});

describe('a faint suggestion in the box', () => {
  test('counts as empty: the line is typed, not held, and Enter is pressed once', async () => {
    const cli = fakeCli({ empty: 'suggestion' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1 });
    expect(cli.log).toEqual([`type:${LINE}`, 'enter']);
  });

  test('is never taken for the trigger: a cleared box with no proof is delivered as taken, and no Enter follows', async () => {
    const cli = fakeCli({ empty: 'suggestion', after: 'idle' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', evidence: 'taken', tries: 1 });
    expect(result.box).toBeUndefined();
    expect(cli.enters).toBe(1);
  });

  test('a blank box reads the same', async () => {
    const cli = fakeCli({ empty: 'blank' });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', tries: 1 });
  });
});

describe('a box or a pane that is not for typing', () => {
  test('text a person left in the box is held, and nothing is typed or sent', async () => {
    const cli = fakeCli({ preload: 'half a sentence' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'held', box: 'half a sentence', tries: 0 });
    expect(cli.log).toEqual([]);
  });

  test('a dialog is unreachable, and gets no key', async () => {
    const cli = fakeCli({ dialog: capture('permission-read-wide-ansi.txt') });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('unreachable');
    expect(result.reason).toContain('permission');
    expect(cli.log).toEqual([]);
  });

  test('a pane that will not take the text is unreachable', async () => {
    const cli = fakeCli({ refusesText: true });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'unreachable', tries: 0 });
    expect(cli.enters).toBe(0);
  });

  test('a status herdr cannot read is unreachable', async () => {
    const cli = { ...fakeCli(), status: () => null };
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('unreachable');
    expect(cli.typed).toEqual([]);
  });

  test('a box that reads back something other than the trigger gets no Enter', async () => {
    const cli = fakeCli();
    const typeText = cli.typeText;
    cli.typeText = (pane, text) => typeText(pane, `${text} and something else`);
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('held');
    expect(result.box).toContain('and something else');
    expect(cli.enters).toBe(0);
  });

  test('an Enter herdr did not take, with the line still in the box, is not-submitted with that line', async () => {
    const cli = fakeCli();
    cli.pressEnter = () => false;
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'not-submitted', box: LINE, tries: 0 });
  });

  test('an Enter herdr did not take, with nothing in the box to show for it, is unreachable', async () => {
    const cli = fakeCli({ empty: 'suggestion' });
    // The typed text never reaches the box this fake draws, so the pane cannot be keyed.
    const typeText = cli.typeText;
    cli.typeText = (pane, text) => (typeText(pane, text), true);
    cli.pressEnter = () => false;
    cli.readAnsi = () => screenWith(`${PROMPT}${FAINT('Try "fix typecheck errors"')}`);
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'unreachable', tries: 0 });
  });
});

describe('a box that cannot be read', () => {
  test('the herdr status alone verifies, as it did before', async () => {
    const cli = fakeCli();
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    expect(await deliverTrigger(blind, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', tries: 1 });
  });

  test('an unverified send is not-submitted with no box text, never a success', async () => {
    const cli = fakeCli({ swallow: Infinity });
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    const result = await deliverTrigger(blind, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBeUndefined();
  });
});

describe('a seat whose status lags', () => {
  const explored = `\u25cf Explored 1 file (${DROP_ID})`;

  test('a cleared box and a transcript that shows the drop read is delivered, with no status change at all', async () => {
    const cli = fakeCli({ after: 'idle', transcript: [`\u25cf Read /tmp/drops/native/${DROP_ID} and do that.`, explored] });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1, evidence: 'transcript' });
    expect(cli.enters).toBe(1);
  });

  test('the same is delivered whatever the faint suggestion, or a blank box', async () => {
    const cli = fakeCli({ after: 'idle', empty: 'blank', transcript: [explored] });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', evidence: 'transcript' });
  });

  test('the echo of the trigger in the transcript is not the drop being read: taken, not yet confirmed', async () => {
    const echo = [`\u276f Read /tmp/drops/native/${DROP_ID} and do that.`];
    const cli = fakeCli({ after: 'idle', transcript: echo });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', evidence: 'taken', tries: 1 });
    expect(cli.enters).toBe(1);
  });

  test('an echo wrapped over rows is not the drop being read either, and ends taken', async () => {
    const echo = ['\u276f Read /tmp/drops/native/', `  ${DROP_ID} and do`, '  that.'];
    const cli = fakeCli({ after: 'idle', transcript: echo });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', evidence: 'taken' });
  });

  test('a status that moves late, inside the longer window, is delivered', async () => {
    const cli = fakeCli({ lagMs: 15_000 });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', tries: 1, evidence: 'status' });
    expect(cli.enters).toBe(1);
  });

  test('a status that never moves, and a transcript that shows nothing, is taken after the whole window', async () => {
    const cli = fakeCli({ lagMs: Infinity });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', evidence: 'taken', tries: 1 });
    expect(settled(cli)).toBe(VERIFY_TOTAL_MS);
  });

  test('a transcript that shows the drop does not count while the box still holds the trigger', async () => {
    const cli = fakeCli({ keepsLine: true, after: 'idle', transcript: [explored] });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBe(LINE);
  });

  test('a box that cannot be read has no transcript to go by', async () => {
    const cli = fakeCli({ after: 'idle', transcript: [explored] });
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    expect((await deliverTrigger(blind, 'w1:p1', LINE, PROFILE)).outcome).toBe('not-submitted');
  });
});

describe('evidence has to come from this line', () => {
  const explored = `\u25cf Explored 1 file (${DROP_ID})`;

  test('a seat already working before Enter, still working after, with an empty box and no transcript, is taken', async () => {
    const cli = fakeCli({ statusBefore: 'working', after: 'working' });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result).toMatchObject({ outcome: 'delivered', evidence: 'taken', prior: 'working', tries: 1 });
    expect(cli.enters).toBe(1);
  });

  test('a seat already working that finishes its turn is taken too: the box cleared', async () => {
    const cli = fakeCli({ statusBefore: 'working', after: 'done' });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', evidence: 'taken' });
  });

  test('a seat already working is delivered when the transcript shows the drop read', async () => {
    const cli = fakeCli({ statusBefore: 'working', after: 'working', transcript: [explored] });
    expect(await deliverTrigger(cli, 'w1:p1', LINE, PROFILE)).toMatchObject({ outcome: 'delivered', evidence: 'transcript' });
  });

  test('a status that moved while the screen is a permission dialog is not delivered, and gets no key', async () => {
    const cli = fakeCli({ dialogAfterEnter: capture('permission-read-wide-ansi.txt') });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('unreachable');
    expect(result.dialog).toBe('permission');
    expect(cli.enters).toBe(1);
  });
});

describe('an unreadable box gets no second Enter', () => {
  test('a read that fails after a swallowed first Enter stops at one key, and is not-submitted with no box text', async () => {
    const cli = fakeCli({ swallow: Infinity, unreadAfterEnter: true });
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.box).toBeUndefined();
    expect(result.tries).toBe(1);
    expect(cli.enters).toBe(1);
  });

  test('a box that reads again later, still holding the trigger, is pressed again then', async () => {
    const cli = fakeCli({ swallow: 1 });
    const read = cli.readAnsi;
    let reads = 0;
    // The reads of the first window after the first Enter fail (the transcript read and the
    // re-read); the next re-read shows the box still holding the trigger.
    cli.readAnsi = (pane) => {
      if (cli.enters > 0 && reads++ < 2) return null;
      return read?.(pane) ?? null;
    };
    const result = await deliverTrigger(cli, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('delivered');
    expect(cli.enters).toBe(2);
  });

  test('a box that cannot be read at all gets one Enter, and no more however long the status is silent', async () => {
    const cli = fakeCli({ lagMs: Infinity });
    const blind: DeliverHost = { ...cli };
    delete blind.readAnsi;
    const result = await deliverTrigger(blind, 'w1:p1', LINE, PROFILE);
    expect(result.outcome).toBe('not-submitted');
    expect(result.tries).toBe(1);
    expect(cli.enters).toBe(1);
  });
});

describe('the drop in a screen', () => {
  test('the id is the last segment of the path the trigger names', () => {
    expect(dropIdOf(LINE)).toBe(DROP_ID);
    expect(dropIdOf('hello there')).toBeNull();
    expect(dropIdOf('Read /tmp/dir/ and do that.')).toBeNull();
  });

  test('a wake that names its sender names the same drop', () => {
    const named = LINE.replace(/^Read /, 'From tester-2@teamcli: read ');
    expect(dropPathOf(named)).toBe(dropPathOf(LINE));
    expect(dropIdOf(named)).toBe(DROP_ID);
    // The drop path is the one the trigger's own tail names, never a sender-supplied one.
    expect(dropPathOf('From tester-2@teamcli: read /tmp/x and do that.')).toBe('/tmp/x');
    expect(dropPathOf('From tester-2@teamcli /tmp/x and do that.')).toBeNull();
    expect(dropPathOf('From : read /tmp/x and do that.')).toBeNull();
  });

  test('a row that names the id counts, with or without styling and decoration', () => {
    expect(showsDrop(`\x1b[2m\u25cf Explored 1 file (${DROP_ID})\x1b[0m`, LINE)).toBe(true);
    expect(showsDrop(`\u2502 Read(${DROP_ID}) \u2502`, LINE)).toBe(true);
    expect(showsDrop(`reading ${DROP_ID}`, LINE)).toBe(true);
  });

  test('the trigger line, whole or wrapped, does not count', () => {
    expect(showsDrop(`\u276f ${LINE}`, LINE)).toBe(false);
    expect(showsDrop(`\u2502 ${LINE} \u2502`, LINE)).toBe(false);
    expect(showsDrop(`  ${DROP_ID} and do that.`, LINE)).toBe(false);
    expect(showsDrop('Read /tmp/drops/native/', LINE)).toBe(false);
  });

  test('another drop, or none, does not count', () => {
    expect(showsDrop('Explored 1 file (aaaaaaaa-0000)', LINE)).toBe(false);
    expect(showsDrop('', LINE)).toBe(false);
  });
});

describe('binding a pane to a session', () => {
  test('passes the session to every operation and reads the styled screen', async () => {
    const calls: string[] = [];
    const native: NativePane = {
      typeText: (session, pane, text) => (calls.push(`type ${session} ${pane} ${text}`), true),
      pressEnter: (session, pane) => (calls.push(`enter ${session} ${pane}`), true),
      status: (session, pane) => (calls.push(`status ${session} ${pane}`), 'idle'),
      wait: async () => {},
      paneText: (session, pane) => (calls.push(`read ${session} ${pane}`), 'screen'),
    };
    const host = bindPane(native, 'acme');
    host.typeText('w1:p1', 'x');
    host.pressEnter('w1:p1');
    host.status('w1:p1');
    expect(host.readAnsi?.('w1:p1')).toBe('screen');
    expect(calls).toEqual(['type acme w1:p1 x', 'enter acme w1:p1', 'status acme w1:p1', 'read acme w1:p1']);
  });

  test('a pane that cannot be read has no readAnsi', () => {
    const native: NativePane = { typeText: () => true, pressEnter: () => true, status: () => 'idle', wait: async () => {} };
    expect(bindPane(native, 'acme').readAnsi).toBeUndefined();
  });
});

describe('unsent text in the box', () => {
  type DraftBehaviour = {
    /** The screen before the first key: the box as a person left it. */
    screen: string;
    /** The draft's rows, as the box draws them once a key was sent. */
    draft: string;
    /** A seat mid-turn: herdr reports working before and after Enter. */
    working?: boolean;
    /** The keys reach nothing: the box stays as it is. */
    deafKeys?: boolean;
    /** Enters never submit; the trigger stays in the box. */
    neverSubmits?: boolean;
  };

  /** A pane with one box: the first read is `behaviour.screen`, then the box follows the keys,
   *  the typed trigger and the paste exactly as a CLI's composer does. */
  function draftCli(behaviour: DraftBehaviour): DeliverHost & { typed: string[]; keys: string[] } {
    let box = behaviour.draft;
    let touched = false;
    let submitted = false;
    const typed: string[] = [];
    const keys: string[] = [];
    return {
      typed,
      keys,
      typeText: (_pane: string, text: string): boolean => {
        typed.push(text);
        touched = true;
        const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
        box = paste ? paste[1] ?? '' : text;
        return true;
      },
      pressEnter: (): boolean => {
        if (behaviour.neverSubmits !== true) {
          box = '';
          submitted = true;
        }
        return true;
      },
      status: (): string => (behaviour.working === true || submitted ? 'working' : 'idle'),
      wait: async (): Promise<void> => {},
      readAnsi: (): string => (touched ? claudeBox(box) : behaviour.screen),
      sendKey: (_pane: string, key: string): boolean => {
        keys.push(key);
        touched = true;
        if (behaviour.deafKeys !== true) box = '';
        return true;
      },
    };
  }

  /** A drop path in a throwaway folder: the copy the delivery keeps sits beside it. */
  function dropSidecar(): { line: string; copy: string; cleanup(): void } {
    const dir = mkdtempSync(join(tmpdir(), 'team-draft-'));
    return {
      line: `Read ${join(dir, DROP_ID)} and do that.`,
      copy: join(dir, `${DROP_ID}.draft`),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test('is copied beside the drop, cleared with the measured keys, and pasted back after the trigger', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = draftCli({ screen: capture('unsent-typed-ansi.txt'), draft: 'Fix the' });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      // The draft is never typed as literal text: one clear key, the trigger, one bracketed paste.
      expect(cli.keys).toEqual(['ctrl+c']);
      expect(cli.typed).toEqual([sidecar.line, '\x1b[200~Fix the\x1b[201~']);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a multi-line draft from a real capture is held: its rows cannot be told from a soft wrap', async () => {
    const sidecar = dropSidecar();
    try {
      // Taken from claude-code 2.1.303 on herdr 0.7.1: four composer rows typed line by line,
      // one of them blank. The same drawing is what a wrapped one-line draft looks like, so the
      // rows cannot be copied faithfully and the box is left untouched.
      const screen = captureLater('unsent-multiline-ansi.txt');
      expect(captureDraft('claude-code', screen)).toEqual({
        why: 'over more than one drawn row, where a soft wrap cannot be told from a newline',
      });
      const cli = draftCli({ screen, draft: 'first row\nsecond row\n\nfourth row' });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(
        'the composer already holds unsent text over more than one drawn row, where a soft wrap cannot be told from a newline; it was left as it is',
      );
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a one-line draft the composer draws over several rows is held, never pasted back with an added newline', async () => {
    const sidecar = dropSidecar();
    try {
      // The drawing a word wrap makes: the draft's line continued at the box's own indent. A
      // newline the person typed draws the same way, so the row break cannot be copied faithfully.
      const wide = 'Please check the staging deployment logs for the billing service before handing the parser work to the night team.';
      const screen = screenWith(
        `${PROMPT}Please check the staging deployment logs for the billing\n  service before handing the parser work to the night team.`,
      );
      const cli = draftCli({ screen, draft: wide });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(
        'the composer already holds unsent text over more than one drawn row, where a soft wrap cannot be told from a newline; it was left as it is',
      );
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a draft typed during a running turn is cleared with the turn\'s own key, never the interrupt key', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = draftCli({
        screen: capture('unsent-typing-while-running-ansi.txt'),
        draft: 'hurry please',
        working: true,
      });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      // clear_working is ctrl+u for claude-code: ctrl+c would end the turn.
      expect(cli.keys).toEqual(['ctrl+u']);
      expect(cli.typed).toContain('\x1b[200~hurry please\x1b[201~');
    } finally {
      sidecar.cleanup();
    }
  });

  test('a draft behind the CLI\'s paste chip is held: nothing is typed and no key is sent', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = draftCli({ screen: capture('unsent-paste-ansi.txt'), draft: '' });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe('the composer already holds unsent text behind a paste chip; it was left as it is');
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a CLI with no measured clear keys is held, and nothing is typed', async () => {
    const sidecar = dropSidecar();
    try {
      const gemini = readFileSync(join(import.meta.dir, 'fixtures', 'gemini', '0.64.0', 'unsent.txt'), 'utf8').replace(/\r\n/g, '\n');
      const cli = draftCli({ screen: gemini, draft: 'RULES_RECEIVED' });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, 'gemini');
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe("the composer already holds unsent text, and this CLI's box has no measured clear keys; it was left as it is");
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual([]);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a box that will not empty keeps the copy beside the drop, and the reason names it', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = draftCli({ screen: capture('unsent-typed-ansi.txt'), draft: 'Fix the', deafKeys: true });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('held');
      expect(result.reason).toBe(`the composer already holds unsent text, and the box did not empty after 3 clear passes; the copy is at ${sidecar.copy}`);
      expect(result.draft).toEqual({ restored: false, copy: sidecar.copy });
      expect(readFileSync(sidecar.copy, 'utf8')).toBe('Fix the');
      expect(cli.typed).toEqual([]);
      expect(cli.keys).toEqual(['ctrl+c', 'ctrl+c', 'ctrl+c']);
    } finally {
      sidecar.cleanup();
    }
  });

  test('a not-submitted delivery puts the draft back before saying so', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = draftCli({ screen: capture('unsent-typed-ansi.txt'), draft: 'Fix the', neverSubmits: true });
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('not-submitted');
      expect(result.reason).toContain('the unsent text was pasted back');
      expect(result.draft).toEqual({ restored: true });
      // The trigger was cleared, then the draft pasted back — the box is the owner's again.
      expect(cli.keys).toEqual(['ctrl+c', 'ctrl+c']);
      expect(cli.typed).toEqual([sidecar.line, '\x1b[200~Fix the\x1b[201~']);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  /** A pane whose one-row draft is cleared and whose box keeps drawing the submitted trigger
   *  for the leave check's read; the redraw to an empty box lands inside the verify window. */
  function lateClearCli(line: string): DeliverHost & { typed: string[]; keys: string[] } {
    let box = 'Fix the';
    let entered = false;
    let cleared = false;
    let readsSinceEnter = 0;
    const typed: string[] = [];
    const keys: string[] = [];
    return {
      typed,
      keys,
      typeText: (_pane: string, text: string): boolean => {
        typed.push(text);
        const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
        box = paste ? paste[1] ?? '' : text;
        return true;
      },
      pressEnter: (): boolean => {
        entered = true;
        readsSinceEnter = 0;
        return true;
      },
      status: (): string => (entered ? 'working' : 'idle'),
      wait: async (): Promise<void> => {},
      readAnsi: (): string => {
        if (entered) {
          readsSinceEnter += 1;
          // The leave check's own read still sees the trigger drawn; the redraw follows it.
          if (readsSinceEnter === 1) return claudeBox(line);
          if (!cleared) {
            box = '';
            cleared = true;
          }
        }
        return claudeBox(box);
      },
      sendKey: (_pane: string, key: string): boolean => {
        keys.push(key);
        box = '';
        return true;
      },
    };
  }

  test('a box that empties only after the leave check is restored inside the verify window', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = lateClearCli(sidecar.line);
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      // One clear, the trigger, one Enter, then the owner's text back as one paste.
      expect(cli.keys).toEqual(['ctrl+c']);
      expect(cli.typed).toEqual([sidecar.line, '\x1b[200~Fix the\x1b[201~']);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });

  /** A pane whose reads fail for a moment after Enter (a redraw), then recover with the box
   *  empty: the leave check reads nothing, and the delivery verifies once reads come back. */
  function unreadLeaveCli(line: string): DeliverHost & { typed: string[]; keys: string[] } {
    let box = 'Fix the';
    let entered = false;
    let cleared = false;
    let readsSinceEnter = 0;
    const typed: string[] = [];
    const keys: string[] = [];
    return {
      typed,
      keys,
      typeText: (_pane: string, text: string): boolean => {
        typed.push(text);
        const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
        box = paste ? paste[1] ?? '' : text;
        return true;
      },
      pressEnter: (): boolean => {
        entered = true;
        readsSinceEnter = 0;
        return true;
      },
      status: (): string => (entered ? 'working' : 'idle'),
      wait: async (): Promise<void> => {},
      readAnsi: (): string | null => {
        if (entered) {
          readsSinceEnter += 1;
          if (readsSinceEnter <= 3) return null;
          if (!cleared) {
            box = '';
            cleared = true;
          }
        }
        return claudeBox(box);
      },
      sendKey: (_pane: string, key: string): boolean => {
        keys.push(key);
        box = '';
        return true;
      },
    };
  }

  test('a leave check whose read fails still restores the draft once reads recover', async () => {
    const sidecar = dropSidecar();
    try {
      const cli = unreadLeaveCli(sidecar.line);
      const result = await deliverTrigger(cli, 'w1:p1', sidecar.line, PROFILE);
      expect(result.outcome).toBe('delivered');
      expect(result.draft).toEqual({ restored: true });
      expect(cli.keys).toEqual(['ctrl+c']);
      expect(cli.typed).toEqual([sidecar.line, '\x1b[200~Fix the\x1b[201~']);
      expect(existsSync(sidecar.copy)).toBe(false);
    } finally {
      sidecar.cleanup();
    }
  });
});
