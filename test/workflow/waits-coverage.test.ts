// Independent T3 coverage for the shared pure flat-wait helpers at their published pin
// (WAITS 5f92580e, module blob ff9368e3): `waitsAtEntry`, `fireRecordedWait`,
// `waitsAfterStep`. Authored from the published interface and the definition schema only — no
// builder test or fixture was read or copied. The fixtures here are authored in this file and
// parse-validated against the pinned schema.
//
// The families map to the record: the initial pending wait; the recorded fire from a supplied
// setting; the post-step fired/new-pending derivation; occurrence identity across re-entry; the
// early and missing-setting paths where the helper leaves the run unmoved and the core alone
// refuses or holds; and interoperability with the real core and the real replay fold, including
// the purity/no-second-engine boundary.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  DryStop,
  EvidenceDocument,
  EvidenceRecord,
  SignalName,
  Workflow,
  WorkflowEnvelope,
} from '../../src/workflow/index.ts';
import { decide } from '../../src/workflow/core.ts';
import type { CoreInput } from '../../src/workflow/core.ts';
import type { OccurrenceRecord, RunState, RunWait } from '../../src/workflow/core-state.ts';
import type { RunId } from '../../src/workflow/types.ts';
import type { EvidenceSource, SettingSource } from '../../src/workflow/registry.ts';
import { replay } from '../../src/workflow/replay.ts';
import * as waitsModule from '../../src/workflow/waits.ts';
import { fireRecordedWait, waitsAfterStep, waitsAtEntry } from '../../src/workflow/waits.ts';

const TARGET = 'main';
const ARTIFACT: ArtifactRef = { kind: 'none' };
const NOTICE = 'dry run — no record is written';
const GUARDS = provisionalResolvers().guards;

const EARLY = '2026-10-21T09:00:00Z';
const OPEN_AT = '2026-10-21T10:00:00Z';
const PAUSE_AT = '2026-10-21T11:00:00Z';
const LATE = '2026-10-21T12:00:00Z';

// ---------------------------------------------------------------------------------------------
// Fixtures: two states that each wait for the clock and re-enter each other; a one-transition
// approval wait; and a time wait whose state also enables another signal, so the core's own
// signal check is reachable with the wait still pending.
// ---------------------------------------------------------------------------------------------

const CYCLE_SOURCE = `workflow: t3-two-cycle-waits
version: 1
initial: open
states:
  open:
    on-enter: [pulse-open]
    wait:
      for: time
      at: open-at
  paused:
    on-enter: [pulse-paused]
    wait:
      for: time
      at: pause-at
transitions:
  - { from: open, to: paused, on: time-reached, role: lead }
  - { from: paused, to: open, on: time-reached, role: lead }
effects:
  pulse-open:
    run: release-notes
    role: lead
    capability: write
  pulse-paused:
    run: release-notes
    role: lead
    capability: write
`;

const APPROVAL_SOURCE = `workflow: t3-approval-wait
version: 1
initial: drafting
states:
  drafting:
    on-enter: [pulse-draft]
    wait:
      for: approval
      role: owner
  shipped:
    on-enter: [pulse-ship]
transitions:
  - { from: drafting, to: shipped, on: approved, role: owner }
effects:
  pulse-draft:
    run: release-notes
    role: lead
    capability: write
  pulse-ship:
    run: release-notes
    role: lead
    capability: write
`;

const SIGNAL_SOURCE = `workflow: t3-wait-signal-cross
version: 1
initial: ready
states:
  ready:
    on-enter: [pulse-ready]
    wait:
      for: time
      at: ready-at
  done: {}
transitions:
  - { from: ready, to: done, on: pr-opened, role: lead }
effects:
  pulse-ready:
    run: release-notes
    role: lead
    capability: write
`;

function parseOk(source: string): { workflow: Workflow; definition: DefinitionId } {
  const result = parseWorkflow(source);
  if (!('workflow' in result)) {
    throw new Error(`fixture did not parse: ${JSON.stringify(result)}`);
  }
  return { workflow: result.workflow, definition: result.definition };
}

const cycle = () => parseOk(CYCLE_SOURCE);
const approval = () => parseOk(APPROVAL_SOURCE);
const signal = () => parseOk(SIGNAL_SOURCE);

function settingsOf(map: Record<string, string>): SettingSource {
  return { get: (name) => (Object.hasOwn(map, name) ? map[name] : undefined) };
}

