// The send fallback acceptance, against the public `runSend`/`SendHost` seam.
//
// FIXED invariants (the reviewed decision, 2026-10-20) this file pins: the message is signed and staged
// once before any route attempt; every route attempt carries the same message id; the durable
// signed copy survives a failed route; and the receiver's effect is counted once across routes.
// Per-route timeout, route order and escalation delays are policies the walk varies.
//
// These scenes run against the walk this branch carries (`src/commands/send.ts` and
// `src/send/fallback-walk.ts`): a socket frame the transport refuses, or one the receiver holds at
// its dialog, falls through to the next allowed route with the same signed record and message id,
// never a second record; a walk no route takes records its exhaustion once and leaves one delayed
// escalation. The attempts feed, the held first attempt (receipt `unknown`, never read) and the
// all-failed event plus main escalation are pinned below as the walk records them.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import type { Caller } from '../src/caller.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { runNext } from '../src/commands/next.ts';
import { runSend } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { MESSAGE_ID, readMessage } from '../src/mcp/inbox.ts';
import { DELIVERY_ESCALATION_SECONDS } from '../src/policy/types.ts';
import {
  allFailedRecordId,
  attemptLedgerFileName,
  escalatedRecordId,
  escalationMailboxId,
  escalateDue,
  markerPathOf,
  type CanonicalRecipient,
  type FallbackMarker,
} from '../src/send/fallback-events.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { dropDir, fake, NOW, owner, scripted, world, type World } from './send-native-fixtures.ts';

const RULE = '─'.repeat(30);

/** A team the local queue reads, for the receiver-side scene: one placed seat and one task. */
const QUEUE_TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
tasks:
  source: file
  path: .agents/tasks.yaml
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's own declaration that it accepts cross-session frames, and the socket its
 *  pane exposes. The declaration's file predates the socket, so the session was started after the
 *  declaration took effect and the socket leg is live. */
function accepting(made: World): void {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(made.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. */
function declareEntity(made: World, entity = 'acme-corp'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

test('a refused socket frame falls through with the same record and message id', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const pane = scripted(['idle', 'working'], `${RULE}\n❯ \n${RULE}`);
  const dir = dropDir(made.dir, 'lead');
  const dials: string[] = [];
  let stagedAtDial: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      // The signed record is already on disk when the transport is dialed.
      stagedAtDial = readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
      dials.push(frame);
      return { ok: false, reason: 'the session closed the connection before it took the frame' };
    },
  });
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

  // One signed record, one message id, shared by both route attempts; it was staged before the
  // first attempt reached the transport.
  const records = readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
  expect(records).toHaveLength(1);
  const id = records[0] as string;
  expect(stagedAtDial).toEqual(records);
  expect(readFileSync(join(dir, id), 'utf8')).toContain(id);
  expect(dials).toHaveLength(1);
  expect(dials[0]).toContain(id);
  const trigger = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string;
  expect(pane.typed).toEqual([trigger]);

  // The one history line names the socket refusal and the route that took the send.
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  const entry = history.entries[history.entries.length - 1];
  expect(entry?.id).toBe(id);
  expect(entry?.via).toBe('typed');
  expect(entry?.failed).toEqual(['socket: the session closed the connection before it took the frame']);
});

test('a replayed delivery is served once by the real gate and takes its task once', async () => {
  // The first attempt's outcome was ambiguous (`maybe-consumed`), so the fallback repeats the same
  // id. The receiver's read is the real `readMessage` gate both adapters call: content exposure is
  // at most once, and the queued task it orders is claimed once. No fixture set stands in.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-gate-accept-')));
  cleanup = () => rmSync(base, { recursive: true, force: true });
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), QUEUE_TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
  });
  const id = '7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
  plantRecord(home, root, 'acme', 'lead', id, 'run team next');
  const target = { dropDir: join(root, '.agents', 'send-drops', 'acme', 'lead'), root, seat: 'lead', session: 'acme' };
  const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
  const at = Date.parse('2026-10-08T09:00:00.000Z');
  const claim = 'team acme, session "acme"\nm1  the task title\nteam next: claimed m1\n';

  const served = readMessage(target, id, home);
  expect(served.ok).toBe(true);
  if (!served.ok) return;
  expect(served.body).toBe('run team next');
  const first = testIo(root, lead);
  expect(await runNext([], first, { home, now: () => at })).toBe(0);
  expect(first.out).toBe(claim);
  const leasePath = join(root, '.agents', 'leases', 'm1.json');
  const acquired = JSON.parse(readFileSync(leasePath, 'utf8')).acquiredAt as string;

  // The replay: the same id, the same inbox, through the same production gate.
  const replayed = readMessage(target, id, home);
  expect(replayed).toEqual({
    ok: false,
    reason: `message ${JSON.stringify(id)} was already served in this inbox`,
    served: 'already-served',
  });
  const again = testIo(root, lead);
  expect(await runNext([], again, { home, now: () => at + 1000 })).toBe(0);
  expect(again.out).toBe(claim);

  // One real body exposure, one claimed task: the replay renewed the same lease.
  expect([served, replayed].filter((read) => read.ok)).toHaveLength(1);
  expect(readdirSync(join(root, '.agents', 'leases'))).toEqual(['m1.json']);
  expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toMatchObject({
    id: 'm1',
    seat: 'lead',
    pane: 'w1:p1',
    acquiredAt: acquired,
  });
});

