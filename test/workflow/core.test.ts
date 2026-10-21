import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  canonicalEffectPayload,
  canonicalRequestPayload,
  occurrenceId,
  payloadDigest,
} from '../../src/workflow/canonical.ts';
import { DECISION_CODES } from '../../src/workflow/codes.ts';
import { decide } from '../../src/workflow/core.ts';
import type { CoreInput, StepDecision } from '../../src/workflow/core.ts';
import type { OccurrenceRecord, RunState } from '../../src/workflow/core-state.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import type { EvidenceSource, GuardCatalogue, SettingSource } from '../../src/workflow/registry.ts';
import type { SignalName } from '../../src/workflow/signals.ts';
import type {
  ArtifactRef,
  DefinitionId,
  EvidenceRecord,
  EvidenceRef,
  Workflow,
  WorkflowEffect,
  WorkflowEnvelope,
  WorkflowState,
  WorkflowTransition,
  WorkflowWait,
} from '../../src/workflow/types.ts';

const target = 'refs/heads/main';
const artifact: ArtifactRef = { kind: 'ref', value: 'v0.5.4' };
const definitionId: DefinitionId = {
  workflow: 'release',
  schemaVersion: 1,
  digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
};
const at = '2026-10-21T12:00:00Z';

function effect(name: string, operation: string): WorkflowEffect {
  return {
    line: 1,
    name,
    run: { name: operation, line: 1 },
    role: { name: 'builder', line: 1 },
    capability: 'write',
  };
}

function state(
  name: string,
  onEnter: string[] = [],
  onLeave: string[] = [],
  wait?: WorkflowWait,
): WorkflowState {
  return {
    line: 1,
    name,
    onEnter: onEnter.map((item) => ({ name: item, line: 1 })),
    onLeave: onLeave.map((item) => ({ name: item, line: 1 })),
    ...(wait !== undefined ? { wait } : {}),
  };
}

function transition(
  from: string,
  to: string,
  on: SignalName,
  guard?: string,
): WorkflowTransition {
  return {
    line: 1,
    from,
    to,
    on,
    role: { name: 'lead', line: 1 },
    ...(guard !== undefined ? { guard: { name: guard, line: 1 } } : {}),
  };
}

function workflow(parts: {
  states: Record<string, WorkflowState>;
  transitions: WorkflowTransition[];
  effects?: Record<string, WorkflowEffect>;
}): Workflow {
  return {
    line: 1,
    name: 'release',
    version: 1,
    initial: Object.keys(parts.states)[0]!,
    on: [],
    inputs: [],
    states: parts.states,
    transitions: parts.transitions,
    effects: parts.effects ?? {},
    library: {},
  };
}

function source(records: Record<EvidenceRef, EvidenceRecord>): EvidenceSource {
  return { record: (ref) => records[ref] };
}

function settingsSource(settings: Record<string, string>): SettingSource {
  return { get: (name) => settings[name] };
}

function moveTo(definition: Workflow, from: string, on: SignalName): string {
  const matches = definition.transitions.filter(
    (candidate) => candidate.from === from && candidate.on === on,
  );
  return matches[0]?.to ?? 'missing';
}

type Scene = {
  definition: Workflow;
  run?: Partial<RunState>;
  envelope?: Partial<WorkflowEnvelope>;
  signal?: { name: SignalName; at: string };
  evidence?: Record<EvidenceRef, EvidenceRecord>;
  settingValues?: Record<string, string>;
  guards?: GuardCatalogue;
};

function scene(parts: Scene): CoreInput {
  const run: RunState = {
    runId: 'run-1',
    definitionId,
    state: 'prep',
    revision: 0,
    activation: 1,
    occurrences: new Map(),
    requests: new Map(),
    waits: [],
    ...parts.run,
  };
  const signal = parts.signal ?? { name: 'gate-passed', at };
  const evidence = parts.evidence ?? gateEvidence();
  const envelope: WorkflowEnvelope = {
    format: 1,
    run: run.runId,
    definition: definitionId,
    expectedRevision: run.revision,
    requestId: 'req-1',
    move: {
      transition: {
        from: run.state,
        to: moveTo(parts.definition, run.state, signal.name),
        on: signal.name,
      },
    },
    target,
    artifact,
    evidence: Object.keys(evidence),
    ...parts.envelope,
  };
  return {
    definition: parts.definition,
    definitionId,
    run,
    envelope,
    signal,
    evidence: source(evidence),
    settings: settingsSource(parts.settingValues ?? {}),
    guards: parts.guards ?? provisionalResolvers().guards,
  };
}

