import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  describeCaller,
  detachedRefusal,
  fileOwnerRefusal,
  isOwner,
  judgeCallerIn,
  mayChangeTeamVerdict,
  noPaneRefusal,
  standingOf,
  walkCaller,
  type Caller,
  type CallerVerdict,
} from '../caller.ts';
import { charterGate } from '../charter/check.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { currentTeam } from '../file/current.ts';
import { rulesOriginOf, type RulesOrigin } from '../launch/rules.ts';
import type { Seat, TeamFile } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';
import { teamIdOf } from '../registry/teams.ts';
import { readState, type QueuedSwap } from '../state.ts';
import { WAIT_FOR, waitSecondsFor } from '../swap/auto.ts';
import {
  cancelSwap,
  enqueueSwap,
  forceSwap,
  queuedSwap,
  queuedSwaps,
  swapLine,
  swapModelOf,
  type QueueRequest,
} from '../swap/queue.ts';
import { findRecipe, listModelRuleBreaches, type ModelRecipe, type RuleDonor, type RuleListing } from '../swap/rule.ts';
import { runDueSwaps, runOneSwap, type SwapRunOptions, type SwapRunResult } from '../swap/run.ts';
import { realSources, type RestartSources } from './restart.ts';

// `team swap` is the command family for the entity's model rule and the queued swap
// (Policies rules 10 and 11). The rule is read
// from the entity policy source; a breach is a seat whose team file declares a vendor the rule
// forbids; the replacement is a recipe copied from a seat already running in the entity, never
// invented. The queue is the project's, like the hold and the pause, and the watch carries it
// out at the seat's boundary. This command owns the queue and the listing; the run is the
// watch's, or `team swap --run` for a team whose watch is not running.

export const USAGE = `Usage: team swap [--file <path>] [--json]
       team swap --rule [--file <path>] [--json]
       team swap queue <seat> [--to <target>] [--file <path>] [--json]
       team swap now <seat> [--file <path>] [--json]
       team swap cancel <seat> [--file <path>] [--json]
       team swap --run [--file <path>] [--json]

A <target> is <cli>:<model>, and the recipe is copied from a seat of the entity that already runs it.
Exits 0 when the queue or the listing is shown, or a swap is queued, forced, run or cancelled, 1 when refused, a run failed or the entity rule cannot be read, 2 when the invocation or team file is invalid.
`;

export type SwapCommandOptions = {
  home?: string;
  now?: Date | (() => Date);
  sources?: RestartSources;
  /** The caller's fresh per-seat native channel health, when it has a provider. Unset leaves
   *  every native projection unproven, so the run holds such a seat. */
  presenceChannelHealthy?: (seat: string) => boolean;
  /** The credential store a charter signature is confirmed against. Absent: the system one. */
  ownerSeatStore?: OwnerSeatKeyStore;
};

function resolveNow(now: Date | (() => Date) | undefined): Date {
  if (typeof now === 'function') return now();
  return now ?? new Date();
}

export const swap: Command = (argv, io) => runSwap(argv, io);
export default swap;

/** Every way the command ends; the numeric code is chosen once, below. */
type Outcome =
  | 'listed'
  | 'queued'
  | 'forced'
  | 'ran'
  | 'cancelled'
  | 'invocation'
  | 'file'
  | 'caller'
  | 'detached'
  | 'herdr'
  | 'io'
  | 'not-queued'
  | 'rule'
  | 'run-failed'
  | 'seat'
  | 'target'
  | 'unchanged';

/** What `execute` hands the async half: `team swap --run` drains the queue, and `team swap now`
 *  forces one record and runs it at once. */
type RunPlan = {
  plan: true;
  dir: string;
  root: string;
  home: string;
  /** The team file's path: the run writes the new declaration there and launches from it. */
  path: string;
  team: TeamFile;
  session: string;
  io: Io;
  rawIo: Io;
  json: boolean;
  base: Base;
  /** The words the log carries as the caller. */
  by: string;
  owner: boolean;
  now: Date;
  sources: RestartSources;
  /** The caller's per-seat native channel health, when it has a provider. */
  presenceChannelHealthy?: (seat: string) => boolean;
  /** `team swap now`: the seat it forced and the record it stands on; absent for `--run`. */
  forcedSeat?: { seat: Seat; record: QueuedSwap; donor: RuleDonor | null };
  /** Registry wording when the team was read from the registry; file wording for a real team.yaml. */
  rulesOrigin?: RulesOrigin;
};

