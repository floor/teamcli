// A pure native-observation candidate. It tracks one main-thread permission gate and says when a
// session-end still needs process proof. It is not persisted presence, not a bus status record,
// and not permission to dispatch or answer. Matching seat and incarnation tokens is local
// consistency only: the check does not authenticate an observer, and a caller resets incarnation
// explicitly. The module never reads a clock, a session, or a credential.

const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;

const KINDS = [
  'permission-gate',
  'permission-clear',
  'tool-start',
  'tool-end',
  'turn-start',
  'turn-end',
  'subagent',
  'heartbeat',
  'candidate-state',
  'quiet',
  'session-end',
] as const;

const ADVISORIES = ['working', 'quiet', 'unknown'] as const;

const FIELDS = new Set([
  'source',
  'seq',
  'kind',
  'seatId',
  'incarnation',
  'mainTurn',
  'lane',
  'toolId',
  'gateId',
  'binding',
  'advisory',
  'ownerRequired',
]);

export type NativeKind = (typeof KINDS)[number];

export type NativeLane = 'main' | 'subagent';

export type ClosedAdvisory = (typeof ADVISORIES)[number];

export type AdvisoryWord = ClosedAdvisory | 'gated';

export type ProcessConfirmation = 'not_requested' | 'needed';

export type Continuity = 'proven' | 'unproven';

export type ReasonCode =
  | 'established'
  | 'incarnation_reset'
  | 'sequence_resynced'
  | 'malformed'
  | 'unsupported'
  | 'missing_context'
  | 'context_mismatch'
  | 'duplicate_sequence'
  | 'late_sequence'
  | 'sequence_gap'
  | 'ambiguous_gate'
  | 'correlation_mismatch'
  | 'gate_opened'
  | 'gate_cleared'
  | 'gate_preserved'
  | 'heartbeat_preserved'
  | 'quiet_preserved'
  | 'advisory_ignored'
  | 'advisory_updated'
  | 'session_end_unconfirmed'
  | 'owner_required_preserved'
  | 'subagent_ignored';

export type LogicalContext = {
  readonly seatId: string;
  readonly incarnation: string;
  readonly mainTurn: string;
};

/** The one open main-thread gate. Owner-required is fixed at open and is not a caller flag. */
export type PermissionGate = {
  readonly gateId: string;
  readonly toolId: string;
  readonly mainTurn: string;
  readonly binding: string;
  readonly ownerRequired: true;
};

export type NativeCandidateState = {
  readonly context: LogicalContext | null;
  readonly lastSeq: number | null;
  readonly continuity: Continuity;
  readonly gate: PermissionGate | null;
  readonly advisory: AdvisoryWord;
  readonly processConfirmation: ProcessConfirmation;
};

export type ReduceOutcome = {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly reason: ReasonCode;
};

export type ReduceResult = {
  readonly state: NativeCandidateState;
  readonly outcome: ReduceOutcome;
};

type Observation = {
  readonly seq: number;
  readonly kind: NativeKind;
  readonly seatId: string;
  readonly incarnation: string;
  readonly mainTurn: string;
  readonly lane: NativeLane;
  readonly toolId?: string;
  readonly gateId?: string;
  readonly binding?: string;
  readonly advisory?: ClosedAdvisory;
  readonly ownerRequired?: boolean;
};

type Parsed =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported' };

/** An empty candidate. Context arrives only through `establishContext`. */
export function initialNativeCandidate(): NativeCandidateState {
  return {
    context: null,
    lastSeq: null,
    continuity: 'proven',
    gate: null,
    advisory: 'unknown',
    processConfirmation: 'not_requested',
  };
}

/** Sets the current seat, incarnation, and main turn. Refused once context already exists. */
export function establishContext(state: NativeCandidateState, context: unknown): ReduceResult {
  if (state.context !== null) return refused(state, 'unsupported');
  const parsed = parseContext(context);
  if (parsed === null) return refused(state, 'malformed');
  return {
    state: { ...initialNativeCandidate(), context: parsed },
    outcome: { accepted: false, applied: true, reason: 'established' },
  };
}

