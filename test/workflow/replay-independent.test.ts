// Independent replay coverage for the workflow replay contract. Authored from the settled
// contract (the ruling, the definition schema at main 37e48e4e and the published fold seam),
// not from implementation fixtures.
//
// The replay module is loaded through one adapter because the seam is published red-first: this
// test file must typecheck before `src/workflow/replay.ts` exists. When the seam lands, the
// adapter is the only place the exact exported names need pinning.
//
// Fixtures here are authored in this file: a two-step approval flow, a self-loop for duplicated
// request identities, a held entry-effect stop, a false-guard stop, a missing-setting stop and
// the derived wait rows.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalEffectPayload,
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
  DryRunJournal,
  EvidenceDocument,
  Workflow,
} from '../../src/workflow/index.ts';

const TARGET = 'main';
const ARTIFACT: ArtifactRef = { kind: 'none' };
const NOTICE = 'dry run — no record is written';
const REPLAY_MODULE = '../../src/workflow/replay.ts';
const GUARDS = provisionalResolvers().guards;

type ReplayFailure = {
  code: string;
  step?: number;
  expected?: unknown;
  actual?: unknown;
  why: string;
};

type ReplayResult = { ok: true; run: unknown } | { ok: false; fail: ReplayFailure };

type ReplayInput = {
  definitionBytes: Uint8Array;
  definition: Workflow;
  journal: DryRunJournal;
  evidence: EvidenceDocument;
  guards: ReturnType<typeof provisionalResolvers>['guards'];
  decide: (input: unknown) => unknown;
};

type ReplaySeam = {
  readJournal(text: string): { ok: true; journal: DryRunJournal } | { ok: false; code: string; why: string };
  replay(input: ReplayInput): ReplayResult;
};

/** The one adapter the exact published names are pinned through. */
async function seam(): Promise<ReplaySeam> {
  return (await import(REPLAY_MODULE)) as unknown as ReplaySeam;
}

async function replay(input: ReplayInput): Promise<ReplayResult> {
  return (await seam()).replay(input);
}

function parseOk(source: string): { workflow: Workflow; definition: DefinitionId } {
  const result = parseWorkflow(source);
  if (!('workflow' in result)) throw new Error(`fixture did not parse: ${JSON.stringify(result)}`);
  return { workflow: result.workflow, definition: result.definition };
}

function effectRecord(
  run: string,
  name: string,
  state: string,
  activation: number,
  operation: string,
): DryEffectRecord {
  return {
    name,
    state,
    activation,
    occurrence: occurrenceId(run, activation, name),
    payloadDigest: payloadDigest(canonicalEffectPayload(name, operation, TARGET, ARTIFACT)),
    dispatched: false,
  };
}

type JournalStep = DryRunJournal['steps'][number];

function stepRecord(args: {
  revision: number;
  at: string;
  signal: JournalStep['signal'];
  requestId: string;
  from: string;
  to: string;
  activation: number;
  evidence: string[];
  effects: DryEffectRecord[];
}): JournalStep {
  const transition = { from: args.from, to: args.to, on: args.signal };
  return {
    revision: args.revision,
    at: args.at,
    signal: args.signal,
    requestId: args.requestId,
    requestDigest: payloadDigest(
      canonicalRequestPayload({
        move: { transition },
        target: TARGET,
        artifact: ARTIFACT,
        evidence: args.evidence,
      }),
    ),
    transition,
    activation: args.activation,
    evidence: args.evidence,
    effects: args.effects,
  };
}

