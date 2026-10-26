import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readState, updateState } from '../state.ts';
import { readTeamConfig } from './team-config.ts';
import type { Deprecation, Problem, TeamFile } from './types.ts';
import { validateTeamFile } from './validate.ts';

// The team as the commands that must keep working read it: `status`, `watch`, `down`. A valid
// file is remembered in the state; a broken one is replaced by the last copy that validated,
// with a notice to print first. Commands that launch or change anything use loadTeamFile and
// refuse instead. Remembering is the owner's alone: a read that is not the owner's (`status`
// aimed with `--file` at a project its caller has nothing to do with) must write nothing
// anywhere, so the command passes the walk's verdict as `remember` and everything else here —
// the load, the fallback, the notice — is a read either way.
export type Current =
  | {
      ok: true;
      team: TeamFile;
      root: string;
      dir: string;
      warnings: Problem[];
      /** Deprecated fields the file still reads; only `team check` prints them. */
      deprecations?: Deprecation[];
      notice?: string;
      path?: string;
      /** Where the configuration was read from (src/file/team-config.ts). */
      source?: 'registry' | 'team-file';
      /** A team file left beside a registry team, and whether it matches the record. */
      leftover?: { path: string; matches: boolean };
    }
  | { ok: false; errors: Problem[] };

export function currentTeam(
  cwd: string,
  file: string | undefined,
  now: Date,
  home?: string,
  remember = true,
  /** The session the command addresses, when it has one: the placement check reads that
   *  session's recorded lobby. Absent reads the file's own. */
  session?: string,
): Current {
  const loaded = readTeamConfig(cwd, {
    ...(file ? { file } : {}),
    ...(home ? { home } : {}),
    ...(session !== undefined ? { session } : {}),
  });
  if (loaded.ok) {
    const dir = dirname(loaded.path);
    if (remember) rememberLastValid(dir, loaded.path, now);
    return { ok: true, team: loaded.team, root: loaded.root, dir, warnings: loaded.warnings, deprecations: loaded.deprecations ?? [], path: loaded.path,
      ...(loaded.source !== undefined ? { source: loaded.source } : {}),
      ...(loaded.leftover !== undefined ? { leftover: loaded.leftover } : {}) };
  }
  if (!loaded.path || !existsSync(loaded.path)) return { ok: false, errors: loaded.errors };
  const dir = dirname(loaded.path);
  const saved = lastValid(dir);
  if (!saved) return { ok: false, errors: loaded.errors };
  const first = loaded.errors[0];
  return {
    ok: true,
    team: saved.team,
    root: dir.endsWith('.agents') ? dirname(dir) : dir,
    dir,
    warnings: [],
    notice: `team.yaml is invalid (${first && first.line ? `line ${first.line}: ` : ''}${first?.message ?? 'unreadable'}); using the copy of ${saved.readAt}`,
  };
}

/** The `last_valid` write `currentTeam` makes when `remember` is left on. A command that loaded
 *  with `remember` false calls this only after its caller gate has allowed the run. */
export function rememberCurrent(dir: string, path: string, now: Date): void {
  rememberLastValid(dir, path, now);
}

function rememberLastValid(dir: string, path: string, now: Date): void {
  const file = readFileSync(path, 'utf8');
  try {
    if (readState(dir).last_valid?.file === file) return;
    updateState(dir, (state) => {
      state.last_valid = { read_at: now.toISOString(), file };
    });
  } catch {
    // A state that can't be written must not stop a command that only reads.
  }
}

function lastValid(dir: string): { team: TeamFile; readAt: string } | null {
  try {
    const saved = readState(dir).last_valid;
    if (!saved) return null;
    const result = validateTeamFile(saved.file);
    return result.ok ? { team: result.team, readAt: saved.read_at } : null;
  } catch {
    return null;
  }
}
