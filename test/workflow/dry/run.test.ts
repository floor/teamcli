// WF1-DRY acceptance: the pure runner over the two-cycle graph and the replay fold over its
// journal. The rows are the interface map's P1/P2/P5/P6/P11/P13 and tester-2's D1-D10.

import { describe, expect, test } from 'bun:test';
import { canonicalJson, definitionId } from '../../../src/workflow/canonical.ts';
import { DECISION_CODES } from '../../../src/workflow/codes.ts';
import type { RunState } from '../../../src/workflow/core-state.ts';
import { dryReplay, dryRun, dryRunId, readScript } from '../../../src/workflow/dry/index.ts';
import type { DryScript, DrySignal } from '../../../src/workflow/dry/index.ts';
import { provisionalResolvers } from '../../../src/workflow/registry.ts';
import { parseWorkflow } from '../../../src/workflow/schema.ts';
import type {
  DefinitionId,
  DryRunJournal,
  EvidenceDocument,
  EvidenceRecord,
  Workflow,
} from '../../../src/workflow/types.ts';

const GUARDS = provisionalResolvers().guards;

const TWO_CYCLE = `workflow: two-cycle-dry
version: 1
initial: ready
states:
  ready:
    on-enter: [notice-ready]
    wait:
      for: time
      at: ready-at
  resting:
    on-enter: [notice-resting]
    wait:
      for: time
      at: rest-at
transitions:
  - { from: ready, to: resting, on: time-reached, role: lead }
  - { from: resting, to: ready, on: time-reached, role: lead }
effects:
  notice-ready:
    run: release-notes
    role: lead
    capability: write
  notice-resting:
    run: release-notes
    role: lead
    capability: write
`;

const SELF_LOOP = `workflow: self-loop-dry
version: 1
initial: open
states:
  open: {}
transitions:
  - { from: open, to: open, on: time-reached, role: lead }
effects: {}
`;

const USES = `workflow: uses-dry
version: 1
initial: open
states:
  open: {}
  child:
    uses: round
transitions:
  - { from: open, to: child, on: accepted, role: lead }
effects: {}
`;

function parsed(source: string): Workflow {
  const result = parseWorkflow(source);
  if (!('workflow' in result)) throw new Error(`fixture did not parse: ${JSON.stringify(result)}`);
  return result.workflow;
}

const DEFINITION = parsed(TWO_CYCLE);
const DEFINITION_BYTES = new TextEncoder().encode(TWO_CYCLE);
const PIN: DefinitionId = definitionId(DEFINITION, TWO_CYCLE);

function signals(): DrySignal[] {
  return [
    {
      signal: 'time-reached',
      at: '2026-10-21T18:00:00Z',
      requestId: 'req-1',
      expectedRevision: 0,
      evidence: ['timer-1'],
    },
    {
      signal: 'time-reached',
      at: '2026-10-22T06:00:00Z',
      requestId: 'req-2',
      expectedRevision: 1,
      evidence: ['timer-2'],
    },
    {
      signal: 'time-reached',
      at: '2026-10-22T18:00:00Z',
      requestId: 'req-3',
      expectedRevision: 2,
      evidence: ['timer-3'],
    },
  ];
}

function dryScript(overrides: Partial<DryScript> = {}): DryScript {
  return {
    format: 1,
    target: 'floor/teamcli',
    artifact: { kind: 'none' },
    settings: {
      'ready-at': '2026-10-21T12:00:00Z',
      'rest-at': '2026-10-21T18:00:00Z',
    },
    inputs: {},
    evidence: {
      'timer-1': { type: 'timer' },
      'timer-2': { type: 'timer' },
      'timer-3': { type: 'timer' },
    },
    signals: signals(),
    ...overrides,
  };
}

/** Add the entry-effect outcome fixtures the core demands before a state may be left. */
function addEntryOutcomes(
  script: DryScript,
  entries: Array<{ ref: string; activation: number; effect: string }>,
): void {
  const runId = dryRunId(PIN, script);
  for (const entry of entries) {
    script.evidence[entry.ref] = {
      type: 'outcome',
      effect: `${runId}/${entry.activation}/${entry.effect}`,
      operation: 'release-notes',
      target: script.target,
      result: 'done',
    };
  }
}

