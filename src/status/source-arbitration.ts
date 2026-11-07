// Pure source arbitration over explicit snapshots. It selects one advisory and keeps a native
// permission gate owner-required. It does not read a clock, a process table, a screen, or a
// credential, and its result is not permission to dispatch, wake, or type. Seat and incarnation
// equality is local consistency only.
import type { Continuity, PermissionGate, ProcessConfirmation } from './native-observation.ts';

const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;

const HEALTH = ['healthy', 'unhealthy', 'missing'] as const;
const NONBLOCKING = ['working', 'quiet', 'unknown'] as const;
const NATIVE_ADVISORY = ['working', 'quiet', 'unknown', 'gated'] as const;
const PROMPTS = ['none', 'permission', 'login', 'trust', 'question', 'other'] as const;
const COVERAGE = ['full', 'partial'] as const;
const EXITS = ['running', 'clean', 'abnormal', 'unknown'] as const;
const CONFIRMATION = ['not_requested', 'needed'] as const;
const CONTINUITY = ['proven', 'unproven'] as const;

export type Health = (typeof HEALTH)[number];
export type Nonblocking = (typeof NONBLOCKING)[number];
export type PromptClass = (typeof PROMPTS)[number];
export type PromptCoverage = (typeof COVERAGE)[number];
export type ExitFact = (typeof EXITS)[number];
export type WinningSource = 'native' | 'host' | 'screen' | 'none';
export type ShownAdvisory = 'working' | 'quiet' | 'unknown' | 'gated';
export type ExitRepresentation = 'unproven' | 'confirmation-needed' | 'exited' | 'unreachable' | 'unconfirmed';

export type ArbitrationReason =
  | 'malformed'
  | 'unsupported'
  | 'context_mismatch'
  | 'native_advisory'
  | 'native_quiet'
  | 'native_gate'
  | 'gate_preserved'
  | 'host_fallback'
  | 'screen_fallback'
  | 'none_usable'
  | 'screen_refined_quiet'
  | 'screen_refined_partial_working'
  | 'prompt_classified'
  | 'continuity_unproven'
  | 'process_stale'
  | 'process_mismatch'
  | 'clean_exit'
  | 'abnormal_exit'
  | 'exit_unknown'
  | 'exit_blocked_by_gate'
  | 'session_end_unconfirmed';

export type ArbitrationView = {
  readonly context: { readonly seatId: string; readonly incarnation: string } | null;
  readonly source: WinningSource;
  readonly advisory: ShownAdvisory;
  readonly gate: PermissionGate | null;
  readonly prompt: PromptClass;
  readonly promptCoverage: PromptCoverage;
  readonly exit: ExitRepresentation;
  readonly disagreement: ArbitrationReason | null;
  readonly processFence: number | null;
};

export type ArbitrationDecision = {
  readonly view: ArbitrationView;
  readonly reason: ArbitrationReason;
  readonly applied: boolean;
};

type Identity = { readonly seatId: string; readonly incarnation: string };

type NativeSnap = {
  readonly identity: Identity;
  readonly health: Health;
  readonly continuity: Continuity;
  readonly advisory: ShownAdvisory;
  readonly gate: PermissionGate | null;
  readonly processConfirmation: ProcessConfirmation;
  readonly promptCoverage: PromptCoverage;
};

type HostSnap = {
  readonly identity: Identity;
  readonly health: Health;
  readonly advisory: Nonblocking;
  readonly prompt: PromptClass;
};

type ScreenSnap = HostSnap & { readonly current: boolean };

type ProcessSnap = {
  readonly identity: Identity;
  readonly processId: string;
  readonly expectedProcessId: string;
  readonly fence: number;
  readonly exit: ExitFact;
};

type Snapshot = {
  readonly context: Identity;
  readonly native: NativeSnap | null;
  readonly host: HostSnap | null;
  readonly screen: ScreenSnap | null;
  readonly process: ProcessSnap | null;
};

type Parsed = { readonly ok: true; readonly snapshot: Snapshot } | { readonly ok: false; readonly reason: 'malformed' | 'unsupported' };

/** An empty selection. Context arrives only from a later snapshot. */
export function initialArbitration(): ArbitrationView {
  return {
    context: null,
    source: 'none',
    advisory: 'unknown',
    gate: null,
    prompt: 'none',
    promptCoverage: 'full',
    exit: 'unproven',
    disagreement: null,
    processFence: null,
  };
}

