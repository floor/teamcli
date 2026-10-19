// Narrow reusable Codex (`0.161.0`) relay adapter bridge for the committed sender walk
// (`785d63e1f`, `src/commands/send.ts` + `src/send/fallback-walk.ts` + `packages/relay`).
//
// Invariants enforced here:
//   - Accepts already-resolved shared policy/timing budgets from `src/policy/delivery.ts`
//     (`DeliveryTimeoutInForce`, `DeliveryEscalationDelay`, `DELIVERY_RECEIPT_SECONDS`,
//     `receiptSecondsFor`) and `src/policy/types.ts` (`DELIVERY_TIMEOUT_DEFAULTS.native`).
//     Never re-parses policy YAML or introduces a second independent timeout resolver.
//   - Resolves signed `deliveryTimeout` first, fails closed on `{ ok: false }`, and clamps any
//     optional `timeoutMs` override so it can only shorten (never lengthen or bypass) the signed
//     `native` budget.
//   - Deducts elapsed preparation time (durable staging + local policy/session pre-validation)
//     from the overall `native` attempt deadline and passes only the remaining budget to
//     `codex queue`.
//   - Uses `B7`'s shared `recordedSeatSession` (`src/registry/resume.ts`) for trusted session
//     binding and `resolveCodexDaemonPolicy` (`src/policy/codex-daemon.ts`) for `codex-daemon`
//     (`on | off`) verification via `probeCodexNativeRoute`, which `deliverCodexNativeRoute`
//     calls directly.
//   - Stages the durable signed copy via `stage` from `packages/relay/index.js` (create-or-match,
//     mode `0600`, no-follow) before invoking `codex queue`, preserving one `message.id` and
//     `record` across route fallbacks.
//   - Forwards only the opaque single-line `pointer` built by `pushPointer(id, sender)` — never
//     parses `message.record` and never touches the message body.
//   - Preserves `enqueue != delivered (read)`: `codex queue` exit `0` returns `outcome: 'enqueue'`
//     (daemon queue acceptance transport only, `receipt: { kind: 'maybe-consumed' }` on the
//     fallback-walk transport fact). Signed `<id>.read.json` receipt verification and user-facing
//     `read` vs `sent (unconfirmed)` classification stay in `src/commands/send.ts` (`B1`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  stage as relayStage,
  type CopyTarget,
  type RelayReceipt as PackageRelayReceipt,
} from '../../../packages/relay/index.js';
import {
  resolveCodexDaemonPolicy,
  type CodexDaemonResolution,
  type CodexDaemonValue,
} from '../../policy/codex-daemon.ts';
import {
  DELIVERY_RECEIPT_SECONDS,
  receiptSecondsFor,
  type DeliveryEscalationDelay,
  type DeliveryTimeoutInForce,
} from '../../policy/delivery.ts';
import {
  DELIVERY_ESCALATION_SECONDS,
  DELIVERY_TIMEOUT_DEFAULTS,
  type DeliveryTimeoutRoute,
} from '../../policy/types.ts';
import {
  recordedSeatSession,
  type RecordedSeatSession,
  type RecordedSeatSessionRead,
} from '../../registry/resume.ts';
import { readState, type SeatState } from '../../state.ts';
import type { AttemptOutcome, RelayReceipt as WalkRelayReceipt } from '../fallback-events.ts';
import type { WalkAttempt } from '../fallback-walk.ts';
import { TRIGGER_MAX } from '../native.ts';
import {
  pushPointer,
  type PushSender,
  type RuntimePushAdapter,
  type RuntimePushOutcome,
} from '../push.ts';
import {
  CODEX_DAEMON_OFF_REASON,
  codexPushAdapter,
  isValidCodexRemote,
  type CodexSpawn,
} from './codex.ts';

/** Canonical route name in `DELIVERY_LEGS` and `DELIVERY_TIMEOUT_ROUTES`. */
export const CODEX_NATIVE_ROUTE = 'native' as const;

/** Default attempt budget for the `native` route in milliseconds (`15_000` ms from `DELIVERY_TIMEOUT_DEFAULTS.native`). */
export const CODEX_NATIVE_TIMEOUT_MS = DELIVERY_TIMEOUT_DEFAULTS.native * 1000;

