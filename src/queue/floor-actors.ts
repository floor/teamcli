// The live actors of a root, read for the activation check (rfc-event-comms §3, step E6).
//
// "Live" is every process with a presence record or a pane-bound inbox server for a seat of the
// root: the machine daemon (which hosts the watches, the wake and retry workers, and the send host
// in its own process tree, all of one build), and every seat's MCP inbox server, which keeps the
// code it started with until its seat restarts. Each reports the level it enforces; one that
// reports none is a build before E6, and its level is unknown.
import { pidAlive, readListener } from '../mcp/inbox.ts';
import { readDaemonState } from '../daemon/state.ts';
import { type FloorActor, seatDropFolders } from './floor.ts';

/**
 * The live actors for `root`, or null when one cannot be read (fail closed: no activation). A
 * listener whose process is gone is not live. A listener for another root is not this root's.
 */
export function liveFloorActors(root: string, home: string): FloorActor[] | null {
  const actors: FloorActor[] = [];
  const daemon = readDaemonState(home);
  if (daemon.kind === 'unreadable') return null;
  if (daemon.kind === 'ok' && pidAlive(daemon.state.pid)) {
    actors.push({ kind: 'daemon', name: 'daemon', pid: daemon.state.pid, build: daemon.state.version, level: daemon.state.floorLevel ?? null });
  }
  for (const dropDir of seatDropFolders(root)) {
    const listener = readListener(dropDir);
    if (listener === null) continue;
    if (listener.root !== root) continue;
    if (!pidAlive(listener.pid)) continue;
    actors.push({ kind: 'inbox-server', name: `${listener.session}/${listener.seat}`, pid: listener.pid, build: listener.build ?? null, level: listener.level ?? null });
  }
  return actors;
}