function evidenceOf(document: EvidenceDocument): EvidenceSource {
  return { record: (ref) => (Object.hasOwn(document, ref) ? document[ref] : undefined) };
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

function effectRecord(
  run: RunId,
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

/** The entry occurrences the pinned definition plans, exactly as the fold reconstructs them. */
function entryRecords(
  run: RunId,
  workflow: Workflow,
  stateName: string,
  activation: number,
): OccurrenceRecord[] {
  const state = workflow.states[stateName]!;
  return state.onEnter.map((hook) => {
    const effect = workflow.effects[hook.name]!;
    return {
      id: occurrenceId(run, activation, hook.name),
      effect: hook.name,
      state: stateName,
      activation,
      payloadDigest: payloadDigest(
        canonicalEffectPayload(hook.name, effect.run.name, TARGET, ARTIFACT),
      ),
    };
  });
}

function unitRun(
  definition: DefinitionId,
  state: string,
  activation: number,
  waits: RunWait[],
  options: { run?: string; occurrences?: OccurrenceRecord[] } = {},
): RunState {
  const occurrences = new Map<string, OccurrenceRecord>();
  for (const record of options.occurrences ?? []) occurrences.set(record.id, record);
  return {
    runId: options.run ?? 'run-t3-waits-unit',
    definitionId: definition,
    state,
    revision: 0,
    activation,
    occurrences,
    requests: new Map(),
    waits,
  };
}

function envelopeOf(args: {
  run: RunId;
  definition: DefinitionId;
  revision: number;
  requestId: string;
  from: string;
  to: string;
  on: SignalName;
  evidence: string[];
}): WorkflowEnvelope {
  return {
    format: 1,
    run: args.run,
    definition: args.definition,
    expectedRevision: args.revision,
    requestId: args.requestId,
    move: { transition: { from: args.from, to: args.to, on: args.on } },
    target: TARGET,
    artifact: ARTIFACT,
    evidence: args.evidence,
  };
}

function coreInput(args: {
  workflow: Workflow;
  definition: DefinitionId;
  run: RunState;
  envelope: WorkflowEnvelope;
  signal: { name: SignalName; at: string };
  evidence: EvidenceDocument;
  settings: Record<string, string>;
}): CoreInput {
  return {
    definition: args.workflow,
    definitionId: args.definition,
    run: args.run,
    envelope: args.envelope,
    signal: args.signal,
    evidence: evidenceOf(args.evidence),
    settings: settingsOf(args.settings),
    guards: GUARDS,
  };
}

// ---------------------------------------------------------------------------------------------
// The two-cycle journal: three recorded steps with distinct request ids and per-activation entry
// outcomes. The fold below drives the real core and the shared helpers; the same journal drives
// the real replay.
// ---------------------------------------------------------------------------------------------

type CycleStepInput = {
  revision: number;
  at: string;
  requestId: string;
  from: string;
  to: string;
  activation: number;
  evidence: string[];
  effects: DryEffectRecord[];
};

function journalStep(args: CycleStepInput): DryRunJournal['steps'][number] {
  const transition = { from: args.from, to: args.to, on: 'time-reached' as const };
  return {
    revision: args.revision,
    at: args.at,
    signal: 'time-reached',
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

function cycleFixture() {
  const { workflow, definition } = cycle();
  const run = 'run-t3-waits-cycle';
  const steps = [
    journalStep({
      revision: 1,
      at: OPEN_AT,
      requestId: 'req-cycle-1',
      from: 'open',
      to: 'paused',
      activation: 2,
      evidence: ['ev-timer-1', 'ev-open-1'],
      effects: [effectRecord(run, 'pulse-paused', 'paused', 2, 'release-notes')],
    }),
    journalStep({
      revision: 2,
      at: PAUSE_AT,
      requestId: 'req-cycle-2',
      from: 'paused',
      to: 'open',
      activation: 3,
      evidence: ['ev-timer-2', 'ev-paused-2'],
      effects: [effectRecord(run, 'pulse-open', 'open', 3, 'release-notes')],
    }),
    journalStep({
      revision: 3,
      at: LATE,
      requestId: 'req-cycle-3',
      from: 'open',
      to: 'paused',
      activation: 4,
      evidence: ['ev-timer-3', 'ev-open-3'],
      effects: [effectRecord(run, 'pulse-paused', 'paused', 4, 'release-notes')],
    }),
  ];
  const evidence: EvidenceDocument = {
    'ev-timer-1': { type: 'timer', target: TARGET },
    'ev-timer-2': { type: 'timer', target: TARGET },
    'ev-timer-3': { type: 'timer', target: TARGET },
    'ev-open-1': outcomeFor(run, 1, 'pulse-open'),
    'ev-paused-2': outcomeFor(run, 2, 'pulse-paused'),
    'ev-open-3': outcomeFor(run, 3, 'pulse-open'),
  };
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
    settings: { 'open-at': OPEN_AT, 'pause-at': PAUSE_AT },
    initial: 'open',
    start: { state: 'open', activation: 1, effects: [effectRecord(run, 'pulse-open', 'open', 1, 'release-notes')] },
    steps,
    outcome: { kind: 'script-exhausted' },
  };
  return { workflow, definition, source: CYCLE_SOURCE, run, journal, evidence, steps };
}

function outcomeFor(run: RunId, activation: number, effect: string): EvidenceRecord {
  return {
    type: 'outcome',
    operation: 'release-notes',
    result: 'done',
    effect: occurrenceId(run, activation, effect),
    target: TARGET,
  };
}

type CycleFixture = ReturnType<typeof cycleFixture>;

function startRun(fixture: CycleFixture): RunState {
  const occurrences = new Map<string, OccurrenceRecord>();
  for (const record of fixture.journal.start.effects) {
    occurrences.set(record.occurrence, {
      id: record.occurrence,
      effect: record.name,
      state: record.state,
      activation: record.activation,
      payloadDigest: record.payloadDigest,
    });
  }
  return {
    runId: fixture.run,
    definitionId: fixture.definition,
    state: fixture.journal.initial,
    revision: 0,
    activation: 1,
    occurrences,
    requests: new Map(),
    waits: waitsAtEntry(fixture.workflow, fixture.journal.initial, 1),
  };
}

/** The runner's order: entry waits, fire before decide, derive after the accepted step. */
function foldPrefix(fixture: CycleFixture, upto: number): RunState {
  let run = startRun(fixture);
  const settings = settingsOf(fixture.journal.settings);
  for (let index = 0; index < upto; index += 1) {
    const step = fixture.journal.steps[index]!;
    const decisionRun = fireRecordedWait(run, fixture.workflow, {
      signal: step.signal,
      at: step.at,
      settings,
    });
    const envelope = envelopeOf({
      run: fixture.run,
      definition: fixture.definition,
      revision: decisionRun.revision,
      requestId: step.requestId,
      from: step.transition.from,
      to: step.transition.to,
      on: step.signal,
      evidence: step.evidence,
    });
    const decision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run: decisionRun,
        envelope,
        signal: { name: step.signal, at: step.at },
        evidence: fixture.evidence,
        settings: fixture.journal.settings,
      }),
    );
    if (decision.kind !== 'step') {
      throw new Error(`step ${index} did not re-evaluate to a step: ${JSON.stringify(decision)}`);
    }
    const occurrences = new Map(decisionRun.occurrences);
    for (const item of decision.plan) {
      if (item.kind !== 'effect') continue;
      const state = item.phase === 'exit' ? decisionRun.state : decision.next.state;
      const activation = item.phase === 'exit' ? decisionRun.activation : decision.next.activation;
      occurrences.set(item.occurrence, {
        id: item.occurrence,
        effect: item.effect,
        state,
        activation,
        payloadDigest: item.digest,
      });
    }
    const requests = new Map(decisionRun.requests);
    requests.set(step.requestId, { payloadDigest: step.requestDigest, step: index });
    run = {
      ...decisionRun,
      state: decision.next.state,
      revision: decision.nextRevision,
      activation: decision.next.activation,
      occurrences,
      requests,
      waits: waitsAfterStep(decisionRun, fixture.workflow, {
        signal: step.signal,
        nextState: decision.next.state,
        nextActivation: decision.next.activation,
      }),
    };
  }
  return run;
}

