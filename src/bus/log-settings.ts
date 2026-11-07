// The bus log's two policy words in force for one store: the open segment's size bound
// (`bus.segment_mb`, the catalogue policy `event-segment-mb`) and the age window
// (`bus.retain_days`, the existing `event-retention-days` policy with `0` and `all` as the
// explicit keep-all words). Both are read to the team level, the way the daemon reads its other
// knobs: the nearest level's word wins, and the catalogue's fallback answers an absent word.
//
// The log must stay writable when the policy store cannot answer, so a chain that will not
// resolve keeps the release defaults for the segment size and the window and reports why through
// `unknown`; the append path only keeps writing. A store with no team configuration — a folder
// outside every team, a fixture — keeps the constants this build shipped before the settings
// existed: one live file bounded at the retained-size cap, the 30-day window, and a two-file set.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { projectIdOfTeam } from '../dev_mode.ts';
import { entitiesPath } from '../entities.ts';
import { isNoRepository } from '../file/load.ts';
import { grantsDir } from '../grant.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { Problem, TeamFile } from '../file/types.ts';
import { EVENT_SEGMENT_BYTES, loadAndResolvePolicyChain } from '../policy/index.ts';
import { projectsFile } from '../registry/projects.ts';
import { teamConfigRecordPath } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';
import { machineSettingsPath } from '../settings/declared.ts';
import { DEFAULT_EVENT_RETENTION_SECONDS, EVENT_LOG_KEPT, EVENT_LOG_TOTAL_BYTES } from './kinds.ts';

/** The log's settings in force, and why the release defaults stand in when they do. */
export type EventLogSettings = {
  /** The most the open segment may hold before an append rotates it. */
  segmentBytes: number;
  /** The age after which a sealed segment is dropped; `0` is the explicit keep-all word. */
  retentionSeconds: number;
  /** The retained files a reader looks at: the live segment and the sealed slots the cap allows. */
  kept: number;
  /** Why the release defaults are in force; absent when the chain resolved every word. */
  unknown?: string;
};

/** A store with no team configuration keeps today's constants exactly. */
const UNCONFIGURED: EventLogSettings = {
  segmentBytes: EVENT_LOG_TOTAL_BYTES,
  retentionSeconds: DEFAULT_EVENT_RETENTION_SECONDS,
  kept: EVENT_LOG_KEPT,
};

/**
 * The retained set's slot count for one segment size: the live segment plus the sealed segments
 * the retained-size cap can hold. The count only bounds how many paths a reader looks at;
 * pruning, not rotation, drops a segment to stay under the cap in bytes.
 */
export function retainedSlotsFor(segmentBytes: number): number {
  return Math.max(EVENT_LOG_KEPT, Math.floor(EVENT_LOG_TOTAL_BYTES / segmentBytes) + 1);
}

/** Whether a load problem means "this root has no team", not "this root's team is broken". A
 *  missing team is a store outside every team and keeps the constants; a team file that does not
 *  parse is a chain that could not be read and is named as such. */
function noTeamProblem(problem: Problem): boolean {
  if (isNoRepository(problem)) return true;
  return (
    problem.message.startsWith('no team file') ||
    problem.message.startsWith('no team is registered for ') ||
    problem.message.startsWith('the registry lists this team but holds no config record')
  );
}

