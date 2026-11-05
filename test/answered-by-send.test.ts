// A seat's `team send` is its own answer (ADR `zeus-message-path`, D3). The send settles the
// NEWEST message the addressed seat delivered to the sending seat before the send's own instant,
// and only that one: a recipient that sent three messages and is answered once keeps the other
// two waiting. Only a delivery the history names as a frame, a channel push or a native handoff
// counts — a typed wake is that leg's own act and a webhook post is the sender's — and the
// receipt is the answering seat's own signed record, never the sender's.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkedMailboxReceipt } from '../src/bus/arrival.ts';
import { readEvents } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import type { Caller } from '../src/caller.ts';
import { runAck } from '../src/commands/ack.ts';
import { listUnackedMessages, plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runTrace } from '../src/commands/trace.ts';
import type { WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { channelPushPath } from '../src/mcp/channel.ts';
import { listUnread, listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { markAnsweredBySend } from '../src/send/answered-by-send.ts';
import { appendHistory } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import { isRead, signReceiptPayload, signRecord, signedReceiptOf, verifyReceipt } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import type { Machine } from '../src/watch/machine.ts';
import { reportedPath, reportUnreadDrops, wakePath, wakeTryPath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const OLD = 'a1000000-0000-4000-8000-000000000001';
const NEW = 'a1000000-0000-4000-8000-000000000002';
const TYPED = 'a1000000-0000-4000-8000-000000000003';
const CHANNEL = 'a1000000-0000-4000-8000-000000000004';
const WEBHOOK = 'a1000000-0000-4000-8000-000000000005';
const LATE = 'a1000000-0000-4000-8000-000000000006';

const PANE_LEAD = 'pane-lead';
const PANE_WORKER = 'pane-worker';
const PANE_HELPER = 'pane-helper';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = { root: string; home: string; sockets: string };

/** The file's three seats, all placed: a coordinator and two implementers. The send these scenes
 *  run travels the drop leg, so nothing is typed and no socket is opened. */
function makeWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'answered-by-send-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
delivery_order: [drop]
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: helper
    label: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`,
  );
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: PANE_LEAD };
    session.seats.worker = { stage: 'ready', pane: PANE_WORKER };
    session.seats.helper = { stage: 'ready', pane: PANE_HELPER };
  });
  return { root, home, sockets };
}

function makeHost(w: World): SendHost {
  return {
    agents: () => [
      { name: 'lead', pane: PANE_LEAD },
      { name: 'worker', pane: PANE_WORKER },
      { name: 'helper', pane: PANE_HELPER },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native: { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} } satisfies NativePane,
    now: () => NOW,
    home: w.home,
  };
}

const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: PANE_LEAD, session: 'acme' };

/** A message `team send` would have delivered to `seat`, signed by its sender. */
function delivered(w: World, seat: string, id: string, fields: Parameters<typeof plantRecord>[6]): void {
  plantRecord(w.home, w.root, 'acme', seat, id, 'a question', fields);
}

/** The sender's own history line: the first line about a message names the leg that carried it. */
function line(w: World, id: string, via: string, ts: string): void {
  appendHistory('acme', w.root, w.home, {
    ts,
    from: 'worker',
    to: 'lead',
    body: 'a question',
    id,
    outcome: 'delivered',
    via,
  });
}

function readReceiptOf(w: World, seat: string, id: string): ReturnType<typeof signedReceiptOf> {
  return signedReceiptOf(JSON.parse(readFileSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`), 'utf8')));
}

function readReceiptExists(w: World, seat: string, id: string): boolean {
  return existsSync(join(recordDir(w.root, 'acme', seat), `${id}.read.json`));
}

