// The watch's pace in force: one policy value (`watch-rhythm`), the legacy `tempo` +
// `watch.interval` conversion, and the safe fallback when the policy chain cannot be read.
//
// The pace is one object so the pass rate and the six waits can never disagree. A signed
// declaration wins and names its level; with none, a verified file's tempo and interval convert
// to the same structured shape, keeping their former independence (tempo is the wait factor,
// interval the final sweep). An unreadable chain is not "nothing declared": the caller keeps the
// safe reading cadence but must hold automated work, nudges and escalations until the chain can
// be read, and this module says so through `unknown`. Nothing here writes a marker or a file.

import { projectIdOfTeam } from '../dev_mode.ts';
import { SCALED_WATCH_WAITS } from '../file/sections/tempo.ts';
import { defaultWatch } from '../file/sections/watch.ts';
import type { TeamFile } from '../file/types.ts';
import {
  loadAndResolvePolicyChain,
  WATCH_RHYTHM_FACTOR,
  WATCH_RHYTHM_SWEEP,
  WATCH_SWEEP_MAX,
  WATCH_SWEEP_MIN,
  watchRhythmValueOf,
  type WatchRhythmPreset,
} from '../policy/index.ts';
import type { Standing } from '../store/store.ts';

/** Whose word set the pace: a signed policy level, the team file, or the release default. */
export type WatchPaceSource = 'entity' | 'project' | 'team' | 'file' | 'default';

export type WatchPace = {
  preset: WatchRhythmPreset;
  /** The final interval between passes. Never multiplied by the preset. */
  sweepSeconds: number;
  source: WatchPaceSource;
  /** A legacy interval the sweep floor or ceiling had to normalize, with its declared number. */
  normalized: { field: 'watch.interval'; declared: number; used: number } | null;
  /** Legacy file values a signed declaration set aside. */
  setAside: { setting: 'tempo' | 'watch.interval'; declared: string | number; by: 'entity' | 'project' | 'team' }[];
  /** Why the policy chain could not be read; automated effects must stay held while it is set. */
  unknown?: string;
};

export type WatchPaceInput = {
  team: TeamFile;
  root: string;
  home: string | undefined;
  standing: Standing;
  now: Date;
};

/**
 * The watch with a pace applied: the sweep is the pace's final interval and the six waits scale
 * by the preset's factor, to the nearest second, never below one and never above a day. An
 * omitted `idleRepeat` stays off. No other field is touched.
 */
export function applyWatchPace(
  watch: TeamFile['watch'],
  pace: Pick<WatchPace, 'preset' | 'sweepSeconds'>,
): TeamFile['watch'] {
  const factor = WATCH_RHYTHM_FACTOR[pace.preset];
  const next: TeamFile['watch'] = { ...watch, interval: pace.sweepSeconds };
  if (factor === 1) return next;
  for (const key of SCALED_WATCH_WAITS) {
    const value = watch[key];
    if (value === undefined) continue;
    next[key] = Math.min(WATCH_SWEEP_MAX, Math.max(1, Math.round(value * factor)));
  }
  return next;
}

/** The watch values a pass runs with under a pace: the team file when verified, else defaults. */
export function watchInForceWithPace(standing: Standing, team: TeamFile, pace: WatchPace): TeamFile['watch'] {
  return applyWatchPace(standing.kind === 'verified' ? team.watch : defaultWatch(), pace);
}

/** The legacy file pair as the one structured value, its interval clamped to the sweep range. */
function legacyPace(team: TeamFile): Pick<WatchPace, 'preset' | 'sweepSeconds' | 'normalized'> {
  const declared = team.watch.interval;
  const used = Math.min(WATCH_SWEEP_MAX, Math.max(WATCH_SWEEP_MIN, declared));
  return {
    preset: team.tempo,
    sweepSeconds: used,
    normalized: used === declared
      ? null
      : { field: 'watch.interval', declared, used },
  };
}

/**
 * The one-line reports a pace owes: the normalization it applied, the legacy values a signed
 * declaration set aside, or why the chain could not be read. Empty when the pace is quiet.
 */
export function watchPaceNotes(pace: WatchPace): string[] {
  if (pace.unknown !== undefined) {
    return [`the watch-rhythm policy could not be read: ${pace.unknown}; automated work, nudges and escalations are held until it can be read`];
  }
  const notes: string[] = [];
  if (pace.normalized !== null) {
    const { declared, used } = pace.normalized;
    const bound = used > declared ? 'below the 10s sweep floor' : 'above the 24h sweep ceiling';
    notes.push(`watch.interval ${declared}s is ${bound}; sweeping every ${used}s`);
  }
  for (const aside of pace.setAside) {
    notes.push(`the file's ${aside.setting} "${String(aside.declared)}" is set aside by a signed watch-rhythm at ${aside.by}`);
  }
  return notes;
}

/**
 * The pace in force. A signed `watch-rhythm` at the nearest level wins, with the legacy file
 * values it set aside named. With no signed declaration, a verified file's tempo and interval
 * convert; an unverified file keeps the release default (normal, 120s). A chain that cannot be
 * read carries `unknown` and the safe fallback: the verified file conversion for reading
 * cadence, normal@120 otherwise. The fixed daemon heartbeat is not read here and never scales.
 */
export function watchPaceOf(input: WatchPaceInput): WatchPace {
  const { team, root, home, standing, now } = input;
  let unknown: string | undefined;
  let signed: { preset: WatchRhythmPreset; sweepSeconds: number } | null = null;
  let signedBy: 'entity' | 'project' | 'team' | null = null;

  if (home === undefined) {
    unknown = 'there is no home to read the watch-rhythm policy chain from';
  } else {
    try {
      const resolved = loadAndResolvePolicyChain(
        {
          home,
          entity: team.entity,
          projectId: projectIdOfTeam(home, team, root),
          teamRoot: root,
          team,
        },
        { now, upToLevel: 'team' },
      );
      if (!resolved.ok) {
        unknown = resolved.refusals.map((refusal) => refusal.message).join('; ')
          || 'the watch-rhythm policy chain could not be read';
      } else {
        const effective = resolved.policies['watch-rhythm'];
        if (effective !== undefined
          && (effective.level === 'entity' || effective.level === 'project' || effective.level === 'team')) {
          const value = typeof effective.value === 'string' ? watchRhythmValueOf(effective.value) : null;
          if (value === null) {
            unknown = `watch-rhythm resolved to a value this build cannot read: ${String(effective.value)}`;
          } else {
            signed = value;
            signedBy = effective.level;
          }
        }
      }
    } catch (error) {
      unknown = error instanceof Error ? error.message : String(error);
    }
  }

  const extra = unknown === undefined ? {} : { unknown };

  if (signed !== null && signedBy !== null) {
    const setAside: WatchPace['setAside'] = [];
    if (standing.kind === 'verified') {
      const defaults = defaultWatch();
      if (team.tempo !== 'normal') setAside.push({ setting: 'tempo', declared: team.tempo, by: signedBy });
      if (team.watch.interval !== defaults.interval) {
        setAside.push({ setting: 'watch.interval', declared: team.watch.interval, by: signedBy });
      }
    }
    return { ...signed, source: signedBy, normalized: null, setAside, ...extra };
  }

  if (standing.kind === 'verified') {
    return { ...legacyPace(team), source: 'file', setAside: [], ...extra };
  }

  return {
    preset: 'normal',
    sweepSeconds: WATCH_RHYTHM_SWEEP.normal,
    source: 'default',
    normalized: null,
    setAside: [],
    ...extra,
  };
}
