/** Pure bounded proposals for a future observation executor. Never permission to capture/type. */
export type ProbeContext = Readonly<{
  seatId: string;
  incarnation: string;
  mainTurn: string;
  step: string;
}>;
export type ProbeCause = 'step' | 'output' | 'classification';
type PendingProbe = Readonly<{ dueAt: number; cause: ProbeCause }>;
export type ProbeDescriptor = Readonly<{
  context: ProbeContext;
  dueAt: number;
  causes: readonly ProbeCause[];
}>;
export type ProbePlanState = Readonly<{
  context: ProbeContext | null;
  contextAt: number;
  now: number;
  lastSeq: number;
  outputSeq: number;
  outputSince: number;
  staggered: boolean;
  completed: boolean;
  pending: readonly PendingProbe[];
}>;
export type ProbePlanResult = Readonly<{
  state: ProbePlanState;
  due: readonly ProbeDescriptor[];
  accepted: boolean;
  reason: 'context_reset' | 'malformed' | 'missing_context' | 'context_mismatch' |
    'stale_sequence' | 'time_regression' | 'subagent_ignored' | 'ineligible' |
    'overflow' | 'step_armed' | 'preserved' | 'step_completed' | 'output_unchanged' |
    'output_regression' | 'facts_regression' | 'output_planned' | 'classification_planned' | 'consumed';
}>;
type Reason = ProbePlanResult['reason'];
type CommonInput = {
  context: ProbeContext; seq: number; now: number; lane: 'main' | 'subagent'; eligible: boolean;
};
type Input = CommonInput & (
  { kind: 'tool-start' | 'turn-stop'; partialCoverage: boolean } |
  { kind: 'output'; outputSeq: number; mode: 'quiet' | 'working' | 'unknown'; since: number; partialCoverage: boolean } |
  { kind: 'completion' | 'permission-clear' | 'heartbeat' | 'other' | 'classify' | 'consume' }
);
const CONTEXT_KEYS = ['seatId', 'incarnation', 'mainTurn', 'step'];
const BASE_KEYS = ['context', 'seq', 'now', 'lane', 'eligibility', 'kind'];
const OUTPUT_KEYS = ['outputSeq', 'mode', 'since', 'partialCoverage'];
const ALL_KEYS = new Set([...BASE_KEYS, ...OUTPUT_KEYS]);
const ELIGIBILITY_KEYS = ['human', 'protected', 'stopped', 'supportsCapture'];

/** State must be kept from this API's output, not reconstructed from provider payloads. */
export function initialProbePlan(): ProbePlanState {
  return freezeState({ context: null, contextAt: 0, now: 0, lastSeq: 0, outputSeq: 0,
    outputSince: 0, staggered: false, completed: false, pending: [] });
}

/** Only an explicit caller transition may change the active step/incarnation/turn. */
export function resetProbePlan(state: ProbePlanState, context: unknown, now: unknown): ProbePlanResult {
  try {
    const parsed = parseContext(context);
    if (parsed === null || !isTime(now)) return outcome(state, false, 'malformed');
    if (now < state.now) return outcome(state, false, 'time_regression');
    const same = state.context !== null && sameContext(state.context, parsed);
    return outcome(freezeState({
      ...(same ? state : initialProbePlan()), context: parsed, contextAt: now, now,
      outputSince: now, pending: [],
    }), true, 'context_reset');
  } catch {
    return outcome(state, false, 'malformed');
  }
}

/** Caller supplies monotonic integer milliseconds and current eligibility on every main input. */
export function reduceProbePlan(state: ProbePlanState, value: unknown): ProbePlanResult {
  try {
    const input = parseInput(value);
    if (input === null) return outcome(state, false, 'malformed');
    if (state.context === null) return outcome(state, false, 'missing_context');
    if (!sameContext(state.context, input.context)) return outcome(state, false, 'context_mismatch');
    if (input.seq <= state.lastSeq) return outcome(state, false, 'stale_sequence');
    if (input.now < state.now) return outcome(state, false, 'time_regression');
    if (input.lane === 'subagent') {
      return outcome(freezeState({ ...state, lastSeq: input.seq, now: input.now }), true, 'subagent_ignored');
    }
    if (input.kind === 'output') {
      if (input.outputSeq < state.outputSeq) return outcome(state, false, 'output_regression');
      if (input.since < state.contextAt || input.since < state.outputSince) {
        return outcome(state, false, 'facts_regression');
      }
    }
    const next = { ...state, lastSeq: input.seq, now: input.now };
    if (!input.eligible) {
      return outcome(freezeState({ ...next, pending: [] }), true, 'ineligible');
    }
    if (input.kind === 'completion' || input.kind === 'permission-clear') {
      return outcome(freezeState({ ...next, completed: true, pending: [] }), true, 'step_completed');
    }
    if (input.kind === 'consume') return consume(freezeState(next));
    if (state.completed) return outcome(freezeState(next), true, 'preserved');
    if (input.kind === 'tool-start' || input.kind === 'turn-stop') {
      if (state.staggered || !input.partialCoverage) return outcome(freezeState(next), true, 'preserved');
      if (input.now > Number.MAX_SAFE_INTEGER - 3000) return outcome(state, false, 'overflow');
      return outcome(freezeState({ ...next, staggered: true, pending: [
        ...state.pending, ...[250, 1000, 3000].map((offset): PendingProbe => ({
          dueAt: input.now + offset, cause: 'step',
        })),
      ] }), true, 'step_armed');
    }
    if (input.kind === 'classify') {
      return outcome(freezeState({ ...next, pending: addOne(state.pending, 'classification', input.now) }),
        true, 'classification_planned');
    }
    if (input.kind === 'output') {
      if (input.outputSeq === state.outputSeq) return outcome(freezeState(next), true, 'output_unchanged');
      const output = { ...next, outputSeq: input.outputSeq, outputSince: input.since };
      const qualifies = (input.mode === 'quiet' && input.now - input.since >= 500) ||
        (input.mode === 'working' && input.partialCoverage && input.now - input.since >= 3000);
      if (!qualifies) return outcome(freezeState(output), true, 'preserved');
      if (!state.pending.some((probe) => probe.cause === 'output') && input.now > Number.MAX_SAFE_INTEGER - 300) {
        return outcome(state, false, 'overflow');
      }
      // An outstanding output deadline is retained, never postponed by another byte sequence.
      const pending = state.pending.some((probe) => probe.cause === 'output') ? state.pending :
        addOne(state.pending, 'output', input.now + 300);
      return outcome(freezeState({ ...output, pending }), true, 'output_planned');
    }
    return outcome(freezeState(next), true, 'preserved');
  } catch {
    return outcome(state, false, 'malformed');
  }
}

