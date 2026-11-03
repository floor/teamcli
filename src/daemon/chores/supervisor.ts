// The daemon's half of the chores isolation: one supervised child per group of roots, on the
// daemon's existing heartbeat.
//
// The supervisor adds no timer of its own. Each daemon beat nudges the child, checks that its
// heartbeat is current, and starts a replacement when the last one left. A child that misses the
// configured number of beats is ended and replaced with a capped, doubling back-off, so a child
// that cannot come up is never retried on every beat. Nothing here awaits a child: a beat that
// finds a stuck child only signals it, and the daemon's socket, health answer and other roots
// keep moving.
//
// `inline` keeps this module out of the picture entirely — the daemon runs the chores on its own
// loop, exactly as before the isolation. `per-root`, the release default, is a child each, for a
// root whose work must not share a process at all. `shared` is one child for every root whose
// word is `shared`, so their work is one process's cost instead of one process each; the group's
// limits are the tightest of its roots', and the child serves the roots round-robin, a slice per
// turn, so one root's backlog delays another root's chores by a slice.
import type { TeamFile } from '../../file/types.ts';
import type { HostedWatchState } from '../../watch/hosted.ts';
import { routeId, type HostedRoute } from '../routes.ts';
import type { DaemonChoresState } from '../state.ts';
import type { HostedWatch } from '../watch.ts';
import type { ChoresPolicy } from './policy.ts';
import { tightestPolicy } from './policy.ts';
import { spawnChoresChild, type ChoresChild, type ChoresChildEvent, type SpawnChoresInput } from './spawn.ts';
import type {
  ChoresChildConfig,
  ChoresMarkerCache,
  ChoresPresenceProof,
  ChoresPresenceReading,
  ChoresWatchSeatHealth,
} from './protocol.ts';

export type ChoresRouteInput = {
  route: HostedRoute;
  team: TeamFile;
  policy: ChoresPolicy;
  /** The team file's folder, where the seat state door and the presence spool live. The child's
   *  presence steps read it, so it is carried in the token beside the validated team file. */
  stateDir?: string;
  /** The route's hosted watch, when this daemon hosts one: the team file the watch is bound to,
   *  and whether the daemon relays per-seat presence health with every beat. Absent, the route's
   *  watch stays on the daemon's own loop. */
  watch?: { teamFile: string; presence: boolean };
};

export type ChoresFleetInput = {
  home: string;
  /** The daemon's heartbeat interval: the child's heartbeat cadence and the kill clock. */
  beatMs: number;
  /** The daemon's own start instant, recorded in each child's config. */
  since: string;
  now: () => Date;
  routes: readonly ChoresRouteInput[];
  log: (text: string) => void;
  /** Starts one child. The default writes a one-use token and spawns this program's own hidden
   *  verb; a test injects a fixture child to observe the protocol. */
  factory?: (input: SpawnChoresInput) => ChoresChild;
  /** How long a terminated child gets before it is forced. */
  killGraceMs?: number;
  /** How long a presence answer waits for the child before the daemon gives it up and holds the
   *  route's seats for that pass. A child that stopped answering must not hold the pass forever;
   *  the child's late answer is dropped as one for a nudge no longer pending. */
  presenceDeadlineMs?: number;
  /** One route's hosted watch reached a seat seam and a daemon beat is due. The daemon's own
   *  beat machinery decides which other routes that beat renews; this hook only carries the
   *  fact across the pipe. */
  watchPulse?: (root: string, at: Date) => void;
};