/**
 * Replaces the incarnation fence. The seat id stays; the token must differ. The previous gate
 * does not carry across, and an observation that merely names a new token is not this call.
 */
export function resetIncarnation(state: NativeCandidateState, context: unknown): ReduceResult {
  const parsed = parseContext(context);
  if (parsed === null) return refused(state, 'malformed');
  if (state.context === null) return refused(state, 'missing_context');
  if (parsed.seatId !== state.context.seatId) return refused(state, 'context_mismatch');
  if (parsed.incarnation === state.context.incarnation) return refused(state, 'unsupported');
  return {
    state: { ...initialNativeCandidate(), context: parsed },
    outcome: { accepted: false, applied: true, reason: 'incarnation_reset' },
  };
}

/**
 * Acknowledges a gap without applying the skipped observation and without clearing a gate.
 * The next contiguous observation is `atSeq + 1`.
 */
export function resyncSequence(state: NativeCandidateState, atSeq: unknown): ReduceResult {
  if (!isSeq(atSeq)) return refused(state, 'malformed');
  if (state.context === null) return refused(state, 'missing_context');
  if (state.continuity !== 'unproven') return refused(state, 'unsupported');
  if (state.lastSeq !== null && atSeq <= state.lastSeq) return refused(state, 'unsupported');
  return {
    state: { ...copyState(state), lastSeq: atSeq, continuity: 'proven' },
    outcome: { accepted: false, applied: false, reason: 'sequence_resynced' },
  };
}

/** Accepts one normalized native observation. Malformed and unsupported shapes change nothing. */
export function reduceNativeObservation(state: NativeCandidateState, input: unknown): ReduceResult {
  const parsed = parseObservation(input);
  if (!parsed.ok) return refused(state, parsed.reason);
  const observation = parsed.observation;
  if (state.context === null) return refused(state, 'missing_context');
  if (
    observation.seatId !== state.context.seatId ||
    observation.incarnation !== state.context.incarnation
  ) {
    return refused(state, 'context_mismatch');
  }
  const sequence = classifySequence(state.lastSeq, observation.seq);
  if (sequence === 'duplicate') return refused(state, 'duplicate_sequence');
  if (sequence === 'late') return refused(state, 'late_sequence');
  if (sequence === 'gap') {
    if (state.continuity === 'unproven') return refused(state, 'sequence_gap');
    return {
      state: { ...copyState(state), continuity: 'unproven' },
      outcome: { accepted: false, applied: false, reason: 'sequence_gap' },
    };
  }
  return apply({ ...copyState(state), lastSeq: observation.seq, continuity: 'proven' }, observation);
}

function refused(state: NativeCandidateState, reason: ReasonCode): ReduceResult {
  return { state, outcome: { accepted: false, applied: false, reason } };
}

function classifySequence(lastSeq: number | null, seq: number): 'ok' | 'duplicate' | 'late' | 'gap' {
  if (lastSeq === null) return seq === 1 ? 'ok' : 'gap';
  if (seq === lastSeq) return 'duplicate';
  if (seq < lastSeq) return 'late';
  if (seq === lastSeq + 1) return 'ok';
  return 'gap';
}

function apply(state: NativeCandidateState, observation: Observation): ReduceResult {
  switch (observation.kind) {
    case 'permission-gate':
      return applyGate(state, observation);
    case 'permission-clear':
    case 'tool-end':
    case 'turn-end':
      return applyClear(state, observation);
    case 'tool-start':
    case 'turn-start':
      return applyActivity(state, observation);
    case 'subagent':
      return kept(state, 'subagent_ignored');
    case 'heartbeat':
      return applyHeartbeat(state, observation);
    case 'quiet':
      return applyQuiet(state, observation);
    case 'candidate-state':
      return applyCandidate(state, observation);
    case 'session-end':
      return applySessionEnd(state, observation);
  }
}