export async function runSwap(argv: string[], rawIo: Io, options: SwapCommandOptions = {}): Promise<number> {
  const executed = execute(argv, rawIo, options);
  const outcome = typeof executed === 'string' ? executed : await performRun(executed);
  if (outcome === 'invocation') {
    return 2; // exit: swap.invocation
  }
  if (outcome === 'file') {
    return 2; // exit: swap.file
  }
  if (outcome === 'caller') {
    return 1; // exit: swap.caller
  }
  if (outcome === 'detached') {
    return 1; // exit: swap.detached
  }
  if (outcome === 'herdr') {
    return 1; // exit: swap.herdr
  }
  if (outcome === 'io') {
    return 1; // exit: swap.io
  }
  if (outcome === 'not-queued') {
    return 1; // exit: swap.not-queued
  }
  if (outcome === 'rule') {
    return 1; // exit: swap.rule
  }
  if (outcome === 'run-failed') {
    return 1; // exit: swap.run-failed
  }
  if (outcome === 'seat') {
    return 1; // exit: swap.seat
  }
  if (outcome === 'target') {
    return 1; // exit: swap.target
  }
  if (outcome === 'unchanged') {
    return 1; // exit: swap.unchanged
  }
  if (outcome === 'listed') {
    return 0; // exit: swap.listed
  }
  if (outcome === 'queued') {
    return 0; // exit: swap.queued
  }
  if (outcome === 'ran') {
    return 0; // exit: swap.ran
  }
  if (outcome === 'forced') {
    return 0; // exit: swap.forced
  }
  return 0; // exit: swap.cancelled
}

type Sub = 'view' | 'rule' | 'queue' | 'now' | 'cancel' | 'run';

