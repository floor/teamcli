// Unified runtime-adapter contract and fallback-walk coordinator for OD1058-RELAY.
//
// Bridges the standalone `@teamcli/relay` transport package (`stage`, `deliver`, `capabilities`,
// `dial` in `packages/relay/index.js`) with TeamCLI's runtime adapters (`codex` `0.161.0` on the
// `native` leg in `./codex-relay.ts` and `gemini` `0.64.0` / `cursor` `2026.10.16` on the
// `headless-resume` leg in `./headless-resume.ts`), Claude Code's cross-session socket declaration
// gate (`declaredInboundOf`, `inboundIsLive` in `../inbound.ts`), and TeamCLI's fallback-episode
// recorder (`FallbackWalk`, `WalkAttempt` in `../fallback-walk.ts`).
//
// Ownership and boundary invariants:
//   - Admission, record signing, message history, event-bus publication, receiver deduplication
//     (`readMessage` in `src/mcp/inbox.ts`), and signed policy resolution (`delivery-order`,
//     `delivery-timeout`, `delivery-escalation`, `codex-daemon`) stay in TeamCLI.
//   - `@teamcli/relay` (`packages/relay/*`) remains a pure Node-builtin transport package with zero
//     TeamCLI imports.
//   - Fixed non-configurable delivery rules (OD20261020-03 binding addendum):
//       1. A signed durable copy is staged (`stage`) once under `message.id` before any route
//          attempt; a conflicting holder at `message.id` refuses before any transport runs.
//       2. Every live route is probed for readiness / acceptance before dialing or spawning, and a
//          route that would hold or block (`crossSessionInbound: 'hold'`, stale socket predating
//          `accept`, or an active / non-accepting Codex thread on `thread/read`) is never chosen.
//       3. One `message.id` (and identical signed record digest) is carried across every route in
//          the walk so receiver deduplication (`inbox_read` / `<id>.read.json`) holds even when an
//          earlier route fails mid-send with an ambiguous (`maybe-consumed`) transport receipt.
//       4. Every route attempt is recorded with its route, outcome, timestamp, elapsed ms, reason,
//          and typed transport receipt (`unknown`, `stored`, or `maybe-consumed`).
//   - Receipt semantics:
//       * Durable copy (`durable-copy`) is storage only (`outcome: 'held'`), never wake or read.
//       * Socket write (`socket`), Codex queue exit 0 (`native`), and Gemini/Cursor headless turn
//         exit 0 (`headless-resume`) are transport only (`outcome: 'delivered'`,
//         `readReceiptVerified: false`, `walkAttempt.receipt: { kind: 'maybe-consumed' }`).
//       * `outcome: 'read'` (`readReceiptVerified: true`) is returned ONLY when TeamCLI's signed
//         `<id>.read.json` receipt verifier confirms a verified read receipt. Existing runtime
//         adapters are reported as `liveReceiptProven: false` until proven by live receipts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  capabilities as packageRelayCapabilities,
  deliver as packageRelayDeliver,
  SEND_TIMEOUT_MS,
  stage as packageRelayStage,
  type CopyTarget,
  type Dial,
  type RelayCapabilities as PackageRelayCapabilities,
  type RelayReceipt as PackageRelayReceipt,
  type RelayStage,
} from '../../../packages/relay/index.js';
import type {
  DeliveryEscalationDelay,
  DeliveryTimeoutInForce,
} from '../../policy/delivery.ts';
import type { DeliveryTimeoutRoute } from '../../policy/types.ts';
import type { RecordedSeatSession, RecordedSeatSessionRead } from '../../registry/resume.ts';
import type { AttemptOutcome, RelayReceipt as WalkRelayReceipt } from '../fallback-events.ts';
import type { FallbackNote } from '../fallback-events.ts';
import type { FallbackWalk, WalkAttempt } from '../fallback-walk.ts';
import {
  declaredInboundOf,
  inboundIsLive,
  inboundSkipReason,
  type CrossSessionInbound,
  type InboundDeclaration,
} from '../inbound.ts';
import type { PushSender, RuntimePushAdapter } from '../push.ts';
import type { CodexSpawn } from './codex.ts';
import {
  CODEX_NATIVE_ROUTE,
  CODEX_NATIVE_TIMEOUT_MS,
  CODEX_PREPROBE_TIMEOUT_MS,
  codexRelayCapabilities,
  deliverCodexNativeRoute,
  probeCodexLiveReadiness,
  probeCodexNativeRoute,
  type CodexThreadActiveFlag,
  type CodexThreadReadProbe,
} from './codex-relay.ts';
import {
  buildHeadlessResumeArgs,
  deliverHeadlessResumeRoute,
  HEADLESS_RESUME_CLIS,
  HEADLESS_RESUME_ROUTE,
  HEADLESS_RESUME_TIMEOUT_MS,
  HEADLESS_RESUME_UNAVAILABLE_REASON,
  headlessResumeBinaryFor,
  headlessResumeCapabilities,
  isHeadlessResumeCli,
  probeHeadlessResumeRoute,
  type HeadlessResumeCli,
  type HeadlessResumeSpawn,
} from './headless-resume.ts';

/** Canonical routes coordinated across `@teamcli/relay` and TeamCLI's runtime adapters. */
export const RUNTIME_RELAY_ROUTES = [
  'socket',
  'native',
  'headless-resume',
  'durable-copy',
] as const;

export type RuntimeRelayRoute = (typeof RUNTIME_RELAY_ROUTES)[number];

/** Default measured runtime versions for capability reporting when the caller omits `version`. */
export const DEFAULT_RUNTIME_VERSIONS: Readonly<Record<string, string>> = {
  'claude-code': '2.1.295',
  codex: '0.161.0',
  gemini: '0.64.0',
  cursor: '2026.10.16',
  grok: '1.0.62',
  antigravity: '1.4.2',
  jules: '0.1.42',
  muse: '1.4.10',
  opencode: '1.14.46',
};

export type RuntimeRelaySocketCapability = PackageRelayCapabilities['socket'] & {
  precheck: 'declared-cross-session-inbound-accept';
  proof: 'socket-kernel-write-only' | 'none';
  liveReceiptProven: false;
};

