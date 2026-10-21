// Whole-graph rules for a parsed definition: entry references, transition ambiguity, hooks,
// uses and the registry-backed role/guard/operation/annotation checks. Parsing and shape stay in
// schema.ts; this module never reads YAML text. Pure and deterministic: the same definition and
// resolvers give byte-identical findings, sorted by line then code. A note never fails a check.

import type { OperationDescriptor, WorkflowResolvers } from './registry.ts';
import type { Finding, Workflow, WorkflowEffect } from './types.ts';

export type CheckResult = { ok: boolean; findings: Finding[] };

type Refuse = (code: string, line: number, message: string) => void;
type Note = (code: string, line: number, message: string) => void;

function compareFindings(a: Finding, b: Finding): number {
  if (a.line !== b.line) return a.line - b.line;
  if (a.code < b.code) return -1;
  if (a.code > b.code) return 1;
  return 0;
}

export function checkWorkflow(definition: Workflow, resolvers: WorkflowResolvers): CheckResult {
  const findings: Finding[] = [];
  const refuse: Refuse = (code, line, message) => {
    findings.push({ level: 'refusal', code, line, message });
  };
  const note: Note = (code, line, message) => {
    findings.push({ level: 'note', code, line, message });
  };

  const declaredStates = new Set(Object.keys(definition.states));

  // Entry points name declared states. The parsed type keeps no line for `initial`/`error`, so
  // those two report at the definition's root line.
  if (definition.initial !== undefined && !declaredStates.has(definition.initial)) {
    refuse('graph.state', definition.line, `initial state "${definition.initial}" is not declared`);
  }
  for (const trigger of definition.on) {
    if (!declaredStates.has(trigger.state)) {
      refuse(
        'graph.state',
        trigger.line,
        `"on: ${trigger.kind}" enters "${trigger.state}", which is not declared`,
      );
    }
  }
  if (definition.error !== undefined && !declaredStates.has(definition.error)) {
    refuse('graph.error-path', definition.line, `error state "${definition.error}" is not declared`);
  }

  // Transitions: declared endpoints, at most one per (from, signal), resolved role and guard.
  const seen = new Set<string>();
  for (const transition of definition.transitions) {
    for (const endpoint of [transition.from, transition.to]) {
      if (!declaredStates.has(endpoint)) {
        refuse(
          'graph.transition',
          transition.line,
          `transition from "${transition.from}" to "${transition.to}" names undeclared state "${endpoint}"`,
        );
      }
    }
    const key = `${transition.from}\u0000${transition.on}`;
    if (seen.has(key)) {
      refuse(
        'graph.ambiguous',
        transition.line,
        `state "${transition.from}" already has a transition on "${transition.on}"`,
      );
    } else {
      seen.add(key);
    }
    if (resolvers.roles.resolve(transition.role.name) === undefined) {
      refuse('ref.role', transition.role.line, `role "${transition.role.name}" is not known`);
    }
    if (transition.guard && resolvers.guards.guard(transition.guard.name) === undefined) {
      refuse(
        'ref.guard',
        transition.guard.line,
        `guard "${transition.guard.name}" is not in the catalogue`,
      );
    }
  }

  // States: hooks resolve to declared effects, approval waits resolve their role, uses names a
  // library entry or the reserved built-in round, and a state nothing enters is a note.
  const reached = new Set<string>();
  if (definition.initial !== undefined) reached.add(definition.initial);
  if (definition.error !== undefined) reached.add(definition.error);
  for (const trigger of definition.on) reached.add(trigger.state);
  for (const transition of definition.transitions) reached.add(transition.to);

  for (const state of Object.values(definition.states)) {
    for (const hook of [...state.onEnter, ...state.onLeave]) {
      if (!Object.hasOwn(definition.effects, hook.name)) {
        refuse(
          'graph.hook',
          hook.line,
          `state "${state.name}" runs effect "${hook.name}", which is not declared`,
        );
      }
    }
    if (state.wait?.for === 'approval') {
      const role = state.wait.role;
      if (resolvers.roles.resolve(role.name) === undefined) {
        refuse('ref.role', role.line, `role "${role.name}" is not known`);
      }
    }
    if (
      state.uses &&
      state.uses.name !== 'round' &&
      !Object.hasOwn(definition.library, state.uses.name)
    ) {
      refuse(
        'graph.uses',
        state.uses.line,
        `state "${state.name}" uses "${state.uses.name}", which is neither a library entry nor the built-in round`,
      );
    }
    if (!reached.has(state.name)) {
      note(
        'graph.orphan',
        state.line,
        `state "${state.name}" is not entered by any initial, on trigger or transition`,
      );
    }
  }

  // Effects: role, the U13 capability omission, then the operation descriptor and its assertions.
  for (const effect of Object.values(definition.effects)) {
    if (resolvers.roles.resolve(effect.role.name) === undefined) {
      refuse('ref.role', effect.role.line, `role "${effect.role.name}" is not known`);
    }
    if (effect.actAs !== undefined && effect.capability === undefined) {
      note(
        'annotation.capability-pending',
        effect.actAs.line,
        `effect "${effect.name}" leaves its capability open while the Kernel names the ref-operation word`,
      );
    }
    const descriptor = resolvers.operations.descriptor(effect.run.name);
    if (!descriptor) {
      refuse(
        'ref.operation',
        effect.run.line,
        `operation "${effect.run.name}" is not in the operations registry`,
      );
      continue;
    }
    if (descriptor.provisional) {
      note(
        'ref.operation',
        effect.run.line,
        `operation "${effect.run.name}" is provisional; its descriptor is not yet a registry row`,
      );
    }
    checkAnnotations(effect, descriptor, refuse, note);
  }

  findings.sort(compareFindings);
  return { ok: !findings.some((finding) => finding.level === 'refusal'), findings };
}

