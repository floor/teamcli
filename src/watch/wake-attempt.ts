// What wake a waiting message has had, read from every trace a wake leaves: the `.wake` marker
// beside the drop, the watch retry's `.wake-try` ledger (a failed retry gives its marker back
// and counts here instead), and the send's own history lines (a send-side typed wake that was
// refused writes no marker). Three states stay apart: no attempt at all; an attempt refused
// before any key reached the pane; and a wake actually submitted — a line typed, an adapter
// posted — that the seat has still not taken.
import { readFileSync } from 'node:fs';
import type { HistoryEntry } from '../send/history.ts';
import { wakeMarkAt, wakePath } from '../send/wake-marker.ts';
import { wakeTryPath } from './unread.ts';

export type WakeAttempt = 'none' | 'refused' | 'submitted';

/** The ledger's word on keys: null when there is no readable ledger. */
function ledgerTyped(dropDir: string, id: string): boolean | null {
  try {
    const parsed = JSON.parse(readFileSync(wakeTryPath(dropDir, id), 'utf8')) as { tries?: unknown; typed?: unknown };
    if (typeof parsed.tries !== 'number' || !Number.isInteger(parsed.tries) || parsed.tries < 1) return null;
    return parsed.typed === true;
  } catch {
    return null;
  }
}

/** What the history lines about one message say of its wake. A typed or webhook leg that
 *  delivered, or a send that ended "wake not taken" (its keys went in), is a submitted wake. A
 *  typed leg that failed without either is an attempt refused before any key. */
function historyAttempt(lines: readonly HistoryEntry[]): WakeAttempt {
  let found: WakeAttempt = 'none';
  for (const line of lines) {
    const outcome = line.outcome ?? '';
    if ((line.via === 'typed' || line.via === 'webhook') && outcome.startsWith('delivered')) return 'submitted';
    if (outcome.includes('wake not taken')) return 'submitted';
    if ((line.failed ?? []).some((one) => one.startsWith('typed: ') || one.startsWith('webhook: '))) found = 'refused';
  }
  return found;
}

/** The message's wake so far. `history` gives every history line for this id, in store order; it
 *  is asked only when the marker and the ledger do not already settle it. */
export function wakeAttemptOf(
  dropDir: string, id: string, history: () => readonly HistoryEntry[] = () => [],
): WakeAttempt {
  const mark = wakeMarkAt(wakePath(dropDir, id));
  if (mark !== null) return mark.state === 'blocked' ? 'refused' : 'submitted';
  const typed = ledgerTyped(dropDir, id);
  if (typed === true) return 'submitted';
  const fromHistory = historyAttempt(history());
  if (fromHistory === 'submitted') return 'submitted';
  if (typed === false || fromHistory === 'refused') return 'refused';
  return 'none';
}
