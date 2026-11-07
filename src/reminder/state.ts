// The reminder chore's own state record (`<home>/.config/team/reminders.state.json`, mode 0600,
// written atomically in the 0700 machine folder). For every reminder name it keeps the local
// wall-clock key the reminder last satisfied, the instant that key stood for, when the send ran
// and how late, and one result per recipient. Only the daemon writes it — it hosts every
// reminder on the machine — and `team daemon status` reads it through this module.
//
// A key is reserved before the send walks and settled when it ends: a crash mid-send can lose
// that reminder's results but never sends the same instant twice. A reminder that speaks for the
// owner must not repeat itself, and a lost result stays visible as a record with no finish.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { machineConfigDir } from '../daemon/paths.ts';
import { isWallKey } from './schedule.ts';

/** One reminder's result for one recipient: the checkout it was sent from, whether it went,
 *  the message id when the send named one, and the refusal's rule or why when it did not. */
export type ReminderDelivery = {
  seat: string;
  root: string;
  ok: boolean;
  id: string | null;
  why: string | null;
  at: string;
};

/** What one reminder last satisfied and what came of it. */
export type ReminderRecord = {
  /** The local wall-clock key last satisfied, `YYYY-MM-DDTHH:MM`. */
  key: string;
  /** The instant that key stood for, kept beside the key so a clock stepped back reads as such
   *  even after a zone's rules change. */
  instant: number;
  /** When the send was reserved, ISO 8601; null when the key was recorded without a send
   *  (a first run, or an instant noticed past its window). */
  firedAt: string | null;
  /** How late the beat noticed the instant; null when nothing was sent. */
  lateMs: number | null;
  /** When every recipient's result was recorded; null while the send is still walking, and set
   *  at the same moment as the record for a key that had no send to await. */
  finishedAt: string | null;
  deliveries: ReminderDelivery[];
};

export type RemindersState = { format: 1; reminders: Record<string, ReminderRecord> };

export type RemindersStateRead =
  | { kind: 'missing' }
  /** The file exists but cannot be trusted. A caller must neither fire from it nor overwrite it:
   *  firing could repeat an instant, and overwriting would erase the diagnosis. */
  | { kind: 'unreadable'; why: string }
  | { kind: 'ok'; state: RemindersState };

/** A write's outcome; a refusal means the file was left exactly as it was. */
export type ReminderWrite = { ok: true; state: RemindersState } | { ok: false; why: string };

/** The reminder state record's path, beside the daemon's own record. */
export function remindersStatePath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'reminders.state.json');
}

/** Reads the record. A missing file is the first run; a malformed one is unreadable and says
 *  which reminder the record could not trust. */
export function readRemindersState(home: string = homedir()): RemindersStateRead {
  const path = remindersStatePath(home);
  if (!existsSync(path)) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'unreadable', why: 'the reminder state record is not readable JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', why: 'the reminder state record is not a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.format !== 1) {
    return { kind: 'unreadable', why: 'the reminder state record does not have format 1' };
  }
  const raw = record.reminders;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unreadable', why: 'the reminder state record has no reminders object' };
  }
  const reminders: Record<string, ReminderRecord> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = recordOf(value);
    if (entry === null) {
      return { kind: 'unreadable', why: `the reminder state record's "${name}" entry is malformed` };
    }
    putOwn(reminders, name, entry);
  }
  return { kind: 'ok', state: { format: 1, reminders } };
}