function occurrences(
  entries: Array<{ effect: string; state: string; activation: number; operation: string }>,
): Map<string, OccurrenceRecord> {
  const map = new Map<string, OccurrenceRecord>();
  for (const entry of entries) {
    const id = occurrenceId('run-1', entry.activation, entry.effect);
    map.set(id, {
      id,
      effect: entry.effect,
      state: entry.state,
      activation: entry.activation,
      payloadDigest: payloadDigest(
        canonicalEffectPayload(entry.effect, entry.operation, target, artifact),
      ),
    });
  }
  return map;
}

function gateEvidence(ref = 'ev-gate'): Record<EvidenceRef, EvidenceRecord> {
  return { [ref]: { type: 'gate', target } };
}

function outcomeEvidence(
  occurrence: string,
  operation: string,
  result: 'done' | 'refused',
  extra: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return { type: 'outcome', operation, effect: occurrence, result, target, ...extra };
}

function maybeStep(decision: ReturnType<typeof decide>): StepDecision {
  if (decision.kind !== 'step') {
    throw new Error(`expected a step, got ${decision.kind}: ${JSON.stringify(decision)}`);
  }
  return decision;
}

// ---------------------------------------------------------------------------------------------
// G — selection
// ---------------------------------------------------------------------------------------------

describe('selection', () => {
  const release = workflow({
    states: { prep: state('prep'), tagging: state('tagging', ['tag']) },
    transitions: [transition('prep', 'tagging', 'gate-passed')],
    effects: { tag: effect('tag', 'release-tag') },
  });

  test('G1 one enabled transition is a step with the entered activation and its entry effect', () => {
    const decision = maybeStep(decide(scene({ definition: release })));
    expect(decision.transition).toEqual({ from: 'prep', to: 'tagging', on: 'gate-passed' });
    expect(decision.revision).toBe(0);
    expect(decision.nextRevision).toBe(1);
    expect(decision.next).toEqual({ state: 'tagging', activation: 2 });
    expect(decision.plan.map((item) => item.kind)).toEqual(['state-entry', 'effect']);
    const effectItem = decision.plan[1]!;
    expect(effectItem.kind).toBe('effect');
    if (effectItem.kind === 'effect') {
      expect(effectItem.occurrence).toBe('run-1/2/tag');
      expect(effectItem.phase).toBe('enter');
    }
  });

  test('G7 an envelope move that names another transition is an invariant', () => {
    const input = scene({ definition: release });
    const moved: CoreInput = {
      ...input,
      envelope: {
        ...input.envelope,
        move: { transition: { from: 'prep', to: 'publishing', on: 'gate-passed' } },
      },
    };
    expect(() => decide(moved)).toThrow(/core invariant/);
  });

  test('G8 an operation move is an invariant for the transition core', () => {
    const input = scene({ definition: release });
    const moved: CoreInput = {
      ...input,
      envelope: { ...input.envelope, move: { operation: { name: 'release-tag' } } },
    };
    expect(() => decide(moved)).toThrow(/core invariant/);
  });

  test('G2 a signal with no transition at the state is an invariant', () => {
    const decision = scene({
      definition: release,
      signal: { name: 'approved', at },
      evidence: { 'ev-approval': { type: 'approval', target } },
    });
    expect(() => decide(decision)).toThrow(/0 enabled transitions/);
  });

  test('G3 two enabled transitions are an invariant, never a selection', () => {
    const ambiguous = workflow({
      states: { prep: state('prep'), a: state('a'), b: state('b') },
      transitions: [
        transition('prep', 'a', 'gate-passed'),
        transition('prep', 'b', 'gate-passed'),
      ],
    });
    expect(() => decide(scene({ definition: ambiguous }))).toThrow(/2 enabled transitions/);
  });

  test('G6 a transition target outside the definition is an invariant', () => {
    const dangling = workflow({
      states: { prep: state('prep') },
      transitions: [transition('prep', 'nowhere', 'gate-passed')],
    });
    expect(() => decide(scene({ definition: dangling }))).toThrow(/not in the pinned definition/);
  });
});