/** Post-submit read-receipt `--wait` window in seconds (`120` s from `DELIVERY_RECEIPT_SECONDS`). */
export const CODEX_RECEIPT_TIMEOUT_SECONDS = DELIVERY_RECEIPT_SECONDS;

export { receiptSecondsFor };

export type CodexRelayCapabilities = {
  runtime: 'codex';
  version: string;
  routes: readonly ['native', 'durable-copy'];
  native: {
    supported: true;
    command: readonly ['codex', 'queue', '--thread', '<agent_session>', '--message', '<pointer>'];
    timeoutMs: number;
    liveProbe: false;
    precheck: 'local-policy-and-session-only';
    ack: false;
    proof: 'queue-accepted-only';
  };
  durableCopy: {
    supported: true;
  };
  limitations: readonly string[];
};

/**
 * Pure, synchronous, zero-I/O capability descriptor for the Codex (`0.161.0`) relay bridge.
 */
export function codexRelayCapabilities(version = '0.161.0'): CodexRelayCapabilities {
  return {
    runtime: 'codex',
    version,
    routes: ['native', 'durable-copy'],
    native: {
      supported: true,
      command: ['codex', 'queue', '--thread', '<agent_session>', '--message', '<pointer>'],
      timeoutMs: CODEX_NATIVE_TIMEOUT_MS,
      liveProbe: false,
      precheck: 'local-policy-and-session-only',
      ack: false,
      proof: 'queue-accepted-only',
    },
    durableCopy: {
      supported: true,
    },
    limitations: [
      'Codex 0.161.0 has no live readiness/accepts/held preprobe RPC; probeCodexNativeRoute performs synchronous local validation only (codex-daemon policy, bound recordedSeatSession thread UUID, single-line pointer, and optional --remote URL).',
      'Requires codex-daemon: on and a bound recordedSeatSession (team.state.json + agents/<id>.yaml); fails closed when codex-daemon is off (seat launched with --no-daemon) or when policy/session binding cannot be verified.',
      'codex queue exit 0 proves daemon queue acceptance (transport only, receipt: maybe-consumed), never receiver turn consumption or read confirmation; signed <id>.read.json verification stays in the sender walk (send.ts).',
    ],
  };
}

/**
 * Resolves the signed `DeliveryTimeoutInForce` (from `deliveryTimeoutInForce` in
 * `src/policy/delivery.ts`), a route-budget map (`seconds`), or a milliseconds number first,
 * rejects any failed signed result (`{ ok: false }`), and then clamps any optional
 * `overrideTimeoutMs` so an override can only shorten (never lengthen or bypass) the signed
 * `native` attempt budget.
 */
export type ResolvedCodexAttemptBudget =
  | { ok: true; timeoutMs: number; attemptSeconds: number }
  | { ok: false; why: string };

export function resolveCodexNativeAttemptTimeoutMs(
  resolved?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number,
  overrideTimeoutMs?: number,
): ResolvedCodexAttemptBudget {
  let baseTimeoutMs = CODEX_NATIVE_TIMEOUT_MS;
  let baseAttemptSeconds: number = DELIVERY_TIMEOUT_DEFAULTS.native;

  if (resolved !== undefined) {
    if (typeof resolved === 'number') {
      if (!Number.isFinite(resolved) || resolved <= 0) {
        return { ok: false, why: 'the native attempt timeout budget must be above 0ms' };
      }
      baseTimeoutMs = Math.round(resolved);
      baseAttemptSeconds = Math.max(1, Math.ceil(baseTimeoutMs / 1000));
    } else if ('ok' in resolved) {
      if (!resolved.ok) {
        return { ok: false, why: resolved.why };
      }
      const seconds = resolved.budgets.native;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: 'the resolved "delivery-timeout" map has no valid native budget' };
      }
      baseTimeoutMs = Math.round(seconds * 1000);
      baseAttemptSeconds = seconds;
    } else {
      const seconds = resolved.native ?? DELIVERY_TIMEOUT_DEFAULTS.native;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: 'the native attempt timeout budget must be above 0s' };
      }
      baseTimeoutMs = Math.round(seconds * 1000);
      baseAttemptSeconds = seconds;
    }
  }

  if (overrideTimeoutMs !== undefined) {
    if (typeof overrideTimeoutMs !== 'number' || !Number.isFinite(overrideTimeoutMs) || overrideTimeoutMs <= 0) {
      return { ok: false, why: 'the native attempt timeout override must be above 0ms' };
    }
    const clampedTimeoutMs = Math.min(baseTimeoutMs, Math.round(overrideTimeoutMs));
    return {
      ok: true,
      timeoutMs: clampedTimeoutMs,
      attemptSeconds: Math.min(baseAttemptSeconds, Math.max(1, Math.ceil(clampedTimeoutMs / 1000))),
    };
  }

  return {
    ok: true,
    timeoutMs: baseTimeoutMs,
    attemptSeconds: baseAttemptSeconds,
  };
}