export type RuntimeRelayNativeCapability =
  | {
      runtime: 'codex';
      supported: true;
      command: readonly ['codex', 'queue', '--thread', '<agent_session>', '--message', '<pointer>'];
      timeoutMs: number;
      preprobeTimeoutMs: number;
      precheck: 'local-policy-and-session-plus-optional-thread-read-rpc';
      liveProbeRpc: 'thread/read';
      ack: false;
      proof: 'queue-accepted-only';
      liveReceiptProven: false;
    }
  | {
      runtime: string;
      supported: false;
      timeoutMs: number;
      preprobeTimeoutMs: number;
      ack: false;
      proof: 'none';
      liveReceiptProven: false;
      reason: string;
    };

export type RuntimeRelayHeadlessCapability =
  | {
      runtime: HeadlessResumeCli;
      supported: true;
      binary: 'gemini' | 'cursor-agent';
      command: readonly string[];
      timeoutMs: number;
      ack: false;
      proof: 'process-exit-0-only';
      liveReceiptProven: false;
    }
  | {
      runtime: string;
      supported: false;
      timeoutMs: number;
      ack: false;
      proof: 'none';
      liveReceiptProven: false;
      reason: string;
    };

export type RuntimeRelayCapabilities = {
  runtime: string;
  version: string;
  routes: readonly RuntimeRelayRoute[];
  socket: RuntimeRelaySocketCapability;
  native: RuntimeRelayNativeCapability;
  headlessResume: RuntimeRelayHeadlessCapability;
  durableCopy: {
    supported: true;
    wakesReceiver: false;
    isReadReceipt: false;
  };
  /**
   * True only when live end-to-end runtime read receipts have been proven in the release artifact.
   * Always `false` in synthetic/local builds: durable copy is never wake/read, and transport
   * delivery (`socket`, `native`, `headless-resume`) is never `read` without a verified signed
   * `<id>.read.json` receipt.
   */
  liveReceiptProven: false;
  limitations: readonly string[];
};

function unsupportedNativeReasonFor(runtime: string): string {
  switch (runtime) {
    case 'claude-code':
      return 'claude-code uses the cross-session socket route (when crossSessionInbound is accept), not a native runtime-push queue';
    case 'gemini':
    case 'cursor':
      return `${runtime} interactive TUI seats expose no inbound runtime-push queue; use headless-resume for one-turn bound session resume`;
    case 'grok':
      return 'grok leader-socket ACP push is off by default and unproven for live interactive seats in this build';
    default:
      return `this build carries no native runtime push channel for ${runtime}`;
  }
}

/**
 * Pure, synchronous, zero-I/O capability descriptor combining `@teamcli/relay`'s `capabilities`
 * (`socket`, `durableCopy`) with TeamCLI's runtime adapters (`codex` `native` and `gemini`/`cursor`
 * `headless-resume`). Never claims live receipt proof.
 */
export function runtimeRelayCapabilities(
  runtime: string,
  version?: string,
): RuntimeRelayCapabilities {
  const resolvedVersion = version ?? DEFAULT_RUNTIME_VERSIONS[runtime] ?? 'unknown';
  const base = packageRelayCapabilities(runtime, resolvedVersion);

  const routes: RuntimeRelayRoute[] = [];
  if (base.socket.supported) routes.push('socket');
  if (runtime === 'codex') routes.push(CODEX_NATIVE_ROUTE);
  if (isHeadlessResumeCli(runtime)) routes.push(HEADLESS_RESUME_ROUTE);
  routes.push('durable-copy');

  const nativeCap: RuntimeRelayNativeCapability =
    runtime === 'codex'
      ? {
          runtime: 'codex',
          supported: true,
          command: codexRelayCapabilities(resolvedVersion).native.command,
          timeoutMs: CODEX_NATIVE_TIMEOUT_MS,
          preprobeTimeoutMs: CODEX_PREPROBE_TIMEOUT_MS,
          precheck: 'local-policy-and-session-plus-optional-thread-read-rpc',
          liveProbeRpc: 'thread/read',
          ack: false,
          proof: 'queue-accepted-only',
          liveReceiptProven: false,
        }
      : {
          runtime,
          supported: false,
          timeoutMs: CODEX_NATIVE_TIMEOUT_MS,
          preprobeTimeoutMs: CODEX_PREPROBE_TIMEOUT_MS,
          ack: false,
          proof: 'none',
          liveReceiptProven: false,
          reason: unsupportedNativeReasonFor(runtime),
        };

  let headlessCap: RuntimeRelayHeadlessCapability;
  if (isHeadlessResumeCli(runtime)) {
    const hCaps = headlessResumeCapabilities({
      [runtime]: resolvedVersion,
    });
    const profile = hCaps.profiles[runtime];
    headlessCap = {
      runtime,
      supported: true,
      binary: profile.binary,
      command: profile.command,
      timeoutMs: HEADLESS_RESUME_TIMEOUT_MS,
      ack: false,
      proof: 'process-exit-0-only',
      liveReceiptProven: false,
    };
  } else {
    headlessCap = {
      runtime,
      supported: false,
      timeoutMs: HEADLESS_RESUME_TIMEOUT_MS,
      ack: false,
      proof: 'none',
      liveReceiptProven: false,
      reason: HEADLESS_RESUME_UNAVAILABLE_REASON,
    };
  }

  return {
    runtime,
    version: resolvedVersion,
    routes,
    socket: {
      ...base.socket,
      precheck: 'declared-cross-session-inbound-accept',
      proof: base.socket.supported ? 'socket-kernel-write-only' : 'none',
      liveReceiptProven: false,
    },
    native: nativeCap,
    headlessResume: headlessCap,
    durableCopy: {
      supported: true,
      wakesReceiver: false,
      isReadReceipt: false,
    },
    liveReceiptProven: false,
    limitations: [
      'A signed durable copy is staged once before any route attempt; durable-copy alone is held storage, never a wake or a read.',
      'Transport completion on socket (kernel write), native (codex queue exit 0), or headless-resume (gemini/cursor-agent exit 0) is unconfirmed delivery (maybe-consumed), never read without a verified signed <id>.read.json receipt.',
      'Existing runtime adapters remain unproven for live receipt consumption until a live runtime writes and verifies <id>.read.json.',
    ],
  };
}

