import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  describeCaller,
  detachedRefusal,
  isOwner,
  judgeCallerIn,
  mayPauseTeamVerdict,
  noPaneRefusal,
  standingOf,
  walkCaller,
  type Caller,
  type CallerVerdict,
} from '../caller.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { resolveTargets, type PauseTarget, type TargetFailure } from '../pause/targets.ts';
import { pauseText, stopText, updateState, type PauseRecord } from '../state.ts';

// `team resume` clears the team's pause and restarts the queue: from that instant `team next`
// claims again and the watch nudges again. It prints the stop points the pause recorded, so the
// lead restarts each seat from the place the tool holds. The caller rule is the pause's own,
// because resuming is the same lever in the other direction.

export const USAGE = `Usage: team resume [<team>|<seat>] [--seat <seat>] [--team <team>] [--all] [--json]

Clears the pause of a seat or of a whole team and prints the stop points it recorded; team next
claims and the watch nudges again. <seat> is a seat the current folder's team declares, <team>
is a registered team's name, project or id, --seat and --team say which one a name means, and
--all is every registered team. A seat's resume leaves a team-wide pause standing, and a team's
resume leaves seats paused on their own. The owner or the team's orchestrator runs it.

Exits 0 when the seat or team resumes, 1 when it is refused or state I/O fails, 2 when the
invocation or team file can't be read.
`;

/** What `runResume` reads from outside, so tests can stand in for the clock and the store. */
export type ResumeSources = { home?: string; now?: () => Date };

const realResumeSources: ResumeSources = {};

export const resume: Command = (argv, io) => runResume(argv, io, realResumeSources);
export default resume;

type Op =
  | { kind: 'resumed'; pause: PauseRecord; still?: Array<{ seat: string; pause: PauseRecord }> }
  | { kind: 'not-paused'; teamPaused?: boolean };

/** One target's write outcome, collected so a `--all` run reports every team it reached. */
type Outcome =
  | { kind: 'resumed'; target: PauseTarget; pause: PauseRecord; still: Array<{ seat: string; pause: PauseRecord }>; session: string }
  | { kind: 'not-paused'; target: PauseTarget; teamPaused: boolean }
  | { kind: 'io'; target: PauseTarget; message: string };

