import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { canonicalRecord, teamRecordOf } from './canonical-record.ts';
import { loadTeamFile, loadTeamText, TEAM_FILE } from './load.ts';
import { withRecordedSession } from './recorded-session.ts';
import type { LoadResult, TeamFile } from './types.ts';
import { machineSettingsPath } from '../settings/declared.ts';
import { parseYaml, toValue, type YamlValue } from '../yaml.ts';

// The one read seam for a team's configuration. Every command that needs the team reads it here,
// never through the backing store directly, so the source can change behind this function without
// touching its callers.
//
// The source is a setting, `team-config.source`, and its default is the registry. The registry
// holds the definition `team migrate` imported once (src/registry/team-config-store.ts). When that
// record exists, a `.agents/team.yaml` left in the project is not read as the team: when it no
// longer says what the registry says, the result carries `leftover.matches: false`, and
// `team check` and `team status` name it with `team import` as the repair. When the record does
// not exist, the team file is read and the result says so once. `--file` always reads the file it
// names (tests, snapshots, `team migrate`), whatever the setting.

/** Where the configuration came from. */
export type TeamConfigSource = 'registry' | 'team-file';

/** The values `team-config.source` takes. */
export const TEAM_CONFIG_SOURCES = ['registry', 'file'] as const;
export type TeamConfigSourceSetting = (typeof TEAM_CONFIG_SOURCES)[number];

/** The setting's name, as written in `<home>/.config/team/settings.yaml`. */
export const TEAM_CONFIG_SOURCE_SETTING = 'team-config.source';
/** The environment variable that overrides the setting for one run (or one test suite). */
export const TEAM_CONFIG_SOURCE_ENV = 'TEAM_CONFIG_SOURCE';
/** The release default: the registry only (owner decision, 2026-10-24). */
export const DEFAULT_TEAM_CONFIG_SOURCE: TeamConfigSourceSetting = 'registry';

/** The options the seam accepts: the team-file reader's, plus the source for this one read. */
export type ReadTeamConfigOptions = NonNullable<Parameters<typeof loadTeamFile>[1]> & {
  /** Read from this source, ahead of the environment and the machine setting. */
  source?: TeamConfigSourceSetting;
  /** The environment the override is read from; the process's own when absent. */
  env?: Record<string, string | undefined>;
};

export type SourceResolution =
  | { ok: true; source: TeamConfigSourceSetting; from: 'option' | 'environment' | 'machine' | 'default' }
  | { ok: false; message: string };

function isSource(value: unknown): value is TeamConfigSourceSetting {
  return typeof value === 'string' && (TEAM_CONFIG_SOURCES as readonly string[]).includes(value);
}

function invalid(value: unknown, where: string): SourceResolution {
  return {
    ok: false,
    message: `${TEAM_CONFIG_SOURCE_SETTING} is "${String(value)}" in ${where}; it must be ${TEAM_CONFIG_SOURCES.join(' or ')}`,
  };
}

/** The machine's word on the source: `team-config.source: <word>` or `team-config: {source: <word>}`
 *  in `<home>/.config/team/settings.yaml`. Absent when the file or the key is absent. */