/**
 * Accepts an already-resolved `DeliveryEscalationDelay` (from `deliveryEscalationDelay` in
 * `src/policy/delivery.ts`) or seconds number without re-parsing policy files.
 */
export function resolveCodexEscalationSeconds(
  resolved?: DeliveryEscalationDelay | number,
): { ok: true; seconds: number } | { ok: false; why: string } {
  if (resolved === undefined) {
    return { ok: true, seconds: DELIVERY_ESCALATION_SECONDS };
  }
  if (typeof resolved === 'number') {
    if (!Number.isFinite(resolved) || resolved <= 0) {
      return { ok: false, why: 'the delivery escalation delay must be above 0s' };
    }
    return { ok: true, seconds: resolved };
  }
  if (!resolved.ok) {
    return { ok: false, why: resolved.why };
  }
  return { ok: true, seconds: resolved.seconds };
}

export type CodexNativeTarget = {
  route: 'native';
  runtime: 'codex';
  copy: CopyTarget;
  root: string;
  home: string;
  session: string;
  seat: string;
  sender: PushSender;
  /** Optional caller-supplied runtime session id; must match the bound `recordedSeatSession`. */
  agentSession?: string | null;
  /** Optional explicit `codex queue --remote <ADDR>` endpoint (`ws://`, `wss://`, or `unix://`). */
  remote?: string;
};

export type CodexNativeMessage = {
  id: string;
  /** The opaque signed record JSON text to stage at `target.copy`. Never parsed by the bridge. */
  record: string;
  /**
   * Optional pre-built single-line pointer (`pushPointer(id, sender)`). When omitted, built from
   * `message.id` and `target.sender` via `pushPointer`.
   */
  pointer?: string;
};

export type CodexNativeProbeInput = {
  root: string;
  home: string;
  session: string;
  seat: string;
  id: string;
  sender: PushSender;
  pointer?: string | null;
  agentSession?: string | null;
  remote?: string;
  /** Optional already-resolved `codex-daemon` policy from `resolveCodexDaemonPolicy`. */
  codexDaemon?: CodexDaemonResolution | CodexDaemonValue;
  /** Optional already-resolved session binding from `recordedSeatSession`. */
  sessionBinding?: RecordedSeatSessionRead;
};

export type CodexNativeProbeOutcome =
  | {
      status: 'ready';
      threadId: string;
      pointer: string;
      recorded: RecordedSeatSession;
    }
  | {
      status: 'unavailable' | 'refused';
      reason: string;
    };

/**
 * Synchronous local policy/session/pointer validation for the Codex `native` route (zero
 * child-process spawn): verifies `codex-daemon` signed policy (`on`), bound `recordedSeatSession`
 * (`src/registry/resume.ts`), opaque single-line pointer (`pushPointer`), and optional `--remote`
 * address.
 *
 * Does not probe live daemon/thread accepts/held state and does not enforce a 400ms live probe
 * timer. Called directly by `deliverCodexNativeRoute` before spawning `codex queue`.
 */
