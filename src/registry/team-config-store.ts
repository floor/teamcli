// The team's configuration as the registry holds it (phase 2 of the team-file migration): one
// record per team, keyed by the team ID, at `<home>/.config/team/team-config/<id>.json`.
//
// Phase 2 stores the definition the owner imported — the team's text, the one the validator reads,
// with its canonical record's digest (`team-record-c14n-v1`, src/file/canonical-record.ts) — so a
// team read from the registry is validated exactly as the file was and a signature means the same
// thing whichever source the team came from. Phase 3 replaces the text with signed records written
// by the editing commands; the path and the envelope's `format` let it do that without a guess.
//
// Every write is an atomic replace (a temporary file in the same folder, then a rename): a reader
// never sees half a record.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../state.ts';

export const TEAM_CONFIG_RECORD_FORMAT = 1;

export type StoredTeamConfig = {
  format: typeof TEAM_CONFIG_RECORD_FORMAT;
  /** The team ID (src/registry/teams.ts `teamIdOf`) of the root this record belongs to. */
  id: string;
  /** The project root the team was imported for, as it was resolved then. */
  root: string;
  /** The team's definition, as validated at import. */
  text: string;
  /** sha256 of `text`: a record whose text does not match is refused, never read. */
  text_sha256: string;
  /** The canonical serialization the digest below was computed with. */
  record_version: string;
  /** sha256 of the canonical record of the validated team at import. */
  record_sha256: string;
  /** Where the definition came from: the team file's path at import. Absent for a team that
   *  `team init` created in the registry, which carries `created_by` instead. */
  imported_from?: string;
  imported_at?: string;
  /** `migrate` for the one-time move, `import` for a later replacement. */
  imported_by?: 'migrate' | 'import';
  /** The command that created the team in the registry, when no file was ever imported. */
  created_by?: 'init';
  created_at?: string;
  /** The last editing command that replaced the definition after the import (phase 3), and when.
   *  Absent until a writer edits the registry's record. */
  edited_by?: string;
  edited_at?: string;
};

export class TeamConfigStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamConfigStoreError';
  }
}

/** The folder of the per-team configuration records. */
export function teamConfigDir(home: string): string {
  return join(home, '.config', 'team', 'team-config');
}

export function teamConfigRecordPath(home: string, id: string): string {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new TeamConfigStoreError(`"${id}" is not a team ID`);
  return join(teamConfigDir(home), `${id}.json`);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The team's stored configuration, or null when the registry holds none. A record that does not
 *  read, or whose text does not match its digest, throws `TeamConfigStoreError` naming the file. */
export function readStoredTeamConfig(home: string, id: string): StoredTeamConfig | null {
  const path = teamConfigRecordPath(home, id);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new TeamConfigStoreError(`${path}: ${(error as Error).message}`);
  }
  const record = value as Partial<StoredTeamConfig> | null;
  if (
    record === null || typeof record !== 'object'
    || record.format !== TEAM_CONFIG_RECORD_FORMAT
    || record.id !== id
    || typeof record.root !== 'string'
    || typeof record.text !== 'string'
    || typeof record.text_sha256 !== 'string'
  ) {
    throw new TeamConfigStoreError(`${path}: not a team configuration record (format ${TEAM_CONFIG_RECORD_FORMAT})`);
  }
  if (sha256(record.text) !== record.text_sha256) {
    throw new TeamConfigStoreError(`${path}: the stored definition does not match its digest`);
  }
  return record as StoredTeamConfig;
}

/** Writes the team's configuration record, replacing any previous one atomically. */
export function writeStoredTeamConfig(home: string, record: StoredTeamConfig): string {
  const path = teamConfigRecordPath(home, record.id);
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}