export type RuntimeRelaySocketTarget = {
  route: 'socket';
  runtime: string;
  socket: string;
  copy: CopyTarget;
  /** Optional seat context for checking `declaredInboundOf` + `inboundIsLive` before dialing. */
  root?: string;
  dir?: string;
  session?: string;
  seat?: string;
  launch?: string;
};

export type RuntimeRelayNativeTarget = {
  route: 'native';
  runtime: string;
  copy: CopyTarget;
  root: string;
  home: string;
  session: string;
  seat: string;
  sender: PushSender;
  agentSession?: string | null;
  remote?: string;
};

export type RuntimeRelayHeadlessTarget = {
  route: 'headless-resume';
  runtime: string;
  copy: CopyTarget;
  root: string;
  home: string;
  session: string;
  seat: string;
  sender: PushSender;
  cwd?: string;
  agentSession?: string | null;
};

export type RuntimeRelayDurableCopyTarget = {
  route: 'durable-copy';
  copy: CopyTarget;
  runtime?: string;
};

export type RuntimeRelayTarget =
  | RuntimeRelaySocketTarget
  | RuntimeRelayNativeTarget
  | RuntimeRelayHeadlessTarget
  | RuntimeRelayDurableCopyTarget;

export type RuntimeRelayMessage = {
  id: string;
  /** Opaque signed record text (JSON with trailing newline) staged at `target.copy`. */
  record: string;
  /** Complete newline-terminated socket frame for `route: 'socket'`. */
  frame?: string;
  /** Optional single-line pointer (`pushPointer(id, sender)`) for `native` or `headless-resume`. */
  pointer?: string;
};

export type RuntimeRelayProbeOptions = {
  /** Explicit `crossSessionInbound` override or declaration for `route: 'socket'`. */
  crossSessionInbound?: CrossSessionInbound | null | InboundDeclaration;
  /** When `true`, `probeRuntimeRelayRoute` checks `existsSync(target.socket)` on `route: 'socket'`. */
  requireSocketFile?: boolean;
  /** Message ID for pointer construction on `native` / `headless-resume` probes. */
  id?: string;
  /** Optional pre-built pointer for `native` / `headless-resume` probes. */
  pointer?: string | null;
  /** Optional resolved `recordedSeatSession` binding. */
  sessionBinding?: RecordedSeatSessionRead;
  /** Optional bounded (`<= 400ms`) live `thread/read` probe for Codex `native`. */
  liveProbe?: boolean | CodexThreadReadProbe;
  /** Optional control socket override for Codex `native` live probe. */
  socketPath?: string | null;
  /** Optional probe timeout budget in ms (clamped to `<= 400ms` for Codex `thread/read`). */
  timeoutMs?: number;
  /** Optional binary override for `headless-resume`. */
  binary?: string;
};

export type RuntimeRelayProbeOutcome =
  | {
      status: 'ready';
      route: RuntimeRelayRoute;
      socket?: string;
      threadId?: string;
      sessionId?: string;
      binary?: string;
      args?: readonly string[];
      pointer?: string;
      recorded?: RecordedSeatSession;
    }
  | {
      status: 'would-hold';
      route: RuntimeRelayRoute;
      reason: string;
      threadId?: string;
      activeFlags?: readonly CodexThreadActiveFlag[];
    }
  | {
      status: 'unsupported' | 'unavailable' | 'refused';
      route: RuntimeRelayRoute;
      reason: string;
      timedOut?: boolean;
    };

function resolveSocketInboundProbe(
  target: RuntimeRelaySocketTarget,
  options: RuntimeRelayProbeOptions = {},
): RuntimeRelayProbeOutcome {
  const caps = packageRelayCapabilities(target.runtime);
  if (!caps.socket.supported) {
    return {
      status: 'unsupported',
      route: 'socket',
      reason: `${target.runtime} sessions have no cross-session socket`,
    };
  }

  let declaration: InboundDeclaration | null = null;
  if (options.crossSessionInbound !== undefined) {
    if (
      options.crossSessionInbound !== null
      && typeof options.crossSessionInbound === 'object'
      && 'policy' in options.crossSessionInbound
    ) {
      declaration = options.crossSessionInbound;
    } else {
      declaration = {
        policy: options.crossSessionInbound,
        declaredAt: null,
        source: 'explicit',
      };
    }
  } else if (
    target.root !== undefined
    && target.session !== undefined
    && target.seat !== undefined
  ) {
    declaration = declaredInboundOf({
      dir: target.dir ?? join(target.root, '.agents'),
      root: target.root,
      session: target.session,
      seat: target.seat,
      ...(target.launch === undefined ? {} : { launch: target.launch }),
    });
  }

  if (declaration !== null) {
    if (declaration.policy === 'hold') {
      return {
        status: 'would-hold',
        route: 'socket',
        reason: inboundSkipReason('hold'),
      };
    }
    if (declaration.policy === 'refuse') {
      return {
        status: 'refused',
        route: 'socket',
        reason: inboundSkipReason('refuse'),
      };
    }
    if (declaration.policy !== 'accept') {
      return {
        status: 'unavailable',
        route: 'socket',
        reason: inboundSkipReason(null),
      };
    }
    if (!inboundIsLive(declaration, target.socket)) {
      return {
        status: 'would-hold',
        route: 'socket',
        reason:
          'the receiving Claude session socket predates its crossSessionInbound accept declaration and would hold the frame',
      };
    }
  }

  if (options.requireSocketFile === true && !existsSync(target.socket)) {
    return {
      status: 'unavailable',
      route: 'socket',
      reason: 'nothing is listening there (the socket is gone)',
    };
  }

  return {
    status: 'ready',
    route: 'socket',
    socket: target.socket,
  };
}

/**
 * Probes whether a candidate route is live and accepts direct delivery without holding or blocking:
 *   - `socket`: verifies `claude-code` runtime + `crossSessionInbound: 'accept'` + `inboundIsLive`
 *     (classifies `hold` or a pre-declaration socket as `would-hold` so the walk skips without dialing).
 *   - `native`: for `codex`, runs `probeCodexLiveReadiness` (`<= 400ms` `thread/read` RPC when
 *     `options.liveProbe` is set) or `probeCodexNativeRoute`; for other runtimes returns `unsupported`.
 *   - `headless-resume`: runs `probeHeadlessResumeRoute` for `gemini` / `cursor` (`unsupported` for others).
 *   - `durable-copy`: always `ready`.
 */
