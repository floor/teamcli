import type { ClosedAdvisory, NativeKind, NativeLane } from './native-observation.ts';

/** Pure candidate. Caller correlation is separate from provider frames. No IO, clock, or echo. */
export type CodexNativeObservation = Readonly<{
  source: 'native';
  seq: number;
  kind: NativeKind;
  seatId: string;
  incarnation: string;
  mainTurn: string;
  lane: NativeLane;
  toolId?: string;
  gateId?: string;
  binding?: string;
  advisory?: ClosedAdvisory;
}>;

type Reason =
  | 'payload_shape'
  | 'payload_limit'
  | 'missing_envelope'
  | 'envelope_shape'
  | 'missing_correlation'
  | 'correlation_mismatch'
  | 'identifier_contract'
  | 'unbound_permission'
  | 'ambiguous_cleanup'
  | 'method'
  | 'schema'
  | 'notification'
  | 'request'
  | 'response'
  | 'error';

type Refusal = Readonly<{
  status: 'ignored' | 'unsupported' | 'malformed' | 'correlation-unproven';
  reason: Reason;
}>;

export type CodexFrameResult =
  | Readonly<{ status: 'normalized'; observation: CodexNativeObservation }>
  | Refusal;

type Envelope = {
  seatId: string;
  incarnation: string;
  mainTurn: string;
  lane: NativeLane;
  seq: number;
  threadId: string;
  turnId?: string;
  itemId?: string;
  requestId?: string | number;
  toolId?: string;
  gateId?: string;
  binding?: string;
};

const MAX_BYTES = 65536;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const ENVELOPE_FIELDS = new Set([
  'seatId', 'incarnation', 'mainTurn', 'lane', 'seq', 'threadId',
  'turnId', 'itemId', 'requestId', 'toolId', 'gateId', 'binding',
]);
const FRAME_FIELDS = new Set(['jsonrpc', 'method', 'params', 'id', 'result', 'error']);
const APPROVALS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);
const TOOL_ITEMS = new Set(['commandExecution', 'fileChange']);
const ITEM_DONE = new Set(['completed', 'failed', 'declined']);
const TURN_DONE = new Set(['completed', 'interrupted', 'failed']);
const IGNORED = new Set([
  'thread/started',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/deleted',
  'thread/reverted',
  'turn/diff/updated',
  'turn/plan/updated',
  'hook/started',
  'hook/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'configWarning',
  'warning',
  'error',
]);

/**
 * One app-server frame, as JSON text or a plain object, plus a trusted caller envelope.
 * At most one native observation. Refusal reasons are fixed and carry no payload text.
 */
export function adaptCodexFrame(frame: unknown, metadata: unknown): CodexFrameResult {
  try {
    const envelope = parseEnvelope(metadata);
    if (isRefusal(envelope)) return envelope;
    const parsed = parseFrame(frame);
    if (isRefusal(parsed)) return parsed;
    const role = classify(parsed);
    if (typeof role !== 'string') return role;
    if (role === 'response') return refuse('ignored', 'response');
    if (role === 'error') return refuse('ignored', 'error');
    if (role === 'request') return handleRequest(parsed, envelope);
    return handleNotification(parsed, envelope);
  } catch {
    return refuse('malformed', 'payload_shape');
  }
}

function handleRequest(data: Record<string, unknown>, envelope: Envelope): CodexFrameResult {
  return typeof data.method === 'string' && APPROVALS.has(data.method)
    ? approval(data, envelope)
    : refuse('ignored', 'request');
}

function handleNotification(data: Record<string, unknown>, envelope: Envelope): CodexFrameResult {
  const method = data.method;
  if (typeof method !== 'string') return refuse('malformed', 'payload_shape');
  if (method === 'thread/status/changed') return statusChanged(data.params, envelope);
  if (method === 'turn/started') return turnStarted(data.params, envelope);
  if (method === 'turn/completed') return turnCompleted(data.params, envelope);
  if (method === 'item/started') return itemEvent(data.params, envelope, false);
  if (method === 'item/completed') return itemEvent(data.params, envelope, true);
  if (method === 'serverRequest/resolved') return resolved(data.params, envelope);
  if (method === 'thread/closed') return closed(data.params, envelope);
  if (IGNORED.has(method)) return refuse('ignored', 'notification');
  return refuse('unsupported', 'method');
}

