// The live fold and the live replay. `foldLive` is the structural fold every read and append uses:
// sequence, state continuity, revisions, activations and occurrence ids, with no definition in
// hand. `replayLive` rechecks the same journal against the pinned definition's bytes: the
// transition set, the exact effect plan, request digests and the run-open pin. Neither writes
// anything, calls `decide`, verifies a signature, dispatches or claims the Kernel ledger.

import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  definitionId,
  occurrenceId,
  payloadDigest,
} from '../canonical.ts';
import type { OccurrenceRecord, RunState } from '../core-state.ts';
import type { SignalName } from '../signals.ts';
import type { ArtifactRef, DefinitionId, DryEffectRecord, EvidenceDocument, EvidenceRecord, RequestId, Revision, RunId, Workflow } from '../types.ts';
import { waitsAfterStep, waitsAtEntry } from '../waits.ts';
import type { LiveErrorMove, LiveRecord, LiveState } from './records.ts';
import { itemKeyText, runIdFor, validateItemKey } from './records.ts';
import { parseJournalText } from './journal.ts';

export type FoldResult = { ok: true; live: LiveState } | { ok: false; why: string; seq?: number };

function fail(why: string, seq?: number): { ok: false; why: string; seq?: number } {
  return { ok: false, why, ...(seq !== undefined ? { seq } : {}) };
}

/**
 * Fold a journal without a definition. Every invariant here is internal to the records: contiguous
 * seq, the run-id/key/generation bind, state continuity through recorded transitions, revision and
 * activation increments, occurrence ids, one terminal outcome, one reopen after it, and the
 * dispatch state's own monotonicity (attempts rise, messages are seen once, intents resolve once).
 */
