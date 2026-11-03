// The cursor typed wake, read on the captured 2026.10.22 frames in
// test/fixtures/cursor/2026.10.22/: the empty idle box, a draft in the box, and the `Working`
// frame. No CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readHistory } from '../src/send/history.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';
import { fake, filed, owner, world } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

const LINE = 'Read /t/mail/abc and do that.';

/** The captured unsent frame with `text` drawn in its input row: `Fix the failing test` is the
 *  capture's own draft, and the row's prompt and trailing cells are left as captured. */
function holding(text: string): string {
  return UNSENT.replace('Fix the failing test', () => text);
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

  test('an unsent box refuses before any key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed' });
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
});
