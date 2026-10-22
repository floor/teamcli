// The idle-work dispatcher: the watch's one path from "these seats are idle and the picker
// would offer them work" to "each of them is told to take some". It reads the shared snapshot
// (`idleWorkReport`) once per pass and never picks, claims or leases on its own, so the watch
// cannot disagree with `status` about who is idle or what is takeable. One attempt is spent per
// seat per idle episode, refusals included; the episode ends only when a later reading no longer
// counts the seat. The legacy typed work nudge is retired for every episode this dispatcher owns:
// the attempt is the direct route's, and the dispatcher itself never types. The route may type
// once as its own fallback — the typed trigger behind a socket leg the route actually dialed and
// the receiver refused (`src/commands/send.ts`) — and that keystroke is part of the same single
// attempt, under the same admission, seat lock, draft move and authority recheck. A seat whose
// route never dialed the socket is told nothing rather than typed at by a second path.
//
// The spend is durable: the episode's identity is the seat's persisted `last_active`, and the
// claim that spends its one attempt lives in the session's state record (src/watch/claim.ts).
// A watch restart, a new host or a second watch on the same root reads the same claim, so an
// episode is never attempted twice — and a capture left `pending` by a stop is held, never read
// as absence and never retried.
//
// Two production readings leave the dispatcher with nothing to deliver, and each says so once
// through the same lead+main announcement: a source with zero takeable records while seats sit
// idle ("N idle, nothing queued"), and a seat still idle a minute after an accepted wake with no
// read-only evidence that it claimed anything (the failed pickup). Both are observations of the
// pass clock; nothing here sleeps, starts a timer or re-wakes a seat.
import { createHash } from 'node:crypto';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator } from '../bus/seats.ts';
import type { DirectSendResult } from '../commands/send.ts';
import type { BrokerWorkSnapshot, IdleWorkInput, IdleWorkReport } from '../idle_work.ts';
import { teamIdOf } from '../registry/teams.ts';
import { liveLeases } from '../tasks/lease.ts';
import { fileSourceOf } from '../tasks/queue.ts';
import { captureIdleClaim, endIdleClaims, idleClaimOf, settleIdleClaim } from './claim.ts';
import { isIdleClaim, type IdleClaim } from './claim-record.ts';
import { idleWorkReport } from './idle-work.ts';
import { prefetchPresence } from './presence.ts';

/** The direct route's request: the seat, the pane and CLI the pass read for it, and the body
 *  already rendered from `watch.nudge`. It is the same shape a work drop carries today. */
export type WorkPushRequest = { seat: string; pane: string; cli: string; body: string };

/** The route's honest answer. `outcome` is the transport's own word and is always required: a
 *  route never flattens `code0`, a held delivery or a durable copy into a successful wake. A
 *  push result is never read or claim proof. */
export type WorkPushResult = { ok: true; outcome: string } | { ok: false; refused: string };

/**
 * What the idle dispatcher reads back from one direct send. Only a route that delivered is a
 * wake; a stored copy, a timeout, an unreachable or a refused ending is `ok: false`, whatever the
 * command's exit code was. A run that ended before any route was attempted is a refusal too, with
 * the command's own words when it said any.
 */
export function workPushResultOf(result: DirectSendResult | null, said: string): WorkPushResult {
  if (result === null) {
    const why = said.replace(/\s+/g, ' ').trim();
    return { ok: false, refused: why === '' ? 'the send ended before any direct route was attempted' : why };
  }
  const detail = result.reason === undefined ? '' : `: ${result.reason}`;
  if (result.outcome === 'delivered') return { ok: true, outcome: `${result.route}: delivered${detail}` };
  return { ok: false, refused: `${result.route}: ${result.outcome}${detail}` };
}

/** The direct route a watch's sources may wire. Absent, this dispatcher sends nothing and types
 *  nothing; it never falls back to a keystroke of its own. A wired route's own typed fallback
 *  (behind a socket leg it dialed and the receiver refused) is the route's, not a second path
 *  from here. */
