// The event bus in `team status` and `team check`, read from its process marker and the bus
// record `team up` keeps, never by dialling the socket. Nothing is said for a team that has never
// had a bus: polling is an ordinary way to run. A bus that serves is named in `status`; a bus that
// died, or one `team up` started and that is gone, is a note in both, with the repair.
import { busHealth } from './server.ts';

export type BusNoteInput = {
  root: string;
  alive: (pid: number) => boolean;
  /** The bus record `team up` wrote for this session, when it wrote one. */
  recorded?: { pane: string; workspace?: string } | undefined;
  /** `bus.autostart` as the file reads it; false names `team bus` as the repair instead. */
  autostart: boolean;
};

const REPAIR_UP = 'seats poll their inboxes until `team up` starts it again';
const REPAIR_OWNER = 'seats poll their inboxes until the owner runs `team bus` again';

/** Problems only: what `team check` prints. */
export function busProblemNotes(input: BusNoteInput): string[] {
  const health = busHealth(input.root, input.alive);
  const repair = input.autostart ? REPAIR_UP : REPAIR_OWNER;
  if (health.kind === 'dead') return [`bus: its process (pid ${health.pid}) is gone; ${repair}`];
  if (health.kind === 'absent' && input.recorded !== undefined) return [`bus: the bus team up started is not running; ${repair}`];
  return [];
}

/** Problems, and a serving bus named: what `team status` prints. */
export function busStatusNotes(input: BusNoteInput): string[] {
  const health = busHealth(input.root, input.alive);
  if (health.kind === 'running') return [`bus: running (pid ${health.pid}); seats follow it for new messages`];
  return busProblemNotes(input);
}
