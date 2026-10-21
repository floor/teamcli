// Independent coverage for the deterministic dry transition core.
//
// Authored from the workflow contract — the definition/envelope/evidence/decision types, the
// frozen decision-code table, the signal-to-record selectors and the supplied-evidence
// semantics — not from the core implementation or its own tests. Fixtures are written here in
// full: no builder fixture or test was imported or copied.
//
// The five areas: identity and request precedence, selector and scope, supplied entry-outcome
// gating, flat waits, occurrence invariants. Every stop asserts the decision kind, the frozen
// code, and that the run state did not move.

import { describe, expect, test } from 'bun:test';
import {
  canonicalEffectPayload,
  canonicalRequestPayload,
  payloadDigest,
} from '../../src/workflow/canonical.ts';
import type { OccurrenceRecord, RequestRecord, RunState } from '../../src/workflow/core-state.ts';
import { decide } from '../../src/workflow/core.ts';
import type { CoreDecision, CoreInput, EffectPlanItem } from '../../src/workflow/core.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import type { EvidenceSource, GuardCatalogue, SettingSource } from '../../src/workflow/registry.ts';
import type { SignalName } from '../../src/workflow/signals.ts';
import type { DecisionCode } from '../../src/workflow/codes.ts';
import type {
  ArtifactRef,
  DefinitionId,
  EvidenceRecord,
  Workflow,
  WorkflowEffect,
  WorkflowState,
  WorkflowTransition,
  WorkflowWait,
  WorkflowEnvelope,
} from '../../src/workflow/types.ts';

const RUN = 'run-1';
const TARGET = 'ticket-7';
const ARTIFACT: ArtifactRef = { kind: 'ref', value: 'tree-7' };
const DEF_DIGEST: `sha256:${string}` = `sha256:${'d'.repeat(64)}`;
const WRONG_DIGEST: `sha256:${string}` = `sha256:${'0'.repeat(64)}`;
const DEF: DefinitionId = { workflow: 'core-coverage', schemaVersion: 1, digest: DEF_DIGEST };
const OTHER_DEF: DefinitionId = { workflow: 'core-coverage', schemaVersion: 1, digest: WRONG_DIGEST };
const AT = '2026-10-21T12:00:00.000Z';
const WAIT_AT = '2026-10-21T12:00:00.000Z';
const BEFORE_WAIT = '2026-10-21T11:59:59.999Z';

// ---------------------------------------------------------------------------------------------
// Definitions. Built as whole values so each test names exactly the graph it exercises.

function workflowState(
  name: string,
  hooks: { onEnter?: string[]; onLeave?: string[]; wait?: WorkflowWait } = {},
): WorkflowState {
  return {
    line: 1,
    name,
    onEnter: (hooks.onEnter ?? []).map((hook) => ({ name: hook, line: 1 })),
    onLeave: (hooks.onLeave ?? []).map((hook) => ({ name: hook, line: 1 })),
    ...(hooks.wait !== undefined ? { wait: hooks.wait } : {}),
  };
}

function timeWait(name = 'ready-at'): WorkflowWait {
  return { line: 1, for: 'time', at: { name, line: 1 } };
}

function approvalWait(role = 'owner'): WorkflowWait {
  return { line: 1, for: 'approval', role: { name: role, line: 1 } };
}

function workflowEffect(name: string, operation: string): WorkflowEffect {
  return {
    line: 1,
    name,
    run: { name: operation, line: 1 },
    role: { name: 'operator', line: 1 },
    capability: 'write',
  };
}

function transition(from: string, to: string, on: SignalName, guard?: string): WorkflowTransition {
  return {
    line: 1,
    from,
    to,
    on,
    role: { name: 'integrator', line: 1 },
    ...(guard !== undefined ? { guard: { name: guard, line: 1 } } : {}),
  };
}

function definitionOf(parts: {
  initial?: string;
  states: Record<string, WorkflowState>;
  transitions: WorkflowTransition[];
  effects: Record<string, WorkflowEffect>;
}): Workflow {
  return {
    line: 1,
    name: 'core-coverage',
    version: 1,
    initial: parts.initial ?? 'ready',
    on: [],
    inputs: [],
    states: parts.states,
    transitions: parts.transitions,
    effects: parts.effects,
    library: {},
  };
}

/** `ready` enters with an effect and waits for the clock; `resting` enters with an effect. */
function baseDefinition(): Workflow {
  return definitionOf({
    states: {
      ready: workflowState('ready', { onEnter: ['notice-ready'], wait: timeWait() }),
      resting: workflowState('resting', { onEnter: ['notice-resting'] }),
    },
    transitions: [
      transition('ready', 'resting', 'time-reached'),
      transition('resting', 'ready', 'time-reached'),
    ],
    effects: {
      'notice-ready': workflowEffect('notice-ready', 'release-notes'),
      'notice-resting': workflowEffect('notice-resting', 'release-notes'),
    },
  });
}

