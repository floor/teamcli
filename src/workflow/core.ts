// WF1-CORE: the deterministic statechart execution core. It selects the one transition a signal
// names, applies the records contract's acceptance order, reads named guard inputs from supplied
// evidence, checks the leaving state's success preconditions, and returns proposed records and
// effect plans. It is pure and synchronous: no filesystem, clock, environment, bus, ledger or
// dispatch. Every effect proposal carries `dispatched` only when the assembler adds it.

import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  nextActivation,
  occurrenceId,
  payloadDigest,
} from './canonical.ts';
import { DECISION_CODES } from './codes.ts';
import type { DecisionCode } from './codes.ts';
import { SIGNAL_RECORD_TYPES } from './signals.ts';
import type { RecordSelector, SignalName } from './signals.ts';
import type { OccurrenceRecord, RequestRecord, RunState } from './core-state.ts';
import type { EvidenceSource, GuardCatalogue, GuardScope, SettingSource } from './registry.ts';
import type {
  ArtifactRef,
  Capability,
  DefinitionId,
  EvidenceRecord,
  EvidenceRef,
  OccurrenceId,
  RequestId,
  Revision,
  WaitingOn,
  Workflow,
  WorkflowEffect,
  WorkflowEnvelope,
} from './types.ts';

export type CoreInput = {
  definition: Workflow;
  definitionId: DefinitionId;
  run: RunState;
  envelope: WorkflowEnvelope;
  signal: { name: SignalName; at: string };
  evidence: EvidenceSource;
  settings: SettingSource;
  guards: GuardCatalogue;
};

export type TransitionRef = { from: string; to: string; on: SignalName };

export type GuardAnswer = { name: string; answer: boolean; evidence: EvidenceRef[] };

export type EffectPlanItem = {
  kind: 'effect';
  phase: 'exit' | 'enter';
  effect: string;
  operation: string;
  role: string;
  capability?: Capability;
  actAs?: string;
  reach: 'local' | 'outside-machine';
  target: string;
  artifact: ArtifactRef;
  occurrence: OccurrenceId;
  payload: string;
  digest: `sha256:${string}`;
};

export type StateEntryPlanItem = {
  kind: 'state-entry';
  from: string;
  to: string;
  on: SignalName;
  revision: Revision;
};

export type PlanItem = EffectPlanItem | StateEntryPlanItem;

export type StepDecision = {
  kind: 'step';
  revision: Revision;
  nextRevision: Revision;
  at: string;
  signal: SignalName;
  requestId: RequestId;
  transition: TransitionRef;
  guard?: GuardAnswer;
  plan: readonly PlanItem[];
  next: { state: string; activation: number };
};

export type DuplicateDecision = {
  kind: 'duplicate';
  at: string;
  signal: SignalName;
  requestId: RequestId;
  /** The stored result the used request id already answers with: its digest and step index. */
  recorded: RequestRecord;
};

type StopFields = {
  code: DecisionCode;
  why: string;
  at: string;
  state: string;
  revision: Revision;
  waitingOn?: WaitingOn;
  signal?: SignalName;
  requestId?: RequestId;
  transition?: TransitionRef;
  evidence: EvidenceRef[];
  guard?: GuardAnswer;
};

export type HeldDecision = { kind: 'held' } & StopFields;
export type RefusedDecision = { kind: 'refused' } & StopFields;
export type CoreDecision = StepDecision | DuplicateDecision | HeldDecision | RefusedDecision;

/**
 * The one core entry point. Pure: the same input twice returns a deep-equal decision.
 * A violation of the pinned-definition/run-state contract throws rather than deciding: those
 * are programming errors or journal mismatches, never runtime facts this slice reports.
 */
