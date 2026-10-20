// The watch actor's epoch: the fence a host captures and a push verifier compares.
//
// One team-state record carries it: `sessions[session].watch.epoch`. The format is fixed so a
// verifier can read a record written by another process without trusting anything else in it:
// `watch_` and 32 lowercase hex digits from 128 random bits. Freshness is measured against the
// host's fixed liveness cadence, never the watch rhythm: a dormant sweep may be a day long, while
// an authority record more than 15 seconds old is not a live authority, and a stamp more than 5
// seconds in the future is not one either. Both edges are inclusive.

import { randomBytes } from 'node:crypto';

export const WATCH_EPOCH_PREFIX = 'watch_';
export const WATCH_EPOCH_HEX_LENGTH = 32;
export const WATCH_EPOCH_PATTERN = /^watch_[0-9a-f]{32}$/;

/** How old a recorded heartbeat may be and still name a live authority. Fixed: never scaled by a watch rhythm. */
export const WATCH_AUTHORITY_MAX_AGE_MS = 15_000;
/** How far in the future a recorded heartbeat may be and still count. Rejects a clock that ran ahead. */
export const WATCH_AUTHORITY_FUTURE_SKEW_MS = 5_000;

/** A fresh epoch: `watch_` and 128 random bits as 32 lowercase hex digits. */
export function mintWatchEpoch(): string {
  return `${WATCH_EPOCH_PREFIX}${randomBytes(WATCH_EPOCH_HEX_LENGTH / 2).toString('hex')}`;
}

/** Whether a value is the epoch shape this build writes and reads. Nothing else is an epoch. */
export function isWatchEpoch(value: unknown): value is string {
  return typeof value === 'string' && WATCH_EPOCH_PATTERN.test(value);
}

/** The fields a freshness reading needs; the state's watch record carries them. */
export type EpochRecord = { pid?: number; epoch?: string; heartbeat?: string };

/**
 * Whether a state watch record names a live authority at `nowMs`: a well-formed epoch and a
 * heartbeat no older than the fixed 15s window and no more than 5s in the future. The edges
 * count. This says nothing about who holds it: a verifier compares `epoch` with the host's
 * capture and `pid` with the runtime process id.
 */
export function watchEpochCurrent(watch: EpochRecord | undefined, nowMs: number): boolean {
  if (!watch || !isWatchEpoch(watch.epoch) || typeof watch.heartbeat !== 'string') return false;
  const beat = Date.parse(watch.heartbeat);
  if (!Number.isFinite(beat)) return false;
  const age = nowMs - beat;
  return age <= WATCH_AUTHORITY_MAX_AGE_MS && age >= -WATCH_AUTHORITY_FUTURE_SKEW_MS;
}
