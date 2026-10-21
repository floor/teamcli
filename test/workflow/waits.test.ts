// The shared flat-wait helpers, pinned against the real core: the same derived run state,
// activations, evidence and settings reach `decide`, and the core — not the helpers — answers
// wait-pending, wait-not-reached, settings.missing and evidence.missing.

import { describe, expect, test } from 'bun:test';
import { DECISION_CODES } from '../../src/workflow/codes.ts';
import { decide } from '../../src/workflow/core.ts';
import type { RunState, RunWait } from '../../src/workflow/core-state.ts';
import { provisionalResolvers } from '../../src/workflow/registry.ts';
import type { EvidenceSource, SettingSource } from '../../src/workflow/registry.ts';
import { parseWorkflow } from '../../src/workflow/schema.ts';
import type { DefinitionId, Workflow, WorkflowEnvelope } from '../../src/workflow/types.ts';
import { fireRecordedWait, waitsAfterStep, waitsAtEntry } from '../../src/workflow/waits.ts';

const RUN = 'run-1';
const TARGET = 'refs/heads/release-0.5.4';
const ARTIFACT = { kind: 'ref' as const, value: 'v0.5.4' };
const AT = '2026-10-21T12:00:00Z';

const TIME = `workflow: waits-time
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

const APPROVAL = `workflow: waits-approval
version: 1
initial: reviewed
states:
  reviewed:
    wait: { for: approval, role: owner }
  waiting:
    wait: { for: time, at: release-slot }
  done: {}
transitions:
  - { from: reviewed, to: waiting, on: approved, role: owner }
  - { from: waiting, to: done, on: time-reached, role: integrator }
