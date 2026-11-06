// Positive lifecycle pairs are synthetic, repository measured-history shapes, or documentation examples.
// Sanitized thread/started and turn-error frames are real captures and are not lifecycle proof.
// See fixtures/status-codex-events/provenance.json.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { adaptCodexFrame as adapt, type CodexFrameResult } from '../src/status/codex-event-adapter.ts';
import {
  establishContext,
  initialNativeCandidate,
  reduceNativeObservation,
  type NativeCandidateState,
} from '../src/status/native-observation.ts';

const envelope = {
  seatId: 'example-seat',
  incarnation: 'example-inc',
  mainTurn: 'example-turn',
  lane: 'main' as const,
  seq: 1,
  threadId: 'thr_example',
};
const context = { seatId: envelope.seatId, incarnation: envelope.incarnation, mainTurn: envelope.mainTurn };
const gateFields = { toolId: 'example-tool', gateId: 'example-gate', binding: 'example-binding' };

function wire(value: unknown): string {
  return JSON.stringify(value);
}
const itemFields = { itemId: 'item_example', turnId: 'turn_example', ...gateFields };

function text(name: string): string {
  return readFileSync(new URL(`./fixtures/status-codex-events/${name}`, import.meta.url), 'utf8');
}

function normalized(result: CodexFrameResult) {
  if (result.status !== 'normalized') throw new Error(`expected normalization, got ${result.status}`);
  return result.observation;
}

function withContext(): NativeCandidateState {
  return establishContext(initialNativeCandidate(), context).state;
}

function gated(): NativeCandidateState {
  return reduceNativeObservation(withContext(), {
    source: 'native',
    seq: 1,
    kind: 'permission-gate',
    ...context,
    lane: 'main',
    ...gateFields,
  }).state;
}

const idle = {
  method: 'thread/status/changed',
  params: { threadId: 'thr_example', status: { type: 'idle' } },
};
const active = {
  method: 'thread/status/changed',
  params: { threadId: 'thr_example', status: { type: 'active', activeFlags: [] as string[] } },
};

