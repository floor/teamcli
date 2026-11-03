// The one typed wake this build allows. A profile that declares `typed_wake: screen`
// lets a send type one trigger line into a composer two reads showed as the empty idle prompt;
// Enter goes only into a box that reads back as exactly that line, and the send is delivered
// only when the profile's working screen shows. The screens below are the captured Muse 1.4.11
// frames in test/fixtures/muse/, with the trigger line drawn in the captured composer.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import {
  DEFAULT_WATCH_WAKE_TRIES,
  profileFor,
  readHintKey,
  typedWakeKey,
  watchWakeKey,
  watchWakeTriesKey,
} from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readBox, readScreen, type Screen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const FIXTURES_149 = join(import.meta.dir, 'fixtures', 'muse', '1.4.9');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const GOAL = readFileSync(join(FIXTURES, 'goal-hint-synthetic.txt'), 'utf8');
const LOOP = readFileSync(join(FIXTURES, 'loop-hint-dim.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const WORKING_149 = readFileSync(join(FIXTURES_149, 'working.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent-synthetic.txt'), 'utf8');
const PERMISSION_149 = readFileSync(join(FIXTURES_149, 'permission.txt'), 'utf8');
const TRUST_149 = readFileSync(join(FIXTURES_149, 'trust.txt'), 'utf8');
const QUESTION_149 = readFileSync(join(FIXTURES_149, 'model-picker.txt'), 'utf8');

/** The captured idle frame with `text` drawn in its composer: the same rules and footer, one
 *  input row. Muse wraps a long row, so the scenes keep the line short enough to read back. */
function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

const LINE = 'Read /t/mail/abc and do that.';

/** A pane scripted by how many reads and Enters it has seen, and by the lines typed into it. The
 *  trigger a send composes is not known until the send runs, so a scene that wants the box to
 *  read back the line draws the text the wake itself typed. `wait` costs nothing. */
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

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

describe('the typed wake: one line into an empty idle box', () => {
  test('two idle reads, one line, one Enter: the working screen is the delivery', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the /goal hint is an empty box: two reads of it, one line, one Enter', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? GOAL : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('the dim /loop hint is an empty box: two reads of it, one line, one Enter', async () => {
    const pane = wakeFake((read, enters) => (enters > 0 ? WORKING : read < 2 ? LOOP : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
  });

  test('a box that holds unsent text on the first read is never typed over', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out.delivered).toBe(false);
    expect(out.reason).toBe('the first read showed unsent, not an empty idle prompt; nothing was typed');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('a working screen on the second read stops the wake before any key', async () => {
    const pane = wakeFake((read) => (read === 0 ? IDLE : WORKING));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
  });

  test('a pane that cannot be read is refused with nothing typed', async () => {
    const pane = wakeFake(() => null);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unreadable, not an empty idle prompt; nothing was typed' });
    expect(pane.typed).toEqual([]);
  });

  test('a box that reads back other text gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding('the owner was typing')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(0);
  });

  test('a box that reads empty after the line was typed gets no Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : IDLE));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(pane.enters).toBe(0);
  });

  test('a line that stays in the box gets at most three guarded Enters and is not delivered', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 3, reason: 'the line stayed in the box through 3 Enters and no working screen showed' });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(3);
  });

  test('a box that clears without a working screen is not a delivery', async () => {
    const pane = wakeFake((_read, enters) => (enters > 0 ? IDLE : _read < 2 ? IDLE : holding(LINE)));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 1, reason: 'the screen read idle and no working screen showed' });
    expect(pane.enters).toBe(1);
  });

  test('a working screen before any of the wake’s Enters is not its delivery', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : WORKING));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: true,
      tries: 0,
      reason: 'a working screen showed before any Enter, so the line was not submitted by this wake; no Enter was pressed',
    });
    expect(pane.enters).toBe(0);
  });

  test('a pane that does not take the line stops the wake with nothing pressed', async () => {
    const pane = wakeFake(() => IDLE, { typeOk: false });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the pane did not take the line; nothing was typed' });
    expect(pane.enters).toBe(0);
  });

  test('a pane that does not take the Enter gets no further Enter', async () => {
    const pane = wakeFake((read) => (read < 2 ? IDLE : holding(LINE)), { enterOk: false });
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'muse', FAST);
    expect(out).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the pane did not take the Enter; no further Enter was pressed' });
    expect(pane.enters).toBe(1);
  });

  test('the exact /goal placeholder reads idle, while real /goal drafts or altered hint text refuse', async () => {
    expect(readScreen('muse', GOAL).kind).toBe('idle');
    expect(readBox('muse', GOAL)).toBeNull();
    expect(boxHoldsText('muse', '/goal pins a session objective with a progress bar', GOAL)).toBe(false);

    const revertedToGoal = wakeFake((read) => (read < 2 ? GOAL : GOAL));
    const outReverted = await deliverTypedWake(revertedToGoal.host, 'pane-1', LINE, 'muse', FAST);
    expect(outReverted).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(revertedToGoal.typed).toEqual([LINE]);
    expect(revertedToGoal.enters).toBe(0);

    const goalDrafts = [
      '/goal',
      '/goal ship 0.5.12',
      '/goal pins a session objective',
      'pins a session objective with a progress bar',
      '/goal pins a session objective with a progress bar now',
      '/goal  pins a session objective with a progress bar',
    ];
    for (const draftText of goalDrafts) {
      const frame = holding(draftText);
      expect(readScreen('muse', frame).kind).toBe('unsent');
      expect(readBox('muse', frame)?.first).toBe(draftText);
      expect(boxHoldsText('muse', draftText, frame)).toBe(true);
      expect(boxHoldsText('muse', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? GOAL : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? GOAL : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('a box with only spaces or altered internal spacing after typing gets no Enter', async () => {
    const spacesOnly = wakeFake((read) => (read < 2 ? IDLE : holding('    ')));
    const outSpaces = await deliverTypedWake(spacesOnly.host, 'pane-1', LINE, 'muse', FAST);
    expect(readScreen('muse', holding('    ')).kind).toBe('idle');
    expect(boxHoldsText('muse', LINE, holding('    '))).toBe(false);
    expect(outSpaces).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the screen read idle after the line was typed; no Enter was pressed' });
    expect(spacesOnly.typed).toEqual([LINE]);
    expect(spacesOnly.enters).toBe(0);

    const doubledSpace = LINE.replace(' ', '  ');
    const internalSpaces = wakeFake((read) => (read < 2 ? IDLE : holding(doubledSpace)));
    const outInternal = await deliverTypedWake(internalSpaces.host, 'pane-1', LINE, 'muse', FAST);
    expect(readScreen('muse', holding(doubledSpace)).kind).toBe('unsent');
    expect(boxHoldsText('muse', LINE, holding(doubledSpace))).toBe(false);
    expect(outInternal).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
    expect(internalSpaces.typed).toEqual([LINE]);
    expect(internalSpaces.enters).toBe(0);
  });

  test('partial text in the box refuses before any key and gets no Enter if drawn after typing', async () => {
    const prefix = LINE.slice(0, 12);
    const suffix = LINE.slice(5);
    for (const draft of [holding(prefix), holding(suffix)]) {
      expect(readScreen('muse', draft).kind).toBe('unsent');
      expect(boxHoldsText('muse', LINE, draft)).toBe(false);

      const firstRead = wakeFake(() => draft);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : draft));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed unsent, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : draft));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: 'the box held text other than the line after the line was typed; no Enter was pressed' });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }
  });

  test('captured dialog and working frames refuse before any key and before Enter', async () => {
    const dialogs: ReadonlyArray<readonly [kind: Screen['kind'], frame: string]> = [
      ['permission', PERMISSION_149],
      ['trust', TRUST_149],
      ['question', QUESTION_149],
    ];
    for (const [kind, frame] of dialogs) {
      expect(readScreen('muse', frame).kind).toBe(kind);
      expect(boxHoldsText('muse', LINE, frame)).toBe(false);

      const firstRead = wakeFake(() => frame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: `the first read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : frame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: `the second read showed ${kind}, not an empty idle prompt; nothing was typed` });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : frame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
      expect(outAfter).toEqual({ delivered: false, typed: true, tries: 0, reason: `the screen read ${kind} after the line was typed; no Enter was pressed` });
      expect(afterType.typed).toEqual([LINE]);
      expect(afterType.enters).toBe(0);
    }

    for (const workingFrame of [WORKING, WORKING_149]) {
      expect(readScreen('muse', workingFrame).kind).toBe('working');
      expect(boxHoldsText('muse', LINE, workingFrame)).toBe(false);

      const firstRead = wakeFake(() => workingFrame);
      const outFirst = await deliverTypedWake(firstRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outFirst).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed working, not an empty idle prompt; nothing was typed' });
      expect(firstRead.typed).toEqual([]);
      expect(firstRead.enters).toBe(0);

      const secondRead = wakeFake((read) => (read === 0 ? IDLE : workingFrame));
      const outSecond = await deliverTypedWake(secondRead.host, 'pane-1', LINE, 'muse', FAST);
      expect(outSecond).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' });
      expect(secondRead.typed).toEqual([]);
      expect(secondRead.enters).toBe(0);

      const afterType = wakeFake((read) => (read < 2 ? IDLE : workingFrame));
      const outAfter = await deliverTypedWake(afterType.host, 'pane-1', LINE, 'muse', FAST);
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

describe('the typed wake is a profile word', () => {
  test('the word is closed, and only Muse, Cursor, Antigravity, Grok and Codex declare it', () => {
    expect(typedWakeKey('typed_wake: screen')).toBe('screen');
    expect(typedWakeKey('cli: muse')).toBeNull();
    expect(() => typedWakeKey('typed_wake: typing')).toThrow(/typed_wake/);
    expect(profileFor('muse')?.typedWake).toBe('screen');
    expect(profileFor('cursor')?.typedWake).toBe('screen');
    expect(profileFor('antigravity')?.typedWake).toBe('screen');
    expect(profileFor('grok')?.typedWake).toBe('screen');
    expect(profileFor('codex')?.typedWake).toBe('screen');
    for (const cli of ['claude-code', 'gemini', 'jules']) {
      expect(profileFor(cli)?.typedWake, cli).toBeNull();
    }
  });

  test('the watch retry is on exactly where the typed wake is declared, with the default bound', () => {
    // On with the typed wake, off without one: the retry is the same wake, so a profile with no
    // wake to retry never claims one.
    expect(profileFor('muse')?.watchWake).toBe(true);
    expect(profileFor('cursor')?.watchWake).toBe(true);
    expect(profileFor('antigravity')?.watchWake).toBe(true);
    expect(profileFor('grok')?.watchWake).toBe(true);
    expect(profileFor('codex')?.watchWake).toBe(true);
    for (const cli of ['claude-code', 'gemini', 'jules']) {
      expect(profileFor(cli)?.watchWake, cli).toBe(false);
    }
    // The bound is the loader's default unless a profile names one, and the shipped ones name none.
    expect(DEFAULT_WATCH_WAKE_TRIES).toBe(3);
    expect(profileFor('muse')?.watchWakeTries).toBe(3);
    expect(profileFor('cursor')?.watchWakeTries).toBe(3);
    expect(profileFor('antigravity')?.watchWakeTries).toBe(3);
    expect(profileFor('grok')?.watchWakeTries).toBe(3);
    expect(profileFor('codex')?.watchWakeTries).toBe(3);
  });

  test('the read hint is declared where a seat has an inbox tool to name', () => {
    // The two profiles whose seats carry an MCP inbox send their woken turn to the one direct
    // call that lists the waiting messages: the typed line never carries the id `inbox_read`
    // takes, so the read is always reached through `inbox_check`.
    for (const cli of ['antigravity', 'cursor']) {
      expect(profileFor(cli)?.readHint, cli).toBe('Read it with: call inbox_check now.');
    }
    // Muse types too, but reads with the drops command: the shipped sentence stands, as it does
    // for a profile that declares no hint at all.
    for (const cli of ['muse', 'claude-code', 'codex', 'grok', 'gemini', 'jules']) {
      expect(profileFor(cli)?.readHint, cli).toBeNull();
    }
  });

  test('the read hint is read and checked by the loader’s own rules', () => {
    // The sentence holds `: `, so the file's own YAML rule makes it a quoted scalar.
    expect(readHintKey("read_hint: 'Read it with: call inbox_check now.'")).toBe('Read it with: call inbox_check now.');
    // The longest accepted sentence is the shipped ceiling: the header has to keep room to name
    // its sender inside the 80-column line.
    expect(readHintKey(`read_hint: ${'x'.repeat(60)}`)).toBe('x'.repeat(60));
    expect(readHintKey('cli: muse')).toBeNull();
    // The last two carry a real newline inside a quoted scalar; a block scalar never reaches the
    // check, because the file's own YAML reader refuses block scalars outright.
    for (const bad of ['""', '5', `"${'x'.repeat(61)}"`, '" leading"', '"trailing "', '"two\\nlines"', '"trailing\\n"']) {
      expect(() => readHintKey(`read_hint: ${bad}`), bad).toThrow(/read_hint/);
    }
  });

  test('the watch keys are read by the loader’s own rules', () => {
    expect(watchWakeKey('watch_wake: on')).toBe(true);
    expect(watchWakeKey('watch_wake: off')).toBe(false);
    expect(watchWakeKey('cli: muse')).toBeNull();
    expect(() => watchWakeKey('watch_wake: maybe')).toThrow(/watch_wake/);
    expect(watchWakeTriesKey('watch_wake_tries: 4')).toBe(4);
    expect(watchWakeTriesKey('watch_wake_tries: 10')).toBe(10);
    expect(watchWakeTriesKey('cli: muse')).toBeNull();
    for (const bad of ['0', '11', '1.5', '"3"', 'three']) {
      expect(() => watchWakeTriesKey(`watch_wake_tries: ${bad}`)).toThrow(/watch_wake_tries/);
    }
  });
});

describe('team send: the typed wake', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  function museWorld() {
    const made = world(['mcp-inbox', 'typed'], [{ name: 'muse', role: 'implementer', cli: 'muse', launch: 'muse' }]);
    cleanups.push(made.cleanup);
    return made;
  }

  test('a Muse seat is woken by one typed trigger, and the send is delivered', async () => {
    const made = museWorld();
    // The send composes the trigger itself, so the box reads back whatever the wake typed.
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['muse', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nmuse: delivered (typed wake)\n');
    // One line, one Enter, and the line is the trigger that reads the drop, never the body.
    // Muse has no MCP inbox, so its profile declares no `read_hint` and the shipped sentence
    // stands: the drop read is this seat's fastest path.
    expect(pane.typed).toEqual(['Message from owner (owner@acme): hello Read it with: team drops --read.']);
    expect(pane.enters).toBe(1);
    // The record was written under the seat lock before the line was typed.
    const drops = join(made.dir, 'send-drops', 'acme', 'muse');
    const records = readdirSync(drops).filter((name) => !name.includes('.'));
    expect(records).toHaveLength(1);
    expect(recordBody(join(drops, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'delivered (typed wake)', via: 'typed' });
      // The typed leg took the send, so no leg behind it failed: the inbox is no leg to skip.
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('a wake that cannot deliver leaves the message in the bus inbox, and the sender is told so', async () => {
    const made = museWorld();
    const pane = wakeFake(() => UNSENT);
    const host = fake(made, {
      agents: () => [{ name: 'muse', pane: 'pane-1' }],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['muse', 'hello'], io, host)).toBe(0);
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nmuse: sent (unconfirmed) (drop, 0 ms); queued; the typed wake failed (the first read showed unsent, not an empty idle prompt; nothing was typed); nothing wakes muse while it is idle except a send-time typed wake and the watch\'s typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn\n');
    expect(io.err).toBe(queuedLine('muse', NO_EVENT_ADAPTER_TOOK_IT));
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'muse', outcome: 'sent (unconfirmed)', via: 'drop' });
      expect(history.entries[0]?.failed).toEqual([
        'typed: the first read showed unsent, not an empty idle prompt; nothing was typed',
      ]);
    }
  });

  test('no other seat in the team gains typing: a Claude Code seat still refuses the typed leg', async () => {
    const made = museWorld();
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const host = fake(made, {
      agents: () => [
        { name: 'lead', pane: 'pane-2' },
        { name: 'muse', pane: 'pane-1' },
      ],
      typedWake: () => pane.host,
    });
    const io = owner(made.root);
    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const history = readHistory('acme', made.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries[0]?.failed).toEqual([
        "typed: typing into a seat's pane is never a delivery: messages go through the bus and an event adapter",
      ]);
    }
  });
});