/** Two exit hooks and two enter hooks, to pin the plan order. */
function planOrderDefinition(): Workflow {
  return definitionOf({
    states: {
      ready: workflowState('ready', {
        onEnter: ['notice-ready'],
        onLeave: ['close-a', 'close-b'],
        wait: timeWait(),
      }),
      resting: workflowState('resting', { onEnter: ['greet-a', 'greet-b'] }),
    },
    transitions: [transition('ready', 'resting', 'time-reached')],
    effects: {
      'notice-ready': workflowEffect('notice-ready', 'release-notes'),
      'close-a': workflowEffect('close-a', 'round-close-hold'),
      'close-b': workflowEffect('close-b', 'round-close-hold'),
      'greet-a': workflowEffect('greet-a', 'review-morning'),
      'greet-b': workflowEffect('greet-b', 'review-morning'),
    },
  });
}

/** A state with a time wait that also names an enabled transition for another signal. */
function mixedWaitDefinition(): Workflow {
  return definitionOf({
    states: {
      ready: workflowState('ready', { onEnter: ['notice-ready'], wait: timeWait() }),
      resting: workflowState('resting', { onEnter: ['notice-resting'] }),
      rejected: workflowState('rejected'),
    },
    transitions: [
      transition('ready', 'resting', 'time-reached'),
      transition('ready', 'rejected', 'approved'),
    ],
    effects: {
      'notice-ready': workflowEffect('notice-ready', 'release-notes'),
      'notice-resting': workflowEffect('notice-resting', 'release-notes'),
    },
  });
}

/** An operation-scoped outcome signal with a named guard on the transition. */
function guardedDefinition(guard: string): Workflow {
  return definitionOf({
    initial: 'open',
    states: { open: workflowState('open'), merged: workflowState('merged') },
    transitions: [transition('open', 'merged', 'pr-merged', guard)],
    effects: {},
  });
}

/** A state that leaves only on approval. */
function approvalDefinition(): Workflow {
  return definitionOf({
    initial: 'reviewing',
    states: {
      reviewing: workflowState('reviewing', { wait: approvalWait() }),
      done: workflowState('done'),
    },
    transitions: [transition('reviewing', 'done', 'approved')],
    effects: {},
  });
}

// ---------------------------------------------------------------------------------------------
// Runs, envelopes, evidence and settings.

function occurrenceOf(
  effect: string,
  activation: number,
  state: string,
  operation: string,
  digest: `sha256:${string}` = payloadDigest(
    canonicalEffectPayload(effect, operation, TARGET, ARTIFACT),
  ),
): OccurrenceRecord {
  return {
    id: `${RUN}/${activation}/${effect}`,
    effect,
    state,
    activation,
    payloadDigest: digest,
  };
}

type RunOptions = {
  state?: string;
  revision?: number;
  activation?: number;
  occurrences?: OccurrenceRecord[];
  requests?: ReadonlyMap<string, RequestRecord>;
  waits?: RunState['waits'];
};

function runOf(options: RunOptions = {}): RunState {
  return {
    runId: RUN,
    definitionId: DEF,
    state: options.state ?? 'ready',
    revision: options.revision ?? 0,
    activation: options.activation ?? 1,
    occurrences: new Map(
      (options.occurrences ?? []).map((record) => [record.id, record] as const),
    ),
    requests: options.requests !== undefined ? new Map(options.requests) : new Map(),
    waits: options.waits ?? [],
  };
}

/** The base run at `ready` activation 1: its entry occurrence is recorded and its wait fired. */
function readyRun(options: RunOptions = {}): RunState {
  return runOf({
    occurrences: [occurrenceOf('notice-ready', 1, 'ready', 'release-notes')],
    waits: [{ state: 'ready', activation: 1, status: 'fired' }],
    ...options,
  });
}

type EnvelopeOptions = {
  run?: string;
  definition?: DefinitionId;
  expectedRevision?: number;
  expectedHead?: WorkflowEnvelope['expectedHead'];
  requestId?: string;
  move?: WorkflowEnvelope['move'];
  target?: string;
  artifact?: ArtifactRef;
  evidence?: string[];
};

function envelopeOf(options: EnvelopeOptions = {}): WorkflowEnvelope {
  return {
    format: 1,
    run: options.run ?? RUN,
    definition: options.definition ?? DEF,
    expectedRevision: options.expectedRevision ?? 0,
    ...(options.expectedHead !== undefined ? { expectedHead: options.expectedHead } : {}),
    requestId: options.requestId ?? 'req-1',
    move: options.move ?? { transition: { from: 'ready', to: 'resting', on: 'time-reached' } },
    target: options.target ?? TARGET,
    artifact: options.artifact ?? ARTIFACT,
    evidence: options.evidence ?? [],
  };
}

function requestDigest(envelope: WorkflowEnvelope): `sha256:${string}` {
  return payloadDigest(canonicalRequestPayload(envelope));
}

function evidenceSource(records: Record<string, EvidenceRecord>): EvidenceSource {
  return { record: (ref) => records[ref] };
}

