// A seat that reads at its next turn is not woken by a stored copy. When a storing leg — the
// seat's own MCP inbox, or the drop file — puts the message in front of a pull-on-turn seat, the
// walk goes on to the typed leg behind it, which types one fixed trigger line
// (`STORED_WAKE_LINE`) through the same guarded wake as every typed send: no second record, no
// body, no second pending marker. The ending reports both facts — the store, and the wake that
// did or did not give the seat its turn.
//
// The default order needs no word from anyone: `mcp-inbox, typed, drop` is what the build walks
// when nothing declares one, and a pull-on-turn Cursor seat whose profile declares `typed_wake`
// gets the trigger after its inbox stores the record. A seat that declares an order without
// `typed` stays as declared, and a seat a push route can wake keeps the store as its ending.
// Scenes here also prove the walk never types into a working seat or a person's pane.
//
// Fixtures only: the team is a synthetic world under a temp folder, the pane is a script of the
// captured Cursor 2026.10.22 frames, and the one webhook receiver is a loopback listener.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { STORED_WAKE_LINE, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { fake, filed, owner, world, type ExtraSeat, type World } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');
const UNSENT = readFileSync(join(FIXTURES, 'unsent.txt'), 'utf8');

/** The captured draft frame with `text` drawn where its draft was: the composer the wake's own
 *  typed line reads back from, so `boxHoldsText` passes and the Enter is pressed. */
function holding(text: string): string {
  return UNSENT.replace('Fix the failing test', text);
}

/** A Cursor seat on a pane scripted by its reads, Enters and typed lines. The trigger line is
 *  fixed, so the box reads back whatever the wake typed. `wait` costs nothing. */
function wakeFake(
  screen: (read: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number } {
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

/** The idle → holding → working script every delivered trigger follows. */
function wakeScript(): (read: number, enters: number, typed: readonly string[]) => string {
  return (read, enters, typed) => (enters > 0 ? WORKING : read < 2 ? IDLE : holding(typed[typed.length - 1] ?? ''));
}

const CURSOR: ExtraSeat = { name: 'cursor', role: 'implementer', cli: 'cursor', launch: 'cursor' };

const made: World[] = [];
const stops: (() => unknown)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const one of made.splice(0)) one.cleanup();
});

/** The seat's own inbox folder: where every storing leg writes the record. */
function inboxOf(one: World, seat = 'cursor'): string {
  return join(one.dir, 'send-drops', 'acme', seat);
}

/** A live listener beside the seat's inbox: this process's pid and the fixture's own seat,
 *  session and root — the record a running inbox server leaves. */
function liveInbox(one: World, seat = 'cursor'): string {
  const dir = inboxOf(one, seat);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat,
    session: 'acme',
    root: one.root,
    cli: 'cursor',
    pid: process.pid,
    ts: '2026-11-02T00:00:00.000Z',
  })}\n`);
  return dir;
}

/** Every message record in the seat's inbox: one send writes one, however many legs walked. */
function recordsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
}

/** A loopback receiver for the push scene's webhook adapter; it records what it accepted. */
function receiver(): { url: string; hits: number } {
  const seen = { hits: 0, url: '' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      seen.hits += 1;
      return new Response('', { status: 200 });
    },
  });
  stops.push(() => server.stop(true));
  seen.url = `http://127.0.0.1:${server.port}/routine`;
  return seen;
}