export async function probeRuntimeRelayRoute(
  target: RuntimeRelayTarget,
  options: RuntimeRelayProbeOptions = {},
): Promise<RuntimeRelayProbeOutcome> {
  if (target.route === 'durable-copy') {
    return { status: 'ready', route: 'durable-copy' };
  }

  if (target.route === 'socket') {
    return resolveSocketInboundProbe(target, options);
  }

  const probeId = options.id ?? target.copy.name;

  if (target.route === 'native') {
    if (target.runtime !== 'codex') {
      return {
        status: 'unsupported',
        route: 'native',
        reason: unsupportedNativeReasonFor(target.runtime),
      };
    }
    if (options.liveProbe !== undefined && options.liveProbe !== false) {
      const live = await probeCodexLiveReadiness({
        root: target.root,
        home: target.home,
        session: target.session,
        seat: target.seat,
        id: probeId,
        sender: target.sender,
        ...(options.pointer !== undefined ? { pointer: options.pointer } : {}),
        ...(target.agentSession !== undefined ? { agentSession: target.agentSession } : {}),
        ...(target.remote !== undefined ? { remote: target.remote } : {}),
        ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
        ...(typeof options.liveProbe === 'function' ? { liveProbe: options.liveProbe } : {}),
      });
      if (live.status === 'ready') {
        return {
          status: 'ready',
          route: 'native',
          threadId: live.threadId,
          pointer: live.pointer,
          recorded: live.recorded,
        };
      }
      if (live.status === 'would-hold') {
        return {
          status: 'would-hold',
          route: 'native',
          reason: live.reason,
          threadId: live.threadId,
          activeFlags: live.activeFlags,
        };
      }
      return {
        status: live.status,
        route: 'native',
        reason: live.reason,
        ...(live.timedOut === true ? { timedOut: true } : {}),
      };
    }

    const sync = probeCodexNativeRoute({
      root: target.root,
      home: target.home,
      session: target.session,
      seat: target.seat,
      id: probeId,
      sender: target.sender,
      ...(options.pointer !== undefined ? { pointer: options.pointer } : {}),
      ...(target.agentSession !== undefined ? { agentSession: target.agentSession } : {}),
      ...(target.remote !== undefined ? { remote: target.remote } : {}),
      ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
    });
    if (sync.status === 'ready') {
      return {
        status: 'ready',
        route: 'native',
        threadId: sync.threadId,
        pointer: sync.pointer,
        recorded: sync.recorded,
      };
    }
    return {
      status: sync.status,
      route: 'native',
      reason: sync.reason,
    };
  }

  // target.route === 'headless-resume'
  const headless = probeHeadlessResumeRoute({
    cli: target.runtime,
    root: target.root,
    home: target.home,
    session: target.session,
    seat: target.seat,
    id: probeId,
    sender: target.sender,
    ...(options.pointer !== undefined ? { pointer: options.pointer } : {}),
    ...(target.agentSession !== undefined ? { agentSession: target.agentSession } : {}),
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
    ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
  });
  if (headless.status === 'ready') {
    return {
      status: 'ready',
      route: 'headless-resume',
      sessionId: headless.sessionId,
      binary: headless.binary,
      args: headless.args,
      pointer: headless.pointer,
      recorded: headless.recorded,
    };
  }
  return {
    status: headless.status,
    route: 'headless-resume',
    reason: headless.reason,
  };
}

export type RuntimeRelayDeliverOptions = {
  now?: () => Date;
  startedAt?: number;
  routeStartedAt?: number | Date;
  /** Already-resolved `DeliveryTimeoutInForce` or route-budget map in seconds. */
  deliveryTimeout?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number;
  /** Optional explicit attempt timeout override in ms (clamped to signed `deliveryTimeout`). */
  timeoutMs?: number;
  /** Whether another live route stands behind this one in the recipient's `delivery-order`. */
  liveRoutesRemain?: boolean;
  /** Skip calling `stage()` when the caller has already staged the record for this walk. */
  skipStage?: boolean;
  /** Injectable socket dial seam for `route: 'socket'`. */
  dial?: Dial;
  /** Explicit `crossSessionInbound` declaration or override for `route: 'socket'`. */
  crossSessionInbound?: CrossSessionInbound | null | InboundDeclaration;
  /** Optional bounded (`<= 400ms`) live `thread/read` readiness probe for Codex `native`. */
  liveProbe?: boolean | CodexThreadReadProbe;
  /** Optional control socket override for Codex `native`. */
  socketPath?: string | null;
  /** Optional resolved `recordedSeatSession` binding for `native` or `headless-resume`. */
  sessionBinding?: RecordedSeatSessionRead;
  /** Optional injected `RuntimePushAdapter` for `native` or `headless-resume`. */
  adapter?: RuntimePushAdapter;
  /** Optional binary override for `native` or `headless-resume`. */
  binary?: string;
  /** Optional process spawn seam for `native` (`codex queue`) or `headless-resume` (`gemini`/`cursor-agent`). */
  spawn?: HeadlessResumeSpawn;
  /**
   * Optional TeamCLI signed read-receipt verifier (`<id>.read.json`). Only when this callback
   * returns `true` after a live transport attempt does `outcome` promote from `'delivered'` to
   * `'read'` (`readReceiptVerified: true`).
   */
  verifyReadReceipt?: (messageId: string) => boolean | Promise<boolean>;
};

export type RuntimeRelayAdapterOutcome =
  | 'delivered'
  | 'enqueue'
  | 'held'
  | 'unsupported'
  | 'unreachable'
  | 'refused';