function settingsSource(values: Record<string, string>): SettingSource {
  return { get: (name) => values[name] };
}

const NO_GUARDS: GuardCatalogue = { guard: () => undefined };
const GUARDS: GuardCatalogue = provisionalResolvers().guards;

const ENTRY_OUTCOME: EvidenceRecord = {
  type: 'outcome',
  result: 'done',
  operation: 'release-notes',
  effect: `${RUN}/1/notice-ready`,
  target: TARGET,
  artifact: ARTIFACT,
};
const TIMER: EvidenceRecord = { type: 'timer', target: TARGET, artifact: ARTIFACT };
const READY_EVIDENCE: Record<string, EvidenceRecord> = {
  'ev-entry': ENTRY_OUTCOME,
  'ev-timer': TIMER,
};

type InputOptions = {
  definition?: Workflow;
  definitionId?: DefinitionId;
  run?: RunState;
  envelope?: WorkflowEnvelope;
  signal?: { name: SignalName; at: string };
  evidence?: EvidenceSource;
  settings?: SettingSource;
  guards?: GuardCatalogue;
};

function inputOf(options: InputOptions = {}): CoreInput {
  return {
    definition: options.definition ?? baseDefinition(),
    definitionId: options.definitionId ?? DEF,
    run: options.run ?? readyRun(),
    envelope:
      options.envelope ?? envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
    signal: options.signal ?? { name: 'time-reached' as SignalName, at: AT },
    evidence: options.evidence ?? evidenceSource(READY_EVIDENCE),
    settings: options.settings ?? settingsSource({ 'ready-at': WAIT_AT }),
    guards: options.guards ?? NO_GUARDS,
  };
}

// ---------------------------------------------------------------------------------------------
// Decision readers. A stop always proves the frozen kind/code and an unmoved run.

type Held = Extract<CoreDecision, { kind: 'held' }>;
type Refused = Extract<CoreDecision, { kind: 'refused' }>;
type Stepped = Extract<CoreDecision, { kind: 'step' }>;

function held(decision: CoreDecision, code: DecisionCode, run: RunState): Held {
  expect(decision.kind).toBe('held');
  if (decision.kind !== 'held') throw new Error(`expected held, received ${decision.kind}`);
  expect(decision.code).toBe(code);
  expect(decision.state).toBe(run.state);
  expect(decision.revision).toBe(run.revision);
  return decision;
}

function refused(decision: CoreDecision, code: DecisionCode, run: RunState): Refused {
  expect(decision.kind).toBe('refused');
  if (decision.kind !== 'refused') throw new Error(`expected refused, received ${decision.kind}`);
  expect(decision.code).toBe(code);
  expect(decision.state).toBe(run.state);
  expect(decision.revision).toBe(run.revision);
  return decision;
}

function stepped(decision: CoreDecision): Stepped {
  expect(decision.kind).toBe('step');
  if (decision.kind !== 'step') throw new Error(`expected step, received ${decision.kind}`);
  return decision;
}

function effectItems(decision: Stepped): EffectPlanItem[] {
  return decision.plan.filter((item): item is EffectPlanItem => item.kind === 'effect');
}

function expectNoPlan(decision: CoreDecision): void {
  expect(decision).not.toHaveProperty('plan');
  expect(decision).not.toHaveProperty('nextRevision');
  expect(decision).not.toHaveProperty('next');
}

// ---------------------------------------------------------------------------------------------
// 1. Identity and request precedence.

