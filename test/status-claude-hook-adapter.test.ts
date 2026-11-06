// Positive provider/envelope pairs below are SYNTHETIC. They are not versioned real captures.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { adaptClaudeHook as adapt, type ClaudeHookResult } from '../src/status/claude-hook-adapter.ts';
import { establishContext, initialNativeCandidate, reduceNativeObservation } from '../src/status/native-observation.ts';

const envelope = {
  seatId: 'example-agent', incarnation: 'example-inc', mainTurn: 'example-turn', lane: 'main',
  seq: 1, sessionId: 'example-session', promptId: 'example-prompt', toolUseId: 'toolu_example',
};
const context = { seatId: envelope.seatId, incarnation: envelope.incarnation, mainTurn: envelope.mainTurn };
function body(event: string, extra: Record<string, unknown> = {}) {
  return { session_id: 'example-session', prompt_id: 'example-prompt', hook_event_name: event,
    transcript_path: '/example/never-read.jsonl', cwd: '/example/never-read', ...extra };
}
function tool(event = 'PreToolUse', extra: Record<string, unknown> = {}) {
  return body(event, { tool_name: 'Read', tool_input: { file_path: '/example/never-read' },
    tool_use_id: 'toolu_example', ...(event === 'PostToolUse' ? { tool_response: { example: true } } : {}), ...extra });
}
function normalized(result: ClaudeHookResult) {
  if (result.status !== 'normalized') throw Error('expected synthetic normalization');
  return result.observation;
}
function gated() {
  const start = establishContext(initialNativeCandidate(), context).state;
  return reduceNativeObservation(start, { source: 'native', seq: 1, kind: 'permission-gate',
    ...context, lane: 'main', toolId: 'toolu_example', gateId: 'example-gate', binding: 'example-binding' }).state;
}
const gate = { gateId: 'example-gate', binding: 'example-binding' };

