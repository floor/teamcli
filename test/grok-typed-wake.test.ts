// The Grok Build typed wake. The empty idle box is the sanitized 1.0.70 welcome frame in
// test/fixtures/grok/1.0.70/. The working turn and the answer widget are the shipped 1.0.52
// frames. The gate is the profile's own screens: nothing is typed unless two reads showed the
// empty idle prompt. A working turn, text in the box, or the answer widget refuses. The scenes
// below script the pane; no CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen, type Screen } from '../src/watch/screen.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.70', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');
const WORKING_START = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'working-start.txt'), 'utf8');
const WORKING_TOOL = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'working-tool.txt'), 'utf8');
const QUESTION = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'question.txt'), 'utf8');
const PERMISSION = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'permission.txt'), 'utf8');
const UNSENT = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'unsent.txt'), 'utf8');
const UNSENT_WRAP = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'unsent-wrap.txt'), 'utf8');
const SLASH_MENU = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'slash-menu.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The captured idle frame with `text` drawn in its empty input row: the `❯` row between the
 *  box's two rules. The right-edge border stays, and the padding shrinks by the text. */
function drawn(frame: string, text: string): string {
  return frame.replace(/^( {2}│ ❯)(.*)$/m, (_match, prompt: string, rest: string) => {
    const trimmed = rest.trimEnd();
    const edge = trimmed.endsWith('│') ? '│' : '';
    const room = trimmed.length - edge.length;
    const gap = Math.max(1, room - text.length);
    return `${prompt} ${text}${' '.repeat(gap)}${edge}`;
  });
}

function holding(text: string): string {
  return drawn(IDLE, text);
}

/** The captured working frame with `text` still in the composer. The spinner row keeps the
 *  screen working; the composer read is unsent while the line sits there. */
function workingHolding(text: string): string {
  return drawn(WORKING, text);
}

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it.
 *  The trigger a send composes is not known until the send runs, so a scene that wants the box
 *  to read back the line draws the text the wake itself typed. `wait` costs nothing. */
function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
  options: { typeOk?: boolean; enterOk?: boolean } = {},
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return options.typeOk ?? true;
    },
    enter: () => {
      state.enters += 1;
      return options.enterOk ?? true;
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

describe('the frames the Grok wake reads back', () => {
  test('the profile declares the wake, and the captured frames read as the gate needs', () => {
    expect(profileFor('grok')?.typedWake).toBe('screen');
    expect(readScreen('grok', IDLE).kind).toBe('idle');
    expect(readScreen('grok', WORKING).kind).toBe('working');
    expect(readScreen('grok', QUESTION).kind).toBe('question');
    expect(readScreen('grok', UNSENT).kind).toBe('unsent');
    expect(readBox('grok', UNSENT)).toMatchObject({ first: 'RULES_RECEIVED', rows: [] });
    expect(boxHoldsText('grok', LINE, UNSENT)).toBe(false);
    expect(readScreen('grok', holding(LINE)).kind).toBe('unsent');
    expect(boxHoldsText('grok', LINE, holding(LINE))).toBe(true);
  });
});

describe('the Grok typed wake: the profile’s own screens gate the keys', () => {
  test('two idle reads, one line, one Enter on the captured frames: the spinner row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that still holds the line is not delivered until the box empties', async () => {
    const held = workingHolding(LINE);
    expect(readScreen('grok', held).kind).toBe('working');
    expect(boxHoldsText('grok', LINE, held)).toBe(true);
    let post = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      post += 1;
      return post < 3 ? held : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', { ...FAST, verifyMs: 3 });
    expect(post).toBe(3);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that keeps the line through the bound is not delivered', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? workingHolding(LINE) : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working pane is never typed into', async () => {
    const pane = wakeFake(() => WORKING);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('the answer widget refuses before a key', async () => {
    const pane = wakeFake(() => QUESTION);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed question, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('text already in the box refuses before a key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a second read that shows the answer widget stops the wake before any key', async () => {
    const pane = wakeFake((read) => (read === 0 ? IDLE : QUESTION));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed question, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('text drawn into the box after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'grok', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
  });

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'grok', FAST);
    expect(readScreen('grok', holding('    ')).kind).toBe('idle');
    expect(boxHoldsText('grok', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(spacesOnly.typed).toEqual([LINE]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'grok', FAST);
    expect(readScreen('grok', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('grok', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(internalSpaces.typed).toEqual([LINE]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('partial or wrapped text in the box refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    for (const draft of [holding(prefix), holding(suffix), UNSENT_WRAP, SLASH_MENU]) {
      expect(readScreen('grok', draft).kind).toBe('unsent');
      expect(boxHoldsText('grok', LINE, draft)).toBe(false);

      const firstRead = wakeFake(() => draft);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : draft));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : draft));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'grok', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('captured dialog and working frames refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['question', QUESTION],
      ['question', PERMISSION],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('grok', frame).kind).toBe(kind);
      expect(boxHoldsText('grok', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'grok', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: `the screen read ${kind} after the line was typed; no Enter was pressed` });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }

    for (const workingFrame of [WORKING, WORKING_START, WORKING_TOOL]) {
      expect(readScreen('grok', workingFrame).kind).toBe('working');
      expect(boxHoldsText('grok', LINE, workingFrame)).toBe(false);

      const firstRead = wakeFake(() => workingFrame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : workingFrame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'grok', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : workingFrame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'grok', FAST);
      expect(outAfter).toEqual({
        delivered: false,
        typed: true,
        tries: 0,
        reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
      });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });
});

describe('team send: the Grok typed wake', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  /** A Grok seat with the inbox tried first: the build walks mcp-inbox, then the typed wake. */
  function grokWorld() {
    const made = world(['mcp-inbox', 'typed'], [{ name: 'grok', role: 'implementer', cli: 'grok', launch: 'grok' }]);
    cleanups.push(made.cleanup);
    return made;
  }

  test('a Grok seat is woken by one typed trigger, and the send is delivered', async () => {
    const made = grokWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'grok', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['grok', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\ngrok: delivered (typed wake)\n');
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain('team drops --read');
    expect((pane.typed[0] as string).length).toBeLessThanOrEqual(80);
    expect(pane.enters).toBe(1);
    const drops = join(made.dir, 'send-drops', 'acme', 'grok');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'grok', outcome: 'delivered (typed wake)', via: 'typed' });
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('the answer widget leaves the message in the bus inbox, and the sender is told so', async () => {
    const made = grokWorld();
    const pane = wakeFake(() => QUESTION);
    const host = fake(made, {
      agents: () => [{ name: 'grok', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['grok', 'hello'], io, host)).toBe(0);
    // The typed wake failed and the walk ends on the drop leg, which wakes nothing: the ending is
    // `queued, not woken`, the same word the history line carries, never `sent (unconfirmed)`.
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\ngrok: queued, not woken (drop, 0 ms); queued; the typed wake failed (the first read showed question, not an empty idle prompt; nothing was typed); grok reads it at its next turn, and nothing here gives it one (pull-only)\n');
    expect(io.err).toBe(queuedLine('grok', NO_EVENT_ADAPTER_TOOK_IT));
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'grok', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed question, not an empty idle prompt; nothing was typed',
      ]);
    }
  });
});
