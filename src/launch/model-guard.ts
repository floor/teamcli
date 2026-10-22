// The entity model rule's word on the model a launch line names, read before a launch has any
// effect: `up`, `add` and `restart` ask here, so a seat whose line names a model the rule does
// not allow on it is refused, never started. The line is read through the seat's own profile:
// the model id its flags carry, and the maker word that id proves. A line that names no model —
// a launcher that chooses one, a CLI started on its last-used model — is not one this version
// can judge: the file's declaration is the watch's report, never a refusal invented here.
import type { Seat } from '../file/types.ts';
import { readEntityModelRule, type EntityModelRule } from '../policy/entity-rule.ts';
import {
  labOfModel,
  modelRuleAllows,
  modelRuleEntryFor,
  modelRuleSentence,
  modelRuleUnknownSentence,
} from '../policy/model-rule.ts';
import { profileFor } from '../profiles/index.ts';

export { readEntityModelRule, type EntityModelRule };

/** The model one launch line names: the lab its id's maker word proves, an id whose maker this
 *  version cannot name, or no model at all. */
export type LaunchModel =
  | { kind: 'none' }
  | { kind: 'lab'; model: string; lab: string }
  | { kind: 'unknown'; model: string };

/** The model a seat's own launch line names, as its profile reads the line. */
export function launchModelOf(seat: Pick<Seat, 'cli' | 'launch'>): LaunchModel {
  const profile = profileFor(seat.cli);
  if (profile === null) return { kind: 'none' };
  const id = profile.modelIdOf(seat.launch);
  if (id === null) return { kind: 'none' };
  const lab = labOfModel(id);
  if (lab !== undefined) return { kind: 'lab', model: id, lab };
  // The id names no maker this version knows; the profile's own reading of a display word is
  // the only other word the line gives, and it is used only when it proves one.
  const named = profile.modelOf(seat.launch);
  const namedLab = named === null ? undefined : labOfModel(named.model);
  if (named === null || namedLab === undefined) return { kind: 'unknown', model: id };
  return { kind: 'lab', model: named.model, lab: namedLab };
}

/**
 * The refusal this seat's launch line earns under the rule in force, without the seat's name in
 * front; null when the line may run. A rule that cannot be read refuses a line that names a
 * model: the rule in force is unknown, so a launch is not one this run can clear. A line that
 * names no model passes — nothing on it names a lab. A rule with no entry for this seat allows
 * it, as every other site reads the rule.
 */
export function launchRefusal(
  seat: Pick<Seat, 'name' | 'role' | 'cli' | 'launch'>,
  rule: EntityModelRule,
): string | null {
  const model = launchModelOf(seat);
  if (model.kind === 'none') return null;
  if (rule.kind === 'none') return null;
  if (rule.kind === 'unreadable') {
    return `the entity model rule in force cannot be read (${rule.why}), so the model its launch line names cannot be judged`;
  }
  if (modelRuleEntryFor(rule.entries, { name: seat.name, role: seat.role }) === undefined) return null;
  if (model.kind === 'unknown') return modelRuleUnknownSentence(model.model);
  if (modelRuleAllows(rule.entries, { name: seat.name, role: seat.role, vendor: model.lab })) return null;
  return modelRuleSentence(model.model, model.lab);
}
