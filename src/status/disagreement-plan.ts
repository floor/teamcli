/** Pure sampled-disagreement diagnostics. Does not select status, authenticate, log or dispatch. */
export type DisagreementSource = 'native' | 'host' | 'screen';
export type DisagreementWord = 'working' | 'quiet' | 'gated' | 'blocked' | 'unknown' | 'unreachable' | 'exited';
export type DisagreementContext = Readonly<{ seatId: string; incarnation: string }>;
type Fact = Readonly<{ source: DisagreementSource; word: DisagreementWord }>;
type Reading = Fact & Readonly<{ healthy: boolean; current: boolean }>;
type Fingerprint = Readonly<{ winner: Fact; other: Fact }>;
type Active = Readonly<{ fingerprint: Fingerprint; since: number; emitted: boolean }>;
export type DisagreementPlanState = Readonly<{
  context: DisagreementContext | null;
  now: number;
  lastSeq: number;
  active: Active | null;
}>;
export type DisagreementDiagnostic = Readonly<{
  context: DisagreementContext;
  winner: Fact;
  other: Fact;
  since: number;
  at: number;
}>;
export type DisagreementPlanResult = Readonly<{
  state: DisagreementPlanState;
  diagnostic: DisagreementDiagnostic | null;
  accepted: boolean;
  reason: 'context_reset' | 'malformed' | 'missing_context' | 'context_mismatch' |
    'stale_sequence' | 'time_regression' | 'same_source' | 'unavailable' | 'agreement' |
    'overflow' | 'conflict_started' | 'conflict_pending' | 'conflict_reported' | 'conflict_suppressed';
}>;
type Input = {
  context: DisagreementContext; seq: number; now: number; winner: Reading | null; other: Reading | null;
};
const CONTEXT_FIELDS = new Set(['seatId', 'incarnation']);
const INPUT_FIELDS = new Set(['context', 'seq', 'now', 'winner', 'other']);
const READING_FIELDS = new Set(['source', 'word', 'healthy', 'current']);
const WORDS: readonly string[] = ['working', 'quiet', 'gated', 'blocked', 'unknown', 'unreachable', 'exited'];

export function initialDisagreementPlan(): DisagreementPlanState {
  return freezeState({ context: null, now: 0, lastSeq: 0, active: null });
}

/** Explicit context reset breaks continuity. Same-context reset retains the sequence fence. */
export function resetDisagreementPlan(
  state: DisagreementPlanState, context: unknown, now: unknown,
): DisagreementPlanResult {
  try {
    const parsed = parseContext(context);
    if (parsed === null || !isTime(now)) return outcome(state, false, 'malformed');
    if (now < state.now) return outcome(state, false, 'time_regression');
    const same = state.context !== null && sameContext(state.context, parsed);
    return outcome(freezeState({ context: parsed, now, lastSeq: same ? state.lastSeq : 0, active: null }),
      true, 'context_reset');
  } catch {
    return outcome(state, false, 'malformed');
  }
}