describe('identity and request precedence', () => {
  test('a foreign envelope run is refused before the request id is read', () => {
    const original = envelopeOf({ evidence: ['ev-entry', 'ev-timer'] });
    const run = readyRun({
      revision: 3,
      requests: new Map([['req-1', { payloadDigest: requestDigest(original), step: 4 }]]),
    });
    const decision = refused(
      decide(inputOf({ run, envelope: envelopeOf({ run: 'run-other', expectedRevision: 9 }) })),
      'core.run-mismatch',
      run,
    );
    expect(decision.requestId).toBe('req-1');
    expectNoPlan(decision);
    expect(run.requests.size).toBe(1);
  });

  test('a foreign envelope definition pin is refused before the request id is read', () => {
    const original = envelopeOf({ evidence: ['ev-entry', 'ev-timer'] });
    const run = readyRun({
      revision: 3,
      requests: new Map([['req-1', { payloadDigest: requestDigest(original), step: 4 }]]),
    });
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ definition: OTHER_DEF, expectedRevision: 9 }),
        }),
      ),
      'core.definition-mismatch',
      run,
    );
    expectNoPlan(decision);
  });

  test('a supplied definition pin that differs from the run pin is refused', () => {
    const run = readyRun();
    const decision = refused(
      decide(inputOf({ run, definitionId: OTHER_DEF })),
      'core.definition-mismatch',
      run,
    );
    expectNoPlan(decision);
  });

  test('a parsed definition whose name differs from its pin is refused', () => {
    const run = readyRun();
    const decision = refused(
      decide(inputOf({ run, definition: { ...baseDefinition(), name: 'other-workflow' } })),
      'core.definition-mismatch',
      run,
    );
    expectNoPlan(decision);
  });

  test('a used request id with the same canonical payload is a duplicate, before the revision', () => {
    const original = envelopeOf({ evidence: ['ev-entry', 'ev-timer'] });
    const run = readyRun({
      revision: 3,
      requests: new Map([['req-1', { payloadDigest: requestDigest(original), step: 4 }]]),
    });
    const decision = decide(
      inputOf({ run, envelope: envelopeOf({ expectedRevision: 9, evidence: ['ev-entry', 'ev-timer'] }) }),
    );
    expect(decision.kind).toBe('duplicate');
    if (decision.kind !== 'duplicate') throw new Error('expected duplicate');
    expect(decision.recorded).toEqual({ step: 4 });
    expect(decision.requestId).toBe('req-1');
    expect(decision.signal).toBe('time-reached');
    expectNoPlan(decision);
    expect(run.requests.size).toBe(1);
    expect(run.occurrences.size).toBe(1);
  });

  test('a changed payload under a used request id is refused before the revision', () => {
    const original = envelopeOf({ evidence: ['ev-entry', 'ev-timer'] });
    const run = readyRun({
      revision: 3,
      requests: new Map([['req-1', { payloadDigest: requestDigest(original), step: 4 }]]),
    });
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({
            expectedRevision: 9,
            target: 'ticket-8',
            evidence: ['ev-entry', 'ev-timer'],
          }),
        }),
      ),
      'core.request-conflict',
      run,
    );
    expectNoPlan(decision);
    expect(run.requests.size).toBe(1);
  });

  test('a fresh request id at a stale revision is refused, naming both revisions', () => {
    for (const expected of [6, 8]) {
      const run = runOf({
        state: 'resting',
        activation: 2,
        revision: 7,
        waits: [{ state: 'resting', activation: 2, status: 'fired' }],
      });
      const decision = refused(
        decide(
          inputOf({
            definition: baseDefinition(),
            run,
            envelope: envelopeOf({
              requestId: 'req-fresh',
              expectedRevision: expected,
              move: { transition: { from: 'resting', to: 'ready', on: 'time-reached' } },
            }),
          }),
        ),
        'core.revision-stale',
        run,
      );
      expect(decision.why).toContain(String(expected));
      expect(decision.why).toContain('7');
      expectNoPlan(decision);
    }
  });

  test('a present expected ledger head is refused, after the revision check', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({
            expectedHead: { seq: 12, hash: 'abc123' },
            evidence: ['ev-entry', 'ev-timer'],
          }),
        }),
      ),
      'core.ledger-head-conflict',
      run,
    );
    expectNoPlan(decision);
  });

  test('the request id and the revision answer before a present expected head', () => {
    const head = { seq: 12, hash: 'abc123' };
    const original = envelopeOf({ expectedHead: head, evidence: ['ev-entry', 'ev-timer'] });
    const used = readyRun({
      revision: 3,
      requests: new Map([['req-1', { payloadDigest: requestDigest(original), step: 4 }]]),
    });
    const duplicate = decide(
      inputOf({
        run: used,
        envelope: envelopeOf({
          expectedRevision: 9,
          expectedHead: head,
          evidence: ['ev-entry', 'ev-timer'],
        }),
      }),
    );
    expect(duplicate.kind).toBe('duplicate');
    expectNoPlan(duplicate);

    const staleRun = readyRun({ revision: 3 });
    const stale = refused(
      decide(
        inputOf({
          run: staleRun,
          envelope: envelopeOf({
            requestId: 'req-fresh',
            expectedRevision: 5,
            expectedHead: head,
            evidence: ['ev-entry', 'ev-timer'],
          }),
        }),
      ),
      'core.revision-stale',
      staleRun,
    );
    expectNoPlan(stale);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Selector and scope.

describe('selector and scope', () => {
  test('a signal with no in-scope record is held and the run does not move', () => {
    const run = readyRun();
    const decision = held(
      decide(inputOf({ run, envelope: envelopeOf({ evidence: ['ev-entry'] }) })),
      'evidence.missing',
      run,
    );
    expectNoPlan(decision);
  });

  test('a same-type record for another target cannot satisfy the signal', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-timer': { type: 'timer', target: 'ticket-8', artifact: ARTIFACT },
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(decision);
  });

  test('a same-type record for another artifact cannot satisfy the signal', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-timer': {
              type: 'timer',
              target: TARGET,
              artifact: { kind: 'ref', value: 'tree-8' },
            },
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(decision);
  });

  test('two in-scope records for one signal are refused as ambiguous', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer', 'ev-timer-2'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-timer': TIMER,
            'ev-timer-2': { type: 'timer', target: TARGET, artifact: ARTIFACT },
          }),
        }),
      ),
      'core.evidence-ambiguous',
      run,
    );
    expectNoPlan(decision);
  });

  test('an out-of-scope record does not create ambiguity', () => {
    const run = readyRun();
    const decision = stepped(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer', 'ev-foreign'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-timer': TIMER,
            'ev-foreign': { type: 'timer', target: 'ticket-8', artifact: ARTIFACT },
          }),
        }),
      ),
    );
    expect(decision.transition).toEqual({ from: 'ready', to: 'resting', on: 'time-reached' });
  });

  test('an outcome signal requires its operation and the done result', () => {
    const definition = guardedDefinitionless();
    const run = runOf({ state: 'open' });
    const move: WorkflowEnvelope['move'] = {
      transition: { from: 'open', to: 'merged', on: 'pr-merged' },
    };
    const signal = { name: 'pr-merged' as SignalName, at: AT };

    const wrongOperation = held(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            definition: DEF,
            move,
            evidence: ['ev-publish'],
          }),
          signal,
          evidence: evidenceSource({
            'ev-publish': {
              type: 'outcome',
              result: 'done',
              operation: 'release-publish',
              effect: 'release-1',
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(wrongOperation);

    const wrongResult = held(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({ definition: DEF, move, evidence: ['ev-merge-refused'] }),
          signal,
          evidence: evidenceSource({
            'ev-merge-refused': {
              type: 'outcome',
              result: 'refused',
              operation: 'merge',
              effect: 'merge-1',
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(wrongResult);

    const done = stepped(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({ definition: DEF, move, evidence: ['ev-merge'] }),
          signal,
          evidence: evidenceSource({
            'ev-merge': {
              type: 'outcome',
              result: 'done',
              operation: 'merge',
              effect: 'merge-1',
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
    );
    expect(done.next).toEqual({ state: 'merged', activation: 2 });
  });

  test('a guard reads only its operation among in-scope records', () => {
    const definition = guardedDefinition('ci-green-on-head');
    const run = runOf({ state: 'open' });
    const envelope = envelopeOf({
      move: { transition: { from: 'open', to: 'merged', on: 'pr-merged' } },
      evidence: ['ev-merge', 'ev-ci'],
    });
    const signal = { name: 'pr-merged' as SignalName, at: AT };

    const none = held(
      decide(
        inputOf({
          definition,
          run,
          envelope,
          signal,
          guards: GUARDS,
          evidence: evidenceSource({
            'ev-merge': mergeRecord('done'),
            'ev-ci': {
              type: 'outcome',
              result: 'done',
              operation: 'ci-suite',
              effect: 'ci-1',
              target: 'ticket-8',
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(none);

    const ambiguous = refused(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'open', to: 'merged', on: 'pr-merged' } },
            evidence: ['ev-merge', 'ev-ci', 'ev-ci-2'],
          }),
          signal,
          guards: GUARDS,
          evidence: evidenceSource({
            'ev-merge': mergeRecord('done'),
            'ev-ci': ciRecord('done'),
            'ev-ci-2': ciRecord('done'),
          }),
        }),
      ),
      'core.evidence-ambiguous',
      run,
    );
    expectNoPlan(ambiguous);
  });

  test('a refused guard candidate is a guard refusal carrying its answer', () => {
    const definition = guardedDefinition('ci-green-on-head');
    const run = runOf({ state: 'open' });
    const decision = refused(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'open', to: 'merged', on: 'pr-merged' } },
            evidence: ['ev-merge', 'ev-ci'],
          }),
          signal: { name: 'pr-merged' as SignalName, at: AT },
          guards: GUARDS,
          evidence: evidenceSource({
            'ev-merge': mergeRecord('done'),
            'ev-ci': ciRecord('refused'),
          }),
        }),
      ),
      'core.guard-refused',
      run,
    );
    expect(decision.guard).toEqual({
      name: 'ci-green-on-head',
      answer: false,
      evidence: ['ev-ci'],
    });
    expectNoPlan(decision);
  });

  test('a passing guard answers true with its one record', () => {
    const definition = guardedDefinition('ci-green-on-head');
    const run = runOf({ state: 'open' });
    const decision = stepped(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'open', to: 'merged', on: 'pr-merged' } },
            evidence: ['ev-merge', 'ev-ci', 'ev-publish'],
          }),
          signal: { name: 'pr-merged' as SignalName, at: AT },
          guards: GUARDS,
          evidence: evidenceSource({
            'ev-merge': mergeRecord('done'),
            'ev-ci': ciRecord('done'),
            'ev-publish': {
              type: 'outcome',
              result: 'done',
              operation: 'release-publish',
              effect: 'publish-1',
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
    );
    expect(decision.guard).toEqual({ name: 'ci-green-on-head', answer: true, evidence: ['ev-ci'] });
    expect(decision.next).toEqual({ state: 'merged', activation: 2 });
  });

  test('an unknown guard name is refused', () => {
    const definition = guardedDefinition('no-such-guard');
    const run = runOf({ state: 'open' });
    const decision = refused(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'open', to: 'merged', on: 'pr-merged' } },
            evidence: ['ev-merge'],
          }),
          signal: { name: 'pr-merged' as SignalName, at: AT },
          guards: GUARDS,
          evidence: evidenceSource({ 'ev-merge': mergeRecord('done') }),
        }),
      ),
      'core.guard-unknown',
      run,
    );
    expectNoPlan(decision);
  });

  test('a cited ref that does not resolve is held awaiting that ref', () => {
    const run = readyRun();
    const decision = held(
      decide(inputOf({ run, envelope: envelopeOf({ evidence: ['ev-gone'] }) })),
      'evidence.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'evidence', ref: 'ev-gone' });
    expectNoPlan(decision);
  });

  test('a journal offered as evidence is non-authoritative', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-journal', 'ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            ...READY_EVIDENCE,
            'ev-journal': { kind: 'workflow-run-dry', type: 'timer', target: TARGET },
          }),
        }),
      ),
      'core.evidence-non-authoritative',
      run,
    );
    expectNoPlan(decision);
  });

  test('an unknown result is not a dry value and is refused', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-unknown', 'ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            ...READY_EVIDENCE,
            'ev-unknown': {
              type: 'outcome',
              result: 'unknown',
              operation: 'merge',
              effect: 'merge-1',
              target: TARGET,
              artifact: ARTIFACT,
            } as unknown as EvidenceRecord,
          }),
        }),
      ),
      'evidence.unknown',
      run,
    );
    expectNoPlan(decision);
  });

  test('a corrupt outcome record is refused', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-corrupt', 'ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            ...READY_EVIDENCE,
            'ev-corrupt': { type: 'outcome', result: 'done', effect: 'merge-1' },
          }),
        }),
      ),
      'evidence.corrupt',
      run,
    );
    expectNoPlan(decision);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Supplied entry-outcome gating.