`;

type Fixture = { workflow: Workflow; definition: DefinitionId };

function fixture(source: string): Fixture {
  const parsed = parseWorkflow(source);
  if (!('workflow' in parsed)) throw new Error(`fixture did not parse: ${JSON.stringify(parsed)}`);
  return { workflow: parsed.workflow, definition: parsed.definition };
}

function runOf(made: Fixture, state: string, waits: readonly RunWait[], activation = 1): RunState {
  return {
    runId: RUN,
    definitionId: made.definition,
    state,
    revision: 0,
    activation,
    occurrences: new Map(),
    requests: new Map(),
    waits,
  };
}

function settingsAt(at: string | undefined): SettingSource {
  return { get: (name) => (name === 'release-slot' ? at : undefined) };
}

const TIMER_EVIDENCE: EvidenceSource = {
  record: (ref) => (ref === 'timer-1' ? { type: 'timer', target: TARGET } : undefined),
};

const NO_EVIDENCE: EvidenceSource = { record: () => undefined };

function timeEnvelope(made: Fixture): WorkflowEnvelope {
  return {
    format: 1,
    run: RUN,
    definition: made.definition,
    expectedRevision: 0,
    requestId: 'req-1',
    move: { transition: { from: 'waiting', to: 'done', on: 'time-reached' } },
    target: TARGET,
    artifact: ARTIFACT,
    evidence: ['timer-1'],
  };
}

function coreAt(
  made: Fixture,
  run: RunState,
  input: { evidence: EvidenceSource; settings: SettingSource; at?: string },
) {
  return decide({
    definition: made.workflow,
    definitionId: made.definition,
    run,
    envelope: timeEnvelope(made),
    signal: { name: 'time-reached', at: input.at ?? AT },
    evidence: input.evidence,
    settings: input.settings,
    guards: provisionalResolvers().guards,
  });
}

describe('waitsAtEntry', () => {
  test('a state that declares a wait starts one pending record at the activation', () => {
    const time = fixture(TIME);
    expect(waitsAtEntry(time.workflow, 'waiting', 1)).toEqual([
      { state: 'waiting', activation: 1, status: 'pending' },
    ]);
    expect(waitsAtEntry(time.workflow, 'waiting', 7)).toEqual([
      { state: 'waiting', activation: 7, status: 'pending' },
    ]);
  });

  test('a state without a wait starts none', () => {
    const time = fixture(TIME);
    expect(waitsAtEntry(time.workflow, 'done', 1)).toEqual([]);
  });

  test('an undeclared state starts none', () => {
    const time = fixture(TIME);
    expect(waitsAtEntry(time.workflow, 'nowhere', 1)).toEqual([]);
  });
});

describe('fireRecordedWait', () => {
  test('fires at the exact recorded instant and leaves the input run untouched', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(AT),
    });
    expect(fired.waits).toEqual([{ state: 'waiting', activation: 1, status: 'fired' }]);
    expect(fired.state).toBe('waiting');
    expect(fired.activation).toBe(1);
    expect(pending.waits).toEqual([{ state: 'waiting', activation: 1, status: 'pending' }]);
    expect(fired.waits).not.toBe(pending.waits);
  });

  test('a reached instant after the setting fires', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: '2026-10-21T12:05:00Z',
      settings: settingsAt(AT),
    });
    expect(fired.waits).toEqual([{ state: 'waiting', activation: 1, status: 'fired' }]);
  });

  test('an instant before the setting leaves the run as it was', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    expect(
      fireRecordedWait(pending, time.workflow, {
        signal: 'time-reached',
        at: '2026-10-21T11:59:00Z',
        settings: settingsAt(AT),
      }),
    ).toBe(pending);
  });

  test('a missing setting leaves the run as it was', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    expect(
      fireRecordedWait(pending, time.workflow, {
        signal: 'time-reached',
        at: AT,
        settings: settingsAt(undefined),
      }),
    ).toBe(pending);
  });

  test('another signal never fires a time wait', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    expect(
      fireRecordedWait(pending, time.workflow, {
        signal: 'gate-passed',
        at: AT,
        settings: settingsAt(AT),
      }),
    ).toBe(pending);
  });

  test('an approval wait is not a recorded time wait', () => {
    const approval = fixture(APPROVAL);
    const pending = runOf(approval, 'reviewed', waitsAtEntry(approval.workflow, 'reviewed', 1));
    expect(
      fireRecordedWait(pending, approval.workflow, {
        signal: 'time-reached',
        at: AT,
        settings: settingsAt(AT),
      }),
    ).toBe(pending);
  });

  test('fires only the current activation and leaves another record untouched', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', [
      { state: 'done', activation: 1, status: 'fired' },
      { state: 'waiting', activation: 1, status: 'pending' },
    ]);
    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(AT),
    });
    expect(fired.waits).toEqual([
      { state: 'done', activation: 1, status: 'fired' },
      { state: 'waiting', activation: 1, status: 'fired' },
    ]);
  });

  test('no record for the activation leaves the run as it was', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', [{ state: 'waiting', activation: 4, status: 'pending' }]);
    expect(
      fireRecordedWait(pending, time.workflow, {
        signal: 'time-reached',
        at: AT,
        settings: settingsAt(AT),
      }),
    ).toBe(pending);
  });
});

describe('waitsAfterStep', () => {
  test('an approval step marks its wait fired and starts the entered state pending', () => {
    const approval = fixture(APPROVAL);
    const pending = runOf(approval, 'reviewed', waitsAtEntry(approval.workflow, 'reviewed', 1));
    const waits = waitsAfterStep(pending, approval.workflow, {
      signal: 'approved',
      nextState: 'waiting',
      nextActivation: 2,
    });
    expect(waits).toEqual([
      { state: 'reviewed', activation: 1, status: 'fired' },
      { state: 'waiting', activation: 2, status: 'pending' },
    ]);
    expect(pending.waits).toEqual([{ state: 'reviewed', activation: 1, status: 'pending' }]);
  });

  test('another signal leaves the approval record pending', () => {
    const approval = fixture(APPROVAL);
    const pending = runOf(approval, 'reviewed', waitsAtEntry(approval.workflow, 'reviewed', 1));
    const waits = waitsAfterStep(pending, approval.workflow, {
      signal: 'gate-passed',
      nextState: 'waiting',
      nextActivation: 2,
    });
    expect(waits).toEqual([
      { state: 'reviewed', activation: 1, status: 'pending' },
      { state: 'waiting', activation: 2, status: 'pending' },
    ]);
  });

  test('a time step marks its wait fired and appends no wait after a plain state', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(AT),
    });
    expect(
      waitsAfterStep(fired, time.workflow, {
        signal: 'time-reached',
        nextState: 'done',
        nextActivation: 2,
      }),
    ).toEqual([{ state: 'waiting', activation: 1, status: 'fired' }]);
  });

  test('another signal leaves a time record pending', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    expect(
      waitsAfterStep(pending, time.workflow, {
        signal: 'gate-passed',
        nextState: 'done',
        nextActivation: 2,
      }),
    ).toEqual([{ state: 'waiting', activation: 1, status: 'pending' }]);
  });

  test('an already fired record stays fired and another activation is untouched', () => {
    const approval = fixture(APPROVAL);
    const pending = runOf(approval, 'reviewed', [
      { state: 'done', activation: 1, status: 'fired' },
      { state: 'reviewed', activation: 1, status: 'fired' },
    ]);
    const waits = waitsAfterStep(pending, approval.workflow, {
      signal: 'approved',
      nextState: 'done',
      nextActivation: 2,
    });
    expect(waits).toEqual([
      { state: 'done', activation: 1, status: 'fired' },
      { state: 'reviewed', activation: 1, status: 'fired' },
    ]);
  });
});

describe('with the real core', () => {
  test('the core refuses the derived pending wait and accepts the same run once it is fired', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));

    const refused = coreAt(time, pending, { evidence: TIMER_EVIDENCE, settings: settingsAt(AT) });
    expect(refused).toMatchObject({
      kind: 'refused',
      code: DECISION_CODES.waitPending,
      state: 'waiting',
      revision: 0,
    });

    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(AT),
    });
    const accepted = coreAt(time, fired, { evidence: TIMER_EVIDENCE, settings: settingsAt(AT) });
    expect(accepted.kind).toBe('step');
    if (accepted.kind !== 'step') throw new Error('the fired wait did not reach a step');
    expect(accepted.nextRevision).toBe(1);
    expect(accepted.next).toEqual({ state: 'done', activation: 2 });
    expect(
      waitsAfterStep(fired, time.workflow, {
        signal: 'time-reached',
        nextState: accepted.next.state,
        nextActivation: accepted.next.activation,
      }),
    ).toEqual([{ state: 'waiting', activation: 1, status: 'fired' }]);
  });

  test('a missing setting holds with waitingOn the setting before anything moves', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const unchanged = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(undefined),
    });
    expect(unchanged).toBe(pending);
    expect(coreAt(time, unchanged, { evidence: TIMER_EVIDENCE, settings: settingsAt(undefined) })).toMatchObject({
      kind: 'held',
      code: DECISION_CODES.settingsMissing,
      state: 'waiting',
      revision: 0,
      waitingOn: { kind: 'setting', name: 'release-slot' },
    });
  });

  test('an instant before the setting leaves the wait pending and the core refuses it', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const early = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: '2026-10-21T11:59:00Z',
      settings: settingsAt(AT),
    });
    expect(early).toBe(pending);
    expect(
      coreAt(time, early, {
        evidence: TIMER_EVIDENCE,
        settings: settingsAt(AT),
        at: '2026-10-21T11:59:00Z',
      }),
    ).toMatchObject({ kind: 'refused', code: DECISION_CODES.waitNotReached, state: 'waiting', revision: 0 });
  });

  test('missing evidence leaves the fired run unmoved', () => {
    const time = fixture(TIME);
    const pending = runOf(time, 'waiting', waitsAtEntry(time.workflow, 'waiting', 1));
    const fired = fireRecordedWait(pending, time.workflow, {
      signal: 'time-reached',
      at: AT,
      settings: settingsAt(AT),
    });
    expect(coreAt(time, fired, { evidence: NO_EVIDENCE, settings: settingsAt(AT) })).toMatchObject({
      kind: 'held',
      code: DECISION_CODES.evidenceMissing,
      state: 'waiting',
      revision: 0,
      waitingOn: { kind: 'evidence', ref: 'timer-1' },
    });
    expect(fired.state).toBe('waiting');
    expect(fired.revision).toBe(0);
  });
});
