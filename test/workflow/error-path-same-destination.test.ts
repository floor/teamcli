// A step's path through the live journal is the explicit move the decision carries: the engine's
// error rule is present in a decision as its `error` record, and a normal step records none. The
// entered state's name never decides it. A refused entry effect on a transition that already
// targets the definition's top-level error state is still the error path, and that decision must
// be appendable, foldable and replayable like any other. The scenes here are synthetic: one
// definition whose requested target and error redirect coincide, read through the core, the
// append gate, the fold and the replay.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalEffectPayload,
  canonicalJson,
  canonicalRequestPayload,
  occurrenceId,
  parseWorkflow,
  payloadDigest,
  provisionalResolvers,
} from '../../src/workflow/index.ts';
import type {
  ArtifactRef,
  DefinitionId,
  DryEffectRecord,
  EvidenceRecord,
  EvidenceRef,
  RunId,
  SignalName,
  Workflow,
  WorkflowEnvelope,
} from '../../src/workflow/index.ts';
import { decide } from '../../src/workflow/core.ts';
import type { StepDecision } from '../../src/workflow/core.ts';
import type { OccurrenceRecord, RunState } from '../../src/workflow/core-state.ts';
import { LIVE_KIND, LIVE_NOTICE, runIdFor } from '../../src/workflow/live/records.ts';
import type { LiveRecord, LiveRunOpenRecord, LiveStepRecord } from '../../src/workflow/live/records.ts';
import { journalPath } from '../../src/workflow/live/journal.ts';
import { foldLive, replayLive, stepFault } from '../../src/workflow/live/replay.ts';
import type { StepInput } from '../../src/workflow/live/replay.ts';
import { LiveStoreError, openRunStore } from '../../src/workflow/live/store.ts';
import type { RunStore } from '../../src/workflow/live/store.ts';

const SOURCE = `workflow: same-dest
version: 1
initial: working
error: failed
inputs: [item-key]
states:
  working:
    on-enter: [dispatch-worker]
  failed: {}
  archived: {}
transitions:
  - { from: working, to: failed, on: step-failed, role: daemon }
  - { from: working, to: failed, on: lead-word, role: daemon, guard: tested-head-equals-built }
  - { from: working, to: archived, on: step-done, role: daemon }
effects:
  dispatch-worker: { run: dispatch-worker, capability: write, role: builder }
`;

const TARGET = 'refs/heads/main';
const ARTIFACT: ArtifactRef = { kind: 'none' };
const AT = '2026-11-01T09:00:00Z';
const ITEM = { source: 'file', project: 'sample', team: 'sample', id: '1' };
const KEY = 'file.sample.sample.1';
const GENERATION = 1;
const RUN = runIdFor(KEY, GENERATION);
const ENTRY = occurrenceId(RUN, 1, 'dispatch-worker');

function parseOk(): { workflow: Workflow; definition: DefinitionId } {
  const result = parseWorkflow(SOURCE);
  if (!('workflow' in result)) throw new Error(`fixture did not parse: ${JSON.stringify(result)}`);
  return result;
}

function startEffect(runId: RunId = RUN): DryEffectRecord {
  return {
    name: 'dispatch-worker',
    state: 'working',
    activation: 1,
    occurrence: occurrenceId(runId, 1, 'dispatch-worker'),
    payloadDigest: payloadDigest(
      canonicalEffectPayload('dispatch-worker', 'dispatch-worker', TARGET, ARTIFACT),
    ),
    dispatched: false,
  };
}

function occurrences(runId: RunId = RUN): Map<string, OccurrenceRecord> {
  const effect = startEffect(runId);
  return new Map([
    [
      effect.occurrence,
      {
        id: effect.occurrence,
        effect: effect.name,
        state: effect.state,
        activation: effect.activation,
        payloadDigest: effect.payloadDigest,
      },
    ],
  ]);
}

function outcome(result: 'done' | 'refused', runId: RunId = RUN): EvidenceRecord {
  return {
    type: 'outcome',
    operation: 'dispatch-worker',
    effect: occurrenceId(runId, 1, 'dispatch-worker'),
    result,
    target: TARGET,
  };
}

type Scene = {
  workflow: Workflow;
  definition: DefinitionId;
  run: RunState;
  envelope: WorkflowEnvelope;
  decision: StepDecision;
  evidence: Record<EvidenceRef, EvidenceRecord>;
};

