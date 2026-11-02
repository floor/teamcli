// When a reminder is due, from its local wall-clock times and the clock the daemon beats on.
// Everything here is pure: the caller passes the instant, the zone and what the reminder last
// satisfied, and reads back one decision. The rules are the design's: only the most recent due
// instant is considered, a late instant may be caught up within half the gap to the next one
// (capped at six hours), a first run stores the latest key without firing, and a clock moved
// back more than five minutes never refires.
//
// Times are wall-clock strings in a named zone, so a repeated hour fires once (the first
// occurrence is the scheduled instant) and a skipped hour's key resolves to the first instant
// after the gap. Nothing here reads the machine's own zone implicitly: the caller names it.
const KEY_SHAPE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
const TIME_SHAPE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** How far the clock may move back before a stored instant is read as a clock change rather
 *  than the same tick arriving late. */
export const CLOCK_BACK_MS = 5 * 60_000;

/** The catch-up window's cap, whatever the cadence's own gap. */
export const CATCH_UP_CAP_MS = 6 * 60 * 60_000;

/** The daemon's beat: with catch-up off, only a tick this close to the instant fires. */
export const ON_TIME_MS = 5_000;

/** One reminder's local times: `HH:MM` strings, as the config validated them. */
export type ReminderTimes = readonly string[];

/** What a reminder last satisfied: the wall-clock key and the instant it stood for. */
export type ReminderStored = { key: string; instant: number };

export type ScheduleDecision =
  /** The stored key is at or past the latest due instant; nothing to do. */
  | { kind: 'none' }
  /** No stored key: remember the latest instant without firing; the next one fires. */
  | { kind: 'first-run'; due: ReminderStored }
  /** The clock stands before the stored instant by more than five minutes: never refire. */
  | { kind: 'clock-back'; stored: number; now: number }
  /** The latest due instant is within its window: fire for it. */
  | { kind: 'fire'; due: ReminderStored; lateMs: number; windowMs: number }
  /** The latest due instant is past its window: record it and send nothing. */
  | { kind: 'missed'; due: ReminderStored; lateMs: number; windowMs: number };

/**
 * The one decision a beat takes for a reminder. `stored` is null only before the first tick
 * after install; `catchUp` false fires only when the tick lands within one beat of the instant.
 */
export function decideDue(input: {
  at: ReminderTimes;
  now: Date;
  zone: string;
  stored: ReminderStored | null;
  catchUp?: boolean;
}): ScheduleDecision {
  const now = input.now.getTime();
  if (input.stored !== null && now < input.stored.instant - CLOCK_BACK_MS) {
    return { kind: 'clock-back', stored: input.stored.instant, now };
  }
  const latest = latestDue(input.at, input.now, input.zone);
  if (latest === null) return { kind: 'none' };
  if (input.stored !== null && input.stored.key >= latest.key) return { kind: 'none' };
  if (input.stored === null) return { kind: 'first-run', due: latest };
  const lateMs = now - latest.instant;
  const windowMs = catchUpWindow(input.at, latest, input.zone, input.catchUp ?? true);
  if (lateMs > windowMs) return { kind: 'missed', due: latest, lateMs, windowMs };
  return { kind: 'fire', due: latest, lateMs, windowMs };
}

/** The next scheduled instant strictly after `now`, for the status surface. */
export function nextDueAfter(at: ReminderTimes, now: Date, zone: string): ReminderStored | null {
  const candidates = instantsAround(at, now, zone).filter((entry) => entry.instant > now.getTime());
  candidates.sort((left, right) => left.instant - right.instant);
  return candidates[0] ?? null;
}

/** The most recent scheduled instant at or before `now`. */
export function latestDue(at: ReminderTimes, now: Date, zone: string): ReminderStored | null {
  const candidates = instantsAround(at, now, zone).filter((entry) => entry.instant <= now.getTime());
  candidates.sort((left, right) => left.instant - right.instant);
  return candidates[candidates.length - 1] ?? null;
}

