// A seat whose launch confined it in a sandbox that hides every process outside it (Grok's
// Seatbelt profile allows process-info only on the sandbox's own processes: `ps` is refused, and
// the parent walk stops at the CLI). Such a caller cannot be placed by its parent processes. It
// is placed by what its confinement lets it write instead, which the seat cannot choose: the
// launch wrote the grant before the CLI started.
//
// The proof, for the one seat a session's state records at the pane the environment names:
//   - the caller can create a file in that seat's own `seat-state/<session>/<seat>/` folder, and
//   - the caller cannot create one in `seat-state/<session>/`, nor in the team's `.agents` folder.
// No launch grants a seat the session's seat-state folder or `.agents` itself, so the second half
// refuses any process that is not confined (it could write both). A confined seat whose grant is
// another seat's folder fails the first half. The pane variable only says which record to test;
// the writes decide. Every probe file is created exclusively and removed at once.
//
// This guards against a mistaken agent, as every placement does: every seat runs as the owner's
// user. It is read only when the parent walk could not be read at all.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export type ConfinedSeat = { name: string; session: string; dir: string };

export type ConfinedSources = {
  /** Whether a new file can be created in `folder` (created exclusively, then removed). */
  canCreateIn(folder: string): boolean;
  /** The `.agents` folders that may hold this caller's team, nearest first. */
  agentDirs(cwd: string): string[];
  /** The seats a state file records, by session: name -> recorded pane. Null when unreadable. */
  recordedPanes(dir: string): Record<string, Record<string, string | undefined>> | null;
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
    const sessionFolder = join(dir, 'seat-state', sessionName);
    const own = join(sessionFolder, name);
    if (!existsSync(own)) return null;
    if (!sources.canCreateIn(own)) return null;
    if (sources.canCreateIn(sessionFolder) || sources.canCreateIn(dir)) return null;
    return { name, session: sessionName, dir };
  }
  return null;
}

function canCreateIn(folder: string): boolean {
  const probe = join(folder, `.placement-probe-${String(process.pid)}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  } catch {
    return false;
  }
  try {
    unlinkSync(probe);
  } catch {
    // The probe stays; it is empty, and its name says what wrote it.
  }
  return true;
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
      timeout: 5_000,
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

export const realConfinedSources: ConfinedSources = { canCreateIn, agentDirs, recordedPanes };
