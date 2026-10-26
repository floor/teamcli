// The entity's model rule in force, read from its one source before anything launches (Policies
// rule 10). The rule has one level — entity — so a launch reads this record and nothing below
// it. A team that declares no entity has no rule; a source that cannot be read or verified, or
// a value that does not parse, is a refusal — never an empty rule, because an unreadable rule
// must not read every seat as in rule.
import type { TeamFile } from '../file/types.ts';
import { parseModelRule, type ModelRuleEntry } from './model-rule.ts';
import { resolvePolicy } from './resolve.ts';
import { readEntityPolicySource } from './sources.ts';
import { normalizePolicyName } from './types.ts';

export type EntityModelRule =
  /** The team declares no entity: no rule holds. */
  | { kind: 'none' }
  /** The rule in force, canonical; `entries` is empty when the entity sets none. */
  | { kind: 'rule'; rule: string; entries: readonly ModelRuleEntry[] }
  /** The rule in force cannot be read or parsed: what it allows is unknown. */
  | { kind: 'unreadable'; why: string };

/** The rule an entity's teams are judged by. The empty default is no rule at all. */
export function readEntityModelRule(home: string, team: Pick<TeamFile, 'entity'>): EntityModelRule {
  if (!team.entity) return { kind: 'none' };
  const source = readEntityPolicySource(home, team.entity);
  if (!source.ok) {
    return { kind: 'unreadable', why: `entity: policy source cannot be read or verified (${source.why})` };
  }
  // The resolver takes one policy's declarations: another name's value would be parsed by this
  // name's grammar.
  const declarations = source.policies.filter((policy) => normalizePolicyName(policy.name) === 'model-rule');
  const resolved = resolvePolicy('model-rule', declarations);
  if (!resolved.ok) {
    return { kind: 'unreadable', why: resolved.refusals.map((refusal) => refusal.message).join('; ') };
  }
  const rule = typeof resolved.effective.value === 'string' ? resolved.effective.value : '';
  return { kind: 'rule', rule, entries: parseModelRule(rule) ?? [] };
}