export type RuntimeRelayAttempt =
  | {
      route: RuntimeRelayRoute;
      outcome: 'delivered' | 'read';
      adapterOutcome: 'delivered' | 'enqueue';
      readReceiptVerified: boolean;
      receipt: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    }
  | {
      route: 'durable-copy';
      outcome: 'held';
      adapterOutcome: 'held';
      readReceiptVerified: false;
      reason: string;
      receipt: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    }
  | {
      route: RuntimeRelayRoute;
      outcome: 'refused';
      adapterOutcome: 'unsupported' | 'unreachable' | 'refused';
      readReceiptVerified: false;
      reason: string;
      timedOut?: boolean;
      wouldHold?: boolean;
      /**
       * True when the transport connection closed mid-send or timed out after an attempt began so
       * the receiver may have observed the frame/pointer (`walkAttempt.receipt.kind === 'maybe-consumed'`).
       * Fallback routes must preserve the identical `message.id` so the receiver's `readMessage`
       * gate deduplicates any replay.
       */
      ambiguousConsumption?: boolean;
      receipt?: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    };

function buildWalkAttempt(
  route: RuntimeRelayRoute,
  outcome: AttemptOutcome,
  liveRoutesRemain: boolean,
  at: Date,
  startedAt: number,
  reason: string | undefined,
  receipt: WalkRelayReceipt,
): WalkAttempt {
  return {
    route,
    outcome,
    liveRoutesRemain,
    at,
    ms: Math.max(0, at.getTime() - startedAt),
    ...(reason === undefined ? {} : { reason }),
    receipt,
  };
}

function isMidSendSocketFailure(reason: string): boolean {
  return (
    /closed the connection before it took the frame/i.test(reason)
    || /did not take the frame within/i.test(reason)
    || /\b(EPIPE|ECONNRESET)\b/i.test(reason)
  );
}

function resolveSocketTimeoutMs(
  deliveryTimeout: RuntimeRelayDeliverOptions['deliveryTimeout'],
  overrideTimeoutMs?: number,
): { ok: true; timeoutMs: number } | { ok: false; why: string } {
  let baseMs = SEND_TIMEOUT_MS;
  if (deliveryTimeout !== undefined) {
    if (typeof deliveryTimeout === 'number') {
      if (!Number.isFinite(deliveryTimeout) || deliveryTimeout <= 0) {
        return { ok: false, why: 'the socket attempt timeout budget must be above 0ms' };
      }
      baseMs = Math.round(deliveryTimeout);
    } else if ('ok' in deliveryTimeout) {
      if (!deliveryTimeout.ok) {
        return { ok: false, why: deliveryTimeout.why };
      }
      const seconds = deliveryTimeout.budgets.socket;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: 'the resolved "delivery-timeout" map has no valid socket budget' };
      }
      baseMs = Math.round(seconds * 1000);
    } else if (deliveryTimeout.socket !== undefined) {
      const seconds = deliveryTimeout.socket;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: 'the socket attempt timeout budget must be above 0s' };
      }
      baseMs = Math.round(seconds * 1000);
    }
  }
  if (overrideTimeoutMs !== undefined) {
    if (!Number.isFinite(overrideTimeoutMs) || overrideTimeoutMs <= 0) {
      return { ok: false, why: 'the socket attempt timeout override must be above 0ms' };
    }
    return { ok: true, timeoutMs: Math.min(baseMs, Math.round(overrideTimeoutMs)) };
  }
  return { ok: true, timeoutMs: baseMs };
}

/**
 * Executes a single route attempt (`socket`, `native`, `headless-resume`, or `durable-copy`)
 * aligned with `@teamcli/relay`'s `deliver(target, message, options)` contract and TeamCLI's
 * `FallbackWalk` (`WalkAttempt`).
 */