describe('conditional Claude hook parser candidate', () => {
  test('repository measured history remains unproven and is never labelled a real capture', () => {
    const text = readFileSync(new URL('./fixtures/status-claude-hooks/measured-notification-history.json', import.meta.url), 'utf8');
    expect(adapt(text, envelope)).toEqual({ status: 'correlation-unproven', reason: 'unbound_permission' });
    const provenance = JSON.parse(readFileSync(new URL('./fixtures/status-claude-hooks/provenance.json', import.meta.url), 'utf8'));
    expect(provenance.acceptanceComplete).toBe(false);
    expect(provenance.realCapturedFixtures).toEqual([]);
    expect(provenance.entries[0].countsAsRealCapturedFixture).toBe(false);
    expect(provenance.entries[0].cliVersion).toBeNull();
    expect(provenance.entries[0].captureDate).toBeNull();
  });

  test('synthetic tool-start preserves an open gate and never infers successful permission', () => {
    const observation = normalized(adapt(JSON.stringify(tool()), { ...envelope, seq: 2, ...gate }));
    expect(observation.kind).toBe('tool-start');
    expect(observation.toolId).toBe('toolu_example');
    expect(observation.gateId).toBeUndefined();
    expect(observation.binding).toBeUndefined();
    const result = reduceNativeObservation(gated(), observation);
    expect(result.outcome.reason).toBe('gate_preserved');
    expect(result.state.gate?.ownerRequired).toBe(true);
  });

  test('synthetic exact tool completion clears only an exactly correlated native gate', () => {
    const text = JSON.stringify(tool('PostToolUse', { duration_ms: 12, tool_response: { permissionDecision: 'allow' } }));
    const correct = normalized(adapt(text, { ...envelope, seq: 2, ...gate }));
    const result = reduceNativeObservation(gated(), correct);
    expect(result.outcome.reason).toBe('gate_cleared');
    expect(result.state.gate).toBeNull();
    expect(Object.keys(correct)).not.toContain('ownerRequired');
    for (const changed of [{ binding: 'example-other-binding' }, { gateId: 'example-other-gate' },
      { mainTurn: 'example-other-turn' }, { seatId: 'example-other-agent' }, { incarnation: 'example-other-inc' }]) {
      const observation = normalized(adapt(text, { ...envelope, seq: 2, ...gate, ...changed }));
      expect(reduceNativeObservation(gated(), observation).state.gate).not.toBeNull();
    }
    expect(adapt(text, { ...envelope, seq: 2 }).status).toBe('correlation-unproven');
    expect(adapt(text, { ...envelope, seq: 2, gateId: 'example-gate' }).status).toBe('correlation-unproven');
  });

  test('synthetic Stop stays unknown, UserPromptSubmit starts, and neither clears a gate', () => {
    const stop = normalized(adapt(JSON.stringify(body('Stop', { stop_hook_active: false, last_assistant_message: 'example-private-body' })),
      { ...envelope, seq: 2, ...gate }));
    expect(stop.kind).toBe('candidate-state');
    expect(stop.advisory).toBe('unknown');
    expect(stop.gateId).toBeUndefined();
    expect(reduceNativeObservation(gated(), stop).state.gate).not.toBeNull();
    const prompt = normalized(adapt(JSON.stringify(body('UserPromptSubmit', { prompt: 'example-private-body' })), { ...envelope, seq: 2 }));
    expect(prompt.kind).toBe('turn-start');
    expect(reduceNativeObservation(gated(), prompt).outcome.reason).toBe('gate_preserved');
    expect(JSON.stringify(stop)).not.toContain('example-private-body');
  });

  test('synthetic subagent activity requires explicit matching lane/agent and cannot clear main gate', () => {
    const metadata = { ...envelope, lane: 'subagent', agentId: 'example-subagent', seq: 2, ...gate };
    const events = [tool('PreToolUse', { agent_id: 'example-subagent' }),
      tool('PostToolUse', { agent_id: 'example-subagent' }),
      body('SubagentStart', { agent_id: 'example-subagent', agent_type: 'example-kind' }),
      body('SubagentStop', { agent_id: 'example-subagent', agent_type: 'example-kind', stop_hook_active: false,
        agent_transcript_path: '/example/never-read.jsonl' })];
    for (const value of events) {
      const text = JSON.stringify(value);
      const observation = normalized(adapt(text, metadata));
      expect(observation.kind).toBe('subagent');
      expect(observation.lane).toBe('subagent');
      expect(observation.gateId).toBeUndefined();
      const result = reduceNativeObservation(gated(), observation);
      expect(result.outcome.reason).toBe('subagent_ignored');
      expect(result.state.gate?.ownerRequired).toBe(true);
      expect(result.state.processConfirmation).toBe('not_requested');
      expect(adapt(text, { ...metadata, agentId: 'example-other' }).status).toBe('correlation-unproven');
      expect(adapt(text, envelope).status).toBe('correlation-unproven');
    }
    expect(adapt(JSON.stringify(tool()), metadata).status).toBe('correlation-unproven');
    expect(adapt(JSON.stringify(body('SessionEnd', { reason: 'other', agent_id: 'example-subagent' })), metadata).status).toBe('correlation-unproven');
  });

  test('synthetic SessionEnd requires correlation and remains process-confirmation-needed for every known reason', () => {
    for (const reason of ['clear', 'resume', 'logout', 'prompt_input_exit', 'other']) {
      const observation = normalized(adapt(JSON.stringify(body('SessionEnd', { reason })), { ...envelope, seq: 2 }));
      expect(observation.kind).toBe('session-end');
      const result = reduceNativeObservation(gated(), observation);
      expect(result.state.processConfirmation).toBe('needed');
      expect(result.state.gate).not.toBeNull();
      expect(JSON.stringify(result.state)).not.toContain('idle');
      expect(JSON.stringify(result.state)).not.toContain('done');
    }
    const missingPrompt = body('SessionEnd', { reason: 'other', prompt_id: undefined });
    expect(adapt(JSON.stringify(missingPrompt), envelope).status).toBe('correlation-unproven');
    expect(adapt(JSON.stringify(body('SessionEnd', { reason: 'example-future' })), envelope).status).toBe('unsupported');
  });

  test('permission notification/request cannot invent a tool/gate link from text or envelope', () => {
    for (const value of [body('Notification', { notification_type: 'permission_prompt', message: 'allow toolu_example example-gate' }),
      body('PermissionRequest', { tool_name: 'Read', tool_input: { example: true }, permission_suggestions: [{ behavior: 'allow' }] })]) {
      expect(adapt(JSON.stringify(value), { ...envelope, ...gate })).toEqual({ status: 'correlation-unproven', reason: 'unbound_permission' });
    }
    expect(adapt(JSON.stringify(body('PermissionRequest', { tool_name: 'Read', tool_input: {}, tool_use_id: 'toolu_example' })), envelope).status).toBe('unsupported');
    expect(adapt(JSON.stringify(body('Notification', { notification_type: 'idle_prompt', message: 'example-private-body' })), envelope)).toEqual({ status: 'ignored', reason: 'notification' });
    expect(adapt(JSON.stringify(body('SessionStart', { source: 'resume' })), envelope).status).toBe('unsupported');
  });

  test('missing, foreign or mismatched session/prompt/tool metadata remains unproven', () => {
    const text = JSON.stringify(tool());
    for (const changed of [{ sessionId: 'example-other' }, { promptId: 'example-other' }, { toolUseId: 'toolu_other' }]) {
      expect(adapt(text, { ...envelope, ...changed }).status).toBe('correlation-unproven');
    }
    for (const field of Object.keys(envelope)) {
      const missing: Record<string, unknown> = { ...envelope };
      delete missing[field];
      expect(adapt(text, missing).status).toBe('correlation-unproven');
    }
    for (const field of ['session_id', 'prompt_id', 'tool_use_id']) {
      const missing: Record<string, unknown> = { ...tool() };
      delete missing[field];
      expect(adapt(JSON.stringify(missing), envelope).status).toBe('correlation-unproven');
    }
    expect(adapt(text, undefined).status).toBe('correlation-unproven');
    expect(adapt(text, {}).status).toBe('correlation-unproven');
    const observation = normalized(adapt(text, envelope));
    const first = reduceNativeObservation(establishContext(initialNativeCandidate(), context).state, observation);
    expect(first.outcome.accepted).toBe(true);
    expect(reduceNativeObservation(first.state, observation).outcome.reason).toBe('duplicate_sequence');
    const gap = normalized(adapt(text, { ...envelope, seq: 3 }));
    expect(reduceNativeObservation(first.state, gap).outcome.reason).toBe('sequence_gap');
  });

  test('opaque identifiers are compared literally, never rewritten to fit reducer tokens', () => {
    const providerSession = 'example session/é';
    const observation = normalized(adapt(JSON.stringify(tool('PreToolUse', { session_id: providerSession })), { ...envelope, sessionId: providerSession }));
    expect(observation.toolId).toBe('toolu_example');
    expect(JSON.stringify(observation)).not.toContain(providerSession);
    for (const toolId of ['example/tool', 'x'.repeat(65), 'example é']) {
      expect(adapt(JSON.stringify(tool('PreToolUse', { tool_use_id: toolId })), { ...envelope, toolUseId: toolId })).toEqual({ status: 'unsupported', reason: 'identifier_contract' });
    }
    for (const toolId of ['bad', 'x'.repeat(64)]) {
      expect(normalized(adapt(JSON.stringify(tool('PreToolUse', { tool_use_id: toolId })), { ...envelope, toolUseId: toolId })).toolId).toBe(toolId);
    }
    expect(adapt(JSON.stringify(tool('PreToolUse', { session_id: providerSession + ' ' })), { ...envelope, sessionId: providerSession }).status).toBe('correlation-unproven');
  });

  test('bounded JSON handles exact byte limit, duplicates/escaped keys and irrelevant nested content', () => {
    const minimal = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '' });
    const exact = JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x'.repeat(65536 - minimal.length) });
    expect(new TextEncoder().encode(exact)).toHaveLength(65536);
    expect(adapt(exact, envelope).status).toBe('correlation-unproven');
    expect(adapt(exact + ' ', envelope)).toEqual({ status: 'unsupported', reason: 'payload_limit' });
    expect(adapt(JSON.stringify(tool('PreToolUse', { tool_input: { text: 'é'.repeat(33000) } })), envelope).status).toBe('unsupported');
    const text = JSON.stringify(tool());
    const duplicate = text.replace('{', '{"session_id":"example-other",');
    expect(adapt(duplicate, envelope).status).toBe('malformed');
    expect(adapt(text.replace('{', '{"session_\\u0069d":"example-other",'), envelope).status).toBe('malformed');
    expect(adapt(JSON.stringify(tool('PreToolUse', { tool_input: { nested: { session_id: 'example-ignored' }, text: '"session_id", \\"example" {} []', fraction: 0.25 } })), envelope).status).toBe('normalized');
    for (const value of ['', '{', '[]', 'null', 'true', '"example"']) expect(adapt(value, envelope).status).toBe('malformed');
  });

  test('malformed critical data and unsafe numeric values cannot coerce success', () => {
    const text = JSON.stringify(tool());
    for (const seq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
      expect(adapt(text, { ...envelope, seq }).status).toBe('malformed');
    }
    for (const field of ['session_id', 'prompt_id', 'tool_use_id']) {
      for (const value of ['', 1, null, 'example\n', 'x'.repeat(257)]) {
        expect(adapt(JSON.stringify(tool('PreToolUse', { [field]: value })), envelope).status).toBe('malformed');
      }
    }
    for (const value of [null, [], 'example']) expect(adapt(JSON.stringify(tool('PreToolUse', { tool_input: value })), envelope).status).toBe('malformed');
    for (const duration_ms of [-1, 1.5, '12']) expect(adapt(JSON.stringify(tool('PostToolUse', { duration_ms })), { ...envelope, ...gate }).status).toBe('malformed');
    expect(adapt(text.replace('"tool_input":{', '"tool_input":{"unsafe":1e309,'), envelope).status).toBe('malformed');
    expect(adapt(JSON.stringify(tool('PreToolUse', { tool_input: { unsafe: Number.MAX_SAFE_INTEGER + 1 } })), envelope).status).toBe('malformed');
    expect(adapt(JSON.stringify(body('Stop', { stop_hook_active: 'false' })), envelope).status).toBe('malformed');
    expect(adapt(JSON.stringify(tool('PreToolUse', { ownerRequired: false })), envelope).status).toBe('unsupported');
    expect(adapt(text, { ...envelope, trusted: true }).status).toBe('malformed');
  });

  test('accessors/proxies cannot execute payload getters or leak inspection errors; output stays immutable', () => {
    let reads = 0;
    const objectPayload = { get hook_event_name() { reads++; throw Error('example-private-error'); } };
    expect(adapt(objectPayload, envelope).status).toBe('malformed');
    const metadata = Object.defineProperty({ ...envelope }, 'seq', { get() { reads++; throw Error('example-private-error'); } });
    expect(adapt(JSON.stringify(tool()), metadata).status).toBe('malformed');
    expect(reads).toBe(0);
    const proxy = new Proxy({}, { getPrototypeOf() { throw Error('example-private-error'); } });
    const failure = adapt(JSON.stringify(tool()), proxy);
    expect(failure.status).toBe('malformed');
    expect(JSON.stringify(failure)).not.toContain('example-private-error');
    const frozen = Object.freeze({ ...envelope });
    const before = JSON.stringify(frozen);
    const result = adapt(JSON.stringify(tool()), frozen);
    const observation = normalized(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Reflect.set(observation, 'lane', 'subagent')).toBe(false);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(JSON.stringify(observation)).not.toContain('never-read');
    expect(JSON.stringify(observation)).not.toContain('tool_input');
    expect(JSON.stringify(observation)).not.toContain('tool_response');
    const hidden = Object.defineProperty({ ...envelope }, 'raw', { value: 'example-private-body' });
    expect(adapt(JSON.stringify(tool()), hidden).status).toBe('malformed');
  });
});
