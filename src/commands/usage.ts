import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { loadTeamFile, TEAM_FILE } from '../file/load.ts';
import type { LoadResult, Problem } from '../file/types.ts';
import {
  machineUsage,
  reportOf,
  reportText,
  StoreUnreadable,
  viewFor,
  type MachineUsage,
  type UsageView,
} from '../information/usage.ts';
import { realQuotaObservations, type QuotaLive } from '../information/quota-observe.ts';
import type { Command, Io } from '../io.ts';
import { writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team usage [--json] [--all]

Exits 0 when the report is printed, 2 when the invocation or store folder can't be read.
`;

/** The sentence a run outside any project contributes as its note: it names no git and no flag
 *  this command does not have, and it is a note with exit 0, not a refusal. */
export const NO_PROJECT = 'no team file is found from this folder; there is no project block to show';

/** What the command reads from outside itself: the home whose store it consults, the clock, and
 *  the live quota observer — absent from a test's own sources, which then read no pane and run
 *  no CLI, so every existing figure stays the file's own. */
export type UsageSources = {
  /** The home whose approval store is read. Required, so no test can reach the owner's own. */
  home: string;
  now(): Date;
  observe?(machine: MachineUsage, view: UsageView, now: number): QuotaLive;
};

export const realSources: UsageSources = {
  home: homedir(),
  now: () => new Date(),
  observe: (machine, view, now) => realQuotaObservations(machine, view, now),
};

export const usage: Command = (argv, io) => runUsage(argv, io, realSources);
export default usage;

/**
 * `team usage [--json]`: the machine's report — every store this machine holds read as one team
 * each, the caller's own project among them — resolved and printed under the caller's view, the
 * way the design note rules (§ 2.1-§ 2.3). Read-only: it writes nothing anywhere, not even the
 * `last_valid` copy `currentTeam` keeps, and it never answers from that copy when the file
 * breaks. The live quota sources it may read — a seat's own status row through herdr and a CLI's
 * own usage command — are read, never written; no credential, key or CLI session file is opened.
 * Any caller may run it, from any folder, and a run outside every project is no refusal:
 * `mine` is null and the whole report reads restricted. The caller is placed once (`viewFor`,
 * `caller.ts`): the owner at a terminal reads the full view — every team named, every root
 * carried, every team's own rows — and everyone else, the restricted view, whose shape is the one
 * closed allow-list `reportOf` builds before either renderer: no other team's name or root, no
 * per-team row but the caller's own, no path a state read produced, another team's problem as a
 * fixed counted sentence (`ANON`). The command itself resolves nothing twice: `mine` is the one
 * resolution, the loader's own message is a note for the owner and a fixed sentence for anyone
 * else (`noticeOf`, `errorNote`), and the only refusal beside the invocation is the stores folder
 * itself unreadable (`usage.store`, § 2.4). Exit 0 whatever the figures.
 */
export async function runUsage(argv: string[], io: Io, sources: UsageSources): Promise<number> {
  const args = readArgs(argv, [], ['json', 'all']);
  const json = args.flags.has('json');
  if (args.error || args.rest.length) {
    const problem = args.error ?? `unexpected "${args.rest[0]}"`;
    if (json) {
      // The structured face: the refusal row's own id, stderr empty, the exit unchanged.
      writeJsonError(io, 'usage.invocation', problem, null);
    } else {
      io.stderr(`team usage: ${problem}\n${USAGE}`);
    }
    // exit: usage.invocation
    return 2;
  }
  // `--all`: every team's seat breakdown under the full view; the report says in one note why a
  // caller the view does not widen still reads only their own team's.
  const allTeams = args.flags.has('all');
  const now = sources.now();
  // The caller's own project, resolved from the current folder the way every command resolves it;
  // a file that cannot be read, and a folder with no file at all, are carried as this caller's
  // own note rather than refused — the machine report prints either way (`mineNotesOf`).
  let loaded: LoadResult | null = null;
  let loadError: unknown = null;
  try {
    loaded = loadTeamFile(io.cwd, { home: sources.home });
  } catch (error) {
    loadError = error;
  }
  const mine = loaded !== null && loaded.ok ? loaded.root : null;
  // Placed once, from the process table alone, and read by nothing else: every line below — text
  // and `--json` alike — comes from the one report the filter builds under this view.
  const view = viewFor(io, mine);
  const restricted = !view.full;
  const mineNotes = mineNotesOf(loaded, loadError, restricted);
  let machine: MachineUsage;
  try {
    machine = machineUsage(sources.home, now.getTime(), view);
  } catch (error) {
    if (!(error instanceof StoreUnreadable)) throw error;
    // The stores folder itself could not be read: the one refusal beside the invocation (§ 2.4).
    // Its message carries the folder, which is this machine's own derivation, so only the owner
    // reads it; every other caller reads the fixed sentence with the reason left to the owner.
    const problem = restricted
      ? 'the store folder cannot be read: the owner reads the reason'
      : error.message;
    if (json) {
      writeJsonError(io, 'usage.store', problem, null);
    } else {
      io.stderr(`team usage: ${problem}\n`);
    }
    // exit: usage.store
    return 2;
  }
  const report = reportOf(machine, view, now.getTime(), mineNotes, allTeams, sources.observe === undefined ? null : sources.observe(machine, view, now.getTime()));
  if (json) {
    // The shared envelope: `schema: { name: 'team.usage', version: 1 }` first, then the report's
    // own keys unchanged — one document, registered under `schema/usage.schema.json`.
    writeJson(io, 'team.usage', report);
  } else {
    io.stdout(reportText(report));
  }
  // exit: usage.block
  return 0;
}

/** The notes the caller's own resolution contributes: the loader's own message for a file that
 *  cannot be read, one fixed sentence per distinct line for a file that exists and does not load
 *  (`noticeOf`), and the one outside sentence for a folder with no team file at all. All but the
 *  last are the reason a member of this machine cannot be read, so the caller's view decides the
 *  face they print in. */
function mineNotesOf(loaded: LoadResult | null, error: unknown, restricted: boolean): string[] {
  if (error !== null) return [errorNote(error, restricted)];
  if (loaded === null || loaded.ok) return [];
  const path = loaded.path;
  if (path === undefined || !existsSync(path)) return [NO_PROJECT];
  return notesOf(path, loaded.errors, restricted);
}

/** One note for a file that exists and does not load. The owner reads the loader's own message:
 *  the path, the line when it has one, and the problem — never the bare `no team file here` text,
 *  which is a different case's sentence. A caller who is not the owner reads a fixed sentence
 *  instead — this project's own path relative to the root, the line, and the owner as the
 *  reader of the reason — because the loader's bodies are the loader's own and can name paths
 *  outside this project (`trust: must list the lobby <home>/…` when a migrated file omits it).
 *  `team status` does not print those bodies for this caller: the caller rule answers with one
 *  sentence and no reason, so this note names the owner, the same way a file that cannot be read
 *  does. */
function noticeOf(path: string, problem: Problem, restricted: boolean): string {
  if (restricted) return `${TEAM_FILE} does not load${problem.line ? ` (line ${problem.line})` : ''}: the owner reads the reason`;
  return `${path}${problem.line ? ` line ${problem.line}` : ''}: ${problem.message}`;
}

/** The notes for a file that exists and does not load: one per problem for the owner, and one per
 *  distinct line for a caller who is not the owner — the fixed sentences carry nothing else, so
 *  three problems on one line are one note. */
function notesOf(path: string, errors: Problem[], restricted: boolean): string[] {
  const notes = errors.map((problem) => noticeOf(path, problem, restricted));
  return restricted ? [...new Set(notes)] : notes;
}

/** The note for a file that exists and cannot be read: the error's own message for the owner, one
 *  fixed sentence for a caller who is not the owner, whose body is the error's own (an errno
 *  error can name the path it failed on) and so does not pass through. The sentence names the
 *  owner as the reader of the reason: `team status` is no pointer here — a run showed it throws on
 *  this same fixture instead of printing anything. */
function errorNote(error: unknown, restricted: boolean): string {
  if (restricted) return `${TEAM_FILE} cannot be read: the owner reads the reason`;
  return error instanceof Error ? error.message : String(error);
}