export type ChoresFleet = {
  /** One daemon beat: nudges each child, checks its heartbeat, starts what is due. */
  tick(at: Date): void;
  /** Asks the child that serves this root to run one presence pass over the daemon's measured
   *  readings. Null when no ready child serves the root right now, so the daemon runs the steps
   *  inline for this pass instead. The answer settles when the child reports, or when it leaves
   *  or is stopped before it does; it never rejects. */
  presence(request: ChoresPresenceRequest): Promise<ChoresPresenceAnswer> | null;
  /** The record for one hosted root; undefined when this fleet has nothing to say about it. */
  stateFor(root: string): DaemonChoresState | undefined;
  /**
   * The daemon's handle on one route's watch where that watch runs in a child. Null when this
   * fleet does not carry that route's watch (inline, or the route names none), so the daemon
   * builds its own host exactly as before. `presence` is read on every beat the fleet sends:
   * the caller answers the route's declared seats, or null when it hosts no presence for it.
   */
  watchFor(root: string, presence: () => readonly ChoresWatchSeatHealth[] | null): HostedWatch | null;
  /** Ends every child and waits, bounded, for each to leave. Idempotent. */
  stop(why: string): Promise<void>;
};

export type ChoresPresenceRequest = {
  root: string;
  /** The daemon's measured instant for this pass; the child reconciles and publishes at it. */
  at: Date;
  /** One reading per runtime source, taken by the daemon after this pass's ingest step. */
  readings: readonly ChoresPresenceReading[];
};

/** What the child made of one presence nudge: the proof row per reading and the notes its log
 *  should carry, or the reason it could not answer for this pass. */
export type ChoresPresenceAnswer =
  | { kind: 'answered'; proofs: ChoresPresenceProof[]; notes: string[] }
  | { kind: 'unavailable'; why: string };

const DEFAULT_KILL_GRACE_MS = 2_000;

/** How long the daemon waits for a child's presence answer when the caller names no deadline:
 *  two default heartbeats, the same bound after which the child would be replaced. */
const DEFAULT_PRESENCE_DEADLINE_MS = 10_000;

type Group = {
  mode: 'per-root' | 'shared';
  routes: ChoresRouteInput[];
  policy: ChoresPolicy;
  child: ChoresChild | null;
  unsubscribe: (() => void) | null;
  startedAtMs: number;
  lastBeatMs: number | null;
  rssBytes: number | null;
  busy: string | null;
  ready: boolean;
  startedOnce: boolean;
  /** The child was signalled because it stopped answering; its exit is the restart's trigger. */
  killing: boolean;
  /** How many children this group has replaced: the record's own count, never reset. */
  restarts: number;
  /** The exponent the next wait reads: the number of starts that failed since the last child
   *  proved a run. A child that has beaten twice since it started resets it, so a long healthy
   *  life is never charged to the next restart. */
  backoff: number;
  /** Heartbeats this child has sent since it started; the second one proves a run. */
  beats: number;
  nextStartAtMs: number;
  /** How the last child left, for the record and the log. */
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** The last completed pass per root, keyed by canonical root. */
  lastPass: Map<string, { at: string; notes: string[] }>;
  /** Presence nudges this child has not answered yet, keyed by their nudge id. A child that
   *  leaves or is stopped settles them as unavailable, so the daemon's pass never waits forever. */
  pendingPresence: Map<string, (answer: ChoresPresenceAnswer) => void>;
  /** The last watch state each watched root's child reported, keyed by canonical root. The
   *  daemon's record mirrors it; a root the child has not reported yet has no entry, and its
   *  reader sees the synthetic starting state instead. */
  watchState: Map<string, HostedWatchState>;
  /** The last chore each root's child finished, by the name that root's own frame carried. A
   *  replacement child starts with none: a cold process has run nothing for the root yet. */
  lastChore: Map<string, { name: string; at: string; ms: number | null }>;
  /** The last presence pass each root's child answered, and what it proved. Presence work is a
   *  chore too: the row says when the child last answered one and whether every seat proved. */
  presence: Map<string, { at: string; ms: number | null; proved: number; missed: number }>;
  /** The child's own marker-cache reading from its latest heartbeat. One cache serves every root
   *  a shared child carries, so each of that child's rows reports the same reading. */
  markerCache: ChoresMarkerCache | null;
  /** Fault diagnostics this child accepted but has not answered yet, keyed by canonical root.
   *  `left` is the writer's answer once the run leaves its seam; `refused` answers a child that
   *  had no run to end, and an unexpected exit answers every one still waiting. */
  watchFaults: Map<string, { left: (recorded: string) => void; refused?: (why: string) => void }>;
  why: string | null;
  stopping: boolean;
};