describe('a seat’s send is the read it signs', () => {
  test('it settles the newest delivered message from the addressed seat and leaves the older one waiting', async () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    delivered(w, 'lead', NEW, { from: 'worker', at: '2026-11-03T10:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');
    line(w, NEW, 'socket', '2026-11-03T10:00:01.000Z');

    const io = testIo(w.root, leadCaller);
    const code = await runSend(['worker', 'the answer'], io, makeHost(w));

    expect(code).toBe(0);
    expect(readReceiptExists(w, 'lead', NEW)).toBe(true);
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
    const read = readReceiptOf(w, 'lead', NEW);
    if (read === null) throw new Error('no read receipt was written');
    const { writer, ...fields } = read.payload;
    expect(fields).toEqual({
      kind: 'receipt',
      status: 'read',
      id: NEW,
      to: 'lead',
      root: w.root,
      session: 'acme',
      at: NOW_ISO,
      read_by: 'answered-by-send',
    });
    expect(writer?.pid).toBe(process.pid);
    const key = messageKeyState(w.home);
    if (key.kind !== 'key') throw new Error(key.kind);
    expect(verifyReceipt(read, key.key)).toBe(true);
    // The older question still waits, and the sent message's own copy in the recipient's folder
    // carries no read: the answering seat's act settles what it received, never what it sent.
    expect(listUnackedMessages(w.root, 'acme', w.home).filter((message) => message.to === 'lead').map((message) => message.id)).toEqual([OLD]);
    expect(readdirSync(recordDir(w.root, 'acme', 'worker')).filter((name) => name.endsWith('.read.json'))).toEqual([]);
  });

  test('only a frame, a channel push or a native handoff is evidence enough to answer', async () => {
    const w = makeWorld();
    delivered(w, 'lead', CHANNEL, { from: 'worker', at: '2026-11-03T08:00:00.000Z' });
    delivered(w, 'lead', TYPED, { from: 'worker', at: '2026-11-03T10:00:00.000Z' });
    delivered(w, 'lead', WEBHOOK, { from: 'worker', at: '2026-11-03T11:00:00.000Z' });
    delivered(w, 'lead', LATE, { from: 'worker', at: '2026-11-03T11:30:00.000Z' });
    line(w, CHANNEL, 'channel', '2026-11-03T08:00:01.000Z');
    line(w, TYPED, 'typed', '2026-11-03T10:00:01.000Z');
    line(w, WEBHOOK, 'webhook', '2026-11-03T11:00:01.000Z');
    // A frame delivered after this send is not answered by it, however the send is timed.
    line(w, LATE, 'socket', '2026-11-03T12:00:01.000Z');

    const code = await runSend(['worker', 'the answer'], testIo(w.root, leadCaller), makeHost(w));

    expect(code).toBe(0);
    // The channel push is older than the typed and webhook messages and still the one settled:
    // those two are not deliveries this rule counts, and a newer one never blocks an older.
    expect(readReceiptExists(w, 'lead', CHANNEL)).toBe(true);
    expect(readReceiptExists(w, 'lead', TYPED)).toBe(false);
    expect(readReceiptExists(w, 'lead', WEBHOOK)).toBe(false);
    expect(readReceiptExists(w, 'lead', LATE)).toBe(false);
    expect(
      listUnackedMessages(w.root, 'acme', w.home).filter((message) => message.to === 'lead').map((message) => message.id).sort(),
    ).toEqual([LATE, TYPED, WEBHOOK].sort());
  });

  test('a message signed by another agent under the addressed name is not settled by the name', () => {
    const w = makeWorld();
    const OTHER_AGENT = 'a1000000-0000-4000-8000-000000000007';
    const THIS_AGENT = 'a1000000-0000-4000-8000-000000000008';
    delivered(w, 'lead', OLD, { from: 'worker', from_id: THIS_AGENT, at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');

    const sweep = (senderId: string | null): ReturnType<typeof markAnsweredBySend> =>
      markAnsweredBySend({
        seat: 'lead',
        sender: 'worker',
        senderId,
        root: w.root,
        session: 'acme',
        project: 'acme',
        home: w.home,
        at: NOW_ISO,
      });

    // The address resolved to another registered agent: the same display name is another person.
    expect(sweep(OTHER_AGENT)).toEqual({ kind: 'none' });
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
    // The resolved id is the one the message's own signature names: this is that sender's message.
    expect(sweep(THIS_AGENT)).toEqual({ kind: 'marked', id: OLD });
    expect(readReceiptExists(w, 'lead', OLD)).toBe(true);
    expect(readReceiptOf(w, 'lead', OLD)?.payload.read_by).toBe('answered-by-send');
  });

  test('when no registry id resolved, the signed seat name is all the evidence there is', () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', from_id: 'a1000000-0000-4000-8000-000000000009', at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'native', '2026-11-03T09:00:01.000Z');

    const outcome = markAnsweredBySend({
      seat: 'lead',
      sender: 'worker',
      senderId: null,
      root: w.root,
      session: 'acme',
      project: 'acme',
      home: w.home,
      at: NOW_ISO,
    });

    expect(outcome).toEqual({ kind: 'marked', id: OLD });
  });
});

describe('independent adversarial read-receipt intake and D7 trace checks', () => {
  test('a receipt cannot be forged by the sender: foreign-key receipt is refused and the sending seat cannot ack, reply, or settle its own outbound message', async () => {
    const w = makeWorld();
    const senderHome = join(base, 'foreign-sender-home');
    mkdirSync(senderHome, { recursive: true });
    // Ensure both homes have distinct Ed25519 message keys.
    messageKeyOf(w.home);
    messageKeyOf(senderHome);

    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    const dropDir = recordDir(w.root, 'acme', 'lead');

    // Forge a `<OLD>.read.json` receipt signed with `senderHome`'s key instead of `w.home`'s key.
    const forged = signReceiptPayload(
      {
        kind: 'receipt',
        status: 'read',
        id: OLD,
        to: 'lead',
        root: w.root,
        session: 'acme',
        at: NOW_ISO,
        read_by: 'forged-by-sender',
      },
      senderHome,
    );
    const forgedPath = join(dropDir, `${OLD}.read.json`);
    writeFileSync(forgedPath, `${JSON.stringify(forged, null, 2)}\n`, { mode: 0o600 });

    const teamKey = messageKeyState(w.home);
    if (teamKey.kind !== 'key') throw new Error(teamKey.kind);

    // 1. Direct cryptographic and reader checks refuse the wrong-key receipt.
    expect(verifyReceipt(forged, teamKey.key)).toBe(false);
    expect(isRead(dropDir, OLD, { to: 'lead', root: w.root, session: 'acme' }, teamKey.key)).toBe(false);
    expect(listUnread(dropDir, { to: 'lead', root: w.root, session: 'acme' }, w.home).map((one) => one.id)).toContain(OLD);
    expect(listUnackedMessages(w.root, 'acme', w.home).map((one) => one.id)).toContain(OLD);
    expect(
      checkedMailboxReceipt(
        forgedPath,
        { session: 'acme', seat: 'lead', record_id: OLD },
        { root: w.root, session: 'acme' },
        teamKey.key,
      ),
    ).toEqual({ ok: false, reason: "the receipt is not signed with this checkout's message key" });

    // 2. `publishRecordRead` and `runAck` refuse to trust or overwrite the unverified receipt file.
    expect(
      publishRecordRead({
        dropDir,
        id: OLD,
        to: 'lead',
        root: w.root,
        session: 'acme',
        home: w.home,
        key: teamKey.key,
        at: NOW_ISO,
      }),
    ).toEqual({ kind: 'held', status: 'read', entry: 'file' });

    const ackIo = testIo(w.root, leadCaller);
    expect(await runAck([OLD], ackIo, { home: w.home, now: () => NOW })).toBe(1);
    expect(ackIo.err).toContain('the read receipt name is held by a file that does not verify for this message');

    // 3. Remove the foreign file and verify the SENDER seat (`worker`) cannot forge a read receipt
    // for `OLD` via `team ack`, `team reply`, or `markAnsweredBySend` (`worker -> lead`).
    rmSync(forgedPath);
    const workerCaller: Caller = { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' };
    const senderAckIo = testIo(w.root, workerCaller);
    expect(await runAck([OLD], senderAckIo, { home: w.home, now: () => NOW })).toBe(1);
    expect(senderAckIo.err).toContain('addressed to lead, not to worker');
    expect(existsSync(forgedPath)).toBe(false);

    const senderReplyIo = testIo(w.root, workerCaller);
    expect(
      await runReply([OLD, 'sender trying to reply to its own message'], senderReplyIo, {
        home: w.home,
        now: () => NOW,
        newId: () => 'b1000000-0000-4000-8000-000000000088',
      }),
    ).toBe(1);
    expect(senderReplyIo.err).toContain('addressed to lead, not to worker');
    expect(existsSync(forgedPath)).toBe(false);

    markAnsweredBySend({
      project: 'acme',
      root: w.root,
      session: 'acme',
      home: w.home,
      seat: 'worker',
      sender: 'lead',
      senderId: null,
      at: NOW_ISO,
    });
    expect(existsSync(forgedPath)).toBe(false);
  });

  test('team ack and team reply refuse an id addressed to another seat and write no receipt', async () => {
    const w = makeWorld();
    delivered(w, 'worker', OLD, { from: 'helper', at: '2026-11-03T09:00:00.000Z' });

    const replyHost: ReplyHost = {
      home: w.home,
      now: () => NOW,
      newId: () => 'b1000000-0000-4000-8000-000000000099',
    };

    // Calling `team ack <OLD>` as `lead` when `<OLD>` is addressed to `worker` is refused.
    const ackIo = testIo(w.root, leadCaller);
    expect(await runAck([OLD], ackIo, { home: w.home, now: () => NOW })).toBe(1);
    expect(ackIo.err).toContain('addressed to worker, not to lead');
    expect(readReceiptExists(w, 'worker', OLD)).toBe(false);
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);

    // Calling `team reply <OLD>` as `lead` when `<OLD>` is addressed to `worker` is refused.
    const repIo = testIo(w.root, leadCaller);
    expect(await runReply([OLD, 'not my message'], repIo, replyHost)).toBe(1);
    expect(repIo.err).toContain('addressed to worker, not to lead');
    expect(readReceiptExists(w, 'worker', OLD)).toBe(false);
    expect(existsSync(join(recordDir(w.root, 'acme', 'worker'), `${OLD}.replied.json`))).toBe(false);

    // Even if the file is copied into `lead`'s own drop folder, the signed `to: 'worker'` payload still causes refusal.
    mkdirSync(recordDir(w.root, 'acme', 'lead'), { recursive: true });
    copyFileSync(join(recordDir(w.root, 'acme', 'worker'), OLD), join(recordDir(w.root, 'acme', 'lead'), OLD));
    const ackCopiedIo = testIo(w.root, leadCaller);
    expect(await runAck([OLD], ackCopiedIo, { home: w.home, now: () => NOW })).toBe(1);
    const repCopiedIo = testIo(w.root, leadCaller);
    expect(await runReply([OLD, 'still not mine'], repCopiedIo, replyHost)).toBe(1);
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
    expect(readReceiptExists(w, 'worker', OLD)).toBe(false);
  });

  test('three messages from X and one newer message from Y followed by one send lead -> X marks only the newest from X and leaves older X and Y untouched', async () => {
    const w = makeWorld();
    const X1 = 'a1000000-0000-4000-8000-000000000011';
    const X2 = 'a1000000-0000-4000-8000-000000000012';
    const X3 = 'a1000000-0000-4000-8000-000000000013';
    const Y1 = 'a1000000-0000-4000-8000-000000000014';

    delivered(w, 'lead', X1, { from: 'worker', at: '2026-11-03T08:00:00.000Z' });
    delivered(w, 'lead', X2, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    delivered(w, 'lead', X3, { from: 'worker', at: '2026-11-03T10:00:00.000Z' });
    delivered(w, 'lead', Y1, { from: 'helper', at: '2026-11-03T11:00:00.000Z' });

    line(w, X1, 'socket', '2026-11-03T08:00:01.000Z');
    line(w, X2, 'channel', '2026-11-03T09:00:01.000Z');
    line(w, X3, 'native', '2026-11-03T10:00:01.000Z');
    appendHistory('acme', w.root, w.home, {
      ts: '2026-11-03T11:00:01.000Z',
      from: 'helper',
      to: 'lead',
      body: 'from Y',
      id: Y1,
      outcome: 'delivered',
      via: 'socket',
    });

    const io = testIo(w.root, leadCaller);
    expect(await runSend(['worker', 'one answer to X'], io, makeHost(w))).toBe(0);

    expect(readReceiptExists(w, 'lead', X3)).toBe(true);
    expect(readReceiptOf(w, 'lead', X3)?.payload.read_by).toBe('answered-by-send');
    expect(readReceiptExists(w, 'lead', X1)).toBe(false);
    expect(readReceiptExists(w, 'lead', X2)).toBe(false);
    expect(readReceiptExists(w, 'lead', Y1)).toBe(false);
    expect(
      listUnackedMessages(w.root, 'acme', w.home)
        .filter((m) => m.to === 'lead')
        .map((m) => m.id)
        .sort(),
    ).toEqual([X1, X2, Y1].sort());
  });

  test('a socket message with no ack gets silent before N, exactly one re-wake at N, nothing at 1.5N, the 2N report once at 2N, and nothing at 3N', async () => {
    const w = makeWorld();
    const codexInterrupted = readFileSync(new URL('./fixtures/codex/0.161.0/interrupted-idle.txt', import.meta.url), 'utf8');
    // Configure `worker` as a Codex seat so profile-gated `typedWake` is active.
    const teamPath = join(w.root, '.agents', 'team.yaml');
    writeFileSync(
      teamPath,
      readFileSync(teamPath, 'utf8').replace(
        `  - role: implementer\n    name: worker\n    label: worker\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude`,
        `  - role: implementer\n    name: worker\n    label: worker\n    cli: codex\n    vendor: test\n    model: Test\n    version: "0.161.0"\n    launch: codex`,
      ),
    );
    const parsed = validateTeamFile(readFileSync(teamPath, 'utf8'));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const team = parsed.team;

    const t0 = Date.parse('2026-11-03T10:00:00.000Z');
    delivered(w, 'worker', OLD, { from: 'lead', at: new Date(t0).toISOString() });
    const workerDropDir = recordDir(w.root, 'acme', 'worker');
    utimesSync(join(workerDropDir, OLD), new Date(t0), new Date(t0));
    appendHistory('acme', w.root, w.home, {
      ts: new Date(t0).toISOString(),
      from: 'lead',
      to: 'worker',
      body: 'a question',
      id: OLD,
      outcome: 'delivered',
      via: 'socket',
    });

    const calls: { pane: string; line: string; cli: string; session: string }[] = [];
    const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
    const makeScene = (nowMs: number) => {
      const sources: WatchSources = {
        live: () => ({
          running: true,
          agents: [{ name: 'worker', agent: 'codex', pane: PANE_WORKER, workspace: 'ws-worker', status: 'idle', cwd: null }],
          workspaces: [{ id: 'ws-worker', label: 'worker' }],
          screens: {},
        }),
        machine: () => fine,
        standing: () => ({ kind: 'none' }),
        readChecks: () => [],
        screen: () => codexInterrupted,
        status: () => 'idle',
        foreground: () => ['codex'],
        processes: () => null,
        typeText: () => false,
        pressEnter: () => false,
        sendKey: () => false,
        sleep: async () => {},
        notify: () => {},
        now: () => new Date(nowMs),
        wait: async () => false,
        alive: () => true,
        pid: 4242,
        home: w.home,
        statusSource: undefined,
        typedWake: async (pane, lineText, cli, session) => {
          calls.push({ pane, line: lineText, cli, session });
          // Even when the Enter is not confirmed (`delivered: false, typed: true`), a socket re-wake is one-shot.
          return { delivered: false, typed: true, tries: 1, reason: 'no working screen showed' };
        },
      };
      return {
        dir: join(w.root, '.agents'),
        session: 'acme',
        root: w.root,
        home: w.home,
        team,
        live: sources.live('acme', team)!,
        ownPane: null,
        sources,
        now: new Date(nowMs),
        say: () => {},
      };
    };

    const N = 60;
    // 1. Before N (t0 + 30 s): silent.
    await wakeUnreadDrops(makeScene(t0 + 30_000), { unreadAfter: N });
    reportUnreadDrops(makeScene(t0 + 30_000), { unreadAfter: N });
    expect(calls).toHaveLength(0);
    expect(existsSync(wakePath(workerDropDir, OLD))).toBe(false);
    expect(existsSync(reportedPath(workerDropDir, OLD))).toBe(false);

    // 2. At N (t0 + 60 s): exactly ONE re-wake carrying `ack <id> or reply`, reservation stays spent, no retry ledger.
    await wakeUnreadDrops(makeScene(t0 + 60_000), { unreadAfter: N });
    reportUnreadDrops(makeScene(t0 + 60_000), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.line).toContain(`ack ${OLD} or reply`);
    expect(existsSync(wakePath(workerDropDir, OLD))).toBe(true);
    expect(existsSync(wakeTryPath(workerDropDir, OLD))).toBe(false);
    expect(existsSync(reportedPath(workerDropDir, OLD))).toBe(false);

    // 3. At 1.5N (t0 + 90 s): no second wake, not yet reported.
    await wakeUnreadDrops(makeScene(t0 + 90_000), { unreadAfter: N });
    reportUnreadDrops(makeScene(t0 + 90_000), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(existsSync(reportedPath(workerDropDir, OLD))).toBe(false);

    // 4. At 2N (t0 + 120 s): 2N flag/report fires once, no second wake.
    await wakeUnreadDrops(makeScene(t0 + 120_000), { unreadAfter: N });
    reportUnreadDrops(makeScene(t0 + 120_000), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(existsSync(reportedPath(workerDropDir, OLD))).toBe(true);
    const leadDropsAt2N = readdirSync(recordDir(w.root, 'acme', 'lead')).filter((n) => !n.startsWith('.'));
    expect(leadDropsAt2N.length).toBeGreaterThanOrEqual(1);

    // 5. At 3N (t0 + 180 s): nothing added.
    await wakeUnreadDrops(makeScene(t0 + 180_000), { unreadAfter: N });
    reportUnreadDrops(makeScene(t0 + 180_000), { unreadAfter: N });
    expect(calls).toHaveLength(1);
    expect(readdirSync(recordDir(w.root, 'acme', 'lead')).filter((n) => !n.startsWith('.'))).toEqual(leadDropsAt2N);
  });

  test('the channel reserves before notification, writes no consumer receipt until explicit ack, and stops before exposing a stale launch', async () => {
    const w = makeWorld();
    const teamPath = join(w.root, '.agents', 'team.yaml');
    writeFileSync(
      teamPath,
      readFileSync(teamPath, 'utf8').replace(
        'launch: claude',
        'launch: claude --dangerously-load-development-channels server:team-inbox',
      ),
    );
    const teamId = teamIdOf(w.root);
    const agents = (['lead', 'worker', 'helper'] as const).map((seat) => registerAgent(w.home, {
      name: seat,
      signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'implementer' },
      lab: 'test', cli: 'claude-code', launcher: null,
      launch: seat === 'lead' ? 'claude --dangerously-load-development-channels server:team-inbox' : 'claude',
      reach: { team: teamId, seat, session: 'acme', pane: `pane-${seat}`, address: null },
      mcp: [], skills: [], lifecycle: 'running', by: 'owner',
    }));
    upsertTeam(w.home, teamId, {
      project: 'acme',
      session: 'acme',
      root: w.root,
      roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
    });

    const leadDropDir = recordDir(w.root, 'acme', 'lead');
    const PUSH_1 = 'c1000000-0000-4000-8000-000000000021';
    const PUSH_2 = 'c1000000-0000-4000-8000-000000000022';

    const pending: string[] = [];
    let ended = false;
    const replies: string[] = [];
    const observed: {
      pushMarkerDuringWrite: boolean | null;
      readReceiptDuringWrite: boolean | null;
      readReceiptDuringAckReply: boolean | null;
      wake: (() => void) | null;
    } = {
      pushMarkerDuringWrite: null,
      readReceiptDuringWrite: null,
      readReceiptDuringAckReply: null,
      wake: null,
    };

    const stream = {
      lines: (async function* () {
        for (;;) {
          if (pending.length > 0) {
            yield pending.shift()!;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            observed.wake = resolve;
          });
        }
      })(),
      write: (lineText: string) => {
        const parsed = JSON.parse(lineText) as { method?: string; id?: string };
        if (parsed.method === 'notifications/claude/channel') {
          // At the exact moment the notification is handed to `write`, `.channel-push.json` exists
          // and `.read.json` is absent: transport handoff cannot acknowledge a consumer read.
          observed.pushMarkerDuringWrite = existsSync(channelPushPath(leadDropDir, PUSH_1));
          observed.readReceiptDuringWrite = existsSync(receiptPath(leadDropDir, PUSH_1));
        }
        if (parsed.id === 'ack-push') {
          // The consumer's explicit ack publishes its receipt before reporting success.
          observed.readReceiptDuringAckReply = existsSync(receiptPath(leadDropDir, PUSH_1));
        }
        replies.push(lineText);
      },
    };

    const running = runMcpServe({ seat: 'lead', session: 'acme' }, testIo(w.root, leadCaller), stream, {
      home: w.home,
    });
    try {
      for (let i = 0; i < 400 && !existsSync(listenerPath(leadDropDir)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const writeSigned = (id: string, body: string) => {
        const rec = signRecord(
          {
            kind: 'message',
            id,
            to: 'lead',
            to_id: agents[0]!.id,
            root: realpathSync(w.root),
            session: 'acme',
            at: NOW_ISO,
            body,
            from: 'worker',
            from_id: agents[1]!.id,
            rule: 'the owner',
            thread: id,
          },
          w.home,
        );
        mkdirSync(leadDropDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(leadDropDir, id), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
      };

      writeSigned(PUSH_1, 'from worker\n\nfirst channel push');
      for (let i = 0; i < 400 && observed.pushMarkerDuringWrite === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(observed.pushMarkerDuringWrite).toBe(true);
      expect(observed.readReceiptDuringWrite).toBe(false);
      expect(existsSync(receiptPath(leadDropDir, PUSH_1))).toBe(false);
      expect(listUnread(leadDropDir, { to: 'lead', root: w.root, session: 'acme' }, w.home).map((one) => one.id)).toEqual([PUSH_1]);
      const pushLine = replies.find((one) => (JSON.parse(one) as Record<string, unknown>).method === 'notifications/claude/channel');
      expect(pushLine).toBeDefined();
      expect(pushLine!).not.toContain('"key"');
      expect(Object.keys((JSON.parse(pushLine!) as { params: Record<string, unknown> }).params)).toEqual(['content', 'meta']);

      pending.push(JSON.stringify({ jsonrpc: '2.0', id: 'ack-push', method: 'tools/call', params: { name: 'ack', arguments: { id: PUSH_1 } } }));
      observed.wake?.();
      for (let i = 0; i < 400 && observed.readReceiptDuringAckReply === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(observed.readReceiptDuringAckReply).toBe(true);
      const acknowledged = replies.map((one) => JSON.parse(one)).find((one) => one.id === 'ack-push');
      expect(acknowledged.result.isError).toBeUndefined();
      expect(JSON.parse(acknowledged.result.content[0].text)).toEqual({ acknowledged: PUSH_1, written: true });
      const read = readReceiptOf(w, 'lead', PUSH_1);
      expect(read?.payload.read_by).toBe('channel');
      const key = messageKeyState(w.home);
      if (key.kind !== 'key' || read === null) throw new Error('no verifiable receipt after ack');
      expect(verifyReceipt(read, key.key)).toBe(true);

      // Now move `lead` off its pane in `team.state.json` so `serving.alive()` refuses before `write`:
      // no notification is handed over and no read receipt is written for `PUSH_2`.
      updateState(join(w.root, '.agents'), (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.seats.lead = { stage: 'ready', pane: 'pane-moved' };
      });
      writeSigned(PUSH_2, 'from worker\n\nsecond channel push');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(receiptPath(leadDropDir, PUSH_2))).toBe(false);
      expect(existsSync(channelPushPath(leadDropDir, PUSH_2))).toBe(false);
      expect(replies.filter((one) => JSON.parse(one).method === 'notifications/claude/channel')).toHaveLength(1);
    } finally {
      ended = true;
      observed.wake?.();
      await running;
    }
  });

  test('D7: team trace <id> on a socket send that was replied to (via team reply or answered-by-send) shows the message.read step', async () => {
    const w = makeWorld();
    const teamPath = join(w.root, '.agents', 'team.yaml');
    writeFileSync(
      teamPath,
      readFileSync(teamPath, 'utf8').replace('delivery_order: [drop]', 'delivery_order: [socket, drop]'),
    );
    // Declare crossSessionInbound: 'accept' and live sockets for both `worker` and `lead`.
    for (const [seat, pid] of [['worker', 222], ['lead', 111]] as const) {
      const settings = cliHookSettingsPath(join(w.root, '.agents'), 'acme', seat);
      if (settings === null) throw new Error(`no settings path for ${seat}`);
      mkdirSync(dirname(settings), { recursive: true });
      writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
      const past = NOW.getTime() - 60_000;
      utimesSync(settings, new Date(past), new Date(past));
      writeFileSync(join(w.sockets, `${String(pid)}.sock`), '');
    }

    const extractId = (out: string): string => {
      const m = / \(id ([0-9a-f-]{36})\)/.exec(out);
      if (m === null) throw new Error(`no id in output: ${out}`);
      return m[1]!;
    };
    const workerCaller: Caller = { kind: 'seat', name: 'worker', pane: PANE_WORKER, session: 'acme' };

    // Case 1: Socket send `lead -> worker`, answered with `team reply <id>`.
    const sendIo1 = testIo(w.root, leadCaller);
    expect(await runSend(['worker', 'socket question 1'], sendIo1, makeHost(w)), sendIo1.err).toBe(0);
    const id1 = extractId(sendIo1.out);

    const replyIo = testIo(w.root, workerCaller);
    const replyHost: ReplyHost = {
      home: w.home,
      now: () => new Date(NOW.getTime() + 1_000),
      newId: () => 'd1000000-0000-4000-8000-000000000031',
    };
    expect(await runReply([id1, 'replying to socket question 1'], replyIo, replyHost), replyIo.err).toBe(0);
    expect(readReceiptOf(w, 'worker', id1)?.payload.read_by).toBe('reply');

    reconcilePass({ project: 'acme', root: w.root, home: w.home, session: 'acme', now: new Date(NOW.getTime() + 2_000) });

    const traceIo1 = testIo(w.root, leadCaller);
    expect(await runTrace([id1, '--json'], traceIo1, { home: w.home }), traceIo1.err).toBe(0);
    const doc1 = JSON.parse(traceIo1.out) as { steps: { kind: string; record_id: string; via?: string; outcome?: string }[] };
    expect(doc1.steps.map((s) => s.kind)).toEqual([
      'message.staged',
      'leg.tried',
      'message.arrived',
      'message.read',
      'message.replied',
      'message.delivered',
    ]);
    expect(doc1.steps.find((s) => s.kind === 'leg.tried')).toMatchObject({ via: 'socket', outcome: 'delivered' });
    expect(doc1.steps.find((s) => s.kind === 'message.read')?.record_id).toBe(`${id1}:read`);

    // Case 2: Socket send `lead -> worker`, answered with plain `team send lead "..."` (`answered-by-send`).
    const sendIo2 = testIo(w.root, leadCaller);
    expect(
      await runSend(['worker', 'socket question 2'], sendIo2, { ...makeHost(w), now: () => new Date(NOW.getTime() + 3_000) }),
      sendIo2.err,
    ).toBe(0);
    const id2 = extractId(sendIo2.out);

    const answerSendIo = testIo(w.root, workerCaller);
    expect(
      await runSend(['lead', 'answering socket question 2 via send'], answerSendIo, {
        ...makeHost(w),
        now: () => new Date(NOW.getTime() + 4_000),
      }),
      answerSendIo.err,
    ).toBe(0);
    expect(readReceiptOf(w, 'worker', id2)?.payload.read_by).toBe('answered-by-send');

    reconcilePass({ project: 'acme', root: w.root, home: w.home, session: 'acme', now: new Date(NOW.getTime() + 5_000) });

    const traceIo2 = testIo(w.root, leadCaller);
    expect(await runTrace([id2, '--json'], traceIo2, { home: w.home }), traceIo2.err).toBe(0);
    const doc2 = JSON.parse(traceIo2.out) as { steps: { kind: string; record_id: string; via?: string; outcome?: string }[] };
    expect(doc2.steps.map((s) => s.kind)).toEqual([
      'message.staged',
      'leg.tried',
      'message.arrived',
      'message.read',
      'message.delivered',
    ]);
    expect(doc2.steps.find((s) => s.kind === 'leg.tried')).toMatchObject({ via: 'socket', outcome: 'delivered' });
    expect(doc2.steps.find((s) => s.kind === 'message.read')?.record_id).toBe(`${id2}:read`);
  });
});