function execute(argv: string[], rawIo: Io, options: SwapCommandOptions): Outcome | RunPlan {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['to', 'file'], ['rule', 'json', 'run']);
  const home = options.home ?? homedir();
  const now = resolveNow(options.now);

  if (args.error !== undefined) return invocation(rawIo, io, json, plainText(args.error));
  const name = args.rest[0];
  const ruleView = args.flags.has('rule');
  const runFlag = args.flags.has('run');
  let sub: Sub;
  if (runFlag && (name !== undefined || ruleView)) {
    return invocation(rawIo, io, json, '--run takes no subcommand and no seat');
  } else if (runFlag) sub = 'run';
  else if (name === undefined) sub = ruleView ? 'rule' : 'view';
  else if (ruleView) return invocation(rawIo, io, json, '--rule takes no subcommand');
  else if (name === 'queue' || name === 'now' || name === 'cancel') sub = name;
  else {
    return invocation(
      rawIo,
      io,
      json,
      `unexpected "${plainLine(name)}"; expected "queue", "now", "cancel", "--rule", "--run", or no subcommand`,
    );
  }
  if (args.values.to !== undefined && sub !== 'queue') {
    return invocation(rawIo, io, json, '--to belongs to `team swap queue <seat>`');
  }
  const withSeat = sub === 'queue' || sub === 'now' || sub === 'cancel';
  const seatName = withSeat ? args.rest[1] : undefined;
  const extra = args.rest[2];
  if (withSeat && seatName === undefined) {
    return invocation(rawIo, io, json, `a <seat> is required for "swap ${sub}"`);
  }
  if (extra !== undefined) return invocation(rawIo, io, json, `unexpected "${plainLine(extra)}"`);

  const walked = walkCaller(rawIo);
  const gate = charterGate(home, { operation: 'swap', cwd: rawIo.cwd }, options.ownerSeatStore);
  if (gate.kind === 'block') {
    refuse(rawIo, io, json, 'swap.caller', plainText(gate.message), `the owner widens the charter with team setup --edit`, undefined, 'owner-or-leads');
    return 'caller';
  }
  const covered = gate.kind === 'admit';
  const owner = isOwner(walked) || covered;

  if (sub === 'now' && !covered) {
    // `team swap now` is the owner's alone: forcing the swap is the owner's word.
    const detached = detachedRefusal(walked, { who: 'the owner', where: 'a terminal outside herdr or its own seat' });
    if (detached !== undefined) {
      refuse(rawIo, io, json, 'swap.detached', plainText(detached), null, undefined, 'owner-only');
      return 'detached';
    }
    if (!owner) {
      refuse(
        rawIo,
        io,
        json,
        'swap.caller',
        `only the owner forces a swap; this call is ${describeCaller(walked)}`,
        null,
        undefined,
        'owner-only',
      );
      return 'caller';
    }
  }

  if (args.values.file !== undefined && !owner) {
    const refusal = fileOwnerRefusal(rawIo, args.values.file);
    if (refusal !== undefined) {
      refuse(
        rawIo,
        io,
        json,
        'swap.caller',
        plainText(refusal),
        'the owner runs `team swap --file <path>` from a terminal outside herdr',
        undefined,
        'owner-only',
      );
      return 'caller';
    }
  }

  const current = currentTeam(rawIo.cwd, owner ? args.values.file : undefined, now, home, owner);
  if (!current.ok) {
    if (!owner) {
      // The same one sentence every read refusal prints: an unapproved caller learns no detail.
      refuse(rawIo, io, json, 'swap.caller', 'this team is not yours to read', null, undefined, 'team-read');
      return 'caller';
    }
    const messages = current.errors.map(
      (problem) => `${problem.line ? `team config line ${problem.line}: ` : ''}${plainText(problem.message)}`,
    );
    if (json) writeJsonError(rawIo, 'swap.file', messages.join('; '), null);
    else for (const message of messages) io.stderr(`team swap: ${message}\n`);
    return 'file';
  }
  const { team, root, dir } = current;
  const notice = current.notice ? plainText(current.notice) : undefined;
  if (notice !== undefined && !json) io.stdout(`${notice}\n`);

  if ((sub === 'queue' || sub === 'cancel' || sub === 'run') && !covered) {
    const judged = judgeCallerIn(rawIo, dir, team);
    const verdict = mayChangeTeamVerdict(judged.caller, team, standingOf(dir, judged.session, judged.caller));
    if (verdict.kind !== 'ok') {
      refuse(rawIo, io, json, 'swap.caller', verdictRefusal(verdict, judged.caller), repairOf(verdict), notice, 'owner-or-leads');
      return 'caller';
    }
  } else if (!owner && !mayReadTeam(current, rawIo, { home })) {
    refuse(rawIo, io, json, 'swap.caller', 'this team is not yours to read', null, notice, 'team-read');
    return 'caller';
  }

  const base: Base = { project: team.project, session: team.session, entity: team.entity, notice: notice ?? null };
  if (sub === 'view') return view(rawIo, io, json, team, dir, now, base);
  if (sub === 'rule') return ruleListing(rawIo, io, json, team, root, home, base);

  if (sub === 'run' || sub === 'now') {
    // A run writes the file's new declaration and launches from it: the saved copy an invalid
    // file fell back to is not where either may happen.
    if (current.path === undefined || notice !== undefined) {
      const msg = 'team config is invalid, so a swap cannot write the new declaration or launch from it';
      if (json) writeJsonError(rawIo, 'swap.file', msg, null);
      else io.stderr(`team swap: ${msg}\n`);
      return 'file';
    }
    if (sub === 'run') {
      return {
        plan: true,
        dir,
        root,
        home,
        path: current.path,
        team,
        session: team.session,
        io,
        rawIo,
        json,
        base,
        by: describeCaller(walked),
        owner,
        now,
        sources: options.sources ?? realSources,
        rulesOrigin: rulesOriginOf(current.source),
        ...(options.presenceChannelHealthy === undefined ? {} : { presenceChannelHealthy: options.presenceChannelHealthy }),
      };
    }
  }

  const seat = team.seats.find((candidate) => candidate.name === seatName) ?? null;
  if (!seat) {
    const msg = `no seat "${plainLine(seatName ?? '')}" is declared in ${team.project}`;
    if (json) writeJsonError(rawIo, 'swap.seat', msg, null, 1, null, notice);
    else io.stderr(`team swap: ${msg}\n`);
    return 'seat';
  }

  if (sub === 'cancel') {
    let held: QueuedSwap | null;
    try {
      held = cancelSwap(dir, seat.name);
    } catch (error) {
      refuse(rawIo, io, json, 'swap.io', `the state cannot be written: ${(error as Error).message}`, null, notice, null);
      return 'io';
    }
    if (!held) {
      const msg = `${seat.name} waits on no swap`;
      if (json) writeJsonError(rawIo, 'swap.not-queued', msg, null, 1, null, notice);
      else io.stderr(`team swap: ${msg}\n`);
      return 'not-queued';
    }
    logLine(dir, 'swap', describeCaller(walked), `${seat.name}: cancelled`, now);
    if (json) {
      writeJson(rawIo, 'team.swap', {
        ...base,
        format: 1,
        dry_run: false,
        status: 'cancelled',
        action_summary: `swap: ${seat.name} cancelled`,
        seat: seat.name,
        swap: held,
      });
    } else {
      io.stdout(`swap cancelled: ${seat.name}\n`);
    }
    return 'cancelled';
  }

  // The plan a forced `now` runs from. It is built before the rule is resolved, because an
  // existing request already carries its recipe and wait: the owner can force it even when the
  // entity has since removed its rule, or the request came from configuration.
  const plan = {
    plan: true as const,
    dir,
    root,
    home,
    // The check above refused `run` and `now` on an invalid file; a `queue` never hands this on.
    path: current.path as string,
    team,
    session: team.session,
    io,
    rawIo,
    json,
    base,
    by: describeCaller(walked),
    owner,
    now,
    sources: options.sources ?? realSources,
    rulesOrigin: rulesOriginOf(current.source),
    ...(options.presenceChannelHealthy === undefined ? {} : { presenceChannelHealthy: options.presenceChannelHealthy }),
  };

  if (sub === 'now') {
    const held = queuedSwap(readState(dir), seat.name);
    if (held) return forcedPlan(plan, seat, held, null);
  }

  // A new `queue` or `now` request needs the wait in force, the rule, and the recipe.
  const wait = waitSecondsFor(home, root, team, seat, now);
  if ('why' in wait) {
    refuse(rawIo, io, json, 'swap.rule', plainText(wait.why), null, notice, null);
    return 'rule';
  }
  let listing: RuleListing;
  try {
    const lookup = listModelRuleBreaches({ home, team, root, teamId: teamIdOf(root) });
    if (!lookup.ok) {
      refuse(rawIo, io, json, 'swap.rule', plainText(lookup.why), null, notice, null);
      return 'rule';
    }
    listing = lookup.listing;
  } catch (error) {
    refuse(rawIo, io, json, 'swap.rule', `the model rule cannot be read: ${(error as Error).message}`, null, notice, null);
    return 'rule';
  }
  if (listing.rule === '') {
    const where = listing.entity === null ? 'this team declares no entity' : `the entity ${listing.entity} declares no model rule`;
    refuse(rawIo, io, json, 'swap.rule', `${where}, so there is nothing to swap to`, null, notice, null);
    return 'rule';
  }

  const choice = choose(sub, listing, root, seat, args.values.to);
  if (choice.kind === 'unchanged') {
    refuse(rawIo, io, json, 'swap.unchanged', choice.message, null, notice, null);
    return 'unchanged';
  }
  if (choice.kind === 'target') {
    refuse(rawIo, io, json, 'swap.target', choice.message, null, notice, null);
    return 'target';
  }
  const request: QueueRequest = {
    seat: seat.name,
    from: swapModelOf(seat),
    to: {
      cli: choice.recipe.cli,
      vendor: choice.recipe.vendor,
      model: choice.recipe.model,
      version: choice.recipe.version,
      display: choice.recipe.display,
      launch: choice.recipe.launch,
      ...(choice.recipe.modelFrom ? { modelFrom: choice.recipe.modelFrom } : {}),
      ...(choice.recipe.effort ? { effort: choice.recipe.effort } : {}),
      ...(choice.recipe.account ? { account: choice.recipe.account } : {}),
    },
    reason: sub === 'now' ? 'owner' : 'model-rule',
    waitSeconds: wait.seconds,
    waitFor: WAIT_FOR,
    rule: listing.rule,
    now,
  };
  let queued: QueuedSwap;
  try {
    queued = enqueueSwap(dir, request);
  } catch (error) {
    refuse(rawIo, io, json, 'swap.io', `the state cannot be written: ${(error as Error).message}`, null, notice, null);
    return 'io';
  }
  if (sub === 'now') {
    return forcedPlan(plan, seat, queued, choice.donor);
  }
  logLine(
    dir,
    'swap',
    describeCaller(walked),
    `${seat.name}: queued ${queued.from.cli} ${queued.from.model} -> ${queued.to.cli} ${queued.to.model} (${queued.to.vendor} ${queued.to.model} ${queued.to.version}), runs by ${queued.deadline}`,
    now,
  );
  if (json) {
    writeJson(rawIo, 'team.swap', {
      ...base,
      format: 1,
      dry_run: false,
      status: 'queued',
      action_summary: `swap: ${seat.name} queued`,
      seat: seat.name,
      swap: queued,
      donor: choice.donor,
    });
  } else {
    io.stdout(`swap queued: ${swapLine(seat.name, queued, now)}\n`);
  }
  return 'queued';
}

