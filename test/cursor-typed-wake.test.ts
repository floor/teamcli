// The cursor typed wake, read on the captured 2026.10.22 frames in
// test/fixtures/cursor/2026.10.22/: the empty idle box, a draft in the box, and the `Working`
// frame. No CLI runs and no key leaves the process.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend, sendDirect } from '../src/commands/send.ts';
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

/** A finished turn's idle tail, transcribed from vlist's builder-cursor and tester-cursor panes
 *  (2026-11-20, cursor-agent on Grok 4.7): the box's `▄`/`▀` frame, `→ Add a follow-up`, then
 *  the background-task count between the frame and the status row, then the workspace line. */
const IDLE_TASK = readFileSync(join(import.meta.dir, 'fixtures', 'cursor', '2026.11.20', 'idle-task-edited.txt'), 'utf8');
const holdingTask = (text: string): string => IDLE_TASK.replace('  → Add a follow-up', () => `  → ${text}`);

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

  test('a finished turn with a task row under the framed box is idle, and the wake types into it', async () => {
    // vlist 2026-11-20: this tail read `done (screen not recognised)` and every send ended
    // "not delivered: no live route" until a restart.
    expect(readScreen('cursor', IDLE_TASK).kind).toBe('idle');
    expect(readScreen('cursor', holdingTask(LINE)).kind).toBe('unsent');
    expect(boxHoldsText('cursor', LINE, holdingTask(LINE))).toBe(true);
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE_TASK : holdingTask(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toMatchObject({ delivered: true, typed: true, tries: 1 });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
    // Anything else between the frame and the status row is still not the frame: unknown.
    expect(readScreen('cursor', IDLE_TASK.replace('  1 task', '  some printed text')).kind).toBe('unknown');
  });

  test('a retry that finds its line held, then an unrecognised frame, presses nothing and flags the screen', async () => {
    const strange = '  a layout no rule knows';
    expect(readScreen('cursor', strange).kind).toBe('unknown');
    const pane = wakeFake((read) => (read === 0 ? holding(LINE) : strange));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toMatchObject({ delivered: false, typed: false, tries: 0, unrecognised: true });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('two idle reads, one line, one Enter: the Working row is the delivery', async () => {
    const pane = wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? '')));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
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
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
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
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(1);
  });

  test('an unsent box refuses before any key', async () => {
    const pane = wakeFake(() => UNSENT);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, 'cursor', FAST);
    // 1345 never-drop: the held draft is kept in a file, and the refusal reason says so.
    expect(out).toEqual({ delivered: false, typed: false, tries: 0, reason: 'the box held a draft; it was kept in a file and no Enter was pressed' });
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
    expect(out).toEqual({ delivered: true, typed: true, tries: 1, reason: 'the working screen showed after 1 Enter', submittedAt: expect.any(Number), workingAt: expect.any(Number) });
    expect(pane.typed).toEqual([LINE]);
    expect(pane.enters).toBe(1);
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

  /** The record `team up` leaves for the cursor seat on its pane: the shell and the CLI it
   *  launched, at their births; and the live readings a direct wake proves them by before each
   *  key. `live` is read at every key: a scene changes it to move or replace the seat. */
  type Live = { pane: string; foreground: number[] };
  function launched(made: ReturnType<typeof cursorWorld>, live: Live) {
    writeFileSync(join(made.dir, 'team.state.json'), JSON.stringify({ format: 1, sessions: { acme: { seats: {
      cursor: { stage: 'ready', pane: 'pane-cursor', launched: { shell: 111, cli: [222] }, pane_shell: 111, pane_shell_start: 5 },
    }, worktrees: {} } } }));
    const agents = () => [{ name: 'cursor', pane: live.pane, cli: 'cursor-agent' }];
    return {
      agents,
      keyOwner: {
        agents: () => agents(),
        processes: () => ({ shell: 111, foreground: live.foreground }),
        processStart: (pid: number) => (pid === 111 ? 5 : null),
      },
    };
  }
  const drawn = (text: string): string => IDLE_TASK.replace('  → Add a follow-up', () => text.split('\n').map((row, at) => (at === 0 ? `  → ${row}` : `    ${row}`)).join('\n'));
  const drawingWake = () => wakeFake((read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE_TASK : drawn(typed[typed.length - 1] ?? '')));
  /** The wake's host, with `after` run once the line is typed and before its Enter. */
  function typedThen(pane: ReturnType<typeof wakeFake>, after: () => void): void {
    const type = pane.host.type;
    pane.host.type = (at, text) => {
      after();
      return type(at, text);
    };
  }

  test('the idle dispatch\'s direct-only send wakes an idle cursor seat with its typed wake', async () => {
    const made = cursorWorld();
    const pane = drawingWake();
    const host = fake(made, { ...launched(made, { pane: 'pane-cursor', foreground: [222] }), typedWake: () => pane.host, wakeVerifyMs: 1, wakePollMs: 1 });
    const run = await sendDirect(owner(made.root), host, { seat: 'cursor', pane: 'pane-cursor', cli: 'cursor', body: 'take the next task' });
    expect(run.result).toMatchObject({ route: 'typed', outcome: 'delivered' });
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
  });

  test('a direct-only send types no further key once the seat has moved off the pane the pass bound', async () => {
    const made = cursorWorld();
    const live = { pane: 'pane-cursor', foreground: [222] };
    const pane = drawingWake();
    typedThen(pane, () => { live.pane = 'pane-other'; });
    const host = fake(made, { ...launched(made, live), typedWake: () => pane.host, wakeVerifyMs: 1, wakePollMs: 1 });
    const run = await sendDirect(owner(made.root), host, { seat: 'cursor', pane: 'pane-cursor', cli: 'cursor', body: 'take the next task' });
    expect(run.result?.outcome).not.toBe('delivered');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(0);
  });

  test('a direct-only send types no further key into a replacement that kept the seat name and pane', async () => {
    const made = cursorWorld();
    const live = { pane: 'pane-cursor', foreground: [222] };
    const pane = drawingWake();
    // Another process now runs in front of the recorded shell, on the same pane id and name.
    typedThen(pane, () => { live.foreground = [333]; });
    const host = fake(made, { ...launched(made, live), typedWake: () => pane.host, wakeVerifyMs: 1, wakePollMs: 1 });
    const run = await sendDirect(owner(made.root), host, { seat: 'cursor', pane: 'pane-cursor', cli: 'cursor', body: 'take the next task' });
    expect(run.result?.outcome).not.toBe('delivered');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(0);
  });

  test('a direct-only send types no further key once the declaration stops the seat', async () => {
    const made = cursorWorld();
    const pane = drawingWake();
    const file = join(made.dir, 'team.yaml');
    typedThen(pane, () => { writeFileSync(file, readFileSync(file, 'utf8').replace('    name: cursor\n', '    name: cursor\n    stopped: true\n')); });
    const host = fake(made, { ...launched(made, { pane: 'pane-cursor', foreground: [222] }), typedWake: () => pane.host, wakeVerifyMs: 1, wakePollMs: 1 });
    const run = await sendDirect(owner(made.root), host, { seat: 'cursor', pane: 'pane-cursor', cli: 'cursor', body: 'take the next task' });
    expect(readFileSync(file, 'utf8')).toContain('stopped: true');
    expect(run.result?.outcome).not.toBe('delivered');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(0);
  });

  test('a direct-only send whose recheck refuses types nothing into a cursor seat', async () => {
    const made = cursorWorld();
    const pane = wakeFake(() => IDLE_TASK);
    const host = fake(made, { ...launched(made, { pane: 'pane-cursor', foreground: [222] }), typedWake: () => pane.host, wakeVerifyMs: 1, wakePollMs: 1 });
    const run = await sendDirect(owner(made.root), host, {
      seat: 'cursor', pane: 'pane-cursor', cli: 'cursor', body: 'take the next task',
      guard: () => ({ ok: false, why: 'the watch was replaced' }),
    });
    expect(run.result).toMatchObject({ route: 'typed', outcome: 'refused' });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('an unrecognised screen is never typed into, and the lead hears it once per episode with no screen content', async () => {
    const made = cursorWorld();
    const strange = IDLE_TASK.replace('  1 task', `  my draft about the merger, call Sam at 555-0100 ${made.home}/Code/private-thing`);
    expect(readScreen('cursor', strange).kind).toBe('unknown');
    const keys: string[] = [];
    const wakeHost: TypedWakeHost = { read: () => strange, type: (_p, text) => { keys.push(text); return true; }, enter: () => { keys.push('<enter>'); return true; }, wait: async () => {} };
    const host = fake(made, { agents: () => [{ name: 'cursor', pane: 'pane-cursor', cli: 'cursor-agent' }], typedWake: () => wakeHost, wakeVerifyMs: 1, wakePollMs: 1 });
    await runSend(['cursor', 'first message'], owner(made.root), host);
    await runSend(['cursor', 'second message'], owner(made.root), host);
    expect(keys).toEqual([]);
    const lead = join(made.root, '.agents', 'messages', 'lead');
    const notices = (): string[] => (existsSync(lead) ? readdirSync(lead).filter((name) => name.startsWith('unrecognised-screen-cursor-')) : []);
    expect(notices()).toHaveLength(1);
    const body = readFileSync(join(lead, notices()[0]!), 'utf8');
    expect(body).toContain('cursor (pane pane-cursor): screen not recognised, capture needed');
    for (const leak of ['merger', 'Sam', '555-0100', 'private-thing', 'Grok', 'Add a follow-up']) expect(body).not.toContain(leak);
  });
});