// ---------------------------------------------------------------------------------------------
// R — revision, request ids, acceptance order
// ---------------------------------------------------------------------------------------------

describe('acceptance order', () => {
  const release = workflow({
    states: { prep: state('prep'), tagging: state('tagging') },
    transitions: [transition('prep', 'tagging', 'gate-passed')],
  });
  const requestDigest = (input: CoreInput) =>
    payloadDigest(canonicalRequestPayload(input.envelope));

  test('R1 a stale revision behind or ahead is refused, naming both', () => {
    const base = scene({ definition: release });
    for (const expectedRevision of [1, 2]) {
      const decision = decide({
        ...base,
        envelope: { ...base.envelope, expectedRevision },
      });
      expect(decision.kind).toBe('refused');
      if (decision.kind === 'refused') {
        expect(decision.code).toBe(DECISION_CODES.revisionStale);
        expect(decision.why).toContain(`expected revision ${expectedRevision}`);
        expect(decision.why).toContain('the run is at 0');
        expect(decision.revision).toBe(0);
      }
      expect('plan' in decision).toBe(false);
    }
  });

  test('R2 a used request id with an identical payload returns the recorded result', () => {
    const base = scene({ definition: release });
    const stored = { payloadDigest: requestDigest(base), step: 0 };
    const decision = decide({
      ...base,
      run: {
        ...base.run,
        requests: new Map([['req-1', stored]]),
      },
    });
    expect(decision).toEqual({
      kind: 'duplicate',
      at,
      signal: 'gate-passed',
      requestId: 'req-1',
      recorded: stored,
    });
  });

  test('R3 a used request id with a different payload is refused', () => {
    const base = scene({ definition: release });
    const decision = decide({
      ...base,
      run: {
        ...base.run,
        requests: new Map([['req-1', { payloadDigest: 'sha256:deadbeef', step: 0 }]]),
      },
    });
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.requestConflict);
    }
  });

  test('R4 a fresh request id at the current revision is a step', () => {
    expect(decide(scene({ definition: release })).kind).toBe('step');
  });

  test('R6 an envelope naming another run or definition is refused ahead of acceptance', () => {
    const base = scene({ definition: release });
    const runMismatch = decide({
      ...base,
      envelope: { ...base.envelope, run: 'run-2' },
    });
    expect(runMismatch.kind).toBe('refused');
    if (runMismatch.kind === 'refused') {
      expect(runMismatch.code).toBe(DECISION_CODES.runMismatch);
      expect(runMismatch.why).toContain('run-2');
    }
    const other: DefinitionId = { ...definitionId, digest: 'sha256:1111' };
    for (const mismatched of [
      { ...base, envelope: { ...base.envelope, definition: other } },
      { ...base, definitionId: other },
    ]) {
      const decision = decide(mismatched);
      expect(decision.kind).toBe('refused');
      if (decision.kind === 'refused') {
        expect(decision.code).toBe(DECISION_CODES.definitionMismatch);
      }
    }
  });

  test('R6b identity is answered before a used request id can duplicate', () => {
    const base = scene({ definition: release });
    const decision = decide({
      ...base,
      run: {
        ...base.run,
        requests: new Map([
          ['req-1', { payloadDigest: requestDigest(base), step: 0 }],
        ]),
      },
      envelope: { ...base.envelope, run: 'run-2' },
    });
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.runMismatch);
    }
  });

  test('R6c a parsed definition whose name differs from its pin is refused', () => {
    const base = scene({ definition: release });
    const renamed: Workflow = { ...release, name: 'other' };
    const decision = decide({ ...base, definition: renamed });
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.definitionMismatch);
    }
  });

  test('R7 the request-id answer wins over a stale revision', () => {
    const base = scene({ definition: release });
    const decision = decide({
      ...base,
      envelope: { ...base.envelope, expectedRevision: 9 },
      run: {
        ...base.run,
        requests: new Map([
          ['req-1', { payloadDigest: requestDigest(base), step: 0 }],
        ]),
      },
    });
    expect(decision.kind).toBe('duplicate');
  });
});

