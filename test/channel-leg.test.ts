// The channel leg as the sender and the watch see it: a Claude Code seat whose launch carries the
// development channel, whose own inbox server is listening with `channel` declared, takes the
// written record as a push. The server's `<id>.channel-push.json` marker is what ends the walk
// `sent (channel)`; nothing is typed and no pane is read. The push is not a read: the marker stays
// pending until a signed receipt follows, and a promotion settles it `delivered (read)` without a
// keystroke. A push whose confirmation window ends with no receipt is redelivered exactly once —
// the socket first, then the typed trigger — with `redelivered: channel unconfirmed` written
// before either attempt, so no later pass can redeliver it again. An acknowledged record is never
// touched: a receipt that lands after the redelivery settles the marker and types nothing more.
//
// Fixtures only: a synthetic team, a listener written by this test, a pane this test scripts, and
// a push marker written where the seat's server would write it. No live session is touched, and
// the server's own half (capability, notification, ack, unknown-id refusal) is
// `test/mcp-channel-server.test.ts`.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redeliverChannelOnSocket, runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import {
  CHANNEL_CONFIRM_MS,
  CHANNEL_HELD_RECEIPT,
  CHANNEL_UNCONFIRMED,
  CHANNEL_UNCONFIRMED_REASON,
  channelPushHeld,
  channelPushPath,
  channelPushed,
  recordChannelPush,
  type ChannelPushReceipt,
} from '../src/mcp/channel.ts';
import { MESSAGE_ID, receiptPath, writeListener } from '../src/mcp/inbox.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { readHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending, readPending } from '../src/send/pending.ts';
import { signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import type { Live } from '../src/status/compare.ts';
import { promoteInboxDrops, retryHeldDrops, type RetryScene, type RetrySources } from '../src/watch/retry.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { claudeBox, recordBody } from './helpers.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const SEND_ID = 'aaaaaaaa-0000-4000-8000-000000000201';
const REDELIVER_ID = 'bbbbbbbb-0000-4000-8000-000000000202';
const ACK_LATE_ID = 'cccccccc-0000-4000-8000-000000000203';
const SOCKET_ID = 'dddddddd-0000-4000-8000-000000000204';
const HEADER = 'from the owner — admitted by: the owner\n\n';
const BODY = `${HEADER}hello`;
/** What the retry's own trigger line names: the body after the display header. */
const TRIGGER = 'hello';
const TRIGGER_TAKEN = 'trigger taken, no read receipt yet';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** A channel seat's world: no declared delivery order, and the lead's launch carries the flag. */
function channelWorld(order: readonly string[] | null = null): World {
  const made = world(order, [], { lead: CHANNEL_LAUNCH });
  cleanup = made.cleanup;
  return made;
}

/** The listener marker a serving inbox leaves, with `channel` declared. The pid is this
 *  process's, so the liveness check sees a live server. */
function listening(made: World, seat = 'lead'): string {
  const dir = dropDir(made.dir, seat);
  mkdirSync(dir, { recursive: true });
  writeListener(dir, {
    v: 1,
    seat,
    session: SESSION,
    root: realpathSync(made.root),
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
    channel: true,
  });
  return dir;
}

/** The marker of a channel server running another install: a live pid, an older version and
 *  another packed commit, so a sender or a retry of this build cannot vouch for its code. */
function staleListening(made: World, seat = 'lead'): string {
  const dir = dropDir(made.dir, seat);
  mkdirSync(dir, { recursive: true });
  writeListener(dir, {
    v: 1,
    seat,
    session: SESSION,
    root: realpathSync(made.root),
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
    version: '0.5.4-hotfix.9',
    build: 'a'.repeat(16),
    head: 'a'.repeat(40),
    channel: true,
  });
  return dir;
}

/** The marker the seat's server writes after one push. Only its id matters to the sender's wait;
 *  the rest is what the server records, kept whole so the fixture is the real shape. */
function pushMarker(made: World, id: string): ChannelPushReceipt {
  return {
    v: 1,
    kind: 'channel-push',
    id,
    seat: 'lead',
    session: SESSION,
    root: realpathSync(made.root),
    at: NOW.toISOString(),
    meta: { id, from: 'owner', seat: 'lead', team: 'acme' },
    content_sha256: 'a'.repeat(64),
    status: 'sent (channel)',
  };
}

type Watched = { typed: string[]; enters: string[] };

/** The host a channel send is handed: a pane that records every keystroke, and — when `push` is
 *  set — a server that writes the push marker the first time the sender waits. */
function senderHost(made: World, one: Watched, push: boolean, patch: Record<string, unknown> = {}) {
  const dir = dropDir(made.dir, 'lead');
  return fake(made, {
    sendId: () => SEND_ID,
    native: {
      typeText: (_session: string, _pane: string, text: string) => {
        one.typed.push(text);
        return true;
      },
      pressEnter: () => {
        one.enters.push('lead');
        return true;
      },
      status: () => 'idle',
      paneText: () => null,
      wait: async () => {
        if (!push) return;
        const names = existsSync(dir) ? readdirSync(dir) : [];
        const id = names.find((name) => MESSAGE_ID.test(name));
        if (id !== undefined) recordChannelPush(dir, pushMarker(made, id));
      },
    },
    ...patch,
  });
}

type Pane = { screen: string | null; status: string; typed: string[]; enters: number };

function pane(screen: string | null, status = 'idle'): Pane {
  return { screen, status, typed: [], enters: 0 };
}

function scripts(one: Pane): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      one.screen = claudeBox(pasted ? pasted[1] ?? '' : text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      one.screen = claudeBox('');
      return true;
    },
    sleep: async () => {},
  };
}