describe('pure Codex app-server frame parser', () => {
  test('provenance keeps measured history and documentation examples out of the capture set', () => {
    const provenance = JSON.parse(text('provenance.json')) as {
      acceptanceComplete: boolean;
      positiveLifecycleCoverage: boolean;
      observedTargetMethods: string[];
      missingTargetMethods: string[];
      realCapturedFixtures: string[];
      entries: { file: string; countsAsRealCapturedFixture: boolean; captureDate?: null; evidenceClass: string }[];
    };
    expect(provenance.acceptanceComplete).toBe(false);
    expect(provenance.positiveLifecycleCoverage).toBe(false);
    expect(provenance.observedTargetMethods).toEqual(['thread/started']);
    expect(provenance.missingTargetMethods).toContain('turn/started');
    expect(provenance.missingTargetMethods).toContain('thread/closed');
    expect(provenance.realCapturedFixtures).toEqual([
      'captured-thread-started-20261106T144757Z.json',
      'captured-thread-started-20261106T145950Z.json',
      'captured-turn-start-error.json',
    ]);
    const historical = provenance.entries.filter((entry) => !entry.countsAsRealCapturedFixture);
    expect(historical.length).toBe(8);
    for (const entry of historical) {
      expect(entry.captureDate).toBeNull();
      expect(['repository-measured-history', 'documentation-example']).toContain(entry.evidenceClass);
    }
    expect(provenance.entries.filter((entry) => entry.countsAsRealCapturedFixture).map((entry) => entry.file))
      .toEqual(provenance.realCapturedFixtures);
  });

  test('measured idle and active shapes update advisory and preserve an open gate', () => {
    const quiet = normalized(adapt(text('measured-status-idle.json'), { ...envelope, seq: 2 }));
    expect(quiet.kind).toBe('quiet');
    expect(quiet.gateId).toBeUndefined();
    const preserved = reduceNativeObservation(gated(), quiet);
    expect(preserved.outcome.reason).toBe('quiet_preserved');
    expect(preserved.state.gate?.ownerRequired).toBe(true);

    const working = normalized(adapt(text('measured-status-active.json'), envelope));
    expect(working).toMatchObject({ kind: 'candidate-state', advisory: 'working', lane: 'main' });
    const started = reduceNativeObservation(withContext(), working);
    expect(started.outcome.reason).toBe('advisory_updated');
    expect(started.state.advisory).toBe('working');
    const held = reduceNativeObservation(gated(), { ...working, seq: 2 });
    expect(held.outcome.reason).toBe('advisory_ignored');
    expect(held.state.gate).not.toBeNull();
  });

  test('measured thread start is ignored and a foreign thread is not a lifecycle success', () => {
    expect(adapt(text('measured-thread-started.json'), envelope)).toEqual({
      status: 'ignored',
      reason: 'notification',
    });
    expect(adapt(wire(idle), { ...envelope, threadId: 'thr_other' }).status).toBe('correlation-unproven');
    expect(adapt(wire(idle), { ...envelope, threadId: 'thr_other' })).toEqual({
      status: 'correlation-unproven',
      reason: 'correlation_mismatch',
    });
  });

  test('documentation waiting, notLoaded, and resolved frames do not open or clear a gate', () => {
    const waiting = adapt(text('doc-status-waiting.json'), { ...envelope, threadId: 'thr_123', seq: 2 });
    expect(waiting).toEqual({ status: 'correlation-unproven', reason: 'unbound_permission' });
    expect(adapt(text('doc-status-not-loaded.json'), { ...envelope, threadId: 'thr_123' })).toEqual({
      status: 'ignored',
      reason: 'notification',
    });
    const resolved = adapt(text('doc-server-request-resolved.json'), {
      ...envelope,
      threadId: 'thr_123',
      requestId: 'req_doc_example',
      seq: 2,
      ...gateFields,
    });
    expect(resolved).toEqual({ status: 'correlation-unproven', reason: 'ambiguous_cleanup' });
    expect(reduceNativeObservation(gated(), {
      source: 'native', seq: 2, kind: 'quiet', ...context, lane: 'main',
    }).state.processConfirmation).toBe('not_requested');
  });

  test('documentation turn start and thread close stay short of process proof', () => {
    const started = normalized(adapt(text('doc-turn-started.json'), {
      ...envelope, turnId: 'turn_456', seq: 2, ...gateFields,
    }));
    expect(started.kind).toBe('turn-start');
    expect(started.gateId).toBeUndefined();
    expect(started.toolId).toBeUndefined();
    expect(reduceNativeObservation(gated(), started).outcome.reason).toBe('gate_preserved');

    const closed = normalized(adapt(text('doc-thread-closed.json'), { ...envelope, threadId: 'thr_123', seq: 2 }));
    expect(closed.kind).toBe('session-end');
    const result = reduceNativeObservation(gated(), closed);
    expect(result.outcome.reason).toBe('session_end_unconfirmed');
    expect(result.state.processConfirmation).toBe('needed');
    expect(result.state.gate?.ownerRequired).toBe(true);
    expect(JSON.stringify(result.state)).not.toContain('done');
    expect(result.state.advisory).not.toBe('quiet');
  });

  test('synthetic turn completion preserves a gate and does not copy gate fields', () => {
    const frame = {
      method: 'turn/completed',
      params: {
        threadId: 'thr_example',
        turn: { id: 'turn_example', status: 'completed', error: { message: 'example-private-error' } },
      },
    };
    const observation = normalized(adapt(wire(frame), { ...envelope, seq: 2, turnId: 'turn_example', ...gateFields }));
    expect(observation.kind).toBe('turn-end');
    expect(observation.gateId).toBeUndefined();
    expect(observation.binding).toBeUndefined();
    expect(observation.toolId).toBeUndefined();
    expect(JSON.stringify(observation)).not.toContain('example-private-error');
    const result = reduceNativeObservation(gated(), observation);
    expect(result.state.gate).not.toBeNull();
    expect(result.outcome.reason).toBe('correlation_mismatch');
    for (const status of ['interrupted', 'failed']) {
      const next = adapt(
        wire({ ...frame, params: { ...frame.params, turn: { id: 'turn_example', status } } }),
        { ...envelope, seq: 2, turnId: 'turn_example' },
      );
      expect(normalized(next).kind).toBe('turn-end');
    }
  });

  test('synthetic tool start preserves a gate and exact completion clears only that gate', () => {
    const started = {
      method: 'item/started',
      params: {
        threadId: 'thr_example',
        item: {
          type: 'commandExecution',
          id: 'item_example',
          command: 'example-command-not-echoed',
          cwd: 'example-path-not-followed',
        },
      },
    };
    const start = normalized(adapt(wire(started), { ...envelope, seq: 2, ...itemFields }));
    expect(start.kind).toBe('tool-start');
    expect(start.toolId).toBe('example-tool');
    expect(start.gateId).toBeUndefined();
    expect(JSON.stringify(start)).not.toContain('example-command-not-echoed');
    expect(JSON.stringify(start)).not.toContain('example-path-not-followed');
    expect(reduceNativeObservation(gated(), start).outcome.reason).toBe('gate_preserved');

    const completed = {
      method: 'item/completed',
      params: {
        item: { type: 'fileChange', id: 'item_example', status: 'declined', changes: [{ path: 'example-path-not-followed' }] },
      },
    };
    const clear = normalized(adapt(wire(completed), { ...envelope, seq: 2, ...itemFields }));
    expect(clear).toMatchObject({ kind: 'tool-end', ...gateFields });
    const cleared = reduceNativeObservation(gated(), clear);
    expect(cleared.outcome.reason).toBe('gate_cleared');
    expect(cleared.state.gate).toBeNull();
    expect(JSON.stringify(clear)).not.toContain('example-path-not-followed');

    const wrong = normalized(adapt(wire(completed), {
      ...envelope, seq: 2, ...itemFields, binding: 'example-other-binding',
    }));
    expect(reduceNativeObservation(gated(), wrong).state.gate).not.toBeNull();
    expect(adapt(wire(completed), { ...envelope, seq: 2, itemId: 'item_example', toolId: 'example-tool' })).toEqual({
      status: 'correlation-unproven',
      reason: 'unbound_permission',
    });
    expect(adapt(wire(completed), { ...envelope, seq: 2, ...itemFields, itemId: 'item_other' })).toEqual({
      status: 'correlation-unproven',
      reason: 'correlation_mismatch',
    });
  });

  test('synthetic approval opens one owner-required gate and a missing binding does not', () => {
    const request = {
      method: 'item/commandExecution/requestApproval',
      id: 7,
      params: {
        threadId: 'thr_example',
        turnId: 'turn_example',
        itemId: 'item_example',
        command: 'example-command-not-echoed',
        cwd: 'example-path-not-followed',
      },
    };
    const opened = normalized(adapt(wire(request), { ...envelope, requestId: 7, ...itemFields }));
    expect(opened.kind).toBe('permission-gate');
    expect(opened).toMatchObject(gateFields);
    expect(Object.keys(opened)).not.toContain('ownerRequired');
    const result = reduceNativeObservation(withContext(), opened);
    expect(result.outcome.reason).toBe('gate_opened');
    expect(result.state.gate?.ownerRequired).toBe(true);
    expect(JSON.stringify(opened)).not.toContain('example-command-not-echoed');
    expect(adapt(wire(request), { ...envelope, ...itemFields, requestId: 8 })).toEqual({
      status: 'correlation-unproven',
      reason: 'correlation_mismatch',
    });
    expect(adapt(wire(request), { ...envelope, requestId: 7, itemId: 'item_example', turnId: 'turn_example' })).toEqual({
      status: 'correlation-unproven',
      reason: 'unbound_permission',
    });
    expect(adapt(wire({ ...request, id: undefined }), { ...envelope, requestId: 7, ...itemFields }).status).not.toBe('normalized');
  });

  test('synthetic subagent frames cannot clear a main gate or confirm the process', () => {
    const metadata = { ...envelope, lane: 'subagent' as const, seq: 2, ...itemFields };
    const frames = [
      idle,
      active,
      { method: 'turn/completed', params: { turn: { id: 'turn_example', status: 'completed' } } },
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'item_example', status: 'completed' } } },
      { method: 'thread/closed', params: { threadId: 'thr_example' } },
    ];
    for (const frame of frames) {
      const observation = normalized(adapt(wire(frame), metadata));
      expect(observation.kind).toBe('subagent');
      expect(observation.lane).toBe('subagent');
      expect(observation.gateId).toBeUndefined();
      const result = reduceNativeObservation(gated(), observation);
      expect(result.outcome.reason).toBe('subagent_ignored');
      expect(result.state.gate?.ownerRequired).toBe(true);
      expect(result.state.processConfirmation).toBe('not_requested');
    }
  });

  test('duplicate and out-of-order sequences stay with the native reducer', () => {
    const first = normalized(adapt(wire(active), envelope));
    const late = normalized(adapt(wire(idle), { ...envelope, seq: 1 }));
    const gap = normalized(adapt(wire(idle), { ...envelope, seq: 3 }));
    let state = reduceNativeObservation(withContext(), first);
    expect(state.outcome.reason).toBe('advisory_updated');
    expect(reduceNativeObservation(state.state, late).outcome.reason).toBe('duplicate_sequence');
    const gapped = reduceNativeObservation(state.state, gap);
    expect(gapped.outcome.reason).toBe('sequence_gap');
    expect(gapped.state.continuity).toBe('unproven');
    expect(gapped.state.advisory).toBe('working');
    expect(gapped.state.lastSeq).toBe(1);
    const second = normalized(adapt(wire(idle), { ...envelope, seq: 2 }));
    state = reduceNativeObservation(state.state, second);
    const older = normalized(adapt(wire(active), { ...envelope, seq: 1 }));
    expect(reduceNativeObservation(state.state, older).outcome.reason).toBe('late_sequence');
  });

  test('requests, responses, errors, and unknown methods are not lifecycle successes', () => {
    expect(adapt(wire({ method: 'thread/start', id: 1, params: { model: 'example' } }), envelope)).toEqual({
      status: 'ignored',
      reason: 'request',
    });
    expect(adapt(wire({ method: 'thread/status/changed', id: 1, params: idle.params }), envelope)).toEqual({
      status: 'ignored',
      reason: 'request',
    });
    const response = { id: 1, result: { thread: { id: 'thr_example', note: 'example-private-result' } } };
    expect(adapt(wire(response), envelope)).toEqual({ status: 'ignored', reason: 'response' });
    expect(JSON.stringify(adapt(wire(response), envelope))).not.toContain('example-private-result');
    const error = { id: 1, error: { code: 1, message: 'example-private-error' } };
    expect(adapt(JSON.stringify(error), envelope)).toEqual({ status: 'ignored', reason: 'error' });
    expect(JSON.stringify(adapt(JSON.stringify(error), envelope))).not.toContain('example-private-error');
    expect(adapt(wire({ method: 'example/unknown', params: {} }), envelope)).toEqual({
      status: 'unsupported',
      reason: 'method',
    });
    expect(adapt(wire({ method: 'item/agentMessage/delta', params: { text: 'example-private-text' } }), envelope)).toEqual({
      status: 'ignored',
      reason: 'notification',
    });
  });

  test('malformed frames, accessors, limits, and token constraints stay fixed refusals', () => {
    const before = structuredClone(idle);
    const meta = { ...envelope };
    expect(adapt(wire(idle), meta).status).toBe('normalized');
    expect(idle).toEqual(before);
    expect(meta).toEqual(envelope);
    expect(adapt('{', envelope)).toEqual({ status: 'malformed', reason: 'payload_shape' });
    expect(adapt('{"method":"thread/closed","method":"thread/closed","params":{"threadId":"thr_example"}}', envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt('{"id":9007199254740993,"result":{}}', envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    let rootCalls = 0;
    const getter = {};
    Object.defineProperty(getter, 'method', {
      enumerable: true,
      get() { rootCalls += 1; return 'thread/status/changed'; },
    });
    const refused = adapt(getter, envelope);
    expect(refused).toEqual({ status: 'malformed', reason: 'payload_shape' });
    expect(rootCalls).toBe(0);
    expect(JSON.stringify(refused)).not.toContain('example-private-accessor');
    expect(adapt(wire(idle), null)).toEqual({ status: 'correlation-unproven', reason: 'missing_envelope' });
    expect(adapt(wire(idle), { ...envelope, extra: true })).toEqual({ status: 'malformed', reason: 'envelope_shape' });
    expect(adapt(wire(active), { ...envelope, toolId: 'bad/tool' })).toEqual({
      status: 'unsupported',
      reason: 'identifier_contract',
    });
    const opaqueId = `item_${'x'.repeat(180)}`;
    const started = normalized(adapt(wire({
      method: 'item/started',
      params: { item: { type: 'commandExecution', id: opaqueId } },
    }), { ...envelope, itemId: opaqueId, toolId: 'example-tool' }));
    expect(started.toolId).toBe('example-tool');
    expect(JSON.stringify(started)).not.toContain(opaqueId);
    expect(adapt(`{"method":"thread/closed","params":{"threadId":"${'t'.repeat(70000)}"}}`, envelope)).toEqual({
      status: 'unsupported',
      reason: 'payload_limit',
    });
  });

  test('object frames are refused before nested getters or toJSON run', () => {
    let getterCalls = 0;
    let toJSONCalls = 0;
    const nested = { threadId: 'thr_example', status: { type: 'idle' } };
    Object.defineProperty(nested, 'extra', {
      enumerable: true,
      get() { getterCalls += 1; return 'benign'; },
    });
    const withToJSON = {
      threadId: 'thr_example',
      status: { type: 'idle' },
      toJSON() {
        toJSONCalls += 1;
        return { threadId: 'thr_example', status: { type: 'idle' } };
      },
    };
    const beforeNested = nested.threadId;
    const beforeStatus = nested.status.type;
    expect(adapt({ method: 'thread/status/changed', params: nested }, envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt({ method: 'thread/status/changed', params: withToJSON }, envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(getterCalls).toBe(0);
    expect(toJSONCalls).toBe(0);
    expect(nested.threadId).toBe(beforeNested);
    expect(nested.status.type).toBe(beforeStatus);
  });

  test('captured frames tolerate emittedAtMs and do not prove a lifecycle', () => {
    for (const name of [
      'captured-thread-started-20261106T144757Z.json',
      'captured-thread-started-20261106T145950Z.json',
    ]) {
      const frame = text(name);
      expect(frame).toContain('"emittedAtMs"');
      const result = adapt(frame, envelope);
      expect(result).toEqual({ status: 'ignored', reason: 'notification' });
      expect(JSON.stringify(result)).not.toContain('emittedAtMs');
      expect(JSON.stringify(result)).not.toContain('example-private-path');
    }
    const errorFrame = text('captured-turn-start-error.json');
    expect(adapt(errorFrame, envelope)).toEqual({ status: 'ignored', reason: 'error' });
    expect(JSON.stringify(adapt(errorFrame, envelope))).not.toContain('example-redacted-string');

    const quiet = normalized(adapt(wire({ ...idle, emittedAtMs: 0 }), { ...envelope, seq: 2 }));
    expect(quiet.kind).toBe('quiet');
    expect(JSON.stringify(quiet)).not.toContain('emittedAtMs');
    const preserved = reduceNativeObservation(gated(), quiet);
    expect(preserved.outcome.reason).toBe('quiet_preserved');
    expect(preserved.state.gate).not.toBeNull();

    const clear = normalized(adapt(wire({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'item_example', status: 'completed' } },
      emittedAtMs: 1,
    }), { ...envelope, seq: 2, ...itemFields }));
    expect(clear.kind).toBe('tool-end');
    expect(reduceNativeObservation(gated(), clear).outcome.reason).toBe('gate_cleared');

    const first = normalized(adapt(wire({ ...active, emittedAtMs: 10 }), envelope));
    const second = normalized(adapt(wire({ ...idle, emittedAtMs: 11 }), { ...envelope, seq: 2 }));
    const ordered = reduceNativeObservation(reduceNativeObservation(withContext(), first).state, second);
    expect(ordered.state.lastSeq).toBe(2);
    expect(ordered.state.advisory).toBe('quiet');

    expect(adapt(wire({ method: 'thread/started', params: {}, emittedAtMs: -1 }), envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt(wire({ method: 'thread/started', params: {}, emittedAtMs: 1.5 }), envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt(wire({ method: 'thread/started', params: {}, emittedAtMs: '1' }), envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt(wire({ method: 'thread/started', params: {}, extra: true }), envelope)).toEqual({
      status: 'malformed',
      reason: 'payload_shape',
    });
    expect(adapt(wire({ method: 'example/unknown', params: {}, emittedAtMs: 1 }), envelope)).toEqual({
      status: 'unsupported',
      reason: 'method',
    });
    expect(adapt(
      `{"method":"thread/started","params":{},"emittedAtMs":${Number.MAX_SAFE_INTEGER}}`,
      envelope,
    )).toEqual({ status: 'ignored', reason: 'notification' });
    expect(adapt(
      '{"method":"thread/started","params":{},"emittedAtMs":9007199254740992}',
      envelope,
    )).toEqual({ status: 'malformed', reason: 'payload_shape' });
  });
});