export function foldLive(records: readonly LiveRecord[]): FoldResult {
  const first = records[0];
  if (first === undefined) return fail('the journal has no run-open record');
  if (first.record !== 'run-open') return fail('the journal does not start with a run-open record', first.seq);

  const live: LiveState = {
    run: first.run,
    key: '',
    item: first.item,
    generation: first.generation,
    definition: first.definition,
    status: 'live',
    state: first.start.state,
    revision: 0,
    activation: 1,
    evidence: [],
    evidenceRecords: [],
    entryOutcomes: [],
    holds: [],
    timers: [],
    attempts: {},
    messages: [],
    intents: [],
    results: [],
    decisions: [],
    lastSeq: first.seq - 1,
  };
  const key = validateItemKey(first.item);
  if (!key.ok) return fail(key.why, first.seq);
  if (runIdFor(key.key, first.generation) !== first.run) {
    return fail('the run id does not name its item key and generation', first.seq);
  }
  if (first.start.state !== first.initial) return fail('the start state is not the run-open initial state', first.seq);
  live.key = itemKeyText(first.item);

  const occurrences = new Set<string>();
  const evidenceByRef = new Map<string, string>();
  const intentIds = new Map<string, string>();
  const resolved = new Map<string, string>();
  let closed = false;
  let reopened = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.seq !== live.lastSeq + 1 || record.seq !== index + 1) {
      return fail('the record sequence is not contiguous from 1', record.seq);
    }
    live.lastSeq = record.seq;

    if (reopened) return fail('a reopened journal takes no further records', record.seq);

    switch (record.record) {
      case 'run-open':
        if (index !== 0) return fail('a second run-open record', record.seq);
        break;
      case 'step': {
        if (closed) return fail('a step after the run ended', record.seq);
        if (record.transition.on !== record.signal) return fail('the step signal and transition signal differ', record.seq);
        if (record.transition.from !== live.state) {
          return fail(`the step leaves "${record.transition.from}" while the run is in "${live.state}"`, record.seq);
        }
        if (record.revision !== live.revision + 1) return fail('the step revision does not advance by one', record.seq);
        if (record.activation !== live.activation + 1) {
          return fail('the step activation does not advance by one', record.seq);
        }
        const previousActivation = live.activation;
        const next = record.next ?? record.transition.to;
        if (next === record.transition.to) {
          if (record.error !== undefined) return fail('a normal step records an error move', record.seq);
        } else if (record.error === undefined) {
          return fail('an error-path step records no refused effect', record.seq);
        } else {
          if (record.error.from !== record.transition.from || record.error.to !== next) {
            return fail('the error move names another move', record.seq);
          }
          if (record.error.occurrence !== occurrenceId(live.run, previousActivation, record.error.effect)) {
            return fail('the error move carries a foreign occurrence id', record.seq);
          }
        }
        for (const effect of record.effects) {
          if (effect.activation !== previousActivation && effect.activation !== record.activation) {
            return fail(`effect "${effect.name}" names an activation that is neither the old nor the new one`, record.seq);
          }
          if (effect.activation === previousActivation) {
            if (next !== record.transition.to) {
              return fail('an error-path step records an exit effect', record.seq);
            }
            if (effect.state !== record.transition.from) {
              return fail(`exit effect "${effect.name}" does not name the leaving state`, record.seq);
            }
          }
          if (effect.activation === record.activation && effect.state !== next) {
            return fail(`enter effect "${effect.name}" does not name the entered state`, record.seq);
          }
          const expected = occurrenceId(live.run, effect.activation, effect.name);
          if (effect.occurrence !== expected) return fail(`effect "${effect.name}" carries a foreign occurrence id`, record.seq);
          if (occurrences.has(effect.occurrence)) {
            return fail(`occurrence "${effect.occurrence}" is recorded twice`, record.seq);
          }
          occurrences.add(effect.occurrence);
        }
        live.evidence.push(...record.evidence);
        if (record.evidenceRecords !== undefined) {
          for (const [ref, entry] of Object.entries(record.evidenceRecords)) {
            const seen = evidenceByRef.get(ref);
            const canonical = canonicalJsonSafe(entry);
            if (seen !== undefined) {
              if (seen !== canonical) return fail(`evidence "${ref}" is recorded with different bytes`, record.seq);
            } else {
              evidenceByRef.set(ref, canonical);
              live.evidenceRecords.push(entry);
            }
          }
        }
        live.state = next;
        live.revision = record.revision;
        live.activation = record.activation;
        break;
      }
      case 'evidence':
        live.evidenceRecords.push(...record.entries);
        break;
      case 'entry-outcome': {
        if (closed) return fail('an entry outcome after the run ended', record.seq);
        if (record.state !== live.state) {
          return fail(`the entry outcome names "${record.state}" while the run is in "${live.state}"`, record.seq);
        }
        if (record.activation !== live.activation) {
          return fail('the entry outcome names another activation', record.seq);
        }
        if (record.occurrence !== occurrenceId(live.run, record.activation, record.effect)) {
          return fail('the entry outcome carries a foreign occurrence id', record.seq);
        }
        if (live.entryOutcomes.some((seen) => seen.occurrence === record.occurrence)) {
          return fail(`the entry outcome "${record.occurrence}" is recorded twice`, record.seq);
        }
        live.entryOutcomes.push(record);
        break;
      }
      case 'intent': {
        const canonical = intentCanonical(record);
        const seen = intentIds.get(record.intentId);
        if (seen !== undefined) {
          if (seen !== canonical) return fail(`intent "${record.intentId}" is recorded with different bytes`, record.seq);
          break;
        }
        intentIds.set(record.intentId, canonical);
        live.intents.push(record);
        break;
      }
      case 'result': {
        if (!intentIds.has(record.intentId)) return fail(`result for unknown intent "${record.intentId}"`, record.seq);
        const canonical = resultCanonical(record);
        const seen = resolved.get(record.intentId);
        if (seen !== undefined) {
          if (seen !== canonical) return fail(`intent "${record.intentId}" resolves twice`, record.seq);
          break;
        }
        resolved.set(record.intentId, canonical);
        live.results.push(record);
        break;
      }
      case 'hold': {
        if (record.hold.item !== live.key) return fail('a hold names another item key', record.seq);
        const at = live.holds.findIndex((candidate) => candidate.item === record.hold.item);
        if (record.action === 'reserve') {
          if (at >= 0) {
            if (canonicalJsonSafe(live.holds[at]) !== canonicalJsonSafe(record.hold)) {
              return fail('a second reservation is recorded for the item', record.seq);
            }
            break;
          }
          live.holds.push(record.hold);
          break;
        }
        if (at < 0) return fail(`hold ${record.action} without a recorded hold`, record.seq);
        if (live.holds[at]!.owner !== record.hold.owner) {
          return fail(`hold ${record.action} by a different owner`, record.seq);
        }
        if (record.action === 'release') live.holds.splice(at, 1);
        else live.holds[at] = record.hold;
        break;
      }
      case 'timer': {
        const at = live.timers.findIndex((candidate) => candidate.timerId === record.timerId);
        if (record.action === 'arm') {
          if (at >= 0) live.timers[at] = record;
          else live.timers.push(record);
          break;
        }
        if (at < 0) return fail(`timer ${record.action} for "${record.timerId}" is not armed`, record.seq);
        live.timers.splice(at, 1);
        break;
      }
      case 'attempt': {
        const current = live.attempts[record.stage];
        if (current !== undefined && record.attempt <= current) {
          return fail(`attempt for "${record.stage}" does not rise`, record.seq);
        }
        live.attempts[record.stage] = record.attempt;
        break;
      }
      case 'message': {
        if (live.messages.some((candidate) => candidate.messageId === record.messageId)) {
          return fail(`message "${record.messageId}" is recorded twice`, record.seq);
        }
        live.messages.push(record);
        break;
      }
      case 'decision':
        live.decisions.push(record);
        break;
      case 'outcome': {
        if (closed) return fail('a second outcome record', record.seq);
        closed = true;
        live.status = record.outcome;
        live.outcome = {
          outcome: record.outcome,
          ...(record.why !== undefined ? { why: record.why } : {}),
          ...(record.by !== undefined ? { by: record.by } : {}),
          at: record.at,
        };
        break;
      }
      case 'reopen': {
        if (!closed) return fail('a reopen before any outcome', record.seq);
        reopened = true;
        live.reopened = { by: record.by, reason: record.reason, at: record.at };
        break;
      }
      default:
        return fail('the record kind is unknown', records[index]!.seq);
    }
  }

  return { ok: true, live };
}