function liveWith(name: string, paneId: string): Live {
  return {
    running: true,
    agents: [
      { name, agent: 'claude', pane: paneId, workspace: 'first', status: 'idle', cwd: null },
      { name: null, agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
    ],
    workspaces: [],
    screens: {},
  };
}

/** The watch scene both passes are handed: the channel seat's team, one scripted pane, and the
 *  pass's own clock. */
function sceneOf(made: World, one: Pane, now: Date, said: string[], extra: Partial<RetryScene> = {}): RetryScene {
  const loaded = loadTeamFile(made.root, { home: made.home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return {
    dir: made.dir,
    session: SESSION,
    root: made.root,
    home: made.home,
    team: loaded.team,
    live: liveWith('lead', 'w1:p1'),
    ownPane: null,
    sources: scripts(one),
    now,
    say: (text: string) => said.push(text),
    ...extra,
  };
}

/** A signed record and the channel marker the channel leg leaves, as the sender wrote them. */
function seedChannel(made: World, id: string, body: string, ts = NOW): string {
  const dir = dropDir(made.dir, 'lead');
  const record = signRecord({
    kind: 'message',
    id,
    to: 'lead',
    to_id: null,
    root: realpathSync(made.root),
    session: SESSION,
    at: ts.toISOString(),
    body,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, made.home);
  dropMessage(dir, id, `${JSON.stringify(record, null, 2)}\n`);
  markPending(dir, { id, from: 'owner', to: 'lead', body, ts: ts.toISOString(), leg: 'channel', thread: id });
  return dir;
}

/** The ack the channel tool writes: the same signed receipt `team ack` publishes, with the
 *  channel's own `read_by`. */
function ack(made: World, dir: string, id: string, at: Date): void {
  const key = messageKeyState(made.home);
  expect(key.kind).toBe('key');
  if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
  const written = publishRecordRead({
    dropDir: dir,
    id,
    to: 'lead',
    root: realpathSync(made.root),
    session: SESSION,
    home: made.home,
    key: key.key,
    at: at.toISOString(),
    readBy: 'channel',
  });
  expect(written).toEqual({ kind: 'published' });
}

function lastEntry(made: World): Record<string, unknown> {
  const history = readHistory(SESSION, made.root, made.home);
  if (!history.ok) throw new Error('the history could not be read');
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) throw new Error('no history entry');
  return entry as unknown as Record<string, unknown>;
}

function entries(made: World): Record<string, unknown>[] {
  const history = readHistory(SESSION, made.root, made.home);
  if (!history.ok) throw new Error('the history could not be read');
  return history.entries as unknown as Record<string, unknown>[];
}

describe('the channel leg', () => {
  test('the push marker ends the walk sent (channel), with the record and marker left for the receipt', async () => {
    const made = channelWorld();
    const dir = listening(made);
    const one: Watched = { typed: [], enters: [] };
    const host = senderHost(made, one, true, { channelGraceMs: 500 });
    const io = owner(made.root);

    const code = await runSend(['lead', TRIGGER], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toBe(`team acme, session "acme"\nlead: sent (channel) (0 ms)\n`);
    // Nothing was typed and no pane was read: the push is the delivery.
    expect(one.typed).toEqual([]);
    expect(one.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(recordBody(join(dir, SEND_ID))).toBe(BODY);
    const marker = JSON.parse(readFileSync(channelPushPath(dir, SEND_ID), 'utf8')) as Record<string, unknown>;
    expect(marker.id).toBe(SEND_ID);
    // The marker waits for the seat's signed receipt; the push itself proved only that the
    // notification was written.
    expect(readPending(dir)).toEqual([
      { id: SEND_ID, from: 'owner', to: 'lead', body: BODY, ts: NOW.toISOString(), tries: 0, leg: 'channel', thread: SEND_ID },
    ]);
    expect(existsSync(receiptPath(dir, SEND_ID))).toBe(false);
    expect(lastEntry(made)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: BODY,
      id: SEND_ID,
      thread: SEND_ID,
      outcome: 'sent (channel)',
      ms: 0,
      via: 'channel',
    });
  });

  test('a push then its ack is one delivery: the marker settles delivered (read) and the watch types nothing', async () => {
    const made = channelWorld();
    const dir = listening(made);
    const one: Watched = { typed: [], enters: [] };
    const host = senderHost(made, one, true, { channelGraceMs: 500 });
    expect(await runSend(['lead', TRIGGER], owner(made.root), host)).toBe(0);

    ack(made, dir, SEND_ID, NOW);
    const receipt = JSON.parse(readFileSync(receiptPath(dir, SEND_ID), 'utf8')) as SignedReceipt;
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: SEND_ID, to: 'lead', read_by: 'channel' });
    const key = messageKeyState(made.home);
    if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);

    // No pane is needed to promote: the signed receipt is the whole proof.
    const box = pane(claudeBox(''));
    const said: string[] = [];
    const scene = sceneOf(made, box, NOW, said, { live: { running: true, agents: [], workspaces: [], screens: {} } });
    expect(promoteInboxDrops(scene)).toEqual(new Set([`lead\n${SEND_ID}`]));
    expect(readPending(dir)).toEqual([]);
    expect(said).toEqual([`lead: a channel send from owner was read (receipt)`]);
    // The one history line the ack adds, after the send's own.
    expect(entries(made)).toHaveLength(2);
    expect(entries(made)[1]).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: BODY,
      id: SEND_ID,
      outcome: 'delivered (read)',
      via: 'channel',
    });

    // A later watch pass has nothing to ring: the acknowledged record is never redelivered.
    const watch = sceneOf(made, box, new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1), said);
    await retryHeldDrops(watch);
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
    expect(said).toEqual([`lead: a channel send from owner was read (receipt)`]);
  });

  test('no push marker means the walk continues: the record waits in the inbox and the channel claims nothing', async () => {
    const made = channelWorld();
    const dir = listening(made);
    const one: Watched = { typed: [], enters: [] };
    // The server never writes the marker this time; the grace is over at once.
    const host = senderHost(made, one, false, { channelGraceMs: 0 });
    const io = owner(made.root);

    const code = await runSend(['lead', TRIGGER], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe(`team acme, session "acme"\nlead: sent (unconfirmed) (mcp-inbox, 0 ms)\n`);
    expect(io.out).not.toContain('sent (channel)');
    expect(existsSync(channelPushPath(dir, SEND_ID))).toBe(false);
    expect(one.typed).toEqual([]);
    expect(one.enters).toEqual([]);
    // The channel's own marker was cleared when its leg fell through; the inbox leg's marker is
    // the one left standing, so a watch pass treats it as the seat's own message, never a push.
    expect(readPending(dir)).toEqual([
      { id: SEND_ID, from: 'owner', to: 'lead', body: BODY, ts: NOW.toISOString(), tries: 0, leg: 'mcp-inbox', thread: SEND_ID },
    ]);
    expect(lastEntry(made)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: BODY,
      id: SEND_ID,
      thread: SEND_ID,
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'mcp-inbox',
      failed: ['channel: no push receipt within 0 ms'],
    });
  });
});

