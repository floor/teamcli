import type { ClosedAdvisory, NativeKind, NativeLane } from './native-observation.ts';

/** Candidate only: caller must separately establish current launch/turn/lane/sequence authority. */
export type ClaudeNativeObservation = Readonly<{
  source: 'native'; seq: number; kind: NativeKind; seatId: string; incarnation: string;
  mainTurn: string; lane: NativeLane; toolId?: string; gateId?: string; binding?: string;
  advisory?: ClosedAdvisory;
}>;
type Refusal = Readonly<{
  status: 'ignored' | 'unsupported' | 'malformed' | 'correlation-unproven';
  reason: 'payload_shape' | 'payload_limit' | 'event' | 'schema' | 'notification' |
    'missing_envelope' | 'envelope_shape' | 'missing_correlation' | 'correlation_mismatch' |
    'identifier_contract' | 'unbound_permission' | 'session_reason';
}>;
export type ClaudeHookResult = Readonly<{ status: 'normalized'; observation: ClaudeNativeObservation }> | Refusal;
type Envelope = {
  seatId: string; incarnation: string; mainTurn: string; lane: NativeLane; seq: number;
  sessionId: string; promptId: string; agentId?: string; toolUseId?: string; gateId?: string; binding?: string;
};
const ENVELOPE_FIELDS = new Set(['seatId', 'incarnation', 'mainTurn', 'lane', 'seq',
  'sessionId', 'promptId', 'agentId', 'toolUseId', 'gateId', 'binding']);
const COMMON = ['session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir',
  'permission_mode', 'effort', 'hook_event_name', 'agent_id', 'agent_type'];
const SCHEMAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  UserPromptSubmit: ['prompt'],
  PreToolUse: ['tool_name', 'tool_input', 'tool_use_id', 'mcp_server'],
  PostToolUse: ['tool_name', 'tool_input', 'tool_use_id', 'tool_response', 'duration_ms', 'mcp_server'],
  Stop: ['stop_hook_active', 'last_assistant_message', 'background_tasks', 'session_crons'],
  SubagentStart: [],
  SubagentStop: ['stop_hook_active', 'agent_transcript_path', 'last_assistant_message'],
  SessionEnd: ['reason'],
  Notification: ['notification_type', 'message', 'title'],
  PermissionRequest: ['tool_name', 'tool_input', 'permission_suggestions', 'mcp_server'],
});

/** JSON text only, <=64KiB UTF-8. No object getters, IO, path following, clock or state mutation. */
export function adaptClaudeHook(text: unknown, metadata: unknown): ClaudeHookResult {
  try {
    if (typeof text !== 'string') return refuse('malformed', 'payload_shape');
    if (text.length > 65536 || new TextEncoder().encode(text).length > 65536) {
      return refuse('unsupported', 'payload_limit');
    }
    const value: unknown = JSON.parse(text, (_key, item: unknown) => {
      if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER)) {
        throw new Error('unsupported numeric magnitude');
      }
      return item;
    });
    if (!plain(value) || duplicateTopKeys(text)) return refuse('malformed', 'payload_shape');
    const event = value.hook_event_name;
    if (typeof event !== 'string' || event.length === 0) return refuse('malformed', 'payload_shape');
    if (!Object.hasOwn(SCHEMAS, event)) return refuse('unsupported', 'event');
    const fields = new Set([...COMMON, ...SCHEMAS[event]!]);
    if (Object.keys(value).some((key) => !fields.has(key))) return refuse('unsupported', 'schema');
    for (const key of ['session_id', 'prompt_id', 'agent_id', 'tool_use_id']) {
      if (value[key] !== undefined && !opaque(value[key])) return refuse('malformed', 'payload_shape');
    }
    if (value.duration_ms !== undefined && !nonnegativeInteger(value.duration_ms)) {
      return refuse('malformed', 'payload_shape');
    }
    if (event === 'Notification') {
      if (typeof value.notification_type !== 'string') return refuse('malformed', 'payload_shape');
      return value.notification_type === 'permission_prompt' ?
        refuse('correlation-unproven', 'unbound_permission') : refuse('ignored', 'notification');
    }
    if (event === 'PermissionRequest') return refuse('correlation-unproven', 'unbound_permission');
    if ((event === 'PreToolUse' || event === 'PostToolUse') &&
      (!opaque(value.tool_name) || !plain(value.tool_input) ||
        (event === 'PostToolUse' && !Object.hasOwn(value, 'tool_response')))) {
      return refuse('malformed', 'payload_shape');
    }
    if (event === 'UserPromptSubmit' && typeof value.prompt !== 'string') return refuse('malformed', 'payload_shape');
    if ((event === 'Stop' || event === 'SubagentStop') && typeof value.stop_hook_active !== 'boolean') {
      return refuse('malformed', 'payload_shape');
    }
    if (event === 'SessionEnd') {
      if (typeof value.reason !== 'string') return refuse('malformed', 'payload_shape');
      if (!['clear', 'resume', 'logout', 'prompt_input_exit', 'other'].includes(value.reason)) {
        return refuse('unsupported', 'session_reason');
      }
    }
    const envelope = parseEnvelope(metadata);
    if ('status' in envelope) return envelope;
    if (value.session_id === undefined || value.prompt_id === undefined) {
      return refuse('correlation-unproven', 'missing_correlation');
    }
    if (value.session_id !== envelope.sessionId || value.prompt_id !== envelope.promptId) {
      return refuse('correlation-unproven', 'correlation_mismatch');
    }
    if (envelope.lane === 'main') {
      if (value.agent_id !== undefined || envelope.agentId !== undefined || event.startsWith('Subagent')) {
        return refuse('correlation-unproven', 'correlation_mismatch');
      }
    } else {
      if (value.agent_id === undefined || envelope.agentId === undefined) {
        return refuse('correlation-unproven', 'missing_correlation');
      }
      if (value.agent_id !== envelope.agentId || ['UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event)) {
        return refuse('correlation-unproven', 'correlation_mismatch');
      }
    }
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      const tool = value.tool_use_id;
      if (tool === undefined || envelope.toolUseId === undefined) return refuse('correlation-unproven', 'missing_correlation');
      if (tool !== envelope.toolUseId) return refuse('correlation-unproven', 'correlation_mismatch');
      if (!token(tool)) return refuse('unsupported', 'identifier_contract');
      if (envelope.lane === 'subagent') return normalized(envelope, 'subagent', { toolId: tool });
      if (event === 'PreToolUse') return normalized(envelope, 'tool-start', { toolId: tool });
      if (envelope.gateId === undefined || envelope.binding === undefined) {
        return refuse('correlation-unproven', 'missing_correlation');
      }
      return normalized(envelope, 'tool-end', { toolId: tool, gateId: envelope.gateId, binding: envelope.binding });
    }
    if (event === 'UserPromptSubmit') return normalized(envelope, 'turn-start');
    if (event === 'Stop') return normalized(envelope, 'candidate-state', { advisory: 'unknown' });
    if (event === 'SessionEnd') return normalized(envelope, 'session-end');
    return normalized(envelope, 'subagent');
  } catch {
    return refuse('malformed', 'payload_shape');
  }
}

