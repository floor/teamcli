// ADR zeus-message-path D1: a send walks the owner's cascade — the channel-class legs the
// receiving seat's delivery_order names, then the typed leg, then the drop file — and stops at
// the first leg taken. `mcp-inbox` is not a leg in this build: the MCP inbox is the store's
// reader (the same records `team drops --read` reads), and a push from an MCP server is not a
// wake. A delivery_order that still names it keeps the word; the walk reports it skipped with
// `MCP_INBOX_UNAVAILABLE`, and a live `.inbox-listener` beside the seat neither splices a leg
// into the walk nor changes the order. The store the cascade's mailbox leg writes is the record
// the inbox's server reads.
//
// The store-then-trigger walk this file used to pin (`pull-only-trigger.test.ts`) is gone with
// it: a pull-on-turn seat is woken by the typed leg's own trigger, and the drop leg behind it is
// that walk's ending, not a second delivery.
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
import { MCP_INBOX_UNAVAILABLE } from '../src/send/walk-cascade.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
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
 *  the send's own, so the box reads back whatever the wake typed. `wait` costs nothing. */
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
 *  session and root — the record a running inbox server leaves. Under D1 the file is read by
 *  nobody in the walk; the scenes that write it prove it changes nothing. */
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-cascade-legs-')));
  stops.push(() => rmSync(base, { recursive: true, force: true }));
  const urlFile = join(base, 'hook-url');
  const secretFile = join(base, 'hook-secret');
  writeFileSync(urlFile, `${url}\n`);
  writeFileSync(secretFile, 'synthetic-secret-value\n', { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { urlFile, secretFile };
}

describe('the cascade: channel classes, then typed, then the mailbox', () => {
  test('a live inbox listener is no leg: a working seat is reached by the drop, and nothing is typed', async () => {
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
    // The typed leg cannot wake a working pane, and the drop behind it takes the send; the
    // listener beside the seat is not walked, so the old inbox ending is not reachable.
    expect(io.out).toContain('cursor: sent (unconfirmed) (drop, 0 ms)');
    expect(io.out).toContain('the typed wake failed');
    expect(io.out).not.toContain('(mcp-inbox');
    // The splice line the old walk printed when a listener stood beside the seat is gone.
    expect(io.err).not.toContain('inbox server is listening');
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'sent (unconfirmed)', via: 'drop' });
      // The listener is not a leg, so it is not a failed one either.
      expect((history.entries[0]?.failed ?? []).some((line) => line.startsWith('mcp-inbox'))).toBe(false);
      expect(history.entries[0]?.failed?.[0]).toMatch(/^typed: /);
    }
  });

  test('a declared mcp-inbox word is read as unavailable, and the typed leg behind it delivers', async () => {
    const one = world(['mcp-inbox', 'typed', 'drop'], [CURSOR]);
    made.push(one);
    liveInbox(one);
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello', '--json'], io, host)).toBe(0);
    const doc = JSON.parse(io.out) as {
      status: string;
      delivery: { leg: string; state: string; reason?: string }[];
    };
    expect(doc.status).toBe('delivered');
    const legs = new Map(doc.delivery.map((leg) => [leg.leg, leg]));
    expect(legs.get('mcp-inbox')).toEqual({
      leg: 'mcp-inbox',
      state: 'skipped',
      reason: MCP_INBOX_UNAVAILABLE,
    });
    expect(legs.get('typed')).toMatchObject({ state: 'attempted' });
    expect(legs.get('drop')).toMatchObject({ state: 'not-reached' });
    // One line, one Enter, one record: the unavailable word adds no copy and no wake.
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
    expect(recordBody(join(inboxOf(one), recordsIn(inboxOf(one))[0] as string))).toBe(filed('hello'));
  });

  test('a declared order cannot put the drop first: the typed leg is walked before it', async () => {
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
    expect(io.out).toBe('team acme, session "acme"\ncursor: delivered (typed wake)\n');
    expect(pane.typed).toHaveLength(1);
    expect(pane.enters).toBe(1);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'delivered (typed wake)', via: 'typed' });
  });

  test('an order with no typed leg and a stored-only word ends on the drop, with the word reported', async () => {
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
    expect(await runSend(['cursor', 'hello', '--json'], io, host)).toBe(0);
    const doc = JSON.parse(io.out) as {
      status: string;
      delivery: { leg: string; state: string; reason?: string }[];
    };
    expect(doc.status).toBe('sent (unconfirmed)');
    const legs = new Map(doc.delivery.map((leg) => [leg.leg, leg]));
    expect(legs.get('mcp-inbox')).toEqual({ leg: 'mcp-inbox', state: 'skipped', reason: MCP_INBOX_UNAVAILABLE });
    expect(legs.get('drop')).toBeDefined();
    // No typed word, no typed wake: the pane is never typed into.
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'sent (unconfirmed)', via: 'drop' });
  });

  test('the sender-posted webhook fires once and stops the walk, whatever the listener beside the seat says', async () => {
    const hook = receiver();
    const one = world(null, [{ ...CURSOR, webhook: hookFiles(hook.url) }]);
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
    expect(io.out).toContain('cursor: delivered (webhook, ');
    expect(pane.typed).toEqual([]);
    expect(hook.hits).toBe(1);
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
});
