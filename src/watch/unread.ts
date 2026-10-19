// Waking an idle seat whose message is still unread, and telling the sender and the lead.
//
// A delivery is a deposit until the seat's signed read receipt follows: a trigger can leave the
// box with no sign the seat acted on it, and a drop can sit in a folder no watcher reads. The
// send's own window proves only what it saw while it waited; the watch is the reader that keeps
// looking. Its unread pass counts from `watch.unread_after` (N): a message still without a
// receipt N after it landed gets one wake — the seat's own drop read typed into its pane — and a
// message still unread at twice that window is reported to its sender and to the team's lead.
// The report is a mailbox record (`team messages` reads it), never a keystroke into another
// seat's pane.
//
// The wake is the typed leg's own delivery, with the rules that leg already has: a human seat's
// pane is never typed into, a dialog or a box holding unsent text is not typed blind, the seat
// lock is taken, and a pane back at its shell is left alone. A message a held send's retry owns
// (a `.pending` marker) is not woken here: that pass types it, and a second trigger from this
// one would be one too many. Nothing here claims more than it saw: a typed wake is `sent
// (unconfirmed)` until a receipt verifies, and only a verified receipt is `delivered (read)`.
//
// The markers are conveniences beside the message, never the message: `<id>.wake` says the one
// wake line was sent, `<id>.reported` says the sender and the lead were told. A marker that
// cannot be written costs a repeat, not a byte of the body.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_MAILBOX, writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { listUnread, receiptHeld } from '../mcp/inbox.ts';
import { isBareShellPane } from '../send/daemon.ts';
import { deliverTrigger, draftNote, TRIGGER_TAKEN_NOTE, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { dropMessage, readTriggerLine } from '../send/native.ts';
import { pendingDropPath } from '../send/pending.ts';
import { readRecord, verifyRecord, type RecordPayload, type StatusContext } from '../send/record.ts';
import { markTaken } from '../send/taken.ts';
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

/** A marker is written whole, 0600, by the same rename the drop itself gets. It is a convenience:
 *  a write that fails costs a repeat, never the message. */
function mark(dropDir: string, name: string, record: Record<string, unknown>): void {
  try {
    dropMessage(dropDir, name, `${JSON.stringify(record)}\n`);
  } catch {
    // The drop is the message; this record only remembers what was already done.
  }
}

/** The instant the wake marker carries, when it can be read; null otherwise. */
function wakeAt(dropDir: string, id: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(wakePath(dropDir, id), 'utf8')) as { at?: unknown };
    return typeof parsed.at === 'string' ? parsed.at : null;
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
  const nowMs = scene.now.getTime();
  for (const seat of scene.team.seats) {
    // A person's drop is read by a person, and nothing is typed into a human's pane.
    if (seat.human === true) continue;
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
      const line = readTriggerLine(seat.name, scene.session);
      if (line === null) continue;
      // The oldest due message that verifies supplies the audit: the read the trigger names
      // serves the whole folder, and the history line says which message the wake was for.
      const audited = due.map((message) => ({ message, payload: payloadOf(dropDir, message.id, home) }))
        .find((one) => one.payload !== null);
      if (audited === undefined || audited.payload === null) continue;
      const { message, payload } = audited;
      const receipt = (): boolean => receiptHeld(dropDir, message.id, context, home);
      const result = await deliverTrigger(hostOf(scene, pane), pane, line, seat.cli, {
        submitHeld: true,
        dropPath: join(dropDir, message.id),
        receipt,
      });
      // `held` (the box filled between the reads), `unreachable` (a dialog, an unreadable
      // status) and `not-submitted` typed no line the seat took: nothing is marked, and a later
      // pass inside the window tries the one wake again.
      if (result.outcome !== 'delivered') continue;
      const draft = result.draft === undefined ? undefined : draftNote(result.draft);
      // The wake's trigger is the seat's own receipt-writing read: a receipt that landed inside
      // the window — or just after its last poll — is the read itself, never merely a take.
      if (result.evidence === 'receipt' || receipt()) {
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
      // One line served every message due at this instant: each is marked, so none is woken
      // twice. A message that arrives later gets its own wake when its own window opens.
      for (const one of due) {
        mark(dropDir, `${one.id}.wake`, { id: one.id, at: scene.now.toISOString(), evidence: result.evidence ?? result.outcome });
      }
    } finally {
      lock.release();
    }
  }
}

/** The mailboxes one report goes to: the sender's own when this team holds that seat (or the
 *  owner's own), and the team's lead. A sender outside this team has no mailbox here — the lead
 *  is still told, and the line names the sender. The same seat is never written twice. */
function reportTargets(scene: RetryScene, from: string): string[] {
  const targets: string[] = [];
  if (from === OWNER_MAILBOX) targets.push(OWNER_MAILBOX);
  else if (scene.team.seats.some((seat) => seat.name === from)) targets.push(from);
  const lead = scene.team.orchestrator !== '' ? scene.team.orchestrator : scene.team.operator;
  if (lead !== '' && !targets.includes(lead)) targets.push(lead);
  return targets;
}

/**
 * Reports every message still unread at twice the window to its sender and the team's lead, once.
 * The record is the Runtime's own (`from: runtime`, the writer owner delivery already uses), so
 * it reaches the mailbox `team messages` reads and the seat's watch rings it — no pane is
 * touched, which is why a watch without nudges runs this too. The words keep the three states
 * apart: a message with a wake marker says its wake line was sent; one without says none was
 * typed. A write that fails leaves the message without `<id>.reported`, and a later pass writes
 * the same record name again rather than a second one.
 */
export function reportUnreadDrops(scene: RetryScene, window: UnreadWindow): void {
  const home = scene.home;
  if (home === undefined) return;
  const key = messageKeyState(home);
  if (key.kind !== 'key') return;
  const nowMs = scene.now.getTime();
  const threshold = window.unreadAfter * 1000 * 2;
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
      const minutes = Math.max(1, Math.round(age / 60_000));
      const woke = wakeAt(dropDir, message.id);
      const wakeWords = woke === null
        ? 'no wake line was typed'
        : `its wake line was sent at ${woke}`;
      const text = `${seat.name}: a message from ${payload.from} has been unread for ${minutes} min (id ${message.id}); ${wakeWords}; the drop is at ${join(dropDir, message.id)}`;
      const targets = reportTargets(scene, payload.from);
      let written = true;
      for (const target of targets) {
        const outcome = writeRuntimeMailboxRecord({
          root: scene.root,
          home,
          to: target,
          id: `unread-${message.id}`,
          text,
          session: scene.session,
          at: scene.now.toISOString(),
        });
        if (!outcome.ok) {
          written = false;
          scene.say(`${seat.name}: the unread report for ${message.id} was not written to ${target}: ${outcome.error}`, true);
        }
      }
      if (!written) continue;
      mark(dropDir, `${message.id}.reported`, { id: message.id, at: scene.now.toISOString(), to: targets });
      scene.say(
        `${seat.name}: a message from ${payload.from} was still unread after ${minutes} min; reported to ${targets.join(' and ')}`,
        true,
      );
    }
  }
}
