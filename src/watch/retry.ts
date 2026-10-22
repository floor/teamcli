// Delivering the drops a held send left behind, once the seat is free.
//
// The watch is the only long-lived reader with a live view of every seat, so it is where a held
// send's retry belongs: one pass looks again, and a composer that was holding the owner's draft
// is empty a pass later. A retry is the send's own delivery — the same `deliverTrigger`, the same
// verification — with one addition: a box already holding exactly the trigger is submitted, never
// typed over, because the marker beside the drop says whose line it is.
//
// Every retry is bounded (`PENDING_MAX_TRIES` typed tries, `PENDING_MAX_AGE_MS` from the held
// send) and reported when it stops: the word is the drop's path, so the message is never lost
// silently even though the sender's own command has already exited.
//
// A message the mcp-inbox leg left is not a held send: its marker says so, and the seat's own
// client reads it. A receipt promotes it once (`delivered (read)`, the marker cleared) with nothing
// typed; a message still unread when `INBOX_FALLBACK_MS` ends is handed to this same retry, which
// types its trigger and records why the fallback happened. A message the drop leg left is not a
// held send either: nothing is ever typed for it, and a receipt from the seat's own watcher — the
// turn-start hook's read (`team drops --read`), or its inbox client's `inbox_read` — promotes it
// the same way. A
// drop no watcher read is given up on with the file's path, never typed and never called lost.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Seat, TeamFile } from '../file/types.ts';
import type { PaneProcesses } from '../herdr.ts';
import { acquireSeatLock } from '../launch/seat-lock.ts';
import { isBareShellPane } from '../send/daemon.ts';
import { claimBindingIn, INBOX_FALLBACK_MS, INBOX_FALLBACK_REASON, inboxLive, receiptHeld } from '../mcp/inbox.ts';
import {
  channelLaunchEnabled,
  CHANNEL_CONFIRM_MS,
  CHANNEL_HELD_RECEIPT,
  CHANNEL_UNCONFIRMED,
  CHANNEL_UNCONFIRMED_REASON,
  recordChannelHeld,
} from '../mcp/channel.ts';
import {
  clearPending,
  markRedelivered,
  PENDING_MAX_AGE_MS,
  PENDING_MAX_TRIES,
  readPending,
  recordPendingTry,
  type PendingDrop,
} from '../send/pending.ts';
import { deliverTrigger, draftNote, TRIGGER_TAKEN_NOTE, type DeliverHost } from '../send/deliver.ts';
import { appendHistory } from '../send/history.ts';
import { readTriggerLine } from '../send/native.ts';
import { markTaken } from '../send/taken.ts';
import { verifiedPayloadOf, wakeTrigger } from '../send/wake.ts';
import type { Live } from '../status/compare.ts';
import { readScreen } from './screen.ts';

/** What a retry reads and types through: the watch's own sources, narrowed to the pane calls. */
export type RetrySources = {
  screen(pane: string, session: string): string | null;
  status(pane: string, session: string): string | null;
  typeText(pane: string, text: string, session: string): boolean;
  pressEnter(pane: string, session: string): boolean;
  sleep(ms: number): Promise<void>;
  /** One key, spelled as herdr spells it. Absent, a retry that meets unsent text holds: the box
   *  is never cleared without the delivery's own copy and restore. */
  sendKey?(pane: string, key: string, session: string): boolean;
  /** The pane's process identity, as the send's typed leg reads it; null when herdr can't tell.
   *  A pane whose foreground is its own shell is not the seat, and no retry is typed there. */
  processes?(pane: string, session: string): PaneProcesses | null;
};

