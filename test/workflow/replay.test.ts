import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  canonicalEffectPayload,
  canonicalRequestPayload,
  occurrenceId,
  payloadDigest,
} from '../../src/workflow/canonical.ts';
import { DECISION_CODES } from '../../src/workflow/codes.ts';
import { decide } from '../../src/workflow/core.ts';
import type { RunState } from '../../src/workflow/core-state.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import type { GuardCatalogue } from '../../src/workflow/registry.ts';
import { readJournal, replay } from '../../src/workflow/replay.ts';
import type { ReplayFailure, ReplayResult } from '../../src/workflow/replay.ts';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { SignalName } from '../../src/workflow/signals.ts';
import type {
  ArtifactRef,
  DefinitionId,
  DryEffectRecord,
  DryRunJournal,
  EvidenceDocument,
  EvidenceRecord,
  EvidenceRef,
  WaitingOn,
  Workflow,
  WorkflowEnvelope,
} from '../../src/workflow/types.ts';

const RUN = 'run-1';
const TARGET = 'refs/heads/release-0.5.4';
const ARTIFACT: ArtifactRef = { kind: 'ref', value: 'v0.5.4' };
const AT = '2026-10-21T12:00:00Z';
const NOTICE = 'dry run — no record is written';

// ---------------------------------------------------------------------------------------------
// The worlds: parsed definitions with their real content pin, plus the run's fixed inputs.

const DEMO = `workflow: replay-demo
version: 1
initial: prep
on:
  release.ready: prep
inputs: [version]
states:
  prep:
    on-enter: [build]
    on-leave: [record]
  reviewed:
    wait: { for: approval, role: owner }
    on-enter: [notify]
    on-leave: [cleanup]
  done: {}
effects:
  build: { run: build, capability: write, role: operator }
  record: { run: record, capability: write, role: operator }
  notify: { run: notify, capability: write, role: operator }
  cleanup: { run: cleanup, capability: write, role: operator }
transitions:
  - { from: prep, to: reviewed, on: gate-passed, role: integrator }
  - { from: reviewed, to: done, on: approved, role: owner }
`;

const GUARDED = `workflow: replay-guard
version: 1
initial: prep
states:
  prep:
    on-enter: [build]
  ready: {}
effects:
  build: { run: build, capability: write, role: operator }
transitions:
  - { from: prep, to: ready, on: gate-passed, guard: ci-green-on-head, role: integrator }
`;

const UNKNOWN_GUARD = `workflow: replay-guard-unknown
version: 1
initial: prep
states:
  prep:
    on-enter: [build]
  ready: {}
effects:
  build: { run: build, capability: write, role: operator }
transitions:
  - { from: prep, to: ready, on: gate-passed, guard: no-such-guard, role: integrator }
`;

const TIME = `workflow: replay-time
version: 1
initial: waiting
on:
  release.ready: waiting
states:
  waiting:
    wait: { for: time, at: release-slot }
  done: {}
transitions:
  - { from: waiting, to: done, on: time-reached, role: integrator }
`;

const APPROVAL_ALT = `workflow: replay-approval-alt
version: 1
initial: prep
states:
  prep:
    on-enter: [build]
    on-leave: [record]
  reviewed:
    wait: { for: approval, role: owner }
    on-enter: [notify]
    on-leave: [cleanup]
  done: {}
effects:
  build: { run: build, capability: write, role: operator }
  record: { run: record, capability: write, role: operator }
  notify: { run: notify, capability: write, role: operator }
  cleanup: { run: cleanup, capability: write, role: operator }
transitions:
  - { from: prep, to: reviewed, on: gate-passed, role: integrator }
  - { from: reviewed, to: done, on: gate-passed, role: integrator }
  - { from: reviewed, to: done, on: approved, role: owner }
`;

const LOOP = `workflow: replay-loop
version: 1
initial: loop
on:
  release.ready: loop
states:
  loop:
    on-enter: [tick]
effects:
  tick: { run: tick, capability: write, role: operator }
transitions:
  - { from: loop, to: loop, on: accepted, role: integrator }
`;

const SOLO = `workflow: replay-solo
version: 1
initial: only
states:
  only: {}
transitions: []
`;

const USES = `workflow: replay-uses
version: 1
initial: child
states:
  child:
    uses: library
transitions: []
`;

const BAD_REF = `workflow: replay-bad
version: 1
initial: a
states:
  a: {}
transitions:
  - { from: a, to: missing, on: gate-passed, role: integrator }
`;

type World = {
  source: string;
  workflow: Workflow;
  definition: DefinitionId;
  run: string;
  target: string;
  artifact: ArtifactRef;
  settings: Record<string, string>;
  inputs: Record<string, string>;
};

function world(source: string, settings: Record<string, string> = {}): World {
  const parsed = parseWorkflow(source);
  if (!('workflow' in parsed)) {
    throw new Error(`fixture definition did not parse: ${JSON.stringify(parsed)}`);
  }
  return {
    source,
    workflow: parsed.workflow,
    definition: parsed.definition,
    run: RUN,
    target: TARGET,
    artifact: ARTIFACT,
    settings,
    inputs: { version: '0.5.4' },
  };
}

function effectRecord(
  fixture: World,
  name: string,
  state: string,
  activation: number,
  outcome?: EvidenceRef,
): DryEffectRecord {
  const effect = fixture.workflow.effects[name]!;
  return {
    name,
    state,
    activation,
    occurrence: occurrenceId(fixture.run, activation, name),
    payloadDigest: payloadDigest(
      canonicalEffectPayload(name, effect.run.name, fixture.target, fixture.artifact),
    ),
    ...(outcome !== undefined ? { outcome } : {}),
    dispatched: false,
  };
}

function entryEffects(fixture: World, stateName: string, activation: number): DryEffectRecord[] {
  return fixture.workflow.states[stateName]!.onEnter.map((hook) =>
    effectRecord(fixture, hook.name, stateName, activation),
  );
}

