// Independent verification for send summary outcomes vs. seat delivery classes:
//
// 1. A send's summary line states the leg's own recorded outcome, never the seat's delivery class
//    as if an adapter had woken the seat.
// 2. A drop that no adapter leg took prints `queued, not woken` (in plain text, `--json` status
//    and `action_summary`, and history), including when:
//      - a typed wake ran and failed (or did not run) and fell through to drop;
//      - `mcp-inbox` is declared or a live inbox listener sits beside the drop;
//      - the seat's delivery class reads `push` ("woken through its event adapter") via the
//        development channel flag, a live cross-session socket whose dial failed, or a webhook
//        adapter row, and no adapter leg took the message.
// 3. A channel notification marker (`<id>.channel-push.json`) prints `notified, not yet read`
//    (in plain text, `--json` `action_summary`, and `walkReplyDelivery`), never `woken`, and
//    promotes to `delivered (read)` only when a real signed read receipt lands.
// 4. A socket push prints `delivered (socket)` (in plain text, `--json`, and `walkReplyDelivery`),
//    never `woken`.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend, walkReplyDelivery, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import { resolveLobby } from '../src/lobby/gate.ts';
import { channelPushPath, markChannelNotified, recordChannelPush, type ChannelPushReceipt } from '../src/mcp/channel.ts';
import { MESSAGE_ID, inboxLive, listUnread, readMessage, receiptPath, writeListener } from '../src/mcp/inbox.ts';
import { buildIdentity } from '../src/version.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readHistory } from '../src/send/history.ts';
import { defaultNaming } from '../src/send/names.ts';
import { NO_PANE_MESSAGING } from '../src/send/no-pane-messaging.ts';
import { markPending, readPending } from '../src/send/pending.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { isRead, signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import type { Live } from '../src/status/compare.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import { promoteInboxDrops, type RetryScene, type RetrySources } from '../src/watch/retry.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertMatchesOutputSchema, withoutSendId } from './helpers/output.ts';

const NOW = new Date('2026-11-05T21:00:00.000Z');
const SESSION = 'acme';
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const MUSE_IDLE_SCREEN = readFileSync(join(import.meta.dir, 'fixtures', 'muse', '1.4.11', 'idle.txt'), 'utf8');
const MUSE_UNSENT_SCREEN = MUSE_IDLE_SCREEN.replace('❯\n', '❯ draft already in prompt\n');

type SendActionJson = {
  status: string;
  action_summary: string;
  channel?: string | null;
  ids: { sent: string | null; reply: string | null };
  delivery?: Array<{ leg: string; state: string; reason?: string }>;
};

const tempRoots: string[] = [];

afterEach(() => {
  discardFixtures(tempRoots.splice(0));
});

type FixtureWorld = {
  base: string;
  root: string;
  dir: string;
  home: string;
  sockets: string;
  dropDirOf: (seat: string) => string;
};

function createWorld(extraYaml = ''): FixtureWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'woken-proof-ind-')));
  tempRoots.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const lobby = resolveLobby(home, { entity: 'floor' });
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });

  const urlFile = join(base, 'hook.url');
  const secretFile = join(base, 'hook.secret');
  writeFileSync(urlFile, 'http://127.0.0.1:9/unreachable\n', { mode: 0o600 });
  writeFileSync(secretFile, 'synthetic-secret-token\n', { mode: 0o600 });

  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
${extraYaml}seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: muse-worker
    cli: muse
    vendor: test
    model: Muse
    version: "1"
    launch: muse --yolo
  - role: implementer
    name: inbox-worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    delivery_order: [mcp-inbox, drop]
  - role: implementer
    name: socket-worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    inbound: accept
  - role: implementer
    name: channel-worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${CHANNEL_LAUNCH}
  - role: implementer
    name: adapter-webhook-worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${CHANNEL_LAUNCH}
    delivery_order: [drop]
    webhook:
      url_file: ${urlFile}
      secret_file: ${secretFile}
