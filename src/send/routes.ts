// The native channel's bookkeeping: one route record per address the CLI handed a sender, and
// the reading that says whether the address is worth handing over at all.
//
// A route is not a message: it moves no text and reaches nobody, so its record is not written
// into `messages.jsonl` — the feed's own promise is one line per completed send there, and its
// page pins the history union. Routes have their own stream beside it, `<storeDir>/routes.jsonl`,
// through the same store ladder, `lstat` guards, mode 0600 and 1 MB rotation `appendHistory`
// uses (one implementation, `appendStoreLine`). The record is written before the address is
// answered: a sender that was routed natively is accountable for it, so a record that cannot be
// written is a refusal, never a silent route.
//
// Everything here is a decision over what the caller hands in: the record is composed from the
// judgement the command already made, and the socket reading looks at file names and process
// lists — it never opens, dials or writes to another session's socket.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PaneProcesses } from '../herdr.ts';
import { storePath } from '../store/store.ts';
import { defaultSocketsDirs, socketOfProcesses, socketPid } from './address.ts';
import { appendStoreLine, type HistoryWrite } from './history.ts';

/** The file inside `<project state folder>/` that holds the route records. */
export const ROUTES_FILE = 'routes.jsonl';

/** The one channel the native half exists for. A recorded delivery names it in the history's
 *  `via`, so a reader meets the same word in both streams. */
export const NATIVE_CHANNEL = 'native';

/** What the history records as the body when the sender did not hand its text to the CLI: the
 *  text travelled in the sender's own tool call, and nothing here invents it. */
export const NATIVE_BODY_MARKER = '(native delivery; the text did not pass through the team CLI)';

/** Where the address stands: `live` (the recorded one is still the pane's), `stale` (recorded,
 *  but its process is gone or its path is), `pane` (none recorded, one found on the pane now),
 *  `none` (no address anywhere), `unread` (the pane could not be read, so nothing is claimed). */
export type SocketState = 'live' | 'stale' | 'pane' | 'none' | 'unread';

/** One address handed out: the socket path, or null, and which of the states above it is. */
export type RouteAddress = { socket: string | null; state: SocketState };

/** One route record: who was routed to whom, by which rule, to which address, when. */
export type RouteRecord = {
  /** ISO-8601, the run's own clock. */
  ts: string;
  /** The caller as the log names it — `logTag`'s bracket: `owner`, or the caller's own seat name. */
  from: string;
  /** The sender's agent id, or null for a declared seat the registry holds no record for. */
  from_id: string | null;
  /** The recipient's seat. */
  to: string;
  /** The recipient's agent id: a route always resolves a record, so it is always present. */
  to_id: string;
  /** The receiving team, by the id the registry keys it on. */
  team: string;
  /** The recipient's session. */
  session: string;
  /** The pane the recipient was resolved to. */
  pane: string;
  /** The address handed out, or null when there is none. */
  socket: string | null;
  socket_state: SocketState;
  /** Whether the recipient's own CLI carries the cross-session channel at all. */
  native: boolean;
  /** The admission rule that let the route through, verbatim. */
  rule: string;
};

/** `<home>/.config/team/<project>-<hash>/routes.jsonl`: inside the project's state folder,
 *  beside `messages.jsonl`, never in a lobby and never in the repository checkout. */
export function routesPath(project: string, root: string, home: string): string {
  return join(storePath(project, root, home), ROUTES_FILE);
}

/** Appends one route record to the project's own stream. The result is the caller's to judge:
 *  `team route` refuses when it is not `ok`, so the answer only ever follows a written record. */
export function appendRoute(project: string, root: string, home: string, record: RouteRecord): HistoryWrite {
  return appendStoreLine(project, root, home, ROUTES_FILE, { ...record });
}

/**
 * The address a route hands out, read from what the caller already has: the recipient's recorded
 * address (`reach.address`) and its pane's process list. The recorded address is `live` only
 * while its own pid still runs in the pane and its path is still there; a pane that cannot be
 * read leaves a recorded address named but unclaimed (`unread`), and a record with nothing
 * recorded falls back to the socket the pane's processes carry right now (`pane`). Nothing here
 * dials: the path is named, and the sender decides whether to use it.
 */
export function readRouteAddress(
  recorded: string | null | undefined,
  processes: PaneProcesses | null | undefined,
  sockets: string | readonly string[] = defaultSocketsDirs(),
): RouteAddress {
  if (recorded) {
    if (!processes) return { socket: recorded, state: 'unread' };
    const pid = socketPid(recorded);
    if (pid !== null && pidsOf(processes).includes(pid) && existsSync(recorded)) return { socket: recorded, state: 'live' };
    return { socket: recorded, state: 'stale' };
  }
  if (!processes) return { socket: null, state: 'unread' };
  const found = socketOfProcesses(processes, sockets);
  return found === null ? { socket: null, state: 'none' } : { socket: found, state: 'pane' };
}

// The pane's pids, foreground first, each once — `address.ts`'s own order.
function pidsOf(processes: PaneProcesses): number[] {
  return [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
}