/** `team swap now`: force the record the queue already holds (or the one just queued) and hand
 *  the run to the async half. The force is written first, so a run that cannot start now leaves
 *  the record standing and the watch still carries it out. */
function forcedPlan(
  origin: Omit<RunPlan, 'forcedSeat'>,
  seat: Seat,
  held: QueuedSwap,
  donor: RuleDonor | null,
): Outcome | RunPlan {
  let record: QueuedSwap;
  try {
    record = forceSwap(origin.dir, seat.name, origin.by, origin.now) ?? held;
  } catch (error) {
    refuse(origin.rawIo, origin.io, origin.json, 'swap.io', `the state cannot be written: ${(error as Error).message}`, null, origin.base.notice ?? undefined, null);
    return 'io';
  }
  logLine(
    origin.dir,
    'swap',
    origin.by,
    `${seat.name}: forced now, ${record.from.cli} ${record.from.model} -> ${record.to.cli} ${record.to.model} (${record.to.vendor} ${record.to.model} ${record.to.version})`,
    origin.now,
  );
  if (!origin.json) origin.io.stdout(`swap forced: ${swapLine(seat.name, record, origin.now)}\n`);
  return { ...origin, forcedSeat: { seat, record, donor } };
}

/**
 * The async half: `team swap --run` drains the queue the way the watch would — each record at
 * its boundary, forced ones at once — and `team swap now` runs the one record it forced. A
 * swap that cannot start (a busy turn, a replaced pane) stays queued; a preflight refusal, a
 * signed-off seat or a read-back mismatch is a failure and the exit says so.
 */