function machineSource(home: string): { value: unknown; path: string } | undefined {
  const path = machineSettingsPath(home);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let value: YamlValue;
  try {
    value = toValue(parseYaml(text));
  } catch {
    // The settings file's other readers name a file that does not parse; this one only looks
    // for its key and does not refuse every command over another setting's typo.
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (TEAM_CONFIG_SOURCE_SETTING in value) return { value: value[TEAM_CONFIG_SOURCE_SETTING], path };
  const section = value['team-config'];
  if (section !== null && typeof section === 'object' && !Array.isArray(section) && 'source' in section) {
    return { value: section.source, path };
  }
  return undefined;
}

/** Which source a read uses: the option, then `TEAM_CONFIG_SOURCE`, then the machine setting,
 *  then the release default. A value that is not a source is a refusal, never a guess. */
export function resolveTeamConfigSource(options: { source?: string; home?: string; env?: Record<string, string | undefined> } = {}): SourceResolution {
  if (options.source !== undefined) {
    return isSource(options.source) ? { ok: true, source: options.source, from: 'option' } : invalid(options.source, 'this call');
  }
  const env = options.env ?? process.env;
  const fromEnv = env[TEAM_CONFIG_SOURCE_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    return isSource(fromEnv) ? { ok: true, source: fromEnv, from: 'environment' } : invalid(fromEnv, `$${TEAM_CONFIG_SOURCE_ENV}`);
  }
  const machine = machineSource(options.home ?? homedir());
  if (machine !== undefined) {
    return isSource(machine.value) ? { ok: true, source: machine.value, from: 'machine' } : invalid(machine.value, machine.path);
  }
  return { ok: true, source: DEFAULT_TEAM_CONFIG_SOURCE, from: 'default' };
}

/** The canonical record of a validated team: what two sources are compared by. */
export function canonicalTeam(team: TeamFile): string {
  return canonicalRecord(teamRecordOf(team as unknown as Record<string, unknown> & { seats: object[] }));
}

/** Finds, reads and validates the team's configuration for the folder `cwd`. */
export function readTeamConfig(cwd: string, options: ReadTeamConfigOptions = {}): LoadResult {
  const { source: _source, env, ...fileOptions } = options;
  // A named file is read and only that file: the way tests and snapshots hand a team in.
  if (options.file !== undefined) return withSource(loadTeamFile(cwd, { ...fileOptions, source: 'file' }), 'team-file');
  const resolved = resolveTeamConfigSource(options);
  if (!resolved.ok) return { ok: false, errors: [{ line: 0, message: resolved.message }] };
  if (resolved.source === 'file') return withSource(loadTeamFile(cwd, { ...fileOptions, source: 'file' }), 'team-file');
  return loadTeamFile(cwd, { ...fileOptions, source: 'registry', ...(env !== undefined ? { env } : {}) });
}

/** A team read from the registry's config record: the source mark, and a leftover file beside it. */
export function noteRegistryRead(
  loaded: LoadResult,
  path: string,
  root: string,
  options: { home?: string },
): LoadResult {
  if (!loaded.ok) return loaded;
  const result: LoadResult = { ...loaded, source: 'registry' };
  const leftover = leftoverOf(path, loaded.team, root, options);
  return leftover === undefined ? result : { ...result, leftover };
}

function withSource(result: LoadResult, source: TeamConfigSource): LoadResult {
  return result.ok ? { ...result, source } : result;
}

/** A team file left beside a registry team: present, and whether it says what the registry says.
 *  Read and validated only to compare; a file that does not validate does not match. */
function leftoverOf(
  path: string,
  team: TeamFile,
  root: string,
  options: { home?: string },
): { path: string; matches: boolean } | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { path, matches: false };
  }
  const file = loadTeamText(text, root, path, { ...(options.home !== undefined ? { home: options.home } : {}), checkOnly: true });
  if (!file.ok) return { path, matches: false };
  // A leftover that omits `session:` is read the same way the registry record is: the recorded
  // session, not a derived `<entity>-<project>`. Otherwise a byte-identical file looks different.
  const interpreted = options.home === undefined ? file.team : withRecordedSession(file.team, text, options.home, root);
  try {
    return { path, matches: canonicalTeam(interpreted) === canonicalTeam(team) };
  } catch {
    return { path, matches: false };
  }
}

/** The row `team check` and `team status` print for a leftover file that says something else than
 *  the registry: never silent, and never read as the team. */
export function leftoverDifferences(leftover: { path: string; matches: boolean } | undefined): { what: string; repair: string }[] {
  if (leftover === undefined || leftover.matches) return [];
  return [{
    what: `${leftover.path} differs from this team's registry record; the registry is the source and the file is not read`,
    repair: 'team import',
  }];
}

/** The one line `team up`, `team check` and `team status` print for a leftover file that says what
 *  the registry says: a note, never a refusal, naming the command that retires it. */
export function leftoverNote(leftover: { path: string; matches: boolean } | undefined): string | null {
  if (leftover === undefined || !leftover.matches) return null;
  return `${TEAM_FILE} is still in this project, and is no longer read (the team is in the registry): run \`team migrate\` to move it to the Trash`;
}