/** One synthetic run: the refusal outcome answers the `working` entry effect, and the signal's
 *  own record answers the signal. The decision is the core's, never hand-written. */
function scene(
  signal: SignalName,
  evidence: Record<EvidenceRef, EvidenceRecord>,
  runId: RunId = RUN,
): Scene {
  const { workflow, definition } = parseOk();
  const run: RunState = {
    runId,
    definitionId: definition,
    state: 'working',
    revision: 0,
    activation: 1,
    occurrences: occurrences(runId),
    requests: new Map(),
    waits: [],
  };
  const enabled = workflow.transitions.filter(
    (candidate) => candidate.from === run.state && candidate.on === signal,
  );
  const transition = enabled[0];
  if (transition === undefined) throw new Error(`no transition for ${run.state}/${signal}`);
  const envelope: WorkflowEnvelope = {
    format: 1,
    run: runId,
    definition,
    expectedRevision: run.revision,
    requestId: 'req-1',
    move: { transition: { from: transition.from, to: transition.to, on: transition.on } },
    target: TARGET,
    artifact: ARTIFACT,
    evidence: Object.keys(evidence),
  };
  const decision = decide({
    definition: workflow,
    definitionId: definition,
    run,
    envelope,
    signal: { name: signal, at: AT },
    evidence: { record: (ref) => evidence[ref] },
    settings: { get: () => undefined },
    guards: provisionalResolvers().guards,
  });
  if (decision.kind !== 'step') {
    throw new Error(`expected a step, got ${decision.kind}: ${JSON.stringify(decision)}`);
  }
  return { workflow, definition, run, envelope, decision, evidence };
}

function effectsOf(decision: StepDecision, previousActivation: number): DryEffectRecord[] {
  return decision.plan.flatMap((item) =>
    item.kind === 'effect'
      ? [
          {
            name: item.effect,
            state: item.phase === 'exit' ? decision.transition.from : decision.next.state,
            activation: item.phase === 'exit' ? previousActivation : decision.next.activation,
            occurrence: item.occurrence,
            payloadDigest: item.digest,
            dispatched: false as const,
          },
        ]
      : [],
  );
}

function transitionOf(envelope: WorkflowEnvelope): { from: string; to: string; on: SignalName } {
  if (!('transition' in envelope.move)) throw new Error('the scene is not a transition move');
  return envelope.move.transition;
}

/** The append caller's frame around a decision: the step it records is the decision's. */
function stepOf(scene: Scene): StepInput {
  const { decision, envelope, run } = scene;
  const transition = transitionOf(envelope);
  return {
    revision: decision.nextRevision,
    signal: transition.on,
    requestId: envelope.requestId,
    requestDigest: payloadDigest(
      canonicalRequestPayload({
        move: envelope.move,
        target: envelope.target,
        artifact: envelope.artifact,
        evidence: envelope.evidence,
      }),
    ),
    transition: { ...transition },
    activation: decision.next.activation,
    next: decision.next.state,
    ...(decision.error !== undefined ? { error: decision.error } : {}),
    ...(decision.guard !== undefined ? { guard: decision.guard } : {}),
    evidence: [...envelope.evidence],
    evidenceRecords: scene.evidence,
    effects: effectsOf(decision, run.activation),
  };
}

function faultOf(scene: Scene, step: StepInput = stepOf(scene)): string | undefined {
  return stepFault({
    definition: scene.workflow,
    runId: scene.run.runId,
    target: TARGET,
    artifact: ARTIFACT,
    state: scene.run.state,
    previousRevision: scene.run.revision,
    previousActivation: scene.run.activation,
    step,
  });
}

function openRecord(definition: DefinitionId): LiveRunOpenRecord {
  return {
    format: 1,
    kind: LIVE_KIND,
    authoritative: true,
    seq: 1,
    at: AT,
    record: 'run-open',
    notice: LIVE_NOTICE,
    run: RUN,
    item: ITEM,
    generation: GENERATION,
    definition,
    definitionPath: 'definitions/same-dest.yaml',
    target: TARGET,
    artifact: ARTIFACT,
    inputs: { 'item-key': KEY },
    settings: {},
    initial: 'working',
    start: { state: 'working', activation: 1, effects: [startEffect()] },
  };
}

