// The idle-work dispatcher: the watch's one path from "these seats are idle and the picker
// would offer them work" to "each of them is told to take some". It reads the shared snapshot
// (`idleWorkReport`) once per pass and never picks, claims or leases on its own, so the watch
// cannot disagree with `status` about who is idle or what is takeable. One attempt is spent per
// seat per idle episode, refusals included; the episode ends only when a later reading no longer
// counts the seat. The old typed work nudge is suppressed for every episode this dispatcher
// owns, whether or not a direct route is wired: a seat the dispatcher cannot reach is told
// nothing rather than typed at by a second path.
//
// Two production readings leave the dispatcher with nothing to deliver, and each says so once
// through the same lead+main announcement: a source with zero takeable records while seats sit
// idle ("N idle, nothing queued"), and a seat still idle a minute after an accepted wake with no
// read-only evidence that it claimed anything (the failed pickup). Both are observations of the
// pass clock; nothing here sleeps, starts a timer or re-wakes a seat.
import { createHash } from 'node:crypto';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator } from '../bus/seats.ts';
import type { IdleWorkInput, IdleWorkReport } from '../idle_work.ts';
import { teamIdOf } from '../registry/teams.ts';
import { liveLeases } from '../tasks/lease.ts';
import { idleWorkReport } from './idle-work.ts';

/** The direct route's request: the seat, the pane and CLI the pass read for it, and the body
 *  already rendered from `watch.nudge`. It is the same shape a work drop carries today. */
export type WorkPushRequest = { seat: string; pane: string; cli: string; body: string };

/** The route's honest answer. `outcome` is the transport's own word and is always required: a
 *  route never flattens `code0`, a held delivery or a durable copy into a successful wake. A
 *  push result is never read or claim proof. */
export type WorkPushResult = { ok: true; outcome: string } | { ok: false; refused: string };

/** The direct route a watch's sources may wire. Absent, this dispatcher sends nothing and types
 *  nothing; it never falls back to a keystroke of its own. */
export type WorkPush = (request: WorkPushRequest) => Promise<WorkPushResult>;

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
  /** The body a pushed seat is told, rendered per seat by the caller. */
  body: (seat: string) => string;
  push?: WorkPush;
};

export type IdleDispatchResult = {
  /** One entry per attempt made in this call, including refusals. A seat already attempted in
   *  this episode is not attempted again and does not appear here. */
  pushed: PushedWork[];
  /** Every eligible seat whose old typed work nudge this pass must not type: the episodes
   *  attempted now and the episodes attempted earlier in the same idle stretch. */
  suppressed?: string[];
  /** Present when an announcement had to be written: an unavailable or refused route, an empty
   *  source with idle seats, or a failed pickup. One announcement per episode and subject: the
   *  team lead and the main orchestrator, deduplicated when one target, each with its own signed
   *  runtime mailbox record. */
  fallback?: FallbackDelivery;
};

/** How long an accepted wake may take to show a real claim or activity before the episode is
 *  reported once as a failed pickup. The watch's own pass clock measures it. */
const PICKUP_GRACE_MS = 60_000;

const SEP = '\u0000';

/** One seat's idle episode in this process: opened with its one attempt, and, when a route
 *  accepted it, closed out at the first pass past the pickup grace. A refused or unwired route
 *  leaves `wakeAt` absent, so it is never read as a wake that failed. */
type Episode = {
  /** The pass clock at which the route accepted the wake. */
  wakeAt?: number;
  /** The grace was handled (a notice written, or activity seen); never handled twice. */
  settled?: boolean;
};

/** The in-process episode ledger. Keyed by root, session and seat; an entry is removed only when
 *  an actionable reading no longer counts the seat idle. */
const episodes = new Map<string, Episode>();

/** The empty-source notice ledger, keyed by scope: the signature of the idle stretch already
 *  announced. Removed when nothing is idle or the source has takeable work, so a later empty
 *  stretch is a new notice. */
const emptyNotices = new Map<string, { signature: string; seq: number }>();
let emptyNoticeSeq = 0;

function scopeOf(input: IdleWorkInput): string {
  return `${input.root}${SEP}${input.team.session}`;
}