export function probeCodexNativeRoute(input: CodexNativeProbeInput): CodexNativeProbeOutcome {
  if (input.codexDaemon !== undefined) {
    if (typeof input.codexDaemon === 'object' && input.codexDaemon !== null) {
      if (!input.codexDaemon.ok) {
        return {
          status: 'unavailable',
          reason: `codex-daemon policy could not be verified (${input.codexDaemon.why})`,
        };
      }
      if (input.codexDaemon.value === 'off') {
        return { status: 'unavailable', reason: CODEX_DAEMON_OFF_REASON };
      }
    } else if (input.codexDaemon === 'off') {
      return { status: 'unavailable', reason: CODEX_DAEMON_OFF_REASON };
    }
  } else {
    const policy = resolveCodexDaemonPolicy({
      home: input.home,
      root: input.root,
      seat: input.seat,
      session: input.session,
    });
    if (!policy.ok) {
      return {
        status: 'unavailable',
        reason: `codex-daemon policy could not be verified (${policy.why})`,
      };
    }
    if (policy.value === 'off') {
      return { status: 'unavailable', reason: CODEX_DAEMON_OFF_REASON };
    }
  }

  if (input.remote !== undefined && !isValidCodexRemote(input.remote)) {
    return {
      status: 'refused',
      reason: 'the configured codex remote endpoint is not a valid ws://, wss://, or unix:// address',
    };
  }

  const pointer = input.pointer !== undefined ? input.pointer : pushPointer(input.id, input.sender);
  if (
    pointer === null
    || pointer === ''
    || pointer.includes('\n')
    || pointer.includes('\r')
    || pointer.includes('\0')
    || pointer.length > TRIGGER_MAX
  ) {
    return {
      status: 'refused',
      reason:
        pointer === null || pointer.length > TRIGGER_MAX
          ? `the pointer would exceed ${String(TRIGGER_MAX)} characters`
          : 'the runtime pointer is not a valid single line',
    };
  }

  let binding = input.sessionBinding;
  if (binding === undefined) {
    const dir = join(input.root, '.agents');
    let state: SeatState | undefined;
    if (existsSync(join(dir, 'team.state.json'))) {
      try {
        state = readState(dir).sessions[input.session]?.seats[input.seat];
      } catch {
        return {
          status: 'unavailable',
          reason: 'no trusted runtime session is recorded for this seat (seat state could not be read)',
        };
      }
    }
    binding = recordedSeatSession({
      home: input.home,
      root: input.root,
      herdrSession: input.session,
      seat: { name: input.seat, cli: 'codex' },
      state,
    });
  }

  if (binding.kind !== 'bound') {
    return {
      status: binding.kind === 'refused' ? 'refused' : 'unavailable',
      reason:
        binding.kind === 'none' && binding.why === 'no agent record for this seat' && input.agentSession === null
          ? 'no runtime session is recorded for this seat'
          : `no trusted runtime session is recorded for this seat (${binding.why})`,
    };
  }

  if (binding.recorded.cli !== 'codex') {
    return {
      status: 'refused',
      reason: `the recorded session belongs to CLI "${binding.recorded.cli}", not "codex"`,
    };
  }

  const threadId = binding.recorded.sessionId.trim();
  if (threadId === '') {
    return {
      status: 'unavailable',
      reason: 'no runtime session is recorded for this seat',
    };
  }
  if (threadId.startsWith('-') || /[\s\0]/.test(threadId)) {
    return {
      status: 'refused',
      reason: 'the recorded runtime session is not a valid thread id',
    };
  }
  if (
    input.agentSession !== undefined
    && input.agentSession !== null
    && input.agentSession.trim() !== ''
    && input.agentSession.trim() !== threadId
  ) {
    return {
      status: 'refused',
      reason: 'the seat state and the agent record name different sessions',
    };
  }

  return {
    status: 'ready',
    threadId,
    pointer,
    recorded: binding.recorded,
  };
}