export type WorkPush = (request: WorkPushRequest) => Promise<WorkPushResult>;

/** Whether a route's refusal came from the typed fallback that stands behind a refused socket
 *  leg. The fallback's own transport names itself first, exactly as `workPushResultOf` formats
 *  every ending (`typed: <outcome>[: <reason>]`), so the notice can say a fallback was tried
 *  instead of promising nothing was typed. */
export function typedFallbackRefused(refused: string): boolean {
  return refused.startsWith('typed: ');
}

export type PushedWork =
  | { seat: string; ok: true; outcome: string }
  | { seat: string; ok: false; refused: string };

/** What one announcement wrote, could not write, or could not map. `missing` names a recipient
 *  the registry does not resolve (the main orchestrator, usually): the limitation is said, and
 *  no identity is invented in its place. */
export type FallbackDelivery = {
  written: string[];
  failed: string[];
  missing: string[];
};

export type IdleDispatchInput = IdleWorkInput & {
  /** The state directory the pass read its snapshot from. The claim is captured, settled and
   *  pruned under that directory's state lock. */
  dir: string;
  /** The body a pushed seat is told, rendered per seat by the caller. */
  body: (seat: string) => string;
  push?: WorkPush;
  /**
   * The watch's tracker reader, when its sources wire one. Called at most once per pass, and
   * only for a team whose declared source is not a file, once this pass has proven a seat idle:
   * the request names that seat and the pane its state record holds, never a made-up identity.
   * The answer is the snapshot the dispatcher counts; a refusal, a throw, an absence or no
   * reader at all leaves the count unknown and the pass holds. There is no reader in this build.
   */
  readTaskSnapshot?: (caller: { seat: string; pane: string }) => Promise<BrokerWorkSnapshot | null>;
};

export type IdleDispatchResult = {
  /** One entry per attempt made in this call, including refusals. A seat already attempted in
   *  this episode is not attempted again and does not appear here. */
  pushed: PushedWork[];
  /** Every eligible seat whose old typed work nudge this pass must not type: the episodes
   *  attempted now and the episodes attempted earlier in the same idle stretch. */
  suppressed?: string[];
  /** Present when an announcement had to be written: an unavailable or refused route, an empty
   *  source with idle seats, a failed pickup, or a capture whose outcome is unknown after a
   *  stop. One announcement per episode and subject: the team lead and the main orchestrator,
   *  deduplicated when one target, each with its own signed runtime mailbox record. */
  fallback?: FallbackDelivery;
};

/** How long an accepted wake may take to show a real claim or activity before the episode is
 *  reported once as a failed pickup — and how long a capture with no recorded outcome is held
 *  silently before its one unknown-outcome notice. The watch's own pass clock measures both. */
const PICKUP_GRACE_MS = 60_000;

const SEP = '\u0000';

/**
 * A settle the state lock refused, owed by this process only: the route was called exactly once
 * and gave its answer, and only the record of that answer is still to be written. Keyed by the
 * capture's `claim_id`, so it lands on that capture and no other. Never durable, never a retry
 * of the push; a stop before it is written leaves the claim `pending`, which is held.
 */
type PendingSettle = {
  session: string;
  seat: string;
  idle_since: string;
  claim_id: string;
  outcome: 'accepted' | 'refused';
  /** The pass clock of the push, as ISO, so `accepted` stores the wake time the pass read. */
  at: string;
  /** The route's words, for the announcement this process can still make. Never persisted. */
  refused?: string;
};

const pendingSettles = new Map<string, PendingSettle>();

/** The notices this process already published, keyed by the capture's claim_id (a claim owes at
 *  most one notice across its transitions). It is a publication memory, not a spend: the claim's
 *  `notice` field holds the durable intent, and a new process starts with this empty and replays
 *  it (the same `once: true` ids make the replay the same records). Without it, a notice the
 *  claim still owes would be re-announced on every pass that follows its publication. Keying by
 *  claim, not by the mailbox binding, keeps a second claim of the same seat and episode stamp —
 *  after the first was pruned and the episode recaptured — free to publish its own notice. */