/** One effect in the core's plan shape, built from the parsed definition and the canonical helpers. */
function planItem(
  run: string,
  definition: Workflow,
  name: string,
  phase: 'exit' | 'enter',
  activation: number,
): Record<string, unknown> {
  const effect = definition.effects[name];
  if (effect === undefined) throw new Error(`fixture effect "${name}" is not in the definition`);
  const payload = canonicalEffectPayload(name, effect.run.name, TARGET, ARTIFACT);
  return {
    kind: 'effect',
    phase,
    effect: name,
    operation: effect.run.name,
    role: effect.role.name,
    ...(effect.capability !== undefined ? { capability: effect.capability } : {}),
    ...(effect.actAs !== undefined ? { actAs: effect.actAs.value } : {}),
    reach: effect.reach?.value ?? 'local',
    target: TARGET,
    artifact: ARTIFACT,
    occurrence: occurrenceId(run, activation, name),
    payload,
    digest: payloadDigest(payload),
  };
}

/**
 * A scripted core double. It answers request acceptance first, exactly as the shared core does,
 * and otherwise returns the decision the runner recorded for that request. The fold is what is
 * under test; the definitions and identities are real.
 */
function scriptedDecide(truth: Map<string, Record<string, unknown>>) {
  return (input: unknown): unknown => {
    const core = input as {
      envelope: { requestId: string; evidence: string[]; target: string; artifact: ArtifactRef; move: unknown };
      run: { requests: ReadonlyMap<string, { payloadDigest: string; step: number }>; state: string; revision: number };
      signal: { name: string; at: string };
    };
    const used = core.run.requests.get(core.envelope.requestId);
    if (used !== undefined) {
      const digest = payloadDigest(canonicalRequestPayload(core.envelope as never));
      if (used.payloadDigest === digest) {
        return {
          kind: 'duplicate',
          at: core.signal.at,
          signal: core.signal.name,
          requestId: core.envelope.requestId,
          recorded: { step: used.step },
        };
      }
      return {
        kind: 'refused',
        code: 'core.request-conflict',
        why: 'request id reused with different canonical bytes',
        at: core.signal.at,
        state: core.run.state,
        revision: core.run.revision,
        signal: core.signal.name,
        requestId: core.envelope.requestId,
        evidence: [...core.envelope.evidence],
      };
    }
    const decision = truth.get(core.envelope.requestId);
    if (decision === undefined) throw new Error(`no scripted decision for ${core.envelope.requestId}`);
    return decision;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Fixture A: the two-step approval flow. Start enters with `plan`, mid enters with `mark`; every
// leaving step cites its approval/review and the successful outcome of the state's entry effect.
// ---------------------------------------------------------------------------------------------

const FLOW_SOURCE = `workflow: replay-flow
version: 1
initial: start
states:
  start:
    on-enter: [plan]
  mid:
    on-enter: [mark]
  done: {}
transitions:
  - { from: start, to: mid, on: approved, role: owner }
  - { from: mid, to: done, on: accepted, role: reviewer }
effects:
  plan: { run: review-morning, capability: read, role: operator }
  mark: { run: release-notes, capability: write, role: operator }
`;

function flowFixture() {
  const { workflow, definition } = parseOk(FLOW_SOURCE);
  const run = 'run-t2-0001';
  const startPlan = effectRecord(run, 'plan', 'start', 1, 'review-morning');
  const mark = effectRecord(run, 'mark', 'mid', 2, 'release-notes');
  const first = stepRecord({
    revision: 1,
    at: '2026-10-21T00:01:00Z',
    signal: 'approved',
    requestId: 'req-1',
    from: 'start',
    to: 'mid',
    activation: 2,
    evidence: ['ev-approval', 'ev-plan-done'],
    effects: [mark],
  });
  const second = stepRecord({
    revision: 2,
    at: '2026-10-21T00:02:00Z',
    signal: 'accepted',
    requestId: 'req-2',
    from: 'mid',
    to: 'done',
    activation: 3,
    evidence: ['ev-review', 'ev-mark-done'],
    effects: [],
  });
  const journal: DryRunJournal = {
    format: 1,
    kind: 'workflow-run-dry',
    authoritative: false,
    notice: NOTICE,
    definition,
    run,
    target: TARGET,
    artifact: ARTIFACT,
    inputs: {},
    settings: {},
    initial: 'start',
    start: { state: 'start', activation: 1, effects: [startPlan] },
    steps: [first, second],
    outcome: { kind: 'script-exhausted' },
  };
  const evidence: EvidenceDocument = {
    'ev-approval': { type: 'approval', target: TARGET },
    'ev-plan-done': {
      type: 'outcome',
      operation: 'review-morning',
      result: 'done',
      effect: startPlan.occurrence,
      target: TARGET,
    },
    'ev-review': { type: 'review', target: TARGET },
    'ev-mark-done': {
      type: 'outcome',
      operation: 'release-notes',
      result: 'done',
      effect: mark.occurrence,
      target: TARGET,
    },
  };
  const truth = new Map<string, Record<string, unknown>>([
    [
      'req-1',
      {
        kind: 'step',
        revision: 0,
        nextRevision: 1,
        at: first.at,
        signal: 'approved',
        requestId: 'req-1',
        transition: first.transition,
        plan: [
          { kind: 'state-entry', from: 'start', to: 'mid', on: 'approved', revision: 1 },
          planItem(run, workflow, 'mark', 'enter', 2),
        ],
        next: { state: 'mid', activation: 2 },
      },
    ],
    [
      'req-2',
      {
        kind: 'step',
        revision: 1,
        nextRevision: 2,
        at: second.at,
        signal: 'accepted',
        requestId: 'req-2',
        transition: second.transition,
        plan: [{ kind: 'state-entry', from: 'mid', to: 'done', on: 'accepted', revision: 2 }],
        next: { state: 'done', activation: 3 },
      },
    ],
  ]);
  return { source: FLOW_SOURCE, workflow, definition, run, journal, evidence, truth, first, second };
}

async function replayFlow(
  fixture: ReturnType<typeof flowFixture>,
  journal: DryRunJournal = fixture.journal,
  decide = scriptedDecide(fixture.truth),
): Promise<ReplayResult> {
  return replay({
    definitionBytes: new TextEncoder().encode(fixture.source),
    definition: fixture.workflow,
    journal,
    evidence: fixture.evidence,
    guards: GUARDS,
    decide,
  });
}

describe('replay folds the pinned definition, journal and evidence without writing', () => {
  test('a recorded two-step run folds to the same state, occurrences and requests', async () => {
    const fixture = flowFixture();
    const result = await replayFlow(fixture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = result.run as {
      runId: string;
      state: string;
      revision: number;
      activation: number;
      occurrences: ReadonlyMap<string, { id: string; effect: string; payloadDigest: string }>;
      requests: ReadonlyMap<string, { payloadDigest: string; step: number }>;
      waits: unknown[];
      blocked?: unknown;
    };
    expect(run.runId).toBe(fixture.run);
    expect(run.state).toBe('done');
    expect(run.revision).toBe(2);
    expect(run.activation).toBe(3);
    expect([...run.occurrences.keys()].sort()).toEqual([
      occurrenceId(fixture.run, 1, 'plan'),
      occurrenceId(fixture.run, 2, 'mark'),
    ]);
    expect(run.occurrences.get(occurrenceId(fixture.run, 1, 'plan'))?.payloadDigest).toBe(
      fixture.journal.start.effects[0]?.payloadDigest,
    );
    expect(run.requests.get('req-1')).toEqual({
      payloadDigest: fixture.first.requestDigest,
      step: 0,
    });
    expect(run.requests.get('req-2')).toEqual({
      payloadDigest: fixture.second.requestDigest,
      step: 1,
    });
    expect(run.waits).toEqual([]);
    expect(run.blocked).toBeUndefined();
  });

  test('replay is read-only: frozen inputs, one decide call per step, no files touched', async () => {
    const fixture = flowFixture();
    const before = JSON.stringify(fixture.journal);
    const calls: string[] = [];
    const decide = (input: unknown) => {
      const requestId = (input as { envelope: { requestId: string } }).envelope.requestId;
      calls.push(requestId);
      return scriptedDecide(fixture.truth)(input);
    };
    const dir = mkdtempSync(join(tmpdir(), 'replay-independent-'));
    const sentinel = join(dir, 'sentinel.txt');
    writeFileSync(sentinel, 'unchanged');
    const snapshot = `${readdirSync(dir).sort().join(',')}|${readFileSync(sentinel, 'utf8')}`;

    const result = await replayFlow(fixture, deepFreeze(structuredClone(fixture.journal)), decide);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['req-1', 'req-2']);
    expect(JSON.stringify(fixture.journal)).toBe(before);
    expect(`${readdirSync(dir).sort().join(',')}|${readFileSync(sentinel, 'utf8')}`).toBe(snapshot);
    expect(JSON.stringify(result)).not.toContain('"dispatched":true');
  });

  test('the journal reader accepts the record and refuses a foreign kind', async () => {
    const fixture = flowFixture();
    const { readJournal } = await seam();

    const parsed = readJournal(JSON.stringify(fixture.journal));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.journal.run).toBe(fixture.run);

    const foreign = readJournal(
      JSON.stringify({ ...fixture.journal, kind: 'workflow-run-live' }),
    );
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.code).toBe('workflow.journal');
  });
});

