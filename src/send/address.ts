// A Claude Code seat's cross-session address: the socket its session listens on.
//
// The listener is `<sockets dir>/<pid>.sock`, named by the session process — the same shape
// `uds.ts` frames into and `send.ts` discovers live. More than one folder can carry it: the
// runtime temp folder's own and `/tmp/cc-socks`, where this Mac's sessions were seen to write
// while `tmpdir()` answered the per-user `/var/folders/…` path — so discovery walks both, in
// that order. The registry keeps the socket a seat was launched with, so a later send can
// address it without re-reading herdr; the pid in the path's own name is what tells a recorded
// address from a stale one, since a relaunch replaces the process and a new pid brings a new
// socket. Everything here is a reading: nothing throws, and a pane that cannot be read answers
// null rather than guessing.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paneProcesses, type PaneProcesses } from '../herdr.ts';
import { getAgent, recordAgentAddress } from '../registry/agents.ts';

/** The folder a session's socket lives in; the real one is the runtime temp folder's. */
export function defaultSocketsDir(): string {
  return join(tmpdir(), 'cc-socks');
}

/** Where else a session's sockets have been found: this Mac's Claude Code wrote them at
 *  `/tmp/cc-socks` while `tmpdir()` answered the per-user runtime folder. */
export function defaultSocketsDirAlt(): string {
  return '/tmp/cc-socks';
}

/** The folders discovery walks, in order: the temp folder's own and the fallback above — one
 *  entry when they are the same folder (`tmpdir()` is `/tmp` itself where no TMPDIR is set).
 *  One helper, so every reader and writer of an address walks the rule `send` discovered with. */
export function defaultSocketsDirs(): string[] {
  const first = defaultSocketsDir();
  const alt = defaultSocketsDirAlt();
  return first === alt ? [first] : [first, alt];
}

// The folders a caller gave: its one folder, or its list.
function dirsOf(sockets: string | readonly string[]): string[] {
  return typeof sockets === 'string' ? [sockets] : [...sockets];
}

/** The pid a socket path is named by, or null when it is not a `<something>/<pid>.sock` path. */
export function socketPid(socketPath: string | null | undefined): number | null {
  if (!socketPath) return null;
  const match = /\/(\d+)\.sock$/.exec(socketPath);
  return match ? Number(match[1]) : null;
}

// The pane's pids, foreground first, each once — the order the socket rule has always walked.
function pidsOf(processes: PaneProcesses): number[] {
  return [...processes.foreground, processes.shell].filter((pid, index, all) => all.indexOf(pid) === index);
}

/** The socket a pane's own processes carry: the first pid with a socket at its path, foreground
 *  pids first, each pid looked for in every folder given. The rule is the one `send` discovered
 *  with, kept in one place so every reader and writer of an address agrees. */
export function socketOfProcesses(
  processes: PaneProcesses | null | undefined,
  sockets: string | readonly string[] = defaultSocketsDirs(),
): string | null {
  if (!processes) return null;
  const dirs = dirsOf(sockets);
  for (const pid of pidsOf(processes)) {
    for (const dir of dirs) {
      const path = join(dir, `${String(pid)}.sock`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The address to use for a pane: the recorded one while its pid still runs in the pane and its
 *  socket is still there, else the pane's own socket as it stands (null when it has none). */
export function liveSocketOf(
  recorded: string | null | undefined,
  processes: PaneProcesses | null | undefined,
  sockets: string | readonly string[] = defaultSocketsDirs(),
): string | null {
  if (recorded && processes) {
    const pid = socketPid(recorded);
    if (pid !== null && pidsOf(processes).includes(pid) && existsSync(recorded)) return recorded;
  }
  return socketOfProcesses(processes, sockets);
}

/** The live socket of a pane, read through herdr; null when the pane does not answer or none of
 *  its processes carries a socket. */
export function paneSocket(pane: string, session?: string, sockets: string | readonly string[] = defaultSocketsDirs()): string | null {
  return socketOfProcesses(paneProcesses(pane, session), sockets);
}

/** The address to record for a launched claude-code seat, refreshed when the pid changed: reads
 *  the pane, writes the record when the socket it should hold is not the one it holds, and returns
 *  it. A pane that cannot be read is not a change — a recorded address is not cleared on a
 *  reading that never happened. Never throws; the note is for the command's log. */
export function refreshAgentAddress(
  home: string,
  id: string,
  pane: string | null,
  session?: string,
  sockets: string | readonly string[] = defaultSocketsDirs(),
): { address: string | null; note?: string } {
  try {
    const agent = getAgent(home, id);
    // The socket is a Claude Code feature: any other seat keeps whatever its record holds.
    if (!agent || agent.cli !== 'claude-code' || pane === null) return { address: agent?.reach.address ?? null };
    const processes = paneProcesses(pane, session);
    if (processes === null) return { address: agent.reach.address };
    const next = liveSocketOf(agent.reach.address, processes, sockets);
    if (next !== agent.reach.address) recordAgentAddress(home, id, next);
    return { address: next };
  } catch (error) {
    return { address: null, note: `registry not written: ${error instanceof Error ? error.message : String(error)}` };
  }
}
