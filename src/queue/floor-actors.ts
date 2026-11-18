// The live actors of a root, read for the activation check (rfc-event-comms §3, steps E6 and E7b).
//
// E7b revision 3: a stamped record lives only where no level-2 code lists or opens it (the
// `send-stamped/` tree), so an older inbox server or watch still running can never read, expose
// or settle one. Activation therefore needs only the machine daemon at the floor: it hosts the
// delivery legs, the watches, the wake and retry workers and the send host, one build. The daemon
// is read from its state record; a record that cannot be read is no proof (null: fail closed).
import { pidAlive } from '../mcp/inbox.ts';
import { readDaemonState } from '../daemon/state.ts';
import type { FloorActor } from './floor.ts';

/** The live actors for `root` (the daemon only); null when the daemon record cannot be read. */
export function liveFloorActors(root: string, home: string): FloorActor[] | null {
  void root;
  const daemon = readDaemonState(home);
  if (daemon.kind === 'unreadable') return null;
  if (daemon.kind !== 'ok' || !pidAlive(daemon.state.pid)) return [];
  return [{ kind: 'daemon', name: 'daemon', pid: daemon.state.pid, build: daemon.state.version, level: daemon.state.floorLevel ?? null }];
}
