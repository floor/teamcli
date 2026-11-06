// The install step that retires the shuttle units. It stays closed while the router child
// answers only a tick: that child has no ask, send, or reply path, so a fresh heartbeat is
// not a reason to stop the units that still route an ask. A unit the seam cannot remove is
// named once the gate is open, and the child stays up. Nothing here starts a shuttle again,
// and nothing here talks to a service manager: the caller supplies the one call that stops
// and removes a unit.
import { DAEMON_HEARTBEAT_SECONDS } from '../../policy/index.ts';
import { daemonStateAlive, readDaemonState } from '../state.ts';

/** The unit this step retires, once the gate below is open. Nothing replaces it. Older
 *  per-seat shuttle units are not named by the release; a fleet that still carries one
 *  removes it by hand. */
export const SHUTTLE_UNITS = ['io.teamcli.desk-shuttle'] as const;

/** Closed until the router child accepts an ask and an independent scene has exercised
 *  the send and the reply. While this is set, no install stops or removes a shuttle unit. */
export const SHUTTLE_RETIREMENT_HELD = true;

export type ShuttleRetirement = {
  /** The child is left up whether or not every unit came out. */
  child: 'up';
  retired: string[];
  failed: { label: string; why: string }[];
};

/**
 * Retires the shuttle units once the router has shown one fresh heartbeat and the ask path
 * is open. Before either of those, nothing is removed. A failed removal is reported and the
 * remaining units are still asked; the child is not stopped and the shuttles are not started
 * again.
 */
export function retireShuttles(input: {
  heartbeatFresh: boolean;
  retire(label: string): { ok: true } | { ok: false; why: string };
}): ShuttleRetirement {
  if (SHUTTLE_RETIREMENT_HELD || !input.heartbeatFresh) {
    return { child: 'up', retired: [], failed: [] };
  }
  const retired: string[] = [];
  const failed: { label: string; why: string }[] = [];
  for (const label of SHUTTLE_UNITS) {
    const result = input.retire(label);
    if (result.ok) retired.push(label);
    else failed.push({ label, why: result.why });
  }
  return { child: 'up', retired, failed };
}

/** How old a router heartbeat may be and still count. The child answers on the daemon's own
 *  beat, so three of those beats is the window, and never less than the short beat the
 *  status reading already calls recent. */
function mailboxFreshWindowMs(heartbeatSeconds: number | null | undefined): number {
  const beatMs = (heartbeatSeconds ?? DAEMON_HEARTBEAT_SECONDS.release) * 1000;
  return Math.max(beatMs * 3, 15_000);
}

/** Whether this daemon's own router heartbeat is recent. A missing record, a router that has
 *  not answered, a string that is not a time, a beat older than the window, a beat from a
 *  process that is gone, or a record whose uid is not this process, is not fresh. */
export function mailboxHeartbeatFresh(
  home: string,
  options: { now?: number; alive?: (pid: number) => boolean } = {},
): boolean {
  const reading = readDaemonState(home);
  if (reading.kind !== 'ok') return false;
  const state = reading.state;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null || state.uid !== uid) return false;
  const alive = options.alive ?? ((pid: number) => pid === state.pid && daemonStateAlive(state));
  if (!alive(state.pid)) return false;
  const at = state.mailbox?.heartbeatAt;
  if (typeof at !== 'string' || at === '') return false;
  const beat = Date.parse(at);
  if (!Number.isFinite(beat)) return false;
  const now = options.now ?? Date.now();
  const age = now - beat;
  return age >= 0 && age <= mailboxFreshWindowMs(state.heartbeatSeconds);
}