describe('supplied entry-outcome gating', () => {
  test('leaving a state needs a successful supplied outcome for its entry effect', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-timer'] }),
          evidence: evidenceSource({ 'ev-timer': TIMER }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'entry-effect', occurrence: `${RUN}/1/notice-ready` });
    expectNoPlan(decision);
  });

  test('a refused supplied entry outcome holds the run', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': { ...ENTRY_OUTCOME, result: 'refused' },
            'ev-timer': TIMER,
          }),
        }),
      ),
      'core.entry-effect-failed',
      run,
    );
    expectNoPlan(decision);
  });

  test('two supplied outcomes for one entry occurrence are refused as ambiguous', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-entry-2', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-entry-2': { ...ENTRY_OUTCOME },
            'ev-timer': TIMER,
          }),
        }),
      ),
      'core.evidence-ambiguous',
      run,
    );
    expectNoPlan(decision);
  });

  test('an outcome for another operation does not answer the entry effect', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': { ...ENTRY_OUTCOME, operation: 'review-morning' },
            'ev-timer': TIMER,
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'entry-effect', occurrence: `${RUN}/1/notice-ready` });
  });

  test('an outcome for another artifact does not answer the entry effect', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': { ...ENTRY_OUTCOME, artifact: { kind: 'ref', value: 'tree-8' } },
            'ev-timer': TIMER,
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'entry-effect', occurrence: `${RUN}/1/notice-ready` });
  });

  test('an outcome for another occurrence does not answer the entry effect', () => {
    const run = readyRun();
    const decision = held(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': { ...ENTRY_OUTCOME, effect: `${RUN}/2/notice-ready` },
            'ev-timer': TIMER,
          }),
        }),
      ),
      'evidence.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'entry-effect', occurrence: `${RUN}/1/notice-ready` });
  });

  test('the entered state writes its own entry effects without supplied outcomes', () => {
    const run = readyRun();
    const decision = stepped(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
        }),
      ),
    );
    const entered = effectItems(decision).find((item) => item.effect === 'notice-resting');
    expect(entered).toBeDefined();
    expect(entered!.occurrence).toBe(`${RUN}/2/notice-resting`);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Flat waits.

