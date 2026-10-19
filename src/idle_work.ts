// The reading `status` and `check` print about enforced idle work, and the green journal's
// ready-but-uninstalled metadata. The watch owns the snapshot: this module is the shared shape and
// the one renderer, so the producer and the two commands cannot drift. Reading is all either side
// does — a snapshot never claims, writes a lease, touches the broker or infers an install from a
// ready event, a time or a version.
import type { TeamFile } from './file/types.ts';
import type { SessionState } from './state.ts';
import type { Live } from './status/compare.ts';
import type { PendingGreenSlice } from './tasks/green-slices.ts';

export type { PendingGreenSlice };

/** A seat the snapshot counted as quiet: `since` is the last moment it was seen working, or null
 *  when it was already idle when the watch started. */
export type IdleSeat = { seat: string; since: string | null };

/**
 * The idle-with-work snapshot. It is always a reading: the default local task queue exists even
 * when the team file names no source, so an absent queue is zero takeable records, not silence.
 * `takeable` is null only when a named source is explicitly missing or unreadable, and then
 * `refused` says why. `idle` is ordered as the watch read its seats.
 */
export type IdleWorkReport = {
  format: 1;
  /** When the snapshot was read, ISO. */
  at: string;
  /** Seconds an idle seat must have been quiet before the reading counts it. */
  threshold_seconds: number;
  /** Records the picker would offer right now; 0 when the queue is empty, null when unreadable. */
  takeable: number | null;
  /** Present with `takeable: null`: why the source could not be read. */
  refused?: string;
  idle: IdleSeat[];
};

/** What the watch needs to take the snapshot. `home` is absent in a test that does not set one. */
export type IdleWorkInput = {
  root: string;
  team: TeamFile;
  state: SessionState;
  live: Live | null;
  now: Date;
  home?: string;
};

export type IdleWorkSource = (input: IdleWorkInput) => IdleWorkReport;

/** The journal read, or the reason it could not be read. A refused read never becomes "none". */
export type PendingGreenRead =
  | { kind: 'slices'; slices: PendingGreenSlice[] }
  | { kind: 'refused'; why: string };

/** The green journal's own pending reader. A malformed journal throws; the wrapper below turns
 *  that into an explicit refusal for both commands, in the same words. */
export type PendingGreenSource = (dir: string) => PendingGreenSlice[];

/** Read the pending metadata, keeping a corrupt journal a named refusal rather than an empty
 *  list: an install is never inferred from a ready event, a time or a version. */
export function readPendingGreen(source: PendingGreenSource, dir: string): PendingGreenRead {
  try {
    return { kind: 'slices', slices: source(dir) };
  } catch (error) {
    return { kind: 'refused', why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The lines `status` and `check` print. Nothing is said unless there is something to act on: the
 * idle line appears only when seats are idle past the threshold and the queue holds takeable work.
 * A named source that cannot be read is always said, because silence there would read as no work.
 */
export function idleWorkNotes(report: IdleWorkReport): string[] {
  if (report.takeable === null) {
    const why = report.refused === undefined ? '' : ` (${report.refused})`;
    return [`the task source cannot be read, so the idle reading is unknown${why}`];
  }
  if (report.idle.length === 0 || report.takeable === 0) return [];
  const seats = report.idle.map((seat) =>
    seat.since === null ? `${seat.seat} idle since the watch started` : `${seat.seat} idle since ${seat.since}`);
  return [
    `idle with work: ${seats.length === 1 ? '1 idle seat' : `${seats.length} idle seats`} past ${duration(report.threshold_seconds)}, ${report.takeable} takeable; ${seats.join(', ')}`,
  ];
}

/** The green lines. An empty journal says nothing; a refused read says the journal cannot be read
 *  and never that no slice is ready. */
export function greenNotes(read: PendingGreenRead | null): string[] {
  if (read === null) return [];
  if (read.kind === 'refused') {
    return [`the green journal cannot be read, so ready slices are unknown (${read.why})`];
  }
  if (read.slices.length === 0) return [];
  const listed = read.slices.map((slice) => `${slice.task} since ${slice.readyAt}`).join(', ');
  const lead = read.slices.length === 1 ? 'green slice ready and not installed' : 'green slices ready and not installed';
  return [`${lead}: ${listed}`];
}

function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole > 0 && whole % 60 === 0) {
    const minutes = whole / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
}