const publishedNotices = new Set<string>();

/** The empty-source notice ledger, keyed by scope: the signature of the idle stretch already
 *  announced. Removed when nothing is idle or the source has takeable work, so a later empty
 *  stretch is a new notice. */
const emptyNotices = new Map<string, { signature: string; seq: number }>();
let emptyNoticeSeq = 0;

function scopeOf(input: IdleWorkInput): string {
  return `${input.root}${SEP}${input.team.session}`;
}

/** Test and restart seam: forget every in-process memory — the empty-source notice ledger and
 *  the settles a held lock still owes. The durable claims are deliberately not forgotten: a
 *  restart re-reads them from the state file, which is the point of the record. */
export function forgetIdleEpisodes(): void {
  pendingSettles.clear();
  publishedNotices.clear();
  emptyNotices.clear();
  emptyNoticeSeq = 0;
}

/**
 * One dispatch pass. The snapshot is read here, once; nothing else is read to pick work. The
 * claims the reading no longer counts are pruned first, then each eligible seat follows its
 * durable claim: none (or one of an earlier episode) is captured before any push, so the attempt
 * is spent before the route is called and a throw still spends it; a claim of this episode is
 * held. A refused route keeps the one fallback announcement, and the claim remembers it, so a
 * later pass or a new host replays that notice and never pushes again. A seat whose route
 * accepted the wake is checked again at the first pass a minute later: a live lease it holds or
 * an activity clock past the wake counts as a claim and settles the claim silently; a seat still
 * idle with neither is announced once. A capture with no recorded outcome (a stop between the
 * write and the settle) is held, and past the grace one honest unknown-outcome notice is
 * written. An actionable reading with zero takeable records ends every claim and announces the
 * empty stretch once; an unreadable reading (unknown threshold, unreadable source) announces
 * nothing, resets nothing and writes nothing. Every record is written as a signed runtime
 * mailbox record to the team lead and the main orchestrator through the same machinery a prompt
 * climb uses. No bus event kind is invented; no owner identity is used here.
 */
