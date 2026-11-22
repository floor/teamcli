// Whether a seat may control the computer: computer use, the user's browser, desktop apps, and
// the connectors that act under the user's accounts. On unless a word says otherwise: a team, or
// one seat, sets it false for a seat that must not touch the user's apps.
//
// One order, nearest first, the one `team settings` prints (`composeSeatConfig`): a signed seat
// record, the seat's own entry in the team file, a signed record at a wider level, the team
// file's own `desktop_control`, then on. A seat's `true` under a team's `false` is a word and
// wins; a chain that does not verify declares nothing, so the file's words decide.
import type { ConfigLevel } from '../config/registry.ts';

export type DesktopControlWords = {
  /** The seat's own entry in the team file, when it writes one. */
  seat?: boolean;
  /** The team file's own `desktop_control`, when it writes one. */
  team?: boolean | null;
  /** The nearest verified signed record and its level, when the chain holds one. */
  record?: { value: boolean; level: ConfigLevel };
};

/** The seat's effective `desktop_control`. */
export function resolveDesktopControl(words: DesktopControlWords): boolean {
  if (words.record?.level === 'seat') return words.record.value;
  if (words.seat !== undefined) return words.seat;
  if (words.record !== undefined) return words.record.value;
  if (words.team !== undefined && words.team !== null) return words.team;
  return true;
}