function twoCycleScript(): DryScript {
  const script = dryScript();
  addEntryOutcomes(script, [
    { ref: 'ready-1', activation: 1, effect: 'notice-ready' },
    { ref: 'rest-2', activation: 2, effect: 'notice-resting' },
    { ref: 'ready-3', activation: 3, effect: 'notice-ready' },
  ]);
  script.signals[0]!.evidence.push('ready-1');
  script.signals[1]!.evidence.push('rest-2');
  script.signals[2]!.evidence.push('ready-3');
  return script;
}

type AcceptedRun = Extract<ReturnType<typeof dryRun>, { ok: true }>;

function runDry(script: DryScript, definition = DEFINITION, source = TWO_CYCLE) {
  return dryRun({
    definitionBytes: new TextEncoder().encode(source),
    definition,
    script,
    guards: GUARDS,
  });
}

function accepted(script: DryScript, definition = DEFINITION, source = TWO_CYCLE): AcceptedRun {
  const result = runDry(script, definition, source);
  if (!result.ok) throw new Error(`dry run failed: ${result.code}: ${result.why}`);
  return result;
}

function replayOf(
  journal: DryRunJournal,
  evidence: EvidenceDocument,
  definition = DEFINITION,
  source = TWO_CYCLE,
) {
  return dryReplay({
    definitionBytes: new TextEncoder().encode(source),
    definition,
    journalText: JSON.stringify(journal),
    evidence,
    guards: GUARDS,
  });
}

