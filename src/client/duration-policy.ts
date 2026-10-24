// The `client-grant-max-duration` policy text, the pure half: what it says, how it is read and
// written back, and when one reading is no looser than another. Nothing here reads the world; the
// resolver that finds the value in force for an entity and a team is `grant-duration.ts`.
//
// The policy bounds how long a NEW client grant may last, per kind of grant:
//
//   send    a send / inbox / master grant (`team grant --client`)         release default 7 days
//   up      an up, down or up-and-down grant (`--up`, `--down`)            release default 90 days
//   bundle  a bundle grant (`--bundle observer|operator`)                  release default 90 days
//
// A value is a number of days (`30d`) or `none`, which allows a grant with no end date. One bare
// value (`30d`, `none`) names every kind; `send=30d;up=none` names some, and a kind the text leaves
// out keeps the release default (or, below the entity, the value in force above it).
//
// The release defaults are what the three constants were before the policy existed, so a machine
// that sets nothing behaves exactly as it did. They are defaults, not ceilings: the owner raises
// them. A cap is a bound, never a length: a request that names no end date still gets the
// shorter of the kind's default length and the cap.

/** The kinds of client grant a duration is set for. */
export const GRANT_DURATION_KINDS = ['send', 'up', 'bundle'] as const;
export type GrantDurationKind = (typeof GRANT_DURATION_KINDS)[number];

/** A cap: a whole number of days, or `null` for `none` (no end date is allowed). */
export type DurationCap = number | null;

export type DurationCaps = Record<GrantDurationKind, DurationCap>;

/** The release defaults, in days: what the hard-coded constants said before this policy. */
export const GRANT_DURATION_DEFAULT_DAYS: Readonly<Record<GrantDurationKind, number>> = { send: 7, up: 90, bundle: 90 };

/** The most days a policy may write; a longer wish is `none`. */
export const GRANT_DURATION_MAX_WRITTEN_DAYS = 3650;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The release defaults as caps. */
export function defaultDurationCaps(): DurationCaps {
  return { ...GRANT_DURATION_DEFAULT_DAYS };
}

function capWord(text: string): { ok: true; cap: DurationCap } | { ok: false } {
  const word = text.trim().toLowerCase();
  if (word === 'none') return { ok: true, cap: null };
  const match = /^([1-9][0-9]{0,3})d?$/.exec(word);
  if (match === null) return { ok: false };
  const days = Number.parseInt(match[1]!, 10);
  return days <= GRANT_DURATION_MAX_WRITTEN_DAYS ? { ok: true, cap: days } : { ok: false };
}

const SHAPE = 'client-grant-max-duration takes a number of days like 7d, 30d or 90d, or none (no end date), for every kind at once or per kind: send=30d;up=90d;bundle=none';

/**
 * Reads the policy text into the caps it names. Returns the sparse caps (a kind the text leaves out
 * is absent) or the one sentence that says what is wrong. Empty text names nothing.
 */
export function parseDurationPolicy(raw: unknown): { ok: true; caps: Partial<DurationCaps> } | { ok: false; why: string } {
  if (typeof raw === 'number') return parseDurationPolicy(String(raw));
  if (typeof raw !== 'string') return { ok: false, why: SHAPE };
  const text = raw.trim();
  if (text === '') return { ok: true, caps: {} };
  if (!text.includes('=')) {
    const cap = capWord(text);
    if (!cap.ok) return { ok: false, why: `"${text}" is not a duration: ${SHAPE}` };
    return { ok: true, caps: { send: cap.cap, up: cap.cap, bundle: cap.cap } };
  }
  const caps: Partial<DurationCaps> = {};
  for (const entry of text.split(';').map((part) => part.trim()).filter((part) => part !== '')) {
    const match = /^([a-z]+)\s*=\s*([A-Za-z0-9]+)$/.exec(entry);
    if (match === null) return { ok: false, why: `"${entry}" is not a duration entry: ${SHAPE}` };
    const kind = match[1]!;
    if (!(GRANT_DURATION_KINDS as readonly string[]).includes(kind)) return { ok: false, why: `"${kind}" is not a kind of client grant: ${GRANT_DURATION_KINDS.join(', ')}` };
    if (caps[kind as GrantDurationKind] !== undefined) return { ok: false, why: `${kind} is named twice` };
    const cap = capWord(match[2]!);
    if (!cap.ok) return { ok: false, why: `"${match[2]!}" is not a duration for ${kind}: ${SHAPE}` };
    caps[kind as GrantDurationKind] = cap.cap;
  }
  return { ok: true, caps };
}

