// `team reply`: answers the sender of one message record, on its thread.
//
// Draft 3 §3.4: a reply is a message record like any other — written into the folder of the seat
// it answers, signed with the checkout's message key, carrying `thread` (its first message's id)
// and `in_reply_to` (the record it answers). It goes to the sender of the record it answers,
// never to a third seat, and admission judges the pair exactly as a send's, with the reply rule
// (draft 3 §7, `reply-on-open-thread`) asked last: a reply is admitted while its thread is open,
// even between seats no other rule pairs.
//
// §3.5: a thread ends on `team reply --close` or when `thread-ttl` passes with no record; a reply
// on a closed thread opens a new one that cites it — its `in_reply_to` names the record it
// answers, and its `thread` is its own id. `--close` writes a signed sidecar beside the record it
// answers, `<id>.closed.json`, which every later reply reads first. `thread-cap` ends an exchange
// nobody closes.
//
// The record this command answers must be one this checkout's session holds for the caller: it is
// found by its id in the transport tree `<root>/.agents/send-drops/<session>/<seat>/<id>`, must
// verify against the message key, must name the caller as its recipient, and must sit in that
// recipient's folder. A message of an earlier build — `.agents/messages/<seat>/<id>.json` —
// carries no thread and is read, never answered.
//
// A reply is delivered the way the drop leg delivers: the record is left in the target's folder,
// nothing is typed and no frame is sent, and the receiving seat's own watch rings its own read
// (`Team: run team drops --read --seat <seat> --session <session>`). A human's pane takes exactly
// that, so no separate human rule is needed here.
import { randomUUID, type KeyObject } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readArgs } from '../args.ts';
import { raiseRefusalEvent } from '../bus/refusals.ts';
import { ensureClientInbox, scanClientInbox, writeClientInboxFile } from '../client/inbox.ts';
import { activeClientGrant, clientAdmission, readClientGrant, resolveEntityCoordinator, withClientGrantLock } from '../client/records.ts';
import { callerOf, callerVerdict, describeCaller, detachedRefusal, judgeCallerIn, logTag, standingOf, type Caller } from '../caller.ts';
import { projectIdOfTeam } from '../dev_mode.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import type { Command, Io } from '../io.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { logLine } from '../log.ts';
import { contextLine, hasJsonFlag, refuse, writeJson } from '../output/index.ts';
import { eventThresholdsInForce, type EventThresholds } from '../policy/index.ts';
import { resolveOwnerReplyTo } from '../policy/owner-reply.ts';
import { findAgent } from '../registry/agents.ts';
import { teamIdOf } from '../registry/teams.ts';
import { sayThreshold } from '../settings/inherit.ts';
import { senderHeader } from '../send/admit.ts';
import { namingFor } from '../send/names.ts';
import { appendHistory } from '../send/history.ts';
import { resolveTarget, type Target } from '../send/resolve.ts';
import {
  CLIENT_REPLY_RULE,
  closeFile,
  readClose,
  readRecord,
  recordNameOk,
  signClose,
  signReceiptPayload,
  signRecord,
  verifyClose,
  verifyRecord,
  writeClose,
  writeReceipt,
  writeRecord,
  type ClosePayload,
  type RecordPayload,
  type SignedRecord,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';
import { recordDir } from './messages.ts';
import { admissionOf, sealDropTree, senderIdOf } from './send.ts';

export const USAGE = `Usage: team reply <id> [<text>] [--close] [--json]
       team reply <id> --close

Replies to the sender of the message record <id>, or closes its thread.
A reply is a signed record in the sender's folder, on the same thread; it is
admitted while the thread is open. --close ends the thread, and a later reply
opens a new one that cites the closed thread's last record.

Exits 0 when the reply or the close is written, 1 when the reply is refused or no
record holds <id>, 2 when the invocation or the team file can't be read.
`;

export type ReplyHost = {
  home: string;
  now: () => Date;
  /** The id a reply record is written under; the real host mints a UUID, a test pins one. */
  newId?: () => string;
};

export const realHost: ReplyHost = { home: homedir(), now: () => new Date() };

const reply: Command = (argv, io) => runReply(argv, io, realHost);
export default reply;

/** The name shape a seat folder, a record's id and a sidecar's id all share. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** One record this run answers: the folder it was found in, its path, and its envelope. */
export type Found = { seat: string; path: string; record: SignedRecord };

export type Lookup =
  | { kind: 'found'; found: Found }
  | { kind: 'none' }
  | { kind: 'legacy' }
  | { kind: 'refused'; why: string };

/** Whether a thread is open, and what ended it when it is not. */
type ThreadState = { open: boolean; reason: 'close' | 'ttl' | 'cap' | null };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Two spellings of one folder: the real paths where both can be read, the strings otherwise. */
export function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** The marker names a send leaves beside a record; none of them is a message record. */
function isMarkerName(name: string): boolean {
  return name.endsWith('.pending') || name.endsWith('.taken') || name.endsWith('.read') || name.endsWith('.json');
}

/**
 * Every file in the session's transport tree that could be a record, in folder and name order:
 * `<root>/.agents/send-drops/<session>/<seat>/<id>`. The sidecars — a receipt's `<id>.<status>.json`
 * and a close's `<id>.closed.json` — and the watch's `work-<uuid>` nudges are not candidates, and
 * neither is a name a record's id cannot take. The file at a candidate's path may still be
 * anything; `readRecord` decides what it is.
 */
function candidatesOf(root: string, session: string): { seat: string; path: string }[] {
  const dir = join(root, '.agents', 'send-drops', session);
  if (!isDir(dir)) return [];
  let seats: string[];
  try {
    seats = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: { seat: string; path: string }[] = [];
  for (const seat of seats) {
    if (!NAME.test(seat)) continue;
    const seatDir = join(dir, seat);
    if (!isDir(seatDir)) continue;
    let names: string[];
    try {
      names = readdirSync(seatDir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!NAME.test(name) || isMarkerName(name) || name.startsWith('work-')) continue;
      const path = join(seatDir, name);
      if (isFile(path)) out.push({ seat, path });
    }
  }
  return out;
}

/** Whether the store an earlier build wrote holds this id for any seat of the checkout. */
export function legacyHolds(root: string, id: string): boolean {
  const dir = join(root, '.agents', 'messages');
  if (!isDir(dir)) return false;
  let seats: string[];
  try {
    seats = readdirSync(dir);
  } catch {
    return false;
  }
  return seats.some((seat) => NAME.test(seat) && isFile(join(dir, seat, `${id}.json`)));
}

/** The candidate files named exactly `id` in this session's tree: what a lookup has to weigh,
 *  before any key is read. A name no record can take is not one of them. */
export function recordHits(root: string, session: string, id: string): { seat: string; path: string }[] {
  return candidatesOf(root, session).filter((candidate) => basename(candidate.path) === id);
}

/**
 * The record the id names, as this checkout's caller may answer it. A file at the id that is not
 * a record, or a record that does not verify, is refused: the id names a message this build
 * cannot trust. A record addressed to another seat, or one sitting outside its own addressee's
 * folder, is refused for the same reason `team messages` shows it as a difference — a copy is
 * not the message.
 */
export function findRecord(hits: { seat: string; path: string }[], root: string, session: string, id: string, me: string, key: KeyObject): Lookup {
  const verified: Found[] = [];
  for (const hit of hits) {
    const read = readRecord(hit.path, id);
    if (!read.ok) return { kind: 'refused', why: `record ${id} cannot be read: ${read.reason}` };
    if (read.record === null) continue;
    if (!verifyRecord(read.record, key)) {
      return { kind: 'refused', why: `record ${id} does not verify against this message key` };
    }
    verified.push({ seat: hit.seat, path: hit.path, record: read.record });
  }
  if (verified.length === 0) return legacyHolds(root, id) ? { kind: 'legacy' } : { kind: 'none' };
  const mine = verified.filter((found) => found.record.payload.to === me);
  if (mine.length === 0) {
    return { kind: 'refused', why: `record ${id} is addressed to ${verified[0]?.record.payload.to ?? 'nobody'}, not to ${me}` };
  }
  const seated = mine.filter((found) => samePath(recordDir(root, session, me), dirname(found.path)));
  if (seated.length === 0) {
    return { kind: 'refused', why: `record ${id} is addressed to ${me}, and it waits in another seat's folder` };
  }
  if (seated.length > 1) return { kind: 'refused', why: `two records hold the id ${id}` };
  const found = seated[0] as Found;
  return { kind: 'found', found };
}

/**
 * Whether the thread is open, from the records on it and the closes beside them: an exchange
 * nobody closed, whose newest record is younger than the shipping `thread-ttl`, with fewer than
 * `thread-cap` records on it. A close outranks the clock, and the clock outranks the cap, so the
 * reason is the first fact that ended the thread. A record or close that does not verify changes
 * nothing, exactly as it changes no status.
 */
function threadStateOf(
  root: string,
  session: string,
  thread: string,
  key: KeyObject,
  now: Date,
  thresholds: Pick<EventThresholds, 'thread_ttl_seconds' | 'thread_cap'>,
  /** Records on the thread that live outside the seat folders — the verified replies in a
   *  client's inbox. The seat path passes none and reads exactly as before. */
  extra: readonly { at: string }[] = [],
): ThreadState {
  let count = 0;
  let latest = 0;
  let closed = false;
  for (const candidate of candidatesOf(root, session)) {
    const read = readRecord(candidate.path);
    if (!read.ok || read.record === null) continue;
    const payload = read.record.payload;
    if (payload.thread !== thread) continue;
    if (payload.session !== session || !samePath(payload.root, root)) continue;
    if (!verifyRecord(read.record, key)) continue;
    count += 1;
    const at = Date.parse(payload.at);
    if (Number.isFinite(at) && at > latest) latest = at;
    const readCloseSidecar = readClose(closeFile(dirname(candidate.path), payload.id), payload.id);
    if (!readCloseSidecar.ok || readCloseSidecar.close === null) continue;
    const close = readCloseSidecar.close;
    if (close.payload.thread !== thread) continue;
    if (close.payload.session !== session || !samePath(close.payload.root, root)) continue;
    if (verifyClose(close, key)) closed = true;
  }
  for (const record of extra) {
    count += 1;
    const at = Date.parse(record.at);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  if (closed) return { open: false, reason: 'close' };
  if (latest > 0 && now.getTime() - latest >= thresholds.thread_ttl_seconds * 1_000) {
    return { open: false, reason: 'ttl' };
  }
  if (count >= thresholds.thread_cap) return { open: false, reason: 'cap' };
  return { open: true, reason: null };
}

/** Why a thread that is not open cannot be closed, in the thread's own terms. */
function closedWords(
  thread: string,
  reason: NonNullable<ThreadState['reason']>,
  thresholds: Pick<EventThresholds, 'thread_ttl_seconds' | 'thread_cap'>,
): string {
  if (reason === 'ttl') {
    return `the thread ${thread} ended: no record on it for ${sayThreshold(thresholds.thread_ttl_seconds)}`;
  }
  if (reason === 'cap') return `the thread ${thread} ended at its ${String(thresholds.thread_cap)}-record cap`;
  return `the thread ${thread} is already closed`;
}

/** One refusal, under `reply.refused`. Exit 1, always. */
function refused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reply', { id: 'reply.refused', message, repair: null });
  return 1; // exit: reply.refused
}

/** A refusal on a thread an external client opened: its own id, so a seat and a client thread
 *  never read as the same refusal. Exit 1, always. */
function clientRefused(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reply', { id: 'reply.client-refused', message, repair: null });
  return 1; // exit: reply.client-refused
}

/** A team file this run cannot read: nothing is wrong with the pair, the run can't start.
 *  Exit 2, always. */
function configuration(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reply', { id: 'reply.configuration', message, repair: null });
  return 2; // exit: reply.configuration
}

/** The invocation cannot be read. Exit 2, always. */
function usage(io: Io, json: boolean, message: string): number {
  refuse(io, json, 'reply', { id: 'reply.usage', message, repair: null, usage: USAGE });
  return 2; // exit: reply.usage
}

/** The one written answer: the `team.reply` document under `--json`, the context line and the one
 *  line otherwise. `reply.replied` is this command's only written outcome, close and reply both:
 *  exit 0, always, from this one site. */
function written(io: Io, json: boolean, doc: Record<string, unknown>, line: string): number {
  if (json) writeJson(io, 'team.reply', doc);
  else io.stdout(line);
  return 0; // exit: reply.replied
}

/** The seats a file declares, in its own order, for a refusal naming them. */
function seatList(team: TeamFile): string {
  return team.seats.map((seat) => seat.name).join(', ');
}

/** Raises the owner's `security.refused` for a denied identity or admission: the rule, the
 *  caller's seat, the seat it addressed and the folder the call stood in — never the message. */
export function raiseSecurityRefusal(
  team: TeamFile,
  root: string,
  home: string,
  dir: string,
  caller: Caller,
  rule: 'placement' | 'admission',
  target: string | null,
  now: Date,
): void {
  raiseRefusalEvent({
    project: team.project,
    root,
    home,
    session: team.session,
    kind: 'security.refused',
    rule,
    object: {
      ...(target === null ? {} : { id: target }),
      ...(caller.kind === 'seat' ? { seat: caller.name } : caller.kind === 'owner' ? { seat: 'owner' } : {}),
      path: dir,
    },
    now,
  });
}

export async function runReply(argv: string[], io: Io, host: ReplyHost): Promise<number> {
  // Raw argv, before the parser: `--nope --json` must still answer with the structured document.
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, [], ['close', 'json']);
  if (args.error) return usage(io, json, args.error);
  const id = args.rest[0];
  const close = args.flags.has('close');
  if (id === undefined) return usage(io, json, '<id> is required');
  if (!recordNameOk(id)) return usage(io, json, `"${id}" is not a record id`);
  if (close && args.rest.length > 1) return usage(io, json, '--close takes no text');
  const text = args.rest.slice(1).join(' ');
  if (!close && text.trim() === '') return usage(io, json, 'a reply text is required');

  const caller = callerOf(io);
  const detached = detachedRefusal(caller, { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' });
  if (detached !== undefined) return refused(io, json, detached);
  if (caller.kind !== 'owner' && caller.kind !== 'seat') {
    return refused(io, json, `only the owner or a seat of this team replies; this call is ${describeCaller(caller)}`);
  }

  const loaded = loadTeamFile(io.cwd, { home: host.home });
  if (!loaded.ok) {
    const message = loaded.errors.map((problem) => (problem.line ? `line ${problem.line}: ${problem.message}` : problem.message)).join('; ');
    return configuration(io, json, message || 'the team file cannot be read');
  }
  const { team, root } = loaded;
  const dir = dirname(loaded.path);
  const session = team.session;
  const fileTeamId = teamIdOf(root);
  const judged = judgeCallerIn(io, dir, team);
  const who = logTag(judged.caller);
  const standing = standingOf(dir, judged.session, judged.caller);
  // The pane and pair checks below judge the caller placed in the session judged — the file's own,
  // or the state session this caller stands in — never the sessionless reading the pre-file gate
  // keeps. `placeCaller` records the session it was asked about, and `callerVerdict` and the
  // admission's placement check both refuse a seat that carries none: the same reading `team send`
  // judges, so a seat replying from its own pane is that seat and not "a caller of another
  // session". A caller a test hands in is itself; its session is the one the scenes pin.
  const placed = judged.caller;
  const me = placed.kind === 'seat' ? placed.name : caller.kind === 'seat' ? caller.name : 'owner';

  // The id is looked up before the key is read: a name nothing holds needs no key to say so, and
  // a machine that never sent or read a record still gets the honest refusal rather than a
  // message-key complaint about a lookup that had nothing to verify.
  const hits = recordHits(root, session, id);
  if (hits.length === 0) {
    if (legacyHolds(root, id)) {
      return refused(io, json, `the message ${id} was written by an earlier build and has no thread; it is read, not answered`);
    }
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }

  const keyState = messageKeyState(host.home);
  if (keyState.kind !== 'key') return refused(io, json, 'no message key; nothing was written');
  const key = keyState.key;

  const lookup = findRecord(hits, root, session, id, me, key);
  if (lookup.kind === 'none') {
    return refused(io, json, `no record named ${id} waits in this project's session "${session}"`);
  }
  if (lookup.kind === 'legacy') {
    return refused(io, json, `the message ${id} was written by an earlier build and has no thread; it is read, not answered`);
  }
  if (lookup.kind === 'refused') return refused(io, json, lookup.why);
  const found = lookup.found;
  const answered = found.record.payload;

  // A record a client wrote is answered under the client thread's own id in every refusal; the
  // binding checks below are the first place the two paths differ, so they pick their id here.
  const clientThread = answered.from_client !== undefined;
  if (answered.session !== session) {
    const why = `record ${id} is bound to session "${answered.session}", not to "${session}"`;
    return clientThread ? clientRefused(io, json, why) : refused(io, json, why);
  }
  if (!samePath(answered.root, root)) {
    const why = `record ${id} is bound to another checkout`;
    return clientThread ? clientRefused(io, json, why) : refused(io, json, why);
  }

  // The thread's life and cap are the owner's event thresholds, read from the caller's own chain:
  // the seat placing this call may carry a shorter word than the team. A chain that will not
  // load is the configuration refusal (`reply.configuration`), never a guess at the defaults.
  const seatName = placed.kind === 'seat' ? placed.name : null;
  const seat = seatName === null ? null : (team.seats.find((entry) => entry.name === seatName) ?? null);
  const agentId = seatName === null ? null : (findAgent(host.home, { team: teamIdOf(root), seat: seatName })?.id ?? null);
  const thresholds = eventThresholdsInForce({
    home: host.home,
    entity: team.entity,
    projectId: projectIdOfTeam(host.home, team, root),
    root,
    team,
    agentId,
    seat,
    now: host.now(),
    upToLevel: seatName === null ? 'team' : 'seat',
  });
  if (!thresholds.ok) {
    return configuration(
      io,
      json,
      thresholds.refusals.map((refusal) => refusal.message).join('; ') || 'the event thresholds cannot be read',
    );
  }

  const state = threadStateOf(root, session, answered.thread, key, host.now(), thresholds.thresholds);
  const at = host.now().toISOString();
  const startedAt = host.now().getTime();

  if (close) {
    // Closing is the addressee's own act on its own thread: the standing check every write into
    // a seat's folder asks, and nothing else — no admission, since no message is written.
    if (caller.kind === 'seat' && (placed.kind !== 'seat' || callerVerdict(placed, me, standing).kind !== 'ok')) {
      raiseSecurityRefusal(team, root, host.home, dir, placed, 'placement', null, host.now());
      return refused(io, json, `seat ${me} is not this call on its own pane and session; this call is ${describeCaller(placed)}`);
    }
    if (state.reason !== null) {
      return refused(io, json, `${closedWords(answered.thread, state.reason, thresholds.thresholds)}; nothing was written`);
    }
    const closePayload: ClosePayload = { kind: 'thread-close', id: answered.id, thread: answered.thread, by: me, root, session, at };
    const lockSeat = me;
    const lock = acquireSeatLock(dir, session, lockSeat);
    if (!('release' in lock)) {
      return refused(io, json, `${lockSeat}: another command holds it (pid ${String(lock.held)}); nothing was written`);
    }
    try {
      try {
        sealDropTree(dir, session, lockSeat);
      } catch {
        return refused(io, json, `${lockSeat}: the close could not be written; nothing was written`);
      }
      let signed;
      try {
        signed = signClose(closePayload, host.home);
      } catch {
        return refused(io, json, 'no message key; nothing was written');
      }
      const written = writeClose(recordDir(root, session, lockSeat), signed);
      if (!written.ok) return refused(io, json, `${lockSeat}: the close could not be written (${written.reason}); nothing was written`);
      // A file already at the close's name was not written by this call, and it did not verify:
      // `threadStateOf` reads a verified close, so the thread is still open. Say so instead of
      // printing a close this run did not make.
      if (written.existing === true) return refused(io, json, `${lockSeat}: another close already holds that name and does not verify; nothing was written`);
    } finally {
      lock.release();
    }
    const summary = `${answered.thread}: closed`;
    logLine(dir, 'reply', who, summary, host.now());
    return written(io, json, {
      format: 1,
      status: 'closed',
      action_summary: summary,
      project: team.project,
      session,
      record: null,
      thread: answered.thread,
      in_reply_to: answered.id,
      to: null,
      rule: null,
      reply: null,
      at,
    }, `${contextLine(team.project, session)}\n${summary}\n`);
  }

  // ---- a thread an external client opened ------------------------------------------------
  //
  // The answered record carries `from_client`: the pair is seat -> client, admitted by the
  // thread's originating grant itself. No seat admission rule is consulted, no other grant is
  // scanned for, and a later grant never reauthorizes an old thread. The writer is exactly the
  // recipient seat and agent the origin grant signs, on an open thread, under the grant lock;
  // the reply lands in that client's own inbox and nowhere else. The grant must carry the
  // `messages` op, which only the owner gives at issuance (`--inbox`): a seat cannot widen a
  // send-only grant into a conversation, and a client cannot either.
  if (answered.from_client !== undefined) {
    if (caller.kind !== 'seat') {
      return clientRefused(io, json, `a client thread is answered by its recipient seat, not by ${describeCaller(caller)}; nothing was written`);
    }
    if (placed.kind !== 'seat' || callerVerdict(placed, me, standing).kind !== 'ok') {
      raiseSecurityRefusal(team, root, host.home, dir, placed, 'placement', null, host.now());
      return clientRefused(io, json, `seat ${me} is not this call on its own pane and session; this call is ${describeCaller(placed)}`);
    }
    const origin = readClientGrant(host.home, answered.from_client.grant_id);
    if (!origin.ok) {
      return clientRefused(io, json, `the thread's originating grant ${answered.from_client.grant_id} does not verify in the canonical store: ${origin.why}; nothing was written`);
    }
    const grant = origin.grant;
    if (grant.clientId !== answered.from_client.client_id) {
      return clientRefused(io, json, `this thread names client "${answered.from_client.client_id}" and its grant names "${grant.clientId}"; nothing was written`);
    }
    const admitted = clientAdmission(host.home, grant.clientId, grant.entity);
    if (!admitted.ok) return clientRefused(io, json, `${admitted.why}; nothing was written`);
    if (!grant.allowedOps.includes('send') || !grant.allowedOps.includes('messages')) {
      return clientRefused(
        io,
        json,
        `the thread's grant ${grant.grantId} is send-only; only a grant with send and messages opens a client thread a seat may answer. The owner issues a grant with --inbox, and the client starts a new thread; nothing was written`,
      );
    }
    if (answered.thread !== answered.id) {
      return clientRefused(io, json, `record ${id} answers another record; a client thread is the client's own opening record, and only it is answered; nothing was written`);
    }
    if (answered.to_id === null) {
      return clientRefused(io, json, `record ${id} carries no to_id; the recipient the grant signs cannot be matched to it; nothing was written`);
    }
    const resolved = resolveEntityCoordinator(host.home, grant.entity, {
      seat: grant.recipientSeat,
      clientId: grant.clientId,
      ...(grant.team !== undefined ? { team: grant.team } : {}),
    });
    if (!resolved.ok) {
      return clientRefused(io, json, `the grant's recipient cannot be resolved: ${resolved.why}; nothing was written`);
    }
    const coordinator = resolved.coordinator;
    if (coordinator.teamId !== grant.teamId || coordinator.recipientSeat !== grant.recipientSeat || coordinator.recipientId !== grant.recipientId) {
      return clientRefused(io, json, `the registry no longer names the team and recipient the grant ${grant.grantId} signs; a changed binding makes the thread unanswerable; nothing was written`);
    }
    if (!samePath(coordinator.teamRoot, root) || coordinator.session !== session) {
      return clientRefused(io, json, `the grant's recipient lives in another checkout or session than this record; a changed binding makes the thread unanswerable; nothing was written`);
    }
    if (answered.to !== grant.recipientSeat || answered.to_id !== grant.recipientId) {
      raiseSecurityRefusal(team, root, host.home, dir, placed, 'admission', `client:${grant.clientId}`, host.now());
      return clientRefused(io, json, `record ${id} is addressed to "${answered.to}" (${answered.to_id}), not to the recipient the grant signs, "${grant.recipientSeat}" (${grant.recipientId}); nothing was written`);
    }
    if (me !== grant.recipientSeat) {
      raiseSecurityRefusal(team, root, host.home, dir, placed, 'admission', `client:${grant.clientId}`, host.now());
      return clientRefused(io, json, `seat ${me} is not the recipient of the client thread; only ${grant.recipientSeat} answers it; nothing was written`);
    }
    const agent = findAgent(host.home, { team: coordinator.teamId, seat: me });
    if (agent === null || agent.id !== grant.recipientId) {
      return clientRefused(io, json, `seat ${me} has no registered agent record in team ${coordinator.teamId} naming ${grant.recipientId}; a reply never claims an identity it does not have; nothing was written`);
    }
    // The thread's life counts the verified replies already in the client inbox too.
    const inbox = ensureClientInbox(root, session, grant.clientId);
    if (!inbox.ok) return clientRefused(io, json, `the client inbox cannot be used: ${inbox.why}; nothing was written`);
    const scanned = scanClientInbox({ home: host.home, root, session, clientId: grant.clientId, key });
    if (!scanned.ok) return clientRefused(io, json, `${scanned.why}; nothing was written`);
    const onThread = scanned.scan.shown.filter((reply) => reply.thread === answered.id).map((reply) => ({ at: reply.at }));
    const threadNow = threadStateOf(root, session, answered.id, key, host.now(), thresholds.thresholds, onThread);
    if (!threadNow.open) {
      return clientRefused(io, json, `${closedWords(answered.id, threadNow.reason ?? 'close', thresholds.thresholds)}; a client thread is answered only while it is open, never reopened; nothing was written`);
    }

    const replyId = host.newId?.() ?? randomUUID();
    const naming = namingFor({ home: host.home, root, viewerTeam: coordinator.teamId, seat: me, file: team });
    const body = `${senderHeader(agent, CLIENT_REPLY_RULE, naming)}\n${text}`;
    const payload: RecordPayload = {
      kind: 'message',
      id: replyId,
      to: `client:${grant.clientId}`,
      to_id: null,
      root,
      session,
      at,
      body,
      from: me,
      from_id: grant.recipientId,
      rule: CLIENT_REPLY_RULE,
      thread: answered.id,
      in_reply_to: answered.id,
      to_client: { client_id: grant.clientId, grant_id: grant.grantId },
    };
    type Locked = { ok: true } | { ok: false; why: string };
    let locked: Locked;
    try {
      // Lock order is grant lock -> seat lock, the only direction any path takes.
      locked = withClientGrantLock(host.home, (): Locked => {
        const active = activeClientGrant(host.home, { grant, signature: origin.signature }, host.now());
        if (!active.ok) return { ok: false, why: `the originating grant ${grant.grantId} is not active: ${active.why}; nothing was written` };
        const seatLock = acquireSeatLock(dir, session, me);
        if (!('release' in seatLock)) return { ok: false, why: `${me}: another command holds it (pid ${String(seatLock.held)}); nothing was written` };
        try {
          sealDropTree(dir, session, me);
          // Both publication locks are held here. The thread facts and the registry binding were
          // read before the waits; a close, a TTL boundary, a cap or a rebinding that landed while
          // this call waited must be seen now, in the section that publishes, and must refuse.
          const freshInbox = ensureClientInbox(root, session, grant.clientId);
          if (!freshInbox.ok) return { ok: false, why: `the client inbox cannot be used: ${freshInbox.why}; nothing was written` };
          const freshScan = scanClientInbox({ home: host.home, root, session, clientId: grant.clientId, key });
          if (!freshScan.ok) return { ok: false, why: `${freshScan.why}; nothing was written` };
          const freshOnThread = freshScan.scan.shown
            .filter((reply) => reply.thread === answered.id)
            .map((reply) => ({ at: reply.at }));
          const freshState = threadStateOf(root, session, answered.id, key, host.now(), thresholds.thresholds, freshOnThread);
          if (!freshState.open) {
            return {
              ok: false,
              why: `${closedWords(answered.id, freshState.reason ?? 'close', thresholds.thresholds)}; a client thread is answered only while it is open, never reopened; nothing was written`,
            };
          }
          const freshResolved = resolveEntityCoordinator(host.home, grant.entity, {
            seat: grant.recipientSeat,
            clientId: grant.clientId,
            ...(grant.team !== undefined ? { team: grant.team } : {}),
          });
          if (!freshResolved.ok) {
            return { ok: false, why: `the grant's recipient cannot be resolved: ${freshResolved.why}; nothing was written` };
          }
          const freshCoordinator = freshResolved.coordinator;
          if (
            freshCoordinator.teamId !== grant.teamId ||
            freshCoordinator.recipientSeat !== grant.recipientSeat ||
            freshCoordinator.recipientId !== grant.recipientId
          ) {
            return {
              ok: false,
              why: `the registry no longer names the team and recipient the grant ${grant.grantId} signs; a changed binding makes the thread unanswerable; nothing was written`,
            };
          }
          if (!samePath(freshCoordinator.teamRoot, root) || freshCoordinator.session !== session) {
            return {
              ok: false,
              why: `the grant's recipient lives in another checkout or session than this record; a changed binding makes the thread unanswerable; nothing was written`,
            };
          }
          const freshAgent = findAgent(host.home, { team: freshCoordinator.teamId, seat: me });
          if (freshAgent === null || freshAgent.id !== grant.recipientId) {
            return {
              ok: false,
              why: `seat ${me} has no registered agent record in team ${freshCoordinator.teamId} naming ${grant.recipientId}; a reply never claims an identity it does not have; nothing was written`,
            };
          }
          const signed = signRecord(payload, host.home);
          const wrote = writeClientInboxFile(freshInbox.dir, replyId, `${JSON.stringify(signed, null, 2)}\n`);
          if (wrote === 'exists') return { ok: false, why: `client ${grant.clientId}: a record already holds the id ${replyId}; nothing was written` };
          if (wrote !== 'written') return { ok: false, why: 'the record could not be written; nothing was written' };
          // The answered record moves to `replied`: a seat-side receipt beside the client's
          // opening record, as every reply's is.
          const receipt = signReceiptPayload({ kind: 'receipt', status: 'replied', id: answered.id, to: me, root, session, at }, host.home);
          writeReceipt(recordDir(root, session, me), receipt, host.home);
          return { ok: true };
        } catch {
          return { ok: false, why: 'the record could not be written; nothing was written' };
        } finally {
          seatLock.release();
        }
      });
    } catch (error) {
      return clientRefused(io, json, error instanceof Error ? `${error.message}; nothing was written` : 'the client grant lock could not be taken; nothing was written');
    }
    if (!locked.ok) return clientRefused(io, json, locked.why);
    const summary = `client:${grant.clientId}: replied`;
    logLine(dir, 'reply', who, summary, host.now());
    return written(io, json, {
      format: 1,
      status: 'replied',
      action_summary: summary,
      project: team.project,
      session,
      record: replyId,
      thread: answered.id,
      in_reply_to: answered.id,
      to: `client:${grant.clientId}`,
      rule: CLIENT_REPLY_RULE,
      reply: text,
      at,
    }, `${contextLine(team.project, session)}\n${summary}\n`);
  }

  // The reply goes back to the sender of the record it answers. A seat sender must still be
  // declared by this file: a seat removed from the file is not reached by a reply either. A
  // record the owner sent has no seat of this file to answer it: its reply goes to the entity's
  // declared `owner-reply-to` endpoint — the address the owner-origin frame names — resolved
  // through the registry, across teams.
  let targetSeat: string;
  let endpoint: Target | null = null;
  if (answered.from === 'owner') {
    const replyTo = resolveOwnerReplyTo(root, host.home, team.entity, host.now());
    if (!replyTo.ok) {
      return refused(io, json, `record ${id} was sent by the owner, and the owner's reply endpoint is ${replyTo.reason} (${replyTo.why}); nothing was written`);
    }
    const resolved = resolveTarget(host.home, replyTo.target, io);
    if ('error' in resolved) {
      return refused(io, json, `record ${id} was sent by the owner, and the owner's reply endpoint ${replyTo.target} cannot be resolved: ${resolved.error}; nothing was written`);
    }
    endpoint = resolved;
    targetSeat = resolved.agent.reach.seat;
  } else {
    targetSeat = answered.from;
    if (!team.seats.some((seat) => seat.name === targetSeat)) {
      raiseSecurityRefusal(team, root, host.home, dir, placed, 'admission', targetSeat, host.now());
      return refused(io, json, `${targetSeat}: it is not a declared seat; the file's seats are ${seatList(team)}; nothing was written`);
    }
  }

  // The pair is judged as a send's, with `open-thread` in the context: the thread the reply is
  // written onto is open by construction — the answered thread while it is open, and otherwise
  // the new one this reply opens and cites (§3.5). The seat rules admit the ordinary pairs
  // first — two seats of one team, and two seats of one entity's teams — so the reply rule
  // admits what no other rule pairs: two seats of different entities. A send never carries the
  // context.
  const admission = admissionOf(placed, team, endpoint, targetSeat, host.home, fileTeamId, () => host.now(), standing, 'open-thread');
  if (!admission.ok) {
    raiseSecurityRefusal(team, root, host.home, dir, placed, 'admission', targetSeat, host.now());
    return refused(io, json, `refused: ${admission.why}`);
  }

  const replyId = host.newId?.() ?? randomUUID();
  const thread = state.open ? answered.thread : replyId;
  // The receiving side of this reply: the answered seat's own team, or the owner endpoint's seat
  // in its team. The headline reads that side's word on how a sender reads — the same line a send
  // would write into that seat's folder.
  const toRoot = endpoint === null ? root : endpoint.team.root;
  const toSession = endpoint === null ? session : endpoint.agent.reach.session;
  const toDir = endpoint === null ? dir : join(endpoint.team.root, '.agents');
  const toId = endpoint === null ? answered.from_id : endpoint.agent.id;
  const naming = namingFor({
    home: host.home,
    root: toRoot,
    viewerTeam: endpoint === null ? teamIdOf(root) : endpoint.agent.reach.team,
    seat: targetSeat,
    ...(endpoint === null ? { file: team } : {}),
  });
  const body = `${senderHeader(admission.sender, admission.rule, naming)}\n${text}`;
  const payload: RecordPayload = {
    kind: 'message',
    id: replyId,
    to: targetSeat,
    to_id: toId,
    root: toRoot,
    session: toSession,
    at,
    body,
    from: me,
    from_id: senderIdOf(admission),
    rule: admission.rule,
    thread,
    in_reply_to: answered.id,
  };

  const lock = acquireSeatLock(toDir, toSession, targetSeat);
  if (!('release' in lock)) {
    return refused(io, json, `${targetSeat}: another command holds it (pid ${String(lock.held)}); nothing was written`);
  }
  try {
    try {
      sealDropTree(toDir, toSession, targetSeat);
    } catch {
      return refused(io, json, `${targetSeat}: the record could not be written; nothing was written`);
    }
    let signed: SignedRecord;
    try {
      signed = signRecord(payload, host.home);
    } catch {
      return refused(io, json, 'no message key; nothing was written');
    }
    const written = writeRecord(recordDir(toRoot, toSession, targetSeat), signed);
    if (!written.ok) return refused(io, json, `${targetSeat}: the record could not be written (${written.reason}); nothing was written`);
    // The answered record moves to `replied` — a receipt the receiving side writes, beside the
    // message it answers. The reply record is the message; a receipt that cannot be written is
    // an annotation missing, not a reply lost, so it changes no exit.
    const receipt = signReceiptPayload({ kind: 'receipt', status: 'replied', id: answered.id, to: me, root, session, at }, host.home);
    writeReceipt(recordDir(root, session, me), receipt, host.home);
  } finally {
    lock.release();
  }
  logLine(dir, 'reply', who, `${targetSeat}: replied`, host.now());
  // The history line belongs to the team the record was written into: the answer's own team, which
  // is the owner endpoint's team when the owner asked.
  appendHistory(endpoint === null ? team.project : endpoint.team.project, toRoot, host.home, {
    ts: at,
    from: me,
    to: targetSeat,
    // The team the replying seat stands in: a reader of this history resolves the sender the way
    // the record does, never by a local seat name it happens to share.
    from_team: teamIdOf(root),
    body,
    id: replyId,
    thread,
    in_reply_to: answered.id,
    outcome: 'delivered',
    ms: host.now().getTime() - startedAt,
    via: 'drop',
  });

  const summary = `${targetSeat}: replied`;
  return written(io, json, {
    format: 1,
    status: 'replied',
    action_summary: summary,
    project: team.project,
    session,
    record: replyId,
    thread,
    in_reply_to: answered.id,
    to: targetSeat,
    rule: admission.rule,
    reply: text,
    at,
  }, `${contextLine(team.project, session)}\n${summary}\n`);
}