async function performRun(origin: RunPlan): Promise<Outcome> {
  const { dir, root, home, path, team, session, io, rawIo, json, base, by, owner, now, sources, presenceChannelHealthy, forcedSeat } = origin;
  if (sources.agents(session) === null) {
    const what = forcedSeat ? 'the forced swap cannot run' : 'no swap can be run';
    refuse(rawIo, io, json, 'swap.herdr', `herdr cannot be read, so ${what} now`, null, base.notice ?? undefined, null);
    return 'herdr';
  }
  const notes: string[] = [];
  const options: SwapRunOptions = {
    dir,
    root,
    home,
    path,
    team,
    session,
    io,
    json,
    notes,
    sources,
    by,
    owner,
    ...(presenceChannelHealthy === undefined ? {} : { presenceChannelHealthy }),
    ...(origin.rulesOrigin === undefined ? {} : { rulesOrigin: origin.rulesOrigin }),
    now: () => now,
  };
  let results: SwapRunResult[];
  try {
    results = forcedSeat
      ? [await runOneSwap(options, forcedSeat.seat.name, forcedSeat.record)]
      : await runDueSwaps(options);
  } catch (error) {
    refuse(rawIo, io, json, 'swap.io', `the run could not be carried out: ${(error as Error).message}`, null, base.notice ?? undefined, null);
    return 'io';
  }

  let failed = false;
  for (const result of results) {
    if (result.kind === 'mismatch' || result.kind === 'failed') failed = true;
    if (json) continue;
    switch (result.kind) {
      case 'ready':
        io.stdout(
          `swapped: ${result.seat} in ${result.pane} (read-back ${result.readBack.kind === 'match' ? result.readBack.model : 'unread'})\n`,
        );
        break;
      case 'mismatch':
        io.stderr(
          `team swap: ${result.seat}: read-back: mismatch — the file declares ${result.readBack.expected}, the screen shows ${result.readBack.shown}; the swap failed\n`,
        );
        break;
      case 'failed':
        io.stderr(`team swap: ${result.seat}: ${result.why}\n`);
        break;
      case 'retry':
        io.stdout(`${result.seat}: stays queued (${result.why})\n`);
        break;
      case 'wait':
        io.stdout(`${result.seat}: stays queued (${result.why})\n`);
        break;
    }
  }

  if (json) {
    const swapped = results.filter((result) => result.kind === 'ready').length;
    writeJson(rawIo, 'team.swap', {
      ...base,
      format: 1,
      dry_run: false,
      status: failed ? 'run-failed' : forcedSeat ? 'forced' : 'ran',
      action_summary: `swap: ${forcedSeat ? `${forcedSeat.seat.name} forced` : 'run'}, ${swapped} swapped, ${results.length - swapped} left queued or failed`,
      ...(forcedSeat
        ? {
            seat: forcedSeat.seat.name,
            swap: forcedSeat.record,
            ...(forcedSeat.donor ? { donor: forcedSeat.donor } : {}),
          }
        : {}),
      results: results.map(resultDoc),
    });
  }
  if (failed) return 'run-failed';
  return forcedSeat ? 'forced' : 'ran';
}

