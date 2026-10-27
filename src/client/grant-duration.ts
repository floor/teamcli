// How long a client grant may last, the half that reads the world: the `client-grant-max-duration`
// policy in force for an entity (and, when the team sits in one, its project), and the one place
// that turns a request's `--expires` into the end date a grant is signed with, or into no end date.
// The text of the policy and its ordering are in `duration-policy.ts`; the records are in
// `records.ts`; every planner (send, up/down, bundle) calls {@link chooseGrantExpiry} so the three
// kinds cannot drift apart.
//
// Two rules hold everywhere here:
//   - A policy chain that cannot be read or verified refuses the new grant. It never falls back to
//     the release default, which may be looser than the owner's word (a lowered cap).
//   - A grant with no end date is written only when the cap in force for its kind is `none`, and
//     never as a master grant or a sub-grant. Nothing here widens a grant that already exists.

import { charterLifetime } from '../charter/check.ts';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';
import { readTeams } from '../registry/teams.ts';
import {
  DAY_MS,
  GRANT_DURATION_DEFAULT_DAYS,
  capPhrase,
  durationCapsFrom,
  parseDurationPolicy,
  type DurationCap,
  type DurationCaps,
  type GrantDurationKind,
} from './duration-policy.ts';

/** The policy's name, as the owner sets it and as every refusal names it. */
export const GRANT_DURATION_POLICY = 'client-grant-max-duration';

/** The caps in force and where they come from, for a refusal that names the level. */
export type DurationInForce =
  | { ok: true; caps: DurationCaps; level: 'default' | 'entity' | 'project'; entity: string | null; projectId: string | null }
  | { ok: false; why: string };

/** The project id the registry records for a team, or null (a team no project names is its own). */
export function projectIdOfTeamId(home: string, teamId: string): string | null {
  try {
    return readTeams(home)[teamId]?.projectId ?? null;
  } catch {
    return null;
  }
}

/** The caps in force for an entity and its project: the release defaults with the policy laid over
 *  them. An unreadable or unverifiable chain, or a value that does not read, refuses. */
export function grantDurationInForce(
  home: string,
  entity: string | null,
  projectId: string | null = null,
  now: Date = new Date(),
): DurationInForce {
  let chain;
  try {
    chain = loadAndResolvePolicyChain({ home, ...(entity !== null ? { entity } : {}), projectId, teamRoot: null, team: null }, { now, upToLevel: 'project' });
  } catch {
    return { ok: false, why: `the policy chain cannot be read, so how long a client grant may last (${GRANT_DURATION_POLICY}) is unknown` };
  }
  if (!chain.ok) {
    return { ok: false, why: `the policy chain cannot be verified (${chain.refusals[0]?.message ?? 'refused'}), so how long a client grant may last (${GRANT_DURATION_POLICY}) is unknown` };
  }
  const effective = chain.policies[GRANT_DURATION_POLICY];
  const value = effective?.value;
  if (effective === undefined || typeof value !== 'string' || value === '') {
    return { ok: true, caps: durationCapsFrom({}), level: 'default', entity, projectId };
  }
  const parsed = parseDurationPolicy(value);
  if (!parsed.ok) return { ok: false, why: `the ${GRANT_DURATION_POLICY} policy does not read: ${parsed.why}` };
  const level = effective.level === 'project' ? 'project' : effective.level === 'entity' ? 'entity' : 'default';
  return { ok: true, caps: durationCapsFrom(parsed.caps), level, entity, projectId };
}

const KIND_NAME: Readonly<Record<GrantDurationKind, string>> = { send: 'a send grant', up: 'an up or down grant', bundle: 'a bundle grant' };

/** The exact command the owner runs to change the policy, for the level that governs. */
export function setCommandFor(inForce: Extract<DurationInForce, { ok: true }>, kind: GrantDurationKind, value: string): string {
  if (inForce.level === 'project' && inForce.projectId !== null) return `team policy set project ${GRANT_DURATION_POLICY} ${kind}=${value} --project ${inForce.projectId}`;
  return `team policy set entity ${GRANT_DURATION_POLICY} ${kind}=${value} --entity ${inForce.entity ?? '<entity>'}`;
}

/** Where the cap for one kind comes from, in words an owner can act on:
 *  `the policy client-grant-max-duration at entity floor allows at most 7 days for a send grant`. */
export function capSource(inForce: Extract<DurationInForce, { ok: true }>, kind: GrantDurationKind): string {
  const cap = inForce.caps[kind];
  const what = KIND_NAME[kind];
  if (inForce.level === 'default') {
    return `no ${GRANT_DURATION_POLICY} policy is set, so the release default allows ${cap === null ? 'no end date' : `at most ${capPhrase(cap)}`} for ${what}`;
  }
  const where = inForce.level === 'project' ? `project ${inForce.projectId ?? '?'}` : `entity ${inForce.entity ?? '?'}`;
  return `the policy ${GRANT_DURATION_POLICY} at ${where} allows ${cap === null ? 'no end date' : `at most ${capPhrase(cap)}`} for ${what}`;
}