export async function deliverRuntimeRelayRoute(
  target: RuntimeRelayTarget,
  message: RuntimeRelayMessage,
  options: RuntimeRelayDeliverOptions = {},
): Promise<RuntimeRelayAttempt> {
  const nowFn = options.now ?? (() => new Date());
  const entryMs = nowFn().getTime();
  const suppliedRouteStart =
    options.routeStartedAt instanceof Date
      ? options.routeStartedAt.getTime()
      : options.routeStartedAt;
  const routeStartedAtMs = suppliedRouteStart ?? options.startedAt ?? entryMs;
  const startedAt =
    options.startedAt !== undefined && Number.isFinite(options.startedAt)
      ? options.startedAt
      : Number.isFinite(routeStartedAtMs)
        ? routeStartedAtMs
        : entryMs;
  const liveRoutesRemain = options.liveRoutesRemain ?? (target.route !== 'durable-copy');

  if (target.copy.name !== message.id) {
    const at = nowFn();
    const reason = 'the copy target name must match the message id';
    return {
      route: target.route,
      outcome: 'refused',
      adapterOutcome: 'refused',
      readReceiptVerified: false,
      reason,
      walkAttempt: buildWalkAttempt(
        target.route,
        'refused',
        false,
        at,
        startedAt,
        reason,
        { kind: 'unknown' },
      ),
    };
  }

  if (target.route === 'durable-copy') {
    if (options.skipStage === true) {
      const at = nowFn();
      const reason = 'the durable copy is stored; no live route delivered it';
      const receipt: PackageRelayReceipt = {
        copy: join(target.copy.dir, target.copy.name),
        existing: true,
        at: at.toISOString(),
      };
      return {
        route: 'durable-copy',
        outcome: 'held',
        adapterOutcome: 'held',
        readReceiptVerified: false,
        reason,
        receipt,
        walkAttempt: buildWalkAttempt('durable-copy', 'held', false, at, startedAt, reason, {
          kind: 'stored',
          id: message.id,
        }),
      };
    }

    const delivered = await packageRelayDeliver(
      { route: 'durable-copy', copy: target.copy },
      { id: message.id, record: message.record },
      { now: nowFn },
    );
    const at = nowFn();
    if (delivered.outcome === 'refused') {
      return {
        route: 'durable-copy',
        outcome: 'refused',
        adapterOutcome: 'refused',
        readReceiptVerified: false,
        reason: delivered.reason,
        ...(delivered.receipt === undefined ? {} : { receipt: delivered.receipt }),
        walkAttempt: buildWalkAttempt(
          'durable-copy',
          'refused',
          false,
          at,
          startedAt,
          delivered.reason,
          { kind: 'unknown' },
        ),
      };
    }
    const reason =
      delivered.outcome === 'held'
        ? delivered.reason
        : 'the durable copy is stored; no live route delivered it';
    const receipt: PackageRelayReceipt = delivered.receipt ?? {
      copy: join(target.copy.dir, target.copy.name),
      at: at.toISOString(),
    };
    return {
      route: 'durable-copy',
      outcome: 'held',
      adapterOutcome: 'held',
      readReceiptVerified: false,
      reason,
      receipt,
      walkAttempt: buildWalkAttempt('durable-copy', 'held', false, at, startedAt, reason, {
        kind: 'stored',
        id: message.id,
      }),
    };
  }

  if (target.route === 'socket') {
    const budget = resolveSocketTimeoutMs(options.deliveryTimeout, options.timeoutMs);
    if (!budget.ok) {
      const at = nowFn();
      return {
        route: 'socket',
        outcome: 'refused',
        adapterOutcome: 'unsupported',
        readReceiptVerified: false,
        reason: budget.why,
        walkAttempt: buildWalkAttempt('socket', 'unreachable', liveRoutesRemain, at, startedAt, budget.why, {
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
      const staged = await packageRelayStage(
        target.copy,
        { id: message.id, record: message.record },
        { now: nowFn },
      );
      if (staged.outcome === 'refused') {
        const at = nowFn();
        return {
          route: 'socket',
          outcome: 'refused',
          adapterOutcome: 'refused',
          readReceiptVerified: false,
          reason: staged.reason,
          ...(staged.receipt === undefined ? {} : { receipt: staged.receipt }),
          walkAttempt: buildWalkAttempt(
            'socket',
            'refused',
            false,
            at,
            startedAt,
            staged.reason,
            { kind: 'unknown' },
          ),
        };
      }
      copyReceipt = staged.receipt;
    }

    const precheck = resolveSocketInboundProbe(target, {
      ...(options.crossSessionInbound === undefined
        ? {}
        : { crossSessionInbound: options.crossSessionInbound }),
    });
    if (precheck.status !== 'ready') {
      const at = nowFn();
      const wouldHold = precheck.status === 'would-hold';
      return {
        route: 'socket',
        outcome: 'refused',
        adapterOutcome: precheck.status === 'unsupported' ? 'unsupported' : 'unreachable',
        readReceiptVerified: false,
        reason: precheck.reason,
        ...(wouldHold ? { wouldHold: true } : {}),
        receipt: copyReceipt,
        walkAttempt: buildWalkAttempt(
          'socket',
          'unreachable',
          liveRoutesRemain,
          at,
          startedAt,
          precheck.reason,
          { kind: 'stored', id: message.id },
        ),
      };
    }

    const elapsedMs = Math.max(0, nowFn().getTime() - routeStartedAtMs);
    const remainingTimeoutMs = budget.timeoutMs - elapsedMs;
    if (remainingTimeoutMs <= 0) {
      const at = nowFn();
      const reason = `the socket attempt timed out before dial (${String(budget.timeoutMs)}ms budget exhausted during preparation)`;
      return {
        route: 'socket',
        outcome: 'refused',
        adapterOutcome: 'unreachable',
        readReceiptVerified: false,
        reason,
        timedOut: true,
        receipt: copyReceipt,
        walkAttempt: buildWalkAttempt('socket', 'timeout', liveRoutesRemain, at, startedAt, reason, {
          kind: 'stored',
          id: message.id,
        }),
      };
    }

    const attempt = await packageRelayDeliver(
      {
        route: 'socket',
        socket: target.socket,
        runtime: target.runtime,
        copy: target.copy,
      },
      {
        id: message.id,
        record: message.record,
        ...(message.frame === undefined ? {} : { frame: message.frame }),
      },
      {
        now: nowFn,
        timeoutMs: remainingTimeoutMs,
        ...(options.dial === undefined ? {} : { dial: options.dial }),
      },
    );
    const at = nowFn();

    if (attempt.outcome !== 'delivered') {
      const reason = attempt.reason;
      const timedOut = /did not take the frame within/i.test(reason);
      const midSend = isMidSendSocketFailure(reason);
      return {
        route: 'socket',
        outcome: 'refused',
        adapterOutcome: 'unreachable',
        readReceiptVerified: false,
        reason,
        ...(timedOut ? { timedOut: true } : {}),
        ...(midSend ? { ambiguousConsumption: true } : {}),
        receipt: attempt.receipt ?? copyReceipt,
        walkAttempt: buildWalkAttempt(
          'socket',
          timedOut ? 'timeout' : 'unreachable',
          liveRoutesRemain,
          at,
          startedAt,
          reason,
          midSend ? { kind: 'maybe-consumed' } : { kind: 'stored', id: message.id },
        ),
      };
    }

    const verified =
      options.verifyReadReceipt !== undefined
        ? await options.verifyReadReceipt(message.id)
        : false;
    return {
      route: 'socket',
      outcome: verified ? 'read' : 'delivered',
      adapterOutcome: 'delivered',
      readReceiptVerified: verified,
      receipt: attempt.receipt,
      walkAttempt: buildWalkAttempt(
        'socket',
        'delivered',
        false,
        at,
        startedAt,
        verified ? 'delivered over socket and verified by read receipt' : 'sent over cross-session socket; no read receipt yet',
        { kind: 'maybe-consumed' },
      ),
    };
  }

  if (target.route === 'native') {
    if (target.runtime !== 'codex') {
      let copyReceipt: PackageRelayReceipt | undefined;
      if (options.skipStage === true) {
        copyReceipt = {
          copy: join(target.copy.dir, target.copy.name),
          at: nowFn().toISOString(),
        };
      } else {
        const staged = await packageRelayStage(
          target.copy,
          { id: message.id, record: message.record },
          { now: nowFn },
        );
        if (staged.outcome === 'refused') {
          const at = nowFn();
          return {
            route: 'native',
            outcome: 'refused',
            adapterOutcome: 'refused',
            readReceiptVerified: false,
            reason: staged.reason,
            ...(staged.receipt === undefined ? {} : { receipt: staged.receipt }),
            walkAttempt: buildWalkAttempt(
              'native',
              'refused',
              false,
              at,
              startedAt,
              staged.reason,
              { kind: 'unknown' },
            ),
          };
        }
        copyReceipt = staged.receipt;
      }
      const at = nowFn();
      const reason = unsupportedNativeReasonFor(target.runtime);
      return {
        route: 'native',
        outcome: 'refused',
        adapterOutcome: 'unsupported',
        readReceiptVerified: false,
        reason,
        receipt: copyReceipt,
        walkAttempt: buildWalkAttempt(
          'native',
          'unreachable',
          liveRoutesRemain,
          at,
          startedAt,
          reason,
          { kind: 'stored', id: message.id },
        ),
      };
    }

    const codexAttempt = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: target.copy,
        root: target.root,
        home: target.home,
        session: target.session,
        seat: target.seat,
        sender: target.sender,
        ...(target.agentSession === undefined ? {} : { agentSession: target.agentSession }),
        ...(target.remote === undefined ? {} : { remote: target.remote }),
      },
      {
        id: message.id,
        record: message.record,
        ...(message.pointer === undefined ? {} : { pointer: message.pointer }),
      },
      {
        now: nowFn,
        startedAt,
        routeStartedAt: routeStartedAtMs,
        liveRoutesRemain,
        ...(options.deliveryTimeout === undefined ? {} : { deliveryTimeout: options.deliveryTimeout }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.sessionBinding === undefined ? {} : { sessionBinding: options.sessionBinding }),
        ...(options.skipStage === undefined ? {} : { skipStage: options.skipStage }),
        ...(options.liveProbe === undefined ? {} : { liveProbe: options.liveProbe }),
        ...(options.socketPath === undefined ? {} : { socketPath: options.socketPath }),
        ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
        ...(options.binary === undefined ? {} : { binary: options.binary }),
        ...(options.spawn === undefined ? {} : { spawn: options.spawn as CodexSpawn }),
      },
    );

    if (codexAttempt.outcome !== 'enqueue') {
      return {
        route: 'native',
        outcome: 'refused',
        adapterOutcome: codexAttempt.outcome,
        readReceiptVerified: false,
        reason: codexAttempt.reason,
        ...(codexAttempt.timedOut === true ? { timedOut: true, ambiguousConsumption: true } : {}),
        ...(codexAttempt.wouldHold === true ? { wouldHold: true } : {}),
        ...(codexAttempt.receipt === undefined ? {} : { receipt: codexAttempt.receipt }),
        walkAttempt: codexAttempt.walkAttempt,
      };
    }

    const verified =
      options.verifyReadReceipt !== undefined
        ? await options.verifyReadReceipt(message.id)
        : false;
    return {
      route: 'native',
      outcome: verified ? 'read' : 'delivered',
      adapterOutcome: 'enqueue',
      readReceiptVerified: verified,
      receipt: codexAttempt.receipt,
      walkAttempt: codexAttempt.walkAttempt,
    };
  }

  // target.route === 'headless-resume'
  const headlessAttempt = await deliverHeadlessResumeRoute(
    {
      route: 'headless-resume',
      cli: target.runtime,
      copy: target.copy,
      root: target.root,
      home: target.home,
      session: target.session,
      seat: target.seat,
      sender: target.sender,
      ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
      ...(target.agentSession === undefined ? {} : { agentSession: target.agentSession }),
    },
    {
      id: message.id,
      record: message.record,
      ...(message.pointer === undefined ? {} : { pointer: message.pointer }),
    },
    {
      now: nowFn,
      startedAt,
      routeStartedAt: routeStartedAtMs,
      liveRoutesRemain,
      ...(options.deliveryTimeout === undefined ? {} : { deliveryTimeout: options.deliveryTimeout }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sessionBinding === undefined ? {} : { sessionBinding: options.sessionBinding }),
      ...(options.skipStage === undefined ? {} : { skipStage: options.skipStage }),
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn as HeadlessResumeSpawn }),
    },
  );

  if (headlessAttempt.outcome !== 'enqueue') {
    return {
      route: 'headless-resume',
      outcome: 'refused',
      adapterOutcome: headlessAttempt.outcome,
      readReceiptVerified: false,
      reason: headlessAttempt.reason,
      ...(headlessAttempt.timedOut === true ? { timedOut: true, ambiguousConsumption: true } : {}),
      ...(headlessAttempt.receipt === undefined ? {} : { receipt: headlessAttempt.receipt }),
      walkAttempt: headlessAttempt.walkAttempt,
    };
  }

  const verified =
    options.verifyReadReceipt !== undefined
      ? await options.verifyReadReceipt(message.id)
      : false;
  return {
    route: 'headless-resume',
    outcome: verified ? 'read' : 'delivered',
    adapterOutcome: 'enqueue',
    readReceiptVerified: verified,
    receipt: headlessAttempt.receipt,
    walkAttempt: headlessAttempt.walkAttempt,
  };
}