function statusChanged(value: unknown, envelope: Envelope): CodexFrameResult {
  const params = readOpen(value);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = requireThread(params, envelope);
  if (thread !== null) return thread;
  const status = readOpen(params.status);
  if (status === null || typeof status.type !== 'string') return refuse('malformed', 'payload_shape');
  if (status.type === 'idle') return emit(envelope, 'quiet');
  if (status.type === 'notLoaded' || status.type === 'systemError') return refuse('ignored', 'notification');
  if (status.type !== 'active') return refuse('unsupported', 'schema');
  if (!Array.isArray(status.activeFlags) || status.activeFlags.some((flag) => typeof flag !== 'string')) {
    return refuse('malformed', 'payload_shape');
  }
  if (status.activeFlags.length > 0) return refuse('correlation-unproven', 'unbound_permission');
  return emit(envelope, 'candidate-state', { advisory: 'working' });
}

function turnStarted(value: unknown, envelope: Envelope): CodexFrameResult {
  const turn = readTurn(value, envelope);
  if ('status' in turn) return turn;
  return emit(envelope, 'turn-start');
}

function turnCompleted(value: unknown, envelope: Envelope): CodexFrameResult {
  const turn = readTurn(value, envelope);
  if ('status' in turn) return turn;
  if (typeof turn.turn.status !== 'string') return refuse('malformed', 'payload_shape');
  if (!TURN_DONE.has(turn.turn.status)) return refuse('unsupported', 'schema');
  return emit(envelope, 'turn-end');
}

