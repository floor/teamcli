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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverWebhook } from '../src/bus/webhook.ts';
import { runSend } from '../src/commands/send.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { cascadeOrder, cascadeWalk, legClassOf, MCP_INBOX_UNAVAILABLE, unavailableLegsOf } from '../src/send/walk-cascade.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { fake, filed, owner, world, type ExtraSeat, type World } from './send-native-fixtures.ts';
import { recordBody } from './helpers.ts';
import { withoutSendId } from './helpers/output.ts';

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
    expect(io.out).toContain('cursor: queued, not woken (drop, 0 ms)');
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
      expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'queued, not woken', via: 'drop' });
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
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\ncursor: delivered (typed wake)\n');
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
    expect(doc.status).toBe('queued, not woken');
    const legs = new Map(doc.delivery.map((leg) => [leg.leg, leg]));
    expect(legs.get('mcp-inbox')).toEqual({ leg: 'mcp-inbox', state: 'skipped', reason: MCP_INBOX_UNAVAILABLE });
    expect(legs.get('drop')).toBeDefined();
    // No typed word, no typed wake: the pane is never typed into.
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(recordsIn(inboxOf(one))).toHaveLength(1);
    const history = readHistory('acme', one.root, host.home);
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.entries[0]).toMatchObject({ to: 'cursor', outcome: 'queued, not woken', via: 'drop' });
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
    expect(withoutSendId(io.out)).toBe(
      'team acme, session "acme"\n'
      + 'person: queued, not woken (drop, 0 ms); queued; person has no way to be woken while idle\n',
    );
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(io.err).toBe('');
    const dir = inboxOf(one, 'person');
    const records = recordsIn(dir);
    expect(records).toHaveLength(1);
    expect(recordBody(join(dir, records[0] as string))).toBe(filed('hello'));
  });

  test('cascadeWalk orders channel classes, then webhook, then typed, then drop, and omits mcp-inbox', () => {
    expect(legClassOf('socket')).toBe('channel');
    expect(legClassOf('native')).toBe('channel');
    expect(legClassOf('headless-resume')).toBe('channel');
    expect(legClassOf('channel')).toBe('channel');
    expect(legClassOf('session')).toBe('channel');
    expect(legClassOf('webhook')).toBe('webhook');
    expect(legClassOf('typed')).toBe('typed');
    expect(legClassOf('drop')).toBe('mailbox');
    expect(legClassOf('mcp-inbox')).toBe('unavailable');

    const scrambled = ['drop', 'mcp-inbox', 'typed', 'native', 'socket', 'channel', 'headless-resume', 'session'] as const;
    expect(unavailableLegsOf(scrambled)).toEqual(['mcp-inbox']);
    expect(cascadeOrder(scrambled)).toEqual(['native', 'socket', 'channel', 'headless-resume', 'session', 'typed', 'drop']);
    expect(cascadeWalk(scrambled, true)).toEqual([
      'native',
      'socket',
      'channel',
      'headless-resume',
      'session',
      'webhook',
      'typed',
      'drop',
    ]);
    expect(cascadeWalk(['drop', 'typed'], true)).toEqual(['webhook', 'typed', 'drop']);
    expect(cascadeWalk(['socket', 'native'], true)).toEqual(['socket', 'native', 'webhook']);
  });

  test('a definite webhook failure after a channel leg releases the claim and walks typed then drop', async () => {
    let status = 503;
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        hits += 1;
        return new Response('unavailable', { status });
      },
    });
    stops.push(() => server.stop(true));
    const url = `http://127.0.0.1:${String(server.port)}/routine`;

    // Declared order scrambles drop, mcp-inbox, typed, socket; cascade walks socket -> webhook -> typed -> drop.
    const one = world(['drop', 'mcp-inbox', 'typed', 'socket'], [{ ...CURSOR, webhook: hookFiles(url) }]);
    made.push(one);
    liveInbox(one);

    // 1. Idle pane: socket skipped -> webhook HTTP 503 (claim released) -> typed delivers.
    const idlePane = wakeFake(wakeScript());
    const io1 = owner(one.root);
    const host1 = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => idlePane.host,
      inboxGraceMs: 0,
    });
    expect(await runSend(['cursor', 'first', '--json'], io1, host1)).toBe(0);
    const doc1 = JSON.parse(io1.out) as {
      status: string;
      channel: string;
      delivery: { leg: string; state: string; reason?: string }[];
    };
    expect(doc1.status).toBe('delivered');
    expect(doc1.channel).toBe('typed');
    expect(hits).toBe(1);
    expect(idlePane.typed).toHaveLength(1);
    expect(idlePane.enters).toBe(1);
    expect(doc1.delivery.map((entry) => [entry.leg, entry.state])).toEqual([
      ['mcp-inbox', 'skipped'],
      ['socket', 'skipped'],
      ['webhook', 'attempted'],
      ['typed', 'attempted'],
      ['drop', 'not-reached'],
    ]);
    const dir = inboxOf(one);
    const firstId = recordsIn(dir)[0]!;
    expect(existsSync(join(dir, `${firstId}.posting`))).toBe(false);
    expect(existsSync(join(dir, `${firstId}.posted`))).toBe(false);

    // 2. Working pane: socket skipped -> webhook HTTP 503 -> typed fails -> mailbox (drop) under all.
    status = 502;
    const workingPane = wakeFake(() => WORKING);
    const io2 = owner(one.root);
    const host2 = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => workingPane.host,
      inboxGraceMs: 0,
    });
    expect(await runSend(['cursor', 'second'], io2, host2)).toBe(0);
    expect(hits).toBe(2);
    expect(workingPane.typed).toEqual([]);
    expect(io2.out).toContain('cursor: queued, not woken (drop, ');
    expect(io2.out).toContain('webhook not delivered: HTTP 502');
    const history = readHistory('acme', one.root, host2.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(2);
      expect(history.entries[0]).toMatchObject({
        to: 'cursor',
        via: 'typed',
        outcome: 'delivered (typed wake)',
        failed: ['socket: cursor sessions have no cross-session socket', 'webhook: HTTP 503'],
      });
      expect(history.entries[1]?.via).toBe('drop');
      expect(history.entries[1]?.outcome).toBe('queued, not woken');
      expect(history.entries[1]?.failed?.[0]).toBe('socket: cursor sessions have no cross-session socket');
      expect(history.entries[1]?.failed?.[1]).toBe('webhook: HTTP 502');
      expect(history.entries[1]?.failed?.[2]).toMatch(/^typed: /);
    }
  });

  test('a webhook post whose fate is unknown (sent-unknown) stops the cascade before typed and is never repeated', async () => {
    let hits = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        hits += 1;
        await Bun.sleep(250);
        return new Response('late', { status: 200 });
      },
    });
    stops.push(() => server.stop(true));
    const url = `http://127.0.0.1:${String(server.port)}/routine`;
    const files = hookFiles(url);
    const one = world(['socket', 'typed', 'drop'], [{ ...CURSOR, webhook: files }]);
    made.push(one);
    // Set `timeout_ms: 40` on the seat's webhook row so the sender's POST times out into `sent-unknown`.
    const teamYamlPath = join(one.dir, 'team.yaml');
    writeFileSync(
      teamYamlPath,
      readFileSync(teamYamlPath, 'utf8').replace(
        `      secret_file: ${JSON.stringify(files.secretFile)}\n`,
        `      secret_file: ${JSON.stringify(files.secretFile)}\n      timeout_ms: 40\n`,
      ),
    );
    const pane = wakeFake(wakeScript());
    const host = fake(one, {
      agents: () => [{ name: 'cursor', pane: 'pane-1' }],
      typedWake: () => pane.host,
      inboxGraceMs: 0,
    });
    const io = owner(one.root);
    expect(await runSend(['cursor', 'hello'], io, host)).toBe(0);
    // The walk stops at webhook: it never types into the idle pane, and reports the unknown fate.
    expect(hits).toBe(1);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    expect(io.out).toContain('cursor: sent (unconfirmed) (webhook, ');
    expect(io.out).toContain('webhook delivery unknown: no answer within 40 ms');

    const dir = inboxOf(one);
    const records = recordsIn(dir);
    expect(records).toHaveLength(1);
    const id = records[0]!;
    // The claim beside the record stays in `sent` so no later pass repeats the POST.
    const claim = JSON.parse(readFileSync(join(dir, `${id}.posting`), 'utf8')) as { state: string };
    expect(claim.state).toBe('sent');
    expect(existsSync(join(dir, `${id}.posted`))).toBe(false);

    // Even when the bus adapter encounters the same record (including after the stale age), it skips without posting.
    const busOutcome = await deliverWebhook({
      seat: 'cursor',
      webhook: files,
      record: {
        signature: 'synthetic',
        payload: {
          v: 1,
          seq: 1,
          ts: '2026-11-03T00:00:00.000Z',
          kind: 'message.arrived',
          session: 'acme',
          record_id: id,
          from: 'owner',
          to: 'cursor',
        },
      },
      root: one.root,
      policy: { claimStaleMs: 0 },
    });
    expect(busOutcome).toBe('skipped');
    expect(hits).toBe(1);
  });
});