/** Whole beats a heartbeat is overdue by: one that is merely due now is not missed. */
function overdueBeats(lastBeatMs: number | null, startedAtMs: number, ms: number, beatMs: number): number {
  const reference = lastBeatMs ?? startedAtMs;
  return Math.max(0, Math.ceil((ms - reference) / beatMs) - 1);
}

function rootList(group: Group): string {
  return group.routes.map((entry) => entry.route.root).join(', ');
}

/** How a child left, as the record and the log say it. */
function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `was ended by ${signal}`;
  return code === null ? 'left without an exit code' : `exited with code ${String(code)}`;
}

/** One group's supervisor: spawn, replace, report. */
function createGroup(input: ChoresFleetInput, routes: ChoresRouteInput[], mode: 'per-root' | 'shared'): Group {
  const policy = mode === 'shared' ? tightestPolicy(routes.map((entry) => entry.policy)) : routes[0]!.policy;
  return {
    mode,
    routes,
    policy,
    child: null,
    unsubscribe: null,
    startedAtMs: 0,
    lastBeatMs: null,
    rssBytes: null,
    busy: null,
    ready: false,
    startedOnce: false,
    killing: false,
    restarts: 0,
    backoff: 0,
    beats: 0,
    nextStartAtMs: 0,
    lastExit: null,
    lastPass: new Map(),
    pendingPresence: new Map(),
    watchState: new Map(),
    lastChore: new Map(),
    presence: new Map(),
    markerCache: null,
    watchFaults: new Map(),
    why: null,
    stopping: false,
  };
}

/** Settles every unanswered presence nudge with one reason, so a pass awaiting the child never
 *  outlives it. Called when the child leaves, is stopped, or is replaced. */
function settlePresence(group: Group, why: string): void {
  if (group.pendingPresence.size === 0) return;
  const pending = [...group.pendingPresence.values()];
  group.pendingPresence.clear();
  for (const settle of pending) settle({ kind: 'unavailable', why });
}

/** Answers every accepted watch fault still waiting on this child. Called when an unexpected
 *  exit takes the run with it: no seam remains for the fault to reach. */
function settleWatchFaults(group: Group, why: string): void {
  if (group.watchFaults.size === 0) return;
  const pending = [...group.watchFaults.values()];
  group.watchFaults.clear();
  for (const entry of pending) entry.refused?.(why);
}

/** Replaces every watched root's mirrored state with the synthetic record for "no run has
 *  reported on this child": starting before work, stopped once the child is asked to end. The
 *  record closes effects and carries the host's own reason; a reader must never see a live run
 *  behind a child that is not there. */
function resetWatchMirror(
  input: ChoresFleetInput,
  group: Group,
  phase: 'starting' | 'stopped',
  why: string | null,
): void {
  for (const entry of group.routes) {
    if (entry.watch === undefined) continue;
    group.watchState.set(entry.route.root, {
      routeId: routeId(entry.route),
      root: entry.route.root,
      team: entry.route.team,
      session: entry.route.session,
      phase,
      startedAt: group.startedAtMs === 0 ? input.since : new Date(group.startedAtMs).toISOString(),
      lastCycleAt: null,
      lastCycleOutcome: null,
      cycles: 0,
      failures: 0,
      effects: 'blocked',
      required: true,
      why,
    });
  }
}