/** The settings a loaded team's chain answers, or the release defaults with `unknown` why. */
export function eventLogSettingsOf(
  team: TeamFile | null,
  root: string | null,
  home: string | undefined,
  now: Date = new Date(),
): EventLogSettings {
  if (team === null) return { ...UNCONFIGURED };
  const defaults: EventLogSettings = {
    segmentBytes: EVENT_SEGMENT_BYTES,
    retentionSeconds: DEFAULT_EVENT_RETENTION_SECONDS,
    kept: retainedSlotsFor(EVENT_SEGMENT_BYTES),
  };
  try {
    const resolved = loadAndResolvePolicyChain(
      {
        home,
        entity: team.entity,
        projectId: home === undefined || root === null ? null : projectIdOfTeam(home, team, root),
        teamRoot: root,
        team,
      },
      { now, upToLevel: 'team' },
    );
    if (!resolved.ok) {
      const why = resolved.refusals.map((refusal) => refusal.message).join('; ');
      return { ...defaults, unknown: why === '' ? 'the policy chain could not be read' : why };
    }
    const segmentMb = resolved.policies['event-segment-mb']?.value;
    const segmentBytes =
      typeof segmentMb === 'number' && Number.isInteger(segmentMb) && segmentMb >= 1
        ? segmentMb * 1_000_000
        : EVENT_SEGMENT_BYTES;
    const days = resolved.policies['event-retention-days']?.value;
    // Zero is the explicit keep-all word, not a missing value: it must survive the read.
    const retentionSeconds =
      typeof days === 'number' && Number.isInteger(days) && days >= 0
        ? days * 86_400
        : DEFAULT_EVENT_RETENTION_SECONDS;
    return { segmentBytes, retentionSeconds, kept: retainedSlotsFor(segmentBytes) };
  } catch (error) {
    return { ...defaults, unknown: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The settings in force for a store identified by its root: the team is read the way every
 * command reads it (the registry's record first, a team file when the registry holds none), then
 * its chain is resolved to the team level.
 *
 * The answer is cached per store against the files the read depends on — the team's registry
 * record and file, the entity and project policy files, and the machine's config-source setting —
 * and for at most `CACHE_MS`, so a policy word that expires with the clock stops being read as in
 * force. The bus resolves once at start and passes the values down; the cache keeps a command, a
 * feed reader or a scene that reads or appends repeatedly from paying the team read each time.
 */
const CACHE_MS = 1_000;
const CACHE_LIMIT = 128;
const settingsCache = new Map<string, { stamp: string; at: number; settings: EventLogSettings }>();

function statStamp(path: string): string {
  try {
    const held = statSync(path);
    return `${String(held.ino)}:${String(held.size)}:${String(held.mtimeMs)}`;
  } catch {
    return '-';
  }
}

/** What a settings read depends on besides the clock: a write to any of these changes it. */
function settingsStamp(root: string, home: string): string {
  let record = '-';
  try {
    record = statStamp(teamConfigRecordPath(home, teamIdOf(root)));
  } catch {
    record = '-';
  }
  return [
    statStamp(join(root, '.agents', 'team.yaml')),
    record,
    // A policy set lands as a new generation file, so the folder's own stamp moves with it.
    statStamp(grantsDir(home)),
    statStamp(entitiesPath(home)),
    statStamp(projectsFile(home)),
    statStamp(machineSettingsPath(home)),
  ].join('|');
}

export function eventLogSettingsFor(
  root: string,
  home: string,
  now: Date = new Date(),
): EventLogSettings {
  const key = `${root}\u0000${home}`;
  const stamp = settingsStamp(root, home);
  const at = now.getTime();
  const cached = settingsCache.get(key);
  if (cached !== undefined && cached.stamp === stamp && at - cached.at <= CACHE_MS) {
    settingsCache.delete(key);
    settingsCache.set(key, cached);
    return { ...cached.settings };
  }
  const settings = resolveEventLogSettings(root, home, now);
  settingsCache.delete(key);
  settingsCache.set(key, { stamp, at, settings });
  if (settingsCache.size > CACHE_LIMIT) {
    const oldest = settingsCache.keys().next();
    if (!oldest.done) settingsCache.delete(oldest.value);
  }
  return { ...settings };
}

function resolveEventLogSettings(
  root: string,
  home: string,
  now: Date,
): EventLogSettings {
  let loaded;
  try {
    loaded = readTeamConfig(root, { home });
  } catch (error) {
    return {
      segmentBytes: EVENT_SEGMENT_BYTES,
      retentionSeconds: DEFAULT_EVENT_RETENTION_SECONDS,
      kept: retainedSlotsFor(EVENT_SEGMENT_BYTES),
      unknown: error instanceof Error ? error.message : String(error),
    };
  }
  if (!loaded.ok) {
    if (loaded.errors.length > 0 && loaded.errors.every(noTeamProblem)) return { ...UNCONFIGURED };
    const why = loaded.errors.map((problem) => problem.message).join('; ');
    return {
      segmentBytes: EVENT_SEGMENT_BYTES,
      retentionSeconds: DEFAULT_EVENT_RETENTION_SECONDS,
      kept: retainedSlotsFor(EVENT_SEGMENT_BYTES),
      unknown: why === '' ? 'the team configuration could not be read' : why,
    };
  }
  return eventLogSettingsOf(loaded.team, loaded.root, home, now);
}
