// The antigravity typed wake, read on the captured 1.4.12 frames in
// test/fixtures/antigravity/1.4.12/: the empty idle box, the same box under a compacted
// transcript, the braille spinner row of a running turn, and the `/exit` completion frame whose
// box holds `/exit`. The gate is the profile's own screens: nothing is typed unless two reads
// showed the empty idle prompt, and the completion frame is a box holding text, so it refuses.
// The scenes below script the pane; no CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const IDLE_COMPACTED = readFileSync(join(FIXTURES, 'idle-compacted.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const EXIT_UNSENT = readFileSync(join(FIXTURES, 'exit-completion-unsent.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

/** The captured idle frame with `text` drawn in its empty input row: the `>` row between the
 *  box's two rules, never the transcript's own prompt line above them. The function form keeps
 *  `text`'s own characters literal, and puts the captured rule row back unchanged. */
function holding(text: string): string {
  return IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
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
  });
});

describe('the antigravity typed wake: the profile’s own screens gate the keys', () => {
  test('two idle reads, one line, one Enter on the captured frames: the spinner row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the compacted-transcript idle frame still types: a long transcript is not a refusal', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE_COMPACTED : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out.delivered).toBe(true);
    expect(out.tries).toBe(1);
    expect(pane.typed).toEqual([LINE]);
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

  test('an exit-completion frame drawn after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : EXIT_UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
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
    expect(io.out).toBe('team acme, session "acme"\nagy: delivered (typed wake)\n');
    // One line, one Enter, and the line is the trigger that reads the drop, never the body.
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain('team drops --read');
    expect((pane.typed[0] as string).length).toBeLessThanOrEqual(80);
    expect(pane.enters).toBe(1);
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
      expect(history.entries[0]?.failed).toEqual(['mcp-inbox: no live inbox listener']);
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
    expect(io.out).toContain('agy: sent (unconfirmed)');
    expect(io.out).toContain('the typed wake failed (the first read showed unsent, not an empty idle prompt; nothing was typed)');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'sent (unconfirmed)', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'mcp-inbox: no live inbox listener',
        'typed: the first read showed unsent, not an empty idle prompt; nothing was typed',
      ]);
    }
  });
});
