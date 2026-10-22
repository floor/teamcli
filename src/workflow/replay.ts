// WF1-REPLAY: the dry journal reader and the pure replay fold. Replay reconstructs the run from
// the pinned definition, the recorded journal and the standalone evidence document, then calls
// the same core `decide` the dry runner called and compares every decision to the recording.
// It reads no clock, bus, ledger or dispatcher, appends nothing and dispatches nothing.
//
// Mismatch positions are a total order of comparison points: -1 is the start entry, 0..n-1 are
// `journal.steps` indices, and `journal.steps.length` is the terminal stop.
//
// Input precedence is the exit contract's: a malformed journal is `workflow.journal`, a wrong or
// invalid definition is `workflow.definition`, a missing cited evidence ref is `workflow.evidence`;
// only then is the fold compared, and the first divergence is `workflow.replay-mismatch`.

import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  definitionId,
  nextActivation,
  occurrenceId,
  payloadDigest,
} from './canonical.ts';
import type { CoreDecision, CoreInput, StepDecision } from './core.ts';
import type { OccurrenceRecord, RunState } from './core-state.ts';
import type { EvidenceSource, GuardCatalogue, SettingSource } from './registry.ts';
import { isSignalName } from './signals.ts';
import type { SignalName } from './signals.ts';
import { fireRecordedWait, waitsAfterStep, waitsAtEntry } from './waits.ts';
import type {
  DryEffectRecord,
  DryRunJournal,
  EvidenceDocument,
  EvidenceRecord,
  EvidenceRef,
  OccurrenceId,
  Workflow,
  WorkflowEnvelope,
} from './types.ts';

/** The exact journal notice (B1 §3): the run writes no record. */
const NOTICE = 'dry run — no record is written';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

const JOURNAL_KEYS = [
  'format',
  'kind',
  'authoritative',
  'notice',
  'definition',
  'run',
  'target',
  'artifact',
  'inputs',
  'settings',
  'initial',
  'start',
  'steps',
  'outcome',
] as const;

type JsonObject = Record<string, unknown>;

export type JournalReadResult =
  | { ok: true; journal: DryRunJournal }
  | { ok: false; code: 'workflow.journal'; why: string };

/**
 * Read a dry journal from its JSON text. The reader checks shape, closed keys and the
 * non-authoritative markers only; identities, revisions and decisions are the fold's to compare.
 */
export function readJournal(text: string): JournalReadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: 'workflow.journal', why: `the journal is not valid JSON: ${errorMessage(error)}` };
  }
  const problem = journalProblem(value);
  if (problem !== undefined) return { ok: false, code: 'workflow.journal', why: problem };
  return { ok: true, journal: value as DryRunJournal };
}

export type ReplayFailureCode =
  | 'workflow.journal'
  | 'workflow.definition'
  | 'workflow.evidence'
  | 'workflow.replay-mismatch'
  | 'workflow.uses-deferred';

export type ReplayFailure = {
  code: ReplayFailureCode;
  /** -1 start, 0..n-1 journal steps, n the terminal stop; absent when no fold ran. */
  step?: number;
  expected?: unknown;
  actual?: unknown;
  why: string;
};

export type ReplayInput = {
  /** The definition file's bytes; the digest is SHA-256 over CRLF-normalized UTF-8. */
  definitionBytes: Uint8Array;
  /** The parsed definition from the same file. */
  definition: Workflow;
  journal: DryRunJournal;
  evidence: EvidenceDocument;
  /** The guard catalogue the runner used; guards read supplied evidence only. */
  guards: GuardCatalogue;
  /** B5's pure core, injected: replay never imports its runtime. */
  decide: (input: CoreInput) => CoreDecision;
};

export type ReplayResult = { ok: true; run: RunState } | { ok: false; fail: ReplayFailure };