describe('replay fails closed on a changed pin or a tampered history', () => {
  test('a journal digest that does not match the definition bytes is refused', async () => {
    const fixture = flowFixture();
    const journal = structuredClone(fixture.journal);
    journal.definition = { ...journal.definition, digest: `sha256:${'0'.repeat(64)}` };

    const result = await replayFlow(fixture, journal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail.code).toBe('workflow.definition');
  });

  test('bytes for another definition are refused even when the parse is identical', async () => {
    const fixture = flowFixture();
    const changed = new TextEncoder().encode(`${fixture.source}# a changed byte comment\n`);

    const result = await replay({
      definitionBytes: changed,
      definition: fixture.workflow,
      journal: fixture.journal,
      evidence: fixture.evidence,
      guards: GUARDS,
      decide: scriptedDecide(fixture.truth),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail.code).toBe('workflow.definition');
    expect(result.fail.step).toBeUndefined();
  });

  test('a tampered step reports its zero-based index with the recorded and re-evaluated values', async () => {
    for (const index of [0, 1]) {
      const fixture = flowFixture();
      const journal = structuredClone(fixture.journal);
      const step = journal.steps[index]!;
      const tampered = { ...step.transition, to: step.transition.from };
      journal.steps[index] = {
        ...step,
        transition: tampered,
        requestDigest: payloadDigest(
          canonicalRequestPayload({
            move: { transition: tampered },
            target: TARGET,
            artifact: ARTIFACT,
            evidence: step.evidence,
          }),
        ),
      };

      const result = await replayFlow(fixture, journal);

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.fail.step).toBe(index);
      expect(result.fail.code).toBe('workflow.replay-mismatch');
      const shown = JSON.stringify({ expected: result.fail.expected, actual: result.fail.actual });
      expect(shown).toContain(`"to":"${tampered.to}"`);
      expect(shown).toContain(`"to":"${step.transition.to}"`);
    }
  });
});