/** One run result as the `--json` document carries it. */
function resultDoc(result: SwapRunResult): Record<string, unknown> {
  switch (result.kind) {
    case 'ready':
      return {
        seat: result.seat,
        result: 'swapped',
        old_pane: result.oldPane,
        pane: result.pane,
        read_back: result.readBack.kind === 'match' ? result.readBack.model : null,
        ...(result.resumed === undefined ? {} : { resumed: result.resumed }),
        ...(result.handover === undefined ? {} : { handover: result.handover }),
      };
    case 'mismatch':
      return {
        seat: result.seat,
        result: 'mismatch',
        old_pane: result.oldPane,
        pane: result.pane,
        read_back: null,
        why: `the file declares ${result.readBack.expected}, the screen shows ${result.readBack.shown}`,
      };
    case 'failed':
      return { seat: result.seat, result: 'failed', why: result.why };
    case 'retry':
      return { seat: result.seat, result: 'stays', why: result.why };
    case 'wait':
      return { seat: result.seat, result: 'stays', why: result.why };
  }
}

/** The recipe a `queue` or `now` will take, or the refusal it prints. */
type Choice =
  | { kind: 'recipe'; donor: RuleDonor; recipe: ModelRecipe }
  | { kind: 'unchanged'; message: string }
  | { kind: 'target'; message: string };

function choose(sub: Sub, listing: RuleListing, root: string, seat: Seat, to: string | undefined): Choice {
  if (sub === 'queue' && to !== undefined) {
    const want = parseTarget(to);
    if (typeof want === 'string') return { kind: 'target', message: want };
    const found = findRecipe(listing, seat, want);
    if (!found.ok) return { kind: 'target', message: plainText(found.why) };
    return { kind: 'recipe', donor: found.donor, recipe: found.recipe };
  }
  const breach = listing.breaches.find((entry) => entry.root === root && entry.seat.name === seat.name);
  if (!breach) {
    return {
      kind: 'unchanged',
      message: `${seat.name} declares a model the rule allows; there is nothing to swap to`,
    };
  }
  if (!breach.proposal) {
    return { kind: 'target', message: plainText(breach.reason ?? 'no recipe is available for this seat') };
  }
  return { kind: 'recipe', donor: breach.proposal.donor, recipe: breach.proposal.recipe };
}

/** The one sentence a refused caller reads; the placement is named, never the exact step. */
function verdictRefusal(verdict: CallerVerdict, caller: Caller): string {
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return `only the owner, the orchestrator or the operator queues, runs or cancels a swap; this call is ${describeCaller(caller)}`;
}

function repairOf(verdict: CallerVerdict): string | null {
  if (verdict.kind === 'no-pane') return 'team up';
  if (verdict.kind === 'another-pane') return 'team down && team up';
  return null;
}