export function decide(input: CoreInput): CoreDecision {
  const { definition, definitionId, run, envelope, signal } = input;
  const at = signal.at;
  const evidenceRefs = [...envelope.evidence];
  const scope: GuardScope = { target: envelope.target, artifact: envelope.artifact };

  invariant(envelope.format === 1, 'the envelope format must be 1');
  invariant(definition.version === 1, 'the parsed definition is not schema version 1');

  function held(
    code: DecisionCode,
    why: string,
    waitingOn?: WaitingOn,
    guard?: GuardAnswer,
    transition?: TransitionRef,
  ): HeldDecision {
    return {
      kind: 'held',
      code,
      why,
      at,
      state: run.state,
      revision: run.revision,
      ...(waitingOn !== undefined ? { waitingOn } : {}),
      signal: signal.name,
      requestId: envelope.requestId,
      ...(transition !== undefined ? { transition } : {}),
      evidence: evidenceRefs,
      ...(guard !== undefined ? { guard } : {}),
    };
  }

  function refused(
    code: DecisionCode,
    why: string,
    waitingOn?: WaitingOn,
    guard?: GuardAnswer,
    transition?: TransitionRef,
  ): RefusedDecision {
    return {
      kind: 'refused',
      code,
      why,
      at,
      state: run.state,
      revision: run.revision,
      ...(waitingOn !== undefined ? { waitingOn } : {}),
      signal: signal.name,
      requestId: envelope.requestId,
      ...(transition !== undefined ? { transition } : {}),
      evidence: evidenceRefs,
      ...(guard !== undefined ? { guard } : {}),
    };
  }

  // The envelope identity checks are decisions, and they come before request acceptance
  // (T3 G-IDENTITY): a foreign run or definition is refused with its frozen code, never thrown.
  if (envelope.run !== run.runId) {
    return refused(
      DECISION_CODES.runMismatch,
      `the envelope run "${envelope.run}" is not the run state's "${run.runId}"`,
    );
  }
  if (!sameDefinition(envelope.definition, run.definitionId)) {
    return refused(
      DECISION_CODES.definitionMismatch,
      `the envelope definition "${envelope.definition.workflow}/${envelope.definition.digest}" is not the run state pin "${run.definitionId.workflow}/${run.definitionId.digest}"`,
    );
  }
  if (!sameDefinition(definitionId, run.definitionId)) {
    return refused(
      DECISION_CODES.definitionMismatch,
      `the supplied definitionId "${definitionId.workflow}/${definitionId.digest}" is not the run state pin "${run.definitionId.workflow}/${run.definitionId.digest}"`,
    );
  }
  if (definition.name !== definitionId.workflow) {
    return refused(
      DECISION_CODES.definitionMismatch,
      `the parsed definition "${definition.name}" does not carry the pinned workflow name "${definitionId.workflow}"`,
    );
  }

  // Acceptance order 1 and 2: a used request id answers before the revision does.
  const requestDigest = payloadDigest(canonicalRequestPayload(envelope));
  const recordedRequest = run.requests.get(envelope.requestId);
  if (recordedRequest !== undefined) {
    if (recordedRequest.payloadDigest === requestDigest) {
      return {
        kind: 'duplicate',
        at,
        signal: signal.name,
        requestId: envelope.requestId,
        recorded: recordedRequest,
      };
    }
    return refused(
      DECISION_CODES.requestConflict,
      `request id "${envelope.requestId}" was already used with a different canonical payload`,
    );
  }

  // Acceptance order 3: a stale revision moves nothing.
  if (envelope.expectedRevision !== run.revision) {
    return refused(
      DECISION_CODES.revisionStale,
      `expected revision ${envelope.expectedRevision}, the run is at ${run.revision}`,
    );
  }

  // Acceptance order 4: dry envelopes never carry a ledger head, and the dry run records none,
  // so a present expected head cannot match — refused rather than silently ignored.
  if (envelope.expectedHead !== undefined) {
    return refused(
      DECISION_CODES.headConflict,
      'the dry run records no ledger head, so a supplied expected head does not match',
    );
  }

  // Selection. Zero or two enabled transitions are checker facts; the core treats them as
  // invariants and never reports a decision for them.
  const state = definition.states[run.state];
  invariant(state !== undefined, `state "${run.state}" is not in the pinned definition`);
  const enabled = definition.transitions.filter(
    (candidate) => candidate.from === run.state && candidate.on === signal.name,
  );
  invariant(
    enabled.length === 1,
    `the pinned definition has ${enabled.length} enabled transitions for ${run.state}/${signal.name}`,
  );
  const transition = enabled[0]!;
  const toState = definition.states[transition.to];
  invariant(
    toState !== undefined,
    `transition target "${transition.to}" is not in the pinned definition`,
  );
  invariant(
    state.uses === undefined,
    `state "${run.state}" has a uses reference; child execution belongs to the library slice`,
  );
  invariant('transition' in envelope.move, 'a transition move is required');
  const moved = envelope.move.transition;
  invariant(
    moved.from === transition.from && moved.to === transition.to && moved.on === transition.on,
    'the envelope move does not name the enabled transition',
  );
  const transitionRef: TransitionRef = {
    from: transition.from,
    to: transition.to,
    on: transition.on,
  };

  // Resolve and shape-check the cited evidence once. A cited ref the document does not supply is
  // missing evidence, not a refusal: the run waits on that exact ref (waitingOn names it) and
  // nothing moves. A record for another run's target or artifact is not a candidate (scope),
  // never a false answer.
  const resolved: Array<{ ref: EvidenceRef; record: EvidenceRecord }> = [];
  for (const ref of evidenceRefs) {
    const record = input.evidence.record(ref);
    if (record === undefined) {
      return held(
        DECISION_CODES.evidenceMissing,
        `evidence ref "${ref}" is cited but the evidence document does not supply it`,
        { kind: 'evidence', ref },
        undefined,
        transitionRef,
      );
    }
    const problem = recordProblem(record);
    if (problem === 'non-authoritative') {
      return refused(
        DECISION_CODES.evidenceNonAuthoritative,
        `evidence ref "${ref}" names a dry journal, which is never evidence`,
      );
    }
    if (problem === 'unknown') {
      return refused(
        DECISION_CODES.evidenceUnknown,
        `evidence ref "${ref}" carries result unknown, which is not a dry value`,
      );
    }
    if (problem === 'corrupt') {
      return refused(
        DECISION_CODES.evidenceCorrupt,
        `evidence ref "${ref}" does not match the shared evidence shape`,
      );
    }
    resolved.push({ ref, record });
  }

  // The signal's own record: its one selector, in scope. A refused outcome is valid evidence
  // that simply does not match a selector requiring `done`; that is the missing-evidence hold.
  const signalSelector = SIGNAL_RECORD_TYPES[signal.name];
  const signalMatches = resolved.filter(({ record }) =>
    matchesSelector(record, signalSelector, scope),
  );
  if (signalMatches.length === 0) {
    return held(
      DECISION_CODES.evidenceMissing,
      `no supplied ${selectorText(signalSelector)} record matches the ${signal.name} signal in scope`,
      undefined,
      undefined,
      transitionRef,
    );
  }
  if (signalMatches.length > 1) {
    return refused(
      DECISION_CODES.evidenceAmbiguous,
      `${signalMatches.length} supplied records match the ${signal.name} signal in scope`,
      undefined,
      undefined,
      transitionRef,
    );
  }

  // Wait status comes before the leaving state's effect preconditions and before the guard.
  const waitSpec = state.wait;
  if (waitSpec !== undefined) {
    const waitRecord = run.waits.find(
      (candidate) => candidate.state === run.state && candidate.activation === run.activation,
    );
    invariant(
      waitRecord !== undefined,
      `the run state has no wait record for ${run.state} activation ${run.activation}`,
    );
    if (waitSpec.for === 'approval') {
      if (signal.name !== 'approved') {
        return refused(
          DECISION_CODES.waitPending,
          `state "${run.state}" waits for an approval; ${signal.name} cannot fire it`,
          undefined,
          undefined,
          transitionRef,
        );
      }
    } else {
      if (signal.name !== 'time-reached') {
        return refused(
          DECISION_CODES.waitPending,
          `state "${run.state}" waits for the clock; ${signal.name} cannot fire it`,
          undefined,
          undefined,
          transitionRef,
        );
      }
      const settingName = waitSpec.at.name;
      const reachedAt = input.settings.get(settingName);
      if (reachedAt === undefined) {
        return held(
          DECISION_CODES.settingsMissing,
          `the wait setting "${settingName}" is not supplied`,
          { kind: 'setting', name: settingName },
          undefined,
          transitionRef,
        );
      }
      if (at < reachedAt) {
        return refused(
          DECISION_CODES.waitNotReached,
          `the recorded instant ${at} is before the wait's ${reachedAt}`,
          undefined,
          undefined,
          transitionRef,
        );
      }
      if (waitRecord.status === 'pending') {
        return refused(
          DECISION_CODES.waitPending,
          `the wait is still pending at ${at}`,
          undefined,
          undefined,
          transitionRef,
        );
      }
    }
  }

  // A state with entry effects is left only on their successful supplied outcomes.
  for (const hook of state.onEnter) {
    const effect = effectOf(definition, hook.name);
    const occurrence = occurrenceId(run.runId, run.activation, hook.name);
    invariant(
      run.occurrences.has(occurrence),
      `entry occurrence "${occurrence}" is missing from the run state`,
    );
    const outcome = selectOutcome(resolved, occurrence, effect.run.name, scope);
    if (outcome.length === 0) {
      return held(
        DECISION_CODES.evidenceMissing,
        `entry effect "${hook.name}" has no supplied outcome`,
        { kind: 'entry-effect', occurrence },
        undefined,
        transitionRef,
      );
    }
    if (outcome.length > 1) {
      return refused(
        DECISION_CODES.evidenceAmbiguous,
        `${outcome.length} supplied outcomes answer entry occurrence "${occurrence}"`,
        undefined,
        undefined,
        transitionRef,
      );
    }
    if (outcome[0]!.record.result === 'refused') {
      return held(
        DECISION_CODES.entryEffectFailed,
        `entry effect "${hook.name}" was refused`,
        undefined,
        undefined,
        transitionRef,
      );
    }
  }

  // An exit occurrence from an earlier attempt is never re-planned; it needs its outcome too.
  for (const hook of state.onLeave) {
    const effect = effectOf(definition, hook.name);
    const occurrence = occurrenceId(run.runId, run.activation, hook.name);
    if (!run.occurrences.has(occurrence)) continue;
    const outcome = selectOutcome(resolved, occurrence, effect.run.name, scope);
    if (outcome.length === 0) {
      return held(
        DECISION_CODES.evidenceMissing,
        `exit effect "${hook.name}" from an earlier attempt has no supplied outcome`,
        { kind: 'entry-effect', occurrence },
        undefined,
        transitionRef,
      );
    }
    if (outcome.length > 1) {
      return refused(
        DECISION_CODES.evidenceAmbiguous,
        `${outcome.length} supplied outcomes answer exit occurrence "${occurrence}"`,
        undefined,
        undefined,
        transitionRef,
      );
    }
    invariant(
      outcome[0]!.record.result !== 'refused',
      'a refused exit-effect outcome has no frozen slice-1 code (later slice)',
    );
  }

  // The transition's guard reads its one selector among the cited, in-scope records.
  let guardAnswer: GuardAnswer | undefined;
  if (transition.guard !== undefined) {
    const guard = input.guards.guard(transition.guard.name);
    if (guard === undefined) {
      return refused(
        DECISION_CODES.guardUnknown,
        `guard "${transition.guard.name}" is not in the catalogue`,
        undefined,
        undefined,
        transitionRef,
      );
    }
    const candidates = resolved.filter(({ record }) =>
      matchesSelector(record, guard.reads, scope),
    );
    if (candidates.length === 0) {
      return held(
        DECISION_CODES.evidenceMissing,
        `guard "${guard.name}" has no in-scope ${selectorText(guard.reads)} record`,
        undefined,
        undefined,
        transitionRef,
      );
    }
    if (candidates.length > 1) {
      return refused(
        DECISION_CODES.evidenceAmbiguous,
        `${candidates.length} supplied records match guard "${guard.name}" in scope`,
        undefined,
        undefined,
        transitionRef,
      );
    }
    const chosen = candidates[0]!;
    const verdict = guard.evaluate(chosen.record, scope);
    guardAnswer = { name: guard.name, answer: verdict.ok, evidence: [chosen.ref] };
    if (!verdict.ok) {
      return refused(
        DECISION_CODES.guardRefused,
        verdict.why,
        undefined,
        guardAnswer,
        transitionRef,
      );
    }
  }

  // Plan: the leaving state's hooks in declared order, the state entry, the entered state's
  // hooks in declared order. Occurrences are allocated from the one per-run entry counter.
  const next = nextActivation(run.activation);
  const plan: PlanItem[] = [];

  function planEffect(
    phase: 'exit' | 'enter',
    name: string,
    effect: WorkflowEffect,
    occurrence: OccurrenceId,
  ): { item: EffectPlanItem } | { conflict: RefusedDecision } {
    const payload = canonicalEffectPayload(
      name,
      effect.run.name,
      envelope.target,
      envelope.artifact,
    );
    const digest = payloadDigest(payload);
    const existing: OccurrenceRecord | undefined = run.occurrences.get(occurrence);
    if (existing !== undefined && existing.payloadDigest !== digest) {
      return {
        conflict: refused(
          DECISION_CODES.occurrencePayloadConflict,
          `occurrence "${occurrence}" already exists with a different payload digest`,
          undefined,
          undefined,
          transitionRef,
        ),
      };
    }
    return {
      item: {
        kind: 'effect',
        phase,
        effect: name,
        operation: effect.run.name,
        role: effect.role.name,
        ...(effect.capability !== undefined ? { capability: effect.capability } : {}),
        ...(effect.actAs !== undefined ? { actAs: effect.actAs.value } : {}),
        reach: effect.reach?.value ?? 'local',
        target: envelope.target,
        artifact: envelope.artifact,
        occurrence,
        payload,
        digest,
      },
    };
  }

  for (const hook of state.onLeave) {
    const effect = effectOf(definition, hook.name);
    const occurrence = occurrenceId(run.runId, run.activation, hook.name);
    if (run.occurrences.has(occurrence)) continue;
    const planned = planEffect('exit', hook.name, effect, occurrence);
    if ('conflict' in planned) return planned.conflict;
    plan.push(planned.item);
  }

  plan.push({
    kind: 'state-entry',
    from: transition.from,
    to: transition.to,
    on: transition.on,
    revision: run.revision + 1,
  });

  for (const hook of toState.onEnter) {
    const effect = effectOf(definition, hook.name);
    const occurrence = occurrenceId(run.runId, next, hook.name);
    const planned = planEffect('enter', hook.name, effect, occurrence);
    if ('conflict' in planned) return planned.conflict;
    plan.push(planned.item);
  }

  return {
    kind: 'step',
    revision: run.revision,
    nextRevision: run.revision + 1,
    at,
    signal: signal.name,
    requestId: envelope.requestId,
    transition: transitionRef,
    ...(guardAnswer !== undefined ? { guard: guardAnswer } : {}),
    plan,
    next: { state: transition.to, activation: next },
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`workflow core invariant: ${message}`);
}