function canonicalJsonSafe(value: unknown): string {
  return canonicalJson(value);
}

function intentCanonical(record: Extract<LiveRecord, { record: 'intent' }>): string {
  return canonicalJsonSafe({
    intentId: record.intentId,
    occurrence: record.occurrence,
    attempt: record.attempt,
    receiver: record.receiver,
    messageId: record.messageId,
    leg: record.leg,
    payloadDigest: record.payloadDigest,
  });
}

function resultCanonical(record: Extract<LiveRecord, { record: 'result' }>): string {
  return canonicalJsonSafe({
    intentId: record.intentId,
    outcome: record.outcome,
    leg: record.leg,
    messageId: record.messageId,
    why: record.why,
    found: record.found,
  });
}

/** One effect the definition requires at an activation, in hook order. */
export function expectedEffects(
  definition: Workflow,
  runId: RunId,
  stateName: string,
  activation: number,
  target: string,
  artifact: ArtifactRef,
  hooks: Array<{ name: string }>,
): { ok: true; effects: DryEffectRecord[] } | { ok: false; why: string } {
  const effects: DryEffectRecord[] = [];
  for (const hook of hooks) {
    const effect = definition.effects[hook.name];
    if (effect === undefined) return { ok: false, why: `effect "${hook.name}" is not declared` };
    const digest = payloadDigest(canonicalEffectPayload(hook.name, effect.run.name, target, artifact));
    effects.push({
      name: hook.name,
      state: stateName,
      activation,
      occurrence: occurrenceId(runId, activation, hook.name),
      payloadDigest: digest,
      dispatched: false,
    });
  }
  return { ok: true, effects };
}