function journalOf(
  fixture: World,
  parts: Partial<Pick<DryRunJournal, 'initial' | 'settings' | 'steps' | 'outcome'>> & {
    start?: DryEffectRecord[];
  } = {},
): DryRunJournal {
  const initial = parts.initial ?? fixture.workflow.initial!;
  return {
    format: 1,
    kind: 'workflow-run-dry',
    authoritative: false,
    notice: NOTICE,
    definition: fixture.definition,
    run: fixture.run,
    target: fixture.target,
    artifact: fixture.artifact,
    inputs: fixture.inputs,
    settings: parts.settings ?? fixture.settings,
    initial,
    start: { state: initial, activation: 1, effects: parts.start ?? entryEffects(fixture, initial, 1) },
    steps: parts.steps ?? [],
    outcome: parts.outcome ?? { kind: 'script-exhausted' },
  };
}

type StepParts = {
  revision: number;
  activation: number;
  from: string;
  to: string;
  signal: SignalName;
  requestId: string;
  evidence: EvidenceRef[];
  effects: DryEffectRecord[];
  guard?: { name: string; answer: boolean; evidence: EvidenceRef[] };
  at?: string;
  requestDigest?: `sha256:${string}`;
  /** A recorded transition that may deliberately disagree with the enabled one. */
  transition?: { from: string; to: string; on: SignalName };
};

function stepOf(fixture: World, parts: StepParts): DryRunJournal['steps'][number] {
  const enabled = { from: parts.from, to: parts.to, on: parts.signal };
  const envelope: WorkflowEnvelope = {
    format: 1,
    run: fixture.run,
    definition: fixture.definition,
    expectedRevision: parts.revision - 1,
    requestId: parts.requestId,
    move: { transition: enabled },
    target: fixture.target,
    artifact: fixture.artifact,
    evidence: parts.evidence,
  };
  return {
    revision: parts.revision,
    at: parts.at ?? AT,
    signal: parts.signal,
    requestId: parts.requestId,
    requestDigest: parts.requestDigest ?? payloadDigest(canonicalRequestPayload(envelope)),
    transition: parts.transition ?? enabled,
    activation: parts.activation,
    evidence: parts.evidence,
    ...(parts.guard !== undefined ? { guard: parts.guard } : {}),
    effects: parts.effects,
  };
}

function outcomeRecord(
  fixture: World,
  occurrence: string,
  operation: string,
  result: 'done' | 'refused' = 'done',
  artifact: ArtifactRef = fixture.artifact,
): EvidenceRecord {
  return {
    type: 'outcome',
    operation,
    result,
    effect: occurrence,
    target: fixture.target,
    artifact,
  };
}

function gateRecord(fixture: World): EvidenceRecord {
  return { type: 'gate', target: fixture.target };
}

function reviewRecord(fixture: World): EvidenceRecord {
  return { type: 'review', target: fixture.target };
}

function approvalRecord(fixture: World): EvidenceRecord {
  return { type: 'approval', target: fixture.target };
}

function timerRecord(fixture: World): EvidenceRecord {
  return { type: 'timer', target: fixture.target };
}

function ciRecord(fixture: World, result: 'done' | 'refused' = 'done'): EvidenceRecord {
  return {
    type: 'outcome',
    operation: 'ci-suite',
    result,
    effect: 'ci-run-1',
    target: fixture.target,
    artifact: fixture.artifact,
  };
}

function buildDone(fixture: World, activation = 1): EvidenceDocument {
  return {
    'build-done': outcomeRecord(
      fixture,
      occurrenceId(fixture.run, activation, 'build'),
      'build',
    ),
  };
}

function runReplay(
  fixture: World,
  journal: DryRunJournal,
  evidence: EvidenceDocument,
  guards: GuardCatalogue = provisionalResolvers().guards,
): ReplayResult {
  return replay({
    definitionBytes: new TextEncoder().encode(fixture.source),
    definition: fixture.workflow,
    journal,
    evidence,
    guards,
    decide,
  });
}

function okRun(result: ReplayResult): RunState {
  if (!result.ok) throw new Error(`expected a replayed run, got ${JSON.stringify(result.fail)}`);
  return result.run;
}

function failed(result: ReplayResult, code: ReplayFailure['code'], step?: number): ReplayFailure {
  if (result.ok) throw new Error('expected a replay failure');
  expect(result.fail.code).toBe(code);
  if (step !== undefined) expect(result.fail.step).toBe(step);
  return result.fail;
}

function snapshot(run: RunState) {
  return {
    runId: run.runId,
    definitionId: run.definitionId,
    state: run.state,
    revision: run.revision,
    activation: run.activation,
    occurrences: [...run.occurrences],
    requests: [...run.requests],
    waits: run.waits,
    blocked: run.blocked ?? null,
  };
}

// Common journal pieces for the demo definition.

function demoStep0(fixture: World, overrides: Partial<StepParts> = {}) {
  return stepOf(fixture, {
    revision: 1,
    activation: 2,
    from: 'prep',
    to: 'reviewed',
    signal: 'gate-passed',
    requestId: 'req-1',
    evidence: ['gate-1', 'build-done'],
    effects: [
      effectRecord(fixture, 'record', 'prep', 1),
      effectRecord(fixture, 'notify', 'reviewed', 2),
    ],
    ...overrides,
  });
}

function demoStep1(fixture: World, overrides: Partial<StepParts> = {}) {
  return stepOf(fixture, {
    revision: 2,
    activation: 3,
    from: 'reviewed',
    to: 'done',
    signal: 'approved',
    requestId: 'req-2',
    evidence: ['approval-1', 'notify-done'],
    effects: [effectRecord(fixture, 'cleanup', 'reviewed', 2)],
    ...overrides,
  });
}

function demoEvidence(fixture: World): EvidenceDocument {
  return {
    'gate-1': gateRecord(fixture),
    'build-done': outcomeRecord(fixture, occurrenceId(fixture.run, 1, 'build'), 'build'),
  };
}

function demoEvidence2(fixture: World): EvidenceDocument {
  return {
    'approval-1': approvalRecord(fixture),
    'notify-done': outcomeRecord(fixture, occurrenceId(fixture.run, 2, 'notify'), 'notify'),
  };
}

