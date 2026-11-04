// The context-reset checkpoint (R2): the ask a boundary makes. The record names the handover
// path the old conversation is to write, and nothing else — TeamCLI writes the ask, never the
// file; the seat writes the handover, and only a file already at the path is ever used. The
// resume side is the registry's (`src/registry/resume.ts`); the restart that consumes the record
// is `src/commands/restart.ts`, through `performRestart`, so a hand restart and the watchdog's
// `team restart <seat>` read the same record.
import { handoverPath } from '../handover/paths.ts';
import { readState, updateState, type CheckpointRecord } from '../state.ts';

/** The wait a checkpoint ask gives the seat to write its handover: context reset R2's
 *  `boundary_wait` default, an interim constant until the workflow settings exist. */
export const BOUNDARY_WAIT_MS = 30 * 60_000;

/**
 * Records one checkpoint ask for `seat`, replacing the seat's previous ask. The path is minted
 * with the swap queue's own shape, so a `handovers` folder holds one layout; `by` is the caller
 * the command judged, and `deadline` is the ask's own wait. Nothing is written at the path and no
 * message is sent: the ask is the record, and the lead tells the seat. Returns the record.
 */
export function askCheckpoint(dir: string, seat: string, session: string, by: string, now: Date): CheckpointRecord {
  const record: CheckpointRecord = {
    by,
    path: handoverPath(dir, seat, now),
    session,
    at: now.toISOString(),
    deadline: new Date(now.getTime() + BOUNDARY_WAIT_MS).toISOString(),
  };
  return updateState(dir, (state) => {
    state.checkpoints = { ...(state.checkpoints ?? {}), [seat]: record };
    return record;
  });
}

/**
 * The seat's standing checkpoint ask inside `session`, or null when none does: no record, or one
 * left by another herdr session, whose path this session's restart was never asked to wait for.
 * The deadline does not gate the read — a file written late is still the seat's own handover,
 * and a missing one past the deadline is the stale case the restart reports, not a record this
 * reader hides.
 */
export function latestCheckpoint(state: { checkpoints?: Record<string, CheckpointRecord> }, seat: string, session: string): CheckpointRecord | null {
  const record = state.checkpoints?.[seat];
  if (record === undefined || record.session !== session) return null;
  return record;
}