/** Selects one view from explicit native, host, screen, and process snapshots. */
export function arbitrateSources(current: ArbitrationView, input: unknown): ArbitrationDecision {
  const parsed = parseSnapshot(input);
  if (!parsed.ok) return held(current, parsed.reason);
  const snapshot = parsed.snapshot;
  if (
    current.context !== null &&
    (snapshot.context.seatId !== current.context.seatId ||
      snapshot.context.incarnation !== current.context.incarnation)
  ) {
    return held(current, 'context_mismatch');
  }
  const selected = select(current, snapshot);
  if (sameView(current, selected.view)) return { view: current, reason: selected.reason, applied: false };
  return { view: selected.view, reason: selected.reason, applied: true };
}

function held(view: ArbitrationView, reason: ArbitrationReason): ArbitrationDecision {
  return { view, reason, applied: false };
}

function select(current: ArbitrationView, snapshot: Snapshot): ArbitrationDecision {
  const native = matches(snapshot.native, snapshot.context) ? snapshot.native : null;
  const host = matches(snapshot.host, snapshot.context) ? snapshot.host : null;
  const screen = matches(snapshot.screen, snapshot.context) ? snapshot.screen : null;
  const gate = native !== null ? native.gate : copyGate(current.gate);
  const coverage = native?.promptCoverage ?? current.promptCoverage;
  let source: WinningSource = 'none';
  let advisory: ShownAdvisory = 'unknown';
  let prompt: PromptClass = 'none';
  let disagreement: ArbitrationReason | null = null;
  let reason: ArbitrationReason = 'none_usable';

  if (gate !== null) {
    source = 'native';
    advisory = 'gated';
    reason = 'native_gate';
    if (screen !== null && screen.health === 'healthy' && screen.current && screen.prompt !== 'none') {
      prompt = screen.prompt;
      disagreement = 'prompt_classified';
      reason = 'gate_preserved';
    }
  } else if (nativeWins(native)) {
    source = 'native';
    advisory = native.advisory === 'working' ? 'working' : 'quiet';
    reason = advisory === 'quiet' ? 'native_quiet' : 'native_advisory';
    if (screen !== null) {
      const refined = refine(native, screen);
      if (refined !== null) {
        source = 'screen';
        prompt = screen.prompt;
        disagreement = refined;
        reason = refined;
      }
    }
  } else {
    if (native !== null && native.health === 'healthy' && native.continuity === 'unproven') {
      disagreement = 'continuity_unproven';
    }
    if (host !== null && host.health === 'healthy' && host.advisory !== 'unknown') {
      source = 'host';
      advisory = host.advisory;
      prompt = host.prompt;
      reason = 'host_fallback';
    } else if (screen !== null && screen.health === 'healthy' && screen.advisory !== 'unknown') {
      source = 'screen';
      advisory = screen.advisory;
      prompt = screen.current ? screen.prompt : 'none';
      reason = 'screen_fallback';
    } else {
      source = 'none';
      advisory = 'unknown';
      reason = disagreement === 'continuity_unproven' ? 'continuity_unproven' : 'none_usable';
    }
  }

  const process = applyProcess(current, snapshot, native, gate);
  if (process.reason !== null) reason = process.reason;
  if (gate === null && (process.exit === 'exited' || process.exit === 'unreachable' || process.exit === 'unconfirmed')) {
    advisory = 'unknown';
    prompt = 'none';
    source = 'host';
  }
  if (
    native !== null &&
    native.processConfirmation === 'needed' &&
    gate === null &&
    process.exit !== 'exited' &&
    process.exit !== 'unreachable' &&
    process.exit !== 'unconfirmed'
  ) {
    advisory = 'unknown';
    prompt = 'none';
    source = native.health === 'healthy' ? 'native' : source;
    reason = 'session_end_unconfirmed';
  }

  return {
    view: {
      context: { seatId: snapshot.context.seatId, incarnation: snapshot.context.incarnation },
      source,
      advisory,
      gate: copyGate(gate),
      prompt,
      promptCoverage: coverage,
      exit: process.exit,
      disagreement,
      processFence: process.fence,
    },
    reason,
    applied: true,
  };
}

function nativeWins(native: NativeSnap | null): native is NativeSnap & { readonly advisory: 'working' | 'quiet' } {
  return (
    native !== null &&
    native.health === 'healthy' &&
    native.continuity === 'proven' &&
    (native.advisory === 'working' || native.advisory === 'quiet')
  );
}

function refine(native: NativeSnap, screen: ScreenSnap): ArbitrationReason | null {
  if (screen.health !== 'healthy' || !screen.current || screen.prompt === 'none') return null;
  if (native.advisory === 'quiet') return 'screen_refined_quiet';
  if (native.advisory === 'working' && native.promptCoverage === 'partial') return 'screen_refined_partial_working';
  return null;
}