/** The start entry's exact effect plan for the initial state at activation 1. */
export function startEffectsOf(
  definition: Workflow,
  runId: RunId,
  initial: string,
  target: string,
  artifact: ArtifactRef,
): { ok: true; effects: DryEffectRecord[] } | { ok: false; why: string } {
  const state = definition.states[initial];
  if (state === undefined) return { ok: false, why: `state "${initial}" is not declared` };
  return expectedEffects(definition, runId, initial, 1, target, artifact, state.onEnter);
}

export type StepInput = {
  revision: Revision;
  signal: SignalName;
  requestId: RequestId;
  requestDigest: `sha256:${string}`;
  transition: { from: string; to: string; on: SignalName };
  activation: number;
  next?: string;
  error?: LiveErrorMove;
  evidence: string[];
  evidenceRecords?: EvidenceDocument;
  guard?: { name: string; answer: boolean; evidence: string[] };
  effects: DryEffectRecord[];
};

/**
 * Validate one step against the definition before it may be appended: the transition exists and
 * is the only one for its (from, signal), the recorded transition matches it, revision and
 * activation advance by one, the request digest recomputes from the pinned identity fields, the
 * guard name is the definition's, and the effect plan is exactly the leaving state's hooks then
 * the entered state's, with the canonical payload digests.
 */
export function stepFault(input: {
  definition: Workflow;
  runId: RunId;
  target: string;
  artifact: ArtifactRef;
  state: string;
  previousRevision: Revision;
  previousActivation: number;
  step: StepInput;
}): string | undefined {
  const { definition, step } = input;
  if (step.transition.from !== input.state) {
    return `the step leaves "${step.transition.from}" while the run is in "${input.state}"`;
  }
  if (step.transition.on !== step.signal) return 'the step signal and transition signal differ';
  if (step.revision !== input.previousRevision + 1) return 'the step revision does not advance by one';
  if (step.activation !== input.previousActivation + 1) return 'the step activation does not advance by one';

  const from = definition.states[step.transition.from];
  const to = definition.states[step.transition.to];
  if (from === undefined) return `state "${step.transition.from}" is not declared`;
  if (to === undefined) return `state "${step.transition.to}" is not declared`;
  const enabled = definition.transitions.filter(
    (candidate) => candidate.from === step.transition.from && candidate.on === step.signal,
  );
  if (enabled.length !== 1) {
    return `the definition has ${enabled.length} transitions for ${step.transition.from}/${step.signal}`;
  }
  const transition = enabled[0]!;
  if (transition.to !== step.transition.to) {
    return `the definition moves ${step.transition.from}/${step.signal} to "${transition.to}", not "${step.transition.to}"`;
  }
  if (transition.guard !== undefined) {
    if (step.guard === undefined || step.guard.name !== transition.guard.name) {
      return `the transition's guard "${transition.guard.name}" is not recorded`;
    }
  } else if (step.guard !== undefined) {
    return 'a guard is recorded for a transition that declares none';
  }

  const digest = payloadDigest(
    canonicalRequestPayload({
      move: { transition: { from: transition.from, to: transition.to, on: transition.on } },
      target: input.target,
      artifact: input.artifact,
      evidence: step.evidence,
    }),
  );
  if (digest !== step.requestDigest) return 'the request digest does not match the recorded request';

  const next = step.next ?? step.transition.to;
  let expected: DryEffectRecord[];
  if (next === step.transition.to) {
    if (step.error !== undefined) return 'a normal step records an error move';
    const exit = expectedEffects(
      definition,
      input.runId,
      step.transition.from,
      input.previousActivation,
      input.target,
      input.artifact,
      from.onLeave,
    );
    if (!exit.ok) return exit.why;
    const enter = expectedEffects(
      definition,
      input.runId,
      step.transition.to,
      step.activation,
      input.target,
      input.artifact,
      to.onEnter,
    );
    if (!enter.ok) return enter.why;
    expected = [...exit.effects, ...enter.effects];
  } else {
    // The MVP's second engine rule: a refused entry effect takes the run to the definition's
    // top-level error state. The move is not a definition transition, so the plan holds only
    // that state's entry effects; the refusing state's dispatch occurrence is left as it was.
    if (definition.error === undefined) return 'the definition declares no error state';
    if (next !== definition.error) {
      return `the step moves to "${next}", not the definition's error state "${definition.error}"`;
    }
    const move = step.error;
    if (move === undefined) return 'the error-path step records no refused effect';
    if (move.rule !== 'entry-effect-refused') return `the error move names the rule "${move.rule}"`;
    if (move.from !== step.transition.from || move.to !== next) {
      return 'the error move names another move than the step';
    }
    if (!(from.onEnter ?? []).some((hook) => hook.name === move.effect)) {
      return `the error move names "${move.effect}", not an entry effect of "${step.transition.from}"`;
    }
    if (move.occurrence !== occurrenceId(input.runId, input.previousActivation, move.effect)) {
      return 'the error move carries a foreign occurrence id';
    }
    const errorState = definition.states[next];
    if (errorState === undefined) return `error state "${next}" is not declared`;
    const enter = expectedEffects(
      definition,
      input.runId,
      next,
      step.activation,
      input.target,
      input.artifact,
      errorState.onEnter,
    );
    if (!enter.ok) return enter.why;
    expected = enter.effects;
  }
  if (expected.length !== step.effects.length) {
    return `the step records ${step.effects.length} effects; the definition's plan has ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index]!;
    const got = step.effects[index]!;
    if (
      got.name !== want.name ||
      got.state !== want.state ||
      got.activation !== want.activation ||
      got.occurrence !== want.occurrence ||
      got.payloadDigest !== want.payloadDigest
    ) {
      return `effect ${index + 1} ("${want.name}") does not match the definition's plan`;
    }
    if (got.dispatched !== false) return 'a recorded effect claims to be dispatched';
  }
  return undefined;
}

