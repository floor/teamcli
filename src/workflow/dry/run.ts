// WF1-DRY: the pure dry runner. It reads a parsed definition, a dry script and an injected guard
// catalogue, calls the shared core `decide` once per scripted signal, and records the resulting
// journal. It is the only caller of `decide` in slice 1. Nothing here dispatches an effect, writes
// a file or a ledger line, reads a wall clock, bus or daemon, or verifies a supplied record.
//
// The journal is non-authoritative output: the caller prints it; the runner writes nothing. Every
// effect record carries the literal `dispatched: false` and no execution outcome.

import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  definitionId,
  occurrenceId,
  payloadDigest,
} from '../canonical.ts';
import { DECISION_CODES } from '../codes.ts';
import type { CoreDecision, HeldDecision, RefusedDecision, StepDecision } from '../core.ts';
import { decide } from '../core.ts';
import type { OccurrenceRecord, RunState } from '../core-state.ts';
import type { EvidenceSource, GuardCatalogue, SettingSource } from '../registry.ts';
import type { SignalName } from '../signals.ts';
import type {
  DefinitionId,
  DryEffectRecord,
  DryRunJournal,
  DryStop,
  EvidenceRef,
  OccurrenceId,
  Revision,
  RunId,
  Workflow,
  WorkflowEnvelope,
} from '../types.ts';
import type { DryScript } from './script.ts';
import { fireRecordedWait, waitsAfterStep, waitsAtEntry } from '../waits.ts';

/** The exact journal notice (B1 §3): the run writes no record. */
const NOTICE = 'dry run — no record is written';

/**
 * The instant recorded for a refusal that happens before any scripted signal is read. The script
 * supplies every other instant; with no signals there is none, and the epoch marks that absence.
 */
const NO_SIGNAL_AT = '1970-01-01T00:00:00Z';

export type DryRunInput = {
  /** The definition file's bytes; the digest is SHA-256 over CRLF-normalized UTF-8. */
  definitionBytes: Uint8Array;
  /** The parsed definition from the same file, with its real content pin. */
  definition: Workflow;
  script: DryScript;
  /** The guard catalogue the definition's names resolve against. */
  guards: GuardCatalogue;
};

export type DryRunResult =
  | {
      ok: true;
      journal: DryRunJournal;
      /** The folded state at the end: unchanged by a stop; wait state is not derived for a refusal. */
      run: RunState;
      /** The last decision evaluated: the stop, the last accepted step, or absent with no signals. */
      decision: CoreDecision | undefined;
      exit: 0 | 1;
    }
  | { ok: false; code: 'workflow.definition'; why: string };

