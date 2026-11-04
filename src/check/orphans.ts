// Live agent processes with no pane: the orphan reading.
//
// A seat's CLI is launched inside a pane, and the launch records the pane's shell and the
// foreground pids that are not the shell (`SeatState.launched`). When the pane goes away and the
// CLI does not, the process keeps running with nothing holding it — no prompt, no reader, no stop
// the team knows about — and it can outlive the seat it was launched for. This reading names every
// such process it can prove belongs to this team, with its pid, CLI, age and the team record it
// answers to, and offers the team's own close (`team check --close-orphans`). The close lives at
// the end of this file: it asks once, re-proves every candidate immediately before signalling it,
// and leaves — never guesses at — anything whose proof no longer holds.
//
// It never guesses. A pane list that could not be read, or that reads no agents while the state
// records seats, names nothing and closes nothing: a failed read must never make a live seat's
// CLI look orphaned. Where the pane list cannot answer for one pane, the launch's recorded shell
// decides:
// a CLI still in its pane is a descendant of that shell, so a chain without it proves the CLI
// left. A process found by its working folder must sit inside this team's root, and one that
// started before the daemon's own start is named but not closed unless a state record names it —
// when in doubt, name it and do not close.
//
// Every fact about processes comes from the sources handed in (the process adapter in a real
// run); this file names no system of its own.

import { basename, resolve, sep } from 'node:path';
import { PROFILES, processNameMatches } from '../clis.ts';
import type { Difference, Live } from '../status/compare.ts';
import type { SessionState } from '../state.ts';
import { formatRelativeTime, pluralCount } from '../output/text.ts';
import { plainLine } from '../launch/plain.ts';

/** One row of the process table, as the reading needs it: the pid, the name the system holds for
 *  the process, and the instant it started. */
export type OrphanProcessEntry = { pid: number; comm: string; startedAtMs: number };

/** What the orphan reading reads from the machine. All of it is handed in: a real run wires the
 *  process adapter, a scene its own answers, and no read here names a system. */
export type OrphanProcessSources = {
  /** Every process this user runs, or null when the table cannot be read. */
  table(): OrphanProcessEntry[] | null;
  /** The working folders of many pids at once, or null when the read could not start. A pid the
   *  read could not answer stays null in the map. */
  foldersOf(pids: readonly number[]): Map<number, string | null> | null;
  /** One process's own pid and its ancestors, or null when the chain could not be read. The
   *  launch's recorded shell is an ancestor of the CLI it started; a chain without it is the
   *  proof a CLI left its pane even when the pane list could not answer for that pane. */
  ancestorsOf(pid: number): readonly number[] | null;
  /** The pids of this run and its own ancestry: the check never names, and never closes, itself. */
  own(): readonly number[];
};

/** One live CLI no pane holds. `seat` is the state record that names it; null for a process found
 *  by its working folder that no record claims. `closeable` is the proof the close flow needs: a
 *  state record names the pid, or the process started at or after the daemon's own start. */
export type OrphanCandidate = {
  pid: number;
  comm: string;
  startedAtMs: number;
  cli: string;
  seat: string | null;
  recorded: boolean;
  closeable: boolean;
  /** The pane shell the launch recorded for a seat's CLI; null for a process found by its folder.
   *  The close flow re-reads the chain: a shell still above the pid means the CLI never left. */
  shell: number | null;
};

/** The reading's answer: the rows the check prints, the notes that explain a read that could not
 *  complete, the candidates the close flow acts on, and whether a read that did not answer kept
 *  something unnamed. */
export type OrphanReading = {
  differences: Difference[];
  notes: string[];
  candidates: OrphanCandidate[];
  unread: boolean;
};

export type OrphanInput = {
  project: string;
  root: string;
  session: string;
  state: SessionState;
  live: Live;
  now: Date;
  /** The daemon's start instant, ISO 8601, when the caller read it; null when it is not known.
   *  A process the state does not name is closeable only when it started at or after this. */
  daemonSince: string | null;
  sources: OrphanProcessSources;
};

/** The CLI profile a process name belongs to, or null when the name is no known CLI. The name is
 *  the one the system holds: a full path, a bare name, or a display name with spaces; only its
 *  last segment is matched, against the profile's own process names (a version suffix may be cut,
 *  which the profiles spell with a trailing `*`). */
