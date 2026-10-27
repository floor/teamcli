// Moving a team's definition from its `.agents/team.yaml` into the registry: `team migrate` does it
// once, `team import` replaces the registry's record with a file later (the repair `team check`
// and `team status` name when a leftover file no longer matches). One code path for both.
//
// The file is read and validated by the file reader itself — placement included — so nothing the
// file reader would refuse reaches the registry. After the write, the team is read back through
// the registry source and compared with the file by canonical record (`team-record-c14n-v1`):
// the round trip either verifies or the command says it did not. The file is never deleted here.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { CANONICAL_RECORD_VERSION } from './canonical-record.ts';
import { findRoot, loadTeamText, TEAM_FILE } from './load.ts';
import { canonicalTeam, readTeamConfig, resolveTeamConfigSource } from './team-config.ts';
import type { Problem } from './types.ts';
import {
  readStoredTeamConfig,
  sha256,
  TeamConfigStoreError,
  writeStoredTeamConfig,
  type StoredTeamConfig,
} from '../registry/team-config-store.ts';
import { getTeam, teamIdOf } from '../registry/teams.ts';

export type ImportMode = 'migrate' | 'import';

export type ImportOutcome =
  | {
      ok: true;
      /** `imported`: the record was written; `unchanged`: the registry already says this;
       *  `would-import`: a dry run, nothing written. */
      action: 'imported' | 'unchanged' | 'would-import';
      project: string;
      id: string;
      root: string;
      from: string;
      record: string | null;
      replaced: boolean;
      verified: boolean;
    }
  | { ok: false; reason: 'invalid' | 'already-migrated' | 'registry' | 'round-trip'; errors: Problem[]; from?: string };

export type ImportOptions = {
  cwd: string;
  home: string;
  mode: ImportMode;
  /** The team file to read; this checkout's `.agents/team.yaml` when absent. */
  file?: string;
  dryRun?: boolean;
  now?: Date;
};

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function importTeamFile(options: ImportOptions): ImportOutcome {
  const root0 = findRoot(options.cwd) ?? real(options.cwd);
  const from = options.file !== undefined ? resolve(options.cwd, options.file) : join(root0, TEAM_FILE);
  // The team belongs to this checkout whatever file it is read from (a copy elsewhere, later a
  // snapshot): it is validated, and placed, for this root.
  let text: string;
  try {
    text = readFileSync(from, 'utf8');
  } catch {
    return { ok: false, reason: 'invalid', errors: [{ line: 0, message: `no readable team file at ${from}` }], from };
  }
  const loaded = loadTeamText(text, root0, join(root0, TEAM_FILE), { home: options.home });
  if (!loaded.ok) return { ok: false, reason: 'invalid', errors: loaded.errors, from };
  const id = teamIdOf(loaded.root);
  let existing: StoredTeamConfig | null;
  try {
    existing = readStoredTeamConfig(options.home, id);
  } catch (error) {
    if (!(error instanceof TeamConfigStoreError)) throw error;
    // `import` is the repair for a record that no longer reads; `migrate` is not.
    if (options.mode === 'migrate') return { ok: false, reason: 'registry', errors: [{ line: 0, message: error.message }], from };
    existing = null;
  }
  const record = sha256(canonicalTeam(loaded.team));
  const base = { project: loaded.team.project, id, root: loaded.root, from };
  if (existing !== null && options.mode === 'migrate') {
    return {
      ok: false,
      reason: 'already-migrated',
      from,
      errors: [{
        line: 0,
        message: `${loaded.team.project} was already moved to the registry (${existing.imported_at ?? existing.created_at ?? 'at an unknown time'}); to replace the registry's record with this file, run \`team import\``,
      }],
    };
  }
  if (existing !== null && existing.record_sha256 === record && existing.text === loaded.text) {
    return { ok: true, action: 'unchanged', ...base, record, replaced: false, verified: true };
  }
  if (options.dryRun) return { ok: true, action: 'would-import', ...base, record, replaced: existing !== null, verified: false };
  writeStoredTeamConfig(options.home, {
    format: 1,
    id,
    root: loaded.root,
    text: loaded.text,
    text_sha256: sha256(loaded.text),
    record_version: CANONICAL_RECORD_VERSION,
    record_sha256: record,
    imported_from: from,
    imported_at: (options.now ?? new Date()).toISOString(),
    imported_by: options.mode,
  });
  // The round trip: the team as every command will now read it, against the file it came from.
  const back = readTeamConfig(loaded.root, { home: options.home, source: 'registry' });
  if (!back.ok || sha256(canonicalTeam(back.team)) !== record) {
    return {
      ok: false,
      reason: 'round-trip',
      from,
      errors: back.ok
        ? [{ line: 0, message: 'the team read back from the registry differs from the file it was imported from' }]
        : back.errors,
    };
  }
  return { ok: true, action: 'imported', ...base, record, replaced: existing !== null, verified: true };
}

/** `team up` on a team the registry does not hold yet, whose definition is still in this
 *  checkout's `.agents/team.yaml`: the owner's run imports it first, as `team migrate` would, and
 *  says so; the file is kept (team migrate retires it). Null when there is nothing to do, or when
 *  the import does not verify — the read that follows then refuses in its own words. */
export function importForUp(cwd: string, home: string | undefined, dryRun: boolean, now: Date = new Date()): string | null {
  const where = home ?? homedir();
  const resolution = resolveTeamConfigSource({ home: where });
  if (!resolution.ok || resolution.source !== 'registry') return null;
  const root = findRoot(cwd) ?? real(cwd);
  if (!existsSync(join(root, TEAM_FILE))) return null;
  try {
    if (readStoredTeamConfig(where, teamIdOf(root)) !== null) return null;
  } catch {
    return null;
  }
  const listed = registryLists(where, root);
  if (dryRun) {
    return listed
      ? `the registry lists this team but holds no config record yet: a real run imports ${TEAM_FILE} first (team migrate)`
      : `this team is not in the registry yet: a real run imports ${TEAM_FILE} first (team migrate)`;
  }
  const moved = importTeamFile({ cwd, home: where, mode: 'migrate', now });
  if (!moved.ok) return null;
  return listed
    ? `the registry lists this team but holds no config record yet: imported ${TEAM_FILE} (team ${moved.id}), read back and verified; the file is no longer read: run \`team migrate\` to move it to the Trash`
    : `this team was not in the registry yet: imported ${TEAM_FILE} (team ${moved.id}), read back and verified; the file is no longer read: run \`team migrate\` to move it to the Trash`;
}

function registryLists(home: string, root: string): boolean {
  try {
    return getTeam(home, teamIdOf(root)) !== null;
  } catch {
    return false;
  }
}