export type RuntimeRelayWalkInput = {
  /** Ordered candidate routes resolved from the recipient's `delivery-order` policy. */
  routes: readonly RuntimeRelayTarget[];
  /** Single signed message (`id`, `record`, optional `frame` and `pointer`) shared across all routes. */
  message: RuntimeRelayMessage;
  /** Optional `FallbackWalk` episode (`beginFallbackWalk`) to record each `WalkAttempt` in order. */
  fallbackWalk?: FallbackWalk;
  /** Optional delivery/probe/clock options shared across the walk. */
  options?: RuntimeRelayDeliverOptions & {
    /** Optional per-route option overrides keyed by route name. */
    perRouteOptions?: Partial<Record<RuntimeRelayRoute, Partial<RuntimeRelayDeliverOptions>>>;
  };
};

export type RuntimeRelayWalkResult = {
  /** Final walk outcome (`delivered`, `read`, `held`, or `refused` when initial staging failed). */
  outcome: 'delivered' | 'read' | 'held' | 'refused';
  /** The live route that delivered the message (`socket`, `native`, or `headless-resume`), or `null` when held/refused. */
  deliveredRoute: Exclude<RuntimeRelayRoute, 'durable-copy'> | null;
  /** True only when a signed `<id>.read.json` receipt was verified by `verifyReadReceipt`. */
  readReceiptVerified: boolean;
  /** Result of staging the durable signed copy before the first route attempt. */
  staged: RelayStage;
  /** Receipt of the final delivering or held route (or staging receipt). */
  receipt?: PackageRelayReceipt;
  /** Reason when the walk ended `held` or `refused`. */
  reason?: string;
  /** Every route attempt made during the walk, in order. */
  attempts: readonly RuntimeRelayAttempt[];
  /** Every `FallbackWalk.note(...)` result recorded during the walk, in order. */
  fallbackNotes: readonly FallbackNote[];
};

