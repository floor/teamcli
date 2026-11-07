// What `team daemon status --json` says about the reminder chore: one entry per configured
// reminder, read from the same schedule the daemon beats with and the same state record the tick
// writes. Nothing here decides or sends; it only answers what is next, what last came due, what
// came of the record and whether that instant was skipped.
//
// `nextAt` is an instant (ISO 8601), because the wall-clock key it stands for depends on the
// reminder's zone, which the reading does not carry; `lastDue` is the local key itself, the same
// string the record and the log lines use.
import { latestDue, nextDueAfter } from './schedule.ts';
import type { ReminderSpec } from './run.ts';
import type { ReminderRecord, RemindersStateRead } from './state.ts';

/** What came of the stored key: recorded without firing, skipped past its window, sent and
 *  settled, or reserved and still walking. */
export type ReminderResultKind = 'first-run' | 'missed' | 'sent' | 'pending';

export type ReminderLastResult = {
  kind: ReminderResultKind;
  /** The stored wall-clock key this result belongs to; it may be older than `lastDue` when the
   *  daemon was not running. */
  due: string;
  /** Recipients whose send succeeded, as the record settled them. */
  sent: number;
  /** Recipients whose send was refused or had not settled. */
  refused: number;
  /** How late the stored key came due. */
  lateMs: number | null;
  /** When the tick finished recording the key, ISO 8601; null while a send is still walking. */
  at: string | null;
};

export type ReminderReading = {
  name: string;
  /** The next scheduled instant strictly after the reading's clock, ISO 8601; null when the
   *  reminder has no resolvable times. */
  nextAt: string | null;
  /** The most recent scheduled wall-clock key at or before the reading's clock. */
  lastDue: string | null;
  /** What the record says came of its stored key; null before the first tick. */
  lastResult: ReminderLastResult | null;
  /** The stored key came due after its catch-up window had closed, so nothing was sent. */
  missed: boolean;
};

export type ReminderStatus = {
  reminders: ReminderReading[];
  /** Why the state record could not be read; the readings then carry no results. */
  unreadable: string | null;
};

/** One reading per configured reminder, in the configured order. */
export function reminderStatus(specs: readonly ReminderSpec[], state: RemindersStateRead, now: Date): ReminderStatus {
  const stored = state.kind === 'ok' ? state.state.reminders : null;
  const reminders = specs.map((spec): ReminderReading => {
    const next = nextDueAfter(spec.at, now, spec.zone);
    const latest = latestDue(spec.at, now, spec.zone);
    const entry = stored !== null && Object.hasOwn(stored, spec.name) ? stored[spec.name] : undefined;
    return {
      name: spec.name,
      nextAt: next === null ? null : new Date(next.instant).toISOString(),
      lastDue: latest === null ? null : latest.key,
      lastResult: entry === undefined ? null : resultOf(entry),
      missed: entry !== undefined && entry.firedAt === null && entry.lateMs !== null,
    };
  });
  return { reminders, unreadable: state.kind === 'unreadable' ? state.why : null };
}

function resultOf(entry: ReminderRecord): ReminderLastResult {
  const sent = entry.deliveries.filter((one) => one.ok).length;
  const kind: ReminderResultKind =
    entry.firedAt === null
      ? entry.lateMs === null
        ? 'first-run'
        : 'missed'
      : entry.finishedAt === null
        ? 'pending'
        : 'sent';
  return {
    kind,
    due: entry.key,
    sent,
    refused: entry.deliveries.length - sent,
    lateMs: entry.lateMs,
    at: entry.finishedAt,
  };
}