function replayPrefix(fixture: CycleFixture, upto: number): RunState {
  const result = replay({
    definitionBytes: new TextEncoder().encode(fixture.source),
    definition: fixture.workflow,
    journal: { ...fixture.journal, steps: fixture.journal.steps.slice(0, upto) },
    evidence: fixture.evidence,
    guards: GUARDS,
    decide,
  });
  if (!result.ok) throw new Error(`replay refused: ${JSON.stringify(result.fail)}`);
  return result.run;
}

const WAITS_BY_PREFIX: RunWait[][] = [
  [{ state: 'open', activation: 1, status: 'pending' }],
  [
    { state: 'open', activation: 1, status: 'fired' },
    { state: 'paused', activation: 2, status: 'pending' },
  ],
  [
    { state: 'open', activation: 1, status: 'fired' },
    { state: 'paused', activation: 2, status: 'fired' },
    { state: 'open', activation: 3, status: 'pending' },
  ],
  [
    { state: 'open', activation: 1, status: 'fired' },
    { state: 'paused', activation: 2, status: 'fired' },
    { state: 'open', activation: 3, status: 'fired' },
    { state: 'paused', activation: 4, status: 'pending' },
  ],
];

// ---------------------------------------------------------------------------------------------
// A: the initial pending wait.
// ---------------------------------------------------------------------------------------------