function applyProcess(
  current: ArbitrationView,
  snapshot: Snapshot,
  native: NativeSnap | null,
  gate: PermissionGate | null,
): { readonly exit: ExitRepresentation; readonly fence: number | null; readonly reason: ArbitrationReason | null } {
  const confirmationNeeded = native !== null && native.processConfirmation === 'needed';
  const supplied = snapshot.process;
  if (supplied === null) {
    return {
      exit: confirmationNeeded ? 'confirmation-needed' : 'unproven',
      fence: current.processFence,
      reason: confirmationNeeded ? 'session_end_unconfirmed' : null,
    };
  }
  if (
    supplied.identity.seatId !== snapshot.context.seatId ||
    supplied.identity.incarnation !== snapshot.context.incarnation ||
    supplied.processId !== supplied.expectedProcessId
  ) {
    return {
      exit: confirmationNeeded && current.exit !== 'exited' ? 'confirmation-needed' : current.exit,
      fence: current.processFence,
      reason: confirmationNeeded && current.exit !== 'exited' ? 'session_end_unconfirmed' : 'process_mismatch',
    };
  }
  if (current.processFence !== null && supplied.fence <= current.processFence) {
    return {
      exit: current.exit,
      fence: current.processFence,
      reason: 'process_stale',
    };
  }
  if (supplied.exit === 'running') {
    return {
      exit: confirmationNeeded ? 'confirmation-needed' : 'unproven',
      fence: supplied.fence,
      reason: confirmationNeeded ? 'session_end_unconfirmed' : null,
    };
  }
  if (supplied.exit === 'clean') {
    if (gate !== null) {
      return { exit: 'confirmation-needed', fence: supplied.fence, reason: 'exit_blocked_by_gate' };
    }
    return { exit: 'exited', fence: supplied.fence, reason: 'clean_exit' };
  }
  if (supplied.exit === 'abnormal') {
    return { exit: 'unreachable', fence: supplied.fence, reason: 'abnormal_exit' };
  }
  return { exit: 'unconfirmed', fence: supplied.fence, reason: 'exit_unknown' };
}

function matches<T extends { readonly identity: Identity }>(tier: T | null, context: Identity): tier is T {
  return tier !== null && tier.identity.seatId === context.seatId && tier.identity.incarnation === context.incarnation;
}

function copyGate(gate: PermissionGate | null): PermissionGate | null {
  if (gate === null) return null;
  return {
    gateId: gate.gateId,
    toolId: gate.toolId,
    mainTurn: gate.mainTurn,
    binding: gate.binding,
    ownerRequired: true,
  };
}

function sameView(left: ArbitrationView, right: ArbitrationView): boolean {
  return (
    left.source === right.source &&
    left.advisory === right.advisory &&
    left.prompt === right.prompt &&
    left.promptCoverage === right.promptCoverage &&
    left.exit === right.exit &&
    left.disagreement === right.disagreement &&
    left.processFence === right.processFence &&
    left.context?.seatId === right.context?.seatId &&
    left.context?.incarnation === right.context?.incarnation &&
    left.gate?.gateId === right.gate?.gateId &&
    left.gate?.toolId === right.gate?.toolId &&
    left.gate?.mainTurn === right.gate?.mainTurn &&
    left.gate?.binding === right.gate?.binding &&
    (left.gate === null) === (right.gate === null)
  );
}

function parseSnapshot(input: unknown): Parsed {
  if (!isRecord(input) || !exactKeys(input, ['context', 'native', 'host', 'screen', 'process'])) {
    return { ok: false, reason: 'malformed' };
  }
  if (!isRecord(input.context) || !exactKeys(input.context, ['seatId', 'incarnation'])) {
    return { ok: false, reason: 'malformed' };
  }
  const context = parseIdentity(input.context);
  if (context === 'bad') return { ok: false, reason: 'malformed' };
  const native = parseNative(input.native);
  const host = parseHost(input.host);
  const screen = parseScreen(input.screen);
  const process = parseProcess(input.process);
  if (native === 'bad' || host === 'bad' || screen === 'bad' || process === 'bad') {
    return { ok: false, reason: 'malformed' };
  }
  if (native === 'unsupported' || host === 'unsupported' || screen === 'unsupported' || process === 'unsupported') {
    return { ok: false, reason: 'unsupported' };
  }
  return { ok: true, snapshot: { context, native, host, screen, process } };
}

