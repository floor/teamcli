// The Codex typed wake, read on the shipped 0.157.0 frames. The empty idle box is the grey
// suggestion. The working row, the box that holds text, and the permission dialog are the
// refusals. The gate is the profile's own screens: nothing is typed unless two reads showed the
// empty idle prompt. The scenes below script the pane; no CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen, type Screen } from '../src/watch/screen.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.157.0');
const FIXTURES_161 = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const WORKING_161 = readFileSync(join(FIXTURES_161, 'working.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent.txt'), 'utf8');
const PERMISSION = readFileSync(join(FIXTURES, 'permission.txt'), 'utf8');
const PERMISSION_161 = readFileSync(join(FIXTURES_161, 'permission.txt'), 'utf8');
const TRUST = readFileSync(join(FIXTURES, 'trust.txt'), 'utf8');
const TRUST_161 = readFileSync(join(FIXTURES_161, 'trust.txt'), 'utf8');
const PLAN_APPROVAL = readFileSync(join(FIXTURES_161, 'plan-approval.txt'), 'utf8');
const QUESTION_161 = readFileSync(join(FIXTURES_161, 'question.txt'), 'utf8');
const VENDOR_NOTICE = readFileSync(join(FIXTURES, 'startup.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };
const NATIVE_MISSED = 'native: no trusted runtime session is recorded for this seat (no agent record for this seat)';

/** The captured idle frame with `text` drawn in place of the grey suggestion. */
function holding(text: string): string {
  return IDLE.replace('› Ask Codex to do anything', `› ${text}`);
}

/** The captured working frame with `text` still in the composer. The working row keeps the
 *  screen working; the composer read is unsent while the line sits there. */
function workingHolding(text: string): string {
  return WORKING.replace('› Ask Codex to do anything', `› ${text}`);
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

describe('the frames the Codex wake reads back', () => {
  test('the profile declares the wake, and the captured frames read as the gate needs', () => {
    expect(profileFor('codex')?.typedWake).toBe('screen');
    expect(readScreen('codex', IDLE).kind).toBe('idle');
    expect(readScreen('codex', WORKING).kind).toBe('working');
    expect(readScreen('codex', UNSENT).kind).toBe('unsent');
    expect(readScreen('codex', PERMISSION).kind).toBe('permission');
    expect(readBox('codex', UNSENT)?.first).toBe('Rules for this session, from the team file:');
    expect(boxHoldsText('codex', LINE, UNSENT)).toBe(false);
    expect(readScreen('codex', holding(LINE)).kind).toBe('unsent');
    expect(boxHoldsText('codex', LINE, holding(LINE))).toBe(true);
  });
});

describe('the Codex typed wake: the profile’s own screens gate the keys', () => {
  test('two idle reads, one line, one Enter on the captured frames: the working row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that still holds the line is not delivered until the box empties', async () => {
    const held = workingHolding(LINE);
    expect(readScreen('codex', held).kind).toBe('working');
    expect(boxHoldsText('codex', LINE, held)).toBe(true);
    let post = 0;
    const pane = wakeFake((read, enters) => {
      if (read < 2) return IDLE;
      if (enters === 0) return holding(LINE);
      post += 1;
      return post < 3 ? held : WORKING;
    });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', { ...FAST, verifyMs: 3 });
    expect(post).toBe(3);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a working screen that keeps the line through the bound is not delivered', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? workingHolding(LINE) : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
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
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('text already in the box refuses before a key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a permission dialog refuses before a key', async () => {
    const pane = wakeFake(() => PERMISSION);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed permission, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a second read that shows the permission dialog stops the wake before any key', async () => {
    const pane = wakeFake((read) => (read === 0 ? IDLE : PERMISSION));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed permission, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('text drawn into the box after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : UNSENT));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'codex', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
  });

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'codex', FAST);
    expect(readScreen('codex', holding('    ')).kind).toBe('idle');
    expect(boxHoldsText('codex', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(spacesOnly.typed).toEqual([LINE]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'codex', FAST);
    expect(readScreen('codex', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('codex', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(internalSpaces.typed).toEqual([LINE]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('partial text or a modified suggestion in the box refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    const partialSuggestion = 'Ask Codex to do';
    const extendedSuggestion = 'Ask Codex to do anything now';
    for (const draft of [holding(prefix), holding(suffix), holding(partialSuggestion), holding(extendedSuggestion)]) {
      expect(readScreen('codex', draft).kind).toBe('unsent');
      expect(boxHoldsText('codex', LINE, draft)).toBe(false);

      const firstRead = wakeFake(() => draft);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : draft));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : draft));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'codex', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('captured dialog and working frames refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['permission', PERMISSION],
      ['permission', PERMISSION_161],
      ['trust', TRUST],
      ['trust', TRUST_161],
      ['plan approval', PLAN_APPROVAL],
      ['question', QUESTION_161],
      ['vendor notice', VENDOR_NOTICE],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('codex', frame).kind).toBe(kind);
      expect(boxHoldsText('codex', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'codex', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: `the screen read ${kind} after the line was typed; no Enter was pressed` });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }

    for (const workingFrame of [WORKING, WORKING_161]) {
      expect(readScreen('codex', workingFrame).kind).toBe('working');
      expect(boxHoldsText('codex', LINE, workingFrame)).toBe(false);

      const firstRead = wakeFake(() => workingFrame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : workingFrame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'codex', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : workingFrame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'codex', FAST);
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

describe('team send: the Codex typed wake', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  /** The fixture's Codex seat is `native`. The declared order tries the inbox, then the runtime
   *  queue is inserted ahead of the typed wake. */
  function codexWorld() {
    const made = world(['mcp-inbox', 'typed']);
    cleanups.push(made.cleanup);
    return made;
  }

  test('a Codex seat is woken by one typed trigger after the queue cannot take it', async () => {
    const made = codexWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'native', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['native', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nnative: delivered (typed wake)\n');
    expect(pane.typed).toHaveLength(1);
    expect(pane.typed[0]).toContain('team drops --read');
    expect((pane.typed[0] as string).length).toBeLessThanOrEqual(80);
    expect(pane.enters).toBe(1);
    const drops = join(made.dir, 'send-drops', 'acme', 'native');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'native', outcome: 'delivered (typed wake)', via: 'typed' });
      expect(history.entries[0]?.failed).toEqual([NATIVE_MISSED]);
    }
  });

  test('a permission dialog leaves the message in the bus inbox, and the sender is told so', async () => {
    const made = codexWorld();
    const pane = wakeFake(() => PERMISSION);
    const host = fake(made, {
      agents: () => [{ name: 'native', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['native', 'hello'], io, host)).toBe(0);
    // The typed wake failed and the walk ends on the drop leg, which wakes nothing: the ending is
    // `queued, not woken`, the same word the history line carries, never `sent (unconfirmed)`.
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nnative: queued, not woken (drop, 0 ms); queued; the typed wake failed (the first read showed permission, not an empty idle prompt; nothing was typed); native reads it at its next turn, and nothing here gives it one (pull-only)\n');
    expect(io.err).toBe(queuedLine('native', NO_EVENT_ADAPTER_TOOK_IT));
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'native', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        NATIVE_MISSED,
        'typed: the first read showed permission, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('independent adversarial: line held while working through bound in send is not delivered, never retyped, and message stays unread; box cleared or partial line mid-poll refuses', async () => {
    // 1. Line held while working through the bound in `runSend` -> not delivered, never retyped, message still unread.
    const made = codexWorld();
    const pane = wakeFake((read, enters, typed) => {
      if (read < 2) return IDLE;
      const line = typed[typed.length - 1] ?? '';
      return enters === 0 ? holding(line) : workingHolding(line);
    });
    const host = fake(made, {
      agents: () => [{ name: 'native', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['native', 'check held'], io, host)).toBe(0);
    expect(io.out).toContain('native: queued, not woken (drop, 0 ms); queued; the typed wake failed (the working screen showed with the line still in the box after 1 Enter; the line was not submitted)');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    const drops = join(made.dir, 'send-drops', 'acme', 'native');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    const msgId = records[0]!;
    expect(existsSync(join(drops, `${msgId}.read.json`))).toBe(false);
    expect(listUnread(drops, { to: 'native', root: made.root, session: 'acme' }, host.home).map((m) => m.id)).toEqual([msgId]);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'native', outcome: 'queued, not woken', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        NATIVE_MISSED,
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
    const outCleared = await deliverTypedWake(clearedMidPoll.host, 'pane-1', LINE, 'codex', { ...FAST, verifyMs: 4 });
    expect(outCleared).toEqual({
      delivered: false,
      typed: true,
      tries: 1,
      reason: 'the screen read idle and no working screen showed',
      submittedAt: expect.any(Number),
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
      const outPartial = await deliverTypedWake(partialMidPoll.host, 'pane-1', LINE, 'codex', { ...FAST, verifyMs: 4 });
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
