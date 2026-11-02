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
// loop, exactly as before the isolation. `shared`, the release default, is one child for every
// root whose word is `shared`, so their work is one process's cost instead of one process each;
// the group's limits are the tightest of its roots', and the child serves the roots round-robin,
// a slice per turn, so one root's backlog delays another root's chores by a slice. `per-root` is
// a child each, for a root whose work must not share a process at all.
import type { TeamFile } from '../../file/types.ts';
import type { HostedRoute } from '../routes.ts';
import type { DaemonChoresState } from '../state.ts';
import type { ChoresPolicy } from './policy.ts';
import { tightestPolicy } from './policy.ts';
import { spawnChoresChild, type ChoresChild, type ChoresChildEvent, type SpawnChoresInput } from './spawn.ts';
import type { ChoresChildConfig } from './protocol.ts';

export type ChoresRouteInput = {
  route: HostedRoute;
  team: TeamFile;
  policy: ChoresPolicy;
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
};

export type ChoresFleet = {
  /** One daemon beat: nudges each child, checks its heartbeat, starts what is due. */
  tick(at: Date): void;
  /** The record for one hosted root; undefined when this fleet has nothing to say about it. */
  stateFor(root: string): DaemonChoresState | undefined;
  /** Ends every child and waits, bounded, for each to leave. Idempotent. */
  stop(why: string): Promise<void>;
};

const DEFAULT_KILL_GRACE_MS = 2_000;

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
  restarts: number;
  nextStartAtMs: number;
  /** How the last child left, for the record and the log. */
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null;
  /** The last completed pass per root, keyed by canonical root. */
  lastPass: Map<string, { at: string; notes: string[] }>;
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
    nextStartAtMs: 0,
    lastExit: null,
    lastPass: new Map(),
    why: null,
    stopping: false,
  };
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
    })),
  };
  let child: ChoresChild;
  try {
    child = (input.factory ?? spawnChoresChild)({ config });
  } catch (error) {
    // A factory that throws is this start's failure: the restart path decides the next one.
    group.startedOnce = true;
    group.restarts += 1;
    const wait = Math.min(group.policy.backoffCapMs, 1000 * 2 ** (group.restarts - 1));
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
  group.lastExit = null;
  group.startedOnce = true;
  group.why = null;
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
      return;
    case 'pass':
      for (const pass of message.passes) {
        group.lastPass.set(pass.root, { at: pass.at, notes: pass.notes });
        for (const note of pass.notes) input.log(`chores ${pass.root}: ${note}`);
      }
      return;
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
  if (group.stopping) return;
  group.restarts += 1;
  const wait = Math.min(group.policy.backoffCapMs, 1000 * 2 ** (group.restarts - 1));
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
  return {
    tick(at: Date): void {
      for (const group of groups) tickGroup(input, group, at);
    },
    stateFor(root: string): DaemonChoresState | undefined {
      const row = inline.get(root);
      if (row !== undefined) return row;
      for (const group of groups) {
        if (group.routes.some((entry) => entry.route.root === root)) return groupRow(input, group, root);
      }
      return undefined;
    },
    stop(why: string): Promise<void> {
      if (stopRun !== null) return stopRun;
      const waits: Promise<void>[] = [];
      for (const group of groups) {
        if (group.stopping) continue;
        group.stopping = true;
        group.why = why;
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
