// The install step that retires the shuttle units. It runs only after the router child's
// heartbeat is fresh. A unit the seam cannot remove is named, and the child stays up. Nothing
// here starts a shuttle again, and nothing here talks to a service manager: the caller
// supplies the one call that stops and removes a unit.
import { readDaemonState } from '../state.ts';

/** The units this step retires. The desk unit is removed with the other two and nothing
 *  replaces it. */
export const SHUTTLE_UNITS = [
  'io.teamcli.iris-shuttle',
  'io.teamcli.atlas-shuttle',
  'io.teamcli.desk-shuttle',
] as const;

export type ShuttleRetirement = {
  /** The child is left up whether or not every unit came out. */
  child: 'up';
  retired: string[];
  failed: { label: string; why: string }[];
};

/**
 * Retires the shuttle units once the router has shown one fresh heartbeat. Before that,
 * nothing is removed. A failed removal is reported and the remaining units are still asked;
 * the child is not stopped and the shuttles are not started again.
 */
export function retireShuttles(input: {
  heartbeatFresh: boolean;
  retire(label: string): { ok: true } | { ok: false; why: string };
}): ShuttleRetirement {
  if (!input.heartbeatFresh) {
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

/** Whether the daemon's record shows a router heartbeat. A missing record, or a router that
 *  has not answered yet, is not fresh, and the shuttle units stay. */
export function mailboxHeartbeatFresh(home: string): boolean {
  const reading = readDaemonState(home);
  if (reading.kind !== 'ok') return false;
  const at = reading.state.mailbox?.heartbeatAt;
  return typeof at === 'string' && at !== '';
}
