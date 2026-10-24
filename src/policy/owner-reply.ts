// The `owner-reply-to` policy in force for an entity: the qualified `seat@team` address an
// owner-origin message names for the seat that answers it. The policy is entity-level only.
// Entity `floor` ships a default naming its orchestrator; every other entity must declare one,
// and the reader says so rather than inventing a seat. A signed declaration replaces the
// default, and an expired one is unset at its level, as it is everywhere in the chain.
import { readTeamConfig } from '../file/team-config.ts';
import {
  OWNER_REPLY_DEFAULT,
  OWNER_REPLY_FLOOR_ENTITY,
  ownerReplyToValueProblem,
  parseOwnerReplyToValue,
} from '../settings/owner-reply.ts';
import { readEntityPolicySource } from './sources.ts';
import { normalizePolicyName, type Policy } from './types.ts';

/**
 * The owner-reply target, or the explicit reason there is none. `source` says whether a signed
 * entity declaration answered or the floor's own default did; `reason` is `missing` when no live
 * declaration and no default stand, and `invalid` when a declaration or its source cannot be read.
 */
export type OwnerReplyResolution =
  | { ok: true; entity: string; target: string; source: 'policy' | 'default' }
  | { ok: false; entity: string | null; reason: 'missing' | 'invalid'; why: string };

/**
 * Reads the owner-reply target for `entity` from the entity-level signed policy source. `root`
 * is the team root the entity is read from when the caller passes none: the team file's own
 * `entity:` names it. `now` judges an expiry and defaults to the wall clock.
 *
 * The answer is always a qualified `seat@team` target or a reason — never a guessed seat and
 * never a pane address. Entity `floor` answers `orchestrator@floor` when it declares nothing
 * live; every other entity without a live declaration is missing.
 */
export function resolveOwnerReplyTo(
  root: string,
  home: string,
  entity: string | null,
  now: Date = new Date(),
): OwnerReplyResolution {
  const asked = entity?.trim() ?? '';
  const named = asked !== '' ? asked : entityOfTeam(root, home);
  if (named === null) {
    return {
      ok: false,
      entity: null,
      reason: 'missing',
      why: 'the team names no entity, so there is no owner-reply target',
    };
  }
  const source = readEntityPolicySource(home, named);
  if (!source.ok) {
    return { ok: false, entity: named, reason: 'invalid', why: source.why };
  }
  let held = false;
  for (const policy of source.policies) {
    if (normalizePolicyName(policy.name) !== 'owner-reply-to') continue;
    // Entity sources hold only signed entries; a legacy-shaped record never answers here.
    if (!isSignedPolicy(policy)) continue;
    held = true;
    if (expiredPolicy(policy, now)) continue;
    const parsed = parseOwnerReplyToValue(policy.value);
    if (parsed === null) {
      return {
        ok: false,
        entity: named,
        reason: 'invalid',
        why:
          ownerReplyToValueProblem(policy.value)
          ?? `entity "${named}": owner-reply-to has an unreadable value`,
      };
    }
    return { ok: true, entity: named, target: parsed, source: 'policy' };
  }
  if (named === OWNER_REPLY_FLOOR_ENTITY) {
    return { ok: true, entity: named, target: OWNER_REPLY_DEFAULT, source: 'default' };
  }
  return {
    ok: false,
    entity: named,
    reason: 'missing',
    why: held
      ? `entity "${named}" declares no live owner-reply-to: its only declaration expired`
      : `entity "${named}" declares no owner-reply-to policy and has no default`,
  };
}

/** The team file's own entity, or null when the file cannot be read or names none. */
function entityOfTeam(root: string, home: string): string | null {
  try {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) return null;
    const entity = loaded.team.entity;
    return typeof entity === 'string' && entity.trim() !== '' ? entity.trim() : null;
  } catch {
    return null;
  }
}

/** A policy record that was signed, as opposed to a legacy word a source reader injects. */
function isSignedPolicy(policy: Policy): boolean {
  return policy.setter !== null || policy.signature !== undefined;
}

/** An expired declaration counts as unset at its level, as it does in the policy chain. */
function expiredPolicy(policy: Policy, now: Date): boolean {
  if (!policy.expiry) return false;
  const at = Date.parse(policy.expiry);
  return Number.isFinite(at) && at <= now.getTime();
}