export type ReplayLiveFailure = {
  code: 'journal-invalid' | 'definition-mismatch' | 'start-mismatch' | 'step-mismatch' | 'entry-outcome-mismatch';
  record?: number;
  why: string;
};

export type ReplayLiveResult =
  | { ok: true; run: RunState; live: LiveState }
  | { ok: false; fail: ReplayLiveFailure };

export type ReplayLiveInput = {
  definitionBytes: Uint8Array | string;
  definition: Workflow;
  journalText: string;
};

/**
 * Fold a journal and recheck it against the definition it opened with. The bytes and the parsed
 * definition must agree on one pin; the start and every step must match the definition's plan.
 */
export function replayLive(input: ReplayLiveInput): ReplayLiveResult {
  const source =
    typeof input.definitionBytes === 'string'
      ? input.definitionBytes
      : decodeBytes(input.definitionBytes);
  if (source === undefined) return { ok: false, fail: { code: 'definition-mismatch', why: 'the definition bytes are not UTF-8' } };
  const pin = definitionId(input.definition, source);

  const parsed = parseJournalText(input.journalText);
  if (!parsed.ok) return { ok: false, fail: { code: 'journal-invalid', why: parsed.why } };
  const folded = foldLive(parsed.records);
  if (!folded.ok) {
    return { ok: false, fail: { code: 'journal-invalid', ...(folded.seq !== undefined ? { record: folded.seq } : {}), why: folded.why } };
  }
  const live = folded.live;
  const open = parsed.records[0]!;
  if (open.record !== 'run-open') {
    return { ok: false, fail: { code: 'journal-invalid', record: open.seq, why: 'the journal does not start with a run-open record' } };
  }
  if (!sameDefinition(open.definition, pin)) {
    return {
      ok: false,
      fail: { code: 'definition-mismatch', record: open.seq, why: 'the run opened with a different definition pin' },
    };
  }

  const start = startEffectsOf(input.definition, open.run, open.initial, open.target, open.artifact);
  if (!start.ok) {
    return { ok: false, fail: { code: 'start-mismatch', record: open.seq, why: start.why } };
  }
  const startFault = compareEffects(open.start.effects, start.effects);
  if (startFault !== undefined) {
    return { ok: false, fail: { code: 'start-mismatch', record: open.seq, why: startFault } };
  }

  const occurrences = new Map<string, OccurrenceRecord>();
  for (const effect of [...open.start.effects, ...liveSteps(parsed.records).flatMap((step) => step.effects)]) {
    occurrences.set(effect.occurrence, {
      id: effect.occurrence,
      effect: effect.name,
      state: effect.state,
      activation: effect.activation,
      payloadDigest: effect.payloadDigest,
    });
  }
  const requests = new Map<RequestId, { payloadDigest: `sha256:${string}`; step: number }>();

  let run: RunState = {
    runId: open.run,
    definitionId: pin,
    state: open.initial,
    revision: 0,
    activation: 1,
    occurrences,
    requests,
    waits: waitsAtEntry(input.definition, open.initial, 1),
  };

  let stepIndex = 0;
  for (const record of parsed.records) {
    if (record.record !== 'step') continue;
    const fault = stepFault({
      definition: input.definition,
      runId: open.run,
      target: open.target,
      artifact: open.artifact,
      state: run.state,
      previousRevision: run.revision,
      previousActivation: run.activation,
      step: record,
    });
    if (fault !== undefined) {
      return { ok: false, fail: { code: 'step-mismatch', record: record.seq, why: fault } };
    }
    requests.set(record.requestId, { payloadDigest: record.requestDigest, step: stepIndex });
    run = {
      ...run,
      state: record.next ?? record.transition.to,
      revision: record.revision,
      activation: record.activation,
      waits: waitsAfterStep(run, input.definition, {
        signal: record.signal,
        nextState: record.next ?? record.transition.to,
        nextActivation: record.activation,
      }),
    };
    stepIndex += 1;
  }

  for (const outcome of live.entryOutcomes) {
    const state = input.definition.states[outcome.state];
    if (state === undefined || !(state.onEnter ?? []).some((hook) => hook.name === outcome.effect)) {
      return {
        ok: false,
        fail: {
          code: 'entry-outcome-mismatch',
          record: outcome.seq,
          why: `the entry outcome names "${outcome.effect}", not an entry effect of "${outcome.state}"`,
        },
      };
    }
  }

  return { ok: true, run, live };
}

function liveSteps(records: readonly LiveRecord[]): Array<Extract<LiveRecord, { record: 'step' }>> {
  return records.filter((record): record is Extract<LiveRecord, { record: 'step' }> => record.record === 'step');
}

function sameDefinition(left: DefinitionId, right: DefinitionId): boolean {
  return left.workflow === right.workflow && left.schemaVersion === right.schemaVersion && left.digest === right.digest;
}

function compareEffects(got: readonly DryEffectRecord[], want: readonly DryEffectRecord[]): string | undefined {
  if (got.length !== want.length) return `the plan records ${got.length} effects; the definition has ${want.length}`;
  for (let index = 0; index < want.length; index += 1) {
    const left = got[index]!;
    const right = want[index]!;
    if (
      left.name !== right.name ||
      left.state !== right.state ||
      left.activation !== right.activation ||
      left.occurrence !== right.occurrence ||
      left.payloadDigest !== right.payloadDigest
    ) {
      return `effect ${index + 1} ("${right.name}") does not match the definition's plan`;
    }
  }
  return undefined;
}

function decodeBytes(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