export type CodexNativeDeliverOptions = {
  /** Clock function (TeamCLI passes `host.now`); defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Already-resolved `delivery-timeout` budget from `deliveryTimeoutInForce` (`src/policy/delivery.ts`),
   * a route-budget map in seconds, or an explicit `timeoutMs` number.
   */
  deliveryTimeout?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number;
  /**
   * Optional explicit attempt timeout override in milliseconds. Clamped to `deliveryTimeout` so an
   * override can only shorten (never lengthen or bypass) the signed `delivery-timeout` budget.
   */
  timeoutMs?: number;
  /** Optional already-resolved `codex-daemon` policy (`resolveCodexDaemonPolicy`). */
  codexDaemon?: CodexDaemonResolution | CodexDaemonValue;
  /** Optional already-resolved session binding (`recordedSeatSession`). */
  sessionBinding?: RecordedSeatSessionRead;
  /**
   * Whether routes still stand after `native` in the delivery walk (`liveRoutesAfter(walk, at)`),
   * carried onto the returned `walkAttempt`. Defaults to `true`.
   */
  liveRoutesRemain?: boolean;
  /**
   * Optional start timestamp (`startedAt` in `runSend`) used to compute `walkAttempt.ms`.
   * Defaults to `now().getTime()` at the start of `deliverCodexNativeRoute`.
   */
  startedAt?: number;
  /**
   * When true, skips calling `relayStage` (used when the caller already staged the record under
   * the seat lock immediately prior to this call).
   */
  skipStage?: boolean;
  /** Optional injected `RuntimePushAdapter` (or `spawn` / `binary` for `codexPushAdapter`). */
  adapter?: RuntimePushAdapter;
  binary?: string;
  spawn?: CodexSpawn;
};

export type CodexNativeAttempt =
  | {
      route: 'native';
      /**
       * `enqueue` means `codex queue` exited `0` and accepted the pointer into the daemon queue.
       * It is transport queue acceptance only — never `read` or `delivered (read)` until a signed
       * `<id>.read.json` receipt verifies in `src/commands/send.ts`.
       */
      outcome: 'enqueue';
      receipt: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    }
  | {
      route: 'native';
      outcome: 'unsupported' | 'unreachable' | 'refused';
      reason: string;
      timedOut?: boolean;
      receipt?: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    };

function buildWalkAttempt(
  outcome: AttemptOutcome,
  liveRoutesRemain: boolean,
  at: Date,
  startedAt: number,
  reason: string,
  receipt: WalkRelayReceipt,
): WalkAttempt {
  return {
    route: CODEX_NATIVE_ROUTE,
    outcome,
    liveRoutesRemain,
    at,
    ms: Math.max(0, at.getTime() - startedAt),
    reason,
    receipt,
  };
}

/**
 * Makes one bounded Codex `native` (`codex queue`) attempt against the committed sender walk
 * (`785d63e1f`):
 *   1. Resolves the caller-supplied `delivery-timeout` (`native`) budget first, rejects any failed
 *      signed budget, and clamps any optional `timeoutMs` override to it.
 *   2. Stages (or verifies create-or-match) the signed record via `stage` from
 *      `packages/relay/index.js` so the durable copy is on disk under the same `message.id`
 *      before the transport attempt.
 *   3. Runs synchronous local policy/session/pointer pre-validation via `probeCodexNativeRoute`
 *      (`resolveCodexDaemonPolicy` + `recordedSeatSession` + `pushPointer`).
 *   4. Deducts elapsed preparation time (staging + pre-validation) from the overall attempt budget
 *      and passes only the remaining `remainingTimeoutMs` budget to `codex queue`.
 *   5. Returns both the `@teamcli/relay` receipt and the exact `WalkAttempt` for `FallbackWalk.note`
 *      (`receipt: { kind: 'maybe-consumed' }` on queue-accepted `exit 0`; signed `<id>.read.json`
 *      receipt verification stays in `src/commands/send.ts`).
 */