test('a held socket frame falls through to the typed route with the same record and id', async () => {
  // The frame reaches the transport and the receiver holds it at its dialog: the write landed but
  // no seat took it, and the receipt stays `unknown` — a transport fact, never a read. A live
  // route stands behind the socket, so the walk continues with the same signed record and id.
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const emptyBox = `${RULE}\n❯ \n${RULE}`;
  const heldDialog = `Held message from another session\n${RULE}\n❯ \n${RULE}`;
  let frameLanded = false;
  let dialogShown = false;
  const pane = scripted(['idle', 'working']);
  // The dialog renders right after the frame lands; every later read is the free box the typed
  // route types into.
  pane.paneText = () => {
    if (frameLanded && !dialogShown) {
      dialogShown = true;
      return heldDialog;
    }
    return emptyBox;
  };
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_socketPath, frame) => {
      dials.push(frame);
      frameLanded = true;
      return { ok: true };
    },
  });
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

  // One staged record and one frame, both carrying the one message id the typed route took.
  const dir = dropDir(made.dir, 'lead');
  const records = readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
  expect(records).toHaveLength(1);
  const id = records[0] as string;
  expect(dials).toHaveLength(1);
  expect(dials[0]).toContain(id);
  const trigger = readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string;
  expect(pane.typed).toEqual([trigger]);

  const recipient: CanonicalRecipient = { team: 'acme', seat: 'lead', toId: null, session: 'acme', root: made.root };
  const marker = JSON.parse(readFileSync(markerPathOf(recipient, id), 'utf8')) as FallbackMarker;
  expect(marker).toMatchObject({ format: 1, messageId: id, status: 'delivered', sender: 'owner' });
  expect(marker.recipient).toEqual(recipient);
  expect(marker.dueAt).toBeUndefined();
  expect(marker.attempts.map((attempt) => ({ route: attempt.route, outcome: attempt.outcome, receipt: attempt.receipt }))).toEqual([
    { route: 'socket', outcome: 'held', receipt: { kind: 'unknown' } },
    { route: 'typed', outcome: 'delivered', receipt: { kind: 'unknown' } },
  ]);
  const heldReason = marker.attempts[0]?.reason ?? '';
  expect(heldReason).toContain('Held message from another session');

  // The durable ledger keeps every attempt in the order the walk made them, beside the bounded
  // marker summary.
  const ledger = join(dirname(historyPath('acme', made.root, made.home)), attemptLedgerFileName(recipient, id));
  const attempts = readFileSync(ledger, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { route: string; outcome: string });
  expect(attempts.map((attempt) => ({ route: attempt.route, outcome: attempt.outcome }))).toEqual([
    { route: 'socket', outcome: 'held' },
    { route: 'typed', outcome: 'delivered' },
  ]);

  // The feed route that actually took the send is the typed one, and its history line names the
  // held frame it walked past.
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  const entry = history.entries[history.entries.length - 1];
  expect(entry?.id).toBe(id);
  expect(entry?.via).toBe('typed');
  expect(entry?.failed).toEqual([`socket: ${heldReason}`]);
});