function refuse(
  rawIo: Io,
  io: Io,
  json: boolean,
  id: string,
  message: string,
  repair: string | null,
  notice: string | undefined,
  rule: string | null,
): void {
  if (json) writeJsonError(rawIo, id, message, repair, 1, rule, notice);
  else io.stderr(`team swap: ${message}\n`);
}

function invocation(rawIo: Io, io: Io, json: boolean, message: string): Outcome {
  if (json) writeJsonError(rawIo, 'swap.invocation', message, null);
  else io.stderr(`team swap: ${message}\n${USAGE}`);
  return 'invocation';
}

type Base = { project: string; session: string; entity: string | null; notice: string | null };

/** `team swap`: what this team waits on. */
function view(rawIo: Io, io: Io, json: boolean, team: TeamFile, dir: string, now: Date, base: Base): Outcome {
  const queued = queuedSwaps(readState(dir));
  if (json) {
    writeJson(rawIo, 'team.swap', {
      ...base,
      format: 1,
      dry_run: false,
      status: 'listed',
      action_summary: `swap: ${team.project}, ${queued.length} queued`,
      swaps: queued.map(([seat, held]) => ({ seat, swap: held })),
    });
  } else {
    io.stdout(`swap: ${team.project}${team.entity ? ` (entity ${team.entity})` : ''}\n`);
    if (queued.length === 0) io.stdout('nothing queued\n');
    for (const [seat, held] of queued) io.stdout(`${swapLine(seat, held, now)}\n`);
  }
  return 'listed';
}

/** `team swap --rule`: every breach of the entity's rule, with the donor each recipe came from. */
function ruleListing(rawIo: Io, io: Io, json: boolean, team: TeamFile, root: string, home: string, base: Base): Outcome {
  const lookup = listModelRuleBreaches({ home, team, root, teamId: teamIdOf(root) });
  if (!lookup.ok) {
    refuse(rawIo, io, json, 'swap.rule', plainText(lookup.why), null, base.notice ?? undefined, null);
    return 'rule';
  }
  const listing = lookup.listing;
  if (json) {
    writeJson(rawIo, 'team.swap', {
      ...base,
      format: 1,
      dry_run: false,
      status: 'rule',
      action_summary: `swap: rule, ${listing.breaches.length} breaching`,
      rule: listing.rule,
      entries: listing.entries.map((entry) => ({ subject: entry.subject, allow: entry.allow, labs: [...entry.labs] })),
      teams: listing.teams.map((entry) => ({ id: entry.id, name: entry.name, root: entry.root, visibility: entry.visibility })),
      breaches: listing.breaches.map((breach) => ({
        team: breach.team,
        root: breach.root,
        visibility: breach.visibility,
        seat: breach.seat.name,
        role: breach.seat.role,
        vendor: breach.seat.vendor,
        model: breach.seat.model,
        proposal: breach.proposal,
        reason: breach.reason ?? null,
      })),
      ignored: listing.ignored,
    });
    return 'listed';
  }
  if (listing.entity === null) {
    io.stdout('rule: none (this team declares no entity)\n');
    return 'listed';
  }
  io.stdout(`rule: ${listing.rule === '' ? 'none' : listing.rule} (entity ${listing.entity})\n`);
  if (listing.breaches.length === 0) io.stdout('no breach\n');
  for (const breach of listing.breaches) {
    const proposal = breach.proposal
      ? ` -> ${breach.proposal.recipe.cli} ${breach.proposal.recipe.model} ${breach.proposal.recipe.version} from ${breach.proposal.donor.team}/${breach.proposal.donor.seat}`
      : ` (${breach.reason ?? 'no recipe'})`;
    io.stdout(`${breach.team}/${breach.seat.name}: role ${breach.seat.role}, vendor ${breach.seat.vendor}${proposal}\n`);
  }
  for (const entry of listing.ignored) io.stdout(`ignored: ${entry.root} (${entry.why})\n`);
  return 'listed';
}

/** `--to <cli>:<model>`, or the sentence saying how it is malformed. */
function parseTarget(text: string): { cli: string; model: string } | string {
  const colon = text.indexOf(':');
  if (colon <= 0 || colon === text.length - 1) return `--to takes <cli>:<model>, not "${text}"`;
  return { cli: text.slice(0, colon), model: text.slice(colon + 1) };
}
