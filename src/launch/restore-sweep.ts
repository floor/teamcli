// The daemon's restore sweep for one hosted route: after a host restart the
// daemon runs the same guarded pass `team up` runs, once per accepted route, without ever
// cold-starting a team that was never up or was deliberately `team down`'d.
//
// This module is the non-recursive boundary the daemon imports: `daemon/host.ts` never imports
// `commands/up.ts` directly, and `up.ts` imports nothing from `daemon/`. The sweep owns the
// session's run lock for the whole pass and hands it to `runUp` through its internal seam, so a
// concurrent manual `team up` refuses rather than launching over the sweep.
import { dirname } from 'node:path';
import { launchTeamFile } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { SessionState } from '../herdr.ts';
import type { Io } from '../io.ts';
import type { Caller } from '../caller.ts';
import { readState } from '../state.ts';
import { realSources, runUp, type UpSources } from '../commands/up.ts';
import { restoreSummaryOf, type Report, type RestoreSweepSummary } from './execute.ts';
import { acquireRunLock } from './run-lock.ts';
import { restoreLifecycleProblem } from './restore-lifecycle.ts';
import { channelRepairLine, restoreLeadChannels, type RestoreChannelDeps } from './restore-channel.ts';
import { relaunchRestoredSeats, type RestoreRelaunchDeps } from './restore-relaunch.ts';
import { runSelfRestarts } from './self-restart.ts';
import { realSources as restartRealSources, runRestart } from '../commands/restart.ts';
import { channelUnproven } from '../queue/resend.ts';
import { pendingProbe, placeChannelProbe } from '../queue/channel-probe.ts';
import { seatDropDir } from '../queue/mail-tree.ts';
import { messageKeyState } from '../store/keys.ts';
import { inboxLive } from '../mcp/inbox.ts';
import { listenerKeyOf } from '../comms/offer.ts';
import { writeRuntimeNotice } from '../send/endpoint-notice.ts';

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
  | { kind: 'refused'; exit: number; detail?: string; retry?: 'load' }
  /** The sweep ran. `failed` is `runUp`'s exit: nonzero when the run refused a seat. */
  | { kind: 'ran'; summary: RestoreSweepSummary; failed: boolean; retry?: 'load'; detail?: string };
/** What a self-restart pass (`runSelfRestartsForRoute`) did, one line each; never a restore. */
export type SelfRestartPassResult = { kind: 'self-restart'; lines: string[] };

export type RestoreSweepInput = {
  home: string;
  /** The canonical route root: what the restart sweep was accepted for. */
  root: string;
  /** The team file the route was loaded from when it is a `team-file` route. Absent for a route
   *  whose team lives in the registry: this pass then resolves `root` through the one seam, the
   *  way every writer does, and never reads a leftover beside the root. */
  teamFile?: string;
  now?: () => Date;
  /** The session the daemon hosts this route under. When the loaded team names another, the
   *  pass refuses before any read of either session: the route changed since the daemon looked. */
  expectedSession?: string;
  /** The daemon's closing flag: stops the pass between seat steps. */
  isClosing?: () => boolean;
  /** A test's world in place of the real launch and read sources. A test that injects one owns
   *  its `home` too; the daemon never injects this. */
  sources?: UpSources;
  /** A test's stand-ins for the channel repair (`restore-channel.ts`); with injected sources and
   *  none of these, no repair runs. */
  channelDeps?: RestoreChannelDeps;
  /** A test's stand-ins for the relaunch and reach check (`restore-relaunch.ts`); with injected
   *  sources and none of these, nothing is relaunched. */
  relaunchDeps?: RestoreRelaunchDeps;
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
    loaded = input.teamFile === undefined
      ? readTeamConfig(input.root, { home: sources.home })
      : readTeamConfig(input.root, { file: input.teamFile, home: sources.home });
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!loaded.ok) {
    const said = loaded.errors.map((problem) => problem.message).join('; ');
    return { kind: 'unreadable', reason: said === '' ? 'the team file could not be read' : said };
  }
  const { team } = loaded;
  const session = team.session;
  if (input.expectedSession !== undefined && input.expectedSession !== session) {
    return {
      kind: 'refused',
      exit: 1,
      detail: `the team's session is now "${session}", not the hosted "${input.expectedSession}"; nothing was restored`,
    };
  }
  const dir = dirname(loaded.path);
  const lifecycleProblem = restoreLifecycleProblem(sources.home, loaded.root, team.project);
  if (lifecycleProblem !== null) return { kind: 'refused', exit: 1, detail: lifecycleProblem };
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
  let ran: Extract<RestoreSweepResult, { kind: 'ran' }>;
  let relaunchFile: string | undefined;
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
    const currentProblem = restoreLifecycleProblem(sources.home, loaded.root, team.project);
    if (currentProblem !== null) return { kind: 'refused', exit: 1, detail: currentProblem };
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
    // A lead whose channel pair went missing gets it back through setup before the run reads
    // the folder: the launch then finds the pair instead of starting the lead without its inbox.
    // A test world (injected sources) never runs setup against the real config writer.
    const channelLine = input.sources === undefined || input.channelDeps !== undefined
      ? channelRepairLine(await restoreLeadChannels({
        home: sources.home, root: loaded.root, team, caller: OWNER,
        ...(input.channelDeps === undefined ? {} : { deps: input.channelDeps }),
      }))
      : null;
    const seen: { report: Report | null } = { report: null };
    let loadReason: string | null = null;
    const loadSeats = new Map<string, string>();
    // The file the route was loaded from, never the path a registry read carries: a registry
    // team's `path` is the conventional filename that need not exist, and `up --file` reads only
    // the file it names. With no file, `up` resolves this root the way this pass did.
    const launchFile = launchTeamFile(loaded);
    const exit = await runUp(launchFile === undefined ? [] : ['--file', launchFile], io, sources, {
      caller: OWNER,
      lockHeld: true,
      nonInteractive: true,
      restore: true,
      restoreMissingOnly: true,
      // The session checked above and locked: the run's own reload must name the same one.
      expectedSession: session,
      onLoadDeferred: ({ reason, seat }) => {
        if (seat === undefined) loadReason = reason;
        else loadSeats.set(seat, reason);
      },
      ...(input.isClosing ? { isClosing: input.isClosing } : {}),
      onReport: (next) => {
        seen.report = next;
      },
    });
    if (seen.report === null) {
      const said = loadReason ?? lastSaid(err, out);
      return { kind: 'refused', exit, ...(said === undefined ? {} : { detail: said }), ...(loadReason === null ? {} : { retry: 'load' as const }) };
    }
    const summary = restoreSummaryOf(seen.report.restoreBuckets);
    const note = seen.report.daemonHostNote;
    if (note !== undefined && note !== '') summary.line = `${summary.line}; ${note}`;
    if (channelLine !== null) summary.line = `${summary.line}; ${channelLine}`;
    const loadOnly = summary.refused_seats.length > 0 && summary.refused_seats.every((seat) => loadSeats.has(seat.seat));
    ran = { kind: 'ran', summary, failed: exit !== 0,
      ...(loadOnly ? { retry: 'load' as const, detail: loadSeats.get(summary.refused_seats[0]!.seat)! } : {}) };
    relaunchFile = launchFile;
  } finally {
    lock.release();
  }
  // The pass's restored Claude seats come back through their launch lines, after the run lock is
  // released (the restart takes it itself), and each restored seat's reach is checked. A seat
  // still working, the load, or a proof still awaited keeps the route on the load guard's retry.
  // A test world (injected sources) relaunches nothing unless it hands its stand-ins in.
  const deps = input.sources === undefined ? realRelaunchDeps(sources.home, loaded.root, session, team.orchestrator) : input.relaunchDeps;
  if (deps === undefined || input.isClosing?.() === true) return ran;
  const pass = await relaunchRestoredSeats({
    root: loaded.root, dir, session, team, sources, caller: OWNER, deps,
    ...(relaunchFile === undefined ? {} : { launchFile: relaunchFile }),
  });
  if (pass.lines.length > 0) ran.summary.line = `${ran.summary.line}; ${pass.lines.join('; ')}`;
  if (pass.pending !== null && ran.retry === undefined) return { ...ran, retry: 'load', detail: `restore relaunch pending: ${pass.pending}` };
  return ran;
}

