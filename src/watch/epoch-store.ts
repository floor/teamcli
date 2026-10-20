// The watch authority store: one host per session, fenced by a random epoch and moved only by
// compare-and-set under the team state's lock. The record lives in `sessions[session].watch`:
// `{ pid, epoch, heartbeat }`. `pid` is always this runtime's `process.pid`, written here and
// never taken from a caller; the epoch is minted here; `heartbeat` is the host's clock.
//
// Acquire claims the record only when no standing holder can be found: another process's pid is
// provably dead, or this runtime holds a fresh fenced record it may rotate in place. A live pid
// holds whatever else the record says. A record with no pid is UNKNOWN, not proven dead: a pane
// watch record, a mid-handoff authority and one whose epoch was dropped at the read door all
// hold, and `held` reports what stands, so an unreadable holder never becomes permission for a
// silent takeover. A record the read door dropped entirely is still seen here, before the write,
// through the raw state file. A stale fenced record of this same pid is an old host that lost its
// proof: acquire refuses it too; recovery is explicit.
//
// Renew compares the captured epoch and this runtime's pid AND requires the standing record to be
// a fresh authority under the fixed window, so an expired proof cannot be resurrected. Release
// compares the same pair. Every operation reads, compares and writes under `updateState` with
// `waitMs: 0`: one attempt, never a pause on the heartbeat. A held state lock is `busy` and
// consumes nothing, to be retried on a later tick. A refused operation leaves the file as it
// stands, sanitizing read included. No sender is enabled by this module.

import { emptySession, LockBusyError, pidAlive, storedWatchRecord, updateState } from '../state.ts';
import { isWatchEpoch, mintWatchEpoch, watchEpochCurrent } from './epoch.ts';

/** The authority record a holder renews from. */
export type WatchAuthority = { pid: number; epoch: string; heartbeat: string };

/** What a refused acquire found standing: enough to report, never enough to act as it. A field
 *  absent could not be read from the standing record. */
export type WatchAuthorityHolder = { pid?: number; epoch?: string; heartbeat?: string };

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

/** Whether a record stands in the way of this process acquiring. A pid proven dead gives way.
 *  This runtime's own record gives way only while it is a fresh authority the host may rotate in
 *  place; a stale one is an old host that lost its proof and must not auto-acquire. Everything
 *  else — another live pid, a pid this store cannot read, a pid-less record with or without a
 *  readable authority — stands. */
function holderStands(
  watch: { pid?: number; epoch?: string; heartbeat: string },
  alive: (pid: number) => boolean,
  nowMs: number,
): boolean {
  if (watch.pid === process.pid) return !watchEpochCurrent(watch, nowMs);
  if (watch.pid !== undefined) {
    // A pid that is not a positive integer names no process this store can call dead, so it
    // holds rather than becoming permission to take over.
    if (!Number.isInteger(watch.pid) || watch.pid <= 0) return true;
    return alive(watch.pid);
  }
  // No pid: no process can be proven dead here. A pane record, a mid-handoff authority and one
  // whose epoch was dropped at the read door all stand until an explicit recovery moves them.
  return true;
}

/** What a raw (pre-read-door) watch record can be reported as. */
function rawHolder(stored: unknown): WatchAuthorityHolder {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const raw = stored as { pid?: unknown; epoch?: unknown; heartbeat?: unknown };
  return {
    ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
    ...(typeof raw.epoch === 'string' ? { epoch: raw.epoch } : {}),
    ...(typeof raw.heartbeat === 'string' ? { heartbeat: raw.heartbeat } : {}),
  };
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
      if (prior === undefined) {
        // The read door drops a watch record whose heartbeat is not text. Under the same lock,
        // the raw file still shows it; a dropped record is not an absent holder.
        const stored = storedWatchRecord(dir, session);
        if (stored !== undefined) return { kind: 'held', holder: rawHolder(stored) };
      }
      if (prior !== undefined && holderStands(prior, alive, options.now.getTime())) {
        return { kind: 'held', holder: { pid: prior.pid, epoch: prior.epoch, heartbeat: prior.heartbeat } };
      }
      const authority: WatchAuthority = { pid, epoch: mintWatchEpoch(), heartbeat };
      (state.sessions[session] ??= emptySession()).watch = authority;
      return { kind: 'acquired', authority, replaced: prior !== undefined };
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'acquired' });
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
      if (!isWatchEpoch(epoch) || !watch || watch.epoch !== epoch || watch.pid !== pid
        || !watchEpochCurrent(watch, options.now.getTime())) {
        return { kind: 'lost' };
      }
      watch.heartbeat = options.now.toISOString();
      return { kind: 'renewed', authority: { pid, epoch, heartbeat: watch.heartbeat } };
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'renewed' });
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
    }, { waitMs: 0, writeWhen: (result) => result.kind === 'released' });
  } catch (error) {
    if (error instanceof LockBusyError) return { kind: 'busy' };
    throw error;
  }
}