`,
  );

  return {
    base,
    root,
    dir,
    home,
    sockets,
    dropDirOf: (seat: string) => join(dir, 'send-drops', SESSION, seat),
  };
}

function baseHost(world: FixtureWorld, overrides: Partial<SendHost> = {}): SendHost {
  return {
    agents: () => [],
    processInfo: () => null,
    socketsDir: world.sockets,
    deliver: async () => ({ ok: false, reason: 'no socket dialed by default' }),
    inboxGraceMs: 0,
    channelGraceMs: 0,
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => 'idle',
      paneText: () => null,
      wait: async () => {},
    },
    now: () => NOW,
    home: world.home,
    ...overrides,
  };
}

function declareAcceptedSocket(world: FixtureWorld, seat: string, pid = 222, pane = 'pane-socket-1'): string {
  const settings = cliHookSettingsPath(world.dir, SESSION, seat);
  if (settings === null) throw new Error(`no hook settings path for ${seat}`);
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  const settingsAt = Date.now() - 60_000;
  utimesSync(settings, new Date(settingsAt), new Date(settingsAt));
  const sockPath = join(world.sockets, `${String(pid)}.sock`);
  writeFileSync(sockPath, '');
  registerAgent(world.home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: {
      team: teamIdOf(world.root),
      seat,
      session: SESSION,
      pane,
      address: sockPath,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  return sockPath;
}

function registerChannelListener(
  world: FixtureWorld,
  seat: string,
  channel = true,
  build?: { version: string; head: string | null; build: string | null },
): string {
  const dropDir = world.dropDirOf(seat);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  expect(
    writeListener(dropDir, {
      v: 1,
      seat,
      session: SESSION,
      root: world.root,
      cli: 'claude-code',
      pid: process.pid,
      ts: NOW.toISOString(),
      ...(build === undefined ? {} : {
        version: build.version,
        ...(build.head === null ? {} : { head: build.head }),
        ...(build.build === null ? {} : { build: build.build }),
      }),
      ...(channel ? { channel: true as const } : {}),
    }),
  ).toBe(true);
  return dropDir;
}

function makePushReceipt(world: FixtureWorld, seat: string, id: string): ChannelPushReceipt {
  return {
    v: 1,
    kind: 'channel-push',
    id,
    at: NOW.toISOString(),
  };
}

function historyEntriesOf(world: FixtureWorld) {
  const read = readHistory('acme', world.root, world.home);
  if (!read.ok) throw new Error(`failed to read history: ${read.reason}`);
  return read.entries;
}

function assertNeverClaimsWoken(text: string): void {
  expect(text).not.toContain('woken through');
  expect(text).not.toContain('the typed wake woke it');
  // Any occurrence of the word `woken` must be part of `not woken`.
  const stripped = text.replaceAll('not woken', '');
  expect(stripped).not.toMatch(/\bwoken\b/i);
}

describe('woken-needs-proof independent scenes', () => {

  test('4. channel marker then a real read receipt: prints notified, not yet read in text, --json and walkReplyDelivery (never woken), then promotes to delivered (read) on signed receipt', async () => {
    const world = createWorld();
    const build = buildIdentity();
    const dropDir = registerChannelListener(world, 'channel-worker', true, build);
    expect(inboxLive(dropDir, world.root, SESSION, 'channel-worker', build).live).toBe(true);
    const host = baseHost(world, {
      channelGraceMs: 500,
      native: {
        typeText: () => false,
        pressEnter: () => false,
        status: () => 'idle',
        paneText: () => null,
        wait: async () => {
          const unread = listUnread(dropDir, { to: 'channel-worker', root: world.root, session: SESSION }, world.home);
          for (const msg of unread) {
            if (!existsSync(channelPushPath(dropDir, msg.id))) {
              recordChannelPush(dropDir, makePushReceipt(world, 'channel-worker', msg.id));
            }
            // A reservation is not a delivery. The server marks the line written.
            markChannelNotified(dropDir, msg.id);
          }
        },
      },
    });

    // Plain text send
    const plainIo = testIo(world.root, { kind: 'owner' });
    expect(await runSend(['channel-worker', 'channel hello plain'], plainIo, host)).toBe(0);
    expect(withoutSendId(plainIo.out)).toBe(
      `team acme, session "acme"\nchannel-worker: notified, not yet read (channel, 0 ms)\n`,
    );
    expect(plainIo.out).not.toContain('woken');
    expect(plainIo.out).not.toContain('sent (channel)');

    // --json send
    const jsonIo = testIo(world.root, { kind: 'owner' });
    expect(await runSend(['channel-worker', 'channel hello json', '--json'], jsonIo, host)).toBe(0);
    const doc = JSON.parse(jsonIo.out) as SendActionJson & { schema: { name: string; version: number }; format: number; dry_run: boolean };
    expect(doc.schema).toEqual({ name: 'team.send', version: 1 });
    expect(doc.format).toBe(1);
    expect(doc.dry_run).toBe(false);
    expect(doc.status).toBe('sent (channel)');
    expect(doc.channel).toBe('channel');
    expect(withoutSendId(doc.action_summary)).toBe('channel-worker: notified, not yet read (channel, 0 ms)');
    expect(doc.action_summary).not.toContain('woken');
    expect(doc.delivery).toContainEqual({ leg: 'channel', state: 'attempted' });
    const sentId = doc.ids.sent!;
    expect(sentId).toMatch(MESSAGE_ID);

    // Reply walk over channel
    const replyId = '44444444-0000-4000-8000-000000000404';
    const replyPayload = {
      kind: 'message' as const,
      id: replyId,
      to: 'channel-worker',
      to_id: null,
      root: world.root,
      session: SESSION,
      at: NOW.toISOString(),
      body: 'from lead — admitted by: a seat of its own team\n\nreply over channel',
      from: 'lead',
      from_id: null,
      rule: 'a seat of its own team',
      thread: replyId,
    };
    const signedReply = signRecord(replyPayload, world.home);
    writeFileSync(join(dropDir, replyId), `${JSON.stringify(signedReply, null, 2)}\n`, { mode: 0o600 });
    const replyWalk = await walkReplyDelivery({
      io: testIo(world.root),
      host,
      dir: world.dir,
      root: world.root,
      project: 'acme',
      session: SESSION,
      seat: 'channel-worker',
      cli: 'claude-code',
      file: null,
      address: null,
      who: 'lead',
      sender: { teamId: 'team_acme', project: 'acme' },
      naming: defaultNaming('team_acme'),
      payload: replyPayload,
    });
    expect(replyWalk.via).toBe('channel');
    expect(replyWalk.unconfirmed).toBe(false);
    expect(replyWalk.summary).toBe('channel-worker: notified, not yet read (channel, 0 ms)');
    expect(replyWalk.summary).not.toContain('woken');

    // Before a real read receipt arrives, the message is still pending and unread.
    const key = messageKeyOf(world.home);
    expect(isRead(dropDir, sentId, { to: 'channel-worker', root: world.root, session: SESSION }, key)).toBe(false);
    expect(readPending(dropDir).some((p) => p.id === sentId && p.leg === 'channel')).toBe(true);

    // Now publish the real signed read receipt and run promoteInboxDrops.
    for (const id of [
      ...readPending(dropDir).map((p) => p.id),
    ]) {
      expect(
        publishRecordRead({
          dropDir,
          id,
          to: 'channel-worker',
          root: world.root,
          session: SESSION,
          home: world.home,
          key,
          at: NOW.toISOString(),
          readBy: 'channel',
        }),
      ).toEqual({ kind: 'published' });
      const receipt = JSON.parse(readFileSync(receiptPath(dropDir, id), 'utf8')) as SignedReceipt;
      expect(verifyReceipt(receipt, key)).toBe(true);
    }
    expect(isRead(dropDir, sentId, { to: 'channel-worker', root: world.root, session: SESSION }, key)).toBe(true);

    const loaded = loadTeamFile(world.root, { home: world.home });
    if (!loaded.ok) throw new Error('team.yaml failed to load');
    const said: string[] = [];
    const promoted = promoteInboxDrops({
      dir: world.dir,
      session: SESSION,
      root: world.root,
      home: world.home,
      team: loaded.team,
      live: { running: true, agents: [], workspaces: [], screens: {} },
      ownPane: null,
      sources: {
        screen: () => claudeBox(''),
        status: () => 'idle',
        typeText: () => false,
        pressEnter: () => false,
        sleep: async () => {},
      },
      now: NOW,
      say: (text: string) => said.push(text),
    });
    expect(promoted.has(`channel-worker\n${sentId}`)).toBe(true);
    expect(readPending(dropDir)).toEqual([]);
    expect(said).toContain('channel-worker: a channel send from owner was read (receipt)');
    const entries = historyEntriesOf(world);
    expect(entries.some((e) => e.id === sentId && e.outcome === 'delivered (read)' && e.via === 'channel')).toBe(
      true,
    );
  });
});