function cliOf(comm: string): string | null {
  const name = basename(comm);
  for (const profile of PROFILES) {
    if (processNameMatches(name, profile.processes)) return profile.cli;
  }
  return null;
}

/** Whether a folder is the root or sits inside it. */
function insideRoot(folder: string, root: string): boolean {
  const at = resolve(folder);
  const base = resolve(root);
  return at === base || at.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * The reading. It returns rows for every live CLI it can prove has no pane; the notes explain a
 * read that could not complete, and `unread` says one did.
 */
export function orphanReading(input: OrphanInput): OrphanReading {
  const { state, live, now, sources } = input;
  const recordedSeats = Object.keys(state.seats).length;
  const empty: OrphanReading = { differences: [], notes: [], candidates: [], unread: false };

  // Nothing was ever launched and no agent is listed: no pane exists to lose, so there is nothing
  // to read — and the process table is not asked at all.
  if (recordedSeats === 0 && live.agents.length === 0) return empty;

  // The pane list is the proof every row rests on. A session that is not running, or one that
  // reads no agents while the state records seats, proves nothing about who holds what: naming a
  // process then could make a live seat's CLI look orphaned, so nothing is named and nothing may
  // be closed from this reading.
  if (!live.running) {
    if (recordedSeats === 0) return empty;
    return {
      ...empty,
      unread: true,
      notes: [`session "${input.session}" is not running; no processes are compared`],
    };
  }
  if (live.agents.length === 0 && recordedSeats > 0) {
    return {
      ...empty,
      unread: true,
      notes: [
        `the session's pane list reads no agents while the state records ${pluralCount(recordedSeats, 'seat')}; no orphan processes are named`,
      ],
    };
  }

  const table = sources.table();
  if (table === null) {
    return { ...empty, unread: true, notes: ['the process list could not be read; no orphan processes are named'] };
  }

  // What the panes hold: every pane process reading the live session answered, each a shell and
  // the foreground pids that are not it. A pane the session lists but could not read is counted
  // too: its pids are unknown, so a process found by its folder could be sitting there.
  const held = new Set<number>();
  const unreadPanes = new Set<string>();
  for (const [pane, processes] of Object.entries(live.processes ?? {})) {
    if (processes === null) {
      unreadPanes.add(pane);
      continue;
    }
    held.add(processes.shell);
    for (const pid of processes.foreground) held.add(pid);
  }
  for (const agent of live.agents) {
    if (live.processes?.[agent.pane] === undefined) unreadPanes.add(agent.pane);
  }
  const own = new Set(sources.own());
  const byPid = new Map(table.map((one) => [one.pid, one]));

  // The pids a state record names as a seat's CLI. A stale record names its process the same way:
  // the file not declaring the seat does not stop the process from running.
  const recorded = new Map<number, { seat: string }>();
  for (const [seat, entry] of Object.entries(state.seats)) {
    for (const pid of entry.launched?.cli ?? []) {
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!recorded.has(pid)) recorded.set(pid, { seat });
    }
  }

  const candidates: OrphanCandidate[] = [];
  for (const [pid, { seat }] of recorded) {
    if (held.has(pid) || own.has(pid)) continue;
    const row = byPid.get(pid);
    // Gone: the process the record names is no longer running, so there is nothing to name. A pid
    // the system now runs as something else is not the seat's CLI and is never closed for it.
    if (row === undefined) continue;
    const cli = cliOf(row.comm);
    if (cli === null) continue;
    // The pane the record names could not be read. Herdr alone cannot say whether this pid still
    // sits there, so the launch's own shell decides: a CLI that never left its pane is a
    // descendant of that shell, and one whose chain no longer holds it is no pane's to keep. When
    // the chain cannot be read either, the process stays unnamed — a failed read must never make a
    // live seat's CLI look orphaned.
    const heldLaunch = state.seats[seat]?.launched;
    const pane = state.seats[seat]?.pane;
    if (pane === undefined || live.processes?.[pane] == null) {
      const shell = heldLaunch?.shell;
      if (shell === undefined) continue;
      const chain = sources.ancestorsOf(pid);
      if (chain === null) continue;
      if (chain.includes(shell)) continue;
    }
    const candidate: OrphanCandidate = {
      pid,
      comm: row.comm,
      startedAtMs: row.startedAtMs,
      cli,
      seat,
      recorded: true,
      // A state record is the proof: it names this pid as the seat's CLI, so the close may end it
      // whatever its start instant.
      closeable: true,
      shell: heldLaunch?.shell ?? null,
    };
    candidates.push(candidate);
  }

  // Processes no record names: found by the working folder they run in. One folder read answers
  // them all, and only the CLI-shaped rows that no pane and no record accounts for are asked
  // about — when that set is empty, the read does not run. An unread pane blocks this discovery
  // outright: the process could be sitting in the pane the session could not answer for.
  let folderUnread = false;
  if (unreadPanes.size === 0) {
    const suspects = table.filter(
      (row) =>
        !recorded.has(row.pid) && !held.has(row.pid) && !own.has(row.pid) && cliOf(row.comm) !== null,
    );
    if (suspects.length > 0) {
      const folders = sources.foldersOf(suspects.map((one) => one.pid));
      if (folders === null) {
        folderUnread = true;
      } else {
        const daemonAt = input.daemonSince === null ? Number.NaN : Date.parse(input.daemonSince);
        const knownDaemon = Number.isFinite(daemonAt);
        for (const row of suspects) {
          const folder = folders.get(row.pid);
          if (folder === null || folder === undefined) continue;
          if (!insideRoot(folder, input.root)) continue;
          candidates.push({
            pid: row.pid,
            comm: row.comm,
            startedAtMs: row.startedAtMs,
            cli: cliOf(row.comm) as string,
            seat: null,
            recorded: false,
            // The daemon's start is the floor for a close no record backs: a process that was
            // already running before it may belong to something the record does not know.
            closeable: knownDaemon && row.startedAtMs >= daemonAt,
            shell: null,
          });
        }
      }
    }
  }

  const notes: string[] = [];
  if (unreadPanes.size > 0) {
    notes.push(
      `the session could not say what runs in ${pluralCount(unreadPanes.size, 'pane')}; processes found by their folder are not named`,
    );
  }
  if (folderUnread) {
    notes.push('the folder read did not answer; processes the state does not record are not named');
  }
  if (input.daemonSince === null && candidates.some((one) => !one.recorded)) {
    notes.push("the daemon's start is not known; processes the state does not name are not closed");
  }
  const unread = unreadPanes.size > 0 || folderUnread;

  const differences = candidates.map((candidate): Difference => {
    const age = formatRelativeTime(new Date(candidate.startedAtMs).toISOString(), now);
    const from =
      candidate.seat === null
        ? `last team ${input.project}, no seat record`
        : `last team ${input.project}, seat ${candidate.seat}`;
    return {
      what: `pid ${candidate.pid}: a live ${candidate.cli} process with no pane in session "${input.session}" (started ${age}; ${from})`,
      repair: candidate.closeable
        ? 'close it through the team (team check --close-orphans)'
        : "inspect it, then stop it by hand if it is not a seat's",
      who: candidate.closeable ? "the team's lead" : 'the owner',
    };
  });

  return { differences, notes, candidates, unread };
}