describe('waitsAtEntry — the initial pending wait', () => {
  test('a state that declares a time wait starts one pending record at the given activation', () => {
    const { workflow } = cycle();
    const waits = waitsAtEntry(workflow, 'open', 1);
    expect(waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
    expect(Object.keys(waits[0]!).sort()).toEqual(['activation', 'state', 'status']);
  });

  test('the record carries the entry activation verbatim', () => {
    const { workflow } = cycle();
    expect(waitsAtEntry(workflow, 'paused', 7)).toEqual([
      { state: 'paused', activation: 7, status: 'pending' },
    ]);
  });

  test('an approval wait starts pending through the same entry path', () => {
    const { workflow } = approval();
    expect(waitsAtEntry(workflow, 'drafting', 1)).toEqual([
      { state: 'drafting', activation: 1, status: 'pending' },
    ]);
  });

  test('a state that declares no wait starts no record', () => {
    const { workflow } = approval();
    expect(waitsAtEntry(workflow, 'shipped', 2)).toEqual([]);
  });

  test('a state the definition does not declare starts no record', () => {
    const { workflow } = cycle();
    expect(waitsAtEntry(workflow, 'nowhere', 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B: the recorded fire from a supplied setting.
// ---------------------------------------------------------------------------------------------

describe('fireRecordedWait — supplied setting and recorded fire', () => {
  test('an instant equal to the setting fires exactly the matching pending wait', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const fired = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: OPEN_AT,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(fired).not.toBe(run);
    expect(fired.waits).toEqual([{ state: 'open', activation: 1, status: 'fired' }]);
    expect(run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
    expect(fired.state).toBe(run.state);
    expect(fired.revision).toBe(run.revision);
    expect(fired.activation).toBe(run.activation);
  });

  test('an instant after the setting fires too', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const fired = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(fired.waits).toEqual([{ state: 'open', activation: 1, status: 'fired' }]);
  });

  test('an instant before the setting returns the identical run and leaves the wait pending', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const unchanged = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: EARLY,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(unchanged).toBe(run);
    expect(run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });

  test('a missing setting returns the identical run and reads the definition’s setting name', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const asked: string[] = [];
    const settings: SettingSource = {
      get(name) {
        asked.push(name);
        return undefined;
      },
    };
    const unchanged = fireRecordedWait(run, workflow, { signal: 'time-reached', at: LATE, settings });
    expect(unchanged).toBe(run);
    expect(asked).toEqual(['open-at']);
  });

  test('a signal other than time-reached never fires a time wait', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const unchanged = fireRecordedWait(run, workflow, {
      signal: 'approved',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(unchanged).toBe(run);
  });

  test('an approval wait is never fired by the recorded-fire helper, even on approved', () => {
    const { workflow, definition } = approval();
    const run = unitRun(definition, 'drafting', 1, [
      { state: 'drafting', activation: 1, status: 'pending' },
    ]);
    const unchanged = fireRecordedWait(run, workflow, {
      signal: 'approved',
      at: LATE,
      settings: settingsOf({}),
    });
    expect(unchanged).toBe(run);
  });

  test('no record for the current activation means nothing is fired', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 2, status: 'pending' }]);
    const unchanged = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(unchanged).toBe(run);
  });

  test('records of other activations and states are preserved in order', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 3, [
      { state: 'paused', activation: 2, status: 'fired' },
      { state: 'open', activation: 3, status: 'pending' },
    ]);
    const fired = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(fired.waits).toEqual([
      { state: 'paused', activation: 2, status: 'fired' },
      { state: 'open', activation: 3, status: 'fired' },
    ]);
  });

  test('firing an already-fired wait changes no content (one recorded fire)', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'fired' }]);
    const again = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(again.waits).toEqual([{ state: 'open', activation: 1, status: 'fired' }]);
  });

  test('a frozen input run is never mutated', () => {
    const { workflow, definition } = cycle();
    const run = deepFreeze(
      unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]),
    );
    const fired = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: OPEN_AT,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    expect(fired.waits).toEqual([{ state: 'open', activation: 1, status: 'fired' }]);
    expect(run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// C: the post-step fired / new-pending derivation.
// ---------------------------------------------------------------------------------------------

describe('waitsAfterStep — post-step fired and new pending waits', () => {
  test('a time step fires the leaving wait and starts the entered wait as pending', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'time-reached',
      nextState: 'paused',
      nextActivation: 2,
    });
    expect(waits).toEqual([
      { state: 'open', activation: 1, status: 'fired' },
      { state: 'paused', activation: 2, status: 'pending' },
    ]);
    expect(waits).not.toBe(run.waits);
    expect(run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
    expect(Object.keys(waits[1]!).sort()).toEqual(['activation', 'state', 'status']);
  });

  test('an approval step fires the leaving wait and adds nothing when the entered state waits for nothing', () => {
    const { workflow, definition } = approval();
    const run = unitRun(definition, 'drafting', 1, [
      { state: 'drafting', activation: 1, status: 'pending' },
    ]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'approved',
      nextState: 'shipped',
      nextActivation: 2,
    });
    expect(waits).toEqual([{ state: 'drafting', activation: 1, status: 'fired' }]);
  });

  test('a signal that does not fire the leaving wait leaves it pending', () => {
    const { workflow, definition } = signal();
    const run = unitRun(definition, 'ready', 1, [{ state: 'ready', activation: 1, status: 'pending' }]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'pr-opened',
      nextState: 'done',
      nextActivation: 2,
    });
    expect(waits).toEqual([{ state: 'ready', activation: 1, status: 'pending' }]);
  });

  test('records of another activation are untouched and the entered wait appends last', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 3, [
      { state: 'paused', activation: 2, status: 'fired' },
      { state: 'open', activation: 3, status: 'pending' },
    ]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'time-reached',
      nextState: 'paused',
      nextActivation: 4,
    });
    expect(waits).toEqual([
      { state: 'paused', activation: 2, status: 'fired' },
      { state: 'open', activation: 3, status: 'fired' },
      { state: 'paused', activation: 4, status: 'pending' },
    ]);
  });

  test('an entered state without a wait appends nothing, and the array is still new', () => {
    const { workflow, definition } = approval();
    const run = unitRun(definition, 'drafting', 1, [
      { state: 'drafting', activation: 1, status: 'pending' },
    ]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'approved',
      nextState: 'shipped',
      nextActivation: 2,
    });
    expect(waits).not.toBe(run.waits);
    expect(waits).toEqual([{ state: 'drafting', activation: 1, status: 'fired' }]);
  });

  test('a leaving state with no wait adds only the entered pending record', () => {
    const { workflow, definition } = approval();
    const run = unitRun(definition, 'shipped', 2, []);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'approved',
      nextState: 'drafting',
      nextActivation: 3,
    });
    expect(waits).toEqual([{ state: 'drafting', activation: 3, status: 'pending' }]);
  });

  test('a frozen input run is never mutated', () => {
    const { workflow, definition } = cycle();
    const run = deepFreeze(
      unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]),
    );
    const waits = waitsAfterStep(run, workflow, {
      signal: 'time-reached',
      nextState: 'paused',
      nextActivation: 2,
    });
    expect(waits).toEqual([
      { state: 'open', activation: 1, status: 'fired' },
      { state: 'paused', activation: 2, status: 'pending' },
    ]);
    expect(run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// D: occurrence identity across re-entry through the real fold and the real replay.
// ---------------------------------------------------------------------------------------------

describe('occurrence identity across re-entry', () => {
  test('the helper fold reproduces the real replay waits at every prefix of the two-cycle journal', () => {
    const fixture = cycleFixture();
    for (let upto = 0; upto <= fixture.steps.length; upto += 1) {
      const folded = foldPrefix(fixture, upto);
      const replayed = replayPrefix(fixture, upto);
      expect(folded.waits).toEqual(replayed.waits);
      expect(folded.waits).toEqual(WAITS_BY_PREFIX[upto]!);
    }
  });

  test('each state activation keeps its own wait and re-entry produces distinct activation ids', () => {
    const fixture = cycleFixture();
    const run = replayPrefix(fixture, fixture.steps.length);
    const pairs = run.waits.map((wait) => `${wait.state}/${wait.activation}`);
    expect(pairs).toEqual(['open/1', 'paused/2', 'open/3', 'paused/4']);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  test('the entry occurrences of the two visits to the same state are distinct records', () => {
    const fixture = cycleFixture();
    const run = replayPrefix(fixture, fixture.steps.length);
    const firstOpen = occurrenceId(fixture.run, 1, 'pulse-open');
    const secondOpen = occurrenceId(fixture.run, 3, 'pulse-open');
    expect(run.occurrences.has(firstOpen)).toBe(true);
    expect(run.occurrences.has(secondOpen)).toBe(true);
    expect(firstOpen).not.toBe(secondOpen);
    expect(run.occurrences.get(firstOpen)!.activation).toBe(1);
    expect(run.occurrences.get(secondOpen)!.activation).toBe(3);
  });

  test('the initial wait is pending before the first step and fired after it, in both drivers', () => {
    const fixture = cycleFixture();
    const before = replayPrefix(fixture, 0);
    const after = replayPrefix(fixture, 1);
    expect(before.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
    expect(after.waits).toEqual([
      { state: 'open', activation: 1, status: 'fired' },
      { state: 'paused', activation: 2, status: 'pending' },
    ]);
    expect(foldPrefix(fixture, 1).waits).toEqual(after.waits);
  });
});

// ---------------------------------------------------------------------------------------------
// E: the approval wait — fired only by the accepted approval step, through the real core.
// ---------------------------------------------------------------------------------------------

function approvalFixture() {
  const { workflow, definition } = approval();
  const run = 'run-t3-waits-approval';
  const evidence: EvidenceDocument = {
    'ev-approval': { type: 'approval', target: TARGET },
    'ev-draft': outcomeFor(run, 1, 'pulse-draft'),
  };
  const step: DryRunJournal['steps'][number] = {
    revision: 1,
    at: LATE,
    signal: 'approved',
    requestId: 'req-approval-1',
    requestDigest: payloadDigest(
      canonicalRequestPayload({
        move: { transition: { from: 'drafting', to: 'shipped', on: 'approved' } },
        target: TARGET,
        artifact: ARTIFACT,
        evidence: ['ev-approval', 'ev-draft'],
      }),
    ),
    transition: { from: 'drafting', to: 'shipped', on: 'approved' },
    activation: 2,
    evidence: ['ev-approval', 'ev-draft'],
    effects: [effectRecord(run, 'pulse-ship', 'shipped', 2, 'release-notes')],
  };
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
    initial: 'drafting',
    start: {
      state: 'drafting',
      activation: 1,
      effects: [effectRecord(run, 'pulse-draft', 'drafting', 1, 'release-notes')],
    },
    steps: [step],
    outcome: { kind: 'script-exhausted' },
  };
  return { workflow, definition, source: APPROVAL_SOURCE, run, journal, evidence, step };
}

describe('approval waits through the real core and replay', () => {
  test('the recorded-fire helper never fires an approval wait; the accepted step fires it', () => {
    const fixture = approvalFixture();
    const occurrences = new Map<string, OccurrenceRecord>();
    for (const record of entryRecords(fixture.run, fixture.workflow, 'drafting', 1)) {
      occurrences.set(record.id, record);
    }
    const entry = unitRun(fixture.definition, 'drafting', 1, waitsAtEntry(fixture.workflow, 'drafting', 1), {
      run: fixture.run,
      occurrences: [...occurrences.values()],
    });
    const fired = fireRecordedWait(entry, fixture.workflow, {
      signal: 'approved',
      at: LATE,
      settings: settingsOf({}),
    });
    expect(fired).toBe(entry);
    const envelope = envelopeOf({
      run: fixture.run,
      definition: fixture.definition,
      revision: 0,
      requestId: fixture.step.requestId,
      from: 'drafting',
      to: 'shipped',
      on: 'approved',
      evidence: fixture.step.evidence,
    });
    const decision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run: fired,
        envelope,
        signal: { name: 'approved', at: LATE },
        evidence: fixture.evidence,
        settings: {},
      }),
    );
    expect(decision.kind).toBe('step');
    if (decision.kind !== 'step') throw new Error('unreachable');
    expect(decision.next).toEqual({ state: 'shipped', activation: 2 });
    const waits = waitsAfterStep(fired, fixture.workflow, {
      signal: 'approved',
      nextState: decision.next.state,
      nextActivation: decision.next.activation,
    });
    expect(waits).toEqual([{ state: 'drafting', activation: 1, status: 'fired' }]);
  });

  test('the real replay derives the same fired approval wait, and the entered state adds none', () => {
    const fixture = approvalFixture();
    const result = replay({
      definitionBytes: new TextEncoder().encode(fixture.source),
      definition: fixture.workflow,
      journal: fixture.journal,
      evidence: fixture.evidence,
      guards: GUARDS,
      decide,
    });
    if (!result.ok) throw new Error(`replay refused: ${JSON.stringify(result.fail)}`);
    expect(result.run.waits).toEqual([{ state: 'drafting', activation: 1, status: 'fired' }]);
    expect(result.run.state).toBe('shipped');
    expect(result.run.activation).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// F: the early and missing-setting paths — the helper leaves the run unmoved; the core answers.
// ---------------------------------------------------------------------------------------------

describe('early and missing-setting paths keep the core in authority', () => {
  function startFixture() {
    const fixture = cycleFixture();
    return { fixture, run: startRun(fixture) };
  }

  function timerEnvelope(fixture: CycleFixture): WorkflowEnvelope {
    return envelopeOf({
      run: fixture.run,
      definition: fixture.definition,
      revision: 0,
      requestId: 'req-early-1',
      from: 'open',
      to: 'paused',
      on: 'time-reached',
      evidence: ['ev-timer-1', 'ev-open-1'],
    });
  }

  test('an instant before the setting: the helper returns the identical run, the core refuses wait-not-reached', () => {
    const { fixture, run } = startFixture();
    const unchanged = fireRecordedWait(run, fixture.workflow, {
      signal: 'time-reached',
      at: EARLY,
      settings: settingsOf(fixture.journal.settings),
    });
    expect(unchanged).toBe(run);
    const decision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run: unchanged,
        envelope: timerEnvelope(fixture),
        signal: { name: 'time-reached', at: EARLY },
        evidence: fixture.evidence,
        settings: fixture.journal.settings,
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind !== 'refused') throw new Error('unreachable');
    expect(decision.code).toBe('core.wait-not-reached');
    expect(decision.state).toBe('open');
    expect(decision.revision).toBe(0);
    expect(unchanged.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });

  test('a missing setting: the helper returns the identical run, the core holds settings.missing', () => {
    const { fixture, run } = startFixture();
    const unchanged = fireRecordedWait(run, fixture.workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({}),
    });
    expect(unchanged).toBe(run);
    const decision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run: unchanged,
        envelope: timerEnvelope(fixture),
        signal: { name: 'time-reached', at: LATE },
        evidence: fixture.evidence,
        settings: {},
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind !== 'held') throw new Error('unreachable');
    expect(decision.code).toBe('settings.missing');
    expect(decision.waitingOn).toEqual({ kind: 'setting', name: 'open-at' });
    expect(decision.state).toBe('open');
    expect(decision.revision).toBe(0);
    expect(unchanged.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });

  test('a pending wait at or after the setting is answered wait-pending until the helper fires it', () => {
    const { fixture, run } = startFixture();
    const pendingDecision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run,
        envelope: timerEnvelope(fixture),
        signal: { name: 'time-reached', at: LATE },
        evidence: fixture.evidence,
        settings: fixture.journal.settings,
      }),
    );
    expect(pendingDecision.kind).toBe('refused');
    if (pendingDecision.kind !== 'refused') throw new Error('unreachable');
    expect(pendingDecision.code).toBe('core.wait-pending');

    const fired = fireRecordedWait(run, fixture.workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf(fixture.journal.settings),
    });
    const stepDecision = decide(
      coreInput({
        workflow: fixture.workflow,
        definition: fixture.definition,
        run: fired,
        envelope: timerEnvelope(fixture),
        signal: { name: 'time-reached', at: LATE },
        evidence: fixture.evidence,
        settings: fixture.journal.settings,
      }),
    );
    expect(stepDecision.kind).toBe('step');
  });

  test('a time wait never answers another signal with a step, whatever the helper does', () => {
    const { workflow, definition } = signal();
    const run = unitRun(definition, 'ready', 1, waitsAtEntry(workflow, 'ready', 1), {
      run: 'run-t3-waits-signal',
      occurrences: entryRecords('run-t3-waits-signal', workflow, 'ready', 1),
    });
    const unchanged = fireRecordedWait(run, workflow, {
      signal: 'pr-opened',
      at: LATE,
      settings: settingsOf({ 'ready-at': OPEN_AT }),
    });
    expect(unchanged).toBe(run);
    const decision = decide(
      coreInput({
        workflow,
        definition,
        run: unchanged,
        envelope: envelopeOf({
          run: 'run-t3-waits-signal',
          definition,
          revision: 0,
          requestId: 'req-signal-1',
          from: 'ready',
          to: 'done',
          on: 'pr-opened',
          evidence: ['ev-step', 'ev-ready'],
        }),
        signal: { name: 'pr-opened', at: LATE },
        evidence: {
          'ev-step': { type: 'step', target: TARGET },
          'ev-ready': outcomeFor('run-t3-waits-signal', 1, 'pulse-ready'),
        },
        settings: { 'ready-at': OPEN_AT },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind !== 'refused') throw new Error('unreachable');
    expect(decision.code).toBe('core.wait-pending');
  });

  test('the real replay records the early refusal with the run unmoved', () => {
    const fixture = cycleFixture();
    const stop: DryStop & { expectedRevision: number } = {
      decision: 'refused',
      code: 'core.wait-not-reached',
      why: 'the recorded instant is before the wait setting',
      at: EARLY,
      state: 'open',
      revision: 0,
      expectedRevision: 0,
      signal: 'time-reached',
      requestId: 'req-stop-early',
      evidence: ['ev-timer-1', 'ev-open-1'],
    };
    const result = replay({
      definitionBytes: new TextEncoder().encode(fixture.source),
      definition: fixture.workflow,
      journal: { ...fixture.journal, steps: [], outcome: { kind: 'stopped', ...stop } },
      evidence: fixture.evidence,
      guards: GUARDS,
      decide,
    });
    if (!result.ok) throw new Error(`replay refused: ${JSON.stringify(result.fail)}`);
    expect(result.run.blocked).toEqual({
      decision: 'refused',
      code: 'core.wait-not-reached',
      state: 'open',
      revision: 0,
    });
    expect(result.run.state).toBe('open');
    expect(result.run.revision).toBe(0);
    expect(result.run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });

  test('the real replay records the missing-setting hold with the run unmoved', () => {
    const fixture = cycleFixture();
    const stop: DryStop & { expectedRevision: number } = {
      decision: 'held',
      code: 'settings.missing',
      why: 'the wait setting is not supplied',
      at: LATE,
      state: 'open',
      revision: 0,
      expectedRevision: 0,
      waitingOn: { kind: 'setting', name: 'open-at' },
      signal: 'time-reached',
      requestId: 'req-stop-missing',
      evidence: ['ev-timer-1', 'ev-open-1'],
    };
    const result = replay({
      definitionBytes: new TextEncoder().encode(fixture.source),
      definition: fixture.workflow,
      journal: {
        ...fixture.journal,
        settings: {},
        steps: [],
        outcome: { kind: 'stopped', ...stop },
      },
      evidence: fixture.evidence,
      guards: GUARDS,
      decide,
    });
    if (!result.ok) throw new Error(`replay refused: ${JSON.stringify(result.fail)}`);
    expect(result.run.blocked).toEqual({
      decision: 'held',
      code: 'settings.missing',
      state: 'open',
      revision: 0,
      waitingOn: { kind: 'setting', name: 'open-at' },
    });
    expect(result.run.state).toBe('open');
    expect(result.run.revision).toBe(0);
    expect(result.run.waits).toEqual([{ state: 'open', activation: 1, status: 'pending' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// G: purity and the no-second-engine boundary.
// ---------------------------------------------------------------------------------------------

describe('purity and the no-second-engine boundary', () => {
  const modulePath = join(import.meta.dir, '..', '..', 'src', 'workflow', 'waits.ts');
  const source = readFileSync(modulePath, 'utf8');
  /** Comments mention the excluded mechanisms; the executable text must not. */
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  test('the module exports exactly the three published helpers', () => {
    expect(Object.keys(waitsModule).sort()).toEqual([
      'fireRecordedWait',
      'waitsAfterStep',
      'waitsAtEntry',
    ]);
  });

  test('every import is type-only and names only the shared type modules', () => {
    const imports = executable
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('import '));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) {
      expect(line.startsWith('import type ')).toBe(true);
      expect(line).toMatch(/from '(\.\/core-state\.ts|\.\/registry\.ts|\.\/signals\.ts|\.\/types\.ts)'/);
    }
  });

  test('the executable text carries no timer, clock, worker, promise or async surface', () => {
    expect(executable).not.toMatch(
      /\b(setTimeout|setInterval|setImmediate|queueMicrotask|performance|Worker|Promise|async|await|Date)\b/,
    );
  });

  test('the module does not import the core, the replay fold or a second engine', () => {
    expect(source).not.toMatch(/from '\.\/(core|replay)\.ts'/);
  });

  test('the helpers return synchronously and never a promise', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const entry = waitsAtEntry(workflow, 'open', 1);
    const fired = fireRecordedWait(run, workflow, {
      signal: 'time-reached',
      at: LATE,
      settings: settingsOf({ 'open-at': OPEN_AT }),
    });
    const after = waitsAfterStep(run, workflow, {
      signal: 'time-reached',
      nextState: 'paused',
      nextActivation: 2,
    });
    for (const value of [entry, fired, after]) {
      expect(value instanceof Promise).toBe(false);
      expect(value).not.toBeNull();
      expect(typeof value).toBe('object');
    }
  });

  test('the same inputs twice produce deep-equal outputs', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const call = () =>
      fireRecordedWait(run, workflow, {
        signal: 'time-reached',
        at: LATE,
        settings: settingsOf({ 'open-at': OPEN_AT }),
      });
    expect(call().waits).toEqual(call().waits);
    expect(waitsAtEntry(workflow, 'open', 1)).toEqual(waitsAtEntry(workflow, 'open', 1));
  });

  test('the post-step helper returns waits only and never a decision surface', () => {
    const { workflow, definition } = cycle();
    const run = unitRun(definition, 'open', 1, [{ state: 'open', activation: 1, status: 'pending' }]);
    const waits = waitsAfterStep(run, workflow, {
      signal: 'time-reached',
      nextState: 'paused',
      nextActivation: 2,
    });
    expect(Array.isArray(waits)).toBe(true);
    for (const wait of waits) {
      expect(Object.keys(wait).sort()).toEqual(['activation', 'state', 'status']);
    }
  });
});
