// The cursor typed wake, read on the captured 2026.10.22 frames in
// test/fixtures/cursor/2026.10.22/: the empty idle box, a draft in the box, and the `Working`
// frame. No CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { SUBMIT_ENTER } from '../src/herdr.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { composeMessageLine } from '../src/settings/message-display.ts';
import { readScreen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const DRAWING = readFileSync(join(FIXTURES, 'drawing.txt'), 'utf8');
const SETTLED = readFileSync(join(FIXTURES, 'drawing-settled.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';

/** The captured unsent frame with `text` drawn in its input row: `Fix the failing test` is the
 *  capture's own draft, and the row's prompt and trailing cells are left as captured. */
function holding(text: string): string {
  return UNSENT.replace('Fix the failing test', () => text);
}

/** The captured working frame with `text` in the follow-up row. The placeholder is split by
 *  styling; typed text is not, and `ctrl+c to stop` stays so the row is still the working
 *  screen. The composer read is unsent while the line sits there. */
function workingHolding(text: string): string {
  const lines = WORKING.split('\n');
  const row = lines.findIndex((line) => line.includes('follow-up'));
  lines[row] = ` \u001b[0m\u001b[48;2;21;21;21m → ${text}\u001b[0m\u001b[48;2;21;21;21m                  \u001b[0m\u001b[2m\u001b[48;2;21;21;21mctrl+c to stop\u001b[0m\u001b[48;2;21;21;21m \u001b[0m`;
  return lines.join('\n');
}

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it. The
 *  trigger a send composes is not known until the send runs, so a scene that wants the box to
 *  read back the line draws the text the wake itself typed. `wait` costs nothing. */
function wakeFake(screen: (read: number, enters: number, typed: readonly string[]) => string | null): {
  host: TypedWakeHost;
  typed: string[];
  enters: number;
} {
  const typed: string[] = [];
  const state = { enters: 0, reads: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.enters, typed),
    type: (_pane: string, text: string) => {
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
  };
}

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

describe('the cursor typed wake', () => {
  test('the profile declares the wake and the captured frames read as the gate needs', () => {
    expect(profileFor('cursor')?.typedWake).toBe('screen');
    // The inbox is registered in the seat's own `.cursor/mcp.json`, so the wake names the tool:
    // `inbox_check` lists the waiting messages and the id `inbox_read` takes.
    expect(profileFor('cursor')?.readHint).toBe('Read it with: call inbox_check now.');
    expect(readScreen('cursor', IDLE).kind).toBe('idle');
    expect(readScreen('cursor', WORKING).kind).toBe('working');
    expect(readScreen('cursor', holding(LINE)).kind).toBe('unsent');
  });

  test('two idle reads, one line, one Enter: the Working row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that still holds the line is not delivered until the box empties', async () => {
    const held = workingHolding(LINE);
    expect(readScreen('cursor', held).kind).toBe('working');
    expect(boxHoldsText('cursor', LINE, held)).toBe(true);
    let post = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      post += 1;
      return post < 3 ? held : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', { ...FAST, verifyMs: 3 });
    expect(post).toBe(3);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that keeps the line through the bound is not delivered', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? workingHolding(LINE) : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
    });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a sitting wake line in the cursor box is submitted with Enter and not typed again', async () => {
    const line = composeMessageLine(
      'Message from owner (owner@acme): hello',
      'Read it with: call inbox_check now.',
    );
    expect(line).not.toBeNull();
    if (line === null) return;
    expect(line.endsWith('Read it with: call inbox_check now.')).toBe(true);
    const held = UNSENT.replace(/Fix the failing test\s*/, () => line);
    expect(readScreen('cursor', held).kind).toBe('unsent');
    expect(boxHoldsText('cursor', line, held)).toBe(true);
    const pane = wakeFake((_read, enters) => (enters > 0 ? WORKING : held));
    const out = await deliverTypedWake(pane.host, 'pane-1', line, 'cursor', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(1);
  });

  test('an unsent box refuses before any key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a line still drawing is not submitted until two reads of the settled row agree', async () => {
    expect(SUBMIT_ENTER).toBe('enter');
    expect(readScreen('cursor', DRAWING).kind).toBe('unsent');
    expect(boxHoldsText('cursor', LINE, DRAWING)).toBe(false);
    expect(readScreen('cursor', SETTLED).kind).toBe('unsent');
    expect(boxHoldsText('cursor', LINE, SETTLED)).toBe(true);
    let draws = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters > 0) return WORKING;
      draws += 1;
      return draws === 1 ? DRAWING : SETTLED;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(draws).toBe(3);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a line that does not fit one row is not typed', async () => {
    const pane = wakeFake(() => IDLE);
    const over = await deliverTypedWake(pane.host, 'pane-1', 'x'.repeat(81), 'cursor', FAST);
    expect(over).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the line does not fit 80 characters on one row; nothing was typed' });
    const broken = await deliverTypedWake(pane.host, 'pane-1', 'one\ntwo', 'cursor', FAST);
    expect(broken).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the line does not fit 80 characters on one row; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });
});

describe('team send: the cursor typed wake names the inbox tool', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  /** A cursor seat with no declared order: the build's own default (`mcp-inbox, typed, drop`)
   *  is the walk these scenes read. */
  function cursorWorld() {
    const made = world(null, [{ name: 'cursor', role: 'implementer', cli: 'cursor', launch: 'cursor' }]);
    cleanups.push(made.cleanup);
    return made;
  }

  test('a cursor seat is woken by one typed trigger naming its inbox, and the send is delivered', async () => {
    const made = cursorWorld();
    // The send composes the trigger itself, so the box reads back whatever the wake typed.
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\ncursor: delivered (typed wake)\n');
    // One line, one Enter, and the line is the trigger that names the seat's own fastest read
    // path, never the body: an MCP inbox seat is sent straight to `inbox_check`.
    expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: call inbox_check now.']);
    expect((pane.typed[0] as string).length).toBeLessThanOrEqual(80);
    expect(pane.enters).toBe(1);
    // The record was written under the seat lock before the line was typed.
    const drops = join(made.dir, 'send-drops', 'acme', 'cursor');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'delivered (typed wake)', via: 'typed' });
      // The inbox is the store's reader, never a leg the walk attempts: a `mcp-inbox` word in
      // the declared order is reported as skipped, not recorded as a failure, and the typed leg
      // took the send.
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('a long summary and multi-line body on Cursor truncates the header to fit <= 80 chars, keeps call inbox_check now whole, and never types the body', async () => {
    const made = cursorWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const longBody = `SUMMARY-${'C'.repeat(120)}\nSECOND-LINE-BODY-SECRET\nTHIRD-LINE-BODY-SECRET`;
    const io = owner(made.root);
    expect(await runSend(['cursor', longBody], io, host)).toBe(0);
    expect(pane.typed).toHaveLength(1);
    const typedLine = pane.typed[0] as string;
    expect(typedLine.length).toBe(80);
    expect(typedLine.endsWith(' Read it with: call inbox_check now.')).toBe(true);
    expect(typedLine.startsWith('Message from owner (owner@acme): SUMMARY-')).toBe(true);
    expect(typedLine).not.toContain('\n');
    expect(typedLine).not.toContain('SECOND-LINE-BODY-SECRET');
    expect(typedLine).not.toContain('THIRD-LINE-BODY-SECRET');
    const drops = join(made.dir, 'send-drops', 'acme', 'cursor');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed(longBody));
  });

  test('independent adversarial: line held while working through bound in send is not delivered, never retyped, and message stays unread; box cleared or partial line mid-poll refuses', async () => {
    // 1. Line held while working through the bound in `runSend` -> not delivered, never retyped, message still unread.
    const made = cursorWorld();
    const pane = wakeFake((read, enters, typed) => {
      if (read < 2) return IDLE;
      const line = typed[typed.length - 1] ?? '';
      return enters === 0 ? holding(line) : workingHolding(line);
    });
    const host = fake(made, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['cursor', 'check held'], io, host)).toBe(0);
    expect(io.out).toContain('cursor: queued, not woken (drop, 0 ms); queued; the typed wake failed (the working screen showed with the line still in the box after 1 Enter; the line was not submitted)');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    const drops = join(made.dir, 'send-drops', 'acme', 'cursor');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    const msgId = records[0]!;
    expect(existsSync(join(drops, `${msgId}.read.json`))).toBe(false);
    expect(listUnread(drops, { to: 'cursor', root: made.root, session: 'acme' }, host.home).map((m) => m.id)).toEqual([msgId]);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the working screen showed with the line still in the box after 1 Enter; the line was not submitted',
      ]);
    }

    // 2. Box cleared by someone else mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees IDLE).
    let clearPoll = 0;
    const clearedMidPoll = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      clearPoll += 1;
      return clearPoll <= 2 ? workingHolding(LINE) : IDLE;
    });
    const outCleared = await deliverTypedWake(clearedMidPoll.host, 'pane-1', LINE, 'cursor', { ...FAST, verifyMs: 4 });
    expect(outCleared).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the screen read idle and no working screen showed',
    });
    expect(clearedMidPoll.typed).toEqual([LINE]);
    expect(clearedMidPoll.enters).toBe(1);

    // 3. A partial line left mid-poll (poll 1 sees workingHolding(LINE), poll 2..N sees holding(partial)).
    for (const partial of [LINE.slice(0, 12), LINE.slice(5)]) {
      let partialPoll = 0;
      const partialMidPoll = wakeFake((read, enters) => {
        if (read < 2) return IDLE;
        if (enters === 0) return holding(LINE);
        partialPoll += 1;
        return partialPoll <= 2 ? workingHolding(LINE) : holding(partial);
      });
      const outPartial = await deliverTypedWake(partialMidPoll.host, 'pane-1', LINE, 'cursor', { ...FAST, verifyMs: 4 });
      expect(outPartial).toEqual({
        delivered: false,
        typed: true,
        tries: 1,
        reason: 'the box held text other than the line and no working screen showed',
      });
      expect(partialMidPoll.typed).toEqual([LINE]);
      expect(partialMidPoll.enters).toBe(1);
    }
  });
});