export async function runResume(argv: string[], io: Io, sources: ResumeSources = realResumeSources): Promise<number> {
  const out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['seat', 'team'], ['all', 'json']);
  if (args.error) return invocation(out, args.error, json);
  const all = args.flags.has('all');
  let seat: string | undefined;
  if (args.values.seat !== undefined) {
    seat = plainLine(args.values.seat).trim();
    if (seat === '') return invocation(out, '--seat needs a seat name', json);
  }
  let team: string | undefined;
  if (args.values.team !== undefined) {
    team = plainLine(args.values.team).trim();
    if (team === '') return invocation(out, '--team needs a team name', json);
  }
  if (all && seat !== undefined) return invocation(out, '--all and --seat can\'t be used together', json);
  if (all && team !== undefined) return invocation(out, '--all and --team can\'t be used together', json);
  if (seat !== undefined && team !== undefined) return invocation(out, '--seat and --team can\'t be used together', json);
  if (all && args.rest.length > 0) return invocation(out, '--all takes no <team>', json);
  if (seat !== undefined && args.rest.length > 0) return invocation(out, '--seat takes no positional name', json);
  if (team !== undefined && args.rest.length > 0) return invocation(out, '--team takes no positional name', json);
  if (!all && args.rest.length > 1) return invocation(out, `unexpected "${plainLine(args.rest[1] ?? '')}"`, json);
  if (all && json) return invocation(out, '--all and --json can\'t be used together', json);
  const now = sources.now?.() ?? new Date();
  const walked = walkCaller(io);
  const detached = detachedRefusal(walked, { who: 'the owner or the orchestrator', where: 'a terminal outside herdr or its own seat' });
  if (detached !== undefined) {
    if (json) {
      writeJsonError(out, 'resume.detached', detached, null, 1, 'unplaced');
    } else {
      out.stderr(`team resume: ${detached}\n`);
    }
    // exit: resume.detached
    return 1;
  }
  const resolved = resolveTargets({
    key: seat !== undefined || team !== undefined || all ? undefined : args.rest[0],
    ...(seat !== undefined ? { seat } : {}),
    ...(team !== undefined ? { team } : {}),
    all,
    io,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    now: () => now,
    owner: isOwner(walked),
  });
  if (!resolved.ok) {
    if (resolved.kind === 'io') return ioRefuse(out, resolved.message, json);
    return targetFailure(out, resolved, json);
  }
  const notice = resolved.targets[0]?.notice;
  if (notice !== undefined && !json && resolved.targets.length === 1) out.stdout(`${notice}\n`);
  for (const skipped of resolved.skipped) out.stderr(`team resume: ${skipped}; left as it is\n`);

  // Every target's caller is judged before any state is written: a run that refuses one team
  // resumes none.
  const judged: Array<{ target: PauseTarget; by: string; session: string }> = [];
  for (const target of resolved.targets) {
    const { caller, session } = judgeCallerIn(io, target.dir, target.team, (candidate, at) => mayPauseTeamVerdict(candidate, target.team, at));
    const verdict = mayPauseTeamVerdict(caller, target.team, standingOf(target.dir, session, caller));
    if (verdict.kind !== 'ok') {
      const message = refusalOf(verdict, caller);
      return callerRefuse(out, resolved.targets.length > 1 ? `${target.team.project}: ${message}` : message, verdict, json, notice);
    }
    judged.push({ target, by: describeCaller(caller), session });
  }

  const outcomes: Outcome[] = [];
  for (const entry of judged) {
    const { target, by, session } = entry;
    try {
      const op = updateState<Op>(target.dir, (state) => {
        if (target.seat !== undefined) {
          const standing = state.seat_pauses?.[target.seat];
          if (standing === undefined) return { kind: 'not-paused', teamPaused: state.pause !== undefined };
          if (state.seat_pauses !== undefined) {
            delete state.seat_pauses[target.seat];
            if (Object.keys(state.seat_pauses).length === 0) delete state.seat_pauses;
          }
          return { kind: 'resumed', pause: standing };
        }
        const standing = state.pause;
        if (standing === undefined) return { kind: 'not-paused' };
        delete state.pause;
        // The team's record and a seat's are independent: clearing the team leaves every seat
        // paused on its own exactly as it was, and says so, so the lead does not read the team
        // line as "everyone is moving again".
        const still = Object.entries(state.seat_pauses ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([seat, pause]) => ({ seat, pause }));
        return { kind: 'resumed', pause: standing, still };
      });
      outcomes.push(op.kind === 'resumed'
        ? { kind: 'resumed', target, pause: op.pause, still: op.still ?? [], session }
        : { kind: 'not-paused', target, teamPaused: op.teamPaused === true });
      if (op.kind === 'resumed') {
        logLine(target.dir, 'resume', by, target.seat === undefined
          ? `resumed the team; paused since ${op.pause.at} by ${op.pause.by}`
          : `resumed seat ${target.seat}; paused since ${op.pause.at} by ${op.pause.by}`, now);
      }
    } catch (error) {
      outcomes.push({ kind: 'io', target, message: `${target.team.project}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  let refused = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'io') continue;
    if (outcome.kind === 'resumed') {
      const seat = outcome.target.seat;
      const summary = seat === undefined
        ? `resumed ${outcome.target.team.project} (${pauseText(outcome.pause)})`
        : `resumed ${seat} (${pauseText(outcome.pause)})`;
      if (json) {
        writeJson(out, 'team.resume', {
          format: 1,
          dry_run: false,
          status: 'resumed',
          action_summary: summary,
          project: outcome.target.team.project,
          session: outcome.session,
          target: seat === undefined ? 'team' : 'seat',
          value: seat ?? null,
          resumed: outcome.pause,
          ...(outcome.still.length > 0 ? { still_paused: outcome.still.map((entry) => entry.seat) } : {}),
          ...(notice !== undefined ? { notice } : {}),
        });
        continue;
      }
      out.stdout(`${summary}\n`);
      if (resolved.targets.length === 1) {
        for (const stop of outcome.pause.stops) out.stdout(`${stopText(stop)}\n`);
        for (const entry of outcome.still) out.stdout(`still paused: ${entry.seat} (${pauseText(entry.pause)})\n`);
      }
      continue;
    }
    refused += 1;
    const seat = outcome.target.seat;
    const many = resolved.targets.length > 1;
    const message = seat === undefined
      ? `not paused${many ? `: ${outcome.target.team.project}` : ''}`
      : outcome.teamPaused
        ? 'the team is paused, not the seat; team resume clears the team'
        : `not paused: ${seat}`;
    const repair = seat === undefined ? 'team pause' : outcome.teamPaused ? 'team resume' : `team pause ${seat}`;
    if (json) {
      writeJsonError(out, 'resume.not-paused', message, repair, 1, undefined, notice);
    } else {
      out.stderr(`team resume: ${message}\n`);
    }
  }
  const ioOutcome = outcomes.find((outcome) => outcome.kind === 'io');
  if (ioOutcome !== undefined && ioOutcome.kind === 'io') return ioRefuse(out, ioOutcome.message, json, notice);
  if (refused > 0) {
    // exit: resume.not-paused
    return 1;
  }
  // exit: resume.resumed
  return 0;
}

/** The caller rule's refusal, in `hold`'s own shape: a lost pane and a moved pane keep their
 *  named repairs, and anyone else is refused by the caller it is. */
function refusalOf(verdict: CallerVerdict, caller: Caller): string {
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return `only the owner or the orchestrator resumes the team; this call is ${describeCaller(caller)}`;
}

function callerRefuse(io: Io, message: string, verdict: CallerVerdict, json: boolean, notice?: string): number {
  if (json) {
    const rule = verdict.kind === 'no-pane' || verdict.kind === 'another-pane' ? 'unplaced' : 'owner-or-orchestrator';
    const repair = verdict.kind === 'no-pane' ? 'team up' : verdict.kind === 'another-pane' ? 'team down && team up' : null;
    writeJsonError(io, 'resume.caller', message, repair, 1, rule, notice);
  } else {
    io.stderr(`team resume: ${message}\n`);
  }
  // exit: resume.caller
  return 1;
}

function targetFailure(io: Io, failure: TargetFailure, json: boolean): number {
  const id = failure.kind === 'team' ? 'resume.team' : 'resume.file';
  if (json) {
    writeJsonError(io, id, failure.message, null);
  } else {
    io.stderr(`team resume: ${failure.message}\n`);
  }
  // exit: resume.file
  // exit: resume.team
  return 2;
}

function ioRefuse(io: Io, message: string, json: boolean, notice?: string): number {
  if (json) {
    writeJsonError(io, 'resume.io', message, null, 1, undefined, notice);
  } else {
    io.stderr(`team resume: ${message}\n`);
  }
  // exit: resume.io
  return 1;
}

function invocation(io: Io, message: string, json: boolean): number {
  if (json) {
    writeJsonError(io, 'resume.invocation', message, null);
  } else {
    io.stderr(`team resume: ${message}\n${USAGE}`);
  }
  // exit: resume.invocation
  return 2;
}