function parseNative(value: unknown): NativeSnap | null | 'bad' | 'unsupported' {
  if (value === null) return null;
  if (!isRecord(value)) return 'bad';
  if (!exactKeys(value, ['seatId', 'incarnation', 'health', 'continuity', 'advisory', 'gate', 'processConfirmation', 'promptCoverage'])) {
    return 'bad';
  }
  const identity = parseIdentity(value);
  if (identity === 'bad') return 'bad';
  const health = enumOf(value.health, HEALTH);
  const continuity = enumOf(value.continuity, CONTINUITY);
  const advisory = enumOf(value.advisory, NATIVE_ADVISORY);
  const coverage = enumOf(value.promptCoverage, COVERAGE);
  const confirmation = enumOf(value.processConfirmation, CONFIRMATION);
  if ([health, continuity, advisory, coverage, confirmation].includes('bad')) return 'bad';
  if ([health, continuity, advisory, coverage, confirmation].includes('unsupported')) return 'unsupported';
  const gate = parseGate(value.gate);
  if (gate === 'bad') return 'bad';
  if ((advisory === 'gated') !== (gate !== null)) return 'bad';
  return {
    identity,
    health: health as Health,
    continuity: continuity as Continuity,
    advisory: advisory as ShownAdvisory,
    gate,
    processConfirmation: confirmation as ProcessConfirmation,
    promptCoverage: coverage as PromptCoverage,
  };
}

function parseHost(value: unknown): HostSnap | null | 'bad' | 'unsupported' {
  if (value === null) return null;
  if (!isRecord(value)) return 'bad';
  if (!exactKeys(value, ['seatId', 'incarnation', 'health', 'advisory', 'prompt'])) return 'bad';
  return finishTier(value);
}

function parseScreen(value: unknown): ScreenSnap | null | 'bad' | 'unsupported' {
  if (value === null) return null;
  if (!isRecord(value)) return 'bad';
  if (!exactKeys(value, ['seatId', 'incarnation', 'health', 'advisory', 'prompt', 'current'])) return 'bad';
  if (typeof value.current !== 'boolean') return 'bad';
  const tier = finishTier(value);
  if (tier === 'bad' || tier === 'unsupported' || tier === null) return tier;
  return { ...tier, current: value.current };
}

function finishTier(value: Record<string, unknown>): HostSnap | 'bad' | 'unsupported' {
  const identity = parseIdentity(value);
  if (identity === 'bad') return 'bad';
  const health = enumOf(value.health, HEALTH);
  const advisory = enumOf(value.advisory, NONBLOCKING);
  const prompt = enumOf(value.prompt, PROMPTS);
  if ([health, advisory, prompt].includes('bad')) return 'bad';
  if ([health, advisory, prompt].includes('unsupported')) return 'unsupported';
  return { identity, health: health as Health, advisory: advisory as Nonblocking, prompt: prompt as PromptClass };
}

function parseProcess(value: unknown): ProcessSnap | null | 'bad' | 'unsupported' {
  if (value === null) return null;
  if (!isRecord(value)) return 'bad';
  if (!exactKeys(value, ['seatId', 'incarnation', 'processId', 'expectedProcessId', 'fence', 'exit'])) return 'bad';
  const identity = parseIdentity(value);
  if (identity === 'bad' || !isToken(value.processId) || !isToken(value.expectedProcessId)) return 'bad';
  if (typeof value.fence !== 'number' || !Number.isSafeInteger(value.fence) || value.fence < 0) return 'bad';
  const exit = enumOf(value.exit, EXITS);
  if (exit === 'bad') return 'bad';
  if (exit === 'unsupported') return 'unsupported';
  return {
    identity,
    processId: value.processId,
    expectedProcessId: value.expectedProcessId,
    fence: value.fence,
    exit: exit as ExitFact,
  };
}

function parseGate(value: unknown): PermissionGate | null | 'bad' {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['gateId', 'toolId', 'mainTurn', 'binding', 'ownerRequired'])) return 'bad';
  if (!isToken(value.gateId) || !isToken(value.toolId) || !isToken(value.mainTurn) || !isToken(value.binding)) return 'bad';
  if (value.ownerRequired !== true) return 'bad';
  return {
    gateId: value.gateId,
    toolId: value.toolId,
    mainTurn: value.mainTurn,
    binding: value.binding,
    ownerRequired: true,
  };
}

function parseIdentity(value: unknown): Identity | 'bad' {
  if (!isRecord(value) || !isToken(value.seatId) || !isToken(value.incarnation)) return 'bad';
  return { seatId: value.seatId, incarnation: value.incarnation };
}

function enumOf(value: unknown, allowed: readonly string[]): string | 'bad' | 'unsupported' {
  if (typeof value !== 'string') return 'bad';
  if (allowed.includes(value)) return value;
  return isToken(value) ? 'unsupported' : 'bad';
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}