export async function deliverCodexNativeRoute(
  target: CodexNativeTarget,
  message: CodexNativeMessage,
  options: CodexNativeDeliverOptions = {},
): Promise<CodexNativeAttempt> {
  const nowFn = options.now ?? (() => new Date());
  const attemptStartedAtMs = nowFn().getTime();
  const startedAt = options.startedAt ?? attemptStartedAtMs;
  const liveRoutesRemain = options.liveRoutesRemain ?? true;

  const budget = resolveCodexNativeAttemptTimeoutMs(options.deliveryTimeout, options.timeoutMs);
  if (!budget.ok) {
    const at = nowFn();
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unsupported',
      reason: budget.why,
      walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, budget.why, {
        kind: 'unknown',
      }),
    };
  }

  let copyReceipt: PackageRelayReceipt;
  if (options.skipStage === true) {
    copyReceipt = {
      copy: join(target.copy.dir, target.copy.name),
      at: nowFn().toISOString(),
    };
  } else {
    const staged = await relayStage(
      target.copy,
      { id: message.id, record: message.record },
      { now: nowFn },
    );
    if (staged.outcome === 'refused') {
      const at = nowFn();
      return {
        route: CODEX_NATIVE_ROUTE,
        outcome: 'refused',
        reason: staged.reason,
        ...(staged.receipt === undefined ? {} : { receipt: staged.receipt }),
        walkAttempt: buildWalkAttempt('refused', false, at, startedAt, staged.reason, {
          kind: 'unknown',
        }),
      };
    }
    copyReceipt = staged.receipt;
  }

  const precheck = probeCodexNativeRoute({
    root: target.root,
    home: target.home,
    session: target.session,
    seat: target.seat,
    id: message.id,
    sender: target.sender,
    ...(message.pointer !== undefined ? { pointer: message.pointer } : {}),
    ...(target.agentSession !== undefined ? { agentSession: target.agentSession } : {}),
    ...(target.remote !== undefined ? { remote: target.remote } : {}),
    ...(options.codexDaemon !== undefined ? { codexDaemon: options.codexDaemon } : {}),
    ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
  });
  if (precheck.status !== 'ready') {
    const at = nowFn();
    const outcome = precheck.status === 'refused' ? 'unsupported' : 'unreachable';
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome,
      reason: precheck.reason,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt(
        'unreachable',
        liveRoutesRemain,
        at,
        startedAt,
        precheck.reason,
        { kind: 'stored', id: message.id },
      ),
    };
  }

  const elapsedMs = Math.max(0, nowFn().getTime() - attemptStartedAtMs);
  const remainingTimeoutMs = budget.timeoutMs - elapsedMs;
  if (remainingTimeoutMs <= 0) {
    const at = nowFn();
    const reason = `codex queue timed out before spawn (${String(budget.timeoutMs)}ms attempt budget exhausted during preparation)`;
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unreachable',
      reason,
      timedOut: true,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt(
        'timeout',
        liveRoutesRemain,
        at,
        startedAt,
        reason,
        { kind: 'stored', id: message.id },
      ),
    };
  }

  const adapter =
    options.adapter
    ?? codexPushAdapter({
      ...(options.binary !== undefined ? { binary: options.binary } : {}),
      ...(target.remote !== undefined ? { remote: target.remote } : {}),
      codexDaemon: 'on',
      resolveSession: () => ({ kind: 'bound', recorded: precheck.recorded }),
      ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
      timeoutMs: remainingTimeoutMs,
    });

  let pushed: RuntimePushOutcome;
  try {
    pushed = await adapter.push({
      root: target.root,
      session: target.session,
      seat: target.seat,
      id: message.id,
      sender: target.sender,
      agentSession: precheck.threadId,
      pointer: precheck.pointer,
      home: target.home,
      timeoutMs: remainingTimeoutMs,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const timedOut = /timed out after \d+ms/i.test(msg);
    pushed = {
      kind: 'unreachable',
      reason: `the adapter failed: ${msg}`,
      ...(timedOut ? { timedOut: true } : {}),
    };
  }

  const at = nowFn();
  if (pushed.kind !== 'enqueue') {
    const reason =
      pushed.reason === '' ? `the runtime returned ${pushed.kind} with no reason` : pushed.reason;
    const timedOut = pushed.kind === 'unreachable' && pushed.timedOut === true;
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: pushed.kind,
      reason,
      ...(timedOut ? { timedOut: true } : {}),
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt(
        timedOut ? 'timeout' : 'unreachable',
        liveRoutesRemain,
        at,
        startedAt,
        reason,
        { kind: 'stored', id: message.id },
      ),
    };
  }

  const receipt: PackageRelayReceipt = {
    ...(copyReceipt.copy !== undefined ? { copy: copyReceipt.copy } : {}),
    ...(copyReceipt.existing !== undefined ? { existing: copyReceipt.existing } : {}),
    bytes: Buffer.byteLength(precheck.pointer, 'utf8'),
    at: at.toISOString(),
  };

  return {
    route: CODEX_NATIVE_ROUTE,
    outcome: 'enqueue',
    receipt,
    walkAttempt: buildWalkAttempt(
      'delivered',
      false,
      at,
      startedAt,
      'pushed to codex queue; no read receipt yet',
      { kind: 'maybe-consumed' },
    ),
  };
}