function sameDefinition(left: DefinitionId, right: DefinitionId): boolean {
  return (
    left.workflow === right.workflow &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest
  );
}

function effectOf(definition: Workflow, name: string): WorkflowEffect {
  const effect = definition.effects[name];
  invariant(effect !== undefined, `effect "${name}" is not in the pinned definition`);
  return effect;
}

type RecordProblem = 'non-authoritative' | 'unknown' | 'corrupt' | undefined;

/** The shared dry evidence shape. `unknown` is not a dry value; a journal is not evidence. */
function recordProblem(record: EvidenceRecord): RecordProblem {
  const raw = record as Record<string, unknown>;
  if (raw.kind === 'workflow-run-dry') return 'non-authoritative';
  if (raw.result === 'unknown') return 'unknown';
  if (typeof raw.type !== 'string' || raw.type.length === 0) return 'corrupt';
  if (raw.result !== undefined && raw.result !== 'done' && raw.result !== 'refused') {
    return 'corrupt';
  }
  if (raw.target !== undefined && typeof raw.target !== 'string') return 'corrupt';
  if (raw.artifact !== undefined && !isArtifactRef(raw.artifact)) return 'corrupt';
  if (raw.type === 'outcome') {
    if (raw.result !== 'done' && raw.result !== 'refused') return 'corrupt';
    if (typeof raw.operation !== 'string' || typeof raw.effect !== 'string') return 'corrupt';
  }
  if (raw.type === 'gate' || raw.type === 'review' || raw.type === 'approval') {
    if (typeof raw.target !== 'string') return 'corrupt';
  }
  if (raw.type === 'child-completion') {
    if (raw.status !== 'completed' && raw.status !== 'held') return 'corrupt';
  }
  return undefined;
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'none') return true;
  if (raw.kind === 'ref' || raw.kind === 'tree') return typeof raw.value === 'string';
  return false;
}