function guardEvidence(fixture: World, ciResult: 'done' | 'refused' = 'done'): EvidenceDocument {
  return {
    'gate-1': gateRecord(fixture),
    'build-done': outcomeRecord(fixture, occurrenceId(fixture.run, 1, 'build'), 'build'),
    'ci-1': ciRecord(fixture, ciResult),
  };
}

function loopStep0(fixture: World, overrides: Partial<StepParts> = {}) {
  return stepOf(fixture, {
    revision: 1,
    activation: 2,
    from: 'loop',
    to: 'loop',
    signal: 'accepted',
    requestId: 'req-1',
    evidence: ['review-1', 'tick-1-done'],
    effects: [effectRecord(fixture, 'tick', 'loop', 2)],
    ...overrides,
  });
}

function loopStep1(fixture: World, overrides: Partial<StepParts> = {}) {
  return stepOf(fixture, {
    revision: 2,
    activation: 3,
    from: 'loop',
    to: 'loop',
    signal: 'accepted',
    requestId: 'req-2',
    evidence: ['review-1', 'tick-2-done'],
    effects: [effectRecord(fixture, 'tick', 'loop', 3)],
    ...overrides,
  });
}

function loopEvidence(fixture: World): EvidenceDocument {
  return {
    'review-1': reviewRecord(fixture),
    'tick-1-done': outcomeRecord(fixture, occurrenceId(fixture.run, 1, 'tick'), 'tick'),
    'tick-2-done': outcomeRecord(fixture, occurrenceId(fixture.run, 2, 'tick'), 'tick'),
  };
}

function timeStep0(fixture: World, overrides: Partial<StepParts> = {}) {
  return stepOf(fixture, {
    revision: 1,
    activation: 2,
    from: 'waiting',
    to: 'done',
    signal: 'time-reached',
    requestId: 'req-1',
    evidence: ['timer-1'],
    effects: [],
    ...overrides,
  });
}

type StopParts = {
  decision: 'held' | 'refused';
  code: string;
  state?: string;
  revision?: number;
  expectedRevision?: number;
  signal?: SignalName | null;
  requestId?: string | null;
  evidence: EvidenceRef[];
  waitingOn?: WaitingOn;
  guard?: { name: string; answer: boolean; evidence: EvidenceRef[] };
  at?: string;
  settings?: Record<string, string>;
  steps?: DryRunJournal['steps'];
};

function stopped(fixture: World, parts: StopParts): DryRunJournal {
  const signal = parts.signal === null ? undefined : (parts.signal ?? 'gate-passed');
  const requestId = parts.requestId === null ? undefined : (parts.requestId ?? 'req-stop');
  const outcome = {
    kind: 'stopped' as const,
    decision: parts.decision,
    code: parts.code,
    why: 'the recorded stopping decision',
    at: parts.at ?? AT,
    state: parts.state ?? fixture.workflow.initial!,
    revision: parts.revision ?? 0,
    ...(parts.waitingOn !== undefined ? { waitingOn: parts.waitingOn } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    // A request-derived stop records the request's own precondition; a request-less stop carries
    // none, so it stays distinct.
    ...(signal !== undefined && requestId !== undefined
      ? { expectedRevision: parts.expectedRevision ?? parts.revision ?? 0 }
      : {}),
    evidence: parts.evidence,
    ...(parts.guard !== undefined ? { guard: parts.guard } : {}),
  };
  return journalOf(fixture, { steps: parts.steps, settings: parts.settings, outcome });
}

// ---------------------------------------------------------------------------------------------
// The reader: shape, closed keys and the non-authoritative markers.

describe('readJournal', () => {
  const demo = world(DEMO);

  test('reads the journal the runner writes, round-tripping every field', () => {
    const journal = journalOf(demo, { steps: [demoStep0(demo), demoStep1(demo)] });
    const read = readJournal(JSON.stringify(journal));
    if (!read.ok) throw new Error(read.why);
    expect(read.journal).toEqual(journal);
  });

  test('refuses text that is not JSON', () => {
    const read = readJournal('{ not json');
    if (read.ok) throw new Error('expected a refusal');
    expect(read.code).toBe('workflow.journal');
    expect(read.why).toContain('not valid JSON');
  });

  test('refuses a missing required field', () => {
    const journal = journalOf(demo);
    const { steps: _steps, ...withoutSteps } = journal;
    const read = readJournal(JSON.stringify(withoutSteps));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('missing "steps"');
  });

  test('refuses an unknown top-level key', () => {
    const read = readJournal(JSON.stringify({ ...journalOf(demo), extra: true }));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('unknown key "extra"');
  });

  test('refuses an authoritative journal marker', () => {
    const read = readJournal(JSON.stringify({ ...journalOf(demo), authoritative: true }));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('non-authoritative');
  });

  test('refuses a different notice', () => {
    const read = readJournal(JSON.stringify({ ...journalOf(demo), notice: 'dry run' }));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('notice');
  });

  test('refuses the wrong kind or format', () => {
    const wrongKind = readJournal(JSON.stringify({ ...journalOf(demo), kind: 'workflow-run' }));
    if (wrongKind.ok) throw new Error('expected a refusal');
    expect(wrongKind.why).toContain('kind');
    const wrongFormat = readJournal(JSON.stringify({ ...journalOf(demo), format: 2 }));
    if (wrongFormat.ok) throw new Error('expected a refusal');
    expect(wrongFormat.why).toContain('format');
  });

  test('refuses a dispatched effect record', () => {
    const journal = journalOf(demo);
    const effects = [{ ...journal.start.effects[0]!, dispatched: true }];
    const read = readJournal(JSON.stringify({ ...journal, start: { ...journal.start, effects } }));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('dispatched must be false');
  });

  test('refuses a signal outside the closed twelve', () => {
    const step = { ...demoStep0(demo), signal: 'release.ready' };
    const read = readJournal(JSON.stringify(journalOf(demo, { steps: [step as never] })));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('twelve transition signals');
  });

  test('refuses a mistyped waitingOn', () => {
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
      waitingOn: { kind: 'evidence', ref: 7 } as never,
    });
    const read = readJournal(JSON.stringify(journal));
    if (read.ok) throw new Error('expected a refusal');
    expect(read.why).toContain('outcome.waitingOn.ref');
  });

  test('refuses a malformed digest and a start that disagrees with initial', () => {
    const step = { ...demoStep0(demo), requestDigest: 'sha256:short' };
    const digestRead = readJournal(JSON.stringify(journalOf(demo, { steps: [step as never] })));
    if (digestRead.ok) throw new Error('expected a refusal');
    expect(digestRead.why).toContain('sha256');

    const journal = journalOf(demo);
    const start = { ...journal.start, state: 'reviewed' };
    const startRead = readJournal(JSON.stringify({ ...journal, start }));
    if (startRead.ok) throw new Error('expected a refusal');
    expect(startRead.why).toContain('start.state');
  });
});