/** The sentence an owner reads when a request is refused for its duration: which policy, at which
 *  level, what it allows, and the command that changes it. */
export function durationRefusal(inForce: Extract<DurationInForce, { ok: true }>, kind: GrantDurationKind, problem: string): string {
  const raise = inForce.caps[kind] === null ? '' : `; the owner can raise it with \`${setCommandFor(inForce, kind, '30d')}\`, or allow no end date with \`${setCommandFor(inForce, kind, 'none')}\``;
  return `${problem}: ${capSource(inForce, kind)}${raise}`;
}

export type ExpiryChoice = { ok: true; expires: string | null } | { ok: false; why: string };

/**
 * The end date one new grant is signed with: an ISO time, or `null` for no end date.
 *
 * - `never` (`--expires never`) is allowed only when the cap in force for the kind is `none`, and
 *   never when `allowNever` is false (master grants and sub-grants always end).
 * - An explicit `expires` must be in the future and inside the cap.
 * - Neither: the shorter of the kind's default length and the cap. Raising a cap never lengthens
 *   a grant that names no date; `none` never means "forever by default".
 *
 * `narrowDays` is a further bound the caller already holds (a bundle's own `@<days>d`); it can only
 * shorten. `defaultDays` is the kind's default length when it is not the release default.
 */
export function chooseGrantExpiry(input: {
  home: string;
  kind: GrantDurationKind;
  entity: string;
  projectId?: string | null;
  now: Date;
  expires?: string | undefined;
  never?: boolean | undefined;
  allowNever?: boolean;
  defaultDays?: number;
  narrowDays?: number | null;
  /** What the refusals call the thing: `client grant`, `up grant`… */
  noun?: string;
}): ExpiryChoice {
  const nowMs = input.now.getTime();
  const noun = input.noun ?? 'client grant';
  if (input.never === true && input.expires !== undefined) return { ok: false, why: '--expires takes a date or never, not both' };
  const inForce = grantDurationInForce(input.home, input.entity, input.projectId ?? null, input.now);
  if (!inForce.ok) return { ok: false, why: `${inForce.why}; nothing was signed` };
  const policyCap: DurationCap = inForce.caps[input.kind];
  // The cap that binds: the policy's, shortened by a bound the caller already holds.
  const narrow = input.narrowDays ?? null;
  let cap: DurationCap = policyCap === null ? narrow : narrow === null ? policyCap : Math.min(policyCap, narrow);
  const charterCap = charterLifetime(input.home, 'grant');
  if (charterCap.kind === 'invalid') return { ok: false, why: 'the owner charter does not verify; nothing was signed. The owner signs again with team setup --edit' };
  if (charterCap.kind === 'set') {
    if (charterCap.ms === null) cap = narrow;
    else cap = cap === null ? charterCap.ms / DAY_MS : Math.min(cap, charterCap.ms / DAY_MS);
  }
  if (input.never === true) {
    if (input.allowNever === false) return { ok: false, why: `a ${noun} always has an end date: --expires never is refused for it` };
    if (cap !== null) {
      if (policyCap === null) return { ok: false, why: `--expires never is refused: this ${noun} is also held to at most ${capPhrase(narrow)} by the client-bundles policy` };
      return { ok: false, why: durationRefusal(inForce, input.kind, `--expires never is refused: a ${noun} with no end date needs the policy to say none`) };
    }
    return { ok: true, expires: null };
  }
  const defaultDays = input.defaultDays ?? GRANT_DURATION_DEFAULT_DAYS[input.kind];
  if (input.expires === undefined) {
    const days = cap === null ? defaultDays : Math.min(defaultDays, cap);
    return { ok: true, expires: new Date(nowMs + days * DAY_MS).toISOString() };
  }
  const expiresMs = Date.parse(input.expires);
  if (!Number.isFinite(expiresMs)) return { ok: false, why: `"${input.expires}" is not a readable expiry timestamp (an ISO date, or never)` };
  if (expiresMs <= nowMs) return { ok: false, why: `the expiry ${input.expires} is not in the future: a ${noun} is signed with an end date in the future, or with --expires never when the policy allows it` };
  if (cap !== null && expiresMs > nowMs + cap * DAY_MS) {
    const problem = `the expiry ${input.expires} is more than ${String(cap)} days away`;
    if (policyCap !== null && (narrow === null || policyCap <= narrow)) return { ok: false, why: durationRefusal(inForce, input.kind, problem) };
    return { ok: false, why: `${problem}: a ${noun} is held to at most ${capPhrase(cap)} here by the client-bundles policy` };
  }
  return { ok: true, expires: input.expires };
}
