// The watch authority store: one host per session, fenced by a random epoch and moved only by
// compare-and-set under the team state's lock. The record lives in `sessions[session].watch`:
// `{ pid, epoch, heartbeat }`. `pid` is always this runtime's `process.pid`, written here and
// never taken from a caller; the epoch is minted here; `heartbeat` is the host's clock.
//
// Acquire claims the record only when no standing holder can be found: another process's pid is
// provably dead, or the record names no pid and no authority this store can judge. A live pid
// holds whatever else the record says, and a record this process wrote is claimable again with a
// new epoch, so a host that restarted inside the runtime replaces its own fence rather than
// waiting itself out. A record with no pid and no well-formed epoch — a pane watch record, or one
// whose epoch was dropped at the read door — is not judged dead: it holds, and `held` reports what
// stands, so an unreadable holder never becomes permission for a silent takeover.
//
// Renew and release compare both the captured epoch and this runtime's pid, so a holder that lost
// the record can neither re-beat it nor clear the successor. Every operation reads, compares and
// writes under `updateState` with `waitMs: 0`: one attempt, never a pause on the heartbeat. A
// held state lock is `busy` and writes nothing, to be retried on a later tick. No sender is
// enabled by this module.

import { emptySession, LockBusyError, pidAlive, updateState } from '../state.ts';
import { isWatchEpoch, mintWatchEpoch, watchEpochCurrent } from './epoch.ts';

/** The authority record a holder renews from. */
export type WatchAuthority = { pid: number; epoch: string; heartbeat: string };

/** What a refused acquire found standing: enough to report, never enough to act as it. */
export type WatchAuthorityHolder = { pid?: number; epoch?: string; heartbeat: string };

/** `busy` means the state lock was held and nothing was read or written: retry on a later tick. */
export type WatchAuthorityAcquire =
  | { kind: 'acquired'; authority: WatchAuthority; replaced: boolean }
  | { kind: 'held'; holder: WatchAuthorityHolder }
  | { kind: 'busy' };

export type WatchAuthorityRenew =
  | { kind: 'renewed'; authority: WatchAuthority }
  | { kind: 'lost' }
  | { kind: 'busy' };

export type WatchAuthorityRelease = { kind: 'released' } | { kind: 'lost' } | { kind: 'busy' };

export type AcquireWatchAuthorityOptions = { now: Date; alive?: (pid: number) => boolean };
export type RenewWatchAuthorityOptions = { now: Date };

/** Whether a record stands in the way of this process acquiring: another live process, a fresh
 *  epoch mid-handoff, or a record this store cannot judge. This process's own record never stands
 *  in its way: a new epoch replaces it. Only a pid proven dead, or a stale authority record with
 *  no pid, gives way. */
function holderStands(
  watch: { pid?: number; epoch?: string; heartbeat: string },
  alive: (pid: number) => boolean,
  nowMs: number,
): boolean {
  if (watch.pid === process.pid) return false;
  if (watch.pid !== undefined) {
    // A pid that is not a positive integer names no process this store can call dead, so it
    // holds rather than becoming permission to take over.
    if (!Number.isInteger(watch.pid) || watch.pid <= 0) return true;
    return alive(watch.pid);
  }
  // No pid: a well-formed epoch is judged by the fixed authority window. A record with no epoch
  // is a pane watch record (or one whose epoch was dropped at the read door); its heartbeat runs
  // on the watch rhythm, which this store must not read as an authority clock, and taking it over
  // on the strength of an unreadable holder is what this refuses.
  if (isWatchEpoch(watch.epoch)) return watchEpochCurrent(watch, nowMs);
  return true;
}

/**
 * Claims the session's authority record for this runtime and returns the captured epoch. A
 * standing holder refuses with `held` and leaves the record as it was; a record this store cannot
 * judge also refuses, so an unreadable holder never becomes permission for a silent takeover. A
 * record whose pid is provably dead gives way. `replaced` says a record stood before this one. A
 * held state lock is `busy`.
 */
export function acquireWatchAuthority(
  dir: string,
  session: string,
  options: AcquireWatchAuthorityOptions,
): WatchAuthorityAcquire {
  const pid = process.pid;
  const alive = options.alive ?? pidAlive;
  const heartbeat = options.now.toISOString();
  try {
    return updateState(dir, (state) => {
      const prior = state.sessions[session]?.watch;
      if (prior !== undefined && holderStands(prior, alive, options.now.getTime())) {
        return { kind: 'held', holder: { pid: prior.pid, epoch: prior.epoch, heartbeat: prior.heartbeat } };
      }
      const authority: WatchAuthority = { pid, epoch: mintWatchEpoch(), heartbeat };
      (state.sessions[session] ??= emptySession()).watch = authority;
      return { kind: 'acquired', authority, replaced: prior !== undefined };
    }, { waitMs: 0 });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    throw error;
  }
}

/**
 * Renews the heartbeat on the strength of the captured epoch. The write happens only when the
 * record still carries that epoch and this runtime's pid; anything else is `lost`, so an old
 * holder cannot beat over a successor. A held state lock is `busy`, not `lost`: the record may
 * still be this holder's, so the next tick tries again.
 */
export function renewWatchAuthority(
  dir: string,
  session: string,
  epoch: string,
  options: RenewWatchAuthorityOptions,
): WatchAuthorityRenew {
  const pid = process.pid;
  try {
    return updateState(dir, (state) => {
      const watch = state.sessions[session]?.watch;
      if (!isWatchEpoch(epoch) || !watch || watch.epoch !== epoch || watch.pid !== pid) {
        return { kind: 'lost' };
      }
      watch.heartbeat = options.now.toISOString();
      return { kind: 'renewed', authority: { pid, epoch, heartbeat: watch.heartbeat } };
    }, { waitMs: 0 });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    throw error;
  }
}

/**
 * Clears the authority record only for the holder that still owns it. A stale epoch, or a record
 * a successor wrote, is `lost` and stays untouched; a held state lock is `busy` and retried.
 */
export function releaseWatchAuthority(
  dir: string,
  session: string,
  epoch: string,
): WatchAuthorityRelease {
  const pid = process.pid;
  try {
    return updateState(dir, (state) => {
      const watch = state.sessions[session]?.watch;
      if (!isWatchEpoch(epoch) || !watch || watch.epoch !== epoch || watch.pid !== pid) {
        return { kind: 'lost' };
      }
      delete state.sessions[session]!.watch;
      return { kind: 'released' };
    }, { waitMs: 0 });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    throw error;
  }
}
