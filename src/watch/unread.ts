// Waking an idle seat whose message is still unread, and telling the sender and the lead.
//
// A delivery is a deposit until the seat's signed read receipt follows: a trigger can leave the
// box with no sign the seat acted on it, and a drop can sit in a folder no watcher reads. The
// send's own window proves only what it saw while it waited; the watch is the reader that keeps
// looking. Its unread pass counts from `watch.unread_after` (N): a message still without a
// receipt N after it landed gets one wake — the seat's own drop read typed into its pane — and a
// message still unread at twice that window is reported to its sender's own mailbox and to the
// team's lead. The sender's record is per message; the lead gets one signed drop per pass,
// listing every message due in it (`team drops --read` serves it), never a keystroke into
// another seat's pane. The drop's id is fixed by the sorted set of messages it lists, so a repeat
// pass — even one whose markers were lost — finds the standing record instead of writing a
// second. The sender's own mailbox is the one its signed agent id resolves to through this
// home's agent and team registries — a teammate in another checkout is written in that team's
// root and session — and a sender those registries cannot pin to one team, seat and session is
// reported to the lead alone, with the missing metadata said.
//
// The wake is the typed leg's own delivery, with the rules that leg already has: a human seat's
// pane is never typed into, a dialog or a box holding unsent text is not typed blind, the seat
// lock is taken, and a pane back at its shell is left alone. A message a held send's retry owns
// (a `.pending` marker) is not woken here: that pass types it, and a second trigger from this
// one would be one too many. Nothing here claims more than it saw: a typed wake is `sent
// (unconfirmed)` until a receipt verifies, and only a verified receipt is `delivered (read)`.
//
// The markers are reservations made before their effect, never reminders written after it:
// `<id>.wake` is linked into place exclusively before a line is typed, and `<id>.reported` before
// a mailbox record is written. A reservation already there belongs to an earlier attempt whose
// effect is unknown — a crash after Enter leaves no other trace — and is spent: it is never typed
// over and never reported over. A delivery the seam itself says took nothing (`held`,
// `not-submitted`) gives its reservation back so a later pass may still wake; one it could not
// reach (`unreachable`) gives nothing back, because an uncertain attempt is not repeated.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  realpathSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { OWNER_MAILBOX, writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { claimBindingIn, listUnread, receiptHeld } from '../mcp/inbox.ts';
import { AGENT_ID_PATTERN, getAgent } from '../registry/agents.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';
import { isBareShellPane } from '../send/daemon.ts';
import { deliverTrigger, draftNote, TRIGGER_TAKEN_NOTE, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { dropMessage, readTriggerLine } from '../send/native.ts';
import { pendingDropPath } from '../send/pending.ts';
import { readRecord, signRecord, verifyRecord, type RecordPayload, type StatusContext } from '../send/record.ts';
import { markTaken } from '../send/taken.ts';
import { wakeTrigger } from '../send/wake.ts';
import { messageKeyState } from '../store/keys.ts';
import type { RetryScene } from './retry.ts';
import { readScreen } from './screen.ts';

/** The marker beside a message whose one wake line was typed. */
export function wakePath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.wake`);
}

/** The marker beside a message whose sender and lead were told. */
export function reportedPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.reported`);
}

/** The two windows one pass reads: the wake is due at N, the report at twice that. */
export type UnreadWindow = { unreadAfter: number };

/** The wake is typing, so `--no-nudge` leaves it out; the report is a mailbox record and runs
 *  either way. */
export type UnreadOptions = UnreadWindow & { noNudge?: boolean };

/** Rewrites a reservation with what it was seen to become. This is a record update, never the
 *  reservation itself: the marker was linked into place before the effect, and a failed update
 *  leaves `reserved`, which is the truth at that point. */
function mark(dropDir: string, name: string, record: Record<string, unknown>): void {
  try {
    dropMessage(dropDir, name, `${JSON.stringify(record)}\n`);
  } catch {
    // The reservation stands; only the note about its outcome is missing.
  }
}