describe('flat waits', () => {
  test('a signal that cannot fire a time wait is refused', () => {
    const definition = mixedWaitDefinition();
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'ready', to: 'rejected', on: 'approved' } },
            evidence: ['ev-approval'],
          }),
          signal: { name: 'approved' as SignalName, at: AT },
          evidence: evidenceSource({
            'ev-approval': {
              type: 'approval',
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
      'core.wait-pending',
      run,
    );
    expectNoPlan(decision);
  });

  test('the clock before the wait instant is refused', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer'] }),
          signal: { name: 'time-reached' as SignalName, at: BEFORE_WAIT },
        }),
      ),
      'core.wait-not-reached',
      run,
    );
    expectNoPlan(decision);
  });

  test('the clock at the wait instant moves the run', () => {
    const run = readyRun();
    const decision = stepped(decide(inputOf({ run })));
    expect(decision.transition).toEqual({ from: 'ready', to: 'resting', on: 'time-reached' });
    expect(decision.next).toEqual({ state: 'resting', activation: 2 });
  });

  test('a missing wait setting is held awaiting the setting', () => {
    const run = readyRun();
    const decision = held(
      decide(inputOf({ run, settings: settingsSource({}) })),
      'settings.missing',
      run,
    );
    expect(decision.waitingOn).toEqual({ kind: 'setting', name: 'ready-at' });
    expectNoPlan(decision);
  });

  test('a pending wait is refused even when the clock has reached it', () => {
    const run = readyRun({ waits: [{ state: 'ready', activation: 1, status: 'pending' }] });
    const decision = refused(decide(inputOf({ run })), 'core.wait-pending', run);
    expectNoPlan(decision);
  });

  test('the wait is found by state and activation, not by its position', () => {
    const run = readyRun({
      waits: [
        { state: 'resting', activation: 1, status: 'fired' },
        { state: 'ready', activation: 2, status: 'fired' },
        { state: 'ready', activation: 1, status: 'fired' },
      ],
    });
    const decision = stepped(decide(inputOf({ run })));
    expect(decision.next).toEqual({ state: 'resting', activation: 2 });
  });

  test('a wait stop is decided before entry-effect gating', () => {
    const run = readyRun();
    const decision = refused(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ evidence: ['ev-timer'] }),
          signal: { name: 'time-reached' as SignalName, at: BEFORE_WAIT },
          evidence: evidenceSource({ 'ev-timer': TIMER }),
        }),
      ),
      'core.wait-not-reached',
      run,
    );
    expectNoPlan(decision);
  });

  test('an approval wait moves on an in-scope approval record', () => {
    const definition = approvalDefinition();
    const run = runOf({
      state: 'reviewing',
      waits: [{ state: 'reviewing', activation: 1, status: 'fired' }],
    });
    const decision = stepped(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'reviewing', to: 'done', on: 'approved' } },
            evidence: ['ev-approval'],
          }),
          signal: { name: 'approved' as SignalName, at: AT },
          evidence: evidenceSource({
            'ev-approval': { type: 'approval', target: TARGET, artifact: ARTIFACT },
          }),
        }),
      ),
    );
    expect(decision.next).toEqual({ state: 'done', activation: 2 });
  });

  test('an approval wait without its record is held', () => {
    const definition = approvalDefinition();
    const run = runOf({
      state: 'reviewing',
      waits: [{ state: 'reviewing', activation: 1, status: 'fired' }],
    });
    const decision = held(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({
            move: { transition: { from: 'reviewing', to: 'done', on: 'approved' } },
            evidence: [],
          }),
          signal: { name: 'approved' as SignalName, at: AT },
          evidence: evidenceSource({}),
        }),
      ),
      'evidence.missing',
      run,
    );
    expectNoPlan(decision);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Occurrence invariants.

