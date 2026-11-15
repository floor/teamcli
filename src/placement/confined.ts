// A seat whose launch confined it in a sandbox that hides every process outside it (Grok's
// Seatbelt profile allows process-info only on the sandbox's own processes: `ps` is refused, and
// the parent walk stops at the CLI). Such a caller cannot be placed by its parent processes. It
// is placed by what its confinement lets it write instead, which the seat cannot choose: the
// launch wrote the grant before the CLI started.
//
// The proof, for the one seat a session's state records at the pane the environment names:
//   - the caller can create a file in that seat's own seat-state folder (the path the launch
//     grants, `cliHookStatePath`'s folder, with the session's folder name encoded the same way);
//   - the caller is refused, by the sandbox, a file in the session's seat-state folder and in the
//     team's `.agents` folder. A sandbox refusal is EPERM; the folder's own mode must allow its
//     owner to write and the folder must be this user's, so a read-only folder (EACCES) proves
//     nothing;
//   - none of the three folders is reached through a link: each one's real path is its own path
//     read from the real `.agents`, so a link cannot lend another seat's grant.
// No launch grants a seat the session's seat-state folder or `.agents` itself, so the second half
// refuses any process that is not confined. A confined seat whose grant is another seat's folder
// fails the first half. The pane variable only says which record to test; the writes decide.
// Every probe file is created exclusively and removed at once; a probe that cannot be removed
// proves nothing and is named on stderr.
//
// This guards against a mistaken agent, as every placement does: every seat runs as the owner's
// user. It is read only when the parent walk could not be read at all.
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { cliHookStatePath } from '../launch/cli-hook.ts';

export type ConfinedSeat = { name: string; session: string; dir: string };

/** What one probe saw: a file was created (and removed), the sandbox refused it (EPERM on a folder
 *  this user owns and may write), or anything else, which proves nothing either way. */
export type Probe = 'created' | 'sandbox-refused' | 'unproved';

export type ConfinedSources = {
  probe(folder: string): Probe;
  /** The `.agents` folders that may hold this caller's team, nearest first. */
  agentDirs(cwd: string): string[];
  /** The seats a state file records, by session: name -> recorded pane. Null when unreadable. */
  recordedPanes(dir: string): Record<string, Record<string, string | undefined>> | null;
  /** The folder's real path, or null when it cannot be read or is not a directory reached
   *  without a link at its last step. */
  realFolder(folder: string): string | null;
};

/** The confined seat at `pane`, or null when no record holds that pane or the proof fails. */
export function confinedSeatAt(
  cwd: string,
  pane: string,
  session: string | undefined,
  sources: ConfinedSources = realConfinedSources,
): ConfinedSeat | null {
  if (pane === '') return null;
  for (const dir of sources.agentDirs(cwd)) {
    const sessions = sources.recordedPanes(dir);
    if (sessions === null) continue;
    const found: { name: string; session: string }[] = [];
    for (const [sessionName, seats] of Object.entries(sessions)) {
      if (session !== undefined && sessionName !== session) continue;
      for (const [name, recorded] of Object.entries(seats)) {
        if (recorded === pane) found.push({ name, session: sessionName });
      }
    }
    // An ambiguous pane proves nothing; a folder that records none is not this caller's.
    if (found.length !== 1) continue;
    const { name, session: sessionName } = found[0]!;
    // The launch's own path: an unusable session or seat name names no grant.
    const statePath = cliHookStatePath(dir, sessionName, name);
    if (statePath === null) return null;
    const own = dirname(statePath);
    const sessionFolder = dirname(own);
    // Each folder must be itself on disk: its real path is the real `.agents` plus the same
    // names. A link anywhere below `.agents` would let one seat's grant answer for another.
    const realDir = sources.realFolder(dir);
    if (realDir === null) return null;
    const tail = own.slice(dir.length);
    if (sources.realFolder(own) !== realDir + tail) return null;
    if (sources.realFolder(sessionFolder) !== realDir + sessionFolder.slice(dir.length)) return null;
    if (sources.probe(own) !== 'created') return null;
    if (sources.probe(sessionFolder) !== 'sandbox-refused') return null;
    if (sources.probe(dir) !== 'sandbox-refused') return null;
    return { name, session: sessionName, dir };
  }
  return null;
}

function probe(folder: string): Probe {
  const path = join(folder, `.placement-probe-${String(process.pid)}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return 'unproved';
    // EPERM on a folder whose own mode lets its owner write, owned by this user: the sandbox's.
    try {
      const stat = statSync(folder);
      const mine = typeof process.getuid !== 'function' || stat.uid === process.getuid();
      return stat.isDirectory() && mine && (stat.mode & 0o200) !== 0 ? 'sandbox-refused' : 'unproved';
    } catch {
      return 'unproved';
    }
  }
  try {
    unlinkSync(path);
  } catch {
    console.error(`team caller: a placement probe could not be removed: ${path}`);
    return 'unproved';
  }
  return 'created';
}

function realFolder(folder: string): string | null {
  try {
    if (!lstatSync(folder).isDirectory()) return null;
    return realpathSync(folder);
  } catch {
    return null;
  }
}

function agentDirs(cwd: string): string[] {
  const out: string[] = [];
  const add = (dir: string) => {
    if (!out.includes(dir) && existsSync(join(dir, 'team.state.json'))) out.push(dir);
  };
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    if (common !== '') add(join(dirname(common), '.agents'));
  } catch {
    // Not a repository, or git is not reachable: the folder walk below still reads.
  }
  let at = resolve(cwd);
  for (;;) {
    add(join(at, '.agents'));
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return out;
}

function recordedPanes(dir: string): Record<string, Record<string, string | undefined>> | null {
  try {
    const state = JSON.parse(readFileSync(join(dir, 'team.state.json'), 'utf8')) as {
      sessions?: Record<string, { seats?: Record<string, { pane?: unknown }> }>;
    };
    const out: Record<string, Record<string, string | undefined>> = Object.create(null);
    for (const [session, value] of Object.entries(state.sessions ?? {})) {
      const seats: Record<string, string | undefined> = Object.create(null);
      for (const [name, seat] of Object.entries(value?.seats ?? {})) {
        seats[name] = typeof seat?.pane === 'string' ? seat.pane : undefined;
      }
      out[session] = seats;
    }
    return out;
  } catch {
    return null;
  }
}

export const realConfinedSources: ConfinedSources = { probe, agentDirs, recordedPanes, realFolder };
