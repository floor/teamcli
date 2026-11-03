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
import { readBox, readScreen, type Screen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const FIXTURES_142 = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2');
const FIXTURES_1216 = join(import.meta.dir, 'fixtures', 'antigravity', '1.2.16');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const IDLE_COMPACTED = readFileSync(join(FIXTURES, 'idle-compacted.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const EXIT_UNSENT = readFileSync(join(FIXTURES, 'exit-completion-unsent.txt'), 'utf8');
const PERMISSION_DIALOG = readFileSync(join(FIXTURES_142, 'permission.txt'), 'utf8');
const QUESTION_DIALOG = readFileSync(join(FIXTURES_142, 'question.txt'), 'utf8');
const TRUST_DIALOG = readFileSync(join(FIXTURES_142, 'trust.txt'), 'utf8');
const CONFIRMATION_DIALOG = readFileSync(join(FIXTURES_1216, 'question-unsent-54.txt'), 'utf8');

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

  test('a drawn line that one Enter leaves unsent is submitted again, and the line is not retyped', async () => {
    const drawn = holding(LINE);
    let settleReads = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) {
        settleReads += 1;
        return settleReads === 1 ? holding('Read') : drawn;
      }
      return enters === 1 ? drawn : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(settleReads).toBe(3);
    expect(readScreen('antigravity', drawn).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, drawn)).toBe(true);
    expect(out).toEqual({ delivered: true, typed: true, tries: 2, reason: 'the working screen showed after 2 Enters' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(2);
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

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(boxHoldsText('antigravity', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(spacesOnly.typed).toEqual([LINE]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(readScreen('antigravity', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(internalSpaces.typed).toEqual([LINE]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('a box with partial text refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    expect(readScreen('antigravity', holding(prefix)).kind).toBe('unsent');
    expect(boxHoldsText('antigravity', LINE, holding(prefix))).toBe(false);
    expect(boxHoldsText('antigravity', LINE, holding(suffix))).toBe(false);

    const beforeKey = wakeFake(() => holding(prefix));
    const outBefore = await deliverTypedWake(beforeKey.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outBefore).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(beforeKey.typed).toEqual([]);
    expect(beforeKey.enters).toBe(0);

    const afterPrefix = wakeFake((read) => (read < 2 ? IDLE : holding(prefix)));
    const outPrefix = await deliverTypedWake(afterPrefix.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outPrefix).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(afterPrefix.typed).toEqual([LINE]);
    expect(afterPrefix.enters).toBe(0);

    const afterSuffix = wakeFake((read) => (read < 2 ? IDLE : holding(suffix)));
    const outSuffix = await deliverTypedWake(afterSuffix.host, 'pane-1', LINE, 'antigravity', FAST);
    expect(outSuffix).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(afterSuffix.typed).toEqual([LINE]);
    expect(afterSuffix.enters).toBe(0);
  });

  test('captured dialog frames (permission, question, trust, confirmation) refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['permission', PERMISSION_DIALOG],
      ['question', QUESTION_DIALOG],
      ['trust', TRUST_DIALOG],
      ['confirmation', CONFIRMATION_DIALOG],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('antigravity', frame).kind).toBe(kind);
      expect(boxHoldsText('antigravity', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'antigravity', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: `the screen read ${kind} after the line was typed; no Enter was pressed` });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
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
    // The closing line ends with the record's id; the scene's subject is the outcome, not the id.
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nagy: delivered (typed wake)\n');
    // One line, one Enter, and the line is the trigger that names the seat's own fastest read
    // path, never the body: an antigravity seat carries an MCP inbox (`mcp_inbox: registered`),
    // so its profile's `read_hint` sends the woken turn straight to `inbox_check`.
    expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: call inbox_check now.']);
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
      // `mcp-inbox` is not a delivery leg in this build (src/send/walk-cascade.ts): the inbox is
      // the store's reader, and a declared `mcp-inbox` word is reported as skipped, never
      // recorded in `failed`. The typed leg took the send, so nothing behind it failed.
      expect(history.entries[0]?.failed).toBeUndefined();
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
      // The declared `mcp-inbox` word is skipped, not a failure; the typed leg is the one that
      // refused, and the drop leg then took the send.
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed unsent, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('a dialog frame in team send leaves the message in the bus inbox and types nothing', async () => {
    const made = agyWorld();
    const pane = wakeFake(() => PERMISSION_DIALOG);
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['agy', 'hello'], io, host)).toBe(0);
    expect(io.out).toContain('agy: sent (unconfirmed)');
    expect(io.out).toContain('the typed wake failed (the first read showed permission, not an empty idle prompt; nothing was typed)');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'agy', outcome: 'sent (unconfirmed)', via: 'drop' });
      // As above: the skipped `mcp-inbox` word is no failure, and the dialog is what refused the
      // typed leg.
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed permission, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('a long summary and multi-line body on Antigravity truncates the header to fit <= 80 chars, keeps call inbox_check now whole, and never types the body', async () => {
    const made = agyWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'agy', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const longBody = `SUMMARY-${'G'.repeat(120)}\nSECOND-LINE-BODY-SECRET\nTHIRD-LINE-BODY-SECRET`;
    const io = owner(made.root);
    expect(await runSend(['agy', longBody], io, host)).toBe(0);
    expect(pane.typed).toHaveLength(1);
    const typedLine = pane.typed[0] as string;
    expect(typedLine.length).toBe(80);
    expect(typedLine.endsWith(' Read it with: call inbox_check now.')).toBe(true);
    expect(typedLine.startsWith('Message from owner (owner@acme): SUMMARY-')).toBe(true);
    expect(typedLine).not.toContain('\n');
    expect(typedLine).not.toContain('SECOND-LINE-BODY-SECRET');
    expect(typedLine).not.toContain('THIRD-LINE-BODY-SECRET');
    const drops = join(made.dir, 'send-drops', 'acme', 'agy');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed(longBody));
  });
});
