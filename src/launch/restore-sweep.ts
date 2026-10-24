// The daemon's restore sweep for one hosted route: after a host restart the
// daemon runs the same guarded pass `team up` runs, once per accepted route, without ever
// cold-starting a team that was never up or was deliberately `team down`'d.
//
// This module is the non-recursive boundary the daemon imports: `daemon/host.ts` never imports
// `commands/up.ts` directly, and `up.ts` imports nothing from `daemon/`. The sweep owns the
// session's run lock for the whole pass and hands it to `runUp` through its internal seam, so a
// concurrent manual `team up` refuses rather than launching over the sweep.
import { dirname } from 'node:path';
import { readTeamConfig } from '../file/team-config.ts';
import type { SessionState } from '../herdr.ts';
import type { Io } from '../io.ts';
import type { Caller } from '../caller.ts';
import { readState } from '../state.ts';
import { realSources, runUp, type UpSources } from '../commands/up.ts';
import { restoreSummaryOf, type Report, type RestoreSweepSummary } from './execute.ts';
import { acquireRunLock } from './run-lock.ts';

/** The ownership the sweep judged the route as, as the owner of the machine's daemon. The
 *  sweep's caller is the daemon's own, never a seat's: it launches no seat under a seat name. */
const OWNER: Caller = { kind: 'owner' };

export type RestoreSweepResult =
  /** The route records no session for its file's session: a cold or already-downed team. */
  | { kind: 'no-recorded-session' }
  /** Another session-mutating run holds the route's run lock. `holder` is -1 when the lock
   *  cannot be read. */
  | { kind: 'lock-held'; holder: number }
  /** The route records a session, but the terminal host does not have it running: never cold
   *  start it from here, and with no reading at all, never act. */
  | { kind: 'not-running'; state: SessionState | null }
  /** The team file or its state could not be read. */
  | { kind: 'unreadable'; reason: string }
  /** The run returned before it planned any seat (a file or caller refusal): no summary is
   *  honest, and the exit code is the run's own. `detail` is the last line the run said, so the
   *  daemon log names the refusal rather than only its exit. */
  | { kind: 'refused'; exit: number; detail?: string }
  /** The sweep ran. `failed` is `runUp`'s exit: nonzero when the run refused a seat. */
  | { kind: 'ran'; summary: RestoreSweepSummary; failed: boolean };

export type RestoreSweepInput = {
  home: string;
  /** The canonical route root: what the restart sweep was accepted for. */
  root: string;
  /** The team file the route was actually loaded from (`teamFiles.get(route.root)`). */
  teamFile: string;
  now?: () => Date;
  /** The daemon's closing flag: stops the pass between seat steps. */
  isClosing?: () => boolean;
  /** A test's world in place of the real launch and read sources. A test that injects one owns
   *  its `home` too; the daemon never injects this. */
  sources?: UpSources;
};

/** Whether the route records at least one seat for its session. A session entry with no seat
 *  record is a team that was downed (or never launched), never a restore candidate. */
function recordsSeats(dir: string, session: string): boolean {
  const recorded = readState(dir).sessions[session];
  return recorded !== undefined && Object.keys(recorded.seats).length > 0;
}

/** The session's state from the sources, resolved the same way `up` resolves it. Unknown reads
 *  as null, and the sweep then never acts. */
function stateOf(sources: UpSources, session: string): SessionState | null {
  try {
    if (sources.sessionState) return sources.sessionState(session);
    const running = sources.sessionRunning(session);
    return running === null ? null : running ? 'running' : 'absent';
  } catch {
    return null;
  }
}

/** The last non-empty line a run wrote, for the daemon's one log line. Bounded so a refusal that
 *  prints a whole plan cannot grow the log without limit. */
function lastSaid(err: string[], out: string[]): string | undefined {
  const lines = `${err.join('')}\n${out.join('')}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const said = lines.at(-1);
  if (said === undefined) return undefined;
  return said.length > 400 ? `${said.slice(0, 397)}...` : said;
}

/**
 * Runs the bounded restore pass for one route, or reports why it did not.
 *
 * The eligibility checks happen twice: once before the lock, so a cold or downed route costs
 * one read, and once under the lock, because a `team down` that finished while the sweep waited
 * must never be resurrected by it.
 */
export async function runRestoreSweepForRoute(input: RestoreSweepInput): Promise<RestoreSweepResult> {
  const sources: UpSources = input.sources ?? {
    ...realSources,
    home: input.home,
    ...(input.now ? { now: input.now } : {}),
  };
  let loaded: ReturnType<typeof readTeamConfig>;
  try {
    loaded = readTeamConfig(input.root, { file: input.teamFile, home: sources.home });
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!loaded.ok) {
    const said = loaded.errors.map((problem) => problem.message).join('; ');
    return { kind: 'unreadable', reason: said === '' ? 'the team file could not be read' : said };
  }
  const { team } = loaded;
  const session = team.session;
  const dir = dirname(loaded.path);
  // The first read: a route with no recorded session is cold or deliberately downed, and the
  // sweep is never the command that brings it back. A state file that will not parse is a
  // refusal, not a reason to launch anything.
  try {
    if (!recordsSeats(dir, session)) return { kind: 'no-recorded-session' };
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const lock = acquireRunLock(dir, session);
  if ('held' in lock) return { kind: 'lock-held', holder: lock.held };
  try {
    // Under the lock: a team downed while the sweep waited stays down, and a session the host
    // stopped or lost is never cold-started from here.
    try {
      if (!recordsSeats(dir, session)) return { kind: 'no-recorded-session' };
    } catch (error) {
      return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
    }
    const state = stateOf(sources, session);
    if (state !== 'running') return { kind: 'not-running', state };
    // The run's own writers are captured, not printed: the daemon logs the one summary line, and
    // a refusal carries the run's last line into the same log. The injected caller is the owner
    // and the run is marked non-interactive, so no dialog is ever prompted from this process.
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
      cwd: input.root,
      env: { ...process.env },
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stderrIsTTY: false,
      caller: OWNER,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    };
    const seen: { report: Report | null } = { report: null };
    const exit = await runUp(['--file', loaded.path], io, sources, {
      caller: OWNER,
      lockHeld: true,
      nonInteractive: true,
      ...(input.isClosing ? { isClosing: input.isClosing } : {}),
      onReport: (next) => {
        seen.report = next;
      },
    });
    if (seen.report === null) {
      const said = lastSaid(err, out);
      return { kind: 'refused', exit, ...(said === undefined ? {} : { detail: said }) };
    }
    return { kind: 'ran', summary: restoreSummaryOf(seen.report.restoreBuckets), failed: exit !== 0 };
  } finally {
    lock.release();
  }
}