function applyGate(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (!mainTurnMatches(state, observation)) return kept(state, 'correlation_mismatch');
  if (observation.gateId === undefined || observation.toolId === undefined || observation.binding === undefined) {
    return kept(state, 'correlation_mismatch');
  }
  const opened: PermissionGate = {
    gateId: observation.gateId,
    toolId: observation.toolId,
    mainTurn: observation.mainTurn,
    binding: observation.binding,
    ownerRequired: true,
  };
  if (state.gate === null) {
    return changed(
      { ...state, gate: opened, advisory: 'gated' },
      observation.ownerRequired === false ? 'owner_required_preserved' : 'gate_opened',
    );
  }
  if (
    state.gate.gateId === opened.gateId &&
    state.gate.toolId === opened.toolId &&
    state.gate.binding === opened.binding &&
    state.gate.mainTurn === opened.mainTurn
  ) {
    return kept(state, observation.ownerRequired === false ? 'owner_required_preserved' : 'gate_preserved');
  }
  return kept(state, 'ambiguous_gate');
}

function applyClear(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (state.gate === null) {
    return kept(state, mainTurnMatches(state, observation) ? 'advisory_ignored' : 'correlation_mismatch');
  }
  if (!clearMatches(state, observation)) return kept(state, 'correlation_mismatch');
  return changed({ ...state, gate: null, advisory: 'unknown' }, 'gate_cleared');
}

function applyActivity(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (!mainTurnMatches(state, observation)) return kept(state, 'correlation_mismatch');
  if (state.gate !== null) return kept(state, 'gate_preserved');
  if (state.advisory === 'working') return kept(state, 'advisory_ignored');
  return changed({ ...state, advisory: 'working' }, 'advisory_updated');
}

function applyHeartbeat(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (state.gate !== null && observation.ownerRequired === false) return kept(state, 'owner_required_preserved');
  return kept(state, 'heartbeat_preserved');
}

function applyQuiet(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (state.gate !== null) {
    return kept(state, observation.ownerRequired === false ? 'owner_required_preserved' : 'quiet_preserved');
  }
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (!mainTurnMatches(state, observation)) return kept(state, 'correlation_mismatch');
  if (state.advisory === 'quiet') return kept(state, 'quiet_preserved');
  return changed({ ...state, advisory: 'quiet' }, 'quiet_preserved');
}

function applyCandidate(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (state.gate !== null) {
    return kept(state, observation.ownerRequired === false ? 'owner_required_preserved' : 'advisory_ignored');
  }
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (!mainTurnMatches(state, observation)) return kept(state, 'correlation_mismatch');
  if (observation.advisory === undefined || state.advisory === observation.advisory) {
    return kept(state, 'advisory_ignored');
  }
  return changed({ ...state, advisory: observation.advisory }, 'advisory_updated');
}

function applySessionEnd(state: NativeCandidateState, observation: Observation): ReduceResult {
  if (observation.lane === 'subagent') return kept(state, 'subagent_ignored');
  if (!mainTurnMatches(state, observation)) return kept(state, 'correlation_mismatch');
  const advisory = state.gate === null ? 'unknown' : state.advisory;
  const applied = state.processConfirmation !== 'needed' || state.advisory !== advisory;
  return {
    state: { ...state, processConfirmation: 'needed', advisory },
    outcome: { accepted: true, applied, reason: 'session_end_unconfirmed' },
  };
}

function clearMatches(state: NativeCandidateState, observation: Observation): boolean {
  const gate = state.gate;
  if (gate === null || !mainTurnMatches(state, observation)) return false;
  if (observation.mainTurn !== gate.mainTurn) return false;
  if (observation.gateId !== gate.gateId || observation.binding !== gate.binding) return false;
  if (observation.kind === 'turn-end') {
    return observation.toolId === undefined || observation.toolId === gate.toolId;
  }
  return observation.toolId === gate.toolId;
}

function mainTurnMatches(state: NativeCandidateState, observation: Observation): boolean {
  return state.context !== null && observation.mainTurn === state.context.mainTurn;
}

function kept(state: NativeCandidateState, reason: ReasonCode): ReduceResult {
  return { state, outcome: { accepted: true, applied: false, reason } };
}

function changed(state: NativeCandidateState, reason: ReasonCode): ReduceResult {
  return { state, outcome: { accepted: true, applied: true, reason } };
}