export type RetryScene = {
  dir: string;
  session: string;
  root: string;
  /** The home whose store holds the history; absent, a retry is still delivered but not filed. */
  home?: string;
  team: TeamFile;
  live: Live;
  /** The watch's own pane: never typed into. */
  ownPane: string | null;
  sources: RetrySources;
  now: Date;
  say(text: string, desktop: boolean): void;
  /** The pass's native hold by seat: nothing is typed at a seat whose presence proves a turn, a
   *  person wait, a session end, or cannot be trusted. Absent, the retry is exactly today's. */
  nativeHeld?: ReadonlySet<string>;
  /** The channel's one redelivery over the socket: a push no receipt confirmed is written as a
   *  frame to the receiving session. Absent, the redelivery goes straight to the typed leg. */
  socketRedeliver?(dropDir: string, drop: PendingDrop): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/** The drop's words, minus the trigger line: one sentence for the watch's log. An inbox send
 *  was `sent (unconfirmed)` rather than held — the seat's own client never read it — and the
 *  watch typing it is the fallback its bound promises, not a retry. */
function heldWords(drop: PendingDrop): string {
  if (drop.leg === 'mcp-inbox') return `an inbox send from ${drop.from}`;
  if (drop.leg === 'channel') return `a channel send from ${drop.from}`;
  return `a held send from ${drop.from}`;
}

/** Why this marker's delivery ended on another leg, as the history line's failed note. The
 *  inbox's bound and the channel's one redelivery both say so on the same line the retry writes. */
function failedNotes(drop: PendingDrop): { failed?: string[] } {
  if (drop.leg === 'mcp-inbox') return { failed: [INBOX_FALLBACK_REASON] };
  if (drop.leg === 'channel' && drop.redelivered !== undefined) return { failed: [CHANNEL_UNCONFIRMED_REASON] };
  return {};
}

/** The drop is out of retries: forget the marker and say where the message is, so it can be
 *  delivered by hand or sent again. A record whose file is gone has nothing left to name — read
 *  from the disk, so an age-out does not name a file that was moved away. */
function giveUp(scene: RetryScene, dropDir: string, drop: PendingDrop, why: string, dropGone = false): void {
  clearPending(dropDir, drop.id);
  const gone = dropGone || !existsSync(join(dropDir, drop.id));
  const tail = gone ? 'send it again' : `the record is at ${join(dropDir, drop.id)}; send it again`;
  scene.say(`${drop.to}: ${heldWords(drop)} was not delivered (${why}); ${tail}`, true);
}

/** A drop the watch stops watching for a receipt: nothing is typed and the sender's command
 *  already said the file was in place, so the words say only that no watcher read it, and where
 *  the message still waits. A drop whose file is gone is named for the folder, not a file. */
function giveUpUnread(scene: RetryScene, dropDir: string, drop: PendingDrop, why: string): void {
  clearPending(dropDir, drop.id);
  const where = existsSync(join(dropDir, drop.id))
    ? `the drop file is at ${join(dropDir, drop.id)}`
    : `its drop file is gone from ${dropDir}`;
  scene.say(`${drop.to}: a dropped send from ${drop.from} was not read (${why}); ${where}`, true);
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

/** Whether a wake of this seat can race a channel push at all: the channel is a Claude Code
 *  launch feature, and a launch without the flag has no server that could push. A listener
 *  started with the flag can still be running after the team file stops naming it, so a live
 *  marker that declares the channel counts too — but only when it names this seat, this session
 *  and this root, the same binding the sender's live check uses; a marker naming another inbox
 *  proves nothing and holds nothing. A server started after the record arrived pushes nothing
 *  (its first listing is marked seen), so a dead marker leaves no push to race. The marker is
 *  one file and last-writer-wins: a newer server that declares no channel hides an older channel
 *  server still running, and that older one is not covered — the one-process scope the docs
 *  state. */
function channelSeat(scene: RetryScene, seat: Seat, dropDir: string): boolean {
  if (seat.cli === 'claude-code' && channelLaunchEnabled(seat.launch)) return true;
  const live = inboxLive(dropDir, scene.root, scene.session, seat.name);
  return live.live && live.listener.channel === true;
}

/** Reserve the push name before a retry wake. The reservation is made before the wake whichever
 *  install is listening, not after judging a listener: a listener can be replaced, or an install
 *  can land, between any check and the wake, and the name must already be held when that happens.
 *  Every marker-aware serving server treats a marker for the id as a push already made, so every
 *  later tick of every such server skips the record, and the retry's socket frame or typed
 *  trigger is the one wake this pass adds. A build older than the marker rule cannot honor it.
 *  The record stays in the inbox and `inbox_check`/`inbox_read` still serve it, so holding the
 *  name never withholds the message.
 *
 *  The hold is permanent for the id: nothing removes it. If the wake it precedes is never taken
 *  — the typed line is not submitted and the retry gives up after `PENDING_MAX_TRIES`, or the
 *  pane never frees — the name stays held and no marker-aware server pushes this record
 *  afterwards, including a tick a still-running server has yet to make. Delivery then falls to
 *  the seat's own read: its turn-start drop read, `team messages`, or `inbox_check`/`inbox_read`.
 *  That is the price of holding before the wake; removing the marker after a wake that typed
 *  nothing would let a push land after the wake and reopen the duplicate the reservation exists
 *  to stop.
 *
 *  The reservation cannot fence a tick that already passed its own marker check. That tick writes
 *  the notification — the body is displayed — and its push marker write then fails on this file.
 *  It creates no second record and no second valid read receipt: the receipt is per id, so the
 *  claim is no second record or id, not at-most-once display. The server's seen set is per
 *  process, and two servers for one inbox are not excluded, so each live server can do that once;
 *  every later tick of every process finds the name held. The launch-drift fallback reads one
 *  marker, so in a two-server inbox an older channel server hidden by a newer non-channel marker
 *  is not covered; the docs state that one-process scope. */
function holdChannelPush(scene: RetryScene, dropDir: string, drop: PendingDrop): void {
  recordChannelHeld(dropDir, {
    v: 1,
    kind: CHANNEL_HELD_RECEIPT,
    id: drop.id,
    at: scene.now.toISOString(),
    reason: 'the watch retry wakes the seat; the channel push name is held first',
  });
}

/**
 * One held drop, when its seat is free. The screen is read first, and a dialog or a status that
 * is not idle/done ends the pass here — the box is never typed blind. Unsent text is the
 * delivery's to copy and put back; a retry types nothing itself. The seat
 * lock is taken for the delivery, so a second watch and a `team send` cannot type into one pane
 * at once, then the box is read again by the delivery itself, which is the final guard. A pane
 * back at its shell is refused under the lock, as the typed leg and the daemon refuse it: its
 * CLI has exited, and the shell's box is not a composer to type a trigger into.
 */
async function retryOne(scene: RetryScene, seat: Seat, pane: string, dropDir: string, drop: PendingDrop): Promise<void> {
  // The marker is only a convenience; the drop file is the message. A record left behind a drop
  // that was moved or removed has nothing to tell the seat, so it is given up on, not typed.
  if (!existsSync(join(dropDir, drop.id))) {
    giveUp(scene, dropDir, drop, `its drop file is gone from ${dropDir}`, true);
    return;
  }
  // The wake names the sender its signed record carries. A drop whose record this home cannot
  // verify and pin to one sender is not typed nameless: it is given up on with its file kept, so
  // a person can still deliver it by hand.
  const home = scene.home;
  if (home === undefined) {
    giveUp(scene, dropDir, drop, 'this watch has no home to verify its sender with');
    return;
  }
  const payload = verifiedPayloadOf(dropDir, drop.id, home);
  if (payload === null) {
    giveUp(scene, dropDir, drop, "its signed record does not verify with this home's key");
    return;
  }
  const sender = wakeTrigger(payload, home, { root: scene.root, session: scene.session, team: scene.team }, scene.now);
  if (sender === null) {
    giveUp(scene, dropDir, drop, 'its signed record does not name a sender this home can pin');
    return;
  }
  const line = readTriggerLine(drop.to, scene.session, sender);
  if (line === null) {
    giveUp(scene, dropDir, drop, 'its trigger line would not fit in a pane');
    return;
  }
  const status = scene.sources.status(pane, scene.session);
  const screen = scene.sources.screen(pane, scene.session);
  // A box that cannot be read is not typed into: a retry exists to avoid the lost message, not to
  // add a second one. The age bound ends a marker left behind a pane that never reads again.
  if (screen === null || (status !== 'idle' && status !== 'done')) return;
  const kind = readScreen(seat.cli, screen).kind;
  // A dialog screen is never typed into here. Unsent text goes to the delivery below, which
  // copies it beside the drop, clears the box, delivers and pastes it back — or holds where this
  // CLI has no measured way into its box; either way the retry types nothing itself.
  if (kind !== 'idle' && kind !== 'unsent') return;

  const lock = acquireSeatLock(scene.dir, scene.session, drop.to);
  if (!('release' in lock)) return;
  try {
    // A pane back at its shell is no longer the seat: the CLI has exited, and a trigger typed
    // there reaches the shell. The typed leg and the daemon refuse the state with these words;
    // the retry records the same reason and keeps the drop file for a person to send again.
    if (isBareShellPane(scene.dir, scene.session, drop.to, scene.sources.processes?.(pane, scene.session) ?? null)) {
      giveUp(scene, dropDir, drop, 'the seat is back at its shell; nothing was typed');
      return;
    }
    const receipt = (): boolean => receiptHeld(dropDir, drop.id, { to: drop.to, root: scene.root, session: scene.session }, home, claimBindingIn(scene.root, scene.session, drop.to, drop.id));
    // A receipt that landed since the retry records were read is the read itself: nothing is
    // typed, and the marker is settled with the words a receipt inside the retry's window earns.
    // A trigger typed for an already-read message is a duplicate reminder, not a delivery.
    if (receipt()) {
      clearPending(dropDir, drop.id);
      if (home !== undefined) {
        appendHistory(scene.team.project, scene.root, home, {
          ts: scene.now.toISOString(),
          from: drop.from,
          to: drop.to,
          body: drop.body,
          id: drop.id,
          outcome: 'delivered (read)',
          via: 'typed',
          ...failedNotes(drop),
        });
      }
      scene.say(`${drop.to}: ${heldWords(drop)} was read on retry (receipt)`, false);
      return;
    }
    // The retry is a wake of its own, and any marker-aware channel server could push the same
    // record on top of it. The push name is reserved before the line, without waiting to judge
    // the listener: a marker already at that name is the server's own push, and the write is
    // refused while the retry goes on.
    if (channelSeat(scene, seat, dropDir)) holdChannelPush(scene, dropDir, drop);
    const result = await deliverTrigger(hostOf(scene, pane), pane, line, seat.cli, {
      submitHeld: true,
      dropPath: join(dropDir, drop.id),
      receipt,
    });
    if (result.outcome === 'delivered') {
      clearPending(dropDir, drop.id);
      // The retry moved an unsent draft out of the box and back (or kept its copy): the receipt
      // the sender would have had travels with the retry's line and its history entry too.
      const draft = result.draft === undefined ? undefined : draftNote(result.draft);
      // The retry's trigger is the seat's own receipt-writing read. A receipt that landed inside
      // the window — or just after its last poll — is the read itself: `delivered (read)`, and
      // nothing is ever typed again.
      if (receipt !== undefined && (result.evidence === 'receipt' || (result.evidence === 'taken' && receipt()))) {
        if (home !== undefined) {
          appendHistory(scene.team.project, scene.root, home, {
            ts: scene.now.toISOString(),
            from: drop.from,
            to: drop.to,
            body: drop.body,
            id: drop.id,
            outcome: 'delivered (read)',
            ...(draft === undefined ? {} : { note: draft }),
            via: 'typed',
            // A typed fall-through is the inbox leg's own bound ending: the history line says why
            // the same drop file was typed after the seat's client left it unread.
            ...failedNotes(drop),
          });
        }
        scene.say(`${drop.to}: ${heldWords(drop)} was read on retry (receipt)`, false);
        return;
      }
      // A retry that took the line is a trigger sent, never a message read: no signed receipt has
      // come back, and it is never typed again — the marker is gone, and the history says how the
      // send stands.
      const taken = result.evidence === 'taken';
      const note = [TRIGGER_TAKEN_NOTE, draft].filter((one): one is string => one !== undefined).join('; ');
      if (taken) {
        // The retry left a taken line: the same marker the send writes, so the watch's later
        // passes look for the sign the retry's own window missed — and this drops out of the
        // retry records for good.
        markTaken(dropDir, {
          id: drop.id,
          from: drop.from,
          to: drop.to,
          body: drop.body,
          ts: scene.now.toISOString(),
          before: result.prior ?? 'unknown',
        });
      }
      if (scene.home !== undefined) {
        appendHistory(scene.team.project, scene.root, scene.home, {
          ts: scene.now.toISOString(),
          from: drop.from,
          to: drop.to,
          body: drop.body,
          id: drop.id,
          outcome: 'sent (unconfirmed)',
          note,
          via: 'typed',
          // A typed fall-through is the inbox leg's own bound ending: the history line says why
          // the same drop file was typed after the seat's client left it unread.
          ...failedNotes(drop),
        });
      }
      scene.say(`${drop.to}: ${heldWords(drop)} was sent on retry (${note})`, false);
      return;
    }
    if (result.outcome === 'not-submitted') {
      if (drop.tries + 1 >= PENDING_MAX_TRIES) {
        giveUp(scene, dropDir, drop, `the seat did not take it in ${PENDING_MAX_TRIES} tries`);
        return;
      }
      recordPendingTry(dropDir, drop);
      return;
    }
    // `held` (the box filled between the reads) typed no line of its own, and `unreachable` (a
    // dialog, an unreadable status) reached nothing: neither spends a try. The next pass looks
    // again, and the age bound is what ends a pane that never frees.
  } finally {
    lock.release();
  }
}

/**
 * The channel's one redelivery: a push whose confirmation window ended with no signed receipt is
 * written again through the next leg — the receiving session's socket, then the typed trigger —
 * and the marker is marked before either attempt, so no later pass can redeliver it. A
 * marker-aware channel server could push the same record at any tick, so the push name is
 * reserved before the first wake leg, whichever install is listening; `retryOne` reserves again
 * before typing. A receipt
 * that landed first is the read itself: nothing is typed and the record is settled, exactly as
 * the promotion pass would settle it. A socket delivery writes its own receipt and history line;
 * the typed leg is the ordinary retry, whose history line carries `redelivered: channel
 * unconfirmed` as the failed note. A pane this pass cannot type at spends the one redelivery all
 * the same: the marker says the watch tried, and the message stays where a person can send it
 * again.
 */
async function redeliverChannel(scene: RetryScene, seat: Seat, pane: string, dropDir: string, drop: PendingDrop): Promise<void> {
  const home = scene.home;
  if (home === undefined) {
    giveUp(scene, dropDir, drop, 'this watch has no home to verify its sender with');
    return;
  }
  const receipt = (): boolean => receiptHeld(dropDir, drop.id, { to: drop.to, root: scene.root, session: scene.session }, home, claimBindingIn(scene.root, scene.session, drop.to, drop.id));
  // A receipt that arrived after the promotion pass read the markers is the read itself: an
  // acknowledged message is never touched again.
  if (receipt()) {
    clearPending(dropDir, drop.id);
    appendHistory(scene.team.project, scene.root, home, {
      ts: scene.now.toISOString(),
      from: drop.from,
      to: drop.to,
      body: drop.body,
      id: drop.id,
      outcome: 'delivered (read)',
      via: 'channel',
    });
    scene.say(`${drop.to}: a channel send from ${drop.from} was read (receipt)`, false);
    return;
  }
  markRedelivered(dropDir, drop, CHANNEL_UNCONFIRMED);
  // The socket leg is a wake of its own, and the typed leg inside `retryOne` reserves again: the
  // push name is held before the first of them, whichever install is listening, so a server that
  // appears or changes between this point and the wake still finds the record held.
  if (channelSeat(scene, seat, dropDir)) holdChannelPush(scene, dropDir, drop);
  const marked: PendingDrop = { ...drop, redelivered: CHANNEL_UNCONFIRMED };
  if (scene.socketRedeliver !== undefined) {
    const socket = await scene.socketRedeliver(dropDir, marked);
    if (socket.ok) {
      // The socket attempt wrote the signed receipt and its own history line, marked with the
      // channel's own note; the marker has nothing left to say.
      clearPending(dropDir, drop.id);
      scene.say(`${drop.to}: a channel send from ${drop.from} was redelivered on the socket`, false);
      return;
    }
    scene.say(`${drop.to}: a channel send from ${drop.from} was not confirmed; the socket was not taken (${socket.reason}), typing the trigger`, false);
  }
  await retryOne(scene, seat, pane, dropDir, marked);
}

/**
 * Promotes every send a seat has read since the last pass, on either receipt leg: the
 * `<id>.read.json` receipt the seat's inbox, its turn-start drop read, or `team messages` signed
 * with the message key says it read the message, so the history records `delivered (read)` once
 * and the marker is cleared. A receipt the key did not sign, or one naming another seat, checkout
 * or session, proves nothing. Nothing is typed and no pane is needed — the pass reads two files
 * per marker — so it runs in a watch without nudges too, where the receipt is the only word the
 * sender gets. The name is the inbox-side one it grew from; the watch's call site keeps it.
 */
export function promoteInboxDrops(scene: RetryScene): ReadonlySet<string> {
  // A promoted inbox/drop receipt may have a matching message record in the ordinary mailbox
  // store. Tell the ring path which exact seat/id was read so it cannot use the stale mailbox
  // snapshot from before this promotion.
  const read = new Set<string>();
  for (const seat of scene.team.seats) {
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    for (const drop of readPending(dropDir)) {
      // A marker with no leg is a typed retry's own record; a receipt on the drop is another
      // send's proof and never this one's.
      if (drop.leg === undefined) continue;
      if (scene.home === undefined) continue;
      if (!receiptHeld(dropDir, drop.id, { to: seat.name, root: scene.root, session: scene.session }, scene.home, claimBindingIn(scene.root, scene.session, seat.name, drop.id))) continue;
      read.add(`${seat.name}\n${drop.id}`);
      clearPending(dropDir, drop.id);
      if (scene.home !== undefined) {
        appendHistory(scene.team.project, scene.root, scene.home, {
          ts: scene.now.toISOString(),
          from: drop.from,
          to: drop.to,
          body: drop.body,
          id: drop.id,
          outcome: 'delivered (read)',
          via: drop.leg,
          ...(drop.leg === 'channel' && drop.redelivered !== undefined ? { failed: [CHANNEL_UNCONFIRMED_REASON] } : {}),
        });
      }
      scene.say(
        drop.leg === 'drop'
          ? `${seat.name}: a dropped send from ${drop.from} was read in its drop folder`
          : drop.leg === 'channel'
            ? `${seat.name}: a channel send from ${drop.from} was read (receipt)`
            : `${seat.name}: an inbox send from ${drop.from} was read in its inbox`,
        false,
      );
    }
  }
  return read;
}

/**
 * Retries the held drops of every seat this team has a live pane for: the oldest drop of each
 * seat, at most one per seat per pass, so a seat is never sent two messages at once.
 */
export async function retryHeldDrops(scene: RetryScene): Promise<void> {
  for (const seat of scene.team.seats) {
    const dropDir = join(scene.dir, 'send-drops', scene.session, seat.name);
    const drops = readPending(dropDir);
    if (drops.length === 0) continue;
    // A pane the file marks as a human's is never typed into: a retry is typing, so a marker
    // left for such a seat is given up on where it stands, with the reason, and the message
    // waits in its drop file for a person to read. A drop-leg marker is not a retry at all —
    // a person reading the drop writes no receipt — so it is only forgotten.
    if (seat.human === true) {
      for (const drop of drops) {
        if (drop.leg === 'drop') clearPending(dropDir, drop.id);
        else giveUp(scene, dropDir, drop, 'the pane is a human\'s, and nothing is typed into it');
      }
      continue;
    }
    // A held seat is not retried: the native store proves it is not idle (or the projection
    // cannot be trusted). The marker stays pending, so a later pass with the hold lifted still
    // finds it; no age bound is applied while the hold stands.
    if (scene.nativeHeld?.has(seat.name) === true) continue;
    // The age bound is applied before the pane is looked for: a seat that vanished leaves no
    // pane to retry, and its marker must not sit in the store forever. A drop-leg marker has
    // nothing to retry, only a receipt to wait for: past the bound it is given up on with the
    // file's path and the word that no watcher read it.
    const now = scene.now.getTime();
    const live: PendingDrop[] = [];
    for (const drop of drops) {
      if (now - Date.parse(drop.ts) <= PENDING_MAX_AGE_MS) {
        live.push(drop);
        continue;
      }
      if (drop.leg === 'drop') giveUpUnread(scene, dropDir, drop, `no receipt within ${String(PENDING_MAX_AGE_MS / 60_000)}m`);
      else giveUp(scene, dropDir, drop, 'the retry window passed');
    }
    const agents = scene.live.agents.filter((agent) => agent.name === seat.name);
    const pane = agents.length === 1 ? agents[0]?.pane : undefined;
    if (pane === undefined || pane === scene.ownPane) continue;
    // A typed marker is the retry's own business and always goes first. A channel marker is
    // redelivered once, after its confirmation window and only while no redelivery is recorded.
    // An inbox marker is typed only once its fallback window has ended — before that the seat's
    // own client still has the message, and typing the trigger would race a read that is about to
    // happen. A drop marker is in none of the finds: nothing is ever typed for it.
    const channelDue = live.find(
      (one) => one.leg === 'channel' && one.redelivered === undefined && now - Date.parse(one.ts) > CHANNEL_CONFIRM_MS,
    );
    const drop = live.find((one) => one.leg === undefined)
      ?? channelDue
      ?? live.find((one) => one.leg === 'mcp-inbox' && now - Date.parse(one.ts) > INBOX_FALLBACK_MS);
    if (drop === undefined) continue;
    if (drop.leg === 'channel') await redeliverChannel(scene, seat, pane, dropDir, drop);
    else await retryOne(scene, seat, pane, dropDir, drop);
  }
}