const LOOP_SOURCE = `workflow: replay-loop
version: 1
initial: loop
states:
  loop: {}
transitions:
  - { from: loop, to: loop, on: pr-opened, role: operator }
`;

function loopFixture() {
  const { workflow, definition } = parseOk(LOOP_SOURCE);
  const run = 'run-t2-loop';
  const first = stepRecord({
    revision: 1,
    at: '2026-10-21T00:08:00Z',
    signal: 'pr-opened',
    requestId: 'req-loop',
    from: 'loop',
    to: 'loop',
    activation: 2,
    evidence: ['ev-step'],
    effects: [],
  });
  const journal: DryRunJournal = {
    format: 1,
    kind: 'workflow-run-dry',
    authoritative: false,
    notice: NOTICE,
    definition,
    run,
    target: TARGET,
    artifact: ARTIFACT,
    inputs: {},
    settings: {},
    initial: 'loop',
    start: { state: 'loop', activation: 1, effects: [] },
    steps: [first],
    outcome: { kind: 'script-exhausted' },
  };
  const evidence: EvidenceDocument = {
    'ev-step': { type: 'step', target: TARGET },
    'ev-other': { type: 'step', target: TARGET },
  };
  const truth = new Map<string, Record<string, unknown>>([
    [
      'req-loop',
      {
        kind: 'step',
        revision: 0,
        nextRevision: 1,
        at: first.at,
        signal: 'pr-opened',
        requestId: 'req-loop',
        transition: first.transition,
        plan: [{ kind: 'state-entry', from: 'loop', to: 'loop', on: 'pr-opened', revision: 1 }],
        next: { state: 'loop', activation: 2 },
      },
    ],
  ]);
  return { source: LOOP_SOURCE, workflow, definition, run, journal, evidence, truth };
}