// ---------------------------------------------------------------------------------------------
// E — evidence and guards
// ---------------------------------------------------------------------------------------------

describe('evidence and guards', () => {
  const guarded = workflow({
    states: { prep: state('prep'), tagging: state('tagging') },
    transitions: [transition('prep', 'tagging', 'gate-passed', 'ci-green-on-head')],
  });

  test('E1 a true guard records its answer and the one evidence ref', () => {
    const ci = outcomeEvidence('run-0/1/ci', 'ci-suite', 'done');
    const decision = maybeStep(
      decide(
        scene({
          definition: guarded,
          evidence: { ...gateEvidence(), 'ev-ci': ci },
        }),
      ),
    );
    expect(decision.guard).toEqual({
      name: 'ci-green-on-head',
      answer: true,
      evidence: ['ev-ci'],
    });
  });

  test('E2 a false guard is refused with its answer and ref, revision unchanged', () => {
    const ci = outcomeEvidence('run-0/1/ci', 'ci-suite', 'refused');
    const decision = decide(
      scene({ definition: guarded, evidence: { ...gateEvidence(), 'ev-ci': ci } }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.guardRefused);
      expect(decision.guard).toEqual({
        name: 'ci-green-on-head',
        answer: false,
        evidence: ['ev-ci'],
      });
      expect(decision.revision).toBe(0);
    }
  });

  test('E3 a guard with no input is held, and its answer is not evaluated', () => {
    const decision = decide(scene({ definition: guarded }));
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.why).toContain('ci-green-on-head');
      expect(decision.guard).toBeUndefined();
    }
  });

  test('E4 two in-scope records for one guard are ambiguous', () => {
    const ci = outcomeEvidence('run-0/1/ci', 'ci-suite', 'done');
    const decision = decide(
      scene({
        definition: guarded,
        evidence: { ...gateEvidence(), 'ev-ci': ci, 'ev-ci-2': { ...ci } },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.evidenceAmbiguous);
    }
  });

  test('E5 an unknown guard name is refused', () => {
    const unknown = workflow({
      states: { prep: state('prep'), tagging: state('tagging') },
      transitions: [transition('prep', 'tagging', 'gate-passed', 'not-a-guard')],
    });
    const decision = decide(scene({ definition: unknown }));
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.guardUnknown);
    }
  });

  test('E6 a signal with no record is held; two records are ambiguous', () => {
    const noRecord = decide(scene({ definition: guarded, evidence: {} }));
    expect(noRecord.kind).toBe('held');
    if (noRecord.kind === 'held') {
      expect(noRecord.code).toBe(DECISION_CODES.evidenceMissing);
    }
    const two = decide(
      scene({
        definition: guarded,
        evidence: {
          ...gateEvidence(),
          'ev-gate-2': { type: 'gate', target },
          'ev-ci': outcomeEvidence('run-0/1/ci', 'ci-suite', 'done'),
        },
      }),
    );
    expect(two.kind).toBe('refused');
    if (two.kind === 'refused') {
      expect(two.code).toBe(DECISION_CODES.evidenceAmbiguous);
    }
  });

  test('E7 an evidence ref naming a dry journal is refused', () => {
    const decision = decide(
      scene({
        definition: guarded,
        evidence: {
          ...gateEvidence(),
          'ev-ci': outcomeEvidence('run-0/1/ci', 'ci-suite', 'done'),
          'ev-journal': {
            kind: 'workflow-run-dry',
            authoritative: false,
          } as unknown as EvidenceRecord,
        },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.evidenceNonAuthoritative);
    }
  });

  test('E8 a refused outcome signal is valid evidence but not a match: held evidence.missing', () => {
    const tagging = workflow({
      states: { tagging: state('tagging'), publishing: state('publishing') },
      transitions: [transition('tagging', 'publishing', 'tag-outcome')],
    });
    const refusedOutcome = outcomeEvidence('run-1/1/tag', 'release-tag', 'refused');
    const decision = decide(
      scene({
        definition: tagging,
        run: { state: 'tagging' },
        signal: { name: 'tag-outcome', at },
        evidence: { 'ev-outcome': refusedOutcome },
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.revision).toBe(0);
    }
  });

  test('E9 a record for another artifact is not a candidate', () => {
    const registry = workflow({
      states: { prep: state('prep'), ready: state('ready') },
      transitions: [transition('prep', 'ready', 'gate-passed', 'registry-shows-version')],
    });
    const other = outcomeEvidence('run-0/1/reg', 'registry-check', 'done', {
      artifact: { kind: 'ref', value: 'v0.4.9' },
    });
    const decision = decide(
      scene({ definition: registry, evidence: { ...gateEvidence(), 'ev-reg': other } }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.guard).toBeUndefined();
    }
  });

  test('E11 a cited record outside the shared shape is refused corrupt', () => {
    const decision = decide(
      scene({ definition: guarded, evidence: { 'ev-gate': { type: 'gate' } } }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.evidenceCorrupt);
    }
  });

  test('E12 a cited ref the document does not supply is held on that ref', () => {
    const decision = decide(
      scene({
        definition: guarded,
        envelope: { evidence: ['ev-gate', 'ev-absent'] },
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.waitingOn).toEqual({ kind: 'evidence', ref: 'ev-absent' });
      expect(decision.revision).toBe(0);
    }
  });

  test('E10 two outcomes in one envelope: each selector picks its own', () => {
    const ci = outcomeEvidence('run-0/1/ci', 'ci-suite', 'done');
    const publish = outcomeEvidence('run-0/1/pub', 'release-publish', 'done');
    const decision = maybeStep(
      decide(
        scene({
          definition: guarded,
          evidence: { ...gateEvidence(), 'ev-ci': ci, 'ev-pub': publish },
        }),
      ),
    );
    expect(decision.guard?.evidence).toEqual(['ev-ci']);
  });
});

// ---------------------------------------------------------------------------------------------
// O — ordering and plans
// ---------------------------------------------------------------------------------------------

describe('plans', () => {
  const hooks = workflow({
    states: {
      alpha: state('alpha', [], ['x', 'y']),
      beta: state('beta', ['p', 'q']),
    },
    transitions: [transition('alpha', 'beta', 'gate-passed')],
    effects: {
      x: effect('x', 'x-run'),
      y: effect('y', 'y-run'),
      p: effect('p', 'p-run'),
      q: effect('q', 'q-run'),
    },
  });

  test('O1 the plan order is exit hooks, state entry, enter hooks', () => {
    const decision = maybeStep(
      decide(scene({ definition: hooks, run: { state: 'alpha', activation: 3 } })),
    );
    expect(decision.plan.map((item) => item.kind === 'effect' ? `${item.phase}:${item.effect}` : item.kind))
      .toEqual(['exit:x', 'exit:y', 'state-entry', 'enter:p', 'enter:q']);
  });

  test('O2 and O3 exit occurrences use the current activation, entries the next', () => {
    const loop = workflow({
      states: { alpha: state('alpha', ['p'], ['x']) },
      transitions: [transition('alpha', 'alpha', 'gate-passed')],
      effects: { x: effect('x', 'x-run'), p: effect('p', 'p-run') },
    });
    const decision = maybeStep(
      decide(
        scene({
          definition: loop,
          run: {
            state: 'alpha',
            activation: 3,
            occurrences: occurrences([
              { effect: 'p', state: 'alpha', activation: 3, operation: 'p-run' },
            ]),
          },
          evidence: {
            ...gateEvidence(),
            'ev-p': outcomeEvidence('run-1/3/p', 'p-run', 'done'),
          },
        }),
      ),
    );
    const items = decision.plan;
    expect(items).toHaveLength(3);
    const exit = items[0]!;
    const entry = items[2]!;
    expect(exit.kind).toBe('effect');
    expect(entry.kind).toBe('effect');
    if (exit.kind === 'effect' && entry.kind === 'effect') {
      expect(exit.occurrence).toBe('run-1/3/x');
      expect(entry.occurrence).toBe('run-1/4/p');
      expect(exit.occurrence).not.toBe(entry.occurrence);
    }
    expect(decision.next).toEqual({ state: 'alpha', activation: 4 });
  });

  test('O4 an effect item carries the whole proposal, payload and digest included', () => {
    const decision = maybeStep(
      decide(scene({ definition: hooks, run: { state: 'alpha', activation: 3 } })),
    );
    const item = decision.plan[0]!;
    expect(item.kind).toBe('effect');
    if (item.kind === 'effect') {
      expect(item.operation).toBe('x-run');
      expect(item.role).toBe('builder');
      expect(item.capability).toBe('write');
      expect(item.reach).toBe('local');
      expect(item.target).toBe(target);
      expect(item.artifact).toEqual(artifact);
      expect(item.payload).toBe(canonicalEffectPayload('x', 'x-run', target, artifact));
      expect(item.digest).toBe(payloadDigest(item.payload));
    }
  });

  test('O6 a state with no hooks yields the state-entry item alone', () => {
    const bare = workflow({
      states: { alpha: state('alpha'), beta: state('beta') },
      transitions: [transition('alpha', 'beta', 'gate-passed')],
    });
    const decision = maybeStep(decide(scene({ definition: bare, run: { state: 'alpha' } })));
    expect(decision.plan).toEqual([
      { kind: 'state-entry', from: 'alpha', to: 'beta', on: 'gate-passed', revision: 1 },
    ]);
  });

  test('O7 re-entry never resets the activation counter', () => {
    const decision = maybeStep(
      decide(scene({ definition: hooks, run: { state: 'alpha', activation: 7 } })),
    );
    expect(decision.next.activation).toBe(8);
    const entry = decision.plan.find((item) => item.kind === 'effect' && item.phase === 'enter');
    expect(entry).toBeDefined();
    if (entry?.kind === 'effect') expect(entry.occurrence).toBe('run-1/8/p');
  });
});

// ---------------------------------------------------------------------------------------------
// S — success progression with supplied outcomes
// ---------------------------------------------------------------------------------------------

describe('success progression', () => {
  const tagging = workflow({
    states: {
      tagging: state('tagging', ['notify']),
      publishing: state('publishing'),
    },
    transitions: [transition('tagging', 'publishing', 'gate-passed')],
    effects: { notify: effect('notify', 'notify-room') },
  });
  const entryOccurrence = occurrenceId('run-1', 2, 'notify');

  test('S1 an absent entry outcome holds with the occurrence it waits for', () => {
    const decision = decide(
      scene({
        definition: tagging,
        run: {
          state: 'tagging',
          activation: 2,
          occurrences: occurrences([
            { effect: 'notify', state: 'tagging', activation: 2, operation: 'notify-room' },
          ]),
        },
        evidence: gateEvidence(),
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.waitingOn).toEqual({ kind: 'entry-effect', occurrence: entryOccurrence });
      expect(decision.state).toBe('tagging');
      expect(decision.revision).toBe(0);
    }
  });

  test('S2 a supplied done outcome releases the state', () => {
    const decision = maybeStep(
      decide(
        scene({
          definition: tagging,
          run: {
            state: 'tagging',
            activation: 2,
            occurrences: occurrences([
              { effect: 'notify', state: 'tagging', activation: 2, operation: 'notify-room' },
            ]),
          },
          evidence: {
            ...gateEvidence(),
            'ev-notify': outcomeEvidence(entryOccurrence, 'notify-room', 'done'),
          },
        }),
      ),
    );
    expect(decision.transition).toEqual({ from: 'tagging', to: 'publishing', on: 'gate-passed' });
  });

  test('S3 a supplied refused outcome holds core.entry-effect-failed', () => {
    const decision = decide(
      scene({
        definition: tagging,
        run: {
          state: 'tagging',
          activation: 2,
          occurrences: occurrences([
            { effect: 'notify', state: 'tagging', activation: 2, operation: 'notify-room' },
          ]),
        },
        evidence: {
          ...gateEvidence(),
          'ev-notify': outcomeEvidence(entryOccurrence, 'notify-room', 'refused'),
        },
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.entryEffectFailed);
    }
  });

  test('S5 an unknown outcome is refused, never held', () => {
    const decision = decide(
      scene({
        definition: tagging,
        run: {
          state: 'tagging',
          activation: 2,
          occurrences: occurrences([
            { effect: 'notify', state: 'tagging', activation: 2, operation: 'notify-room' },
          ]),
        },
        evidence: {
          ...gateEvidence(),
          'ev-notify': {
            type: 'outcome',
            operation: 'notify-room',
            effect: entryOccurrence,
            result: 'unknown',
          } as unknown as EvidenceRecord,
        },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.evidenceUnknown);
    }
  });

  test('S6 a state with no entry effects has no precondition', () => {
    const bare = workflow({
      states: { tagging: state('tagging'), publishing: state('publishing') },
      transitions: [transition('tagging', 'publishing', 'gate-passed')],
    });
    expect(
      decide(scene({ definition: bare, run: { state: 'tagging', activation: 2 } })).kind,
    ).toBe('step');
  });

  test('S7 absent entry evidence holds before a guard is evaluated', () => {
    const guarded = workflow({
      states: {
        tagging: state('tagging', ['notify']),
        publishing: state('publishing'),
      },
      transitions: [transition('tagging', 'publishing', 'gate-passed', 'ci-green-on-head')],
      effects: { notify: effect('notify', 'notify-room') },
    });
    const decision = decide(
      scene({
        definition: guarded,
        run: {
          state: 'tagging',
          activation: 2,
          occurrences: occurrences([
            { effect: 'notify', state: 'tagging', activation: 2, operation: 'notify-room' },
          ]),
        },
        evidence: {
          ...gateEvidence(),
          'ev-ci': outcomeEvidence('run-0/1/ci', 'ci-suite', 'refused'),
        },
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
      expect(decision.guard).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// W — waits
// ---------------------------------------------------------------------------------------------

describe('waits', () => {
  const approvalWait = workflow({
    states: {
      waiting: state('waiting', [], [], {
        line: 1,
        for: 'approval',
        role: { name: 'owner', line: 1 },
      }),
      done: state('done'),
    },
    transitions: [transition('waiting', 'done', 'approved')],
  });
  const timeWait = workflow({
    states: {
      waiting: state('waiting', [], [], {
        line: 1,
        for: 'time',
        at: { name: 'release-slot', line: 1 },
      }),
      done: state('done'),
    },
    transitions: [transition('waiting', 'done', 'time-reached')],
  });
  const waitRecord = [{ state: 'waiting', activation: 1, status: 'pending' as const }];

  test('W1 an approval wait fires on approved with the record present', () => {
    expect(
      decide(
        scene({
          definition: approvalWait,
          run: { state: 'waiting', waits: waitRecord },
          signal: { name: 'approved', at },
          evidence: { 'ev-approval': { type: 'approval', target } },
        }),
      ).kind,
    ).toBe('step');
  });

  test('W2 an approval wait with no record is held', () => {
    const decision = decide(
      scene({
        definition: approvalWait,
        run: { state: 'waiting', waits: waitRecord },
        signal: { name: 'approved', at },
        evidence: {},
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') expect(decision.code).toBe(DECISION_CODES.evidenceMissing);
  });

  test('W3 a time-reached before the setting is refused wait-not-reached', () => {
    const decision = decide(
      scene({
        definition: timeWait,
        run: { state: 'waiting', waits: waitRecord },
        signal: { name: 'time-reached', at: '2026-10-21T11:00:00Z' },
        settingValues: { 'release-slot': '2026-10-21T12:00:00Z' },
        evidence: { 'ev-timer': { type: 'timer' } },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.waitNotReached);
    }
  });

  test('W4 a fired time wait at/after the setting is a step', () => {
    expect(
      decide(
        scene({
          definition: timeWait,
          run: {
            state: 'waiting',
            waits: [{ state: 'waiting', activation: 1, status: 'fired' }],
          },
          signal: { name: 'time-reached', at },
          settingValues: { 'release-slot': '2026-10-21T12:00:00Z' },
          evidence: { 'ev-timer': { type: 'timer' } },
        }),
      ).kind,
    ).toBe('step');
  });

  test('W5 a pending time wait at/after the setting is refused wait-pending', () => {
    const decision = decide(
      scene({
        definition: timeWait,
        run: { state: 'waiting', waits: waitRecord },
        signal: { name: 'time-reached', at },
        settingValues: { 'release-slot': '2026-10-21T12:00:00Z' },
        evidence: { 'ev-timer': { type: 'timer' } },
      }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.waitPending);
    }
  });

  test('W6 a missing wait setting is held settings.missing', () => {
    const decision = decide(
      scene({
        definition: timeWait,
        run: { state: 'waiting', waits: waitRecord },
        signal: { name: 'time-reached', at },
        evidence: { 'ev-timer': { type: 'timer' } },
      }),
    );
    expect(decision.kind).toBe('held');
    if (decision.kind === 'held') {
      expect(decision.code).toBe(DECISION_CODES.settingsMissing);
      expect(decision.waitingOn).toEqual({ kind: 'setting', name: 'release-slot' });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// X — occurrences
// ---------------------------------------------------------------------------------------------

describe('occurrences', () => {
  const release = workflow({
    states: { prep: state('prep'), tagging: state('tagging', ['tag']) },
    transitions: [transition('prep', 'tagging', 'gate-passed')],
    effects: { tag: effect('tag', 'release-tag') },
  });

  test('X3 an existing occurrence with another digest is refused', () => {
    const existing = occurrences([
      { effect: 'tag', state: 'tagging', activation: 2, operation: 'another-operation' },
    ]);
    const decision = decide(
      scene({ definition: release, run: { occurrences: existing } }),
    );
    expect(decision.kind).toBe('refused');
    if (decision.kind === 'refused') {
      expect(decision.code).toBe(DECISION_CODES.occurrencePayloadConflict);
      expect(decision.why).toContain('run-1/2/tag');
    }
  });

  test('X3b an existing occurrence with the same digest is planned unchanged', () => {
    const existing = occurrences([
      { effect: 'tag', state: 'tagging', activation: 2, operation: 'release-tag' },
    ]);
    const decision = maybeStep(decide(scene({ definition: release, run: { occurrences: existing } })));
    const entry = decision.plan.find((item) => item.kind === 'effect');
    expect(entry?.kind).toBe('effect');
    if (entry?.kind === 'effect') {
      expect(entry.occurrence).toBe('run-1/2/tag');
      expect(entry.payload).toBe(canonicalEffectPayload('tag', 'release-tag', target, artifact));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// D — determinism and the no-invocation boundary
// ---------------------------------------------------------------------------------------------

describe('determinism and boundary', () => {
  const release = workflow({
    states: { prep: state('prep'), tagging: state('tagging', ['tag']) },
    transitions: [transition('prep', 'tagging', 'gate-passed')],
    effects: { tag: effect('tag', 'release-tag') },
  });

  test('D1 the same input twice is a deep-equal decision', () => {
    const input = scene({ definition: release });
    expect(decide(input)).toEqual(decide(input));
  });

  test('D2 a frozen input is not mutated and does not throw', () => {
    const input = scene({ definition: release });
    Object.freeze(input);
    Object.freeze(input.definition);
    Object.freeze(input.run);
    Object.freeze(input.envelope);
    Object.freeze(input.signal);
    expect(() => decide(input)).not.toThrow();
  });

  test('D3 the core imports only the shared workflow module', async () => {
    const text = await Bun.file(
      new URL('../../src/workflow/core.ts', import.meta.url),
    ).text();
    const imports = [...text.matchAll(/^\s*import[\s\S]*?from\s+'([^']+)';/gm)].map(
      (match) => match[1]!,
    );
    const allowed = new Set([
      './canonical.ts',
      './codes.ts',
      './core-state.ts',
      './registry.ts',
      './signals.ts',
      './types.ts',
    ]);
    for (const specifier of imports) {
      expect(allowed.has(specifier)).toBe(true);
    }
    expect(text).not.toMatch(/\bDate\b/);
    expect(text).not.toMatch(/Math\.random/);
    expect(text).not.toMatch(/\bprocess\b/);
  });

  test('D4 a decision writes nothing: it returns plain data with no function members', () => {
    const decision = decide(scene({ definition: release }));
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (typeof value === 'function') throw new Error('a decision carried a function');
      if (value === null || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    };
    walk(decision);
  });
});
