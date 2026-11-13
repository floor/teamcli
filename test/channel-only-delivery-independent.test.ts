// A seat whose channel is on is delivered once, through that channel. The socket is a fallback
// only when the order lists it and the channel server is not connected. A channel marker beside
// a signed record does not stop this seat's own shell acknowledgement, and an unsigned record
// is still refused.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAck } from '../src/commands/ack.ts';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { updateState, emptySession } from '../src/state.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER, channelPushPath, recordChannelEmitted } from '../src/mcp/channel.ts';
import { writeListener } from '../src/mcp/inbox.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { RECORD_KIND, receiptFile, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { recordDir } from '../src/commands/messages.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';
import { NOW, fake, owner, quietNative, world, type World } from './send-native-fixtures.ts';

const PANE = 'pane-lead';
const SHELL = 410;
const CLI_PID = 411;
const CHANNEL_LAUNCH = `claude ${CHANNEL_FLAG} server:${CHANNEL_SERVER}`;

const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

function keep(made: World): World {
  owned.push(dirname(made.root));
  return made;
}

/** The fixture team names an entity, so the socket frame can name its owner. */
function entityFile(made: World): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: 'box' });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, `${text.replace(lobbyDir(made.home), lobby)}entity: box\n`);
}

function placeSocket(made: World): void {
  writeFileSync(join(made.sockets, `${String(CLI_PID)}.sock`), '');
}

/** The launch's own settings file declares accept, and it is older than the socket the pane
 *  exposes: the session was started after the launcher declared the policy. */
function acceptOlderThanSocket(made: World): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  placeSocket(made);
  const settingsAt = new Date(Date.now() - 60_000);
  utimesSync(path, settingsAt, settingsAt);
}

function listen(made: World, seat: string): void {
  const drop = join(made.dir, 'send-drops', 'acme', seat);
  mkdirSync(drop, { recursive: true });
  const wrote = writeListener(drop, {
    v: 1,
    seat,
    session: 'acme',
    root: made.root,
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW.toISOString(),
    channel: true,
  });
  if (!wrote) throw new Error('the fixture listener marker was not written');
}

function hostFor(made: World, extra: { id?: string; pushOnWait?: boolean; graceMs?: number } = {}) {
  const pane = quietNative();
  const drop = join(made.dir, 'send-drops', 'acme', 'lead');
  return fake(made, {
    agents: () => [{ name: 'lead', pane: PANE, cli: 'claude' }],
    processInfo: () => ({ shell: SHELL, foreground: [CLI_PID] }),
    socketsDir: made.sockets,
    native: {
      ...pane,
      wait: async () => {
        if (extra.pushOnWait !== true || extra.id === undefined) return;
        mkdirSync(drop, { recursive: true });
        writeFileSync(channelPushPath(drop, extra.id), `${JSON.stringify({ id: extra.id, notified: true })}\n`);
      },
    },
    ...(extra.graceMs === undefined ? {} : { channelGraceMs: extra.graceMs }),
    ...(extra.id === undefined ? {} : { sendId: () => extra.id as string }),
  });
}

test('a channel that is on but not connected falls back to the socket when the order lists it', async () => {
  const made = keep(world(['mcp-inbox', 'socket', 'typed'], [], { lead: CHANNEL_LAUNCH }));
  entityFile(made);
  acceptOlderThanSocket(made);
  const host = hostFor(made);
  const io = owner(made.root);
  expect(await runSend(['lead', 'a note while the channel server is down'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(io.out).toContain('lead: delivered (socket)');
});

test('a seat with the channel off keeps the socket delivery', async () => {
  const made = keep(world(null));
  entityFile(made);
  acceptOlderThanSocket(made);
  const host = hostFor(made);
  const io = owner(made.root);
  expect(await runSend(['lead', 'a note on the socket'], io, host)).toBe(0);
  expect(host.frames).toHaveLength(1);
  expect(io.out).toContain('lead: delivered (socket)');
});

function recordFor(made: World, seat: string, id: string): void {
  const payload: RecordPayload = {
    kind: RECORD_KIND,
    id,
    to: seat,
    to_id: null,
    root: made.root,
    session: 'acme',
    at: NOW.toISOString(),
    body: 'from the owner\n\nA note the channel already emitted.\n',
    from: 'owner',
    from_id: null,
    rule: 'the owner may write to a seat of this team',
    thread: id,
  };
  const written = writeRecord(recordDir(made.root, 'acme', seat), signRecord(payload, made.home));
  if (!written.ok) throw new Error(written.reason);
}

test("this seat's shell ack reads its own channel record, and the marker is not the record", async () => {
  const made = keep(world(null));
  entityFile(made);
  const id = 'c0bb1e00-1111-4000-8000-0000000000c1';
  recordFor(made, 'lead', id);
  const drop = recordDir(made.root, 'acme', 'lead');
  if (!recordChannelEmitted(drop, id, NOW.toISOString())) throw new Error('the channel marker was not written');
  updateState(made.dir, (state) => {
    const session = state.sessions.acme ?? (state.sessions.acme = emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE };
  });
  const io = testIo(made.root, { kind: 'seat', name: 'lead', pane: PANE, session: 'acme' });
  expect(await runAck(['c0bb1e00'], io, { home: made.home, now: () => NOW })).toBe(0);
  expect(io.err).toBe('');
  expect(io.out).toContain(`${id}: read`);
  expect(existsSync(receiptFile(drop, id, 'read'))).toBe(true);
});

test('an unsigned record in another seat folder is still refused', async () => {
  const made = keep(world(null));
  entityFile(made);
  const id = 'f0e19600-2222-4000-8000-0000000000f1';
  const drop = recordDir(made.root, 'acme', 'helper');
  mkdirSync(drop, { recursive: true });
  messageKeyOf(made.home);
  writeFileSync(join(drop, id), `${JSON.stringify({ v: 1, id })}\n`);
  updateState(made.dir, (state) => {
    const session = state.sessions.acme ?? (state.sessions.acme = emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE };
  });
  const io = testIo(made.root, { kind: 'seat', name: 'lead', pane: PANE, session: 'acme' });
  expect(await runAck([id], io, { home: made.home, now: () => NOW })).toBe(1);
  expect(io.err).toContain('the record is not a signed record');
});