// ---------------------------------------------------------------------------------------------
// Inputs: the definition pin, the evidence document and the start entry.

describe('replay inputs', () => {
  test('a definition digest mismatch is workflow.definition', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo);
    const result = replay({
      definitionBytes: new TextEncoder().encode(`${demo.source}\n# changed\n`),
      definition: demo.workflow,
      journal,
      evidence: {},
      guards: provisionalResolvers().guards,
      decide,
    });
    failed(result, 'workflow.definition');
  });

  test('unreadable definition bytes are workflow.definition', () => {
    const demo = world(DEMO);
    const result = replay({
      definitionBytes: new Uint8Array([0xff, 0xfe, 0xfd]),
      definition: demo.workflow,
      journal: journalOf(demo),
      evidence: {},
      guards: provisionalResolvers().guards,
      decide,
    });
    failed(result, 'workflow.definition');
  });

  test('a structurally invalid definition is workflow.definition', () => {
    const bad = world(BAD_REF);
    const result = runReplay(bad, journalOf(bad, { initial: 'a' }), {});
    failed(result, 'workflow.definition');
  });

  test('a journal starting in an undeclared state is workflow.journal', () => {
    const demo = world(DEMO);
    const result = runReplay(demo, journalOf(demo, { initial: 'nowhere', start: [] }), {});
    failed(result, 'workflow.journal');
  });

  test('a reachable uses state is workflow.uses-deferred', () => {
    const uses = world(USES);
    const result = runReplay(uses, journalOf(uses), {});
    failed(result, 'workflow.uses-deferred');
  });

  test('a cited evidence ref missing from the document is workflow.evidence', () => {
    const demo = world(DEMO);
    const result = runReplay(
      demo,
      journalOf(demo, { steps: [demoStep0(demo)] }),
      { 'build-done': demoEvidence(demo)['build-done']! },
    );
    failed(result, 'workflow.evidence');
  });

  test('a cited evidence record that is not an object or has no type is workflow.evidence', () => {
    const demo = world(DEMO);
    const base = demoEvidence(demo);
    const notObject = runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), {
      ...base,
      'gate-1': 5 as never,
    });
    failed(notObject, 'workflow.evidence');
    const noType = runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), {
      ...base,
      'gate-1': { target: TARGET } as never,
    });
    failed(noType, 'workflow.evidence');
  });

  test('a non-object evidence document is workflow.evidence', () => {
    const demo = world(DEMO);
    const result = runReplay(demo, journalOf(demo), [] as never);
    failed(result, 'workflow.evidence');
  });
});

// ---------------------------------------------------------------------------------------------
// The start entry and the trivial fold.

