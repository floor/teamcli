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

describe('a carrier\'s delivered receipt is the delivery evidence before its history line', () => {
  /** The carrier's signed hand-over receipt, as a native queue writes it before its grace wait. */
  function carried(w: World, id: string, leg: string, at: string): void {
    const receipt = signReceiptPayload(
      { kind: 'receipt', status: 'delivered', id, to: 'lead', root: w.root, session: 'acme', at, read_by: `carrier:${leg}` },
      w.home,
    );
    writeFileSync(join(recordDir(w.root, 'acme', 'lead'), `${id}.delivered.json`), `${JSON.stringify(receipt, null, 2)}\n`);
  }

  test('a send made while the native leg still waits settles the message just handed over, not the older one', () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');
    // The newer message: its queue took it at 11:59; the original send is still in its grace,
    // so no history line names it yet.
    delivered(w, 'lead', NEW, { from: 'worker', at: '2026-11-03T11:58:59.000Z' });
    carried(w, NEW, 'native', '2026-11-03T11:59:00.000Z');
    const outcome = markAnsweredBySend({ seat: 'lead', sender: 'worker', senderId: null, root: w.root, session: 'acme', project: 'acme', home: w.home, at: NOW_ISO });
    expect(outcome).toEqual({ kind: 'marked', id: NEW });
    expect(readReceiptOf(w, 'lead', NEW)?.payload.read_by).toBe('answered-by-send');
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
  });

  test('a --wait history line written after the answer does not hide a hand-over the carrier signed before it', () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');
    // The newer message: the socket took it at 11:59, before the answer (12:00); the sender was
    // waiting with --wait, so its first history line is stamped when the wait ended, 12:02.
    delivered(w, 'lead', NEW, { from: 'worker', at: '2026-11-03T11:58:59.000Z' });
    carried(w, NEW, 'socket', '2026-11-03T11:59:00.000Z');
    line(w, NEW, 'socket', '2026-11-03T12:02:00.000Z');
    const outcome = markAnsweredBySend({ seat: 'lead', sender: 'worker', senderId: null, root: w.root, session: 'acme', project: 'acme', home: w.home, at: NOW_ISO });
    expect(outcome).toEqual({ kind: 'marked', id: NEW });
    expect(readReceiptExists(w, 'lead', OLD)).toBe(false);
  });

  test('a carried typed wake, or a hand-over after the send, is not that evidence', () => {
    const w = makeWorld();
    delivered(w, 'lead', OLD, { from: 'worker', at: '2026-11-03T09:00:00.000Z' });
    line(w, OLD, 'socket', '2026-11-03T09:00:01.000Z');
    delivered(w, 'lead', NEW, { from: 'worker', at: '2026-11-03T11:58:59.000Z' });
    carried(w, NEW, 'typed', '2026-11-03T11:59:00.000Z');
    delivered(w, 'lead', LATE, { from: 'worker', at: '2026-11-03T11:59:30.000Z' });
    carried(w, LATE, 'native', '2026-11-03T12:00:05.000Z');
    const outcome = markAnsweredBySend({ seat: 'lead', sender: 'worker', senderId: null, root: w.root, session: 'acme', project: 'acme', home: w.home, at: NOW_ISO });
    expect(outcome).toEqual({ kind: 'marked', id: OLD });
    expect(readReceiptExists(w, 'lead', NEW)).toBe(false);
    expect(readReceiptExists(w, 'lead', LATE)).toBe(false);
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
});