function loopReplay(fixture: ReturnType<typeof loopFixture>, journal: DryRunJournal): Promise<ReplayResult> {
  return replay({
    definitionBytes: new TextEncoder().encode(fixture.source),
    definition: fixture.workflow,
    journal,
    evidence: fixture.evidence,
    guards: GUARDS,
    decide: scriptedDecide(fixture.truth),
  });
}

describe('replay refuses duplicated request and occurrence identities', () => {
  test('a step reusing a used request id with the same payload never folds as a step', async () => {
    const fixture = loopFixture();
    const journal = structuredClone(fixture.journal);
    // The self-loop makes the same move enabled again; the payload is exactly the first step's,
    // which is what makes the retry a duplicate rather than a conflict.
    journal.steps[1] = stepRecord({
      revision: 2,
      at: '2026-10-21T00:09:00Z',
      signal: 'pr-opened',
      requestId: 'req-loop',
      from: 'loop',
      to: 'loop',
      activation: 3,
      evidence: ['ev-step'],
      effects: [],
    });

    const result = await loopReplay(fixture, journal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail.step).toBe(1);
    expect(result.fail.code).toBe('workflow.replay-mismatch');
    const shown = JSON.stringify({ expected: result.fail.expected, actual: result.fail.actual });
    expect(shown).toContain('duplicate');
    expect(shown).toContain('"step":0');
  });

  test('a step reusing a used request id with different bytes is never applied', async () => {
    const fixture = loopFixture();
    const journal = structuredClone(fixture.journal);
    journal.steps[1] = stepRecord({
      revision: 2,
      at: '2026-10-21T00:09:00Z',
      signal: 'pr-opened',
      requestId: 'req-loop',
      from: 'loop',
      to: 'loop',
      activation: 3,
      evidence: ['ev-other'],
      effects: [],
    });

    const result = await loopReplay(fixture, journal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail.step).toBe(1);
    expect(JSON.stringify({ expected: result.fail.expected, actual: result.fail.actual })).toContain(
      'core.request-conflict',
    );
  });

  test('a second start effect on one occurrence id is a start-entry mismatch, never a fold', async () => {
    const fixture = flowFixture();
    const journal = structuredClone(fixture.journal);
    const planned = journal.start.effects[0]!;
    // The same occurrence id, recorded twice with different payloads: a corrupt history no runner
    // can produce. The derived start plan has one effect; the recorded side has two.
    const other = effectRecord(fixture.run, 'mark', 'start', 1, 'release-notes');
    journal.start.effects = [planned, { ...other, occurrence: planned.occurrence }];

    const result = await replayFlow(fixture, journal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fail.code).toBe('workflow.replay-mismatch');
    expect(result.fail.step).toBe(-1);
    expect(JSON.stringify(result.fail.actual)).toContain('"name":"mark"');
  });
});

