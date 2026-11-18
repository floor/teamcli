// The live actors of a root, read for the activation check (rfc-event-comms §3, step E6).
//
// The actors are the long-lived processes that can read or deliver mail for the root: the daemon
// (which hosts the watches, the wake, typed and app-server legs, the retry workers and the send
// host) and each seat's MCP inbox server. A `team` command a seat runs (ack, reply, drops) executes
// the installed package, so after an install it is at the installed level by construction and is
// not an actor (E7b, the coordinator's decision). For each seat, the answer is one of:
//   - not an actor: no live CLI and no live marker; or a live CLI with no marker whose current
//     managed launch signed level >= the floor and names that CLI process (src/queue/launch-level.ts);
//   - live and reporting a level: the marker is readable, bound to this root, session and seat,
//     and its process is alive;
//   - unknown: an unreadable or malformed marker, a marker bound elsewhere, a marker that stands
//     while its process is gone and the seat's launched CLI is live, a folder or state that cannot
//     be read. Unknown is an actor of level null, which refuses activation (fail closed) until the
//     marker is cleaned or the seat is relaunched.
// The machine daemon (which hosts the watches, wake and retry workers and the send host, one build)
// is read from its state record. A listener marker for a seat the state does not record is an
// actor too, never dropped.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, readListener } from '../mcp/inbox.ts';
import { readDaemonState } from '../daemon/state.ts';
import { readState } from '../state.ts';
import { FLOOR_LEVEL, type FloorActor } from './floor.ts';
import { launchLevelProves } from './launch-level.ts';
import { processStartOf } from '../watch/pane.ts';

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
    // No marker. A seat whose CLI is not live is not an actor. A live one is not an actor only on
    // positive evidence: its current managed launch signed level >= the floor and names this live
    // CLI process (pid and start instant), so any inbox server it has came from this build or
    // later. Anything else (no record, a pending one, an older launch, another process) is unknown.
    if (marker === 'absent') {
      if (!launchedLive) return;
      if (launchLevelProves(root, home, session, seat, FLOOR_LEVEL, { alive: pidAlive, startOf: processStartOf })) return;
      return unknown(`${name} (live CLI, no inbox marker, no level-${String(FLOOR_LEVEL)} launch record)`, 0);
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
