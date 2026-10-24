import { homedir } from 'node:os';
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
import { auditClientRefusal, authorizeClientRun, clientActor, clientBanner, clientFormProblem, enterClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { logLine } from '../log.ts';
import { plainLine } from '../launch/plain.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { pauseStops, resolveTargets, type PauseTarget, type TargetFailure } from '../pause/targets.ts';
import { emptySession, pauseText, stopText, updateState, type PauseRecord } from '../state.ts';

// `team pause` stops the team taking new work: `team next` claims nothing while the record
// stands, and the watch types no work nudge. It writes one top-level `pause` record in the
// team state — never the team file, for the reason `hold` gives: the file waits for the owner's
// approval, and a stop that waits is no stop. The record carries a stop point for every seat the
// file declares that is not a human's, so the resume starts the lead from what the tool holds.
// The caller rule is narrower than `hold`'s: the owner, or the team's own orchestrator.

export const USAGE = `Usage: team pause [<team>] [--reason <text>] [--all] [--json]

Stops every seat taking new work: team next claims nothing and the watch types no work nudge
until team resume. The stop points of every declared seat are recorded in the state. The owner
or the team's orchestrator runs it; a human seat is never touched. <team> is a registered
team's name, project or id, and --all is every registered team.

       team pause --client <grant-file> --key <client-key> [--team <team>] [--reason <text>] [--json]

The --client form is for a client with no terminal that the owner signed a developer bundle grant carrying pause for one team (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle developer --request): it pauses that one team, as signed, and nothing else. It is as graceful as the plain form: ongoing work finishes, nothing is interrupted, only new work is withheld until resume. It never prompts, is never the owner, and takes no <team> and no --all.

Exits 0 when the team is paused, 1 when it is refused or state I/O fails, 2 when the invocation or team file can't be read.
`;

/** What `runPause` reads from outside, so tests can stand in for the clock and the store. */
export type PauseSources = { home?: string; now?: () => Date };

const realPauseSources: PauseSources = {};

export const pause: Command = (argv, io) => runPause(argv, io, realPauseSources);
export default pause;

type Op = { kind: 'placed'; pause: PauseRecord } | { kind: 'paused'; pause: PauseRecord };

/** One target's write outcome, collected so a `--all` run reports every team it reached. */
type Outcome =
  | { kind: 'placed'; target: PauseTarget; pause: PauseRecord; session: string }
  | { kind: 'paused'; target: PauseTarget; pause: PauseRecord; session: string }
  | { kind: 'io'; target: PauseTarget; message: string };

export async function runPause(argv: string[], io: Io, sources: PauseSources = realPauseSources): Promise<number> {
  let out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['reason', 'client', 'key', 'team'], ['all', 'json']);
  if (args.error) return invocation(out, args.error, json);
  const clientProblem = clientFormProblem(args.values, 'team pause --client <grant-file> --key <client-key-file>')
    ?? (args.values.client !== undefined && (args.rest.length > 0 || args.flags.has('all'))
      ? '--client pauses the one team its grant names: <team> and --all are the owner\'s and take no --client'
      : null);
  if (clientProblem !== null) return invocation(out, clientProblem, json);
  const all = args.flags.has('all');
  if (all && args.rest.length > 0) return invocation(out, '--all takes no <team>', json);
  if (!all && args.rest.length > 1) return invocation(out, `unexpected "${plainLine(args.rest[1] ?? '')}"`, json);
  // Every team is its own document, so one `--json` cannot carry the run: the lines are the
  // only shape `--all` has, the same rule `team seats` keeps for `--watch`.
  if (all && json) return invocation(out, '--all and --json can\'t be used together', json);
  let reason: string | undefined;
  if (args.values.reason !== undefined) {
    reason = plainLine(args.values.reason).trim();
    if (reason === '') return invocation(out, '--reason needs text', json);
  }
  const now = sources.now?.() ?? new Date();
  // The client form: a developer grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything is read. The second door of the caller rule below, never a
  // second rule: every other caller goes through it, unchanged. The run is never the owner's.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const entered = enterClientForm({ home: sources.home ?? homedir(), now }, { op: 'pause', values: args.values, cwd: io.cwd });
    if (!entered.ok) return clientRefused(out, json, entered.why);
    clientRun = entered.run;
    // The folder is the grant's, whatever the caller's: from here every read is of that team.
    io = { ...io, cwd: clientRun.root };
    out = cleanedIo(io);
    if (!json) io.stderr(`${clientBanner(clientRun)}\n`);
  }
  const walked = walkCaller(io);
  const detached = clientRun !== null ? undefined : detachedRefusal(walked, { who: 'the owner or the orchestrator', where: 'a terminal outside herdr or its own seat' });
  if (detached !== undefined) {
    if (json) {
      writeJsonError(out, 'pause.detached', detached, null, 1, 'unplaced');
    } else {
      out.stderr(`team pause: ${detached}\n`);
    }
    // exit: pause.detached
    return 1;
  }
  const resolved = resolveTargets({
    key: all ? undefined : args.rest[0],
    all,
    io,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    now: () => now,
    owner: clientRun === null && isOwner(walked),
  });
  if (!resolved.ok) {
    if (resolved.kind === 'io') return ioRefuse(out, resolved.message, json);
    return targetFailure(out, resolved, json);
  }
  const notice = resolved.targets[0]?.notice;
  if (notice !== undefined && !json && resolved.targets.length === 1) out.stdout(`${notice}\n`);
  for (const skipped of resolved.skipped) out.stderr(`team pause: ${skipped}; left as it is\n`);

  // Every target's caller is judged before any state is written: a run that refuses one team
  // pauses none, so the answer to the caller never changes halfway through the list.
  const judged: Array<{ target: PauseTarget; session: string; by: string }> = [];
  for (const target of resolved.targets) {
    if (clientRun !== null) {
      judged.push({ target, session: target.team.session, by: clientActor(clientRun) });
      continue;
    }
    const { caller, session } = judgeCallerIn(io, target.dir, target.team, (candidate, at) => mayPauseTeamVerdict(candidate, target.team, at));
    const verdict = mayPauseTeamVerdict(caller, target.team, standingOf(target.dir, session, caller));
    if (verdict.kind !== 'ok') {
      const message = refusalOf(verdict, caller);
      return callerRefuse(out, resolved.targets.length > 1 ? `${target.team.project}: ${message}` : message, verdict, json, notice);
    }
    judged.push({ target, session, by: describeCaller(caller) });
  }

  // The client's grant, read once more under its lock immediately before the first effect, and its audit
  // line written while the lock is held: a revocation is either seen here or ordered after this run.
  if (clientRun !== null) {
    const stood = authorizeClientRun(sources.home ?? homedir(), clientRun, 'pause', now, reason === undefined ? '' : `reason ${reason}`);
    if (stood !== null) {
      auditClientRefusal('pause', clientRun.grant, stood, now);
      return clientRefused(out, json, stood);
    }
  }
  const at = now.toISOString();
  const outcomes: Outcome[] = [];
  for (const entry of judged) {
    const { target, session, by } = entry;
    try {
      // The read, the check and the write are one step under the state's lock, so two pauses
      // at once keep the first one and the second is refused by name. The stop points are read
      // from the state this write holds, not from an earlier read.
      const op = updateState<Op>(target.dir, (state) => {
        if (state.pause !== undefined) return { kind: 'paused', pause: state.pause };
        const record: PauseRecord = {
          by,
          at,
          ...(reason !== undefined ? { reason } : {}),
          stops: pauseStops(target.team, state.sessions[session] ?? emptySession()),
        };
        state.pause = record;
        return { kind: 'placed', pause: record };
      });
      outcomes.push(op.kind === 'placed'
        ? { kind: 'placed', target, pause: op.pause, session }
        : { kind: 'paused', target, pause: op.pause, session });
      if (op.kind === 'placed') {
        logLine(target.dir, 'pause', by, reason === undefined ? 'paused the team' : `paused the team: ${reason}`, now);
      }
    } catch (error) {
      outcomes.push({ kind: 'io', target, message: `${target.team.project}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  let refused = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'io') continue;
    const many = resolved.targets.length > 1;
    if (outcome.kind === 'placed') {
      const summary = pauseText(outcome.pause);
      if (json) {
        writeJson(out, 'team.pause', {
          format: 1,
          dry_run: false,
          status: 'paused',
          action_summary: summary,
          project: outcome.target.team.project,
          session: outcome.session,
          target: 'team',
          value: outcome.pause.reason ?? null,
          pause: outcome.pause,
          ...(notice !== undefined ? { notice } : {}),
        });
        continue;
      }
      out.stdout(`${many ? `${outcome.target.team.project}: ` : ''}${summary}\n`);
      if (!many) for (const stop of outcome.pause.stops) out.stdout(`${stopText(stop)}\n`);
      continue;
    }
    refused += 1;
    const message = `already paused: ${pauseText(outcome.pause)}`;
    if (json) {
      writeJsonError(out, 'pause.paused', message, 'team resume', 1, undefined, notice);
    } else {
      out.stderr(`team pause: ${many ? `${outcome.target.team.project}: ` : ''}${message}\n`);
    }
  }
  const ioOutcome = outcomes.find((outcome) => outcome.kind === 'io');
  if (ioOutcome !== undefined && ioOutcome.kind === 'io') return ioRefuse(out, ioOutcome.message, json, notice);
  if (refused > 0) {
    // exit: pause.paused
    return 1;
  }
  // exit: pause.placed
  return 0;
}

/** The caller rule's refusal, in `hold`'s own shape: a lost pane and a moved pane keep their
 *  named repairs, and anyone else is refused by the caller it is. */
function refusalOf(verdict: CallerVerdict, caller: Caller): string {
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return `only the owner or the orchestrator pauses the team; this call is ${describeCaller(caller)}`;
}

function callerRefuse(io: Io, message: string, verdict: CallerVerdict, json: boolean, notice?: string): number {
  if (json) {
    const rule = verdict.kind === 'no-pane' || verdict.kind === 'another-pane' ? 'unplaced' : 'owner-or-orchestrator';
    const repair = verdict.kind === 'no-pane' ? 'team up' : verdict.kind === 'another-pane' ? 'team down && team up' : null;
    writeJsonError(io, 'pause.caller', message, repair, 1, rule, notice);
  } else {
    io.stderr(`team pause: ${message}\n`);
  }
  // exit: pause.caller
  return 1;
}

function targetFailure(io: Io, failure: TargetFailure, json: boolean): number {
  const id = failure.kind === 'team' ? 'pause.team' : 'pause.file';
  if (json) {
    writeJsonError(io, id, failure.message, null);
  } else {
    io.stderr(`team pause: ${failure.message}\n`);
  }
  // exit: pause.file
  // exit: pause.team
  return 2;
}

function ioRefuse(io: Io, message: string, json: boolean, notice?: string): number {
  if (json) {
    writeJsonError(io, 'pause.io', message, null, 1, undefined, notice);
  } else {
    io.stderr(`team pause: ${message}\n`);
  }
  // exit: pause.io
  return 1;
}

function clientRefused(io: Io, json: boolean, message: string): number {
  if (json) {
    writeJsonError(io, 'pause.client-refused', plainLine(message), null);
  } else {
    io.stderr(`team pause: ${plainLine(message)}\n`);
  }
  // exit: pause.client-refused
  return 1;
}

function invocation(io: Io, message: string, json: boolean): number {
  if (json) {
    writeJsonError(io, 'pause.invocation', message, null);
  } else {
    io.stderr(`team pause: ${message}\n${USAGE}`);
  }
  // exit: pause.invocation
  return 2;
}