function addOne(pending: readonly PendingProbe[], cause: ProbeCause, dueAt: number): readonly PendingProbe[] {
  return pending.some((probe) => probe.cause === cause) ? pending : [...pending, { dueAt, cause }];
}

function consume(state: ProbePlanState): ProbePlanResult {
  const groups = new Map<number, ProbeCause[]>();
  for (const probe of state.pending) {
    if (probe.dueAt > state.now) continue;
    const causes = groups.get(probe.dueAt) ?? [];
    if (!causes.includes(probe.cause)) causes.push(probe.cause);
    groups.set(probe.dueAt, causes);
  }
  const due = [...groups.entries()].sort(([a], [b]) => a - b).map(([dueAt, causes]) => Object.freeze({
    context: state.context!, dueAt, causes: Object.freeze(causes.sort()),
  }));
  return outcome(freezeState({ ...state, pending: state.pending.filter((probe) => probe.dueAt > state.now) }),
    true, 'consumed', due);
}

function freezeState(state: ProbePlanState): ProbePlanState {
  return Object.freeze({ ...state,
    context: state.context === null ? null : Object.freeze({ ...state.context }),
    pending: Object.freeze(state.pending.map((probe) => Object.freeze({ ...probe }))),
  });
}

function outcome(state: ProbePlanState, accepted: boolean, reason: Reason,
  due: readonly ProbeDescriptor[] = []): ProbePlanResult {
  return Object.freeze({ state, due: Object.freeze(due), accepted, reason });
}

function sameContext(a: ProbeContext, b: ProbeContext): boolean {
  return a.seatId === b.seatId && a.incarnation === b.incarnation &&
    a.mainTurn === b.mainTurn && a.step === b.step;
}

function parseContext(value: unknown): ProbeContext | null {
  const data = dataRecord(value, new Set(CONTEXT_KEYS));
  if (data === null || CONTEXT_KEYS.some((key) => !isToken(data[key]))) return null;
  // Every required field has been independently checked; no provider object is retained.
  return { seatId: data.seatId as string, incarnation: data.incarnation as string,
    mainTurn: data.mainTurn as string, step: data.step as string };
}

function parseInput(value: unknown): Input | null {
  const data = dataRecord(value, ALL_KEYS);
  if (data === null) return null;
  const context = parseContext(data.context);
  if (context === null || !isTime(data.seq) || data.seq === 0 || !isTime(data.now) ||
    (data.lane !== 'main' && data.lane !== 'subagent')) return null;
  const eligibility = parseEligibility(data.eligibility);
  if (eligibility === null) return null;
  const kind = data.kind;
  const extra = kind === 'output' ? OUTPUT_KEYS :
    kind === 'tool-start' || kind === 'turn-stop' ? ['partialCoverage'] : [];
  if (Object.keys(data).some((key) => !BASE_KEYS.includes(key) && !extra.includes(key))) return null;
  const common: CommonInput = { context, seq: data.seq, now: data.now, lane: data.lane,
    eligible: eligibility.eligible };
  switch (kind) {
    case 'tool-start':
    case 'turn-stop':
      return typeof data.partialCoverage === 'boolean' ? { ...common, kind, partialCoverage: data.partialCoverage } : null;
    case 'output':
      if (!isTime(data.outputSeq) || !isTime(data.since) || data.since > data.now ||
        typeof data.partialCoverage !== 'boolean' ||
        (data.mode !== 'quiet' && data.mode !== 'working' && data.mode !== 'unknown')) return null;
      return { ...common, kind, outputSeq: data.outputSeq, since: data.since,
        mode: data.mode, partialCoverage: data.partialCoverage };
    case 'completion': case 'permission-clear': case 'heartbeat': case 'other': case 'classify': case 'consume':
      return { ...common, kind };
    default:
      return null;
  }
}

function parseEligibility(value: unknown): { eligible: boolean } | null {
  if (value === undefined) return { eligible: false };
  const data = dataRecord(value, new Set(ELIGIBILITY_KEYS));
  if (data === null || ELIGIBILITY_KEYS.some((key) => data[key] !== undefined && typeof data[key] !== 'boolean')) return null;
  return { eligible: data.human === false && data.protected === false &&
    data.stopped === false && data.supportsCapture === true };
}

function dataRecord(value: unknown, allowed: Set<string>): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.size) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    !/[^A-Za-z0-9._:-]/.test(value);
}
