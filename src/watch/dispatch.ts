// The idle-work dispatcher: the watch's one path from "these seats are idle and the picker
// would offer them work" to "each of them is told to take some". It reads the shared snapshot
// (`idleWorkReport`) once per pass and never picks, claims or leases on its own, so the watch
// cannot disagree with `status` about who is idle or what is takeable. One attempt is spent per
// seat per idle episode, refusals included; the episode ends only when a later reading no longer
// counts the seat. The old typed work nudge is suppressed for every episode this dispatcher
// owns, whether or not a direct route is wired: a seat the dispatcher cannot reach is told
// nothing rather than typed at by a second path.
import { createHash } from 'node:crypto';
import { writeRuntimeMailboxRecord } from '../bus/owner.ts';
import { readEntityOrchestrator } from '../bus/seats.ts';
import type { IdleWorkInput, IdleWorkReport } from '../idle_work.ts';
import { teamIdOf } from '../registry/teams.ts';
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

/** What one fallback announcement wrote, could not write, or could not map. `missing` names a
 *  recipient the registry does not resolve (the main orchestrator, usually): the limitation is
 *  said, and no identity is invented in its place. */
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
  /** Present when an unavailable or refused route had to be announced. One announcement per
   *  episode: the team lead and the main orchestrator, deduplicated when one target, each with
   *  its own signed runtime mailbox record. */
  fallback?: FallbackDelivery;
};

/** The seats an idle episode is owed an attempt for: every seat the snapshot counted idle, when
 *  the window is known and the source shows at least one takeable record. A reading that cannot
 *  be trusted (unknown threshold, unreadable source) dispatches nothing and resets nothing: the
 *  dispatcher cannot tell a seat that left its episode from a reading it could not take. */
function eligibleSeatsOf(report: IdleWorkReport): string[] | null {
  if (report.threshold_unknown !== undefined) return null;
  if (report.takeable === null) return null;
  if (report.takeable === 0) return [];
  return report.idle.map((seat) => seat.seat);
}

const SEP = '\u0000';
/** The in-process episode ledger. Keyed by root, session and seat; a seat's entry is spent on
 *  its one attempt and removed only when an actionable reading no longer counts it idle. */
const spent = new Map<string, true>();

function scopeOf(input: IdleWorkInput): string {
  return `${input.root}${SEP}${input.team.session}`;
}

function episodeKey(scope: string, seat: string): string {
  return `${scope}${SEP}${seat}`;
}

/** Test and restart seam: forget every episode. A watch process's own restart starts the idle
 *  stretches again, exactly as the typed nudge's process memory already does. */
export function forgetIdleEpisodes(): void {
  spent.clear();
}

/**
 * One dispatch pass. The snapshot is read here, once; nothing else is read to pick work. Each
 * eligible seat with no attempt in this episode is pushed its body through `push`, when one is
 * wired, and the attempt is spent before the route is called, so a throw still spends it. An
 * unavailable or refused route leaves one fallback announcement per episode, written as signed
 * runtime mailbox records to the team lead and the main orchestrator through the same machinery
 * a prompt climb uses. No bus event kind is invented; no owner identity is used here.
 */
export async function dispatchIdleWork(input: IdleDispatchInput): Promise<IdleDispatchResult> {
  const report = idleWorkReport(input);
  const eligible = eligibleSeatsOf(report);
  if (eligible === null) return { pushed: [] };
  const scope = scopeOf(input);
  const current = new Set(eligible.map((seat) => episodeKey(scope, seat)));
  for (const key of [...spent.keys()]) {
    if (key.startsWith(`${scope}${SEP}`) && !current.has(key)) spent.delete(key);
  }
  if (eligible.length === 0) return { pushed: [] };

  const result: IdleDispatchResult = { pushed: [], suppressed: [...eligible] };
  for (const seat of eligible) {
    const key = episodeKey(scope, seat);
    if (spent.has(key)) continue;
    spent.set(key, true);
    const outcome = await attempt(input, seat);
    result.pushed.push(outcome.pushed);
    if (outcome.pushed.ok) continue;
    const delivery = announceFallback(input, report, seat, outcome.pushed.refused);
    const prior = result.fallback;
    if (prior === undefined) {
      result.fallback = delivery;
    } else {
      prior.written.push(...delivery.written);
      prior.failed.push(...delivery.failed);
      prior.missing.push(...delivery.missing);
    }
  }
  return result;
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

/**
 * The unavailable/refused route's one announcement. The recipients are the team lead (its
 * mailbox in this root) and the main orchestrator (the entity's lead, in the entity's root, as
 * the prompt climb resolves it); when the registry cannot map the main, that target is reported
 * missing rather than replaced with an owner or a guessed seat. Each record's id binds the
 * recipient and the episode, and `once: true` keeps a re-run from rewriting the first record.
 */
function announceFallback(
  input: IdleDispatchInput,
  report: IdleWorkReport,
  seat: string,
  reason: string,
): FallbackDelivery {
  const delivery: FallbackDelivery = { written: [], failed: [], missing: [] };
  const text = `${input.team.project}: ${seat} is idle with takeable work but was not told directly (${reason}); nothing was typed for it`;
  const since = report.idle.find((item) => item.seat === seat)?.since ?? null;
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
      .update(`${role}${SEP}${canonical}${SEP}${seat}${SEP}${since ?? 'watch-start'}`)
      .digest('hex')
      .slice(0, 16);
    const outcome = writeRuntimeMailboxRecord({
      root: target.root,
      home: input.home,
      to: target.seat,
      id: `evt-work-push-${role}-${seat}-${stamp}`,
      text,
      session: target.session,
      at: input.now.toISOString(),
      once: true,
    });
    if (outcome.ok) delivery.written.push(outcome.path);
    else delivery.failed.push(`${target.seat} was not told of ${seat}'s stalled work route: ${outcome.error}`);
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