function copyState(state: NativeCandidateState): NativeCandidateState {
  return {
    context: state.context === null ? null : { ...state.context },
    lastSeq: state.lastSeq,
    continuity: state.continuity,
    gate: state.gate === null ? null : { ...state.gate },
    advisory: state.advisory,
    processConfirmation: state.processConfirmation,
  };
}

function parseContext(value: unknown): LogicalContext | null {
  try {
    const record = ownData(value);
    if (record === null) return null;
    const keys = Object.keys(record);
    if (keys.length !== 3 || !keys.every((key) => key === 'seatId' || key === 'incarnation' || key === 'mainTurn')) {
      return null;
    }
    if (!isToken(record.seatId) || !isToken(record.incarnation) || !isToken(record.mainTurn)) return null;
    return { seatId: record.seatId, incarnation: record.incarnation, mainTurn: record.mainTurn };
  } catch {
    return null;
  }
}

function parseObservation(input: unknown): Parsed {
  try {
    const record = ownData(input);
    if (record === null) return { ok: false, reason: 'malformed' };
    for (const key of Object.keys(record)) {
      if (!FIELDS.has(key)) return { ok: false, reason: 'malformed' };
    }
    if (record.source !== 'native') {
      return { ok: false, reason: typeof record.source === 'string' ? 'unsupported' : 'malformed' };
    }
    if (!isSeq(record.seq) || typeof record.kind !== 'string') return { ok: false, reason: 'malformed' };
    if (!isKind(record.kind)) {
      return { ok: false, reason: isToken(record.kind) ? 'unsupported' : 'malformed' };
    }
    if (!isToken(record.seatId) || !isToken(record.incarnation) || !isToken(record.mainTurn)) {
      return { ok: false, reason: 'malformed' };
    }
    if (record.lane !== 'main' && record.lane !== 'subagent') return { ok: false, reason: 'malformed' };
    const toolId = optionalToken(record.toolId);
    const gateId = optionalToken(record.gateId);
    const binding = optionalToken(record.binding);
    if (!toolId.ok || !gateId.ok || !binding.ok) return { ok: false, reason: 'malformed' };
    if (record.ownerRequired !== undefined && typeof record.ownerRequired !== 'boolean') {
      return { ok: false, reason: 'malformed' };
    }
    const advisory = parseAdvisory(record.advisory);
    if (advisory === 'bad') return { ok: false, reason: 'malformed' };
    if (record.kind === 'candidate-state') {
      if (advisory === undefined) return { ok: false, reason: 'malformed' };
    } else if (advisory !== undefined) {
      return { ok: false, reason: 'malformed' };
    }
    return {
      ok: true,
      observation: {
        seq: record.seq,
        kind: record.kind,
        seatId: record.seatId,
        incarnation: record.incarnation,
        mainTurn: record.mainTurn,
        lane: record.lane,
        ...(toolId.token === undefined ? {} : { toolId: toolId.token }),
        ...(gateId.token === undefined ? {} : { gateId: gateId.token }),
        ...(binding.token === undefined ? {} : { binding: binding.token }),
        ...(advisory === undefined ? {} : { advisory }),
        ...(record.ownerRequired === undefined ? {} : { ownerRequired: record.ownerRequired }),
      },
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** Own enumerable data properties only. An accessor is refused without being called. */
function ownData(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const copied: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    copied[key] = descriptor.value;
  }
  return copied;
}

function parseAdvisory(value: unknown): ClosedAdvisory | undefined | 'bad' {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return 'bad';
  return isAdvisory(value) ? value : 'bad';
}

function optionalToken(value: unknown): { readonly ok: true; readonly token: string | undefined } | { readonly ok: false } {
  if (value === undefined) return { ok: true, token: undefined };
  if (!isToken(value)) return { ok: false };
  return { ok: true, token: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isKind(value: string): value is NativeKind {
  return (KINDS as readonly string[]).includes(value);
}

function isAdvisory(value: string): value is ClosedAdvisory {
  return (ADVISORIES as readonly string[]).includes(value);
}