function itemEvent(value: unknown, envelope: Envelope, completed: boolean): CodexFrameResult {
  const params = readOpen(value);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = optionalThread(params, envelope);
  if (thread !== null) return thread;
  const item = readOpen(params.item);
  if (item === null || typeof item.type !== 'string') return refuse('malformed', 'payload_shape');
  if (!TOOL_ITEMS.has(item.type)) return refuse('ignored', 'notification');
  if (typeof item.id !== 'string' || !opaque(item.id)) return refuse('malformed', 'payload_shape');
  if (envelope.itemId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  if (item.id !== envelope.itemId) return refuse('correlation-unproven', 'correlation_mismatch');
  const turn = optionalTurn(params, envelope) ?? optionalTurn(item, envelope);
  if (turn !== null) return turn;
  if (!completed) return toolStart(envelope);
  if (typeof item.status !== 'string') return refuse('malformed', 'payload_shape');
  if (!ITEM_DONE.has(item.status)) return refuse('unsupported', 'schema');
  return correlatedEnd(envelope);
}

function resolved(value: unknown, envelope: Envelope): CodexFrameResult {
  const params = readOpen(value);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = requireThread(params, envelope);
  if (thread !== null) return thread;
  if (params.requestId !== undefined && !validId(params.requestId)) return refuse('malformed', 'payload_shape');
  return refuse('correlation-unproven', 'ambiguous_cleanup');
}

function closed(value: unknown, envelope: Envelope): CodexFrameResult {
  const params = readOpen(value);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = requireThread(params, envelope);
  if (thread !== null) return thread;
  return emit(envelope, 'session-end');
}

function approval(data: Record<string, unknown>, envelope: Envelope): CodexFrameResult {
  const params = readOpen(data.params);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = requireThread(params, envelope);
  if (thread !== null) return thread;
  if (params.turnId === undefined || envelope.turnId === undefined) {
    return refuse('correlation-unproven', 'missing_correlation');
  }
  const turn = requireTurn(params.turnId, envelope);
  if (turn !== null) return turn;
  if (typeof params.itemId !== 'string' || !opaque(params.itemId)) return refuse('malformed', 'payload_shape');
  if (envelope.itemId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  if (params.itemId !== envelope.itemId) return refuse('correlation-unproven', 'correlation_mismatch');
  if (envelope.requestId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  if (data.id !== envelope.requestId || !validId(data.id)) {
    return refuse('correlation-unproven', 'correlation_mismatch');
  }
  return correlatedGate(envelope);
}

function toolStart(envelope: Envelope): CodexFrameResult {
  if (envelope.toolId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  if (!token(envelope.toolId)) return refuse('unsupported', 'identifier_contract');
  return emit(envelope, 'tool-start', { toolId: envelope.toolId });
}

function correlatedEnd(envelope: Envelope): CodexFrameResult {
  if (envelope.toolId === undefined || envelope.gateId === undefined || envelope.binding === undefined) {
    return refuse('correlation-unproven', 'unbound_permission');
  }
  if (!token(envelope.toolId) || !token(envelope.gateId) || !token(envelope.binding)) {
    return refuse('unsupported', 'identifier_contract');
  }
  return emit(envelope, 'tool-end', {
    toolId: envelope.toolId,
    gateId: envelope.gateId,
    binding: envelope.binding,
  });
}

function correlatedGate(envelope: Envelope): CodexFrameResult {
  if (envelope.toolId === undefined || envelope.gateId === undefined || envelope.binding === undefined) {
    return refuse('correlation-unproven', 'unbound_permission');
  }
  if (!token(envelope.toolId) || !token(envelope.gateId) || !token(envelope.binding)) {
    return refuse('unsupported', 'identifier_contract');
  }
  return emit(envelope, 'permission-gate', {
    toolId: envelope.toolId,
    gateId: envelope.gateId,
    binding: envelope.binding,
  });
}

function emit(
  envelope: Envelope,
  kind: NativeKind,
  extra: Partial<Pick<CodexNativeObservation, 'toolId' | 'gateId' | 'binding' | 'advisory'>> = {},
): CodexFrameResult {
  const base = {
    source: 'native' as const,
    seq: envelope.seq,
    seatId: envelope.seatId,
    incarnation: envelope.incarnation,
    mainTurn: envelope.mainTurn,
    lane: envelope.lane,
  };
  if (envelope.lane === 'subagent') {
    return Object.freeze({
      status: 'normalized',
      observation: Object.freeze({ ...base, kind: 'subagent' }),
    });
  }
  return Object.freeze({
    status: 'normalized',
    observation: Object.freeze({ ...base, kind, ...extra }),
  });
}

function readTurn(
  value: unknown,
  envelope: Envelope,
): { readonly turn: Record<string, unknown> } | Refusal {
  const params = readOpen(value);
  if (params === null) return refuse('malformed', 'payload_shape');
  const thread = optionalThread(params, envelope);
  if (thread !== null) return thread;
  const turn = readOpen(params.turn);
  if (turn === null) return refuse('malformed', 'payload_shape');
  const nested = optionalThread(turn, envelope);
  if (nested !== null) return nested;
  if (typeof turn.id !== 'string' || !opaque(turn.id)) return refuse('malformed', 'payload_shape');
  if (envelope.turnId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  const matched = requireTurn(turn.id, envelope);
  if (matched !== null) return matched;
  return { turn };
}

function requireThread(params: Record<string, unknown>, envelope: Envelope): Refusal | null {
  if (typeof params.threadId !== 'string' || !opaque(params.threadId)) return refuse('malformed', 'payload_shape');
  if (params.threadId !== envelope.threadId) return refuse('correlation-unproven', 'correlation_mismatch');
  return null;
}

function optionalThread(params: Record<string, unknown>, envelope: Envelope): Refusal | null {
  if (params.threadId === undefined) return null;
  return requireThread(params, envelope);
}

function optionalTurn(params: Record<string, unknown>, envelope: Envelope): Refusal | null {
  if (params.turnId === undefined) return null;
  if (envelope.turnId === undefined) return refuse('correlation-unproven', 'missing_correlation');
  return requireTurn(params.turnId, envelope);
}

function requireTurn(value: unknown, envelope: Envelope): Refusal | null {
  if (typeof value !== 'string' || !opaque(value)) return refuse('malformed', 'payload_shape');
  if (value !== envelope.turnId) return refuse('correlation-unproven', 'correlation_mismatch');
  return null;
}

function parseEnvelope(value: unknown): Envelope | Refusal {
  if (value === undefined || value === null) return refuse('correlation-unproven', 'missing_envelope');
  const data = readFields(value, ENVELOPE_FIELDS, 'envelope_shape');
  if (isRefusal(data)) return data;
  const seatId = data.seatId;
  const incarnation = data.incarnation;
  const mainTurn = data.mainTurn;
  const lane = data.lane;
  const seq = data.seq;
  const threadId = data.threadId;
  if (seatId === undefined || incarnation === undefined || mainTurn === undefined || lane === undefined ||
    seq === undefined || threadId === undefined) {
    return refuse('correlation-unproven', 'missing_correlation');
  }
  if (!token(seatId) || !token(incarnation) || !token(mainTurn) || !opaque(threadId)) {
    return refuse('malformed', 'envelope_shape');
  }
  if (lane !== 'main' && lane !== 'subagent') return refuse('malformed', 'envelope_shape');
  if (!positiveSeq(seq)) return refuse('malformed', 'envelope_shape');
  const turnId = data.turnId;
  const itemId = data.itemId;
  const requestId = data.requestId;
  const toolId = data.toolId;
  const gateId = data.gateId;
  const binding = data.binding;
  if ((turnId !== undefined && !opaque(turnId)) || (itemId !== undefined && !opaque(itemId))) {
    return refuse('malformed', 'envelope_shape');
  }
  if (requestId !== undefined && !validId(requestId)) return refuse('malformed', 'envelope_shape');
  if ((toolId !== undefined && !token(toolId)) || (gateId !== undefined && !token(gateId)) ||
    (binding !== undefined && !token(binding))) {
    return refuse('unsupported', 'identifier_contract');
  }
  return {
    seatId, incarnation, mainTurn, lane, seq, threadId,
    ...(turnId === undefined ? {} : { turnId }),
    ...(itemId === undefined ? {} : { itemId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(toolId === undefined ? {} : { toolId }),
    ...(gateId === undefined ? {} : { gateId }),
    ...(binding === undefined ? {} : { binding }),
  };
}

function parseFrame(frame: unknown): Record<string, unknown> | Refusal {
  if (typeof frame === 'string') {
    if (byteLength(frame) > MAX_BYTES) return refuse('unsupported', 'payload_limit');
    const value: unknown = JSON.parse(frame, (_key, item: unknown) => {
      if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER)) {
        throw new Error('unsafe number');
      }
      return item;
    });
    if (duplicateTopKeys(frame)) return refuse('malformed', 'payload_shape');
    const read = readFields(value, FRAME_FIELDS, 'payload_shape');
    if (isRefusal(read)) return read;
    return read;
  }
  const data = readFields(frame, FRAME_FIELDS, 'payload_shape');
  if (isRefusal(data)) return data;
  if (byteLength(JSON.stringify(data)) > MAX_BYTES) return refuse('unsupported', 'payload_limit');
  return data;
}

function classify(data: Record<string, unknown>): 'request' | 'notification' | 'response' | 'error' | Refusal {
  if (data.jsonrpc !== undefined && data.jsonrpc !== '2.0') return refuse('unsupported', 'schema');
  const hasMethod = data.method !== undefined;
  if (hasMethod) {
    if (typeof data.method !== 'string' || data.method.length === 0 || data.method.length > 128) {
      return refuse('malformed', 'payload_shape');
    }
    if (data.result !== undefined || data.error !== undefined) return refuse('malformed', 'payload_shape');
    if (data.id !== undefined && !validId(data.id)) return refuse('malformed', 'payload_shape');
    return data.id === undefined ? 'notification' : 'request';
  }
  if (!validId(data.id)) return refuse('malformed', 'payload_shape');
  if (data.error !== undefined && data.result === undefined) return 'error';
  if (data.result !== undefined && data.error === undefined) return 'response';
  return refuse('malformed', 'payload_shape');
}

function readFields(
  value: unknown,
  allowed: Set<string>,
  reason: 'payload_shape' | 'envelope_shape',
): Record<string, unknown> | Refusal {
  if (!plain(value)) return refuse('malformed', reason);
  const data: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) return refuse('malformed', reason);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return refuse('malformed', reason);
    data[key] = descriptor.value;
  }
  return data;
}

function readOpen(value: unknown): Record<string, unknown> | null {
  if (!plain(value)) return null;
  const data: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    data[key] = descriptor.value;
  }
  return data;
}

function refuse(status: Refusal['status'], reason: Reason): Refusal {
  return Object.freeze({ status, reason });
}

function isRefusal(value: object): value is Refusal {
  if (!Object.hasOwn(value, 'status') || !Object.hasOwn(value, 'reason') || Object.hasOwn(value, 'observation')) {
    return false;
  }
  const status = Object.getOwnPropertyDescriptor(value, 'status')?.value;
  return status === 'ignored' || status === 'unsupported' || status === 'malformed' ||
    status === 'correlation-unproven';
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function token(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function positiveSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function validId(value: unknown): value is string | number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return opaque(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** JSON.parse already validated grammar. Scan only root keys, decoding escapes before equality. */
function duplicateTopKeys(text: string): boolean {
  let depth = 0;
  let expectKey = false;
  const keys = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === '\\') {
          index += 1;
          continue;
        }
        if (text[index] === '"') break;
      }
      if (depth === 1 && expectKey) {
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys.has(key)) return true;
        keys.add(key);
        expectKey = false;
      }
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth === 1) expectKey = true;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      expectKey = true;
    }
  }
  return false;
}