describe('the start entry', () => {
  test('A1 a one-state graph with no effects folds to revision 0 and the start state', () => {
    const solo = world(SOLO);
    const run = okRun(runReplay(solo, journalOf(solo), {}));
    expect(run.state).toBe('only');
    expect(run.revision).toBe(0);
    expect(run.activation).toBe(1);
    expect(run.occurrences.size).toBe(0);
    expect(run.requests.size).toBe(0);
    expect(run.waits).toEqual([]);
    expect(run.blocked).toBeUndefined();
  });

  test('the start records the initial entry hooks at activation 1', () => {
    const demo = world(DEMO);
    const run = okRun(runReplay(demo, journalOf(demo), {}));
    expect(run.state).toBe('prep');
    expect(run.activation).toBe(1);
    expect([...run.occurrences.values()]).toEqual([
      {
        id: occurrenceId(RUN, 1, 'build'),
        effect: 'build',
        state: 'prep',
        activation: 1,
        payloadDigest: payloadDigest(
          canonicalEffectPayload('build', demo.workflow.effects.build!.run.name, TARGET, ARTIFACT),
        ),
      },
    ]);
  });

  test('a start occurrence that disagrees with the definition is a mismatch at -1', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo);
    const wrongName = [{ ...journal.start.effects[0]!, name: 'notify' }];
    const fail = failed(
      runReplay(demo, { ...journal, start: { ...journal.start, effects: wrongName } }, {}),
      'workflow.replay-mismatch',
      -1,
    );
    expect(fail.expected).toMatchObject({ name: 'build', state: 'prep', activation: 1 });
    expect(fail.actual).toMatchObject({ name: 'notify', state: 'prep', activation: 1 });
  });

  test('a tampered start payload digest is a mismatch at -1', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo);
    const digest: `sha256:${string}` = `sha256:${'0'.repeat(64)}`;
    const tampered = [{ ...journal.start.effects[0]!, payloadDigest: digest }];
    const fail = failed(
      runReplay(demo, { ...journal, start: { ...journal.start, effects: tampered } }, {}),
      'workflow.replay-mismatch',
      -1,
    );
    expect(fail.actual).toMatchObject({ payloadDigest: digest });
  });

  test('an extra start effect is a mismatch at -1', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo);
    const extra = [...journal.start.effects, effectRecord(demo, 'notify', 'prep', 1)];
    failed(
      runReplay(demo, { ...journal, start: { ...journal.start, effects: extra } }, {}),
      'workflow.replay-mismatch',
      -1,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Accepted steps: state, revision, activation, requests, occurrences, waits.

describe('accepted steps', () => {
  test('A2 a transition applies its revision, activation, request and occurrences', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo);
    const run = okRun(runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)));
    expect(run.state).toBe('reviewed');
    expect(run.revision).toBe(1);
    expect(run.activation).toBe(2);
    expect(run.requests.get('req-1')).toEqual({ payloadDigest: step.requestDigest, step: 0 });
    expect(run.occurrences.size).toBe(3);
    expect(run.occurrences.get(occurrenceId(RUN, 1, 'record'))).toMatchObject({
      effect: 'record',
      state: 'prep',
      activation: 1,
    });
    expect(run.occurrences.get(occurrenceId(RUN, 2, 'notify'))).toMatchObject({
      effect: 'notify',
      state: 'reviewed',
      activation: 2,
    });
  });

  test('a two-step run folds the approval wait to fired and ends in done', () => {
    const demo = world(DEMO);
    const s0 = demoStep0(demo);
    const s1 = demoStep1(demo);
    const evidence = { ...demoEvidence(demo), ...demoEvidence2(demo) };
    const run = okRun(runReplay(demo, journalOf(demo, { steps: [s0, s1] }), evidence));
    expect(run.state).toBe('done');
    expect(run.revision).toBe(2);
    expect(run.activation).toBe(3);
    expect(run.occurrences.size).toBe(4);
    expect(run.requests.get('req-2')).toEqual({ payloadDigest: s1.requestDigest, step: 1 });
    expect(run.waits).toEqual([{ state: 'reviewed', activation: 2, status: 'fired' }]);
    expect(run.blocked).toBeUndefined();
  });

  test('A5 the effect record names the supplied outcome that released the state', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo, { steps: [demoStep0(demo)] });
    const start = {
      ...journal.start,
      effects: [{ ...journal.start.effects[0]!, outcome: 'build-done' }],
    };
    const run = okRun(runReplay(demo, { ...journal, start }, demoEvidence(demo)));
    expect(run.state).toBe('reviewed');
  });

  test('A6 a self-loop allocates a new activation and new occurrences at each step', () => {
    const loop = world(LOOP);
    const s0 = loopStep0(loop);
    const s1 = loopStep1(loop);
    const run = okRun(runReplay(loop, journalOf(loop, { steps: [s0, s1] }), loopEvidence(loop)));
    expect(run.state).toBe('loop');
    expect(run.revision).toBe(2);
    expect(run.activation).toBe(3);
    expect([...run.occurrences.keys()]).toEqual([
      occurrenceId(RUN, 1, 'tick'),
      occurrenceId(RUN, 2, 'tick'),
      occurrenceId(RUN, 3, 'tick'),
    ]);
  });

  test('step and occurrence counts add nothing and the journal is not mutated', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo, { steps: [demoStep0(demo), demoStep1(demo)] });
    const before = JSON.stringify(journal);
    const evidence = { ...demoEvidence(demo), ...demoEvidence2(demo) };
    const run = okRun(runReplay(demo, journal, evidence));
    expect(JSON.stringify(journal)).toBe(before);
    expect(run.occurrences.size).toBe(1 + journal.steps[0]!.effects.length + journal.steps[1]!.effects.length);
    expect(run.requests.size).toBe(2);
    expect(run.revision).toBe(journal.steps.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Step divergences: the first difference is reported with its zero-based index.

describe('step divergences', () => {
  test('C8 a revision gap is a mismatch at that step', () => {
    const demo = world(DEMO);
    const step = { ...demoStep0(demo), revision: 2 };
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.expected).toEqual({ revision: 1 });
    expect(fail.actual).toEqual({ revision: 2 });
  });

  test('C10 a wrong activation is a mismatch at that step', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo, { activation: 3 });
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.expected).toEqual({ activation: 2 });
    expect(fail.actual).toEqual({ activation: 3 });
  });

  test('C9 a signal the definition does not accept at this state is a mismatch', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo, { signal: 'accepted' });
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.why).toContain('0 transitions');
  });

  test('C9 a recorded transition that differs from the enabled one is a mismatch', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo, { transition: { from: 'reviewed', to: 'done', on: 'gate-passed' } });
    failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
  });

  test('C11 a request digest that does not match the reconstructed envelope is a mismatch', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo, { requestDigest: `sha256:${'1'.repeat(64)}` });
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ requestDigest: step.requestDigest });
    expect((fail.expected as { requestDigest: string }).requestDigest).not.toBe(step.requestDigest);
  });

  test('C12 a tampered occurrence id or payload digest is a mismatch', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo);
    const effects = [{ ...step.effects[0]!, occurrence: `${RUN}/9/record` }, step.effects[1]!];
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [{ ...step, effects }] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ occurrence: `${RUN}/9/record` });

    const digest: `sha256:${string}` = `sha256:${'2'.repeat(64)}`;
    const effects2 = [{ ...step.effects[0]!, payloadDigest: digest }, step.effects[1]!];
    failed(
      runReplay(demo, journalOf(demo, { steps: [{ ...step, effects: effects2 }] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
  });

  test('a swapped effect order is a mismatch', () => {
    const demo = world(DEMO);
    const step = demoStep0(demo);
    const effects = [step.effects[1]!, step.effects[0]!];
    failed(
      runReplay(demo, journalOf(demo, { steps: [{ ...step, effects }] }), demoEvidence(demo)),
      'workflow.replay-mismatch',
      0,
    );
  });

  test('C13 a reused request id with an identical payload re-evaluates as a duplicate', () => {
    const loop = world(LOOP);
    const s0 = loopStep0(loop);
    const s1 = loopStep1(loop, {
      requestId: 'req-1',
      evidence: s0.evidence,
      requestDigest: s0.requestDigest,
    });
    const fail = failed(
      runReplay(loop, journalOf(loop, { steps: [s0, s1] }), loopEvidence(loop)),
      'workflow.replay-mismatch',
      1,
    );
    expect(fail.actual).toEqual({ kind: 'duplicate', recorded: { step: 0 } });
  });

  test('C13 a reused request id with different bytes re-evaluates as a conflict', () => {
    const loop = world(LOOP);
    const s0 = loopStep0(loop);
    const s1 = loopStep1(loop, { requestId: 'req-1', evidence: ['review-1'] });
    const fail = failed(
      runReplay(loop, journalOf(loop, { steps: [s0, s1] }), loopEvidence(loop)),
      'workflow.replay-mismatch',
      1,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.requestConflict });
  });

  test('the first divergent step wins', () => {
    const demo = world(DEMO);
    const s0 = demoStep0(demo);
    const s1 = demoStep1(demo, { revision: 5 });
    const evidence = { ...demoEvidence(demo), ...demoEvidence2(demo) };
    failed(runReplay(demo, journalOf(demo, { steps: [s0, s1] }), evidence), 'workflow.replay-mismatch', 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Guards.

describe('guards', () => {
  test('a true guard re-evaluates to the recorded answer and evidence', () => {
    const guarded = world(GUARDED);
    const step = stepOf(guarded, {
      revision: 1,
      activation: 2,
      from: 'prep',
      to: 'ready',
      signal: 'gate-passed',
      requestId: 'req-1',
      evidence: ['gate-1', 'build-done', 'ci-1'],
      guard: { name: 'ci-green-on-head', answer: true, evidence: ['ci-1'] },
      effects: [],
    });
    const run = okRun(runReplay(guarded, journalOf(guarded, { steps: [step] }), guardEvidence(guarded)));
    expect(run.state).toBe('ready');
    expect(run.revision).toBe(1);
  });

  test('a false guard re-evaluates as a refusal, so a recorded step is a mismatch', () => {
    const guarded = world(GUARDED);
    const step = stepOf(guarded, {
      revision: 1,
      activation: 2,
      from: 'prep',
      to: 'ready',
      signal: 'gate-passed',
      requestId: 'req-1',
      evidence: ['gate-1', 'build-done', 'ci-1'],
      guard: { name: 'ci-green-on-head', answer: true, evidence: ['ci-1'] },
      effects: [],
    });
    const fail = failed(
      runReplay(guarded, journalOf(guarded, { steps: [step] }), guardEvidence(guarded, 'refused')),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.guardRefused });
  });

  test('a guard with no in-scope record re-evaluates as a missing-evidence hold', () => {
    const guarded = world(GUARDED);
    const step = stepOf(guarded, {
      revision: 1,
      activation: 2,
      from: 'prep',
      to: 'ready',
      signal: 'gate-passed',
      requestId: 'req-1',
      evidence: ['gate-1', 'build-done'],
      guard: { name: 'ci-green-on-head', answer: true, evidence: ['ci-1'] },
      effects: [],
    });
    const evidence = guardEvidence(guarded);
    const fail = failed(
      runReplay(guarded, journalOf(guarded, { steps: [step] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'held', code: DECISION_CODES.evidenceMissing });
  });

  test('more than one in-scope guard record is an ambiguity refusal', () => {
    const guarded = world(GUARDED);
    const step = stepOf(guarded, {
      revision: 1,
      activation: 2,
      from: 'prep',
      to: 'ready',
      signal: 'gate-passed',
      requestId: 'req-1',
      evidence: ['gate-1', 'build-done', 'ci-1', 'ci-2'],
      effects: [],
    });
    const evidence = { ...guardEvidence(guarded), 'ci-2': ciRecord(guarded) };
    const fail = failed(
      runReplay(guarded, journalOf(guarded, { steps: [step] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.evidenceAmbiguous });
  });

  test('an unknown guard is refused', () => {
    const unknown = world(UNKNOWN_GUARD);
    const step = stepOf(unknown, {
      revision: 1,
      activation: 2,
      from: 'prep',
      to: 'ready',
      signal: 'gate-passed',
      requestId: 'req-1',
      evidence: ['gate-1', 'build-done'],
      effects: [],
    });
    const evidence = {
      'gate-1': gateRecord(unknown),
      'build-done': outcomeRecord(unknown, occurrenceId(RUN, 1, 'build'), 'build'),
    };
    const fail = failed(
      runReplay(unknown, journalOf(unknown, { steps: [step] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.guardUnknown });
  });

  test('a false-guard stop re-evaluates identically', () => {
    const guarded = world(GUARDED);
    const journal = stopped(guarded, {
      decision: 'refused',
      code: DECISION_CODES.guardRefused,
      evidence: ['gate-1', 'build-done', 'ci-1'],
      guard: { name: 'ci-green-on-head', answer: false, evidence: ['ci-1'] },
    });
    const run = okRun(runReplay(guarded, journal, guardEvidence(guarded, 'refused')));
    expect(run.state).toBe('prep');
    expect(run.revision).toBe(0);
    expect(run.blocked).toEqual({
      decision: 'refused',
      code: DECISION_CODES.guardRefused,
      state: 'prep',
      revision: 0,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Entry-effect preconditions.

describe('entry-effect preconditions', () => {
  const demo = world(DEMO);

  test('a missing entry outcome is held evidence.missing with the occurrence', () => {
    const evidence = { 'gate-1': gateRecord(demo) };
    const step = demoStep0(demo, { evidence: ['gate-1'] });
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({
      kind: 'held',
      code: DECISION_CODES.evidenceMissing,
      waitingOn: { kind: 'entry-effect', occurrence: occurrenceId(RUN, 1, 'build') },
    });
  });

  test('a refused entry outcome is held core.entry-effect-failed', () => {
    const evidence = {
      'gate-1': gateRecord(demo),
      'build-done': outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build', 'refused'),
    };
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'held', code: DECISION_CODES.entryEffectFailed });
  });

  test('an unknown entry outcome is refused evidence.unknown', () => {
    const evidence = {
      'gate-1': gateRecord(demo),
      'build-done': {
        ...outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build'),
        result: 'unknown',
      } as unknown as EvidenceRecord,
    };
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.evidenceUnknown });
  });

  test('two outcomes for one entry occurrence are refused evidence-ambiguous', () => {
    const evidence = {
      'gate-1': gateRecord(demo),
      'build-done': outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build'),
      'build-done-2': outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build'),
    };
    const step = demoStep0(demo, { evidence: ['gate-1', 'build-done', 'build-done-2'] });
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [step] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.evidenceAmbiguous });
  });

  test('another artifact\'s outcome never satisfies the entry precondition', () => {
    const evidence = {
      'gate-1': gateRecord(demo),
      'build-done': outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build', 'done', {
        kind: 'ref',
        value: 'some-other-artifact',
      }),
    };
    const fail = failed(
      runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), evidence),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'held', code: DECISION_CODES.evidenceMissing });
  });

  test('a held entry-effect stop re-evaluates identically', () => {
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: ['gate-1'],
      waitingOn: { kind: 'entry-effect', occurrence: occurrenceId(RUN, 1, 'build') },
    });
    const run = okRun(runReplay(demo, journal, { 'gate-1': gateRecord(demo) }));
    expect(run.blocked).toEqual({
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      state: 'prep',
      revision: 0,
      waitingOn: { kind: 'entry-effect', occurrence: occurrenceId(RUN, 1, 'build') },
    });
  });

  test('a refused entry-effect stop re-evaluates identically', () => {
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.entryEffectFailed,
      evidence: ['gate-1', 'build-done'],
    });
    const evidence = {
      'gate-1': gateRecord(demo),
      'build-done': outcomeRecord(demo, occurrenceId(RUN, 1, 'build'), 'build', 'refused'),
    };
    const run = okRun(runReplay(demo, journal, evidence));
    expect(run.blocked).toMatchObject({ decision: 'held', code: DECISION_CODES.entryEffectFailed });
  });
});