export async function dispatchIdleWork(input: IdleDispatchInput): Promise<IdleDispatchResult> {
  // Coherent native readings are prefetched outside the synchronous snapshot. The channel health
  // is the caller's own per-seat knowledge (daemon ownership, a binding-matched fixed health or a
  // live RPC answer); with none supplied it is not known, so a present projection is held rather
  // than believed.
  const presence = input.presence === undefined
    ? await prefetchPresence({
        stateDir: input.dir,
        session: input.team.session,
        seatNames: input.team.seats.map((seat) => seat.name),
      })
    : input.presence;
  let report = idleWorkReport({ ...input, presence });
  // A declared tracker has no count until its reader answers. Ask once per pass, for the first
  // seat this pass proved idle and the pane its state record holds; the reader judges the pair.
  // No reader, no route to push over, an untrustworthy reading, no idle seat, no recorded pane, a
  // refusal or a throw all leave the count unknown, and the pass holds exactly as it did before
  // a reader existed. A file source never asks, and a caller-supplied broker snapshot is never
  // overridden by a second read.
  if (report.takeable === null && input.broker === undefined && input.readTaskSnapshot !== undefined
    && input.push !== undefined && report.threshold_unknown === undefined && report.presence_unknown === undefined
    && fileSourceOf(input.team) === null && report.idle.length > 0) {
    const seat = report.idle[0]!.seat;
    const pane = input.state.seats[seat]?.pane;
    let snapshot: BrokerWorkSnapshot | null;
    if (pane === undefined) {
      snapshot = null;
    } else {
      try {
        snapshot = await input.readTaskSnapshot({ seat, pane });
      } catch (error) {
        snapshot = {
          kind: 'refused',
          at: input.now.toISOString(),
          why: `the tracker snapshot read failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    report = idleWorkReport({ ...input, presence, broker: snapshot });
  }
  // A reading that cannot be trusted dispatches nothing, announces nothing and resets nothing:
  // the dispatcher cannot tell a seat that left its episode from a reading it could not take.
  if (report.threshold_unknown !== undefined || report.takeable === null) return { pushed: [] };
  // A seat whose native presence could not be trusted holds every prune, write and notice. An
  // invalid or unfenced reading must never look like a seat that ended its idle episode.
  if (report.presence_unknown !== undefined) return { pushed: [] };
  const scope = scopeOf(input);
  const result: IdleDispatchResult = { pushed: [] };

  if (report.takeable === 0) {
    // The current contract's own end of episode: no takeable work ends every claim. A busy or
    // unreadable lock leaves them standing; nothing is pushed on this path either way.
    endIdleClaims(input.dir, { session: input.team.session, current: [] });
    // A paused team has no takeable work by rule, not because the source is empty: the pause's
    // own drops say what is happening, and "nothing queued" would be a claim about a queue the
    // pause itself has withdrawn.
    if (input.pause != null) return result;
    if (report.idle.length === 0) {
      emptyNotices.delete(scope);
      return result;
    }
    noticeEmpty(input, report, scope, result);
    return result;
  }

  // Takeable work exists: any empty stretch is over, and a seat no longer counted leaves its
  // claim behind.
  emptyNotices.delete(scope);
  const eligible = report.idle.map((item) => item.seat);
  result.suppressed = [...eligible];
  if (eligible.length === 0) return result;
  const ended = endIdleClaims(input.dir, {
    session: input.team.session,
    current: report.idle.map((item) => ({ seat: item.seat, idle_since: item.since ?? 'watch-start' })),
  });
  if (ended.kind !== 'ended') {
    // The claims could not be read or pruned under the lock: no push is made from a ledger this
    // pass could not align, and nothing is announced. The next pass repeats.
    return result;
  }

  for (const seat of eligible) {
    const since = sinceOf(report, seat);
    const standing = idleClaimOf(input.state, seat);
    if (standing !== undefined) {
      // An unreadable presence is a hold: no push, no notice, no replacement here.
      if (!isIdleClaim(standing)) continue;
      if (standing.idle_since === since) {
        await followClaim(input, result, seat, standing);
        continue;
      }
      // A readable claim of an earlier episode falls through to capture, which replaces it.
    }
    const captured = captureIdleClaim(input.dir, {
      session: input.team.session,
      seat,
      idle_since: since,
      at: input.now,
    });
    if (captured.kind === 'held') {
      // Another writer captured between the snapshot and the lock: obey its record.
      if (isIdleClaim(captured.entry) && captured.entry.idle_since === since) {
        await followClaim(input, result, seat, captured.entry);
      }
      continue;
    }
    // Stale (the persisted clock moved), busy, or unreadable: no push this pass.
    if (captured.kind !== 'captured') continue;
    const outcome = await attempt(input, seat);
    result.pushed.push(outcome.pushed);
    const settled = settleIdleClaim(input.dir, {
      session: input.team.session,
      seat,
      idle_since: since,
      claim_id: captured.claim.claim_id,
      at: input.now,
      outcome: outcome.pushed.ok ? 'accepted' : 'refused',
    });
    if (settled.kind === 'busy' || settled.kind === 'failed') {
      pendingSettles.set(captured.claim.claim_id, {
        session: input.team.session,
        seat,
        idle_since: since,
        claim_id: captured.claim.claim_id,
        outcome: outcome.pushed.ok ? 'accepted' : 'refused',
        at: input.now.toISOString(),
        ...(outcome.pushed.ok ? {} : { refused: outcome.pushed.refused }),
      });
      continue;
    }
    if (outcome.pushed.ok) continue;
    replayNotice(input, result, captured.claim.claim_id, 'push', seat,
      refusalText(input, seat, outcome.pushed.refused), pushBinding(seat, captured.claim));
  }
  return result;
}

/**
 * Follows one seat's durable claim of this episode. The claim is the authority: nothing here
 * pushes. A `pending` claim with a settle this process still owes is finished with the answer
 * the route already gave; with no such settle it is a capture whose outcome is unknown, held
 * silently until the grace, then announced once. An `inflight` claim is checked at the grace for
 * claim evidence and closed out with its one notice when there is none. `refused` and `done`
 * replay the notice the claim still owes, under the same deterministic mailbox ids, so a stop
 * between the write and the publication loses nothing.
 */
async function followClaim(
  input: IdleDispatchInput,
  result: IdleDispatchResult,
  seat: string,
  claim: IdleClaim,
): Promise<void> {
  const session = input.team.session;
  const now = input.now.getTime();
  if (claim.state === 'pending') {
    const owed = pendingSettles.get(claim.claim_id);
    if (owed !== undefined) {
      const settled = settleIdleClaim(input.dir, {
        session,
        seat,
        idle_since: claim.idle_since,
        claim_id: claim.claim_id,
        at: new Date(owed.at),
        outcome: owed.outcome,
      });
      if (settled.kind === 'busy' || settled.kind === 'failed') return;
      pendingSettles.delete(claim.claim_id);
      if (settled.kind !== 'settled') return;
      if (settled.claim.state === 'refused' && owed.refused !== undefined) {
        replayNotice(input, result, claim.claim_id, 'push', seat,
          refusalText(input, seat, owed.refused), pushBinding(seat, claim));
      }
      return;
    }
    // A stop between the capture and the settle: the attempt may or may not have been made, so
    // the claim is held and never retried. Past the grace, say exactly that once.
    if (now - Date.parse(claim.claimed_at) < PICKUP_GRACE_MS) return;
    const settled = settleIdleClaim(input.dir, {
      session,
      seat,
      idle_since: claim.idle_since,
      claim_id: claim.claim_id,
      at: input.now,
      outcome: 'unknown',
    });
    if (settled.kind !== 'settled') return;
    replayNotice(input, result, claim.claim_id, 'unknown', seat,
      `${input.team.project}: ${seat}'s direct work request of ${claim.claimed_at} has no recorded outcome; the attempt is held and will not be retried in this idle episode`,
      unknownBinding(seat, claim));
    return;
  }
  if (claim.state === 'inflight') {
    const wakeAt = claim.wake_at === undefined ? Number.NaN : Date.parse(claim.wake_at);
    if (!Number.isFinite(wakeAt) || now - wakeAt < PICKUP_GRACE_MS) return;
    const claimed = claimedSince(input, seat, wakeAt);
    const settled = settleIdleClaim(input.dir, {
      session,
      seat,
      idle_since: claim.idle_since,
      claim_id: claim.claim_id,
      at: input.now,
      outcome: 'pickup',
      claimed,
    });
    if (settled.kind !== 'settled') return;
    if (claimed || settled.claim.notice !== 'stalled') return;
    replayNotice(input, result, claim.claim_id, 'stalled', seat, stalledText(input, seat),
      stalledBinding(seat, claim));
    return;
  }
  if (claim.state === 'refused') {
    if (claim.notice !== 'refused') return;
    // The record keeps no route, so this replay cannot say whether the route's typed fallback
    // was tried: it says only what is true of every refused claim, and promises no keystroke it
    // cannot prove.
    replayNotice(input, result, claim.claim_id, 'push', seat,
      `${input.team.project}: ${seat} is idle with takeable work and its direct work request was refused earlier in this idle episode; the attempt is spent and will not be repeated`,
      pushBinding(seat, claim));
    return;
  }
  // done: the pickup check is over; only the notice it may still owe is replayed.
  if (claim.notice === 'stalled') {
    replayNotice(input, result, claim.claim_id, 'stalled', seat, stalledText(input, seat),
      stalledBinding(seat, claim));
  }
}

function sinceOf(report: IdleWorkReport, seat: string): string {
  return report.idle.find((item) => item.seat === seat)?.since ?? 'watch-start';
}

function pushBinding(seat: string, claim: IdleClaim): string {
  return `push${SEP}${seat}${SEP}${claim.idle_since}${SEP}${claim.claim_id}`;
}

function stalledBinding(seat: string, claim: IdleClaim): string {
  return `stalled${SEP}${seat}${SEP}${claim.idle_since}${SEP}${claim.claim_id}${SEP}${claim.wake_at ?? claim.claimed_at}`;
}

function unknownBinding(seat: string, claim: IdleClaim): string {
  return `unknown${SEP}${seat}${SEP}${claim.idle_since}${SEP}${claim.claim_id}`;
}

function refusalText(input: IdleDispatchInput, seat: string, refused: string): string {
  const tail = typedFallbackRefused(refused)
    ? 'its typed fallback did not take it'
    : 'nothing was typed for it';
  return `${input.team.project}: ${seat} is idle with takeable work but was not told directly (${refused}); ${tail}`;
}

function stalledText(input: IdleDispatchInput, seat: string): string {
  return `${input.team.project}: ${seat} accepted a work wake a minute ago and is still idle with no observed claim; it will not be woken again in this idle episode`;
}

/**
 * The empty-source announcement: one aggregate notice per continuous idle-and-empty stretch.
 * The stretch's signature is the idle seats and their clocks, so the same stretch is never
 * announced twice, while a changed cast or a later stretch is.
 */
function noticeEmpty(
  input: IdleDispatchInput,
  report: IdleWorkReport,
  scope: string,
  result: IdleDispatchResult,
): void {
  const signature = report.idle.map((item) => `${item.seat}@${item.since ?? 'watch-start'}`).join(',');
  if (emptyNotices.get(scope)?.signature === signature) return;
  const seq = ++emptyNoticeSeq;
  emptyNotices.set(scope, { signature, seq });
  const names = report.idle.map((item) => item.seat).join(', ');
  mergeDelivery(result, announce(input, 'empty', 'idle',
    `${input.team.project}: ${report.idle.length} idle, nothing queued (${names})`,
    `empty${SEP}${signature}${SEP}${seq}`));
}

/**
 * Read-only evidence that the woken seat claimed something: a live lease it holds in this clone,
 * or a persisted activity clock at or past the wake instant. The transport's outcome and any
 * read receipt are never claim proof.
 */
function claimedSince(input: IdleWorkInput, seat: string, wakeAt: number): boolean {
  const last = input.state.seats[seat]?.last_active;
  if (last !== undefined) {
    const at = Date.parse(last);
    if (Number.isFinite(at) && at >= wakeAt) return true;
  }
  return liveLeases(input.root, input.now.getTime()).some((lease) => lease.seat === seat);
}

/** The route's one call. A request that cannot be built is a refusal, not a second path. */
async function attempt(
  input: IdleDispatchInput,
  seat: string,
): Promise<{ pushed: PushedWork }> {
  if (input.push === undefined) {
    return { pushed: { seat, ok: false, refused: 'no direct work route is wired' } };
  }
  if (input.live === null) {
    return { pushed: { seat, ok: false, refused: 'herdr gave no live read this pass' } };
  }
  const agent = input.live.agents.find((candidate) => candidate.name === seat);
  if (agent === undefined) {
    return { pushed: { seat, ok: false, refused: 'herdr named no pane for the seat' } };
  }
  const fileSeat = input.team.seats.find((candidate) => candidate.name === seat);
  if (fileSeat === undefined) {
    return { pushed: { seat, ok: false, refused: 'the team file names no seat of that name' } };
  }
  const request: WorkPushRequest = { seat, pane: agent.pane, cli: fileSeat.cli, body: input.body(seat) };
  try {
    const outcome = await input.push(request);
    if (outcome.ok) return { pushed: { seat, ok: true, outcome: outcome.outcome } };
    return { pushed: { seat, ok: false, refused: outcome.refused } };
  } catch (error) {
    return { pushed: { seat, ok: false, refused: error instanceof Error ? error.message : String(error) } };
  }
}

/** Publishes one claim's owed notice unless this process already did. A new process holds no
 *  key and publishes from the claim's `notice`; the deterministic `once: true` ids keep an
 *  already-written record from being rewritten. A publication with a failed or unmapped target
 *  stays owed, so the next pass of this process retries it: the targets already written are
 *  found by their ids and a target that could not be written can recover. The work itself is
 *  never pushed again. */
function replayNotice(
  input: IdleDispatchInput,
  result: IdleDispatchResult,
  claim_id: string,
  kind: 'push' | 'stalled' | 'unknown',
  seat: string,
  text: string,
  binding: string,
): void {
  if (publishedNotices.has(claim_id)) return;
  const delivery = announce(input, kind, seat, text, binding);
  mergeDelivery(result, delivery);
  if (delivery.failed.length === 0 && delivery.missing.length === 0) publishedNotices.add(claim_id);
}

function mergeDelivery(result: IdleDispatchResult, delivery: FallbackDelivery): void {
  const prior = result.fallback;
  if (prior === undefined) {
    result.fallback = delivery;
    return;
  }
  prior.written.push(...delivery.written);
  prior.failed.push(...delivery.failed);
  prior.missing.push(...delivery.missing);
}

/**
 * One announcement. The recipients are the team lead (its mailbox in this root) and the main
 * orchestrator (the entity's lead, in the entity's root, as the prompt climb resolves it); when
 * the registry cannot map the main, that target is reported missing rather than replaced with an
 * owner or a guessed seat. Each record's id binds the recipient, the kind, the subject and the
 * sentence's subject — the episode (or the claim), so a replay of the same notice is the same
 * record — and `once: true` keeps a re-run from rewriting the first record.
 */
function announce(
  input: IdleDispatchInput,
  kind: 'push' | 'empty' | 'stalled' | 'unknown',
  subject: string,
  text: string,
  binding: string,
): FallbackDelivery {
  const delivery: FallbackDelivery = { written: [], failed: [], missing: [] };
  const told = new Set<string>();
  const write = (role: string, target: { root: string; session: string; seat: string }): void => {
    const canonical = `${target.root}${SEP}${target.session}${SEP}${target.seat}`;
    if (told.has(canonical)) return;
    told.add(canonical);
    if (input.home === undefined) {
      delivery.missing.push(`${role} ${target.seat} was not told: there is no home to sign the record with`);
      return;
    }
    const stamp = createHash('sha256')
      .update(`${role}${SEP}${canonical}${SEP}${binding}`)
      .digest('hex')
      .slice(0, 16);
    const outcome = writeRuntimeMailboxRecord({
      root: target.root,
      home: input.home,
      to: target.seat,
      id: `evt-work-${kind}-${role}-${subject}-${stamp}`,
      text,
      session: target.session,
      at: input.now.toISOString(),
      once: true,
    });
    if (outcome.ok) delivery.written.push(outcome.path);
    else delivery.failed.push(`${target.seat} was not told: ${outcome.error}`);
  };

  if (input.team.orchestrator !== '') {
    write('lead', { root: input.root, session: input.team.session, seat: input.team.orchestrator });
  } else {
    delivery.missing.push('the team lead was not told: the team file names no lead');
  }
  const main = input.home === undefined
    ? null
    : readEntityOrchestrator(input.home, teamIdOf(input.root));
  if (main === null) {
    delivery.missing.push('the main orchestrator was not told: the registry maps no entity lead for this team');
  } else {
    write('main', main);
  }
  return delivery;
}