/** The effective caps: `base` (the release defaults when absent) with what a parsed policy names laid over it. */
export function durationCapsFrom(named: Partial<DurationCaps>, base: DurationCaps = defaultDurationCaps()): DurationCaps {
  const out = { ...base };
  for (const kind of GRANT_DURATION_KINDS) {
    if (named[kind] !== undefined) out[kind] = named[kind] as DurationCap;
  }
  return out;
}

function capText(cap: DurationCap): string {
  return cap === null ? 'none' : `${String(cap)}d`;
}

/** The policy text for caps, normalized: kinds in fixed order. `all` writes every kind; otherwise only those named. */
export function formatDurationPolicy(named: Partial<DurationCaps>): string {
  return GRANT_DURATION_KINDS.filter((kind) => named[kind] !== undefined)
    .map((kind) => `${kind}=${capText(named[kind] as DurationCap)}`)
    .join(';');
}

/** The value a declaration is held as once it is merged with the value in force above it. */
export function inheritDurationPolicy(higher: string, lower: string): string {
  const high = parseDurationPolicy(higher);
  const low = parseDurationPolicy(lower);
  if (!high.ok || !low.ok) return lower;
  return formatDurationPolicy(durationCapsFrom(low.caps, durationCapsFrom(high.caps)));
}

/** Whether a cap is no looser than another: fewer days is tighter, `none` is the loosest. */
export function capWithin(lower: DurationCap, higher: DurationCap): boolean {
  if (higher === null) return true;
  return lower !== null && lower <= higher;
}

/** Whether `lower` is no looser than `higher`, kind by kind, each read over the release defaults. */
export function durationPolicyWithin(lower: string, higher: string): boolean {
  const low = parseDurationPolicy(lower);
  const high = parseDurationPolicy(higher);
  if (!low.ok || !high.ok) return false;
  const lowCaps = durationCapsFrom(low.caps);
  const highCaps = durationCapsFrom(high.caps);
  return GRANT_DURATION_KINDS.every((kind) => capWithin(lowCaps[kind], highCaps[kind]));
}

/** `7 days`, `1 day`, or `no end date`. */
export function capPhrase(cap: DurationCap): string {
  if (cap === null) return 'no end date';
  return cap === 1 ? '1 day' : `${String(cap)} days`;
}

/** The end time a signed record carries, as a number: a record with no end date never ends. */
export function endsAtMs(expires: string | null): number {
  return expires === null ? Number.POSITIVE_INFINITY : Date.parse(expires);
}

/** What a record's expiry reads as in a sentence: the date, or that it lasts until revoked. */
export function expiryPhrase(expires: string | null): string {
  return expires === null ? 'until revoked (no end date)' : `until ${expires}`;
}

/** The value a `expires:` output line carries: the date, or `never` with what it means. */
export function expiresField(expires: string | null): string {
  return expires === null ? 'never (until revoked; no end date)' : expires;
}

/** What `--expires` asked for: a date, no end date (`never`), or nothing (the default length). */
export function expiresArgument(raw: string | undefined): { expires?: string; neverExpires?: true } {
  if (raw === undefined) return {};
  return raw.trim().toLowerCase() === 'never' ? { neverExpires: true } : { expires: raw };
}