describe('occurrence invariants', () => {
  test('a step plans the entered state effect at the next activation and the entry itself', () => {
    const run = readyRun();
    const decision = stepped(decide(inputOf({ run })));
    expect(decision.revision).toBe(0);
    expect(decision.nextRevision).toBe(1);
    expect(decision.at).toBe(AT);
    expect(decision.signal).toBe('time-reached');
    expect(decision.requestId).toBe('req-1');
    expect(decision.transition).toEqual({ from: 'ready', to: 'resting', on: 'time-reached' });
    expect(decision.next).toEqual({ state: 'resting', activation: 2 });
    expect(decision.plan).toHaveLength(2);

    const entry = decision.plan[0]!;
    expect(entry).toEqual({
      kind: 'state-entry',
      from: 'ready',
      to: 'resting',
      on: 'time-reached',
      revision: 1,
    });

    const planned = effectItems(decision)[0]!;
    expect(planned).toEqual({
      kind: 'effect',
      phase: 'enter',
      effect: 'notice-resting',
      operation: 'release-notes',
      role: 'operator',
      capability: 'write',
      reach: 'local',
      target: TARGET,
      artifact: ARTIFACT,
      occurrence: `${RUN}/2/notice-resting`,
      payload: canonicalEffectPayload('notice-resting', 'release-notes', TARGET, ARTIFACT),
      digest: payloadDigest(canonicalEffectPayload('notice-resting', 'release-notes', TARGET, ARTIFACT)),
    });
    expect(Object.hasOwn(planned, 'dispatched')).toBe(false);
  });

  test('exit hooks, the state entry and enter hooks are planned in declared order', () => {
    const definition = planOrderDefinition();
    const run = readyRun();
    const decision = stepped(decide(inputOf({ definition, run })));
    const order = decision.plan.map((item) =>
      item.kind === 'effect' ? `${item.phase}:${item.effect}` : `entry:${item.to}`,
    );
    expect(order).toEqual([
      'exit:close-a',
      'exit:close-b',
      'entry:resting',
      'enter:greet-a',
      'enter:greet-b',
    ]);
    const items = effectItems(decision);
    expect(items.map((item) => item.occurrence)).toEqual([
      `${RUN}/1/close-a`,
      `${RUN}/1/close-b`,
      `${RUN}/2/greet-a`,
      `${RUN}/2/greet-b`,
    ]);
  });

  test('an exit occurrence from an earlier attempt is not re-planned but needs its outcome', () => {
    const definition = planOrderDefinition();
    const run = readyRun({
      occurrences: [
        occurrenceOf('notice-ready', 1, 'ready', 'release-notes'),
        occurrenceOf('close-a', 1, 'ready', 'round-close-hold'),
      ],
    });
    const decision = stepped(
      decide(
        inputOf({
          definition,
          run,
          envelope: envelopeOf({ evidence: ['ev-entry', 'ev-timer', 'ev-close'] }),
          evidence: evidenceSource({
            'ev-entry': ENTRY_OUTCOME,
            'ev-timer': TIMER,
            'ev-close': {
              type: 'outcome',
              result: 'done',
              operation: 'round-close-hold',
              effect: `${RUN}/1/close-a`,
              target: TARGET,
              artifact: ARTIFACT,
            },
          }),
        }),
      ),
    );
    const order = decision.plan.map((item) =>
      item.kind === 'effect' ? `${item.phase}:${item.effect}` : `entry:${item.to}`,
    );
    expect(order).toEqual(['exit:close-b', 'entry:resting', 'enter:greet-a', 'enter:greet-b']);
    expect(run.occurrences.size).toBe(2);
  });

  test('an existing occurrence with the same payload is returned, not reassigned', () => {
    const definition = planOrderDefinition();
    const existing = occurrenceOf('greet-a', 2, 'resting', 'review-morning');
    const run = readyRun({ occurrences: [occurrenceOf('notice-ready', 1, 'ready', 'release-notes'), existing] });
    const decision = stepped(decide(inputOf({ definition, run })));
    const planned = effectItems(decision).filter((item) => item.effect === 'greet-a');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.occurrence).toBe(existing.id);
    expect(planned[0]!.digest).toBe(existing.payloadDigest);
  });

  test('an existing occurrence with a different payload is refused', () => {
    const definition = planOrderDefinition();
    const run = readyRun({
      occurrences: [
        occurrenceOf('notice-ready', 1, 'ready', 'release-notes'),
        occurrenceOf('greet-a', 2, 'resting', 'review-morning', WRONG_DIGEST),
      ],
    });
    const decision = refused(
      decide(inputOf({ definition, run })),
      'core.occurrence-payload-conflict',
      run,
    );
    expect(decision.why).toContain(`${RUN}/2/greet-a`);
    expectNoPlan(decision);
    expect(run.occurrences.get(`${RUN}/2/greet-a`)!.payloadDigest).toBe(WRONG_DIGEST);
  });

  test('activation is a per-run high-water mark', () => {
    const run = readyRun({
      revision: 2,
      activation: 3,
      occurrences: [occurrenceOf('notice-ready', 3, 'ready', 'release-notes')],
      waits: [{ state: 'ready', activation: 3, status: 'fired' }],
    });
    const decision = stepped(
      decide(
        inputOf({
          run,
          envelope: envelopeOf({ expectedRevision: 2, evidence: ['ev-entry', 'ev-timer'] }),
          evidence: evidenceSource({
            'ev-entry': { ...ENTRY_OUTCOME, effect: `${RUN}/3/notice-ready` },
            'ev-timer': TIMER,
          }),
        }),
      ),
    );
    expect(decision.next).toEqual({ state: 'resting', activation: 4 });
    const planned = effectItems(decision)[0]!;
    expect(planned.occurrence).toBe(`${RUN}/4/notice-resting`);
    expect(decision.plan[0]).toEqual({
      kind: 'state-entry',
      from: 'ready',
      to: 'resting',
      on: 'time-reached',
      revision: 3,
    });
  });

  test('deciding is pure and every effect stays undispatched', () => {
    const run = readyRun();
    const input = inputOf({ run });
    const first = decide(input);
    const second = decide(input);
    expect(second).toEqual(first);
    expect(run.occurrences.size).toBe(1);
    expect(run.requests.size).toBe(0);
    expect(run.waits).toHaveLength(1);
    for (const item of stepped(first).plan) {
      expect(Object.hasOwn(item, 'dispatched')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Shared recorded shapes for the outcome-signal tests.

function mergeRecord(result: 'done' | 'refused'): EvidenceRecord {
  return {
    type: 'outcome',
    result,
    operation: 'merge',
    effect: 'merge-1',
    target: TARGET,
    artifact: ARTIFACT,
  };
}

function ciRecord(result: 'done' | 'refused'): EvidenceRecord {
  return {
    type: 'outcome',
    result,
    operation: 'ci-suite',
    effect: 'ci-1',
    target: TARGET,
    artifact: ARTIFACT,
  };
}

/** The unguarded pr-merged graph used to isolate the signal selector from guard behavior. */
function guardedDefinitionless(): Workflow {
  return definitionOf({
    initial: 'open',
    states: { open: workflowState('open'), merged: workflowState('merged') },
    transitions: [transition('open', 'merged', 'pr-merged')],
    effects: {},
  });
}