function episodeKey(scope: string, seat: string): string {
  return `${scope}${SEP}${seat}`;
}

/** Test and restart seam: forget every episode. A watch process's own restart starts the idle
 *  stretches again, exactly as the typed nudge's process memory already does. */
export function forgetIdleEpisodes(): void {
  episodes.clear();
  emptyNotices.clear();
  emptyNoticeSeq = 0;
}

/**
 * One dispatch pass. The snapshot is read here, once; nothing else is read to pick work. Each
 * eligible seat with no attempt in this episode is pushed its body through `push`, when one is
 * wired, and the attempt is spent before the route is called, so a throw still spends it. An
 * unavailable or refused route leaves one fallback announcement per episode. A seat whose route
 * accepted the wake is checked again at the first pass a minute later: a live lease it holds or
 * an activity clock past the wake counts as a claim and settles the episode silently; a seat
 * still idle with neither is announced once and never woken again in that episode. An actionable
 * reading with zero takeable records announces the empty stretch once; an unreadable reading
 * (unknown threshold, unreadable source) announces nothing and resets nothing. Every record is
 * written as a signed runtime mailbox record to the team lead and the main orchestrator through
 * the same machinery a prompt climb uses. No bus event kind is invented; no owner identity is
 * used here.
 */
export async function dispatchIdleWork(input: IdleDispatchInput): Promise<IdleDispatchResult> {
  const report = idleWorkReport(input);
  // A reading that cannot be trusted dispatches nothing, announces nothing and resets nothing:
  // the dispatcher cannot tell a seat that left its episode from a reading it could not take.
  if (report.threshold_unknown !== undefined || report.takeable === null) return { pushed: [] };
  const scope = scopeOf(input);
  const result: IdleDispatchResult = { pushed: [] };

  if (report.takeable === 0) {
    endEpisodes(scope, new Set());
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
  // episode (and any pending pickup check) behind.
  emptyNotices.delete(scope);
  const eligible = report.idle.map((item) => item.seat);
  endEpisodes(scope, new Set(eligible.map((seat) => episodeKey(scope, seat))));
  if (eligible.length === 0) return result;
  result.suppressed = [...eligible];

  const now = input.now.getTime();
  for (const seat of eligible) {
    const key = episodeKey(scope, seat);
    const episode = episodes.get(key);
    if (episode === undefined) {
      const opened: Episode = {};
      episodes.set(key, opened);
      const outcome = await attempt(input, seat);
      result.pushed.push(outcome.pushed);
      if (outcome.pushed.ok) {
        opened.wakeAt = now;
        continue;
      }
      mergeDelivery(result, announce(input, 'push', seat,
        `${input.team.project}: ${seat} is idle with takeable work but was not told directly (${outcome.pushed.refused}); nothing was typed for it`,
        `push${SEP}${seat}${SEP}${sinceOf(report, seat)}`));
      continue;
    }
    if (episode.wakeAt === undefined || episode.settled === true) continue;
    if (now - episode.wakeAt < PICKUP_GRACE_MS) continue;
    episode.settled = true;
    if (claimedSince(input, seat, episode.wakeAt)) continue;
    mergeDelivery(result, announce(input, 'stalled', seat,
      `${input.team.project}: ${seat} accepted a work wake a minute ago and is still idle with no observed claim; it will not be woken again in this idle episode`,
      `stalled${SEP}${seat}${SEP}${episode.wakeAt}`));
  }
  return result;
}

/** Drops every episode in this scope the current reading no longer counts. A seat that left
 *  eligibility cancels its pending pickup check with it. */
function endEpisodes(scope: string, current: ReadonlySet<string>): void {
  for (const key of [...episodes.keys()]) {
    if (key.startsWith(`${scope}${SEP}`) && !current.has(key)) episodes.delete(key);
  }
}

function sinceOf(report: IdleWorkReport, seat: string): string {
  return report.idle.find((item) => item.seat === seat)?.since ?? 'watch-start';
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
 * episode, and `once: true` keeps a re-run from rewriting the first record.
 */
function announce(
  input: IdleDispatchInput,
  kind: 'push' | 'empty' | 'stalled',
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