/**
 * The daemon's pass over one hosted route's queued self-restarts (`./self-restart.ts`), run in a
 * restore child: the team is read the way the restore sweep reads it, and each request runs the
 * ordinary restart as the daemon.
 */
export async function runSelfRestartsForRoute(input: { home: string; root: string; teamFile?: string }): Promise<string[]> {
  const sources: UpSources = { ...realSources, home: input.home };
  const loaded = input.teamFile === undefined
    ? readTeamConfig(input.root, { home: input.home })
    : readTeamConfig(input.root, { file: input.teamFile, home: input.home });
  if (!loaded.ok) return [];
  const { team } = loaded;
  const launchFile = launchTeamFile(loaded);
  return runSelfRestarts({
    home: input.home, root: loaded.root, dir: dirname(loaded.path), team, sources, caller: OWNER,
    deps: {
      // The seat's own request rides into the restart, which enforces it under its run lock.
      restart: (argv, io, request) => runRestart(argv, io, { ...restartRealSources, home: input.home }, { selfRequest: request }),
      // The notice goes to the lead in the request's own session.
      notify: (one) => writeRuntimeNotice({ home: input.home, root: loaded.root, session: one.session, lead: one.lead, id: one.id, body: one.body, at: new Date().toISOString() }).ok,
    },
    ...(launchFile === undefined ? {} : { launchFile }),
  });
}

/** The relaunch's real world: the restart command, the channel proof, the probe and the lead
 *  notice, each through its existing writer. */
function realRelaunchDeps(home: string, root: string, session: string, lead: string): RestoreRelaunchDeps {
  const restartSources = { ...restartRealSources, home };
  return {
    restart: (argv, io) => runRestart(argv, io, restartSources),
    unproven: (seat) => {
      const key = messageKeyState(home);
      if (key.kind !== 'key') return 'no message key';
      return channelUnproven({
        dropDir: seatDropDir(root, session, seat), root, session, seat,
        context: { to: seat, root, session, ...(lead === '' ? {} : { lead }) }, key: key.key, nowMs: Date.now(),
      });
    },
    probe: (seat) => {
      const key = messageKeyState(home);
      if (key.kind !== 'key') return;
      const live = inboxLive(seatDropDir(root, session, seat), root, session, seat);
      if (!live.live || live.listener.channel !== true) return;
      const listenerKey = listenerKeyOf(live.listener);
      if (pendingProbe({ root, session, seat, key: key.key, listenerKey, nowMs: Date.now(), ...(lead === '' ? {} : { lead }) }) !== null) return;
      placeChannelProbe({ home, root, session, seat, listenerKey, now: new Date() });
    },
    notify: (one) => writeRuntimeNotice({ home, root, session, lead: one.lead, id: one.id, body: one.body, at: new Date().toISOString() }).ok,
  };
}