/**
 * Half the gap from `due` to the next scheduled instant, capped at six hours; with catch-up off,
 * the daemon's own beat instead, so only an on-time tick fires. Exported because a retry for a
 * key already satisfied asks the same question: is its window still open?
 */
export function catchUpWindow(at: ReminderTimes, due: ReminderStored, zone: string, catchUp: boolean): number {
  if (!catchUp) return ON_TIME_MS;
  const next = nextDueAfter(at, new Date(due.instant), zone);
  if (next === null) return CATCH_UP_CAP_MS;
  return Math.min(Math.floor((next.instant - due.instant) / 2), CATCH_UP_CAP_MS);
}

/** One entry per scheduled time for yesterday, today and tomorrow's wall date in `zone`, each
 *  resolved to the instant its key stands for (the first, when a key occurs twice; the first
 *  instant after the gap, when it never occurs). */
function instantsAround(at: ReminderTimes, now: Date, zone: string): ReminderStored[] {
  const times = [...new Set(at.filter((time) => TIME_SHAPE.test(time)))].sort();
  if (times.length === 0) return [];
  const today = wallDate(now, zone);
  const entries: ReminderStored[] = [];
  for (const shift of [-1, 0, 1]) {
    const date = addDays(today, shift);
    for (const time of times) {
      const key = `${date}T${time}`;
      const instants = instantsOf(key, zone);
      if (instants.length === 0) continue;
      entries.push({ key, instant: instants[0] as number });
    }
  }
  return entries;
}

/** The wall-clock date (`YYYY-MM-DD`) of an instant in `zone`. */
export function wallDate(now: Date, zone: string): string {
  const parts = partsOf(now.getTime(), zone);
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** The wall-clock key (`YYYY-MM-DDTHH:MM`) of an instant in `zone`. */
export function wallKey(now: Date, zone: string): string {
  const parts = partsOf(now.getTime(), zone);
  return `${String(parts.year)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Whether a value has the wall-clock key's shape, `YYYY-MM-DDTHH:MM`. */
export function isWallKey(value: string): boolean {
  return KEY_SHAPE.test(value);
}

/** Every instant whose wall-clock key in `zone` is `key`, earliest first: none for a key the
 * clock skipped, two inside a repeated hour. When the key never occurs, the answer is the first
 * instant after the gap — the instant the key resolves to.
 */
export function instantsOf(key: string, zone: string): number[] {
  if (!isWallKey(key)) return [];
  const target = utcOfKey(key);
  const probes = [-12, -6, 0, 6, 12].map((hours) => target + hours * 3_600_000);
  const offsets = [...new Set(probes.map((probe) => offsetAt(probe, zone)))];
  const found = offsets
    .map((offset) => target - offset)
    .filter((instant) => wallMs(instant, zone) === target)
    .sort((left, right) => left - right);
  const unique = [...new Set(found)];
  if (unique.length > 0) return unique;
  const after = firstAfterGap(target, zone);
  return after === null ? [] : [after];
}

/** The first instant whose wall time at `zone` is at or past the skipped key: the clock jumped
 *  over it, so this is the transition instant itself. */
function firstAfterGap(target: number, zone: string): number | null {
  for (let instant = target - 3 * 3_600_000; instant <= target + 3 * 3_600_000; instant += 60_000) {
    if (wallMs(instant, zone) >= target) return instant;
  }
  return null;
}

/** The zone's UTC offset at an instant, in milliseconds east of UTC. */
function offsetAt(instant: number, zone: string): number {
  return wallMs(instant, zone) - instant;
}

/** The instant read as a UTC wall-clock value: the parts `zone` shows, treated as UTC. */
function wallMs(instant: number, zone: string): number {
  const parts = partsOf(instant, zone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const known = formatters.get(zone);
  if (known !== undefined) return known;
  const made = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(zone, made);
  return made;
}

function partsOf(instant: number, zone: string): Wall {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function utcOfKey(key: string): number {
  return Date.UTC(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
    Number(key.slice(11, 13)),
    Number(key.slice(14, 16)),
    0,
    0,
  );
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(moved.getUTCFullYear())}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
