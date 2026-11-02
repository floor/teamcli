// The writers' seam (phase 3 of the team-file migration): where a team's text is read from and
// written to when a command edits the team. Under `team-config.source: registry` the text of this
// checkout's team is the registry's record (src/registry/team-config-store.ts), and an edit
// replaces that record: the file is neither read nor written. Under `file`, and for a team file a
// caller names that is not this checkout's `.agents/team.yaml` (`--file`, tests, snapshots), the
// text is the file's, as before.
//
// Every write is validated first, exactly as `writeTeamFile` validates; an invalid edit is refused
// and nothing is written. A registry write recomputes the text's digest and the canonical record's
// digest (`team-record-c14n-v1`), keeps the import's provenance, and names the editing command.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { CANONICAL_RECORD_VERSION } from './canonical-record.ts';
import { TEAM_FILE } from './load.ts';
import { canonicalTeam, readTeamConfig, resolveTeamConfigSource, type ReadTeamConfigOptions } from './team-config.ts';
import type { LoadResult, Problem } from './types.ts';
import { validateTeamFile } from './validate.ts';
import { writeTeamFile } from './write.ts';
import { readStoredTeamConfig, sha256, TeamConfigStoreError, writeStoredTeamConfig, type StoredTeamConfig } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';

export type TeamTextOptions = {
  /** The home whose registry holds the record; the user's when absent. */
  home?: string;
  /** The source for this call; the setting's resolution when absent. */
  source?: string;
  env?: Record<string, string | undefined>;
  /** The editing command, recorded on a registry write. */
  command?: string;
  now?: () => Date;
  /** A new team (team init): the registry is the target even before it holds a record. */
  create?: boolean;
};

export type TeamTextTarget =
  | { kind: 'file'; path: string }
  | { kind: 'registry'; path: string; root: string; id: string; home: string };

export type TeamTextTargetRead = { ok: true; target: TeamTextTarget } | { ok: false; why: string };

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Where an edit of the team at `path` lands. The registry only for this checkout's own
 *  `.agents/team.yaml` path under the registry source, once the registry holds the team (or for a
 *  new one); any other path is a file. A record that cannot be read throws, never falls back. */
export function teamTextTarget(path: string, options: TeamTextOptions = {}): TeamTextTarget {
  const resolution = resolveTeamConfigSource({
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  if (!resolution.ok || resolution.source !== 'registry') return { kind: 'file', path };
  const [dir, name] = TEAM_FILE.split('/') as [string, string];
  if (basename(path) !== name || basename(dirname(path)) !== dir) return { kind: 'file', path };
  const root = real(dirname(dirname(path)));
  const home = options.home ?? homedir();
  const id = teamIdOf(root);
  // A team the registry does not hold was read from a file the caller named (`--file`, a launched
  // team file): the read refuses every other way in. Its edit stays on that file.
  if (!options.create && readStoredTeamConfig(home, id) === null) return { kind: 'file', path };
  return { kind: 'registry', path, root, id, home };
}

/** The same resolution, for callers that must refuse plainly: a record that cannot be read comes
 *  back as the sentence the plain read refuses with, never as an exception. The writers keep
 *  calling `teamTextTarget` itself, which still throws rather than fall back to the file. */
export function readTeamTextTarget(path: string, options: TeamTextOptions = {}): TeamTextTargetRead {
  try {
    return { ok: true, target: teamTextTarget(path, options) };
  } catch (error) {
    if (!(error instanceof TeamConfigStoreError)) throw error;
    return { ok: false, why: `the registry's record of this team cannot be read: ${error.message}` };
  }
}

/** How a message names where the team lives: `the registry's record` under the registry source,
 *  `the team file` otherwise, so a refusal never names a file that is not read. A record that
 *  cannot be read is still the registry's: its name is the last thing a refusal can say. */
export function teamPlace(path: string, options: TeamTextOptions = {}, onFile = 'the team file'): string {
  const read = readTeamTextTarget(path, options);
  return read.ok && read.target.kind === 'file' ? onFile : "the registry's record";
}

/** The team a launched pointer names, read as the team it is. A pointer records the file a
 *  session was launched from; when that file is a root's own `.agents/team.yaml` and the
 *  registry holds that root's team, the registry's record is the team — the source every edit
 *  writes, so the read never serves a copy the registry has moved past (a seat stopped with
 *  `remove --keep`, for one). Any other file is read as the file it names, as `--file` is. */
export function readLaunchedTeam(file: string, options: ReadTeamConfigOptions = {}): LoadResult {
  const target = readTeamTextTarget(file, {
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  if (!target.ok) return { ok: false, path: file, errors: [{ line: 0, message: target.why }] };
  const { file: _named, ...rest } = options;
  return target.target.kind === 'registry'
    ? readTeamConfig(target.target.root, rest)
    : readTeamConfig(dirname(file), { ...rest, file });
}

/** The team's text as an editing command reads it: the registry's record, or the file. Throws as
 *  `readFileSync` does when there is nothing to read, so callers keep their own refusal. */
export function readTeamText(path: string, options: TeamTextOptions = {}): string {
  const target = teamTextTarget(path, options);
  if (target.kind === 'file') return readFileSync(path, 'utf8');
  const stored = readStoredTeamConfig(target.home, target.id);
  if (stored === null) throw new Error(`no team is registered for ${target.root}: run \`team migrate\``);
  return stored.text;
}

function provenanceOf(
  previous: StoredTeamConfig | null,
  now: string,
): Pick<StoredTeamConfig, 'imported_from' | 'imported_at' | 'imported_by' | 'created_by' | 'created_at'> {
  if (previous === null) return { created_by: 'init', created_at: now };
  const kept: Pick<StoredTeamConfig, 'imported_from' | 'imported_at' | 'imported_by' | 'created_by' | 'created_at'> = {};
  for (const key of ['imported_from', 'imported_at', 'imported_by', 'created_by', 'created_at'] as const) {
    if (previous[key] !== undefined) (kept as Record<string, unknown>)[key] = previous[key];
  }
  return kept;
}

// Replace in place, for now (the owner's ruling for phase 3): an edit replaces the team's one
// record atomically, and the previous version is not kept. The design's append-only, signed
// ledger (one signed entry per edit, `team history`, `team diff`) replaces this write when it
// lands; the record's `format` lets that change be read without a guess.
/** The one write of an edited team: validated, then the registry's record or the file. */
export function writeTeamText(path: string, text: string, options: TeamTextOptions = {}): { ok: true; target: TeamTextTarget['kind'] } | { ok: false; errors: Problem[] } {
  const target = teamTextTarget(path, options);
  if (target.kind === 'file') {
    const wrote = writeTeamFile(path, text);
    return wrote.ok ? { ok: true, target: 'file' } : wrote;
  }
  const parsed = validateTeamFile(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const previous = readStoredTeamConfig(target.home, target.id);
  const now = (options.now ?? (() => new Date()))().toISOString();
  const record: StoredTeamConfig = {
    format: 1,
    id: target.id,
    root: target.root,
    text,
    text_sha256: sha256(text),
    record_version: CANONICAL_RECORD_VERSION,
    record_sha256: sha256(canonicalTeam(parsed.team)),
    // The provenance is kept: an imported team keeps its import fields, and a team `team init`
    // created here keeps `created_by`. A new record (`create`) is marked as created, never as an
    // import that did not happen.
    ...provenanceOf(previous, now),
    edited_by: options.command ?? 'edit',
    edited_at: now,
  };
  writeStoredTeamConfig(target.home, record);
  return { ok: true, target: 'registry' };
}
