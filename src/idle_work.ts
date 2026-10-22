// The reading `status` and `check` print about enforced idle work, and the green journal's
// ready-but-uninstalled metadata. The watch owns the snapshot: this module is the shared shape and
// the one renderer, so the producer and the two commands cannot drift. Reading is all either side
// does — a snapshot never claims, writes a lease, opens the broker or infers an install from a
// ready event, a time or a version.
import type { TeamFile } from './file/types.ts';
import type { PauseRecord, SessionState } from './state.ts';
import type { Live } from './status/compare.ts';
import type { TaskRecord } from './tasks/adapter.ts';
import type { PendingGreenSlice } from './tasks/green-slices.ts';
import type { PresenceWriterSource } from './daemon/presence/contract.ts';
import type { PresenceRead } from './watch/presence.ts';

export type { PendingGreenSlice };

/** Where a seat's presence reading came from. `terminal-host` is this reader's labelled fallback
 *  for a seat the native store cannot answer for; a native reading carries its writer source. */
export type PresenceSource = PresenceWriterSource | 'terminal-host';

/** A seat the snapshot counted as quiet: `since` is the persisted activity stamp (the claim's
 *  episode clock), or null when it was already idle when the watch started. `native_since` is the
 *  runtime's own idle instant, carried for eligibility only: it never becomes the claim stamp. */
export type IdleSeat = {
  seat: string;
  since: string | null;
  native_since?: string;
  presence_source?: PresenceSource;
};

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
  /** Present when the signed policy chain could not be read: the threshold in force is unknown,
   *  `threshold_seconds` is only the documented default, and no dispatch may act on this reading. */
  threshold_unknown?: string;
  /** Records the picker would offer right now; 0 when the queue is empty, null when unreadable. */
  takeable: number | null;
  /** Present with `takeable: null`: why the source could not be read. */
  refused?: string;
  /** Present when a seat's native presence could not be trusted (malformed record, unknown
   *  source/event, binding or fence mismatch, unapplied/stale fence, unknown channel). The
   *  dispatcher then prunes, writes and announces nothing; existing claims stay byte-identical. */
  presence_unknown?: string;
  idle: IdleSeat[];
};

/** One prefetched broker reading for a team whose source is a tracker: the records the broker
 *  answered with — the tracker's whole page; which seat may take which record stays the picker's
 *  rule — and when the reading was taken. `refused` carries the broker's own sentence, so a
 *  refused read is never an empty page. A snapshot is a photograph: it is never re-read, and its
 *  age is its `at`, not a reason to read the socket again. */
export type BrokerWorkSnapshot =
  | { kind: 'records'; at: string; records: readonly TaskRecord[] }
  | { kind: 'refused'; at: string; why: string };

/** The caller's broker reader for one pass. The watch never opens the broker's socket: a daemon
 *  that hosts the broker, or a command that owns a seat's placement, supplies the snapshot.
 *  `null` means this caller could not take one, and the reading keeps its explicit unknown. */
export type BrokerWorkSource = (input: {
  root: string;
  team: TeamFile;
  now: Date;
}) => Promise<BrokerWorkSnapshot | null>;

/** What the watch needs to take the snapshot. `home` is absent in a test that does not set one.
 *  The pause, the seats paused on their own and the queued swaps are the project's records, not
 *  one session's, so they arrive beside the session state: a paused team claims nothing, a seat
 *  paused on its own is not an idle worker and gets no wake, and a seat holding a queued swap
 *  takes no new task. */
export type IdleWorkInput = {
  root: string;
  team: TeamFile;
  state: SessionState;
  live: Live | null;
  now: Date;
  home?: string;
  pause?: PauseRecord | null;
  /** Seats paused on their own with `team pause <seat>`, keyed by name: skipped by the snapshot
   *  and by every wake path that reads it, while the rest of the team keeps working. */
  seatPauses?: Readonly<Record<string, PauseRecord>> | null;
  swaps?: readonly string[];
  /** Native presence readings prefetched for this pass, keyed by seat name. Absent means the
   *  reader does not consult the native store and keeps the terminal-host reading as it was;
   *  an explicit null means the channel is not used for this command. */
  presence?: ReadonlyMap<string, PresenceRead> | null;
  /** The caller's fresh answer for one seat's native channel this pass (daemon ownership, a
   *  binding-matched fixed health or a live RPC answer), keyed by declared seat name. Absent, or
   *  anything but exactly true for a seat, means that seat's native projection is held, never
   *  believed. */
  presenceChannelHealthy?: (seat: string) => boolean;
  /** The broker reading this pass prefetched for a tracker team, when the caller hosts one.
   *  Absent (the default for `status`, `check` and a hand-started watch) keeps the pinned
   *  no-snapshot refusal: nothing here ever opens the broker's socket or reads the credential.
   *  Ignored for a team whose source is a file. */
  broker?: BrokerWorkSnapshot | null;
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
 * An unreadable signed chain is said first: the window in force is unknown, so the default number
 * the report carries must never be printed as if it were the window, and no dispatch acts on it.
 */
export function idleWorkNotes(report: IdleWorkReport): string[] {
  const unknown: string[] = [];
  if (report.threshold_unknown !== undefined) {
    unknown.push(`the idle threshold cannot be read, so the idle reading is unknown (${report.threshold_unknown}); no dispatch acts on it`);
  }
  if (report.takeable === null) {
    const why = report.refused === undefined ? '' : ` (${report.refused})`;
    unknown.push(`the task source cannot be read, so the idle reading is unknown${why}`);
  }
  if (unknown.length > 0) return unknown;
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
  if (whole > 0 && whole % 3600 === 0) {
    const hours = whole / 3600;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  if (whole > 0 && whole % 60 === 0) {
    const minutes = whole / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
}