function parseEnvelope(value: unknown): Envelope | Refusal {
  if (value === undefined || value === null) return refuse('correlation-unproven', 'missing_envelope');
  if (!plain(value)) return refuse('malformed', 'envelope_shape');
  const keys = Reflect.ownKeys(value);
  if (keys.length > ENVELOPE_FIELDS.size) return refuse('malformed', 'envelope_shape');
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !ENVELOPE_FIELDS.has(key)) return refuse('malformed', 'envelope_shape');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return refuse('malformed', 'envelope_shape');
    data[key] = descriptor.value;
  }
  for (const key of ['seatId', 'incarnation', 'mainTurn', 'lane', 'seq', 'sessionId', 'promptId']) {
    if (data[key] === undefined) return refuse('correlation-unproven', 'missing_correlation');
  }
  if (!token(data.seatId) || !token(data.incarnation) || !token(data.mainTurn) ||
    (data.lane !== 'main' && data.lane !== 'subagent') || !nonnegativeInteger(data.seq) || data.seq === 0 ||
    !opaque(data.sessionId) || !opaque(data.promptId)) return refuse('malformed', 'envelope_shape');
  for (const key of ['agentId', 'toolUseId']) {
    if (data[key] !== undefined && !opaque(data[key])) return refuse('malformed', 'envelope_shape');
  }
  for (const key of ['gateId', 'binding']) {
    if (data[key] !== undefined && !token(data[key])) return refuse('malformed', 'envelope_shape');
  }
  return { seatId: data.seatId, incarnation: data.incarnation, mainTurn: data.mainTurn,
    lane: data.lane, seq: data.seq, sessionId: data.sessionId, promptId: data.promptId,
    ...(data.agentId === undefined ? {} : { agentId: data.agentId as string }),
    ...(data.toolUseId === undefined ? {} : { toolUseId: data.toolUseId as string }),
    ...(data.gateId === undefined ? {} : { gateId: data.gateId as string }),
    ...(data.binding === undefined ? {} : { binding: data.binding as string }),
  };
}

function normalized(envelope: Envelope, kind: NativeKind,
  extra: Partial<Pick<ClaudeNativeObservation, 'toolId' | 'gateId' | 'binding' | 'advisory'>> = {}): ClaudeHookResult {
  return Object.freeze({ status: 'normalized', observation: Object.freeze({ source: 'native',
    seq: envelope.seq, kind, seatId: envelope.seatId, incarnation: envelope.incarnation,
    mainTurn: envelope.mainTurn, lane: envelope.lane, ...extra }) });
}
function refuse(status: Refusal['status'], reason: Refusal['reason']): Refusal {
  return Object.freeze({ status, reason });
}
function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9._:-]/.test(value);
}
function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** JSON.parse already validated grammar. Scan just root keys, decoding escapes before equality. */
function duplicateTopKeys(text: string): boolean {
  let depth = 0, expectKey = false;
  const keys = new Set<string>();
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (c === '"') {
      const start = index;
      for (index++; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue; }
        if (text[index] === '"') break;
      }
      if (depth === 1 && expectKey) {
        const key: string = JSON.parse(text.slice(start, index + 1));
        if (keys.has(key)) return true;
        keys.add(key); expectKey = false;
      }
    } else if (c === '{' || c === '[') {
      depth++; if (depth === 1) expectKey = true;
    } else if (c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
  }
  return false;
}