/** The two files a seat's webhook row names: the receiver's URL, and a 0600 secret. */
function hookFiles(url: string): { urlFile: string; secretFile: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pull-trigger-')));
  stops.push(() => rmSync(base, { recursive: true, force: true }));
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, 'synthetic-secret-value\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

describe('the pull-only walk types one trigger after the store', () => {
  test('the default order catches a pull-on-turn seat: the inbox stores it, then one trigger line', async () => {
    const one = world(null, [CURSOR]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'cursor: sent (unconfirmed) (mcp-inbox, 0 ms); queued; the typed wake woke it (the working screen showed after 1 Enter); cursor reads it at its next turn\n',
    );
    // One line, one Enter: the trigger only, never the body and never a second copy.
    expect(pane.typed).toEqual([STORED_WAKE_LINE]);
    expect(pane.enters).toBe(1);
    expect(io.err).toBe('');
    const dir = inboxOf(one);
    const records = recordsIn(dir);
    expect(records).toHaveLength(1);
    expect(recordBody(join(dir, records[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'sent (unconfirmed)', via: 'mcp-inbox' });
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('an order that declares no typed leg stays as declared: the store ends the send', async () => {
    const one = world(['mcp-inbox', 'drop'], [CURSOR]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'cursor: sent (unconfirmed) (mcp-inbox, 0 ms); queued; cursor reads it at its next turn, and nothing here gives it one (pull-only)\n',
    );
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
  });

  test('a push seat keeps the store as its ending: no trigger is typed after it', async () => {
    const hook = receiver();
    const one = world(null, [{ ...CURSOR, webhook: hookFiles(hook.url) }]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.out).toContain('cursor: sent (unconfirmed) (mcp-inbox, 0 ms)');
    expect(io.out).toContain('webhook delivered (');
    expect(io.out).not.toContain('queued;');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(hook.hits).toBe(1);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
  });

  test('a working seat gets no typing: the record is stored and the wake says why it did not run', async () => {
    const one = world(null, [CURSOR]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(() => WORKING);
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'cursor: sent (unconfirmed) (mcp-inbox, 0 ms); queued; the typed wake did not run (the first read showed working, not an empty idle prompt; nothing was typed); cursor reads it at its next turn, and nothing here gives it one (pull-only)\n',
    );
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
  });

  test('a person’s pane is never typed: the human walk is the drop file alone', async () => {
    const one = world(null, [{ ...CURSOR, name: 'person', human: true }]);
    made.push(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'person', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['person', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'person: sent (unconfirmed) (drop, 0 ms); queued; person has no way to be woken while idle\n',
    );
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(io.err).toBe('');
    const dir = inboxOf(one, 'person');
    const records = recordsIn(dir);
    expect(records).toHaveLength(1);
    expect(recordBody(join(dir, records[0] as string))).toBe(filed('hello'));
  });

  test('a drop written before the typed leg is stored once, then the trigger wakes the seat', async () => {
    const one = world(['drop', 'typed'], [CURSOR]);
    made.push(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'cursor: sent (unconfirmed) (drop, 0 ms); queued; the typed wake woke it (the working screen showed after 1 Enter); cursor reads it at its next turn\n',
    );
    expect(pane.typed).toEqual([STORED_WAKE_LINE]);
    expect(pane.enters).toBe(1);
    const dir = inboxOf(one);
    expect(recordsIn(dir)).toHaveLength(1);
    expect(recordBody(join(dir, recordsIn(dir)[0] as string))).toBe(filed('hello'));
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'sent (unconfirmed)', via: 'drop' });
      expect(history.entries[0]?.failed).toBeUndefined();
    }
  });

  test('a live listener spliced ahead of a declared drop stores once; the later drop leg adds no copy', async () => {
    const one = world(['drop', 'typed'], [CURSOR]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    expect(io.err).toBe('team send: cursor: the delivery order names the drop before its inbox, but its inbox server is listening; the inbox is walked before the drop\n');
    expect(io.out).toBe(
      'team acme, session "acme"\n'
      + 'cursor: sent (unconfirmed) (mcp-inbox, 0 ms); queued; the typed wake woke it (the working screen showed after 1 Enter); cursor reads it at its next turn\n',
    );
    expect(pane.typed).toEqual([STORED_WAKE_LINE]);
    expect(pane.enters).toBe(1);
    // The inbox stored the record once and the declared drop leg behind it wrote nothing.
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
  });
});