function stepRecord(step: StepInput): LiveStepRecord {
  return {
    format: 1,
    kind: LIVE_KIND,
    authoritative: true,
    seq: 2,
    at: AT,
    record: 'step',
    revision: step.revision,
    signal: step.signal,
    requestId: step.requestId,
    requestDigest: step.requestDigest,
    transition: step.transition,
    activation: step.activation,
    ...(step.next !== undefined ? { next: step.next } : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    evidence: [...step.evidence],
    ...(step.evidenceRecords !== undefined ? { evidenceRecords: step.evidenceRecords } : {}),
    ...(step.guard !== undefined ? { guard: step.guard } : {}),
    effects: step.effects,
  };
}

function journalText(records: readonly LiveRecord[]): string {
  return records.map((record) => `${canonicalJson(record)}\n`).join('');
}

function replayed(scene: Scene, step: StepInput = stepOf(scene)) {
  return replayLive({
    definitionBytes: SOURCE,
    definition: scene.workflow,
    journalText: journalText([openRecord(scene.definition), stepRecord(step)]),
  });
}

const REFUSAL: EvidenceRecord = { type: 'refusal', target: TARGET };
const MESSAGE: EvidenceRecord = { type: 'message', target: TARGET };
const STEP: EvidenceRecord = { type: 'step', target: TARGET };

describe('a refused entry effect on a transition whose target is already the error state', () => {
  const refused = scene('step-failed', { 'ev-refusal': REFUSAL, 'ev-outcome': outcome('refused') });

  test('the core decides the engine error move onto the requested target', () => {
    expect(refused.decision.next).toEqual({ state: 'failed', activation: 2 });
    expect(refused.decision.transition).toEqual({ from: 'working', to: 'failed', on: 'step-failed' });
    expect(refused.decision.error).toEqual({
      rule: 'entry-effect-refused',
      from: 'working',
      to: 'failed',
      effect: 'dispatch-worker',
      occurrence: ENTRY,
    });
  });

  test('append accepts the decision', () => {
    expect(faultOf(refused)).toBeUndefined();
  });

  test('the fold reads the same-destination error step', () => {
    const folded = foldLive([openRecord(refused.definition), stepRecord(stepOf(refused))]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) throw new Error(folded.why);
    expect(folded.live.state).toBe('failed');
    expect(folded.live.activation).toBe(2);
    expect(folded.live.revision).toBe(1);
  });

  test('replay re-derives the same error step', () => {
    const replay = replayed(refused);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.fail.why);
    expect(replay.run.state).toBe('failed');
  });
});

describe('the same-destination error step on a guarded transition', () => {
  const refused = scene('lead-word', { 'ev-message': MESSAGE, 'ev-outcome': outcome('refused') });

  test('the core takes the error path without evaluating the guard', () => {
    expect(refused.decision.guard).toBeUndefined();
    expect(refused.decision.error?.to).toBe('failed');
  });

  test('append accepts the error move and no guard', () => {
    expect(faultOf(refused)).toBeUndefined();
  });

  test('the fold and the replay read it', () => {
    const folded = foldLive([openRecord(refused.definition), stepRecord(stepOf(refused))]);
    expect(folded.ok).toBe(true);
    const replay = replayed(refused);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.fail.why);
    expect(replay.run.state).toBe('failed');
  });
});

describe('a normal step whose target is the error state', () => {
  const normal = scene('step-failed', { 'ev-refusal': REFUSAL, 'ev-outcome': outcome('done') });

  test('the core decides a normal step with no error move', () => {
    expect(normal.decision.next).toEqual({ state: 'failed', activation: 2 });
    expect(normal.decision.error).toBeUndefined();
  });

  test('append, the fold and the replay read it as normal', () => {
    expect(faultOf(normal)).toBeUndefined();
    const folded = foldLive([openRecord(normal.definition), stepRecord(stepOf(normal))]);
    expect(folded.ok).toBe(true);
    if (!folded.ok) throw new Error(folded.why);
    expect(folded.live.state).toBe('failed');
    const replay = replayed(normal);
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.fail.why);
    expect(replay.run.state).toBe('failed');
  });
});