test('an all-failed walk emits the immediate event and the delayed main escalation once', async () => {
  // No route takes the send: the socket write refuses, and the typed route's seat is not live.
  // The last route's failure is exhaustion, so the walk emits the immediate all-failed event and
  // schedules the main escalation; the escalation fires once at its due instant, under focused
  // virtual time, and a second pass writes nothing.
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  accepting(made);
  const host = fake(made, {
    agents: () => [],
    deliver: async () => ({ ok: false, reason: 'the session closed the connection before it took the frame' }),
  });
  const io = owner(made.root);

  expect(await runSend(['lead', 'hello'], io, host)).toBe(1);

  const dir = dropDir(made.dir, 'lead');
  const records = readdirSync(dir).filter((name) => MESSAGE_ID.test(name));
  expect(records).toHaveLength(1);
  const id = records[0] as string;
  const recipient: CanonicalRecipient = { team: 'acme', seat: 'lead', toId: null, session: 'acme', root: made.root };
  const marker = JSON.parse(readFileSync(markerPathOf(recipient, id), 'utf8')) as FallbackMarker;
  // The canonical 300 s release default schedules the main escalation; nothing was escalated yet.
  const allFailedAt = NOW.toISOString();
  const dueAt = new Date(NOW.getTime() + DELIVERY_ESCALATION_SECONDS * 1000).toISOString();
  expect(marker).toMatchObject({ format: 1, messageId: id, status: 'all-failed', sender: 'owner', allFailedAt, dueAt });
  expect(marker.recipient).toEqual(recipient);
  expect(marker.escalatedAt).toBeUndefined();
  expect(marker.outbox).toBeUndefined();
  expect(marker.attempts.map((attempt) => ({ route: attempt.route, outcome: attempt.outcome, receipt: attempt.receipt }))).toEqual([
    { route: 'socket', outcome: 'unreachable', receipt: { kind: 'unknown' } },
    { route: 'typed', outcome: 'unreachable', receipt: { kind: 'unknown' } },
  ]);

  // The immediate event: one `message.held` from the sender to the recipient, on the route whose
  // failure ended the order.
  const log = readEvents('acme', made.root, made.home);
  expect(log.ok).toBe(true);
  if (!log.ok) return;
  const allFailedId = allFailedRecordId(recipient, id);
  const failing = log.events.filter((event) => event.payload.record_id === allFailedId);
  expect(failing).toHaveLength(1);
  expect(failing[0]?.payload).toMatchObject({
    kind: 'message.held',
    session: 'acme',
    record_id: allFailedId,
    from: 'owner',
    to: 'lead',
    seat: 'lead',
    thread: id,
    via: 'typed',
    reason: 'all live routes failed',
  });

  // The delayed main escalation, at its due instant. The entity lead is handed in, so the pass
  // needs no registry read; the target seat differs from the recipient, so it also gets a
  // mailbox record.
  const loaded = loadTeamFile(made.root, { home: made.home });
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const caller: Caller = { kind: 'owner' };
  const orchestrator = { seat: 'native', team: 'acme', root: made.root, session: 'acme' };
  const ctx = { caller, team: loaded.team, root: made.root, home: made.home, now: () => new Date(dueAt), orchestrator };
  const due = escalateDue(ctx, { at: new Date(dueAt) });
  expect(due.escalated).toHaveLength(1);
  const escalation = due.escalated[0];
  expect(escalation?.messageId).toBe(id);
  expect(escalation?.event.payload).toMatchObject({
    kind: 'message.held',
    record_id: escalatedRecordId(recipient, id),
    from: 'owner',
    to: 'native',
    seat: 'lead',
    thread: id,
    via: 'fallback',
    reason: `still undelivered after ${String(DELIVERY_ESCALATION_SECONDS)}s: all live routes failed`,
  });
  expect(escalation?.duplicate).toBe(false);
  const mailbox = join(made.root, '.agents', 'messages', 'native', `${escalationMailboxId(recipient, id)}.json`);
  expect(escalation?.mailbox).toBe(mailbox);
  expect(existsSync(mailbox)).toBe(true);

  // A second pass after the due instant is a no-op: `escalatedAt` is the episode's own receipt.
  const again = escalateDue(ctx, { at: new Date(Date.parse(dueAt) + 1000) });
  expect(again.escalated).toHaveLength(0);
  const settled = JSON.parse(readFileSync(markerPathOf(recipient, id), 'utf8')) as FallbackMarker;
  expect(settled).toMatchObject({ status: 'all-failed', allFailedAt, dueAt, escalatedAt: dueAt, escalatedTo: orchestrator });
  expect(settled.attempts).toHaveLength(2);
  expect(settled.outbox).toBeUndefined();
  const after = readEvents('acme', made.root, made.home);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.events.filter((event) => event.payload.record_id === escalatedRecordId(recipient, id))).toHaveLength(1);
});