// ---------------------------------------------------------------------------------------------
// Terminal stops: a stop is never a step. Its decision is re-evaluated, carries no revision
// advance, and the fold keeps the waiting state visible.
// ---------------------------------------------------------------------------------------------

const HELD_SOURCE = `workflow: replay-held
version: 1
initial: start
states:
  start:
    on-enter: [plan]
  after: {}
transitions:
  - { from: start, to: after, on: approved, role: owner }
effects:
  plan: { run: review-morning, capability: read, role: operator }
`;

const GUARD_SOURCE = `workflow: replay-guard
version: 1
initial: gate
states:
  gate: {}
  after: {}
transitions:
  - { from: gate, to: after, on: approved, guard: ci-green-on-head, role: owner }
`;

const TIME_SOURCE = `workflow: replay-time
version: 1
initial: night
states:
  night:
    wait: { for: time, at: morning-slot }
  done: {}
transitions:
  - { from: night, to: done, on: time-reached, role: owner }
`;

function stopFixture(source: string, run: string, stop: Record<string, unknown>, truth: Record<string, unknown>) {
  const { workflow, definition } = parseOk(source);
  const journal: DryRunJournal = {
    format: 1,
    kind: 'workflow-run-dry',
    authoritative: false,
    notice: NOTICE,
    definition,
    run,
    target: TARGET,
    artifact: ARTIFACT,
    inputs: {},
    settings: {},
    initial: workflow.initial ?? Object.keys(workflow.states)[0]!,
    start: { state: workflow.initial ?? Object.keys(workflow.states)[0]!, activation: 1, effects: [] },
    steps: [],
    outcome: {
      kind: 'stopped',
      // A request-derived stop records the request's own precondition, unchanged by the fold.
      ...(stop['signal'] !== undefined && stop['requestId'] !== undefined
        ? { expectedRevision: stop['expectedRevision'] ?? stop['revision'] ?? 0 }
        : {}),
      ...stop,
    } as DryRunJournal['outcome'],
  };
  return { source, workflow, definition, run, journal, truth, stop };
}