/**
 * Checked assertions, never authorization: an effect's `reach` and `capability` must agree with
 * what the descriptor declares. `reach` is always declared, so its contradictions are refused
 * even against a provisional descriptor. A provisional descriptor's undeclared authority fields —
 * an empty capability list or an absent account — are notes: unresolved information, never a
 * contradiction (ruled 2026-10-21). Real descriptors get the full checks.
 */
function checkAnnotations(
  effect: WorkflowEffect,
  descriptor: OperationDescriptor,
  refuse: Refuse,
  note: Note,
): void {
  const reachesOutside = descriptor.reach === 'outside-machine';
  if (effect.reach?.value === 'outside-machine' && !reachesOutside) {
    refuse(
      'annotation.reach',
      effect.reach.line,
      `effect "${effect.name}" is labelled outside-machine, but operation "${effect.run.name}" is declared local`,
    );
  }
  if (effect.reach === undefined && reachesOutside) {
    refuse(
      'annotation.reach',
      effect.line,
      `effect "${effect.name}" requests operation "${effect.run.name}", which reaches outside the machine, but the effect is labelled local`,
    );
  }

  if (effect.capability !== undefined) {
    if (descriptor.provisional && descriptor.capabilities.length === 0) {
      note(
        'annotation.capability',
        effect.line,
        `operation "${effect.run.name}" declares no capabilities yet; capability "${effect.capability}" is unresolved`,
      );
    } else if (!descriptor.capabilities.includes(effect.capability)) {
      refuse(
        'annotation.capability',
        effect.line,
        `effect "${effect.name}" asserts capability "${effect.capability}", which operation "${effect.run.name}" does not declare`,
      );
    }
  }

  if (effect.actAs !== undefined) {
    if (descriptor.account === undefined) {
      if (descriptor.provisional) {
        note(
          'annotation.act-as',
          effect.actAs.line,
          `operation "${effect.run.name}" declares no account yet; acting as "${effect.actAs.value}" is unresolved`,
        );
      } else {
        refuse(
          'annotation.act-as',
          effect.actAs.line,
          `effect "${effect.name}" acts as "${effect.actAs.value}", but operation "${effect.run.name}" names no account`,
        );
      }
    } else if (descriptor.account !== effect.actAs.value) {
      refuse(
        'annotation.act-as',
        effect.actAs.line,
        `effect "${effect.name}" acts as "${effect.actAs.value}", but operation "${effect.run.name}" is bound to account "${descriptor.account}"`,
      );
    }
  }
}