describe('the error move still decides the path', () => {
  test('append refuses an error move onto a target that is not the definition error state', () => {
    const moved = scene('step-done', { 'ev-step': STEP, 'ev-outcome': outcome('done') });
    const step = stepOf(moved);
    const forged: StepInput = {
      ...step,
      error: {
        rule: 'entry-effect-refused',
        from: 'working',
        to: 'archived',
        effect: 'dispatch-worker',
        occurrence: ENTRY,
      },
    };
    expect(faultOf(moved, forged)).toBe(
      'the step moves to "archived", not the definition\'s error state "failed"',
    );
  });

  test('the fold refuses an error move that names another leaving state', () => {
    const refused = scene('step-failed', {
      'ev-refusal': REFUSAL,
      'ev-outcome': outcome('refused'),
    });
    const step = stepOf(refused);
    const forged: StepInput = {
      ...step,
      error: {
        rule: 'entry-effect-refused',
        from: 'idle',
        to: 'failed',
        effect: 'dispatch-worker',
        occurrence: ENTRY,
      },
    };
    const folded = foldLive([openRecord(refused.definition), stepRecord(forged)]);
    expect(folded.ok).toBe(false);
    if (folded.ok) return;
    expect(folded.why).toBe('the error move names another move');
    expect(folded.seq).toBe(2);
  });
});

describe('the real store applies the same judgement as the replay', () => {
  let base: string | undefined;

  afterEach(() => {
    if (base !== undefined) rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  /** A real run opened from `SOURCE`, exactly as a caller would open it. */
  function opened(): { store: RunStore; run: RunId; path: string } {
    const { workflow } = parseOk();
    base = mkdtempSync(join(tmpdir(), 'error-same-dest-'));
    const store = openRunStore({ root: base, now: () => Date.parse(AT) });
    const created = store.transact((tx) =>
      tx.createRun({
        item: ITEM,
        definitionBytes: SOURCE,
        definition: workflow,
        target: TARGET,
        artifact: ARTIFACT,
        inputs: { 'item-key': KEY },
        settings: {},
      }),
    );
    return { store, run: created.record.run, path: journalPath(base, created.record.run) };
  }

  test('a forged same-destination error over a done outcome is refused before the write', () => {
    const { store, run, path } = opened();
    const normal = scene(
      'step-failed',
      { 'ev-refusal': REFUSAL, 'ev-outcome': outcome('done', run) },
      run,
    );
    const forged: StepInput = {
      ...stepOf(normal),
      error: {
        rule: 'entry-effect-refused',
        from: 'working',
        to: 'failed',
        effect: 'dispatch-worker',
        occurrence: occurrenceId(run, 1, 'dispatch-worker'),
      },
    };
    let thrown: unknown;
    try {
      store.transact((tx) => tx.appendStep(run, { ...forged, at: AT }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LiveStoreError);
    if (!(thrown instanceof LiveStoreError)) throw new Error('the append did not throw a store error');
    expect(thrown.code).toBe('workflow.store.record-invalid');
    expect(thrown.why).toBe(
      'the step records error {"effect":"dispatch-worker","from":"working","occurrence":"' +
        occurrenceId(run, 1, 'dispatch-worker') +
        '","rule":"entry-effect-refused","to":"failed"}; the decision carries null',
    );

    const persisted = readFileSync(path, 'utf8');
    expect(persisted.trimEnd().split('\n')).toHaveLength(1);
    const replay = replayLive({ definitionBytes: SOURCE, definition: normal.workflow, journalText: persisted });
    expect(replay.ok).toBe(true);
  });

  test('the honest same-destination error step is appended and replays', () => {
    const { store, run, path } = opened();
    const refused = scene(
      'step-failed',
      { 'ev-refusal': REFUSAL, 'ev-outcome': outcome('refused', run) },
      run,
    );
    const record = store.transact((tx) => tx.appendStep(run, { ...stepOf(refused), at: AT }));
    expect(record.error).toEqual({
      rule: 'entry-effect-refused',
      from: 'working',
      to: 'failed',
      effect: 'dispatch-worker',
      occurrence: occurrenceId(run, 1, 'dispatch-worker'),
    });
    const replay = replayLive({
      definitionBytes: SOURCE,
      definition: refused.workflow,
      journalText: readFileSync(path, 'utf8'),
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(replay.fail.why);
    expect(replay.run.state).toBe('failed');
  });
});