/** Each call supplies a fresh paired sample; elapsed time without a sample cannot emit. */
export function observeDisagreementPlan(state: DisagreementPlanState, value: unknown): DisagreementPlanResult {
  try {
    const input = parseInput(value);
    if (input === null) return outcome(state, false, 'malformed');
    if (state.context === null) return outcome(state, false, 'missing_context');
    if (!sameContext(state.context, input.context)) return outcome(state, false, 'context_mismatch');
    if (input.seq <= state.lastSeq) return outcome(state, false, 'stale_sequence');
    if (input.now < state.now) return outcome(state, false, 'time_regression');
    const { winner, other } = input;
    if (winner !== null && other !== null && winner.source === other.source) return outcome(state, false, 'same_source');
    const next = { ...state, now: input.now, lastSeq: input.seq };
    if (winner === null || other === null || !winner.healthy || !winner.current || !other.healthy || !other.current) {
      return outcome(freezeState({ ...next, active: null }), true, 'unavailable');
    }
    if (winner.word === other.word) return outcome(freezeState({ ...next, active: null }), true, 'agreement');
    const fingerprint: Fingerprint = {
      winner: { source: winner.source, word: winner.word },
      other: { source: other.source, word: other.word },
    };
    const previous = state.active;
    if (previous === null || !sameFingerprint(previous.fingerprint, fingerprint)) {
      if (input.now > Number.MAX_SAFE_INTEGER - 2000) return outcome(state, false, 'overflow');
      return outcome(freezeState({ ...next, active: { fingerprint, since: input.now, emitted: false } }),
        true, 'conflict_started');
    }
    if (previous.emitted) return outcome(freezeState(next), true, 'conflict_suppressed');
    if (input.now - previous.since < 2000) return outcome(freezeState(next), true, 'conflict_pending');
    const settled = freezeState({ ...next, active: { ...previous, emitted: true } });
    const diagnostic = Object.freeze({ context: settled.context!, winner: settled.active!.fingerprint.winner,
      other: settled.active!.fingerprint.other, since: previous.since, at: input.now });
    return outcome(settled, true, 'conflict_reported', diagnostic);
  } catch {
    return outcome(state, false, 'malformed');
  }
}

function sameContext(a: DisagreementContext, b: DisagreementContext): boolean {
  return a.seatId === b.seatId && a.incarnation === b.incarnation;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.winner.source === b.winner.source && a.winner.word === b.winner.word &&
    a.other.source === b.other.source && a.other.word === b.other.word;
}

function freezeState(state: DisagreementPlanState): DisagreementPlanState {
  return Object.freeze({ ...state,
    context: state.context === null ? null : Object.freeze({ ...state.context }),
    active: state.active === null ? null : Object.freeze({ ...state.active, fingerprint: Object.freeze({
      winner: Object.freeze({ ...state.active.fingerprint.winner }),
      other: Object.freeze({ ...state.active.fingerprint.other }),
    }) }),
  });
}

function outcome(state: DisagreementPlanState, accepted: boolean, reason: DisagreementPlanResult['reason'],
  diagnostic: DisagreementDiagnostic | null = null): DisagreementPlanResult {
  return Object.freeze({ state, diagnostic, accepted, reason });
}

function parseContext(value: unknown): DisagreementContext | null {
  const data = record(value, CONTEXT_FIELDS);
  if (data === null || !isToken(data.seatId) || !isToken(data.incarnation)) return null;
  return { seatId: data.seatId, incarnation: data.incarnation };
}

function parseInput(value: unknown): Input | null {
  const data = record(value, INPUT_FIELDS);
  if (data === null || !isTime(data.seq) || data.seq === 0 || !isTime(data.now)) return null;
  const context = parseContext(data.context);
  const winner = parseReading(data.winner), other = parseReading(data.other);
  if (context === null || winner === undefined || other === undefined) return null;
  return { context, seq: data.seq, now: data.now, winner, other };
}

/** null is an explicit missing sample; undefined is malformed, never a valid fact sentinel. */
function parseReading(value: unknown): Reading | null | undefined {
  if (value === null) return null;
  const data = record(value, READING_FIELDS);
  if (data === null || !isSource(data.source) || !isWord(data.word) ||
    typeof data.healthy !== 'boolean' || typeof data.current !== 'boolean') return undefined;
  return { source: data.source, word: data.word, healthy: data.healthy, current: data.current };
}

function record(value: unknown, fields: Set<string>): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size) return null;
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !fields.has(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return null;
    data[key] = descriptor.value;
  }
  return data;
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9._:-]/.test(value);
}
function isSource(value: unknown): value is DisagreementSource {
  return value === 'native' || value === 'host' || value === 'screen';
}
function isWord(value: unknown): value is DisagreementWord {
  return typeof value === 'string' && WORDS.includes(value);
}