/** Selector match plus scope: a record for another target/artifact is not a candidate. */
function matchesSelector(
  record: EvidenceRecord,
  selector: RecordSelector,
  scope: GuardScope,
): boolean {
  if (record.type !== selector.type) return false;
  if (selector.operation !== undefined && record.operation !== selector.operation) return false;
  if (selector.result !== undefined && record.result !== selector.result) return false;
  if (record.target !== undefined && record.target !== scope.target) return false;
  if (record.artifact !== undefined) {
    if (!isArtifactRef(record.artifact)) return false;
    if (canonicalJson(record.artifact) !== canonicalJson(scope.artifact)) return false;
  }
  return true;
}

/** The supplied outcomes answering one effect occurrence, in envelope order. */
function selectOutcome(
  resolved: Array<{ ref: EvidenceRef; record: EvidenceRecord }>,
  occurrence: OccurrenceId,
  operation: string,
  scope: GuardScope,
): Array<{ ref: EvidenceRef; record: EvidenceRecord }> {
  return resolved.filter(
    ({ record }) =>
      record.type === 'outcome' &&
      record.effect === occurrence &&
      record.operation === operation &&
      matchesSelector(record, { type: 'outcome', operation }, scope),
  );
}

function selectorText(selector: RecordSelector): string {
  const operation = selector.operation !== undefined ? `/${selector.operation}` : '';
  const result = selector.result !== undefined ? ` result=${selector.result}` : '';
  return `${selector.type}${operation}${result}`;
}