// ---------------------------------------------------------------------------------------------
// Waits.

describe('waits', () => {
  test('an approval wait fires only on approved and is recorded fired', () => {
    const demo = world(DEMO);
    const s0 = demoStep0(demo);
    const s1 = demoStep1(demo);
    const run = okRun(
      runReplay(demo, journalOf(demo, { steps: [s0, s1] }), {
        ...demoEvidence(demo),
        ...demoEvidence2(demo),
      }),
    );
    expect(run.waits).toEqual([{ state: 'reviewed', activation: 2, status: 'fired' }]);
  });

  test('a non-approval signal in an approval wait re-evaluates as wait-pending', () => {
    const alt = world(APPROVAL_ALT);
    const s0 = demoStep0(alt);
    const evidence = demoEvidence(alt);
    const s1 = stepOf(alt, {
      revision: 2,
      activation: 3,
      from: 'reviewed',
      to: 'done',
      signal: 'gate-passed',
      requestId: 'req-2',
      evidence: ['gate-2', 'notify-done'],
      effects: [effectRecord(alt, 'cleanup', 'reviewed', 2)],
    });
    const fail = failed(
      runReplay(alt, journalOf(alt, { steps: [s0, s1] }), {
        ...evidence,
        'gate-2': gateRecord(alt),
        'notify-done': outcomeRecord(alt, occurrenceId(RUN, 2, 'notify'), 'notify'),
      }),
      'workflow.replay-mismatch',
      1,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.waitPending });
  });

  test('a reached time wait fires and records the wait fired', () => {
    const time = world(TIME, { 'release-slot': AT });
    const run = okRun(
      runReplay(time, journalOf(time, { steps: [timeStep0(time)] }), { 'timer-1': timerRecord(time) }),
    );
    expect(run.state).toBe('done');
    expect(run.revision).toBe(1);
    expect(run.waits).toEqual([{ state: 'waiting', activation: 1, status: 'fired' }]);
  });

  test('a time wait before its setting re-evaluates as wait-not-reached', () => {
    const time = world(TIME, { 'release-slot': AT });
    const step = timeStep0(time, { at: '2026-10-21T11:59:00Z' });
    const fail = failed(
      runReplay(time, journalOf(time, { steps: [step] }), { 'timer-1': timerRecord(time) }),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'refused', code: DECISION_CODES.waitNotReached });
  });

  test('a missing wait setting holds with waitingOn the setting', () => {
    const time = world(TIME);
    const journal = stopped(time, {
      decision: 'held',
      code: DECISION_CODES.settingsMissing,
      signal: 'time-reached',
      evidence: ['timer-1'],
      waitingOn: { kind: 'setting', name: 'release-slot' },
    });
    const run = okRun(runReplay(time, journal, { 'timer-1': timerRecord(time) }));
    expect(run.blocked).toEqual({
      decision: 'held',
      code: DECISION_CODES.settingsMissing,
      state: 'waiting',
      revision: 0,
      waitingOn: { kind: 'setting', name: 'release-slot' },
    });
  });

  test('a run that exhausts inside its wait keeps the wait pending', () => {
    const time = world(TIME, { 'release-slot': AT });
    const run = okRun(runReplay(time, journalOf(time), {}));
    expect(run.state).toBe('waiting');
    expect(run.waits).toEqual([{ state: 'waiting', activation: 1, status: 'pending' }]);
    expect(run.blocked).toBeUndefined();
  });

  test('D3 an approval wait left open by exhaustion stays pending', () => {
    const demo = world(DEMO);
    const run = okRun(
      runReplay(demo, journalOf(demo, { steps: [demoStep0(demo)] }), demoEvidence(demo)),
    );
    expect(run.state).toBe('reviewed');
    expect(run.waits).toEqual([{ state: 'reviewed', activation: 2, status: 'pending' }]);
    expect(run.blocked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Stops: a terminal held/refused decision is a non-transition that sets blocked.

describe('stops', () => {
  test('a held missing-evidence stop re-evaluates identically', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
    });
    const run = okRun(runReplay(demo, journal, {}));
    expect(run.state).toBe('prep');
    expect(run.revision).toBe(0);
    expect(run.occurrences.size).toBe(1);
    expect(run.blocked).toEqual({
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      state: 'prep',
      revision: 0,
    });
  });

  test('a stop state or revision that disagrees with the fold is workflow.journal', () => {
    const demo = world(DEMO);
    const wrongState = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
      state: 'reviewed',
    });
    failed(runReplay(demo, wrongState, {}), 'workflow.journal');

    const wrongRevision = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
      revision: 1,
    });
    failed(runReplay(demo, wrongRevision, {}), 'workflow.journal');
  });

  test('a stop with no signal or no request id is workflow.journal', () => {
    const demo = world(DEMO);
    const noSignal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
      signal: null,
    });
    failed(runReplay(demo, noSignal, {}), 'workflow.journal');
    const noRequest = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: [],
      requestId: null,
    });
    failed(runReplay(demo, noRequest, {}), 'workflow.journal');
  });

  test('a stop whose decision does not re-evaluate identically is a mismatch at the stop', () => {
    const time = world(TIME, { 'release-slot': AT });
    const journal = stopped(time, {
      decision: 'held',
      code: DECISION_CODES.settingsMissing,
      signal: 'time-reached',
      evidence: ['timer-1'],
      waitingOn: { kind: 'setting', name: 'release-slot' },
    });
    const fail = failed(
      runReplay(time, journal, { 'timer-1': timerRecord(time) }),
      'workflow.replay-mismatch',
      0,
    );
    expect(fail.actual).toMatchObject({ kind: 'step' });
  });

  test('a tampered stop code is a mismatch', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.guardRefused,
      evidence: [],
    });
    const fail = failed(runReplay(demo, journal, {}), 'workflow.replay-mismatch', 0);
    expect(fail.actual).toMatchObject({ decision: 'held', code: DECISION_CODES.evidenceMissing });
  });

  test('a tampered stop guard is a mismatch', () => {
    const guarded = world(GUARDED);
    const journal = stopped(guarded, {
      decision: 'refused',
      code: DECISION_CODES.guardRefused,
      evidence: ['gate-1', 'build-done', 'ci-1'],
      guard: { name: 'ci-green-on-head', answer: true, evidence: ['ci-1'] },
    });
    failed(
      runReplay(guarded, journal, guardEvidence(guarded, 'refused')),
      'workflow.replay-mismatch',
      0,
    );
  });

  test('two gate records re-evaluate as evidence-ambiguous', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'refused',
      code: DECISION_CODES.evidenceAmbiguous,
      evidence: ['gate-1', 'gate-2'],
    });
    const run = okRun(
      runReplay(demo, journal, {
        'gate-1': gateRecord(demo),
        'gate-2': gateRecord(demo),
      }),
    );
    expect(run.blocked).toMatchObject({
      decision: 'refused',
      code: DECISION_CODES.evidenceAmbiguous,
    });
  });

  test('a corrupt cited record re-evaluates as evidence.corrupt', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'refused',
      code: DECISION_CODES.evidenceCorrupt,
      evidence: ['bad-gate'],
    });
    const run = okRun(runReplay(demo, journal, { 'bad-gate': { type: 'gate' } }));
    expect(run.blocked).toMatchObject({ decision: 'refused', code: DECISION_CODES.evidenceCorrupt });
  });

  test('an unknown outcome re-evaluates as evidence.unknown', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'refused',
      code: DECISION_CODES.evidenceUnknown,
      evidence: ['unknown-1'],
    });
    const run = okRun(
      runReplay(demo, journal, {
        'unknown-1': {
          type: 'outcome',
          operation: 'x',
          effect: 'y',
          result: 'unknown',
          target: TARGET,
        } as unknown as EvidenceRecord,
      }),
    );
    expect(run.blocked).toMatchObject({ decision: 'refused', code: DECISION_CODES.evidenceUnknown });
  });

  test('a cited dry journal re-evaluates as evidence-non-authoritative', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'refused',
      code: DECISION_CODES.evidenceNonAuthoritative,
      evidence: ['journal-1'],
    });
    const run = okRun(
      runReplay(demo, journal, {
        'journal-1': { kind: 'workflow-run-dry', type: 'journal' },
      }),
    );
    expect(run.blocked).toMatchObject({
      decision: 'refused',
      code: DECISION_CODES.evidenceNonAuthoritative,
    });
  });

  test('a tampered waitingOn is a mismatch', () => {
    const demo = world(DEMO);
    const journal = stopped(demo, {
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      evidence: ['gate-1'],
      waitingOn: { kind: 'entry-effect', occurrence: occurrenceId(RUN, 1, 'build') },
    });
    const tampered = {
      ...journal.outcome,
      waitingOn: { kind: 'setting', name: 'elsewhere' },
    } as DryRunJournal['outcome'];
    failed(
      runReplay(demo, { ...journal, outcome: tampered }, { 'gate-1': gateRecord(demo) }),
      'workflow.replay-mismatch',
      0,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The boundary: no runtime core import, no dispatcher, no writer.

describe('the replay boundary', () => {
  test('E2 the module has no runtime core import and no bus, ledger or dispatcher module', () => {
    const source = readFileSync(new URL('../../src/workflow/replay.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)].map((match) => ({
      typeOnly: match[1] !== undefined,
      specifier: match[2]!,
    }));
    expect(imports.some((entry) => entry.specifier === './core.ts' && !entry.typeOnly)).toBe(false);
    for (const entry of imports) {
      expect(entry.specifier).not.toMatch(/bus|daemon|grant|approval|ledger|dispatch|commands|cli/);
    }
  });

  test('E1 replaying the same journal twice is deep-equal', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo, { steps: [demoStep0(demo), demoStep1(demo)] });
    const evidence = { ...demoEvidence(demo), ...demoEvidence2(demo) };
    const first = okRun(runReplay(demo, journal, evidence));
    const second = okRun(runReplay(demo, journal, evidence));
    expect(snapshot(second)).toEqual(snapshot(first));
  });

  test('E5 replay adds no step, adds no occurrence and never dispatches', () => {
    const demo = world(DEMO);
    const journal = journalOf(demo, { steps: [demoStep0(demo)] });
    const evidence = demoEvidence(demo);
    const before = JSON.stringify({ journal, evidence });
    const run = okRun(runReplay(demo, journal, evidence));
    expect(JSON.stringify({ journal, evidence })).toBe(before);
    expect(run.revision).toBe(1);
    expect(run.occurrences.size).toBe(3);
    expect(run.requests.size).toBe(1);
    const startAndStep = [...journal.start.effects, ...journal.steps.flatMap((step) => step.effects)];
    expect(run.occurrences.size).toBe(startAndStep.length);
    for (const record of startAndStep) expect(record.dispatched).toBe(false);
  });
});