function isLiveRelayRoute(route: RuntimeRelayRoute): boolean {
  return route !== 'durable-copy';
}

/**
 * Walks an ordered list of candidate routes (`delivery-order`) for a single signed message:
 *   1. Stages the signed durable copy once via `@teamcli/relay`'s `stage` before any route attempt.
 *   2. Attempts each route in order with the identical `message.id` and staged copy (`skipStage: true`).
 *   3. Records every attempt in `attempts` and `fallbackWalk.note(attempt.walkAttempt)`:
 *      - When a live route (`socket`, `native`, `headless-resume`) is refused, would-hold,
 *        unreachable, or killed mid-send, advances immediately to the next route in `routes`.
 *      - When a live route succeeds (`delivered` or `read`), stops the walk and reports
 *        `deliveredRoute`.
 *      - When all live routes fail, `fallbackWalk` records the final live failure with
 *        `liveRoutesRemain: false` (emitting one `message.held` event to sender + lead and
 *        scheduling the delayed main-orchestrator escalation) and the message remains `held`
 *        on disk.
 */
export async function walkRuntimeRelayRoutes(
  input: RuntimeRelayWalkInput,
): Promise<RuntimeRelayWalkResult> {
  const baseOptions = input.options ?? {};
  const nowFn = baseOptions.now ?? (() => new Date());
  const startedAt = baseOptions.startedAt ?? nowFn().getTime();

  if (input.routes.length === 0) {
    return {
      outcome: 'refused',
      deliveredRoute: null,
      readReceiptVerified: false,
      staged: { outcome: 'refused', reason: 'no delivery routes were supplied' },
      reason: 'no delivery routes were supplied',
      attempts: [],
      fallbackNotes: [],
    };
  }

  const firstCopy = input.routes[0]!.copy;
  if (firstCopy.name !== input.message.id) {
    const reason = 'the copy target name must match the message id';
    return {
      outcome: 'refused',
      deliveredRoute: null,
      readReceiptVerified: false,
      staged: { outcome: 'refused', reason },
      reason,
      attempts: [],
      fallbackNotes: [],
    };
  }
  for (const target of input.routes) {
    if (target.copy.dir !== firstCopy.dir || target.copy.name !== firstCopy.name) {
      const reason = 'every route in a walk must stage and reference the same copy target and message id';
      return {
        outcome: 'refused',
        deliveredRoute: null,
        readReceiptVerified: false,
        staged: { outcome: 'refused', reason },
        reason,
        attempts: [],
        fallbackNotes: [],
      };
    }
  }

  const staged = await packageRelayStage(
    firstCopy,
    { id: input.message.id, record: input.message.record },
    { now: nowFn },
  );
  if (staged.outcome === 'refused') {
    return {
      outcome: 'refused',
      deliveredRoute: null,
      readReceiptVerified: false,
      staged,
      reason: staged.reason,
      ...(staged.receipt === undefined ? {} : { receipt: staged.receipt }),
      attempts: [],
      fallbackNotes: [],
    };
  }

  const attempts: RuntimeRelayAttempt[] = [];
  const fallbackNotes: FallbackNote[] = [];

  for (let i = 0; i < input.routes.length; i += 1) {
    const target = input.routes[i]!;
    const liveRoutesRemain = input.routes
      .slice(i + 1)
      .some((later) => isLiveRelayRoute(later.route));
    const perRoute = baseOptions.perRouteOptions?.[target.route] ?? {};
    const routeStartedAt = perRoute.routeStartedAt ?? nowFn();

    const attempt = await deliverRuntimeRelayRoute(target, input.message, {
      ...baseOptions,
      ...perRoute,
      now: nowFn,
      startedAt,
      routeStartedAt,
      liveRoutesRemain,
      skipStage: true,
    });
    attempts.push(attempt);

    // Record every live route attempt in FallbackWalk; if the walk consists solely of
    // `durable-copy` (or reaches `durable-copy` before any exhaustion was noted), only note
    // `durable-copy` when no prior live route already noted `liveRoutesRemain: false`.
    const priorLiveExhausted =
      target.route === 'durable-copy'
      && attempts.slice(0, -1).some((prev) => isLiveRelayRoute(prev.route) && !prev.walkAttempt.liveRoutesRemain);
    if (input.fallbackWalk !== undefined && !priorLiveExhausted) {
      fallbackNotes.push(input.fallbackWalk.note(attempt.walkAttempt));
    }

    if (attempt.outcome === 'delivered' || attempt.outcome === 'read') {
      return {
        outcome: attempt.outcome,
        deliveredRoute: target.route as Exclude<RuntimeRelayRoute, 'durable-copy'>,
        readReceiptVerified: attempt.readReceiptVerified,
        staged,
        receipt: attempt.receipt,
        attempts,
        fallbackNotes,
      };
    }

    if (attempt.outcome === 'held') {
      return {
        outcome: 'held',
        deliveredRoute: null,
        readReceiptVerified: false,
        staged,
        receipt: attempt.receipt,
        reason: attempt.reason,
        attempts,
        fallbackNotes,
      };
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  const heldReason =
    lastAttempt !== undefined && 'reason' in lastAttempt
      ? lastAttempt.reason
      : 'the durable copy is stored; no live route delivered it';
  return {
    outcome: 'held',
    deliveredRoute: null,
    readReceiptVerified: false,
    staged,
    receipt: staged.receipt,
    reason: heldReason,
    attempts,
    fallbackNotes,
  };
}

export {
  buildHeadlessResumeArgs,
  CODEX_NATIVE_ROUTE,
  HEADLESS_RESUME_CLIS,
  HEADLESS_RESUME_ROUTE,
  headlessResumeBinaryFor,
  isHeadlessResumeCli,
  type CopyTarget,
  type DeliveryEscalationDelay,
  type DeliveryTimeoutInForce,
  type PackageRelayReceipt,
};