/** Re-evaluate the recorded journal against the pinned definition and the supplied evidence. */
export function replay(input: ReplayInput): ReplayResult {
  const { definition, journal, evidence, guards, decide } = input;

  const source = decodeDefinition(input.definitionBytes);
  if (source === undefined) {
    return failure('workflow.definition', 'the definition file is not valid UTF-8');
  }

  const pinProblem = pinMismatch(definition, journal, source);
  if (pinProblem !== undefined) return failure('workflow.definition', pinProblem);

  const definitionProblem = definitionFault(definition);
  if (definitionProblem !== undefined) return failure('workflow.definition', definitionProblem);

  const initial = definition.states[journal.initial];
  if (initial === undefined) {
    return failure(
      'workflow.journal',
      `the journal starts in "${journal.initial}", which the pinned definition does not declare`,
    );
  }
  if (initial.uses !== undefined) {
    return failure(
      'workflow.uses-deferred',
      `state "${journal.initial}" uses the child library, which this slice refuses`,
    );
  }

  const evidenceProblem = evidenceFault(evidence, journal);
  if (evidenceProblem !== undefined) return failure('workflow.evidence', evidenceProblem);

  const evidenceSource: EvidenceSource = {
    record(ref) {
      if (!hasOwn(evidence, ref)) return undefined;
      const record = evidence[ref];
      return isObject(record) ? (record as EvidenceRecord) : undefined;
    },
  };
  const settingsSource: SettingSource = {
    get(name) {
      return hasOwn(journal.settings, name) ? journal.settings[name] : undefined;
    },
  };

  // The start entry: activation 1, the initial state's entry hooks.
  const startOccurrences = entryOccurrences(definition, journal, journal.initial, 1);
  const startDiff = effectsDiffer(startOccurrences, journal.start.effects);
  if (startDiff !== undefined) {
    return mismatch(-1, `the start entry does not match the pinned definition: ${startDiff.why}`, startDiff.expected, startDiff.actual);
  }

  const occurrences = new Map<OccurrenceId, OccurrenceRecord>();
  for (const record of startOccurrences) occurrences.set(record.id, record);

  let run: RunState = {
    runId: journal.run,
    definitionId: journal.definition,
    state: journal.initial,
    revision: 0,
    activation: 1,
    occurrences,
    requests: new Map(),
    waits: waitsAtEntry(definition, journal.initial, 1),
  };

  for (let index = 0; index < journal.steps.length; index += 1) {
    const step = journal.steps[index]!;

    const expectedRevision = run.revision + 1;
    if (step.revision !== expectedRevision) {
      return mismatch(
        index,
        `step ${index} records revision ${step.revision}; the fold is at revision ${run.revision}`,
        { revision: expectedRevision },
        { revision: step.revision },
      );
    }

    const state = definition.states[run.state];
    if (state === undefined) {
      return failure('workflow.journal', `the folded state "${run.state}" is not declared by the pinned definition`);
    }
    if (state.uses !== undefined) {
      return failure(
        'workflow.uses-deferred',
        `state "${run.state}" uses the child library, which this slice refuses`,
      );
    }

    const enabled = definition.transitions.filter(
      (candidate) => candidate.from === run.state && candidate.on === step.signal,
    );
    if (enabled.length !== 1) {
      return mismatch(
        index,
        `the pinned definition has ${enabled.length} transitions for ${run.state}/${step.signal}`,
        enabled.length === 1 ? transitionOf(enabled[0]!) : { count: 1 },
        { transition: step.transition, enabled: enabled.length },
      );
    }
    const transition = transitionOf(enabled[0]!);
    if (canonicalJson(transition) !== canonicalJson(step.transition)) {
      return mismatch(
        index,
        `step ${index} records a transition the pinned definition does not enable for ${run.state}/${step.signal}`,
        transition,
        step.transition,
      );
    }

    const expectedActivation = nextActivation(run.activation);
    if (step.activation !== expectedActivation) {
      return mismatch(
        index,
        `step ${index} records activation ${step.activation}; the run counter's next value is ${expectedActivation}`,
        { activation: expectedActivation },
        { activation: step.activation },
      );
    }

    const envelope: WorkflowEnvelope = {
      format: 1,
      run: journal.run,
      definition: journal.definition,
      expectedRevision: run.revision,
      requestId: step.requestId,
      move: { transition },
      target: journal.target,
      artifact: journal.artifact,
      evidence: step.evidence,
    };
    const requestDigest = payloadDigest(canonicalRequestPayload(envelope));
    if (step.requestDigest !== requestDigest) {
      return mismatch(
        index,
        `step ${index} records request digest ${step.requestDigest}; the reconstructed envelope hashes to ${requestDigest}`,
        { requestDigest },
        { requestDigest: step.requestDigest },
      );
    }

    // A recorded time wait is fired at its setting; the core owns every other wait verdict.
    const decisionRun = fireRecordedWait(run, definition, {
      signal: step.signal,
      at: step.at,
      settings: settingsSource,
    });
    let decision: CoreDecision;
    try {
      decision = decide({
        definition,
        definitionId: journal.definition,
        run: decisionRun,
        envelope,
        signal: { name: step.signal, at: step.at },
        evidence: evidenceSource,
        settings: settingsSource,
        guards,
      });
    } catch (error) {
      return mismatch(
        index,
        `the core could not re-evaluate step ${index}: ${errorMessage(error)}`,
        { decision: 'step' },
        { threw: errorMessage(error) },
      );
    }

    if (decision.kind !== 'step') {
      return mismatch(
        index,
        `step ${index} is recorded, but the re-evaluated decision is ${decision.kind}`,
        { decision: 'step' },
        decisionView(decision),
      );
    }

    const recordedGuard = step.guard ?? null;
    const derivedGuard = decision.guard ?? null;
    if (canonicalJson(recordedGuard) !== canonicalJson(derivedGuard)) {
      return mismatch(
        index,
        `step ${index} records guard ${describe(recordedGuard)}; the core answers ${describe(derivedGuard)}`,
        { guard: recordedGuard },
        { guard: derivedGuard },
      );
    }

    const planned = planOccurrences(decision, run);
    const effectDiff = effectsDiffer(planned, step.effects);
    if (effectDiff !== undefined) {
      return mismatch(index, `step ${index}: ${effectDiff.why}`, effectDiff.expected, effectDiff.actual);
    }

    const nextOccurrences = new Map(run.occurrences);
    for (const record of planned) nextOccurrences.set(record.id, record);
    const requests = new Map(run.requests);
    requests.set(step.requestId, { payloadDigest: requestDigest, step: index });
    run = {
      ...run,
      state: decision.next.state,
      revision: decision.nextRevision,
      activation: decision.next.activation,
      occurrences: nextOccurrences,
      requests,
      waits: waitsAfterStep(decisionRun, definition, {
        signal: step.signal,
        nextState: decision.next.state,
        nextActivation: decision.next.activation,
      }),
    };
  }

  if (journal.outcome.kind === 'script-exhausted') {
    const finalState = definition.states[run.state];
    if (finalState?.uses !== undefined) {
      return failure(
        'workflow.uses-deferred',
        `state "${run.state}" uses the child library, which this slice refuses`,
      );
    }
    return { ok: true, run };
  }

  const stop = journal.outcome;
  const stopIndex = journal.steps.length;

  if (stop.state !== run.state) {
    return failure(
      'workflow.journal',
      `the stopped outcome names state "${stop.state}"; the fold is in "${run.state}"`,
    );
  }
  if (stop.revision !== run.revision) {
    return failure(
      'workflow.journal',
      `the stopped outcome names revision ${stop.revision}; the fold is at revision ${run.revision}`,
    );
  }
  if (stop.signal === undefined) {
    return failure('workflow.journal', 'the stopped outcome records no signal; replay re-evaluates signal decisions');
  }
  if (stop.requestId === undefined) {
    return failure('workflow.journal', 'the stopped outcome records no request id');
  }
  if (stop.expectedRevision === undefined) {
    // Fail closed: an older request-derived stop without its precondition is not rebuilt under the
    // folded revision, which would accept the request the producer refused.
    return failure('workflow.journal', 'the stopped outcome records no expected revision');
  }

  const stopState = definition.states[run.state];
  if (stopState === undefined) {
    return failure('workflow.journal', `the folded state "${run.state}" is not declared by the pinned definition`);
  }
  if (stopState.uses !== undefined) {
    return failure(
      'workflow.uses-deferred',
      `state "${run.state}" uses the child library, which this slice refuses`,
    );
  }

  const stopEnabled = definition.transitions.filter(
    (candidate) => candidate.from === run.state && candidate.on === stop.signal,
  );
  if (stopEnabled.length !== 1) {
    return mismatch(
      stopIndex,
      `the stopped outcome names ${run.state}/${stop.signal}, for which the pinned definition has ${stopEnabled.length} transitions`,
      stopEnabled.length === 1 ? transitionOf(stopEnabled[0]!) : { count: 1 },
      { enabled: stopEnabled.length },
    );
  }
  const stopTransition = transitionOf(stopEnabled[0]!);
  // Re-evaluate the stopped request unchanged, under the precondition the producer recorded.
  const stopEnvelope: WorkflowEnvelope = {
    format: 1,
    run: journal.run,
    definition: journal.definition,
    expectedRevision: stop.expectedRevision,
    requestId: stop.requestId,
    move: { transition: stopTransition },
    target: journal.target,
    artifact: journal.artifact,
    evidence: stop.evidence,
  };
  const stopRun = fireRecordedWait(run, definition, {
    signal: stop.signal,
    at: stop.at,
    settings: settingsSource,
  });

  let stopDecision: CoreDecision;
  try {
    stopDecision = decide({
      definition,
      definitionId: journal.definition,
      run: stopRun,
      envelope: stopEnvelope,
      signal: { name: stop.signal, at: stop.at },
      evidence: evidenceSource,
      settings: settingsSource,
      guards,
    });
  } catch (error) {
    return mismatch(
      stopIndex,
      `the core could not re-evaluate the stop: ${errorMessage(error)}`,
      { decision: stop.decision },
      { threw: errorMessage(error) },
    );
  }

  if (stopDecision.kind === 'step' || stopDecision.kind === 'duplicate') {
    return mismatch(
      stopIndex,
      `the stopped outcome re-evaluates to ${stopDecision.kind}, not a stop`,
      { decision: stop.decision, code: stop.code },
      decisionView(stopDecision),
    );
  }

  const recordedStop = {
    decision: stop.decision,
    code: stop.code,
    state: stop.state,
    revision: stop.revision,
    waitingOn: stop.waitingOn ?? null,
    signal: stop.signal,
    requestId: stop.requestId,
    guard: stop.guard ?? null,
  };
  const derivedStop = {
    decision: stopDecision.kind,
    code: stopDecision.code,
    state: stopDecision.state,
    revision: stopDecision.revision,
    waitingOn: stopDecision.waitingOn ?? null,
    signal: stopDecision.signal ?? null,
    requestId: stopDecision.requestId ?? null,
    guard: stopDecision.guard ?? null,
  };
  if (canonicalJson(recordedStop) !== canonicalJson(derivedStop)) {
    return mismatch(
      stopIndex,
      'the stopped outcome does not re-evaluate identically',
      recordedStop,
      derivedStop,
    );
  }

  return {
    ok: true,
    run: {
      ...stopRun,
      blocked: {
        decision: stopDecision.kind,
        code: stopDecision.code,
        state: run.state,
        revision: run.revision,
        ...(stopDecision.waitingOn !== undefined ? { waitingOn: stopDecision.waitingOn } : {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The journal reader's shape checks. Closed key sets and JSON types only; no identity is compared.

function journalProblem(value: unknown): string | undefined {
  const record = asObject(value);
  if (record === undefined) return 'the journal must be a JSON object';

  const keys = keysProblem(record, 'the journal', JOURNAL_KEYS);
  if (keys !== undefined) return keys;

  if (record.format !== 1) return 'the journal format must be 1';
  if (record.kind !== 'workflow-run-dry') return 'the journal kind must be "workflow-run-dry"';
  if (record.authoritative !== false) return 'the journal must be non-authoritative';
  if (record.notice !== NOTICE) return `the journal notice must be exactly "${NOTICE}"`;

  const identity =
    definitionIdProblem(record.definition, 'definition') ??
    nonEmptyStringProblem(record.run, 'run') ??
    nonEmptyStringProblem(record.target, 'target') ??
    artifactProblem(record.artifact, 'artifact') ??
    stringMapProblem(record.inputs, 'inputs') ??
    stringMapProblem(record.settings, 'settings') ??
    nonEmptyStringProblem(record.initial, 'initial');
  if (identity !== undefined) return identity;

  const start = asObject(record.start);
  if (start === undefined) return 'start must be an object';
  const startKeys = keysProblem(start, 'start', ['state', 'activation', 'effects']);
  if (startKeys !== undefined) return startKeys;
  if (start.state !== record.initial) return 'start.state must equal initial';
  if (start.activation !== 1) return 'start.activation must be 1';
  const startProblem =
    nonEmptyStringProblem(start.state, 'start.state') ?? effectsProblem(start.effects, 'start.effects');
  if (startProblem !== undefined) return startProblem;

  if (!Array.isArray(record.steps)) return 'steps must be an array';
  for (let index = 0; index < record.steps.length; index += 1) {
    const problem = stepProblem(record.steps[index], `steps[${index}]`);
    if (problem !== undefined) return problem;
  }

  const outcome = asObject(record.outcome);
  if (outcome === undefined) return 'outcome must be an object';
  if (outcome.kind === 'script-exhausted') return keysProblem(outcome, 'outcome', ['kind']);
  if (outcome.kind === 'stopped') {
    return (
      keysProblem(outcome, 'outcome', ['kind', 'decision', 'code', 'why', 'at', 'state', 'revision', 'evidence'], [
        'waitingOn',
        'signal',
        'requestId',
        'expectedRevision',
        'guard',
      ]) ?? stopProblem(outcome, 'outcome')
    );
  }
  return 'outcome.kind must be "script-exhausted" or "stopped"';
}

function definitionIdProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  const keys = keysProblem(record, where, ['workflow', 'schemaVersion', 'digest']);
  if (keys !== undefined) return keys;
  return (
    nonEmptyStringProblem(record.workflow, `${where}.workflow`) ??
    (record.schemaVersion === 1 ? undefined : `${where}.schemaVersion must be 1`) ??
    digestProblem(record.digest, `${where}.digest`)
  );
}

function stopProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  if (record.decision !== 'held' && record.decision !== 'refused') {
    return `${where}.decision must be "held" or "refused"`;
  }
  // A request-derived stop must record the request's own precondition. An older journal without it
  // fails closed here rather than replaying under a substituted revision; the 0.5.4 contract is
  // unpublished, so there is no released journal shape to keep accepting.
  const precondition =
    record.expectedRevision === undefined
      ? record.signal !== undefined && record.requestId !== undefined
        ? `${where}.expectedRevision is required on a request-derived stop`
        : undefined
      : integerProblem(record.expectedRevision, `${where}.expectedRevision`, 0);
  return (
    nonEmptyStringProblem(record.code, `${where}.code`) ??
    nonEmptyStringProblem(record.why, `${where}.why`) ??
    nonEmptyStringProblem(record.at, `${where}.at`) ??
    nonEmptyStringProblem(record.state, `${where}.state`) ??
    integerProblem(record.revision, `${where}.revision`, 0) ??
    refsProblem(record.evidence, `${where}.evidence`) ??
    (record.waitingOn === undefined ? undefined : waitingOnProblem(record.waitingOn, `${where}.waitingOn`)) ??
    (record.signal === undefined ? undefined : signalProblem(record.signal, `${where}.signal`)) ??
    (record.requestId === undefined ? undefined : nonEmptyStringProblem(record.requestId, `${where}.requestId`)) ??
    precondition ??
    (record.guard === undefined ? undefined : guardProblem(record.guard, `${where}.guard`))
  );
}

function stepProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  const keys = keysProblem(
    record,
    where,
    ['revision', 'at', 'signal', 'requestId', 'requestDigest', 'transition', 'activation', 'evidence', 'effects'],
    ['guard'],
  );
  if (keys !== undefined) return keys;

  const base =
    integerProblem(record.revision, `${where}.revision`, 1) ??
    nonEmptyStringProblem(record.at, `${where}.at`) ??
    signalProblem(record.signal, `${where}.signal`) ??
    nonEmptyStringProblem(record.requestId, `${where}.requestId`) ??
    digestProblem(record.requestDigest, `${where}.requestDigest`) ??
    integerProblem(record.activation, `${where}.activation`, 1) ??
    refsProblem(record.evidence, `${where}.evidence`);
  if (base !== undefined) return base;

  const transition = asObject(record.transition);
  if (transition === undefined) return `${where}.transition must be an object`;
  const transitionKeys = keysProblem(transition, `${where}.transition`, ['from', 'to', 'on']);
  if (transitionKeys !== undefined) return transitionKeys;
  const transitionProblem =
    nonEmptyStringProblem(transition.from, `${where}.transition.from`) ??
    nonEmptyStringProblem(transition.to, `${where}.transition.to`) ??
    signalProblem(transition.on, `${where}.transition.on`);
  if (transitionProblem !== undefined) return transitionProblem;

  if (record.guard !== undefined) {
    const guard = guardProblem(record.guard, `${where}.guard`);
    if (guard !== undefined) return guard;
  }
  return effectsProblem(record.effects, `${where}.effects`);
}

function effectsProblem(value: unknown, where: string): string | undefined {
  if (!Array.isArray(value)) return `${where} must be an array`;
  for (let index = 0; index < value.length; index += 1) {
    const problem = effectProblem(value[index], `${where}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function effectProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  const keys = keysProblem(
    record,
    where,
    ['name', 'state', 'activation', 'occurrence', 'payloadDigest', 'dispatched'],
    ['outcome'],
  );
  if (keys !== undefined) return keys;

  return (
    nonEmptyStringProblem(record.name, `${where}.name`) ??
    nonEmptyStringProblem(record.state, `${where}.state`) ??
    integerProblem(record.activation, `${where}.activation`, 1) ??
    nonEmptyStringProblem(record.occurrence, `${where}.occurrence`) ??
    digestProblem(record.payloadDigest, `${where}.payloadDigest`) ??
    (record.outcome === undefined ? undefined : nonEmptyStringProblem(record.outcome, `${where}.outcome`)) ??
    (record.dispatched === false ? undefined : `${where}.dispatched must be false`)
  );
}

function guardProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  const keys = keysProblem(record, where, ['name', 'answer', 'evidence']);
  if (keys !== undefined) return keys;
  return (
    nonEmptyStringProblem(record.name, `${where}.name`) ??
    (typeof record.answer === 'boolean' ? undefined : `${where}.answer must be a boolean`) ??
    refsProblem(record.evidence, `${where}.evidence`)
  );
}

function waitingOnProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  if (record.kind === 'evidence') {
    return keysProblem(record, where, ['kind', 'ref']) ?? nonEmptyStringProblem(record.ref, `${where}.ref`);
  }
  if (record.kind === 'setting') {
    return keysProblem(record, where, ['kind', 'name']) ?? nonEmptyStringProblem(record.name, `${where}.name`);
  }
  if (record.kind === 'entry-effect') {
    return (
      keysProblem(record, where, ['kind', 'occurrence']) ??
      nonEmptyStringProblem(record.occurrence, `${where}.occurrence`)
    );
  }
  return `${where}.kind must be "evidence", "setting" or "entry-effect"`;
}

function artifactProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  if (record.kind === 'none') return keysProblem(record, where, ['kind']);
  if (record.kind === 'ref' || record.kind === 'tree') {
    return (
      keysProblem(record, where, ['kind', 'value']) ??
      nonEmptyStringProblem(record.value, `${where}.value`)
    );
  }
  return `${where}.kind must be "none", "ref" or "tree"`;
}

function refsProblem(value: unknown, where: string): string | undefined {
  if (!Array.isArray(value)) return `${where} must be an array`;
  for (let index = 0; index < value.length; index += 1) {
    const problem = nonEmptyStringProblem(value[index], `${where}[${index}]`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function stringMapProblem(value: unknown, where: string): string | undefined {
  const record = asObject(value);
  if (record === undefined) return `${where} must be an object`;
  for (const [key, entry] of Object.entries(record)) {
    if (key === '') return `${where} has an empty name`;
    if (typeof entry !== 'string') return `${where}.${key} must be a string`;
  }
  return undefined;
}

function signalProblem(value: unknown, where: string): string | undefined {
  return isSignalName(value) ? undefined : `${where} must be one of the twelve transition signals`;
}

function nonEmptyStringProblem(value: unknown, where: string): string | undefined {
  return typeof value === 'string' && value !== '' ? undefined : `${where} must be a non-empty string`;
}

function digestProblem(value: unknown, where: string): string | undefined {
  return typeof value === 'string' && SHA256.test(value)
    ? undefined
    : `${where} must be a sha256 digest of 64 lowercase hex digits`;
}

function integerProblem(value: unknown, where: string, minimum: number): string | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? undefined
    : `${where} must be an integer >= ${minimum}`;
}

function keysProblem(
  value: JsonObject,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): string | undefined {
  for (const key of required) {
    if (!hasOwn(value, key)) return `${where}: missing "${key}"`;
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return `${where}: unknown key "${key}"`;
  }
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// ---------------------------------------------------------------------------------------------
// The fold's input checks and comparison helpers.

function decodeDefinition(bytes: Uint8Array): string | undefined {
  try {
    // ignoreBOM keeps the bytes the digest is over; the parser received the same text.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function pinMismatch(definition: Workflow, journal: DryRunJournal, source: string): string | undefined {
  const pin = definitionId(definition, source);
  const recorded = journal.definition;
  if (
    pin.workflow === recorded.workflow &&
    pin.schemaVersion === recorded.schemaVersion &&
    pin.digest === recorded.digest
  ) {
    return undefined;
  }
  return `the definition file pins ${pin.workflow}@${pin.digest}; the journal records ${recorded.workflow}@${recorded.digest}`;
}

/** A parsed definition must also be internally resolvable before the core may read it. */
function definitionFault(definition: Workflow): string | undefined {
  if (definition.version !== 1) return 'the definition is not schema version 1';
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

/** Every ref the journal cites must resolve; a held stop's waitingOn ref is not a citation. */
function evidenceFault(evidence: EvidenceDocument, journal: DryRunJournal): string | undefined {
  if (!isObject(evidence)) return 'the evidence document must be a JSON object';
  const refs = new Set<EvidenceRef>();
  for (const effect of journal.start.effects) {
    if (effect.outcome !== undefined) refs.add(effect.outcome);
  }
  for (const step of journal.steps) {
    for (const ref of step.evidence) refs.add(ref);
    for (const ref of step.guard?.evidence ?? []) refs.add(ref);
    for (const effect of step.effects) {
      if (effect.outcome !== undefined) refs.add(effect.outcome);
    }
  }
  if (journal.outcome.kind === 'stopped') {
    for (const ref of journal.outcome.evidence) refs.add(ref);
    for (const ref of journal.outcome.guard?.evidence ?? []) refs.add(ref);
  }
  for (const ref of refs) {
    if (!hasOwn(evidence, ref)) return `the evidence document has no record for ref "${ref}"`;
    const record = evidence[ref];
    if (!isObject(record)) return `the evidence record for ref "${ref}" must be an object`;
    if (typeof record.type !== 'string' || record.type === '') {
      return `the evidence record for ref "${ref}" has no type`;
    }
  }
  return undefined;
}

function entryOccurrences(
  definition: Workflow,
  journal: DryRunJournal,
  stateName: string,
  activation: number,
): OccurrenceRecord[] {
  const state = definition.states[stateName]!;
  return state.onEnter.map((hook) => {
    const effect = definition.effects[hook.name]!;
    return {
      id: occurrenceId(journal.run, activation, hook.name),
      effect: hook.name,
      state: stateName,
      activation,
      payloadDigest: payloadDigest(
        canonicalEffectPayload(hook.name, effect.run.name, journal.target, journal.artifact),
      ),
    };
  });
}

type EffectView = {
  name: string;
  state: string;
  activation: number;
  occurrence: OccurrenceId;
  payloadDigest: string;
};

function effectView(record: OccurrenceRecord): EffectView {
  return {
    name: record.effect,
    state: record.state,
    activation: record.activation,
    occurrence: record.id,
    payloadDigest: record.payloadDigest,
  };
}

function recordedEffectView(record: DryEffectRecord): EffectView {
  return {
    name: record.name,
    state: record.state,
    activation: record.activation,
    occurrence: record.occurrence,
    payloadDigest: record.payloadDigest,
  };
}

function effectsDiffer(
  expected: OccurrenceRecord[],
  recorded: DryEffectRecord[],
): { why: string; expected: unknown; actual: unknown } | undefined {
  if (expected.length !== recorded.length) {
    return {
      why: `the journal records ${recorded.length} effects, the pinned definition plans ${expected.length}`,
      expected: expected.map(effectView),
      actual: recorded.map(recordedEffectView),
    };
  }
  for (let index = 0; index < expected.length; index += 1) {
    const planned = effectView(expected[index]!);
    const written = recordedEffectView(recorded[index]!);
    if (canonicalJson(planned) !== canonicalJson(written)) {
      return {
        why: `effect ${index} does not match the canonical effect plan`,
        expected: { index, ...planned },
        actual: { index, ...written },
      };
    }
  }
  return undefined;
}

function transitionOf(transition: Workflow['transitions'][number]): { from: string; to: string; on: SignalName } {
  return { from: transition.from, to: transition.to, on: transition.on };
}

function planOccurrences(decision: StepDecision, run: RunState): OccurrenceRecord[] {
  const out: OccurrenceRecord[] = [];
  for (const item of decision.plan) {
    if (item.kind !== 'effect') continue;
    out.push({
      id: item.occurrence,
      effect: item.effect,
      state: item.phase === 'exit' ? run.state : decision.next.state,
      activation: item.phase === 'exit' ? run.activation : decision.next.activation,
      payloadDigest: item.digest,
    });
  }
  return out;
}

function decisionView(decision: CoreDecision): unknown {
  if (decision.kind === 'step') {
    return {
      kind: 'step',
      revision: decision.nextRevision,
      transition: decision.transition,
      next: decision.next,
    };
  }
  if (decision.kind === 'duplicate') {
    return { kind: 'duplicate', recorded: decision.recorded };
  }
  return {
    kind: decision.kind,
    code: decision.code,
    state: decision.state,
    revision: decision.revision,
    waitingOn: decision.waitingOn ?? null,
    guard: decision.guard ?? null,
  };
}

function describe(value: unknown): string {
  return value === null ? 'no answer' : canonicalJson(value);
}

function failure(
  code: ReplayFailureCode,
  why: string,
  step?: number,
  expected?: unknown,
  actual?: unknown,
): ReplayResult {
  return {
    ok: false,
    fail: {
      code,
      ...(step !== undefined ? { step } : {}),
      ...(expected !== undefined ? { expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
      why,
    },
  };
}

function mismatch(step: number, why: string, expected: unknown, actual: unknown): ReplayResult {
  return failure('workflow.replay-mismatch', why, step, expected, actual);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