function tickGroup(input: ChoresFleetInput, group: Group, at: Date): void {
  if (group.stopping) return;
  const ms = at.getTime();
  const child = group.child;
  if (child === null) {
    if (ms < group.nextStartAtMs) return;
    startGroup(input, group, at);
    return;
  }
  child.send({ type: 'tick', id: `${String(ms)}-${String(group.restarts)}`, at: at.toISOString() });
  if (group.killing) return;
  const missed = overdueBeats(group.lastBeatMs, group.startedAtMs, ms, input.beatMs);
  if (missed < group.policy.missedBeats) return;
  group.killing = true;
  group.why = `the child missed ${String(group.policy.missedBeats)} heartbeats`;
  input.log(`chores ${rootList(group)}: ${group.why}; ending it and starting a replacement`);
  child.kill(group.why, input.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
}

function startGroup(input: ChoresFleetInput, group: Group, at: Date): void {
  const config: ChoresChildConfig = {
    version: 1,
    home: input.home,
    beatMs: input.beatMs,
    sliceMs: group.policy.sliceMs,
    since: input.since,
    routes: group.routes.map((entry) => ({
      root: entry.route.root,
      team: entry.route.team,
      session: entry.route.session,
      ...(entry.stateDir === undefined ? {} : { stateDir: entry.stateDir }),
      teamFile: entry.team,
      ...(entry.watch === undefined ? {} : { watch: entry.watch }),
    })),
  };
  let child: ChoresChild;
  try {
    child = (input.factory ?? spawnChoresChild)({ config });
  } catch (error) {
    // A factory that throws is this start's failure: the restart path decides the next one.
    group.startedOnce = true;
    group.restarts += 1;
    group.backoff += 1;
    const wait = Math.min(group.policy.backoffCapMs, 1000 * 2 ** (group.backoff - 1));
    group.nextStartAtMs = at.getTime() + wait;
    group.why = `the child could not be started: ${error instanceof Error ? error.message : String(error)}`;
    input.log(`chores ${rootList(group)}: ${group.why}; starting again in ${String(wait)} ms`);
    return;
  }
  group.child = child;
  group.startedAtMs = at.getTime();
  group.lastBeatMs = null;
  group.rssBytes = null;
  group.busy = null;
  group.ready = false;
  group.killing = false;
  group.beats = 0;
  group.lastExit = null;
  group.startedOnce = true;
  group.why = null;
  // A replacement starts with no proved run: every watched root reads starting, effects closed,
  // until the new child reports its own first state. Its chore row starts empty for the same
  // reason: this process has run nothing for the root and holds no marker stamps yet.
  resetWatchMirror(input, group, 'starting', null);
  group.lastChore.clear();
  group.presence.clear();
  group.markerCache = null;
  group.unsubscribe = child.subscribe((event) => onChildEvent(input, group, child, event));
  void child.exited.then(() => onChildExit(input, group, child));
}

function onChildEvent(input: ChoresFleetInput, group: Group, child: ChoresChild, event: ChoresChildEvent): void {
  if (group.child !== child) return;
  if (event.kind === 'note') {
    input.log(`chores ${rootList(group)}: ${event.text}`);
    return;
  }
  if (event.kind === 'exit') {
    group.lastExit = { code: event.code, signal: event.signal };
    return;
  }
  const message = event.message;
  switch (message.type) {
    case 'ready':
      group.ready = true;
      return;
    case 'heartbeat':
      group.lastBeatMs = Date.parse(message.at);
      if (!Number.isFinite(group.lastBeatMs)) group.lastBeatMs = input.now().getTime();
      group.rssBytes = message.rssBytes;
      group.busy = message.busy;
      group.markerCache = message.markerCache;
      group.beats += 1;
      // Two heartbeats span a full beat interval: this child's loop moved on its own after it
      // started, so the next failure waits the first step again. A child that dies before its
      // second beat is a start that did not take, and keeps the doubling wait.
      if (group.ready && group.beats >= 2) group.backoff = 0;
      return;
    case 'pass':
      for (const pass of message.passes) {
        group.lastPass.set(pass.root, { at: pass.at, notes: pass.notes });
        // A frame that names no chore leaves the row's own name alone rather than inventing one.
        if (pass.chore !== null) {
          group.lastChore.set(pass.root, { name: pass.chore, at: pass.at, ms: pass.ms });
        }
        for (const note of pass.notes) input.log(`chores ${pass.root}: ${note}`);
      }
      return;
    case 'presence-result': {
      // A result whose nudge is no longer pending is a late answer for a pass the daemon already
      // gave up on: dropped, never delivered twice. It never reaches the row either, so the row
      // only ever says what an accepted pass proved.
      const settle = group.pendingPresence.get(message.id);
      if (settle === undefined) return;
      group.pendingPresence.delete(message.id);
      const proved = message.proofs.filter((proof) => 'id' in proof).length;
      group.presence.set(message.root, {
        at: message.at,
        ms: message.ms,
        proved,
        missed: message.proofs.length - proved,
      });
      group.lastChore.set(message.root, { name: 'presence', at: message.at, ms: message.ms });
      settle({ kind: 'answered', proofs: message.proofs, notes: message.notes });
      return;
    }
    case 'watch-state':
      // A root this group does not serve is dropped: the mirror is the group's own record.
      if (!group.routes.some((entry) => entry.route.root === message.root)) return;
      group.watchState.set(message.root, message.state);
      return;
    case 'watch-pulse':
      input.watchPulse?.(message.root, new Date(message.at));
      return;
    case 'watch-fault-result': {
      // A result with no accepted fault waiting is a late answer: dropped, never written twice.
      const waiting = group.watchFaults.get(message.root);
      if (waiting === undefined) return;
      group.watchFaults.delete(message.root);
      if (message.outcome === 'left') waiting.left(message.why);
      else waiting.refused?.(message.why);
      return;
    }
    case 'note':
      input.log(`chores ${rootList(group)}: ${message.text}`);
      return;
    case 'stopped':
      return;
  }
}

function onChildExit(input: ChoresFleetInput, group: Group, child: ChoresChild): void {
  if (group.child !== child) return;
  group.child = null;
  group.unsubscribe?.();
  group.unsubscribe = null;
  group.ready = false;
  group.killing = false;
  group.lastBeatMs = null;
  group.rssBytes = null;
  group.busy = null;
  // The dead child's chore row leaves with it: its cache was that process's memory, and the
  // next row is about a replacement, not about work the replacement has not done.
  group.lastChore.clear();
  group.presence.clear();
  group.markerCache = null;
  // A presence pass the child had not answered dies with it: the daemon holds that seat's proof
  // until a later pass has a child again, and never re-runs the steps behind the leaving child.
  settlePresence(group, 'the child left before it answered the presence pass');
  // A fault accepted for a run this exit took with it has no seam left: the writer is answered
  // now. A deliberate stop leaves its faults for the daemon's close, which answers them as not
  // reached, exactly as it does for a watch that never reached its seam.
  if (!group.stopping) settleWatchFaults(group, 'the chores child left before the fault reached the watch');
  resetWatchMirror(
    input,
    group,
    group.stopping ? 'stopped' : 'starting',
    group.stopping ? group.why : 'the chores child left; a replacement starts on a later beat',
  );
  if (group.stopping) return;
  group.restarts += 1;
  group.backoff += 1;
  const wait = Math.min(group.policy.backoffCapMs, 1000 * 2 ** (group.backoff - 1));
  group.nextStartAtMs = input.now().getTime() + wait;
  const reason = exitReason(group.lastExit?.code ?? null, group.lastExit?.signal ?? null);
  group.why = `the child ${reason}`;
  input.log(`chores ${rootList(group)}: the child ${reason}; starting a replacement in ${String(wait)} ms`);
}

/** One row for one root of a group, at this reading's instant. */
function groupRow(input: ChoresFleetInput, group: Group, root: string): DaemonChoresState {
  const ms = input.now().getTime();
  const missed = group.child === null || group.lastBeatMs === null
    ? 0
    : Math.min(
        group.policy.missedBeats,
        overdueBeats(group.lastBeatMs, group.startedAtMs, ms, input.beatMs),
      );
  const state: DaemonChoresState['state'] = group.stopping
    ? 'stopped'
    : group.child === null
      ? (group.startedOnce ? 'restarting' : 'starting')
      : group.ready
        ? (missed > 0 ? 'late' : 'ok')
        : 'starting';
  const pass = group.lastPass.get(root);
  const why = group.stopping
    ? 'the daemon is stopping this child'
    : group.child === null
      ? group.why
      : missed > 0
        ? `the child has missed ${String(missed)} heartbeat${missed === 1 ? '' : 's'}`
        : null;
  return {
    mode: group.mode,
    state,
    pid: group.child?.pid ?? null,
    startedAt: group.startedOnce ? new Date(group.startedAtMs).toISOString() : null,
    heartbeatAt: group.lastBeatMs === null ? null : new Date(group.lastBeatMs).toISOString(),
    rssBytes: group.rssBytes,
    busy: group.busy,
    restarts: group.restarts,
    missed,
    lastPassAt: pass?.at ?? null,
    lastPass: pass?.notes ?? null,
    lastChore: group.lastChore.get(root) ?? null,
    presence: group.presence.get(root) ?? null,
    markerCache: group.markerCache,
    nextStartAt: group.child === null && !group.stopping && group.startedOnce
      ? new Date(group.nextStartAtMs).toISOString()
      : null,
    why,
  };
}

export function createChoresFleet(input: ChoresFleetInput): ChoresFleet {
  const groups: Group[] = [];
  const inline = new Map<string, DaemonChoresState>();
  const shared: ChoresRouteInput[] = [];
  for (const entry of input.routes) {
    if (entry.policy.mode === 'inline') {
      inline.set(entry.route.root, {
        mode: 'inline',
        state: 'inline',
        pid: null,
        startedAt: null,
        heartbeatAt: null,
        rssBytes: null,
        busy: null,
        restarts: 0,
        missed: 0,
        lastPassAt: null,
        lastPass: null,
        lastChore: null,
        presence: null,
        markerCache: null,
        nextStartAt: null,
        why: null,
      });
    } else if (entry.policy.mode === 'shared') {
      shared.push(entry);
    } else {
      const group = createGroup(input, [entry], 'per-root');
      if (entry.policy.unknown !== undefined) input.log(`chores ${entry.route.root}: ${entry.policy.unknown}; the release defaults are in force`);
      groups.push(group);
    }
  }
  if (shared.length > 0) {
    if (shared.some((entry) => entry.policy.unknown !== undefined)) {
      input.log(`chores ${shared.map((entry) => entry.route.root).join(', ')}: a policy value could not be read; the release defaults are in force`);
    }
    groups.push(createGroup(input, shared, 'shared'));
  }

  let stopRun: Promise<void> | null = null;
  let presenceSeq = 0;
  return {
    tick(at: Date): void {
      for (const group of groups) tickGroup(input, group, at);
    },
    presence(request: ChoresPresenceRequest): Promise<ChoresPresenceAnswer> | null {
      for (const group of groups) {
        if (!group.routes.some((entry) => entry.route.root === request.root)) continue;
        const child = group.child;
        // Only a ready child that is not being stopped or replaced may take a pass: until then
        // the daemon's own inline steps answer, exactly as they did before the isolation.
        if (child === null || !group.ready || group.killing || group.stopping) return null;
        const id = `${String(input.now().getTime())}-${String(group.restarts)}-${String(presenceSeq)}`;
        presenceSeq += 1;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let settle!: (answer: ChoresPresenceAnswer) => void;
        const answer = new Promise<ChoresPresenceAnswer>((resolve) => {
          settle = (value: ChoresPresenceAnswer) => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
            resolve(value);
          };
        });
        group.pendingPresence.set(id, settle);
        const sent = child.send({
          type: 'presence',
          id,
          root: request.root,
          at: request.at.toISOString(),
          readings: [...request.readings],
        });
        if (!sent) {
          group.pendingPresence.delete(id);
          return null;
        }
        // The pass has its own deadline. A child that stopped answering cannot hold this route's
        // presence forever: the daemon gives the nudge up, holds the seats for the pass, and a
        // later nudge is a fresh question. A late answer finds no pending nudge and is dropped.
        const deadlineMs = input.presenceDeadlineMs ?? DEFAULT_PRESENCE_DEADLINE_MS;
        timer = setTimeout(() => {
          if (group.pendingPresence.get(id) !== settle) return;
          group.pendingPresence.delete(id);
          settle({
            kind: 'unavailable',
            why: `the child did not answer the presence pass within ${String(deadlineMs)} ms`,
          });
        }, deadlineMs);
        timer.unref();
        return answer;
      }
      return null;
    },
    stateFor(root: string): DaemonChoresState | undefined {
      const row = inline.get(root);
      if (row !== undefined) return row;
      for (const group of groups) {
        if (group.routes.some((entry) => entry.route.root === root)) return groupRow(input, group, root);
      }
      return undefined;
    },
    watchFor(root: string, presence: () => readonly ChoresWatchSeatHealth[] | null): HostedWatch | null {
      const group = groups.find((candidate) => candidate.routes.some((entry) => entry.route.root === root));
      const entry = group?.routes.find((candidate) => candidate.route.root === root);
      if (group === undefined || entry === undefined || entry.watch === undefined) return null;
      const route = entry.route;
      const watchConfig = entry.watch;
      // No child has reported on this root yet: no run is proved, so effects are closed and the
      // phase is starting. This is the same shape every reset writes, never a guess at a run.
      const synthetic = (): HostedWatchState => ({
        routeId: routeId(route),
        root: route.root,
        team: route.team,
        session: route.session,
        phase: 'starting',
        startedAt: group.startedAtMs === 0 ? input.since : new Date(group.startedAtMs).toISOString(),
        lastCycleAt: null,
        lastCycleOutcome: null,
        cycles: 0,
        failures: 0,
        effects: 'blocked',
        required: true,
        why: null,
      });
      return {
        route,
        state: () => group.watchState.get(root) ?? synthetic(),
        tick: (at: Date): void => {
          // A child that is not ready, is being replaced or is stopping gets no beat: its run's
          // authority is not renewed behind a supervisor decision.
          const child = group.child;
          if (child === null || !group.ready || group.killing || group.stopping) return;
          const health = watchConfig.presence ? presence() : null;
          child.send({
            type: 'watch-beat',
            root,
            at: at.toISOString(),
            presence: health === null ? null : [...health],
          });
        },
        fault: (why: string, left: (recorded: string) => void, refused?: (why: string) => void): boolean => {
          const child = group.child;
          if (child === null || !group.ready || group.killing || group.stopping) return false;
          // The host's own refusals, read from what the child last reported: a standby or a
          // stopped host has no run to end. One accepted fault at a time, so a second request
          // can never replace the first writer's answer.
          const mirror = group.watchState.get(root);
          if (mirror !== undefined && (!mirror.required || mirror.phase === 'standby' || mirror.phase === 'stopped')) {
            return false;
          }
          if (group.watchFaults.has(root)) return false;
          if (!child.send({ type: 'watch-fault', root, why })) return false;
          group.watchFaults.set(root, refused === undefined ? { left } : { left, refused });
          return true;
        },
        // The fleet's own stop ends the child that owns this run; this handle has no run of its
        // own, so its stop is the fleet's to make and the record follows the child's exit.
        stop: (): Promise<void> => Promise.resolve(),
        done: Promise.resolve(),
      };
    },
    stop(why: string): Promise<void> {
      if (stopRun !== null) return stopRun;
      const waits: Promise<void>[] = [];
      for (const group of groups) {
        if (group.stopping) continue;
        group.stopping = true;
        group.why = why;
        settlePresence(group, 'the daemon is stopping this child');
        const child = group.child;
        if (child === null) continue;
        child.kill(why, input.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
        // A child that never leaves must not hold the daemon's close: the forced signal above
        // is what ends it, and this bound only keeps the close from waiting past it.
        const bound = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
        waits.push(Promise.race([
          child.exited,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, bound * 2 + 500);
            timer.unref();
          }),
        ]));
      }
      stopRun = Promise.all(waits).then(() => undefined);
      return stopRun;
    },
  };
}
