// The wake child: one daemon-admitted typed wake, run in its own process.
//
// The daemon's send server answers `handed` at acceptance and never waits for the screen; this
// child owns the walk from there. It re-reads the seat live (one pane, not a bare shell), takes
// the seat lock, runs `deliverTypedWake` with the pane host, and writes its outcome — the history
// line, the trace step and the log line — before it exits. Nothing here types on its own: the
// walk is the one module that does, and this child only binds it to a session.
//
// The wake marker beside the staged copy is the reservation the daemon took before it spawned
// this child. A marker that reads `sent` or `read` is an earlier wake's: this request is the same
// wake asked twice and is coalesced with no second child's work. A walk that does not deliver
// gives the reservation back, so the message keeps its one wake; a delivered one records what it
// was seen to become. A child killed mid-walk leaves `reserved`, which is what was known at that
// point, and the watch's own retry in the project's drop folder is still there to wake the seat.
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PaneProcesses } from '../../herdr.ts';
import { acquireSeatLock } from '../../launch/seat-lock.ts';
import { logLine } from '../../log.ts';
import { appendHistory } from '../../send/history.ts';
import { legStep } from '../../send/steps.ts';
import type { TypedWakeHost, TypedWakeResult } from '../../send/typed-wake.ts';
import { markWake, releaseWake, wakeMarkAt, wakePath } from '../../send/wake-marker.ts';
import { findSeatAgent, isBareShellPane, type SeatAgents } from '../seat-live.ts';
import type { WakeChildRequest } from './token.ts';

/** What the child may read and run. The real entry binds herdr and the typed walk; a scene
 *  hands in its own answers, so no pane is typed into and no session is touched. */
export type WakeChildDeps = {
  agents: SeatAgents;
  processes(session: string, pane: string): PaneProcesses | null;
  /** The pane walk the child exists to run (`deliverTypedWake` in the real entry). */
  walk(host: TypedWakeHost, pane: string, line: string, cli: string): Promise<TypedWakeResult>;
  wakeHost(session: string): TypedWakeHost;
  now(): Date;
};

export type WakeChildOutcome =
  | { outcome: 'delivered'; reason: string }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'coalesced' };

/**
 * Runs one wake request to its ending and records it. Never throws for a screen the wake could
 * not take: every ending is an outcome word here and a line in the history and the trace. A
 * request whose marker is already sent or read is coalesced and records nothing.
 */
export async function serveWakeChild(request: WakeChildRequest, deps: WakeChildDeps): Promise<WakeChildOutcome> {
  const marker = wakePath(dirname(request.dropPath), request.id);
  const before = wakeMarkAt(marker);

  /** A mark the walk took on its own clock, counted from the moment the message was staged —
   *  the base the delivery bound reads its two times from. */
  const sinceStaged = (at: number | undefined): number | undefined =>
    at === undefined ? undefined : Math.max(0, at - request.stagedAt);

  const record = (reason: string, delivered: boolean, ms: number, walked?: TypedWakeResult): void => {
    const at = deps.now().toISOString();
    const outcome = delivered ? 'delivered (typed wake)' : 'unreachable';
    const submitMs = sinceStaged(walked?.submittedAt);
    const workingMs = sinceStaged(walked?.workingAt);
    try {
      appendHistory(request.project, request.root, request.home, {
        ts: at,
        from: request.from,
        to: request.seat,
        ...(request.spec === undefined ? {} : { spec: request.spec }),
        ...(request.resolved === undefined ? {} : { resolved: request.resolved }),
        ...(request.from_team === undefined ? {} : { from_team: request.from_team }),
        body: request.body,
        id: request.id,
        outcome,
        note: reason,
        ms,
        via: 'typed',
        ...(request.failed === undefined || request.failed.length === 0 ? {} : { failed: [...request.failed] }),
      });
    } catch {
      // The line is a record of the walk, never a condition of it: the marker and the trace
      // still say what was seen.
    }
    try {
      legStep(
        {
          store: { project: request.project, root: request.root, home: request.home },
          id: request.id,
          session: request.session,
          from: request.from,
          to: request.seat,
          ts: at,
        },
        {
          route: 'typed',
          outcome: delivered ? 'delivered' : 'unreachable',
          ms,
          reason,
          ...(submitMs === undefined ? {} : { submitMs }),
          ...(workingMs === undefined ? {} : { workingMs }),
        },
      );
    } catch {
      // A missing trace line is a missing record, never a failed wake.
    }
    logLine(
      request.dir,
      'send',
      request.from,
      delivered
        ? `${request.seat}: delivered (typed wake) (drop ${String(request.body.length)} characters, typed; ${reason})`
        : `${request.seat}: the typed wake did not land (${reason}); the drop is at ${request.dropPath}`,
      deps.now(),
    );
  };

  /** A guard refused before the walk could type: the reason is the line, and the reservation
   *  goes back so the message keeps its one wake. */
  const refuse = (reason: string): WakeChildOutcome => {
    releaseWake(marker);
    record(reason, false, Math.max(0, deps.now().getTime() - request.stagedAt));
    return { outcome: 'failed', reason };
  };

  // The reservation comes first: a request with no marker of its own does not type, and a marker
  // another wake already carried is the same wake asked twice, coalesced with no second child.
  if (before === null) {
    // The daemon takes the reservation before it starts a child. One that is absent belongs to a
    // wake another pass already gave back; one that cannot be read is never typed over or removed,
    // because what an earlier attempt did is unknown.
    const reason = existsSync(marker)
      ? 'the wake reservation could not be read; nothing was typed'
      : 'the wake reservation for this id was not found; nothing was typed';
    record(reason, false, Math.max(0, deps.now().getTime() - request.stagedAt));
    return { outcome: 'failed', reason };
  }
  if (before.state !== 'reserved') {
    // Another wake has already carried this message: a second request for the same id is the
    // same wake asked twice, and the marker is the reservation that coalesces it.
    return { outcome: 'coalesced' };
  }

  const found = findSeatAgent(deps.agents, request.session, request.seat);
  if (!found.ok) return refuse(found.reason);
  if (isBareShellPane(request.dir, request.session, request.seat, deps.processes(request.session, found.pane))) {
    return refuse('the seat is back at its shell; nothing was typed');
  }

  const lock = acquireSeatLock(request.dir, request.session, request.seat);
  if (!('release' in lock)) {
    return refuse(`another command holds the seat (pid ${String(lock.held)}); nothing was typed`);
  }
  try {
    const host = deps.wakeHost(request.session);
    const walk = await deps.walk(host, found.pane, request.line, request.cli);
    const ms = Math.max(0, deps.now().getTime() - request.stagedAt);
    if (!walk.delivered) {
      releaseWake(marker);
      record(walk.reason, false, ms, walk);
      return { outcome: 'failed', reason: walk.reason };
    }
    markWake(marker, {
      id: request.id,
      at: deps.now().toISOString(),
      state: 'sent',
      evidence: 'typed-wake',
    });
    record(walk.reason, true, ms, walk);
    return { outcome: 'delivered', reason: walk.reason };
  } finally {
    lock.release();
  }
}
