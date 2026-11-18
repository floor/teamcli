// The live actors of a root, read for the activation check (rfc-event-comms §3, step E6).
//
// Positive coverage, never "whatever markers we could read": every seat the root's state records
// as launched, whose launched CLI process is still alive, is an actor that must be accounted for by
// its own seat's inbox-listener marker. Each answer is one of:
//   - not live: no launched record, or every recorded CLI pid is gone;
//   - live and reporting a level: the marker is readable, bound to this root, session and seat,
//     and its process is alive;
//   - unknown: anything else (an unreadable or malformed marker, a marker bound elsewhere, a live
//     CLI with no marker, a folder or state that cannot be read). Unknown is an actor of level null,
//     which refuses activation and fences an active root. Nothing is skipped.
// The machine daemon (which hosts the watches, wake and retry workers and the send host, one build)
// is read from its state record. A listener marker for a seat the state does not record is an
// actor too, never dropped.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readListener } from '../mcp/inbox.ts';
import { readDaemonState } from '../daemon/state.ts';
import { readState } from '../state.ts';
import { launchIntents, releaseLaunch, type FloorActor } from './floor.ts';

function markerState(dropDir: string): 'absent' | 'unknown' | 'present' {
  try {
    lstatSync(join(dropDir, '.inbox-listener'));
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/** The live actors for `root`; null when the daemon record or the state cannot be read at all. */
export function liveFloorActors(root: string, home: string): FloorActor[] | null {
  const actors: FloorActor[] = [];
  const daemon = readDaemonState(home);
  if (daemon.kind === 'unreadable') return null;
  if (daemon.kind === 'ok' && pidAlive(daemon.state.pid)) {
    actors.push({ kind: 'daemon', name: 'daemon', pid: daemon.state.pid, build: daemon.state.version, level: daemon.state.floorLevel ?? null });
  }
  let state;
  try {
    state = readState(join(root, '.agents'));
  } catch {
    return null;
  }
  const seen = new Set<string>();
  const unknown = (name: string, pid: number): void => { actors.push({ kind: 'other', name, pid, build: null, level: null }); };
  const consider = (session: string, seat: string, launchedLive: boolean): void => {
    const name = `${session}/${seat}`;
    if (seen.has(name)) return;
    seen.add(name);
    const dropDir = join(root, '.agents', 'send-drops', session, seat);
    const marker = markerState(dropDir);
    if (marker === 'unknown') return unknown(name, 0);
    if (marker === 'absent') {
      if (launchedLive) unknown(`${name} (live CLI, no inbox marker)`, 0);
      return;
    }
    const listener = readListener(dropDir);
    if (listener === null) return unknown(`${name} (unreadable marker)`, 0);
    if (listener.root !== root || listener.session !== session || listener.seat !== seat) return unknown(`${name} (marker bound elsewhere)`, listener.pid);
    if (!pidAlive(listener.pid)) {
      if (launchedLive) unknown(`${name} (live CLI, dead inbox server)`, listener.pid);
      return;
    }
    actors.push({ kind: 'inbox-server', name, pid: listener.pid, build: listener.build ?? null, level: listener.level ?? null });
  };
  for (const [session, held] of Object.entries(state.sessions ?? {})) {
    for (const [seat, record] of Object.entries(held?.seats ?? {})) {
      const pids = record?.launched?.cli ?? [];
      consider(session, seat, pids.some(pid => pidAlive(pid)));
    }
  }
  // Markers for seats the state does not record are actors too.
  const base = join(root, '.agents', 'send-drops');
  let sessions: string[];
  try {
    sessions = readdirSync(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return actors;
    return null;
  }
  for (const session of sessions) {
    if (session.startsWith('.')) continue;
    let seats: string[];
    try {
      seats = readdirSync(join(base, session));
    } catch {
      return null;
    }
    for (const seat of seats) if (!seat.startsWith('.')) consider(session, seat, false);
  }
  return actors;
}

/** How long an intent whose launcher is gone, with nothing of its seat running, is kept before the
 *  start counts as abandoned. A terminal start can outlive the command that submitted it; a seat
 *  that runs anything (a recorded CLI pid alive, a live listener) is never judged abandoned. */
export const LAUNCH_ABANDON_MS = 10 * 60_000;

/**
 * Recovery for launch intents (E7). An intent whose launcher still runs is left alone (the launch
 * is in flight). For a gone launcher: the start is PROVED when the seat's own listener is live and
 * was published after the intent, and the intent is released; the start is ABANDONED only when the
 * intent is older than LAUNCH_ABANDON_MS and nothing of the seat runs. Anything else keeps the
 * intent, which the actor proof counts at unknown level (fail closed). Returns what it released.
 */
export function resolveLaunchReservations(root: string, nowMs: number = Date.now()): { released: string[]; kept: string[] } | null {
  const intents = launchIntents(root);
  if (intents === null) return null;
  let state;
  try {
    state = readState(join(root, '.agents'));
  } catch {
    return null;
  }
  const released: string[] = [];
  const kept: string[] = [];
  for (const intent of intents) {
    const name = `${intent.session}/${intent.seat}`;
    if (pidAlive(intent.pid)) {
      kept.push(name);
      continue;
    }
    const listener = readListener(join(root, '.agents', 'send-drops', intent.session, intent.seat));
    const listenerLive = listener !== null && listener.root === root && listener.session === intent.session
      && listener.seat === intent.seat && pidAlive(listener.pid);
    const proved = listenerLive && Date.parse(listener.ts) >= Date.parse(intent.at);
    const cliLive = (state.sessions?.[intent.session]?.seats?.[intent.seat]?.launched?.cli ?? []).some(pid => pidAlive(pid));
    const abandoned = !listenerLive && !cliLive && nowMs - Date.parse(intent.at) >= LAUNCH_ABANDON_MS;
    if ((proved || abandoned) && releaseLaunch(root, { session: intent.session, seat: intent.seat })) released.push(name);
    else kept.push(name);
  }
  return { released, kept };
}