describe('the channel redelivery', () => {
  test('a push with no ack waits out the window, then one typed redelivery ends it for good', async () => {
    const made = channelWorld();
    const dir = seedChannel(made, REDELIVER_ID, BODY);
    const box = pane(claudeBox(''));
    const said: string[] = [];
    const early = sceneOf(made, box, new Date(NOW.getTime() + CHANNEL_CONFIRM_MS - 1_000), said);

    // Before the window ends the push still belongs to the seat's own client: nothing is typed.
    await retryHeldDrops(early);
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
    expect(readPending(dir)).toEqual([
      { id: REDELIVER_ID, from: 'owner', to: 'lead', body: BODY, ts: NOW.toISOString(), tries: 0, leg: 'channel', thread: REDELIVER_ID },
    ]);
    expect(entries(made)).toEqual([]);

    const due = new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1);
    const scene = sceneOf(made, box, due, said);
    await retryHeldDrops(scene);
    expect(box.typed).toHaveLength(1);
    expect(box.typed[0]).toContain(TRIGGER);
    expect(box.enters).toBe(1);
    expect(readPending(dir)).toEqual([]);
    expect(entries(made)).toEqual([
      {
        ts: due.toISOString(),
        from: 'owner',
        to: 'lead',
        body: BODY,
        id: REDELIVER_ID,
        outcome: 'sent (unconfirmed)',
        note: TRIGGER_TAKEN,
        via: 'typed',
        failed: [CHANNEL_UNCONFIRMED_REASON],
      },
    ]);
    expect(said).toEqual([`lead: a channel send from owner was sent on retry (${TRIGGER_TAKEN})`]);

    // The one redelivery is spent: a later pass types nothing, even though the send was never
    // confirmed as read.
    const later = sceneOf(made, box, new Date(due.getTime() + CHANNEL_CONFIRM_MS), said);
    await retryHeldDrops(later);
    expect(box.typed).toHaveLength(1);
    expect(box.enters).toBe(1);
  });

  test('a redelivery the box cannot take stays marked once, and a later ack settles it without typing', async () => {
    const made = channelWorld();
    const dir = seedChannel(made, ACK_LATE_ID, BODY);
    const box = pane(claudeBox('a draft only its author can send'));
    const said: string[] = [];
    const due = new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1);

    await retryHeldDrops(sceneOf(made, box, due, said));
    // The draft holds the box: no keystroke, and the marker records the one attempt made.
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
    expect(readPending(dir)).toEqual([
      {
        id: ACK_LATE_ID,
        from: 'owner',
        to: 'lead',
        body: BODY,
        ts: NOW.toISOString(),
        tries: 0,
        leg: 'channel',
        thread: ACK_LATE_ID,
        redelivered: CHANNEL_UNCONFIRMED,
      },
    ]);
    expect(entries(made)).toEqual([]);

    // The ack arrives after the redelivery: the marker is settled as the read it is, with the
    // redelivery noted on the line, and nothing is typed for the acknowledged message.
    ack(made, dir, ACK_LATE_ID, due);
    const scene = sceneOf(made, box, due, said);
    expect(promoteInboxDrops(scene)).toEqual(new Set([`lead\n${ACK_LATE_ID}`]));
    expect(readPending(dir)).toEqual([]);
    expect(entries(made)).toEqual([
      {
        ts: due.toISOString(),
        from: 'owner',
        to: 'lead',
        body: BODY,
        id: ACK_LATE_ID,
        outcome: 'delivered (read)',
        via: 'channel',
        failed: [CHANNEL_UNCONFIRMED_REASON],
      },
    ]);
    expect(said).toEqual([`lead: a channel send from owner was read (receipt)`]);

    // And a later pass still types nothing: the acknowledged record is never touched again.
    await retryHeldDrops(sceneOf(made, box, new Date(due.getTime() + CHANNEL_CONFIRM_MS), said));
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
  });

  test('the socket takes the redelivery first: one frame, its signed receipt, and the marker cleared', async () => {
    const made = channelWorld();
    // The owner's frame ends with the entity's owner-reply target, so the receiving team names
    // an entity whose shipped default answers (`floor`).
    declareEntity(made, 'floor');
    declareSeat(made, 'lead', 'accept');
    const dir = seedChannel(made, SOCKET_ID, BODY);
    const box = pane(claudeBox(''));
    const said: string[] = [];
    const frames: string[] = [];
    const due = new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1);
    const host = fake(made, {
      // The watch hands the redelivery its own clock, so the socket line is filed at the pass's
      // time, not at the wall time the fixture started.
      now: () => due,
      deliver: async (_path: string, frame: string) => {
        frames.push(frame);
        return { ok: true };
      },
    });
    const loaded = loadTeamFile(made.root, { home: made.home });
    if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
    const launch = loaded.team.seats.find((one) => one.name === 'lead')?.launch;
    const scene = sceneOf(made, box, due, said, {
      socketRedeliver: (dropDir, drop) => redeliverChannelOnSocket({
        host, dir: made.dir, root: made.root, project: 'acme', session: SESSION, seat: drop.to,
        cli: 'claude-code', dropDir, drop, team: loaded.team,
        ...(launch === undefined ? {} : { launch }),
      }),
    });

    await retryHeldDrops(scene);

    expect(frames).toHaveLength(1);
    const content = (JSON.parse(frames[0] as string) as { message: { content: string } }).message.content;
    expect(content).toContain(BODY);
    expect(content.split('\n').at(-1)).toBe('Reply with: team send orchestrator@floor "…"');
    // The socket delivery writes the same signed read receipt a socket send writes; the message
    // is served, so no later pass rings for it.
    const receipt = JSON.parse(readFileSync(receiptPath(dir, SOCKET_ID), 'utf8')) as SignedReceipt;
    expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: SOCKET_ID, to: 'lead', read_by: 'socket delivery' });
    const key = messageKeyState(made.home);
    if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
    expect(verifyReceipt(receipt, key.key)).toBe(true);
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
    expect(readPending(dir)).toEqual([]);
    expect(said).toEqual([`lead: a channel send from owner was redelivered on the socket`]);
    expect(lastEntry(made)).toEqual({
      ts: due.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(made.root),
      body: BODY,
      id: SOCKET_ID,
      thread: SOCKET_ID,
      outcome: 'delivered',
      ms: 0,
      via: 'socket',
      failed: [CHANNEL_UNCONFIRMED_REASON],
    });
  });

  test('the socket redelivery holds the push name first, so a stale channel server cannot push it too', async () => {
    const made = channelWorld();
    staleListening(made);
    const dir = seedChannel(made, SOCKET_ID, BODY);
    const box = pane(claudeBox(''));
    const said: string[] = [];
    const due = new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1);
    // The socket leg reads the push name as it is handed the drop: the reservation must already
    // be there, before any wake, or a later tick of the stale server would find the id free.
    let heldAtSocket: boolean | undefined;
    const scene = sceneOf(made, box, due, said, {
      build: () => ({ version: '0.5.5', build: 'b'.repeat(16), builtAt: NOW.getTime(), head: 'b'.repeat(40) }),
      socketRedeliver: async (dropDir, drop) => {
        heldAtSocket = channelPushHeld(dropDir, drop.id);
        return { ok: true };
      },
    });

    await retryHeldDrops(scene);

    expect(heldAtSocket).toBe(true);
    const marker = JSON.parse(readFileSync(channelPushPath(dir, SOCKET_ID), 'utf8')) as Record<string, unknown>;
    expect(marker).toMatchObject({ v: 1, kind: CHANNEL_HELD_RECEIPT, id: SOCKET_ID });
    // The held marker is not a push: the socket delivery is the one wake that happened.
    expect(channelPushed(dir, SOCKET_ID)).toBe(false);
    expect(box.typed).toEqual([]);
    expect(box.enters).toBe(0);
    expect(readPending(dir)).toEqual([]);
    expect(said).toEqual([`lead: a channel send from owner was redelivered on the socket`]);
  });

  test('a socket that will not take the frame falls to the typed trigger, with the reason said', async () => {
    const made = channelWorld();
    const dir = seedChannel(made, SOCKET_ID, BODY);
    const box = pane(claudeBox(''));
    const said: string[] = [];
    const due = new Date(NOW.getTime() + CHANNEL_CONFIRM_MS + 1);
    const scene = sceneOf(made, box, due, said, {
      socketRedeliver: async () => ({ ok: false, reason: 'the receiving seat does not declare crossSessionInbound accept' }),
    });

    await retryHeldDrops(scene);

    expect(box.typed).toHaveLength(1);
    expect(box.typed[0]).toContain(TRIGGER);
    expect(box.enters).toBe(1);
    expect(readPending(dir)).toEqual([]);
    expect(said).toEqual([
      `lead: a channel send from owner was not confirmed; the socket was not taken (the receiving seat does not declare crossSessionInbound accept), typing the trigger`,
      `lead: a channel send from owner was sent on retry (${TRIGGER_TAKEN})`,
    ]);
    expect(lastEntry(made)).toMatchObject({
      id: SOCKET_ID,
      outcome: 'sent (unconfirmed)',
      via: 'typed',
      failed: [CHANNEL_UNCONFIRMED_REASON],
    });
  });
});

/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. */
function declareEntity(made: World, entity: string): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** The receiving seat's own settings declaration, and the socket its pane exposes. The file
 *  predates the socket: the session was started after the launcher declared the policy. */
function declareSeat(made: World, seat: string, policy: string): void {
  const path = cliHookSettingsPath(made.dir, SESSION, seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const settingsAt = Date.now() - 60_000;
  utimesSync(path, new Date(settingsAt), new Date(settingsAt));
}
