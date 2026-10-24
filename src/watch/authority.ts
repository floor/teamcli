// The watch's own authority, checked from the records this session already holds. A watch
// process that pushes automatic work is admitted by what the state records about it — the pid
// and the epoch its host captured when it acquired the watch, the heartbeat it renewed, and the
// team file `up` recorded — never by a name, a caller object or an environment value a request
// could supply.
//
// The epoch is the fence: a host that acquires the watch mints `watch_` + 32 lowerhex from 128
// random bits and keeps it in memory, so a contender's record carries another epoch and the old
// host's next send refuses even while the pid still matches. Freshness is a fixed liveness bound
// (three heartbeat beats), not the policy interval: a dormant watch must not stay valid.
//
// The proof is a diagnostic digest of the snapshot; no other code accepts it as a token. This
// module reads the state under the state's own lock, so the record it judges is one consistent
// snapshot, and it refuses on a missing or unknown epoch rather than falling back to a pid.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical } from '../approve/fingerprint.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { LockBusyError, readState, type State, withLock } from '../state.ts';
import {
  isWatchEpoch,
  WATCH_AUTHORITY_FUTURE_SKEW_MS,
  WATCH_AUTHORITY_MAX_AGE_MS,
} from './epoch.ts';

/** The only purpose the watch actor is admitted for; any other word has no branch. */
export const WATCH_DIRECT_WORK = 'direct-work';

export type WatchAuthorityInput = {
  /** The team root; the verifier canonicalizes it and loads the team file from it. */
  root: string;
  /** The session whose watch record is judged. */
  session: string;
  /** The fence this host captured when it acquired the watch, held in its memory. */
  epoch: string;
  purpose: typeof WATCH_DIRECT_WORK;
  /** A test seam for the clock; production takes `new Date()`. */
  now?: Date;
};

export type WatchAuthority = {
  pid: number;
  epoch: string;
  heartbeat: string;
  pane?: string;
  /** The canonical path of the team file `up` recorded. */
  file: string;
};

export type WatchActorVerdict =
  | {
      ok: true;
      actor: { kind: 'watch'; session: string; pane?: string };
      authority: WatchAuthority;
      /** A digest of the snapshot, for diagnostics only — never a bearer token. */
      proof: string;
    }
  | { ok: false; why: string };

function refuse(why: string): WatchActorVerdict {
  return { ok: false, why };
}

/** One consistent state snapshot, read under the state's own lock. `waitMs: 0` tries once and
 *  throws `LockBusyError` at the first held lock — including a fresh lock that names no holder
 *  yet — so a hosted cycle never blocks its event loop on the lock: a state being written at
 *  this instant is a refusal to prove the watch now, not a stall. */
function stateUnderLock(dir: string): State {
  return withLock(dir, () => readState(dir), { waitMs: 0 });
}

/**
 * Judges one direct-work send against the watch records of `input.root`'s state. `process.pid`
 * is read here, never taken from the input; the verdict is recomputed for every send and is
 * never stored or accepted as a token.
 */
export function verifyWatchAuthority(input: WatchAuthorityInput): WatchActorVerdict {
  if (input.purpose !== WATCH_DIRECT_WORK) {
    return refuse('the watch actor is admitted for direct work only');
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return refuse('the clock cannot be read');
  if (!isWatchEpoch(input.epoch)) return refuse('this host holds no watch epoch');

  let loaded: ReturnType<typeof readTeamConfig>;
  try {
    loaded = readTeamConfig(realpathSync(input.root));
  } catch {
    return refuse('the team root cannot be read');
  }
  if (!loaded.ok) return refuse('the team file cannot be read');
  let file: string;
  let root: string;
  try {
    file = realpathSync(loaded.path);
    root = realpathSync(loaded.root);
  } catch {
    return refuse('the team file cannot be read');
  }
  if (input.session !== loaded.team.session) {
    return refuse('the session is not this team file\'s');
  }

  const dir = dirname(loaded.path);
  let state: State;
  try {
    state = stateUnderLock(dir);
  } catch (error) {
    if (error instanceof LockBusyError) {
      return refuse('the session state is being written; the watch is not proven now');
    }
    return refuse('the session state cannot be read; the watch is not proven now');
  }
  const recorded = state.sessions[input.session];
  const watchdog = recorded?.watchdog;
  if (!watchdog || typeof watchdog.file !== 'string' || watchdog.file === '') {
    return refuse('this session records no watch file');
  }
  let recordedFile: string;
  try {
    recordedFile = realpathSync(watchdog.file);
  } catch {
    return refuse('the recorded watch file cannot be read');
  }
  if (recordedFile !== file) return refuse('the recorded watch file is not this team file');
  if (watchdog.pane !== undefined && (typeof watchdog.pane !== 'string' || watchdog.pane === '')) {
    return refuse('the recorded watch pane is not a pane');
  }

  const watch = recorded?.watch;
  if (!watch) return refuse('this session records no watch');
  if (watch.pid !== process.pid) return refuse('the recorded watch is another process');
  if (typeof watch.epoch !== 'string' || watch.epoch === '') {
    return refuse('the recorded watch carries no epoch');
  }
  if (!isWatchEpoch(watch.epoch)) {
    return refuse('the recorded watch epoch is not an epoch');
  }
  if (watch.epoch !== input.epoch) {
    return refuse('the recorded watch is another watch\'s epoch');
  }
  if (watch.pane !== undefined) {
    if (typeof watch.pane !== 'string' || watch.pane === '') {
      return refuse('the recorded watch pane is not a pane');
    }
    if (watchdog.pane !== undefined && watch.pane !== watchdog.pane) {
      return refuse('the recorded watch pane and its file disagree');
    }
  }
  if (typeof watch.heartbeat !== 'string') {
    return refuse('the recorded watch carries no readable heartbeat');
  }
  const beat = Date.parse(watch.heartbeat);
  if (!Number.isFinite(beat)) {
    return refuse('the recorded watch carries no readable heartbeat');
  }
  const age = now.getTime() - beat;
  if (age > WATCH_AUTHORITY_MAX_AGE_MS) {
    return refuse('the recorded watch has not beaten within its liveness bound');
  }
  if (-age > WATCH_AUTHORITY_FUTURE_SKEW_MS) {
    return refuse('the recorded watch heartbeat is in the future');
  }

  const pane = watch.pane;
  const actor = pane === undefined
    ? { kind: 'watch' as const, session: input.session }
    : { kind: 'watch' as const, session: input.session, pane };
  const authority: WatchAuthority = {
    pid: watch.pid,
    epoch: watch.epoch,
    heartbeat: watch.heartbeat,
    ...(pane === undefined ? {} : { pane }),
    file,
  };
  const proof = createHash('sha256')
    .update(canonical({
      root,
      session: input.session,
      pid: watch.pid,
      epoch: watch.epoch,
      heartbeat: watch.heartbeat,
      file,
      ...(pane === undefined ? {} : { pane }),
    }))
    .digest('hex');
  return { ok: true, actor, authority, proof };
}