/** The run state as JSON, so two folds compare whole (maps included). */
function stateView(run: RunState): unknown {
  const occurrences = [...run.occurrences.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const requests = [...run.requests.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return {
    runId: run.runId,
    definitionId: run.definitionId,
    state: run.state,
    revision: run.revision,
    activation: run.activation,
    occurrences,
    requests,
    waits: run.waits,
    blocked: run.blocked ?? null,
  };
}

describe('dry runner', () => {
  test('the same definition and script give the same journal and run (D1)', () => {
    const first = accepted(twoCycleScript());
    const second = accepted(twoCycleScript());
    expect(canonicalJson(first.journal)).toBe(canonicalJson(second.journal));
    expect(stateView(first.run)).toEqual(stateView(second.run));
    expect(first.journal.run).toBe(dryRunId(PIN, twoCycleScript()));
    expect(first.journal.definition).toEqual(PIN);
  });

  test('the accepted script document drives the runner end to end', () => {
    const text = `format: 1
target: floor/teamcli
artifact: { kind: none }
settings:
  ready-at: '2026-10-21T12:00:00Z'
  rest-at: '2026-10-21T18:00:00Z'
inputs: {}
evidence:
  timer-1: { type: timer }
  timer-2: { type: timer }
  timer-3: { type: timer }
signals:
  - { signal: time-reached, at: '2026-10-21T18:00:00Z', request-id: req-1, expected-revision: 0, evidence: [timer-1] }
  - { signal: time-reached, at: '2026-10-22T06:00:00Z', request-id: req-2, expected-revision: 1, evidence: [timer-2] }
  - { signal: time-reached, at: '2026-10-22T18:00:00Z', request-id: req-3, expected-revision: 2, evidence: [timer-3] }
`;
    const read = readScript(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    addEntryOutcomes(read.script, [
      { ref: 'ready-1', activation: 1, effect: 'notice-ready' },
      { ref: 'rest-2', activation: 2, effect: 'notice-resting' },
      { ref: 'ready-3', activation: 3, effect: 'notice-ready' },
    ]);
    read.script.signals[0]!.evidence.push('ready-1');
    read.script.signals[1]!.evidence.push('rest-2');
    read.script.signals[2]!.evidence.push('ready-3');
    const result = accepted(read.script);
    expect(result.journal.steps).toHaveLength(3);
    expect(result.journal.outcome).toEqual({ kind: 'script-exhausted' });
  });

  test('two cycles give one occurrence per state entry, all distinct (D2)', () => {
    const { journal, run, decision, exit } = accepted(twoCycleScript());

    expect(journal.format).toBe(1);
    expect(journal.kind).toBe('workflow-run-dry');
    expect(journal.authoritative).toBe(false);
    expect(journal.notice).toBe('dry run — no record is written');
    expect(journal.outcome).toEqual({ kind: 'script-exhausted' });
    expect(exit).toBe(0);
    expect(decision?.kind).toBe('step');

    expect(journal.steps.map((step) => step.revision)).toEqual([1, 2, 3]);
    expect(journal.steps.map((step) => step.activation)).toEqual([2, 3, 4]);
    expect(journal.steps.map((step) => `${step.transition.from}->${step.transition.to}`)).toEqual([
      'ready->resting',
      'resting->ready',
      'ready->resting',
    ]);
    expect(journal.steps.map((step) => step.requestId)).toEqual(['req-1', 'req-2', 'req-3']);

    const occurrences = [...journal.start.effects, ...journal.steps.flatMap((step) => step.effects)];
    expect(occurrences.map((record) => record.name)).toEqual([
      'notice-ready',
      'notice-resting',
      'notice-ready',
      'notice-resting',
    ]);
    expect(occurrences.map((record) => record.activation)).toEqual([1, 2, 3, 4]);
    expect(new Set(occurrences.map((record) => record.occurrence)).size).toBe(4);
    for (const record of occurrences) {
      expect(record.dispatched).toBe(false);
      expect(record.occurrence).toBe(`${journal.run}/${record.activation}/${record.name}`);
    }
    // The released entries name the supplied outcome refs; the last entered state was not left.
    expect(journal.start.effects[0]!.outcome).toBe('ready-1');
    expect(journal.steps[0]!.effects[0]!.outcome).toBe('rest-2');
    expect(journal.steps[1]!.effects[0]!.outcome).toBe('ready-3');
    expect(journal.steps[2]!.effects[0]!.outcome).toBeUndefined();

    // Wait state is derived, never journaled; the fold's final state carries it.
    expect('waits' in journal).toBe(false);
    expect(run.state).toBe('resting');
    expect(run.revision).toBe(3);
    expect(run.activation).toBe(4);
    expect(run.waits).toEqual([
      { state: 'ready', activation: 1, status: 'fired' },
      { state: 'resting', activation: 2, status: 'fired' },
      { state: 'ready', activation: 3, status: 'fired' },
      { state: 'resting', activation: 4, status: 'pending' },
    ]);
  });

  test('a missing entry outcome holds the run with state and revision unmoved (D3)', () => {
    const script = dryScript();
    const { journal, run, exit } = accepted(script);
    expect(exit).toBe(1);
    expect(journal.steps).toHaveLength(0);
    expect(journal.outcome.kind).toBe('stopped');
    if (journal.outcome.kind !== 'stopped') return;
    expect(journal.outcome.decision).toBe('held');
    expect(journal.outcome.code).toBe(DECISION_CODES.evidenceMissing);
    expect(journal.outcome.waitingOn).toEqual({
      kind: 'entry-effect',
      occurrence: `${journal.run}/1/notice-ready`,
    });
    expect(journal.outcome.state).toBe('ready');
    expect(journal.outcome.revision).toBe(0);
    expect(run.state).toBe('ready');
    expect(run.revision).toBe(0);
  });

  test('a cited ref the document does not supply is held, not refused', () => {
    const script = dryScript();
    delete script.evidence['timer-1'];
    const { journal, run, exit } = accepted(script);
    expect(exit).toBe(1);
    if (journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(journal.outcome.decision).toBe('held');
    expect(journal.outcome.code).toBe(DECISION_CODES.evidenceMissing);
    expect(journal.outcome.waitingOn).toEqual({ kind: 'evidence', ref: 'timer-1' });
    expect(journal.steps).toHaveLength(0);
    expect(run.state).toBe('ready');
    expect(run.revision).toBe(0);
  });

  test('an unknown result is refused, never held (D4)', () => {
    const script = dryScript();
    script.evidence['timer-1'] = { type: 'timer', result: 'unknown' } as unknown as EvidenceRecord;
    const { journal, exit } = accepted(script);
    expect(exit).toBe(1);
    if (journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(journal.outcome.decision).toBe('refused');
    expect(journal.outcome.code).toBe(DECISION_CODES.evidenceUnknown);
    expect(journal.steps).toHaveLength(0);
  });

  test('a fixture outside the shared evidence shape is refused as corrupt', () => {
    const script = dryScript();
    script.evidence['timer-1'] = { result: 'done' } as unknown as EvidenceRecord;
    const { journal } = accepted(script);
    if (journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(journal.outcome.decision).toBe('refused');
    expect(journal.outcome.code).toBe(DECISION_CODES.evidenceCorrupt);
  });

  test('supplied evidence is never verified and never copied into the journal (D5, D6)', () => {
    const script = twoCycleScript();
    script.evidence['timer-1'] = { type: 'timer', result: 'refused', signature: 'forged' };
    script.evidence['ready-1'] = { ...script.evidence['ready-1']!, signature: 'forged' };
    const { journal, exit } = accepted(script);
    expect(exit).toBe(0);
    expect(journal.steps).toHaveLength(3);
    expect(JSON.stringify(journal)).not.toContain('forged');
    for (const record of [...journal.start.effects, ...journal.steps.flatMap((step) => step.effects)]) {
      expect(record.dispatched).toBe(false);
      expect(record).not.toHaveProperty('result');
    }
  });

  test('a stale expected revision refuses with no step and no occurrence (P13)', () => {
    const script = dryScript();
    script.signals[0]!.expectedRevision = 2;
    const { journal, run } = accepted(script);
    if (journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(journal.outcome.decision).toBe('refused');
    expect(journal.outcome.code).toBe(DECISION_CODES.revisionStale);
    // The producer keeps the stopped request's own precondition, including the stale supplied value.
    expect(journal.outcome).toMatchObject({ expectedRevision: 2 });
    expect(journal.steps).toHaveLength(0);
    expect(run.revision).toBe(0);
    expect(run.occurrences.size).toBe(1); // only the start entry's effect occurrence
  });

  test('the time wait is inclusive at its setting and fails closed without one (P11)', () => {
    const early = dryScript({
      signals: [{ ...signals()[0]!, at: '2026-10-21T11:59:59Z' }],
    });
    const before = accepted(early);
    if (before.journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(before.journal.outcome.decision).toBe('refused');
    expect(before.journal.outcome.code).toBe(DECISION_CODES.waitNotReached);
    expect(before.journal.steps).toHaveLength(0);

    const exact = dryScript({
      signals: [{ ...signals()[0]!, at: '2026-10-21T12:00:00Z' }],
    });
    addEntryOutcomes(exact, [{ ref: 'ready-1', activation: 1, effect: 'notice-ready' }]);
    exact.signals[0]!.evidence.push('ready-1');
    const atBoundary = accepted(exact);
    expect(atBoundary.journal.steps).toHaveLength(1);
    expect(atBoundary.exit).toBe(0);

    const noSetting = dryScript({
      settings: { 'rest-at': '2026-10-21T18:00:00Z' },
      signals: [{ ...signals()[0]! }],
    });
    const missing = accepted(noSetting);
    if (missing.journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(missing.journal.outcome.decision).toBe('held');
    expect(missing.journal.outcome.code).toBe(DECISION_CODES.settingsMissing);
    expect(missing.journal.outcome.waitingOn).toEqual({ kind: 'setting', name: 'ready-at' });
  });

  test('a repeated request is not re-applied, a changed one is refused', () => {
    const definition = parsed(SELF_LOOP);
    const source = SELF_LOOP;
    const loopSignal = (requestId: string, evidence: string, expectedRevision: number): DrySignal => ({
      signal: 'time-reached',
      at: `2026-10-21T1${expectedRevision}:00:00Z`,
      requestId,
      expectedRevision,
      evidence: [evidence],
    });
    const duplicate = dryScript({
      settings: {},
      evidence: { 'timer-1': { type: 'timer' }, 'timer-2': { type: 'timer' } },
      signals: [loopSignal('req-1', 'timer-1', 0), loopSignal('req-1', 'timer-1', 1)],
    });
    const repeated = accepted(duplicate, definition, source);
    expect(repeated.journal.steps).toHaveLength(1);
    expect(repeated.run.revision).toBe(1);
    expect(repeated.exit).toBe(0);

    const conflict = dryScript({
      settings: {},
      evidence: { 'timer-1': { type: 'timer' }, 'timer-2': { type: 'timer' } },
      signals: [loopSignal('req-1', 'timer-1', 0), loopSignal('req-1', 'timer-2', 1)],
    });
    const changed = accepted(conflict, definition, source);
    if (changed.journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(changed.journal.outcome.decision).toBe('refused');
    expect(changed.journal.outcome.code).toBe(DECISION_CODES.requestConflict);
    expect(changed.journal.steps).toHaveLength(1);
  });

  test('replay adds no step and lands on the runner state (D7)', () => {
    const script = twoCycleScript();
    const { journal, run } = accepted(script);
    const replay = replayOf(journal, script.evidence);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.exit).toBe(0);
    expect(stateView(replay.run)).toEqual(stateView(run));
    expect(replay.run.revision).toBe(journal.steps.length);
  });

  test('a stopped journal replays to the same blocked run (D7, matrix 54)', () => {
    const script = dryScript();
    const { journal, run } = accepted(script);
    const replay = replayOf(journal, script.evidence);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.exit).toBe(0);
    expect(replay.run.state).toBe(run.state);
    expect(replay.run.revision).toBe(run.revision);
    expect(replay.run.blocked).toEqual({
      decision: 'held',
      code: DECISION_CODES.evidenceMissing,
      state: 'ready',
      revision: 0,
      waitingOn: { kind: 'entry-effect', occurrence: `${journal.run}/1/notice-ready` },
    });
  });

  test('replay reports the first divergent step (D8)', () => {
    const script = twoCycleScript();
    const { journal } = accepted(script);
    const tampered = JSON.parse(JSON.stringify(journal)) as DryRunJournal;
    tampered.steps[2]!.requestId = 'req-other';
    tampered.steps[1]!.at = '2026-10-21T05:59:59Z';
    const replay = replayOf(tampered, script.evidence);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.replay-mismatch');
    expect(replay.fail.step).toBe(1);
  });

  test('replay reports a start divergence at step -1', () => {
    const script = twoCycleScript();
    const { journal } = accepted(script);
    const tampered = JSON.parse(JSON.stringify(journal)) as DryRunJournal;
    tampered.start.effects[0]!.occurrence = `${journal.run}/9/notice-ready`;
    const replay = replayOf(tampered, script.evidence);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.replay-mismatch');
    expect(replay.fail.step).toBe(-1);
  });

  test('replay refuses a journal pinned to another definition (D9)', () => {
    const script = twoCycleScript();
    const { journal } = accepted(script);
    const otherSource = TWO_CYCLE.replace('workflow: two-cycle-dry', 'workflow: two-cycle-other');
    const otherDefinition = parsed(otherSource);
    const replay = replayOf(journal, script.evidence, otherDefinition, otherSource);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.definition');
    expect(replay.exit).toBe(1);
  });

  test('a stop that re-evaluates to a step is a mismatch at the stop position (D9)', () => {
    const script = twoCycleScript();
    // Cite the entry outcome without supplying it: the run stops before the first step.
    const held = dryScript();
    held.signals[0]!.evidence.push('ready-1');
    const stopped = accepted(held);
    if (stopped.journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(stopped.journal.outcome.code).toBe(DECISION_CODES.evidenceMissing);
    expect(stopped.journal.steps).toHaveLength(0);

    const nowStep = replayOf(stopped.journal, script.evidence);
    expect(nowStep.ok).toBe(false);
    if (nowStep.ok) return;
    expect(nowStep.fail.code).toBe('workflow.replay-mismatch');
    expect(nowStep.fail.step).toBe(0);
  });

  test('a reachable child reference is refused naming the library slice (D10)', () => {
    const definition = parsed(USES);
    const script = dryScript({ settings: {}, evidence: {}, signals: [] });
    const result = accepted(script, definition, USES);
    expect(result.exit).toBe(1);
    expect(result.journal.steps).toHaveLength(0);
    if (result.journal.outcome.kind !== 'stopped') throw new Error('expected a stop');
    expect(result.journal.outcome.decision).toBe('refused');
    expect(result.journal.outcome.code).toBe(DECISION_CODES.usesDeferred);
    expect(result.journal.outcome.state).toBe('child');
    expect(result.journal.outcome.why).toContain('library slice');

    const replay = replayOf(result.journal, {}, definition, USES);
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.fail.code).toBe('workflow.uses-deferred');
  });

  test('a definition that cannot be read or resolved fails closed', () => {
    const script = dryScript();
    const invalid = dryRun({
      definitionBytes: new Uint8Array([0xff, 0xfe]),
      definition: DEFINITION,
      script,
      guards: GUARDS,
    });
    expect(invalid).toEqual({ ok: false, code: 'workflow.definition', why: 'the definition file is not valid UTF-8' });

    const noInitial: Workflow = { ...DEFINITION };
    delete (noInitial as { initial?: string }).initial;
    const missing = runDry(script, noInitial);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('workflow.definition');
    expect(missing.why).toContain('no initial state');
  });
});