/** Run a dry script over a parsed definition. Pure and synchronous; writes nothing. */
export function dryRun(input: DryRunInput): DryRunResult {
  const { definition, definitionBytes, script, guards } = input;

  const source = decodeDefinition(definitionBytes);
  if (source === undefined) {
    return fail('the definition file is not valid UTF-8');
  }
  const pin = definitionId(definition, source);

  const fault = definitionFault(definition);
  if (fault !== undefined) return fail(fault);

  const initial = definition.initial;
  if (initial === undefined) {
    return fail('the definition declares no initial state for a dry run');
  }
  const initialProblem = stateFault(definition, initial);
  if (initialProblem !== undefined) return fail(initialProblem);

  const runId = dryRunId(pin, script);
  const startEffects = entryEffects(definition, script, runId, initial, 1);
  if ('failure' in startEffects) return fail(startEffects.failure);
  const occurrences = new Map<string, OccurrenceRecord>();
  for (const record of startEffects.records) occurrences.set(record.id, record);

  const journal: DryRunJournal = {
    format: 1,
    kind: 'workflow-run-dry',
    authoritative: false,
    notice: NOTICE,
    definition: pin,
    run: runId,
    target: script.target,
    artifact: script.artifact,
    inputs: { ...script.inputs },
    settings: { ...script.settings },
    initial,
    start: { state: initial, activation: 1, effects: startEffects.effects },
    steps: [],
    outcome: { kind: 'script-exhausted' },
  };

  // A reachable `uses:` is refused before the core is reached (Zeus U8, slice 1). The message
  // names the library slice that brings nesting; the journal records the stop and no step.
  const deferred = reachableUses(definition, initial);
  if (deferred !== undefined) {
    const stop: DryStop = {
      decision: 'refused',
      code: DECISION_CODES.usesDeferred,
      why: usesDeferredWhy(deferred),
      at: script.signals[0]?.at ?? NO_SIGNAL_AT,
      state: deferred,
      revision: 0,
      evidence: [],
    };
    journal.outcome = { kind: 'stopped', ...stop };
    const refusedRun: RunState = {
      runId,
      definitionId: pin,
      state: initial,
      revision: 0,
      activation: 1,
      occurrences,
      requests: new Map(),
      waits: [],
    };
    return { ok: true, journal, run: refusedRun, decision: undefined, exit: 1 };
  }

  const evidence = evidenceSource(script);
  const settings = settingSource(script);

  let run: RunState = {
    runId,
    definitionId: pin,
    state: initial,
    revision: 0,
    activation: 1,
    occurrences,
    requests: new Map(),
    waits: waitsAtEntry(definition, initial, 1),
  };
  let last: CoreDecision | undefined;

  for (const signal of script.signals) {
    const state = definition.states[run.state];
    if (state === undefined) return fail(`state "${run.state}" is not declared by the definition`);
    const enabled = definition.transitions.filter(
      (candidate) => candidate.from === run.state && candidate.on === signal.signal,
    );
    if (enabled.length !== 1) {
      return fail(
        `the definition has ${enabled.length} transitions for ${run.state}/${signal.signal}; a dry run needs exactly one`,
      );
    }
    const transition = enabled[0]!;
    if (definition.states[transition.to] === undefined) {
      return fail(`a transition names undeclared state "${transition.to}"`);
    }

    const envelope: WorkflowEnvelope = {
      format: 1,
      run: runId,
      definition: pin,
      expectedRevision: signal.expectedRevision,
      requestId: signal.requestId,
      move: {
        transition: { from: transition.from, to: transition.to, on: transition.on },
      },
      target: script.target,
      artifact: script.artifact,
      evidence: [...signal.evidence],
    };
    const requestDigest = payloadDigest(canonicalRequestPayload(envelope));
    const decisionRun = fireRecordedWait(run, definition, {
      signal: signal.signal,
      at: signal.at,
      settings,
    });

    let decision: CoreDecision;
    try {
      decision = decide({
        definition,
        definitionId: pin,
        run: decisionRun,
        envelope,
        signal: { name: signal.signal, at: signal.at },
        evidence,
        settings,
        guards,
      });
    } catch (error) {
      return fail(
        `the core could not evaluate ${run.state}/${signal.signal}: ${errorMessage(error)}`,
      );
    }
    last = decision;

    if (decision.kind === 'held' || decision.kind === 'refused') {
      // The stop keeps the request's own precondition so replay can re-evaluate it unchanged.
      journal.outcome = { kind: 'stopped', ...stopOf(decision, signal.expectedRevision) };
      return { ok: true, journal, run: decisionRun, decision, exit: 1 };
    }
    if (decision.kind === 'duplicate') {
      // The recorded result stands; a repeated request adds no step and moves nothing.
      continue;
    }

    const effects = plannedEffects(decision, run);
    journal.steps.push({
      revision: decision.nextRevision,
      at: signal.at,
      signal: signal.signal,
      requestId: signal.requestId,
      requestDigest,
      transition: decision.transition,
      activation: decision.next.activation,
      evidence: [...signal.evidence],
      ...(decision.guard !== undefined ? { guard: decision.guard } : {}),
      effects: effects.effects,
    });

    // The step leaves this activation, so the leaving state's entry effects were released by the
    // supplied outcomes this envelope cites; the records that were journaled on entry now name
    // their refs (spec §6a.7, matrix row 46).
    attachEntryOutcomes(journal, definition, run.state, run.activation, signal.evidence, script);

    const nextOccurrences = new Map(run.occurrences);
    for (const record of effects.records) nextOccurrences.set(record.occurrence, record.occurrenceRecord);
    const requests = new Map(run.requests);
    requests.set(signal.requestId, { payloadDigest: requestDigest, step: journal.steps.length - 1 });
    run = {
      ...decisionRun,
      state: decision.next.state,
      revision: decision.nextRevision,
      activation: decision.next.activation,
      occurrences: nextOccurrences,
      requests,
      waits: waitsAfterStep(decisionRun, definition, {
        signal: signal.signal,
        nextState: decision.next.state,
        nextActivation: decision.next.activation,
      }),
    };
  }

  return { ok: true, journal, run, decision: last, exit: 0 };
}