/**
 * Takes a marker name exclusively, before the effect it guards: the record is written whole, 0600,
 * to a temporary file and linked into place. `link` fails when the name exists, so exactly one
 * pass — or one crash's predecessor — owns the attempt. `true` means this call wrote the
 * reservation; `false` means someone else's is there (or the name could not be written at all),
 * and the caller must not perform the effect. The temporary file never shares a name with a
 * message: the scan reads UUID names only.
 */
function reserve(path: string, record: Record<string, unknown>): boolean {
  const dir = dirname(path);
  const temp = join(dir, `.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    linkSync(temp, path);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed; the error that ended the attempt is the answer.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Never written, or linked and unlinked above: nothing is left to remove.
    }
  }
}

/** Gives back a reservation this pass wrote, after a delivery the seam says took nothing. A
 *  reservation found on disk is never removed by a later pass. */
function release(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: nothing is claimed by its absence.
  }
}

type WakeMark = { at: string; state: 'reserved' | 'sent' | 'read' };

/** What the wake reservation says, when it can be read; null otherwise. A marker written before
 *  reservations existed carried no state and records a wake line that was sent. */
function wakeMarkOf(dropDir: string, id: string): WakeMark | null {
  try {
    const parsed = JSON.parse(readFileSync(wakePath(dropDir, id), 'utf8')) as { at?: unknown; state?: unknown };
    if (typeof parsed.at !== 'string') return null;
    const state = parsed.state === 'reserved' ? 'reserved' : parsed.state === 'read' ? 'read' : 'sent';
    return { at: parsed.at, state };
  } catch {
    return null;
  }
}

/** The message's signed payload, verified with the checkout's message key. A message that does
 *  not verify has no sender and no body this pass may audit, and a read would refuse it: nothing
 *  is woken or reported from it. */
function payloadOf(dropDir: string, id: string, home: string): RecordPayload | null {
  const key = messageKeyState(home);
  if (key.kind !== 'key') return null;
  const looked = readRecord(join(dropDir, id), id);
  if (!looked.ok || looked.record === null) return null;
  if (!verifyRecord(looked.record, key.key)) return null;
  return looked.record.payload;
}

/** The watch's sources as the delivery sees one pane. */
function hostOf(scene: RetryScene, pane: string): DeliverHost {
  return {
    typeText: (id, text) => scene.sources.typeText(id, text, scene.session),
    pressEnter: (id) => scene.sources.pressEnter(id, scene.session),
    status: (id) => scene.sources.status(id, scene.session),
    wait: (ms) => scene.sources.sleep(ms),
    readAnsi: (id) => scene.sources.screen(id, scene.session),
    ...(scene.sources.sendKey
      ? { sendKey: (id: string, key: string) => scene.sources.sendKey!(id, key, scene.session) }
      : {}),
  };
}

/**
 * Whether this message is the unread pass's to wake now. A message read has left the listing
 * already (`listUnread` omits a verified receipt); what remains is waited on:
 * - younger than the window: not yet;
 * - a `.pending` marker: the retry pass owns it, and a second trigger would be one too many;
 * - `.wake` or `.reported`: the one wake was sent, or the word has already gone out.
 */
function dueForWake(dropDir: string, message: { id: string; ts: string }, nowMs: number, window: UnreadWindow): boolean {
  const age = nowMs - Date.parse(message.ts);
  if (!(age >= window.unreadAfter * 1000)) return false;
  if (existsSync(pendingDropPath(dropDir, message.id))) return false;
  if (existsSync(wakePath(dropDir, message.id))) return false;
  return !existsSync(reportedPath(dropDir, message.id));
}

/**
 * Types one wake line into each idle seat whose oldest due message is still unread, and marks
 * every message due at that moment: the trigger is the seat's own drop read, which serves the
 * whole folder, so one line is the retry for all of them. A pane that cannot be read, a seat
 * whose status is not idle/done, a dialog or unsent text, a held lock, a pane back at its shell,
 * a human seat — each is left for a later pass or for the report, never typed blind. A wake that
 * was delivered is marked; one that was not spends nothing and is tried again while its messages
 * are inside the window.
 */
export async function wakeUnreadDrops(scene: RetryScene, options: UnreadOptions): Promise<void> {
  const home = scene.home;
  if (home === undefined) return;
  if (options.noNudge === true) return;
  const key = messageKeyState(home);
  if (key.kind !== 'key') return;
  // The receiving team's `message-display` template is the same for every seat this pass wakes.
  const nowMs = scene.now.getTime();
  for (const seat of scene.team.seats) {
    // A person's drop is read by a person, and nothing is typed into a human's pane.
    if (seat.human === true) continue;
    // A stopped seat keeps its unread messages until its next start; a stale pane sighting does
    // not turn a stopped roster entry into an invitation to wake it.
    if (seat.stopped === true) continue;
    // A held seat is not woken: its native presence proves a turn, a person wait, a session end,
    // or a projection this pass cannot trust. The message stays unread and the later report
    // still speaks; no reservation is taken and nothing is typed.
    if (scene.nativeHeld?.has(seat.name) === true) continue;
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    const context: StatusContext = { to: seat.name, root: scene.root, session: scene.session };
    const due = listUnread(dropDir, context, home).filter((message) => dueForWake(dropDir, message, nowMs, options));
    if (due.length === 0) continue;
    const agents = scene.live.agents.filter((agent) => agent.name === seat.name);
    const found = agents.length === 1 ? agents[0]?.pane : undefined;
    const pane = found === scene.ownPane ? undefined : found;
    if (pane === undefined) continue;
    const status = scene.sources.status(pane, scene.session);
    const screen = scene.sources.screen(pane, scene.session);
    // A box that cannot be read is not typed into. The delivery below reads it again; this is
    // only the pass's own look, so a dialog is never entered and a busy seat is not nudged.
    if (screen === null || (status !== 'idle' && status !== 'done')) continue;
    const kind = readScreen(seat.cli, screen).kind;
    if (kind !== 'idle' && kind !== 'unsent') continue;
    const lock = acquireSeatLock(scene.dir, scene.session, seat.name);
    if (!('release' in lock)) continue;
    try {
      if (isBareShellPane(scene.dir, scene.session, seat.name, scene.sources.processes?.(pane, scene.session) ?? null)) continue;
      // The oldest due message that verifies supplies the audit: the read the trigger names
      // serves the whole folder, and the history line says which message the wake was for. A
      // message that does not verify cannot be read, so it neither earns a wake nor spends one,
      // and a message whose wake is already reserved is a spent attempt of its own: it is not
      // woken again, and it does not stand in the way of the messages behind it.
      // A receipt that landed after the pass listed the folder is the read itself: the folder is
      // read again under the seat's lock, so an already-read message is not reminded.
      const unreadNow = new Set(listUnread(dropDir, context, home).map((one) => one.id));
      const wakeable = due.filter((one) => unreadNow.has(one.id) && !existsSync(wakePath(dropDir, one.id)));
      const audited = wakeable.map((message) => ({ message, payload: payloadOf(dropDir, message.id, home) }))
        .find((one) => one.payload !== null);
      if (audited === undefined || audited.payload === null) continue;
      // The wake's header names the sender the signed record carries, resolved through this
      // home's registries. A sender that cannot be pinned is not typed nameless: the message
      // stays unread, its reservations are never taken, and the report pass says why.
      const sender = wakeTrigger(audited.payload, home, { root: scene.root, session: scene.session, team: scene.team }, scene.now);
      if (sender === null) continue;
      const line = readTriggerLine(seat.name, scene.session, sender);
      if (line === null) continue;
      // The reservations go down before the line is typed. A crash after Enter can leave no other
      // trace, so the marker is what makes the wake single-writer: one that is already there is an
      // earlier attempt whose effect is unknown, and no second line is typed for it.
      const at = scene.now.toISOString();
      const reserved: string[] = [];
      const take = (id: string): boolean => {
        if (!reserve(wakePath(dropDir, id), { id, at, state: 'reserved' })) return false;
        reserved.push(id);
        return true;
      };
      if (!take(audited.message.id)) continue;
      for (const one of wakeable) {
        if (one.id !== audited.message.id) take(one.id);
      }
      const { message, payload } = audited;
      // A receipt for the seat's current brief counts only under that claim: the reading that
      // found this message unread applied the same binding, so a stale receipt of an earlier
      // delivery cannot become the wake's read here.
      const binding = claimBindingIn(scene.root, scene.session, seat.name, message.id);
      const receipt = (): boolean => receiptHeld(dropDir, message.id, context, home, binding);
      const result = await deliverTrigger(hostOf(scene, pane), pane, line, seat.cli, {
        submitHeld: true,
        dropPath: join(dropDir, message.id),
        receipt,
      });
      // `held` left the box as it was, and `not-submitted` left the trigger in it for the next
      // Enter: neither put a line the seat could act on, so their reservations go back and a later
      // pass inside the window may still wake. `unreachable` keeps them: the delivery may have
      // typed before it stopped, and an uncertain attempt is spent rather than repeated.
      if (result.outcome === 'held' || result.outcome === 'not-submitted') {
        for (const id of reserved) release(wakePath(dropDir, id));
        continue;
      }
      if (result.outcome !== 'delivered') continue;
      const draft = result.draft === undefined ? undefined : draftNote(result.draft);
      // The wake's trigger is the seat's own receipt-writing read: a receipt that landed inside
      // the window — or just after its last poll — is the read itself, never merely a take.
      const read = result.evidence === 'receipt' || receipt();
      if (read) {
        appendHistory(scene.team.project, scene.root, home, {
          ts: scene.now.toISOString(),
          from: payload.from,
          to: seat.name,
          body: payload.body,
          id: message.id,
          thread: payload.thread,
          outcome: 'delivered (read)',
          ...(draft === undefined ? {} : { note: draft }),
          via: 'typed',
        });
        scene.say(`${seat.name}: a message from ${payload.from} was unread and was read on the wake (receipt)`, false);
      } else {
        // A wake that took the line is a trigger sent, never a message read. The taken marker is
        // the same one a send writes, so the watch's later passes look for the sign this
        // window's poll missed.
        if (result.evidence === 'taken') {
          markTaken(dropDir, {
            id: message.id,
            from: payload.from,
            to: seat.name,
            body: payload.body,
            ts: scene.now.toISOString(),
            before: result.prior ?? 'unknown',
          });
        }
        const note = [TRIGGER_TAKEN_NOTE, draft].filter((one): one is string => one !== undefined).join('; ');
        appendHistory(scene.team.project, scene.root, home, {
          ts: scene.now.toISOString(),
          from: payload.from,
          to: seat.name,
          body: payload.body,
          id: message.id,
          thread: payload.thread,
          outcome: 'sent (unconfirmed)',
          note,
          via: 'typed',
        });
        scene.say(`${seat.name}: a message from ${payload.from} was unread and one wake line was sent (${note})`, false);
      }
      // One line served every message due at this instant, and every reservation this pass took
      // now records what was seen. Only the ones this pass took are touched: another pass's
      // reservation is its attempt to describe, not this one's. A crash before this line leaves
      // `reserved`, which is exactly what was known at that point.
      for (const id of reserved) {
        mark(dropDir, `${id}.wake`, {
          id,
          at,
          state: read ? 'read' : 'sent',
          ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
        });
      }
    } finally {
      lock.release();
    }
  }
}

/** One mailbox a report goes to: the checkout and session whose `team messages` reads it, and the
 *  seat name its folder holds. A foreign sender's mailbox lives in its own team's root and
 *  session; both teams on this home share the message key the record is signed with. */
type ReportTarget = { root: string; session: string; to: string; label: string };

/** The rule line the lead's signed report drop carries, and the mark that keeps that drop from
 *  being reported on again: a report is the pass's own product, not a message to report about. */
const LEAD_REPORT_RULE = "the team's unread-message report";

/** The lead drop's id for one report: a UUID shaped from the sorted source message ids it lists,
 *  so a repeat pass — even one whose `.reported` markers were lost — finds the standing record
 *  instead of writing a second report. A one-message report keeps the id earlier builds gave it.
 *  Version 8 and the RFC variant bits make it a valid UUID, not just a name that fits the
 *  reader's pattern. */
function reportDropId(messageIds: readonly string[]): string {
  const digest = createHash('sha256').update('unread-report');
  for (const id of [...new Set(messageIds)].sort()) digest.update(`\u0000${id}`);
  const bytes = [...digest.digest().subarray(0, 16)];
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A report addressed to this team's lead is a signed send-drop under an ordinary message id:
 *  `team drops --read` serves a lowercase UUID and writes its receipt. The `unread-<uuid>` name
 *  a build before 0.5.3 gave this drop is served by the same reader too, so residual reports from
 *  that build are handed over and receipted instead of being listed forever; a legacy mailbox
 *  record lives in a different store and never reaches this folder. One drop lists every message
 *  due in the pass, and its id is fixed by that set. */
function writeLeadReportDrop(
  target: ReportTarget,
  home: string,
  messageIds: readonly string[],
  text: string,
  at: string,
): { ok: true; path: string; id: string; existing?: true } | { ok: false; error: string } {
  const dropDir = join(target.root, '.agents', 'send-drops', target.session, target.to);
  const id = reportDropId(messageIds);
  const path = join(dropDir, id);
  if (existsSync(path)) return { ok: true, path, id, existing: true };
  let record: ReturnType<typeof signRecord>;
  try {
    record = signRecord({
      kind: 'message', id, to: target.to, to_id: null, root: sceneRoot(target.root), session: target.session,
      at, body: text, from: 'runtime', from_id: null, rule: LEAD_REPORT_RULE, thread: id,
    }, home);
    dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  return { ok: true, path, id };
}

function sceneRoot(root: string): string {
  // Registry roots and the watch's root are normally canonical; the signed record always binds
  // the same canonical checkout the inbox reader verifies.
  return realpathSync(root);
}

type ReportResolution = {
  targets: ReportTarget[];
  /** Why the sender's own mailbox could not be named; null when it was. The lead is still
   *  written, and this reason is said in the record and in the report line — never guessed
   *  around, and never replaced by a same-named local seat. */
  unresolved: string | null;
};

/**
 * The mailboxes one report goes to: the sender's own when the signed record's `from_id` resolves
 * through this home's registries to exactly one seat of one known team, and the team's lead. A
 * sender is never routed by name: the signed `from` alone could name a same-named seat here or in
 * another team, so a record without an agent id, or whose agent record, team record or roster
 * entry does not pin the same team, seat and session, is reported to the lead only, with the
 * missing metadata in the words. The identity is exact: the team record's own root must derive
 * the team id the agent names, and the roster must hold exactly one entry for that agent, exactly
 * one entry at that seat, and that entry must be the pair — a root whose identity is another team,
 * an agent listed at two seats, or a seat held by two agents, routes nothing.
 */
function reportTargets(scene: RetryScene, payload: RecordPayload, home: string): ReportResolution {
  const targets: ReportTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ReportTarget): void => {
    const key = `${target.root}\u0000${target.session}\u0000${target.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  const own = (to: string): ReportTarget => ({ root: scene.root, session: scene.session, to, label: to });
  let unresolved: string | null = null;

  if (payload.from === OWNER_MAILBOX && payload.from_id === null) {
    add(own(OWNER_MAILBOX));
  } else if (payload.from_id === null) {
    unresolved = `the signed record names no agent id for ${JSON.stringify(payload.from)}`;
  } else if (!AGENT_ID_PATTERN.test(payload.from_id)) {
    unresolved = `the signed record's from_id ${JSON.stringify(payload.from_id)} is not an agent id`;
  } else {
    const agent = getAgent(home, payload.from_id);
    if (agent === null || agent.lifecycle === 'retired') {
      unresolved = `agent ${payload.from_id} is not a live record in this home's registry`;
    } else if (agent.reach.seat !== payload.from) {
      unresolved = `agent ${payload.from_id} names seat ${JSON.stringify(agent.reach.seat)}, not ${JSON.stringify(payload.from)}`;
    } else if (agent.reach.team === teamIdOf(scene.root)) {
      // The sender is a seat of this very checkout: the record must name this session, and the
      // team file in force must declare the seat.
      if (agent.reach.session !== scene.session) {
        unresolved = `agent ${payload.from_id} is registered in session ${JSON.stringify(agent.reach.session)}, not ${JSON.stringify(scene.session)}`;
      } else if (!scene.team.seats.some((seat) => seat.name === payload.from)) {
        unresolved = `agent ${payload.from_id} is not a seat of this checkout's team`;
      } else {
        add(own(payload.from));
      }
    } else {
      try {
        const team = getTeam(home, agent.reach.team);
        if (team === null) {
          unresolved = `agent ${payload.from_id} names team ${JSON.stringify(agent.reach.team)}, which this home's registry does not hold`;
        } else if (team.root === '') {
          unresolved = `team ${JSON.stringify(agent.reach.team)} has no canonical root in this home's registry`;
        } else if (teamIdOf(team.root) !== agent.reach.team) {
          // The record is stored under one id and its root derives another: one of the two is
          // not the team the agent names, and an identity that does not agree with itself routes
          // nothing.
          unresolved = `team ${JSON.stringify(agent.reach.team)} records root ${JSON.stringify(team.root)}, whose own identity is ${JSON.stringify(teamIdOf(team.root))}`;
        } else if (!Object.hasOwn(team.lobbies, agent.reach.session)) {
          unresolved = `agent ${payload.from_id} names session ${JSON.stringify(agent.reach.session)}, which team ${JSON.stringify(agent.reach.team)} does not record`;
        } else {
          // An exact identity is one agent and one seat: the roster must hold one entry for this
          // agent and one entry at this seat, and the pair must be that same entry. A pair match
          // alone is not enough — an agent listed at two seats, or a seat held by two agents,
          // leaves the sender's identity ambiguous, and an ambiguous identity routes nothing.
          const pair = team.roster.filter((entry) => entry.agent === payload.from_id && entry.seat === payload.from);
          const seats = team.roster.filter((entry) => entry.agent === payload.from_id);
          const agents = team.roster.filter((entry) => entry.seat === payload.from);
          if (pair.length === 0) {
            unresolved = `team ${JSON.stringify(agent.reach.team)} does not list agent ${payload.from_id} at seat ${JSON.stringify(payload.from)}`;
          } else if (pair.length > 1) {
            unresolved = `team ${JSON.stringify(agent.reach.team)} lists ${String(pair.length)} roster entries for agent ${payload.from_id} at seat ${JSON.stringify(payload.from)}`;
          } else if (seats.length > 1) {
            unresolved = `team ${JSON.stringify(agent.reach.team)} lists ${String(seats.length)} seats for agent ${payload.from_id}; one agent must hold one seat`;
          } else if (agents.length > 1) {
            unresolved = `team ${JSON.stringify(agent.reach.team)} lists ${String(agents.length)} agents at seat ${JSON.stringify(payload.from)}; one seat must hold one agent`;
          } else {
            add({ root: team.root, session: agent.reach.session, to: payload.from, label: `${payload.from} of ${team.project}` });
          }
        }
      } catch (error) {
        // An unreadable registry is not a route: the lead is told, with the reason.
        unresolved = `the team registry could not be read: ${String(error)}`;
      }
    }
  }

  const lead = scene.team.orchestrator !== '' ? scene.team.orchestrator : scene.team.operator;
  if (lead !== '') add(own(lead));
  return { targets, unresolved };
}

/** One message due in this pass: what the sender's record says, and the sentence the lead's
 *  aggregate repeats for it. */
type DueReport = {
  seat: string;
  dropDir: string;
  id: string;
  payload: RecordPayload;
  senders: ReportTarget[];
  unresolved: string | null;
  minutes: number;
  text: string;
  /** Every mailbox the message is reported to, in words: its senders and the lead. */
  to: string[];
};

/**
 * Reports every message still unread at twice the window, once. The sender receives its own
 * Runtime mailbox record, one per message; the team's lead receives one signed send-drop per pass
 * listing every message due in it (`team drops --read` serves it). No pane is touched, which is
 * why a watch without nudges runs this too. The sender's mailbox is the one its signed `from_id`
 * resolves to through this home's registries; a sender they cannot pin is reported to the lead
 * only, and the reason is said there and in the line. The words keep the three wake states
 * apart: a message with a wake marker says its wake line was sent; one without says none was
 * typed. The reservations are linked before the lead's write; a write the lead's mailbox refuses
 * releases every reservation the pass took, and a later pass aggregates the same messages again —
 * the sender records are write-once, so the retry publishes each name once. A lead drop's id is
 * fixed by the set of messages it lists, so a lost marker finds the standing record rather than
 * writing a second one.
 */
export function reportUnreadDrops(scene: RetryScene, window: UnreadWindow): void {
  const home = scene.home;
  if (home === undefined) return;
  const key = messageKeyState(home);
  if (key.kind !== 'key') return;
  const nowMs = scene.now.getTime();
  const threshold = window.unreadAfter * 1000 * 2;
  const at = scene.now.toISOString();
  const leadName = scene.team.orchestrator !== '' ? scene.team.orchestrator : scene.team.operator;
  const lead: ReportTarget | null = leadName === ''
    ? null
    : { root: scene.root, session: scene.session, to: leadName, label: leadName };
  const due: DueReport[] = [];
  for (const seat of scene.team.seats) {
    // A person writes no receipt; a drop to a human seat is read by the person, not by a watcher.
    // The retry pass's own give-up already names a drop no watcher read.
    if (seat.human === true) continue;
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    const context: StatusContext = { to: seat.name, root: scene.root, session: scene.session };
    for (const message of listUnread(dropDir, context, home)) {
      const age = nowMs - Date.parse(message.ts);
      if (!(age >= threshold)) continue;
      if (existsSync(reportedPath(dropDir, message.id))) continue;
      const payload = payloadOf(dropDir, message.id, home);
      if (payload === null) continue;
      // A report the pass wrote is not a message to report about: served as an ordinary drop, it
      // waits for the lead's next read like any other message, and never seeds a report of itself.
      if (payload.rule === LEAD_REPORT_RULE) continue;
      const { targets, unresolved } = reportTargets(scene, payload, home);
      if (targets.length === 0) continue;
      const senders = lead === null
        ? targets
        : targets.filter((target) => target.root !== lead.root || target.session !== lead.session || target.to !== lead.to);
      // The reservation is linked before the first write: one pass publishes, and one that finds
      // the name taken — a concurrent pass, or a crash between the write and its marker — spends
      // nothing. The lead drop's id is fixed by the set of messages it lists, so a lost marker
      // finds the standing record rather than writing a second report.
      if (!reserve(reportedPath(dropDir, message.id), { id: message.id, at, state: 'reserved' })) continue;
      const minutes = Math.max(1, Math.round(age / 60_000));
      const woke = wakeMarkOf(dropDir, message.id);
      const wakeWords = woke === null
        ? 'no wake line was typed'
        : woke.state === 'reserved'
          ? `a wake was reserved at ${woke.at} and its outcome is unconfirmed`
          : `its wake line was sent at ${woke.at}`;
      const where = `the drop is at ${join(dropDir, message.id)}`;
      const text = unresolved === null
        ? `${seat.name}: a message from ${payload.from} has been unread for ${minutes} min (id ${message.id}); ${wakeWords}; ${where}`
        : `${seat.name}: a message from ${payload.from} has been unread for ${minutes} min (id ${message.id}); ${wakeWords}; ${where}; the sender's own mailbox could not be resolved (${unresolved}), so this report goes to the team's lead only`;
      due.push({
        seat: seat.name,
        dropDir,
        id: message.id,
        payload,
        senders,
        unresolved,
        minutes,
        text,
        to: [...senders.map((target) => target.label), ...(lead === null ? [] : [lead.label])],
      });
    }
  }
  if (due.length === 0) return;
  const ids = due.map((one) => one.id);
  // One signed drop for the whole pass: every message due in it, listed under their count. A
  // repeat pass with the same set finds the same id on disk and writes nothing.
  let leadId: string | null = null;
  let leadNew = false;
  if (lead !== null) {
    const header = due.length === 1
      ? '1 message has been unread past the report window:'
      : `${String(due.length)} messages have been unread past the report window:`;
    const body = [header, ...due.map((one) => `- ${one.text}`)].join('\n');
    const outcome = writeLeadReportDrop(lead, home, ids, body, at);
    if (!outcome.ok) {
      // The lead's mailbox took nothing: every reservation this pass made goes back, and a later
      // pass may aggregate the same messages again. The sender records are written after this
      // point, so nothing was sent.
      for (const one of due) release(reportedPath(one.dropDir, one.id));
      scene.say(
        due.length === 1
          ? `the unread report for ${ids[0] ?? ''} was not written (${lead.label}: ${outcome.error}); nothing was sent`
          : `the unread report for ${String(due.length)} messages was not written (${lead.label}: ${outcome.error}); nothing was sent`,
        true,
      );
      return;
    }
    leadId = outcome.id;
    leadNew = outcome.existing !== true;
  }
  for (const one of due) {
    let published = 0;
    let existed = 0;
    let failure: string | null = null;
    for (const target of one.senders) {
      const outcome = writeRuntimeMailboxRecord({
        root: target.root,
        home,
        to: target.to,
        id: `unread-${one.id}`,
        text: one.text,
        session: target.session,
        at,
        once: true,
      });
      if (!outcome.ok) {
        failure = `${target.label}: ${outcome.error}`;
        continue;
      }
      if (outcome.existing === true) existed += 1;
      else published += 1;
    }
    if (lead !== null) {
      if (leadNew) published += 1;
      else existed += 1;
    }
    const marker = leadId === null ? { id: one.id, at } : { id: one.id, at, report: leadId };
    if (failure !== null && published === 0 && existed === 0) {
      // Nothing was published: the reservation goes back, and a later pass may speak.
      release(reportedPath(one.dropDir, one.id));
      scene.say(`${one.seat}: the unread report for ${one.id} was not written (${failure}); nothing was sent`, true);
      continue;
    }
    if (failure !== null) {
      // Part of it landed. The reservation stays spent — a repeat could duplicate the part
      // that did — and the line says what did not land.
      mark(one.dropDir, `${one.id}.reported`, { ...marker, state: 'partial', to: one.to });
      scene.say(
        `${one.seat}: the unread report for ${one.id} reached ${String(published + existed)} of ${String(one.senders.length + (lead === null ? 0 : 1))} mailboxes (${failure})`,
        true,
      );
      continue;
    }
    mark(one.dropDir, `${one.id}.reported`, { ...marker, state: 'reported', to: one.to });
    // A record already at a mailbox is the first publication still standing; only a pass that
    // wrote something new says the line again.
    if (published > 0) {
      const reached = one.to.join(' and ');
      scene.say(
        one.unresolved === null
          ? `${one.seat}: a message from ${one.payload.from} was still unread after ${one.minutes} min; reported to ${reached}`
          : `${one.seat}: a message from ${one.payload.from} was still unread after ${one.minutes} min; reported to ${reached} only: the sender's own mailbox could not be resolved (${one.unresolved})`,
        true,
      );
    }
  }
}
