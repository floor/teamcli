import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { anotherPaneRefusal, describeCaller, detachedRefusal, isOwner, judgeCallerIn, mayChangeTeamVerdict, noPaneRefusal, standingOf, walkCaller, type Caller, type CallerVerdict } from '../caller.ts';
import { auditClientRefusal, authorizeClientRun, clientActor, clientBanner, clientFormProblem, enterClientForm, type ClientRun } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { currentTeam } from '../file/current.ts';
import { withoutFileOffer } from '../file/load.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { hasJsonFlag, writeJson, writeJsonError } from '../output/index.ts';
import { holdText, liveHold, updateState, type HoldRecord } from '../state.ts';

// `team hold <reason> [--until <time>]` records a hold on the team's work in the team state,
// and `team hold --release` clears it. The hold lives in the state, never the team file: the
// file waits for the owner's approval, and a hold that waits is no hold. `status` prints it as
// a note and `doctor` as a `--` line; a record past its `until` reads as no hold at all
// (`liveHold`), so nothing has to clear it on time. In this part nothing consults a hold before
// acting: no command and no launch changes behaviour while one stands. The caller rule is
// `down`'s — the owner, or the team's orchestrator or operator — because a hold is shown to
// the whole team like the stop is, and the same gate places and releases.

export const USAGE = `Usage: team hold <reason> [--until <time>] [--json]
       team hold --release [--json]
       team hold <reason> --client <grant-file> --key <client-key> [--team <team>] [--until <time>] [--json]
       team hold --release --client <grant-file> --key <client-key> [--team <team>] [--json]

The --client form is for a client with no terminal that the owner signed a developer bundle grant carrying hold for one team (team grant --client <id> --entity <entity> --public-key <file> --team <team> --bundle developer --request): it places or releases the hold of that one team, as signed, and nothing else. It never prompts and is never the owner.

Exits 0 when the hold is placed or released, 1 when it is refused or state I/O fails, 2 when the invocation or team file can't be read.
`;

/** What `runHold` reads from outside, so tests can stand in for the clock and the store. */
export type HoldSources = { home?: string; now?: () => Date };

const realHoldSources: HoldSources = {};

export const hold: Command = (argv, io) => runHold(argv, io, realHoldSources);
export default hold;

type Op =
  | { kind: 'placed'; hold: HoldRecord }
  | { kind: 'held'; hold: HoldRecord }
  | { kind: 'released' }
  | { kind: 'not-held' };