/**
 * A run id derived from the pinned definition and the script's request structure: the same
 * definition and the same script give the same journal, occurrences and revision, with no clock
 * or random source.
 *
 * Evidence is deliberately not hashed — neither the fixtures nor the refs the signals cite. An
 * entry-effect `outcome` fixture names the occurrence id it answers, and an occurrence id contains
 * the run id, so hashing the refs would make the id change as soon as the fixture that spells it
 * is cited. The id is settled by the definition and the requests; evidence is supplied afterwards.
 */
export function dryRunId(pin: DefinitionId, script: DryScript): RunId {
  const hex = payloadDigest(
    canonicalJson({
      definition: pin,
      target: script.target,
      artifact: script.artifact,
      settings: script.settings,
      inputs: script.inputs,
      signals: script.signals.map(({ signal, at, requestId, expectedRevision }) => ({
        signal,
        at,
        requestId,
        expectedRevision,
      })),
    }),
  ).slice('sha256:'.length);
  return `run-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function decodeDefinition(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM keeps the bytes the digest is over; the parser received the same text.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The parsed definition must be internally resolvable before the core may read it. */
function definitionFault(definition: Workflow): string | undefined {
  if (definition.version !== 1) return 'the definition is not schema version 1';
  if (definition.name === '') return 'the definition has no name';
  for (const [name, state] of Object.entries(definition.states)) {
    for (const hook of [...state.onEnter, ...state.onLeave]) {
      if (definition.effects[hook.name] === undefined) {
        return `state "${name}" names undeclared effect "${hook.name}"`;
      }
    }
  }
  for (const transition of definition.transitions) {
    if (definition.states[transition.from] === undefined) {
      return `a transition names undeclared state "${transition.from}"`;
    }
    if (definition.states[transition.to] === undefined) {
      return `a transition names undeclared state "${transition.to}"`;
    }
  }
  return undefined;
}

function stateFault(definition: Workflow, name: string): string | undefined {
  return definition.states[name] === undefined ? `state "${name}" is not declared` : undefined;
}

/** The first state in breadth-first order from the initial state that names a child library. */
export function reachableUses(definition: Workflow, initial: string): string | undefined {
  const seen = new Set<string>();
  const queue = [initial];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const state = definition.states[name];
    if (state === undefined) continue;
    if (state.uses !== undefined) return name;
    for (const transition of definition.transitions) {
      if (transition.from === name) queue.push(transition.to);
    }
  }
  return undefined;
}

/** The one refusal message for a reachable `uses:` in slice 1. */
export function usesDeferredWhy(state: string): string {
  return `state "${state}" uses the child library; child execution lands with the library slice, which this dry runner refuses`;
}

type EntryEffects =
  | { records: OccurrenceRecord[]; effects: DryEffectRecord[] }
  | { failure: string };

/** The start entry: the initial state's entry hooks, at activation 1. */
function entryEffects(
  definition: Workflow,
  script: DryScript,
  runId: RunId,
  stateName: string,
  activation: number,
): EntryEffects {
  const state = definition.states[stateName];
  if (state === undefined) return { failure: `state "${stateName}" is not declared` };
  const records: OccurrenceRecord[] = [];
  const effects: DryEffectRecord[] = [];
  for (const hook of state.onEnter) {
    const effect = definition.effects[hook.name];
    if (effect === undefined) return { failure: `effect "${hook.name}" is not declared` };
    const id = occurrenceId(runId, activation, hook.name);
    const digest = payloadDigest(
      canonicalEffectPayload(hook.name, effect.run.name, script.target, script.artifact),
    );
    records.push({ id, effect: hook.name, state: stateName, activation, payloadDigest: digest });
    effects.push({
      name: hook.name,
      state: stateName,
      activation,
      occurrence: id,
      payloadDigest: digest,
      dispatched: false,
    });
  }
  return { records, effects };
}

type PlannedEffects = {
  records: Array<{ occurrence: string; occurrenceRecord: OccurrenceRecord }>;
  effects: DryEffectRecord[];
};

/** The accepted step's effect plan in order: the leaving state's hooks, then the entered state's. */
function plannedEffects(decision: StepDecision, run: RunState): PlannedEffects {
  const records: PlannedEffects['records'] = [];
  const effects: DryEffectRecord[] = [];
  for (const item of decision.plan) {
    if (item.kind !== 'effect') continue;
    const state = item.phase === 'exit' ? run.state : decision.next.state;
    const activation = item.phase === 'exit' ? run.activation : decision.next.activation;
    records.push({
      occurrence: item.occurrence,
      occurrenceRecord: {
        id: item.occurrence,
        effect: item.effect,
        state,
        activation,
        payloadDigest: item.digest,
      },
    });
    effects.push({
      name: item.effect,
      state,
      activation,
      occurrence: item.occurrence,
      payloadDigest: item.digest,
      dispatched: false,
    });
  }
  return { records, effects };
}

/**
 * Name the supplied outcome refs that released an activation's entry effects. The core accepts a
 * step leaving a state only after one matching `done` outcome per on-enter hook, so every hook
 * finds its ref among the envelope's cited evidence; a record without one keeps no outcome.
 */
function attachEntryOutcomes(
  journal: DryRunJournal,
  definition: Workflow,
  stateName: string,
  activation: number,
  refs: readonly EvidenceRef[],
  script: DryScript,
): void {
  const state = definition.states[stateName];
  if (state === undefined) return;
  for (const hook of state.onEnter) {
    const effect = definition.effects[hook.name];
    if (effect === undefined) continue;
    const occurrence = occurrenceId(journal.run, activation, hook.name);
    const ref = refs.find((candidate) =>
      answersOccurrence(candidate, occurrence, effect.run.name, script),
    );
    if (ref === undefined) continue;
    for (const record of effectRecords(journal)) {
      if (record.occurrence === occurrence && record.outcome === undefined) record.outcome = ref;
    }
  }
}

/** The core's own outcome selector, read over the script's fixtures. */
function answersOccurrence(
  ref: EvidenceRef,
  occurrence: OccurrenceId,
  operation: string,
  script: DryScript,
): boolean {
  const record = script.evidence[ref];
  if (record === undefined || record.type !== 'outcome') return false;
  if (record.effect !== occurrence || record.operation !== operation) return false;
  if (record.target !== undefined && record.target !== script.target) return false;
  if (
    record.artifact !== undefined &&
    canonicalJson(record.artifact) !== canonicalJson(script.artifact)
  ) {
    return false;
  }
  return true;
}

function effectRecords(journal: DryRunJournal): DryEffectRecord[] {
  return [...journal.start.effects, ...journal.steps.flatMap((step) => step.effects)];
}

function stopOf(decision: HeldDecision | RefusedDecision, expectedRevision: Revision): DryStop {
  return {
    decision: decision.kind,
    code: decision.code,
    why: decision.why,
    at: decision.at,
    state: decision.state,
    revision: decision.revision,
    ...(decision.waitingOn !== undefined ? { waitingOn: decision.waitingOn } : {}),
    ...(decision.signal !== undefined ? { signal: decision.signal } : {}),
    ...(decision.requestId !== undefined ? { requestId: decision.requestId } : {}),
    // A request-derived stop records the request's own precondition; a request-less stop has none.
    ...(decision.signal !== undefined && decision.requestId !== undefined ? { expectedRevision } : {}),
    evidence: [...decision.evidence],
    ...(decision.guard !== undefined ? { guard: decision.guard } : {}),
  };
}

function evidenceSource(script: DryScript): EvidenceSource {
  return {
    record(ref: EvidenceRef) {
      return Object.prototype.hasOwnProperty.call(script.evidence, ref)
        ? script.evidence[ref]
        : undefined;
    },
  };
}

function settingSource(script: DryScript): SettingSource {
  return {
    get(name: string) {
      return Object.prototype.hasOwnProperty.call(script.settings, name)
        ? script.settings[name]
        : undefined;
    },
  };
}

function fail(why: string): DryRunResult {
  return { ok: false, code: 'workflow.definition', why };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