describe('replay re-evaluates terminal stops without advancing the run', () => {
  test('a held stop keeps its waitingOn and the run at revision zero', async () => {
    const run = 'run-t2-held';
    const occurrence = occurrenceId(run, 1, 'plan');
    const stop = {
      decision: 'held',
      code: 'evidence.missing',
      why: 'entry effect "plan" has no supplied outcome',
      at: '2026-10-21T00:03:00Z',
      state: 'start',
      revision: 0,
      signal: 'approved',
      requestId: 'req-held',
      evidence: ['ev-approval'],
      waitingOn: { kind: 'entry-effect', occurrence },
    };
    const fixture = stopFixture(HELD_SOURCE, run, stop, {
      kind: 'held',
      code: 'evidence.missing',
      why: stop.why,
      at: stop.at,
      state: 'start',
      revision: 0,
      signal: 'approved',
      requestId: 'req-held',
      transition: { from: 'start', to: 'after', on: 'approved' },
      evidence: ['ev-approval'],
      waitingOn: { kind: 'entry-effect', occurrence },
    });
    // The initial state enters with one planned effect; the held stop names its missing outcome.
    fixture.journal.start.effects = [effectRecord(run, 'plan', 'start', 1, 'review-morning')];

    const result = await replay({
      definitionBytes: new TextEncoder().encode(HELD_SOURCE),
      definition: fixture.workflow,
      journal: fixture.journal,
      evidence: { 'ev-approval': { type: 'approval', target: TARGET } },
      guards: GUARDS,
      decide: scriptedDecide(new Map([['req-held', fixture.truth]])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.run as {
      state: string;
      revision: number;
      activation: number;
      blocked?: Record<string, unknown>;
    };
    expect(state.state).toBe('start');
    expect(state.revision).toBe(0);
    expect(state.activation).toBe(1);
    expect(state.blocked).toEqual({
      decision: 'held',
      code: 'evidence.missing',
      state: 'start',
      revision: 0,
      waitingOn: { kind: 'entry-effect', occurrence },
    });
  });

  test('a false-guard stop keeps its refusal and the run at revision zero', async () => {
    const run = 'run-t2-guard';
    const stop = {
      decision: 'refused',
      code: 'core.guard-refused',
      why: 'the suite outcome for this head is not done',
      at: '2026-10-21T00:04:00Z',
      state: 'gate',
      revision: 0,
      signal: 'approved',
      requestId: 'req-guard',
      evidence: ['ev-approval', 'ev-suite'],
      guard: { name: 'ci-green-on-head', answer: false, evidence: ['ev-suite'] },
    };
    const fixture = stopFixture(GUARD_SOURCE, run, stop, {
      kind: 'refused',
      code: 'core.guard-refused',
      why: stop.why,
      at: stop.at,
      state: 'gate',
      revision: 0,
      signal: 'approved',
      requestId: 'req-guard',
      transition: { from: 'gate', to: 'after', on: 'approved' },
      evidence: ['ev-approval', 'ev-suite'],
      guard: { name: 'ci-green-on-head', answer: false, evidence: ['ev-suite'] },
    });

    const result = await replay({
      definitionBytes: new TextEncoder().encode(GUARD_SOURCE),
      definition: fixture.workflow,
      journal: fixture.journal,
      evidence: {
        'ev-approval': { type: 'approval', target: TARGET },
        'ev-suite': {
          type: 'outcome',
          operation: 'ci-suite',
          result: 'refused',
          effect: occurrenceId(run, 1, 'suite'),
          target: TARGET,
        },
      },
      guards: GUARDS,
      decide: scriptedDecide(new Map([['req-guard', fixture.truth]])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.run as { state: string; revision: number; blocked?: Record<string, unknown> };
    expect(state.state).toBe('gate');
    expect(state.revision).toBe(0);
    expect(state.blocked).toEqual({
      decision: 'refused',
      code: 'core.guard-refused',
      state: 'gate',
      revision: 0,
    });
  });

  test('a missing wait setting is held with the setting named and the wait pending', async () => {
    const run = 'run-t2-time';
    const stop = {
      decision: 'held',
      code: 'settings.missing',
      why: 'the wait setting "morning-slot" is not supplied',
      at: '2026-10-21T00:05:00Z',
      state: 'night',
      revision: 0,
      signal: 'time-reached',
      requestId: 'req-time',
      evidence: [],
      waitingOn: { kind: 'setting', name: 'morning-slot' },
    };
    const fixture = stopFixture(TIME_SOURCE, run, stop, {
      kind: 'held',
      code: 'settings.missing',
      why: stop.why,
      at: stop.at,
      state: 'night',
      revision: 0,
      signal: 'time-reached',
      requestId: 'req-time',
      transition: { from: 'night', to: 'done', on: 'time-reached' },
      evidence: [],
      waitingOn: { kind: 'setting', name: 'morning-slot' },
    });

    const result = await replay({
      definitionBytes: new TextEncoder().encode(TIME_SOURCE),
      definition: fixture.workflow,
      journal: fixture.journal,
      evidence: {},
      guards: GUARDS,
      decide: scriptedDecide(new Map([['req-time', fixture.truth]])),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.run as { waits: unknown[]; blocked?: Record<string, unknown> };
    expect(state.waits).toEqual([{ state: 'night', activation: 1, status: 'pending' }]);
    expect(state.blocked).toEqual({
      decision: 'held',
      code: 'settings.missing',
      state: 'night',
      revision: 0,
      waitingOn: { kind: 'setting', name: 'morning-slot' },
    });
  });
});

describe('replay derives waits from the definition and the journal settings', () => {
  const WAIT_SOURCE = `workflow: replay-waits
version: 1
initial: wait
states:
  wait:
    wait: { for: approval, role: owner }
  done: {}
transitions:
  - { from: wait, to: done, on: approved, role: owner }
`;

  test('an approval wait fires on the leaving step and carries its activation', async () => {
    const { workflow, definition } = parseOk(WAIT_SOURCE);
    const run = 'run-t2-wait';
    const step = stepRecord({
      revision: 1,
      at: '2026-10-21T00:06:00Z',
      signal: 'approved',
      requestId: 'req-wait',
      from: 'wait',
      to: 'done',
      activation: 2,
      evidence: ['ev-approval'],
      effects: [],
    });
    const journal: DryRunJournal = {
      format: 1,
      kind: 'workflow-run-dry',
      authoritative: false,
      notice: NOTICE,
      definition,
      run,
      target: TARGET,
      artifact: ARTIFACT,
      inputs: {},
      settings: {},
      initial: 'wait',
      start: { state: 'wait', activation: 1, effects: [] },
      steps: [step],
      outcome: { kind: 'script-exhausted' },
    };
    const truth = new Map<string, Record<string, unknown>>([
      [
        'req-wait',
        {
          kind: 'step',
          revision: 0,
          nextRevision: 1,
          at: step.at,
          signal: 'approved',
          requestId: 'req-wait',
          transition: step.transition,
          plan: [{ kind: 'state-entry', from: 'wait', to: 'done', on: 'approved', revision: 1 }],
          next: { state: 'done', activation: 2 },
        },
      ],
    ]);

    const result = await replay({
      definitionBytes: new TextEncoder().encode(WAIT_SOURCE),
      definition: workflow,
      journal,
      evidence: { 'ev-approval': { type: 'approval', target: TARGET } },
      guards: GUARDS,
      decide: scriptedDecide(truth),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.run as { state: string; waits: unknown[] };
    expect(state.state).toBe('done');
    expect(state.waits).toEqual([{ state: 'wait', activation: 1, status: 'fired' }]);
  });

  test('a time wait compares the recorded instant to the journal setting', async () => {
    const { workflow, definition } = parseOk(TIME_SOURCE);
    const run = 'run-t2-timer';
    const step = stepRecord({
      revision: 1,
      at: '2026-10-21T00:07:00Z',
      signal: 'time-reached',
      requestId: 'req-timer',
      from: 'night',
      to: 'done',
      activation: 2,
      evidence: ['ev-timer'],
      effects: [],
    });
    const journal: DryRunJournal = {
      format: 1,
      kind: 'workflow-run-dry',
      authoritative: false,
      notice: NOTICE,
      definition,
      run,
      target: TARGET,
      artifact: ARTIFACT,
      inputs: {},
      settings: { 'morning-slot': '2026-10-21T00:00:00Z' },
      initial: 'night',
      start: { state: 'night', activation: 1, effects: [] },
      steps: [step],
      outcome: { kind: 'script-exhausted' },
    };
    const truth = new Map<string, Record<string, unknown>>([
      [
        'req-timer',
        {
          kind: 'step',
          revision: 0,
          nextRevision: 1,
          at: step.at,
          signal: 'time-reached',
          requestId: 'req-timer',
          transition: step.transition,
          plan: [{ kind: 'state-entry', from: 'night', to: 'done', on: 'time-reached', revision: 1 }],
          next: { state: 'done', activation: 2 },
        },
      ],
    ]);

    const result = await replay({
      definitionBytes: new TextEncoder().encode(TIME_SOURCE),
      definition: workflow,
      journal,
      evidence: { 'ev-timer': { type: 'timer', target: TARGET } },
      guards: GUARDS,
      decide: scriptedDecide(truth),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.run as { state: string; waits: unknown[] };
    expect(state.state).toBe('done');
    expect(state.waits).toEqual([{ state: 'night', activation: 1, status: 'fired' }]);
  });
});
