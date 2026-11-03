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
import { readBox, readScreen } from '../src/watch/screen.ts';
import { recordBody } from './helpers.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';

const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.70', 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');
const QUESTION = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'question.txt'), 'utf8');
const UNSENT = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'unsent.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The captured idle frame with `text` drawn in its empty input row: the `❯` row between the
 *  box's two rules. The right-edge border stays, and the padding shrinks by the text. */
function holding(text: string): string {
  return IDLE.replace(/^( {2}│ ❯)(.*)$/m, (_match, prompt: string, rest: string) => {
    const trimmed = rest.trimEnd();
    const edge = trimmed.endsWith('│') ? '│' : '';
    const room = trimmed.length - edge.length;
    const gap = Math.max(1, room - text.length);
    return `${prompt} ${text}${' '.repeat(gap)}${edge}`;
  });
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
    expect(io.out).toBe('team acme, session "acme"\ngrok: delivered (typed wake)\n');
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
      expect(history.entries[0]?.failed).toEqual(['mcp-inbox: no live inbox listener']);
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
    expect(io.out).toBe('team acme, session "acme"\ngrok: sent (unconfirmed) (drop, 0 ms); queued; the typed wake failed (the first read showed question, not an empty idle prompt; nothing was typed); grok reads it at its next turn, and nothing here gives it one (pull-only)\n');
    expect(io.err).toBe(queuedLine('grok', NO_EVENT_ADAPTER_TOOK_IT));
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'grok', outcome: 'sent (unconfirmed)', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'mcp-inbox: no live inbox listener',
        'typed: the first read showed question, not an empty idle prompt; nothing was typed',
      ]);
    }
  });
});