/** What the close flow reads and does on the machine. Handed in like the reading's sources: the
 *  real run wires the process adapter and signals, a scene its own answers. */
export type OrphanCloseSources = {
  alive(pid: number): boolean;
  /** The name the system holds for the pid now, or null when it is gone. */
  commOf(pid: number): string | null;
  /** The pid's start instant, or null when it is gone or the table cannot be read. */
  startOf(pid: number): number | null;
  /** One process's own pid and its ancestors, or null when the chain cannot be read. */
  ancestorsOf(pid: number): readonly number[] | null;
  /** The pids another running session's panes hold, read once for every closeable candidate; null
   *  when a pane list or a pane reading did not answer. A seat's CLI moved into another session is
   *  alive there, and no record of this session's launches proves otherwise. */
  heldElsewhere(pids: readonly number[], session: string): ReadonlySet<number> | null;
  /** Sends the stop; false when the system refused it (the process is gone or not ours). */
  signal(pid: number, signal: 'terminate' | 'kill'): boolean;
  pause(ms: number): void;
};

export type OrphanCloseInput = {
  candidates: readonly OrphanCandidate[];
  session: string;
  sources: OrphanCloseSources;
  /** Asks the one question. False means the person declined; nothing is signalled. */
  confirm(prompt: string): boolean;
};