export async function runHold(argv: string[], io: Io, sources: HoldSources = realHoldSources): Promise<number> {
  let out = cleanedIo(io);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['until', 'client', 'key', 'team'], ['release', 'json']);
  if (args.error) return invocation(out, args.error, json);
  const clientProblem = clientFormProblem(args.values, 'team hold <reason> --client <grant-file> --key <client-key-file>');
  if (clientProblem !== null) return invocation(out, clientProblem, json);
  const now = sources.now?.() ?? new Date();
  const release = args.flags.has('release');
  let reason = '';
  let until: Date | undefined;
  if (release) {
    if (args.rest.length > 0 || args.values.until !== undefined) {
      return invocation(out, '--release takes no <reason> and no --until', json);
    }
  } else {
    if (args.rest.length === 0) return invocation(out, 'a <reason> is required', json);
    const extra = args.rest[1];
    if (extra !== undefined) return invocation(out, `unexpected "${plainLine(extra)}"`, json);
    reason = plainLine(args.rest[0] ?? '').trim();
    if (reason === '') return invocation(out, 'a <reason> is required', json);
    if (args.values.until !== undefined) {
      const parsed = untilOf(args.values.until, now);
      if (typeof parsed === 'string') {
        if (json) {
          writeJsonError(out, 'hold.until', parsed, null);
        } else {
          out.stderr(`team hold: ${parsed}\n`);
        }
        // exit: hold.until
        return 1;
      }
      until = parsed;
    }
  }
  // The client form: a developer grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything is read. The second door of the caller rule below, never a
  // second rule: every other caller goes through it, unchanged. The run is never the owner's.
  let clientRun: ClientRun | null = null;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const entered = enterClientForm({ home: sources.home ?? homedir(), now }, { op: 'hold', values: args.values, cwd: io.cwd });
    if (!entered.ok) return clientRefused(out, json, entered.why);
    clientRun = entered.run;
    io = { ...io, cwd: clientRun.root };
    out = cleanedIo(io);
    if (!json) io.stderr(`${clientBanner(clientRun)}\n`);
  }
  const walked = walkCaller(io);
  const detached = clientRun !== null ? undefined : detachedRefusal(walked, { who: 'the owner, the orchestrator or the operator', where: 'a terminal outside herdr or its own seat' });
  if (detached !== undefined) {
    if (json) {
      writeJsonError(out, 'hold.detached', detached, null, 1, 'unplaced');
    } else {
      out.stderr(`team hold: ${detached}\n`);
    }
    // exit: hold.detached
    return 1;
  }
  const current = currentTeam(io.cwd, undefined, now, sources.home, clientRun === null && isOwner(walked));
  if (!current.ok) {
    // `team hold` takes no `--file`, so the no-repository refusal must not offer one.
    const messages = current.errors.map(
      (problem) => `${problem.line ? `team.yaml line ${problem.line}: ` : ''}${withoutFileOffer(plainText(problem.message))}`,
    );
    if (json) {
      writeJsonError(out, 'hold.file', messages.join('; '), null);
    } else {
      for (const msg of messages) {
        out.stderr(`team hold: ${msg}\n`);
      }
    }
    // exit: hold.file
    return 2;
  }
  const { team, dir } = current;
  const notice = current.notice ? plainText(current.notice) : undefined;
  if (notice !== undefined && !json) out.stdout(`${notice}\n`);
  const judged = clientRun !== null ? null : judgeCallerIn(io, dir, team);
  const session = judged?.session ?? team.session;
  const by = clientRun !== null ? clientActor(clientRun) : describeCaller(judged!.caller);
  const verdict: CallerVerdict = judged === null ? { kind: 'ok' } : mayChangeTeamVerdict(judged.caller, team, standingOf(dir, session, judged.caller));
  if (verdict.kind !== 'ok' && judged !== null) {
    const { caller } = judged;
    const msg = refusalOf(verdict, caller);
    if (json) {
      const rule = verdict.kind === 'no-pane' || verdict.kind === 'another-pane' ? 'unplaced' : 'owner-or-leads';
      const repair = verdict.kind === 'no-pane' ? 'team up' : verdict.kind === 'another-pane' ? 'team down && team up' : null;
      writeJsonError(out, 'hold.caller', msg, repair, 1, rule, notice);
    } else {
      out.stderr(`team hold: ${msg}\n`);
    }
    // exit: hold.caller
    return 1;
  }
  // The client's grant, read once more under its lock immediately before the first effect, and its audit
  // line written while the lock is held: a revocation is either seen here or ordered after this run.
  if (clientRun !== null) {
    const stood = authorizeClientRun(sources.home ?? homedir(), clientRun, 'hold', now, release ? 'release' : `reason ${reason}`);
    if (stood !== null) {
      auditClientRefusal('hold', clientRun.grant, stood, now);
      return clientRefused(out, json, stood);
    }
  }
  let op: Op;
  try {
    // The read, the check and the write are one step under the state's lock: a hold placed by
    // two callers at once keeps the first one, and the second is refused by name.
    op = updateState<Op>(dir, (state) => {
      if (release) {
        if (state.hold === undefined) return { kind: 'not-held' };
        delete state.hold;
        return { kind: 'released' };
      }
      const standing = liveHold(state, now);
      if (standing !== null) return { kind: 'held', hold: standing };
      const record: HoldRecord = { reason, by, at: now.toISOString(), ...(until ? { until: until.toISOString() } : {}) };
      state.hold = record;
      return { kind: 'placed', hold: record };
    });
  } catch (error) {
    const msg = plainText(error instanceof Error ? error.message : String(error));
    if (json) {
      writeJsonError(out, 'hold.io', msg, null, 1, undefined, notice);
    } else {
      out.stderr(`team hold: ${msg}\n`);
    }
    // exit: hold.io
    return 1;
  }
  if (op.kind === 'placed') {
    const summary = holdText(op.hold);
    if (json) {
      writeJson(out, 'team.hold', {
        format: 1,
        dry_run: false,
        status: 'placed',
        action_summary: summary,
        project: team.project,
        session,
        target: 'hold',
        value: op.hold.reason,
        hold: op.hold,
        ...(notice !== undefined ? { notice } : {}),
      });
    } else {
      out.stdout(`${summary}\n`);
    }
    // exit: hold.placed
    return 0;
  }
  if (op.kind === 'released') {
    const summary = 'hold: released';
    if (json) {
      writeJson(out, 'team.hold', {
        format: 1,
        dry_run: false,
        status: 'released',
        action_summary: summary,
        project: team.project,
        session,
        target: 'hold',
        value: null,
        ...(notice !== undefined ? { notice } : {}),
      });
    } else {
      out.stdout(`${summary}\n`);
    }
    // exit: hold.released
    return 0;
  }
  if (op.kind === 'held') {
    const msg = `already held${op.hold.until ? ` until ${op.hold.until}` : ''}: ${op.hold.reason}`;
    if (json) {
      writeJsonError(out, 'hold.held', msg, 'team hold --release', 1, undefined, notice);
    } else {
      out.stderr(`team hold: ${msg}\n`);
    }
    // exit: hold.held
    return 1;
  }
  if (json) {
    writeJsonError(out, 'hold.not-held', 'not held', null, 1, undefined, notice);
  } else {
    out.stderr('team hold: not held\n');
  }
  // exit: hold.not-held
  return 1;
}

/** The caller rule's refusal, in `down`'s own shape: a lost pane and a moved pane keep their
 *  named repairs, and anyone else is refused by the caller it is. */
function refusalOf(verdict: CallerVerdict, caller: Caller): string {
  if (verdict.kind === 'no-pane') return noPaneRefusal(verdict.name);
  if (verdict.kind === 'another-pane') return anotherPaneRefusal(verdict.name, verdict.recordedPane);
  return `only the owner, the orchestrator or the operator holds the team; this call is ${describeCaller(caller)}`;
}

/** `--until`'s two shapes, and nothing else: a local `<HH:MM>` — the next time it comes, today
 *  or tomorrow when today's has passed — or an ISO 8601 instant carrying `Z` or an offset.
 *  A shape that does not parse comes back as the refusal's own words. */
function untilOf(text: string, now: Date): Date | string {
  const clock = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  if (clock && Number(clock[1]) <= 23) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const at = new Date(text);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return '--until is a local <HH:MM>, or an ISO 8601 instant with Z or an offset, and nothing else';
}

function clientRefused(io: Io, json: boolean, message: string): number {
  if (json) {
    writeJsonError(io, 'hold.client-refused', plainLine(message), null);
  } else {
    io.stderr(`team hold: ${plainLine(message)}\n`);
  }
  // exit: hold.client-refused
  return 1;
}

function invocation(io: Io, message: string, json: boolean): number {
  if (json) {
    writeJsonError(io, 'hold.invocation', message, null);
  } else {
    io.stderr(`team hold: ${message}\n${USAGE}`);
  }
  // exit: hold.invocation
  return 2;
}