/** Writes the record atomically, 0600, in the 0700 machine folder. */
export function writeRemindersState(home: string, state: RemindersState): void {
  const dir = machineConfigDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = remindersStatePath(home);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Records a key a reminder satisfied — the reserve before a send walks, and the record alone for
 * a first run or an instant noticed past its window. Only a key newer than the recorded one is
 * taken, so two beats racing on one instant cannot both claim it; an unreadable record is never
 * overwritten.
 */
export function recordReminder(home: string, name: string, entry: ReminderRecord): ReminderWrite {
  const checked = recordOf(entry);
  if (checked === null) return { ok: false, why: `"${name}" would be recorded malformed` };
  const read = readRemindersState(home);
  if (read.kind === 'unreadable') return { ok: false, why: read.why };
  const state: RemindersState = read.kind === 'ok' ? read.state : { format: 1, reminders: {} };
  const prior = Object.hasOwn(state.reminders, name) ? state.reminders[name] : undefined;
  if (prior !== undefined && prior.key >= checked.key) {
    return {
      ok: false,
      why: `"${name}" already satisfied ${prior.key}, and ${checked.key} is not newer`,
    };
  }
  putOwn(state.reminders, name, checked);
  writeRemindersState(home, state);
  return { ok: true, state };
}

/**
 * Settles a reserved key with every recipient's result. The record must still hold this key:
 * a state file replaced while a send walked is reported rather than rewritten into a record that
 * never reserved it.
 */
export function settleReminder(
  home: string,
  name: string,
  entry: { key: string; deliveries: ReminderDelivery[]; finishedAt: string },
): ReminderWrite {
  const read = readRemindersState(home);
  if (read.kind === 'unreadable') return { ok: false, why: read.why };
  if (read.kind === 'missing') return { ok: false, why: 'the reminder state record is missing' };
  const prior = Object.hasOwn(read.state.reminders, name) ? read.state.reminders[name] : undefined;
  if (prior === undefined) return { ok: false, why: `the reminder state record has no "${name}"` };
  if (prior.key !== entry.key) {
    return {
      ok: false,
      why: `"${name}" holds ${prior.key}, not the settled ${entry.key}`,
    };
  }
  const settled = recordOf({ ...prior, deliveries: entry.deliveries, finishedAt: entry.finishedAt });
  if (settled === null) return { ok: false, why: `"${name}" would be settled malformed` };
  putOwn(read.state.reminders, name, settled);
  writeRemindersState(home, read.state);
  return { ok: true, state: read.state };
}

function recordOf(raw: unknown): ReminderRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.key !== 'string' || !isWallKey(entry.key)) return null;
  if (typeof entry.instant !== 'number' || !Number.isFinite(entry.instant)) return null;
  if (!(entry.firedAt === null || typeof entry.firedAt === 'string')) return null;
  if (!(entry.finishedAt === null || typeof entry.finishedAt === 'string')) return null;
  if (entry.lateMs !== null && (typeof entry.lateMs !== 'number' || !Number.isFinite(entry.lateMs) || entry.lateMs < 0)) {
    return null;
  }
  if (!Array.isArray(entry.deliveries)) return null;
  const deliveries: ReminderDelivery[] = [];
  for (const item of entry.deliveries) {
    const delivery = deliveryOf(item);
    if (delivery === null) return null;
    deliveries.push(delivery);
  }
  return {
    key: entry.key,
    instant: entry.instant,
    firedAt: entry.firedAt as string | null,
    lateMs: entry.lateMs as number | null,
    finishedAt: entry.finishedAt as string | null,
    deliveries,
  };
}

function deliveryOf(raw: unknown): ReminderDelivery | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.seat !== 'string' || entry.seat === '') return null;
  if (typeof entry.root !== 'string' || entry.root === '') return null;
  if (typeof entry.ok !== 'boolean') return null;
  if (!(entry.id === null || typeof entry.id === 'string')) return null;
  if (!(entry.why === null || typeof entry.why === 'string')) return null;
  if (typeof entry.at !== 'string' || entry.at === '') return null;
  return {
    seat: entry.seat,
    root: entry.root,
    ok: entry.ok,
    id: entry.id as string | null,
    why: entry.why as string | null,
    at: entry.at,
  };
}

/** Defines an own property even for a name like `__proto__`, which plain assignment would turn
 *  into a prototype change: a reminder name is data, never a way into the object. */
function putOwn(object: Record<string, ReminderRecord>, key: string, value: ReminderRecord): void {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}