/** What the close flow did: one line per close, force or leave, in the order it tried. */
export type OrphanCloseResult = { lines: string[]; closed: number };

const CLOSE_WAIT_MS = 2000;
const KILL_WAIT_MS = 1000;
const STEP_MS = 100;
/** How far the start instant may move between the reading and the close and still be the same
 *  process. The table's own clock seconds are the floor; a pid reused inside the wait is the only
 *  way past it, and a reused pid's start is later still. */
const SAME_START_MS = 2000;

/** Waits for the pid to go, up to `ms`, asking every step. */
function waitGone(pid: number, sources: OrphanCloseSources, ms: number): boolean {
  for (let waited = 0; waited < ms; waited += STEP_MS) {
    if (!sources.alive(pid)) return true;
    sources.pause(STEP_MS);
  }
  return !sources.alive(pid);
}

/**
 * Closes the orphan candidates that carry the close's proof, after one confirm. Every candidate is
 * re-proven just before it is signalled — still the same pid, still the same CLI, still the same
 * start, and still no pane holding it — so a pid reused or a pane reattached since the reading is
 * left alone. A process that does not answer the first stop is forced, and one that will not stop
 * is left and named.
 */
export function closeOrphans(input: OrphanCloseInput): OrphanCloseResult {
  const closeable = input.candidates.filter((one) => one.closeable);
  if (closeable.length === 0) return { lines: [], closed: 0 };
  const count = pluralCount(closeable.length, 'orphan process', 'orphan processes');
  if (!input.confirm(`team check: close ${count}? [y/N] `)) {
    return { lines: [`left: ${count}: you answered no`], closed: 0 };
  }

  // One pane pass answers every candidate, before the first signal: a close run must not ask the
  // machine once per process. A CLI moved into another session's pane is alive there, and the
  // launch record that names it here says nothing about that pane.
  const elsewhere = input.sources.heldElsewhere(
    closeable.map((one) => one.pid),
    input.session,
  );

  const lines: string[] = [];
  let closed = 0;
  const leave = (candidate: OrphanCandidate, why: string): void => {
    lines.push(`left: pid ${candidate.pid}: ${why}`);
  };

  for (const candidate of closeable) {
    const label = candidate.seat === null ? 'no seat record' : `seat ${candidate.seat}`;
    if (!input.sources.alive(candidate.pid)) {
      leave(candidate, 'it was gone before it could be closed');
      continue;
    }
    const comm = input.sources.commOf(candidate.pid);
    if (comm === null) {
      leave(candidate, 'it was gone before it could be closed');
      continue;
    }
    if (cliOf(comm) !== candidate.cli) {
      leave(candidate, `the pid now runs ${plainLine(comm)}`);
      continue;
    }
    const start = input.sources.startOf(candidate.pid);
    if (start === null || Math.abs(start - candidate.startedAtMs) > SAME_START_MS) {
      leave(candidate, 'it is not the process the check saw');
      continue;
    }
    // The same proof the reading needed, read again: no other session's pane holds it, and a
    // recorded CLI's launch shell is no longer above it. A read that does not answer leaves the
    // process alone.
    if (elsewhere === null) {
      leave(candidate, 'other panes could not be read');
      continue;
    }
    if (elsewhere.has(candidate.pid)) {
      leave(candidate, "another session's pane holds it");
      continue;
    }
    if (candidate.shell !== null) {
      const chain = input.sources.ancestorsOf(candidate.pid);
      if (chain === null) {
        leave(candidate, 'its process chain could not be read');
        continue;
      }
      if (chain.includes(candidate.shell)) {
        leave(candidate, 'it is still inside its pane');
        continue;
      }
    }
    if (!input.sources.signal(candidate.pid, 'terminate')) {
      leave(candidate, 'the system refused the stop');
      continue;
    }
    if (waitGone(candidate.pid, input.sources, CLOSE_WAIT_MS)) {
      lines.push(`closed: pid ${candidate.pid}: ${candidate.cli} (${label})`);
      closed += 1;
      continue;
    }
    input.sources.signal(candidate.pid, 'kill');
    if (waitGone(candidate.pid, input.sources, KILL_WAIT_MS)) {
      lines.push(`forced: pid ${candidate.pid}: ${candidate.cli} (${label})`);
      closed += 1;
      continue;
    }
    leave(candidate, 'it did not stop');
  }
  return { lines, closed };
}
