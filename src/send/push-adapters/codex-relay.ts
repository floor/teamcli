// Narrow reusable Codex (`0.161.0`) relay adapter bridge for the committed sender walk
// (`785d63e1f`, `src/commands/send.ts` + `src/send/fallback-walk.ts` + `packages/relay`).
//
// Invariants enforced here:
//   - Accepts already-resolved shared policy/timing budgets from `src/policy/delivery.ts`
//     (`DeliveryTimeoutInForce`, `DeliveryEscalationDelay`, `DELIVERY_PREPROBE_MS`,
//     `DELIVERY_RECEIPT_SECONDS`, `receiptSecondsFor`) and `src/policy/types.ts`
//     (`DELIVERY_TIMEOUT_DEFAULTS.native`). Never re-parses policy YAML or introduces a second
//     independent timeout resolver.
//   - Resolves signed `deliveryTimeout` first, fails closed on `{ ok: false }`, and clamps any
//     optional `timeoutMs` override so it can only shorten (never lengthen or bypass) the signed
//     `native` budget.
//   - Counts caller route preparation (via `routeStartedAt` / `startedAt`, including when
//     `skipStage: true`), durable staging, local policy/session pre-validation, and optional
//     bounded `<= 400ms` live `thread/read` preprobe toward the overall `native` attempt deadline,
//     passing only `remainingTimeoutMs` to `codex queue`.
//   - Provides both:
//       1. `probeCodexNativeRoute`: synchronous local policy (`codex-daemon`), session binding
//          (`recordedSeatSession`), pointer (`pushPointer`), and `--remote` validation.
//       2. `probeCodexLiveReadiness`: bounded `<= 400ms` (`DELIVERY_PREPROBE_MS`) live readiness
//          probe against the Codex `0.161.0` app-server control socket
//          (`$CODEX_HOME/app-server-control/app-server-control.sock` or `unix://` `--remote`)
//          using the `thread/read` (`includeTurns: false`) RPC from `codex app-server generate-ts`
//          to classify `ready | would-hold | unavailable | refused`.
//   - Preserves `enqueue != delivered (read)`: `codex queue` exit `0` returns `outcome: 'enqueue'`
//     (daemon queue acceptance transport only, `receipt: { kind: 'maybe-consumed' }` on the
//     fallback-walk transport fact). Signed `<id>.read.json` receipt verification and user-facing
//     `read` vs `sent (unconfirmed)` classification stay in `src/commands/send.ts` (the send command).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { readTeamConfig } from '../../file/team-config.ts';
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
  DELIVERY_PREPROBE_MS,
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
import { isPresenceBinding } from '../../daemon/presence/contract.ts';
import { codexEndpointPath, inspectRecordedCodexEndpoint } from '../../daemon/presence/endpoint-record.ts';
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

/** Bounded live readiness preprobe budget in milliseconds (`400` ms from `DELIVERY_PREPROBE_MS`). */
export const CODEX_PREPROBE_TIMEOUT_MS = DELIVERY_PREPROBE_MS;

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
    preprobeTimeoutMs: number;
    precheck: 'local-policy-and-session-plus-optional-thread-read-rpc';
    liveProbeRpc: 'thread/read';
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
      preprobeTimeoutMs: CODEX_PREPROBE_TIMEOUT_MS,
      precheck: 'local-policy-and-session-plus-optional-thread-read-rpc',
      liveProbeRpc: 'thread/read',
      ack: false,
      proof: 'queue-accepted-only',
    },
    durableCopy: {
      supported: true,
    },
    limitations: [
      'probeCodexNativeRoute performs synchronous local validation only (codex-daemon policy, bound recordedSeatSession thread UUID, single-line pointer, and optional --remote URL).',
      'probeCodexLiveReadiness performs a bounded <=400ms WebSocket JSON-RPC thread/read (includeTurns: false) probe against the app-server control socket ($CODEX_HOME/app-server-control/app-server-control.sock or unix:// --remote), classifying the bound thread id exactly + idle + canAcceptDirectInput === true as ready, active or an explicit non-accept as would-hold, and any unknown, unbound, malformed or timed-out reading as unavailable.',
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

type SeatStateRead = { ok: true; state: SeatState | undefined } | { ok: false; why: string };

/**
 * The seat's own state record, read beside the team file that actually loads — a plain-folder or
 * custom-layout team keeps it elsewhere than `.agents`. A team file that cannot be read is not a
 * seat with no state: it is a hold, and the same for a state file that cannot be parsed.
 */
function readSeatState(root: string, home: string, session: string, seat: string): SeatStateRead {
  let dir: string;
  try {
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) {
      return {
        ok: false,
        why: `the team file could not be read, so the seat state folder cannot be resolved (${loaded.errors[0]?.message ?? 'unknown error'})`,
      };
    }
    dir = dirname(loaded.path);
  } catch (error) {
    return {
      ok: false,
      why: `the seat state folder could not be resolved (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!existsSync(join(dir, 'team.state.json'))) return { ok: true, state: undefined };
  try {
    return { ok: true, state: readState(dir).sessions[session]?.seats[seat] };
  } catch {
    return { ok: false, why: 'no trusted runtime session is recorded for this seat (seat state could not be read)' };
  }
}

/**
 * Synchronous local policy/session/pointer validation for the Codex `native` route (zero
 * child-process spawn): verifies `codex-daemon` signed policy (`on`), bound `recordedSeatSession`
 * (`src/registry/resume.ts`), opaque single-line pointer (`pushPointer`), and optional `--remote`
 * address.
 *
 * Does not probe live daemon/thread accepts/held state and does not enforce a 400ms live probe
 * timer; see `probeCodexLiveReadiness` for the bounded `<= 400ms` live `thread/read` RPC probe.
 * Called directly by `deliverCodexNativeRoute` and `probeCodexLiveReadiness`.
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
    const read = readSeatState(input.root, input.home, input.session, input.seat);
    if (!read.ok) return { status: 'unavailable', reason: read.why };
    binding = recordedSeatSession({
      home: input.home,
      root: input.root,
      herdrSession: input.session,
      seat: { name: input.seat, cli: 'codex' },
      state: read.state,
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

/**
 * Protocol types from `codex app-server generate-ts` (`v2/ThreadStatus.ts`, `v2/ThreadActiveFlag.ts`,
 * `v2/ThreadReadResponse.ts`) for the bounded `thread/read` readiness probe.
 */
export type CodexThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags?: readonly CodexThreadActiveFlag[] };

export type CodexThreadReadSnapshot = {
  id: string;
  status: CodexThreadStatus;
  canAcceptDirectInput?: boolean | null;
};

export type CodexThreadReadResult =
  | { ok: true; thread: CodexThreadReadSnapshot }
  | { ok: false; reason: string; timedOut?: boolean };

export type CodexThreadReadProbe = (input: {
  socketPath: string | null;
  remote?: string;
  threadId: string;
  timeoutMs: number;
  home: string;
}) => Promise<CodexThreadReadResult>;

/**
 * Resolves the Unix domain control socket path for the local Codex `0.161.0` app-server daemon:
 *   - `remote === undefined` or `remote === 'unix://'`: `<codexHome>/app-server-control/app-server-control.sock`
 *   - `remote === 'unix:///absolute/path.sock'`: `/absolute/path.sock`
 *   - `ws://` or `wss://`: returns `null` (not a local Unix socket).
 */
export function resolveCodexControlSocketPath(
  home: string,
  remote?: string,
  codexHome?: string,
): string | null {
  const baseCodexHome = codexHome ?? join(home, '.codex');
  if (remote === undefined || remote.trim() === '' || remote.trim() === 'unix://') {
    return join(baseCodexHome, 'app-server-control', 'app-server-control.sock');
  }
  const trimmed = remote.trim();
  if (trimmed.startsWith('unix:///')) {
    return trimmed.slice('unix://'.length);
  }
  return null;
}

/** One endpoint, resolved once: `socketPath` is the local socket both the readiness probe and
 *  the queue name (null for a ws/wss remote), `remote` the explicit `--remote` value the queue
 *  gets. A refusal says why the caller's options cannot name one endpoint. */
export type CodexAttemptEndpoint =
  | { ok: true; socketPath: string | null; remote: string | undefined }
  | { ok: false; why: string };

/** The one endpoint a `native` attempt binds both its readiness probe and its queue to: the
 *  caller's explicit socket, else the control socket under `CODEX_HOME` when the queue's own
 *  process names one, else the team home's `.codex`. A ws/wss remote has no local socket, so the
 *  remote itself stays the endpoint.
 *
 *  The queue process resolves its own relative names against the working directory it inherits,
 *  so a relative socket is named once, absolutely, from `cwd` before either operation runs — the
 *  probe reads the absolute socket and the queue is given the same absolute `unix://` URI. An
 *  explicit `remote` and an explicit socket that name different endpoints are refused: probing
 *  one app-server and enqueuing to another is the split this resolution exists to prevent. */
export function resolveCodexAttemptEndpoint(
  home: string,
  remote?: string,
  socketPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): CodexAttemptEndpoint {
  const codexHome = env.CODEX_HOME?.trim();
  const namedCodexHome = codexHome === undefined || codexHome === '' ? undefined : codexHome;
  const absolute = (path: string): string =>
    isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);

  if (socketPath !== undefined && socketPath !== null && remote !== undefined) {
    const remoteSocket = resolveCodexControlSocketPath(home, remote, namedCodexHome);
    if (remoteSocket === null) {
      return {
        ok: false,
        why: `the configured remote ${remote} names no local control socket, and a control socket was given; refusing to probe one endpoint and enqueue to another`,
      };
    }
    if (absolute(remoteSocket) !== absolute(socketPath)) {
      return {
        ok: false,
        why: `the configured remote names ${remoteSocket}, but the given control socket is ${socketPath}; refusing to probe one endpoint and enqueue to another`,
      };
    }
  }

  const named =
    socketPath !== undefined && socketPath !== null
      ? socketPath
      : resolveCodexControlSocketPath(home, remote, namedCodexHome);
  if (named === null) return { ok: true, socketPath: null, remote };
  const socket = absolute(named);
  return { ok: true, socketPath: socket, remote: `unix://${socket}` };
}

function encodeMaskedWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i]! ^ mask[i % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

/** A `thread/read` reply is small; a frame this large is malformed for this probe, not buffered. */
const MAX_SERVER_FRAME_BYTES = 1024 * 1024;

/** While the handshake is incomplete, anything past this is not a handshake this probe reads. */
const MAX_HANDSHAKE_BYTES = 16 * 1024;

function decodeServerWsFrames(buffer: Buffer): { frames: string[]; rest: Buffer; error?: string } {
  const frames: string[] = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    if ((first & 0x70) !== 0) {
      return {
        frames,
        rest: buffer.subarray(offset),
        error: 'codex app-server sent a WebSocket frame with reserved bits set',
      };
    }
    const opcode = first & 0x0f;
    if ((second & 0x80) !== 0) {
      return {
        frames,
        rest: buffer.subarray(offset),
        error: 'codex app-server sent a masked WebSocket frame',
      };
    }
    let payloadLen = second & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLen = buffer.readBigUInt64BE(offset + 2);
      if (bigLen > BigInt(MAX_SERVER_FRAME_BYTES)) {
        return {
          frames,
          rest: buffer.subarray(offset),
          error: 'codex app-server declared a WebSocket frame larger than this probe reads',
        };
      }
      payloadLen = Number(bigLen);
      headerLen = 10;
    }
    if (payloadLen > MAX_SERVER_FRAME_BYTES) {
      return {
        frames,
        rest: buffer.subarray(offset),
        error: 'codex app-server declared a WebSocket frame larger than this probe reads',
      };
    }
    const totalLen = headerLen + payloadLen;
    if (offset + totalLen > buffer.length) break;
    const payloadStart = offset + headerLen;
    if (opcode === 0x1) frames.push(buffer.subarray(payloadStart, payloadStart + payloadLen).toString('utf8'));
    offset += totalLen;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * Queries the Codex `0.161.0` app-server control socket over WebSocket JSON-RPC 2.0 using
 * `initialize` -> `initialized` -> `thread/read` (`{ threadId, includeTurns: false }`) within a
 * hard `timeoutMs` (`<= 400ms`) deadline.
 */
export function queryCodexAppServerThreadRead(input: {
  socketPath: string | null;
  remote?: string;
  threadId: string;
  timeoutMs?: number;
  home: string;
}): Promise<CodexThreadReadResult> {
  const budgetMs = Math.max(1, Math.min(CODEX_PREPROBE_TIMEOUT_MS, Math.round(input.timeoutMs ?? CODEX_PREPROBE_TIMEOUT_MS)));
  const socketPath = input.socketPath ?? resolveCodexControlSocketPath(input.home, input.remote);
  if (socketPath === null) {
    return Promise.resolve({
      ok: false,
      reason: 'live thread/read preprobe requires a unix:// app-server control socket or injected liveProbe',
    });
  }
  if (!existsSync(socketPath)) {
    return Promise.resolve({
      ok: false,
      reason: 'codex app-server control socket is not listening (ENOENT)',
    });
  }

  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let upgraded = false;
    let initSent = false;
    let readSent = false;
    let buffer: Buffer = Buffer.alloc(0);
    const secKey = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1')
      .update(`${secKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const done = (result: CodexThreadReadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      done({
        ok: false,
        timedOut: true,
        reason: `codex app-server thread/read probe timed out after ${String(budgetMs)}ms`,
      });
    }, budgetMs);

    socket.on('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'error';
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') {
        done({
          ok: false,
          reason: `codex app-server control socket is not listening (${code})`,
        });
        return;
      }
      done({
        ok: false,
        reason: `codex app-server control socket failed (${code})`,
      });
    });

    socket.on('close', () => {
      if (!settled) {
        done({
          ok: false,
          reason: 'codex app-server control socket closed before thread/read completed',
        });
      }
    });

    socket.on('connect', () => {
      const req = [
        'GET /rpc HTTP/1.1',
        'Host: localhost',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${secKey}`,
        '',
        '',
      ].join('\r\n');
      socket.write(req);
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (buffer.length > MAX_HANDSHAKE_BYTES) {
            done({
              ok: false,
              reason: 'codex app-server WebSocket handshake is larger than this probe reads',
            });
          }
          return;
        }
        const headerText = buffer.subarray(0, headerEnd).toString('utf8');
        buffer = buffer.subarray(headerEnd + 4);
        const accept = /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(headerText)?.[1];
        if (!/^HTTP\/1\.1 101\b/i.test(headerText) || accept !== expectedAccept) {
          done({
            ok: false,
            reason: 'codex app-server control socket rejected WebSocket upgrade',
          });
          return;
        }
        upgraded = true;
        if (!initSent) {
          initSent = true;
          socket.write(
            encodeMaskedWsTextFrame(
              JSON.stringify({
                id: 'initialize',
                method: 'initialize',
                params: {
                  clientInfo: { name: 'teamcli', title: null, version: '0.1.0' },
                  capabilities: {
                    experimentalApi: true,
                    requestAttestation: false,
                    optOutNotificationMethods: null,
                  },
                },
              }),
            ),
          );
        }
      }

      const decoded = decodeServerWsFrames(buffer);
      buffer = decoded.rest;
      if (decoded.error !== undefined) {
        done({ ok: false, reason: decoded.error });
        return;
      }
      if (buffer.length > MAX_SERVER_FRAME_BYTES + 16) {
        done({
          ok: false,
          reason: 'codex app-server sent more WebSocket data than this probe reads',
        });
        return;
      }
      for (const raw of decoded.frames) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          done({ ok: false, reason: 'codex app-server returned invalid JSON on thread/read probe' });
          return;
        }
        if (msg.id === 'initialize') {
          if (msg.error !== undefined && msg.error !== null) {
            done({ ok: false, reason: 'codex app-server rejected initialize on thread/read probe' });
            return;
          }
          if (!readSent) {
            readSent = true;
            socket.write(encodeMaskedWsTextFrame(JSON.stringify({ method: 'initialized' })));
            socket.write(
              encodeMaskedWsTextFrame(
                JSON.stringify({
                  id: 'thread_read',
                  method: 'thread/read',
                  params: { threadId: input.threadId, includeTurns: false },
                }),
              ),
            );
          }
        } else if (msg.id === 'thread_read') {
          if (msg.error !== undefined && msg.error !== null) {
            const errObj = msg.error as { message?: unknown };
            const errMsg = typeof errObj.message === 'string' ? errObj.message : 'thread/read error';
            done({ ok: false, reason: `codex app-server thread/read refused: ${errMsg}` });
            return;
          }
          const result = msg.result as { thread?: CodexThreadReadSnapshot } | undefined;
          const thread = result?.thread;
          if (!thread || typeof thread.id !== 'string' || !thread.status || typeof thread.status.type !== 'string') {
            done({ ok: false, reason: 'codex app-server thread/read response is missing thread status' });
            return;
          }
          done({ ok: true, thread });
          return;
        }
      }
    });
  });
}

export type CodexLiveProbeInput = CodexNativeProbeInput & {
  /** Maximum probe deadline in ms; clamped to `<= CODEX_PREPROBE_TIMEOUT_MS` (`400ms`). */
  timeoutMs?: number;
  /** Optional explicit control socket path override. */
  socketPath?: string | null;
  /** Optional injected `thread/read` RPC probe seam. */
  liveProbe?: CodexThreadReadProbe;
};

export type CodexLiveReadinessOutcome =
  | {
      status: 'ready';
      threadId: string;
      pointer: string;
      recorded: RecordedSeatSession;
      threadStatus: 'idle';
      canAcceptDirectInput: boolean | null;
    }
  | {
      status: 'would-hold';
      threadId: string;
      pointer: string;
      recorded: RecordedSeatSession;
      reason: string;
      threadStatus: 'active' | 'idle';
      activeFlags: readonly CodexThreadActiveFlag[];
      canAcceptDirectInput: boolean | null;
    }
  | {
      status: 'unavailable' | 'refused';
      reason: string;
      timedOut?: boolean;
    };

/**
 * Runs one `thread/read` probe under a hard deadline. `queryCodexAppServerThreadRead` owns its
 * own socket timer, but an injected probe is only a promise: this deadline covers it too, so a
 * probe that never settles, or one that throws or rejects, reads as unavailable rather than
 * escaping the `<= 400ms` readiness budget.
 */
async function probeThreadReadWithinBudget(
  probeFn: CodexThreadReadProbe,
  request: Parameters<CodexThreadReadProbe>[0],
  budgetMs: number,
): Promise<CodexThreadReadResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: CodexThreadReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        reason: `codex app-server thread/read probe timed out after ${String(budgetMs)}ms`,
      });
    }, budgetMs);
    let pending: Promise<CodexThreadReadResult>;
    try {
      pending = probeFn(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({ ok: false, reason: `codex app-server thread/read probe failed: ${message}` });
      return;
    }
    void pending.then(
      (result) => finish(result),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        finish({ ok: false, reason: `codex app-server thread/read probe failed: ${message}` });
      },
    );
  });
}

/**
 * Bounded `<= 400ms` (`DELIVERY_PREPROBE_MS`) live readiness probe for the Codex `native` route:
 *   1. Runs synchronous `probeCodexNativeRoute` for `codex-daemon` policy, bound `recordedSeatSession`,
 *      single-line pointer, and `--remote` validation.
 *   2. Queries `thread/read` (`includeTurns: false`) on the app-server control socket within
 *      `Math.min(400ms, timeoutMs)`, under a hard deadline that covers an injected probe too:
 *      - the response's `thread.id` exactly the bound thread id, `thread.status.type === 'idle'`
 *        exactly, and `canAcceptDirectInput === true` -> `'ready'`
 *      - `thread.status.type === 'active'` (running turn or waitingOnApproval/waitingOnUserInput)
 *        or an idle thread with `canAcceptDirectInput === false` -> `'would-hold'`
 *      - any other thread id, any other or unrecognised status, a missing or null direct-accepts
 *        reading, `notLoaded`/`systemError`, socket missing/error, a malformed handshake or
 *        WebSocket frame, or the hard `<= 400ms` deadline -> `'unavailable'`
 */
export async function probeCodexLiveReadiness(
  input: CodexLiveProbeInput,
): Promise<CodexLiveReadinessOutcome> {
  const local = probeCodexNativeRoute(input);
  if (local.status !== 'ready') {
    return local;
  }

  if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
    return {
      status: 'unavailable',
      timedOut: true,
      reason: 'codex native preprobe budget exhausted before live thread/read probe',
    };
  }

  const probeTimeoutMs = Math.max(
    1,
    Math.min(CODEX_PREPROBE_TIMEOUT_MS, Math.round(input.timeoutMs ?? CODEX_PREPROBE_TIMEOUT_MS)),
  );
  const socketPath =
    input.socketPath !== undefined
      ? input.socketPath
      : resolveCodexControlSocketPath(input.home, input.remote);

  const probeFn = input.liveProbe ?? queryCodexAppServerThreadRead;
  const read = await probeThreadReadWithinBudget(
    probeFn,
    {
      socketPath,
      ...(input.remote !== undefined ? { remote: input.remote } : {}),
      threadId: local.threadId,
      timeoutMs: probeTimeoutMs,
      home: input.home,
    },
    probeTimeoutMs,
  );

  if (!read.ok) {
    return {
      status: 'unavailable',
      reason: read.reason,
      ...(read.timedOut === true ? { timedOut: true } : {}),
    };
  }

  const thread = read.thread as CodexThreadReadSnapshot | undefined;
  if (!thread || typeof thread.id !== 'string' || !thread.status || typeof thread.status.type !== 'string') {
    return {
      status: 'unavailable',
      reason: 'codex app-server thread/read response is missing thread status',
    };
  }
  // The answer must be the thread this route bound, exactly: a reply for another thread says
  // nothing about this one, and a missing or different id is never read as ready.
  if (thread.id !== local.threadId) {
    return {
      status: 'unavailable',
      reason: `codex app-server answered for thread ${thread.id}, not the bound thread ${local.threadId}`,
    };
  }
  const statusType: string = thread.status.type;
  if (statusType === 'notLoaded' || statusType === 'systemError') {
    return {
      status: 'unavailable',
      reason: `codex thread ${local.threadId} is ${statusType} on the app-server daemon`,
    };
  }

  if (statusType === 'active') {
    const status = thread.status as Extract<CodexThreadStatus, { type: 'active' }>;
    const flags = status.activeFlags ?? [];
    const flagNote = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    return {
      status: 'would-hold',
      threadId: local.threadId,
      pointer: local.pointer,
      recorded: local.recorded,
      reason: `codex thread ${local.threadId} is active${flagNote}; codex queue would hold the message`,
      threadStatus: 'active',
      activeFlags: flags,
      canAcceptDirectInput: thread.canAcceptDirectInput ?? null,
    };
  }

  // Any status this build does not know is not a readiness answer: unknown reads as unavailable.
  if (statusType !== 'idle') {
    return {
      status: 'unavailable',
      reason: `codex thread ${local.threadId} reports the unrecognised status "${statusType}" on the app-server daemon`,
    };
  }

  if (thread.canAcceptDirectInput === false) {
    return {
      status: 'would-hold',
      threadId: local.threadId,
      pointer: local.pointer,
      recorded: local.recorded,
      reason: `codex thread ${local.threadId} does not currently accept direct turn input; codex queue would hold the message`,
      threadStatus: 'idle',
      activeFlags: [],
      canAcceptDirectInput: false,
    };
  }

  // Ready means idle and an explicit yes: a missing or null direct-accepts reading is unknown,
  // never assumed to accept.
  if (thread.canAcceptDirectInput !== true) {
    return {
      status: 'unavailable',
      reason: `codex thread ${local.threadId} does not report whether it accepts direct input; readiness is unknown`,
    };
  }

  return {
    status: 'ready',
    threadId: local.threadId,
    pointer: local.pointer,
    recorded: local.recorded,
    threadStatus: 'idle',
    canAcceptDirectInput: true,
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
   * Timestamp (ms or Date) when the caller began preparing the `native` route attempt (including
   * caller-side staging / policy resolution when `skipStage: true`). Elapsed time from
   * `routeStartedAt` (defaulting to `startedAt ?? now().getTime()`) counts toward the overall
   * `native` attempt deadline (`budget.timeoutMs`), so pre-validation, optional live preprobe, and
   * `codex queue` only receive the remaining budget.
   */
  routeStartedAt?: number | Date;
  /**
   * Optional start timestamp (`startedAt` in `runSend`) used to compute `walkAttempt.ms` and,
   * when `routeStartedAt` is omitted, the start of the `native` route budget window.
   */
  startedAt?: number;
  /**
   * When true, skips calling `relayStage` (used when the caller already staged the record under
   * the seat lock immediately prior to this call). Caller preparation since `routeStartedAt` /
   * `startedAt` still counts against `budget.timeoutMs`.
   */
  skipStage?: boolean;
  /**
   * Optional bounded (`<= 400ms`) live `thread/read` readiness probe (`true` to query the local
   * app-server control socket, or a `CodexThreadReadProbe` function). When enabled, `would-hold`
   * and `unavailable` outcomes abort before `codex queue` is spawned so the delivery walk can
   * advance to the next route.
   */
  liveProbe?: boolean | CodexThreadReadProbe;
  /** Optional explicit control socket path for `liveProbe`. */
  socketPath?: string | null;
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
      wouldHold?: boolean;
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
 *      before the transport attempt (or reuses the caller's staged record when `skipStage: true`,
 *      still counting caller preparation since `routeStartedAt` / `startedAt` toward the overall
 *      attempt deadline).
 *   3. Runs synchronous local policy/session/pointer pre-validation via `probeCodexNativeRoute`
 *      (and, when `options.liveProbe` is set, the bounded `<= 400ms` live `thread/read` readiness
 *      probe via `probeCodexLiveReadiness`).
 *   4. Deducts elapsed preparation + preprobe time from the overall attempt budget and passes only
 *      the remaining `remainingTimeoutMs` budget to `codex queue`.
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
  const entryMs = nowFn().getTime();
  const suppliedRouteStart =
    options.routeStartedAt instanceof Date ? options.routeStartedAt.getTime() : options.routeStartedAt;
  const routeStartedAtMs = suppliedRouteStart ?? options.startedAt ?? entryMs;
  const startedAt =
    options.startedAt !== undefined && Number.isFinite(options.startedAt)
      ? options.startedAt
      : (Number.isFinite(routeStartedAtMs) ? routeStartedAtMs : entryMs);
  const liveRoutesRemain = options.liveRoutesRemain ?? true;
  // A route start time this build cannot trust never grants a fresh budget: an unreadable one
  // (NaN) or one in the future would otherwise read as zero elapsed. Rejected before staging.
  const routeStartProblem =
    !Number.isFinite(routeStartedAtMs)
      ? 'the native route start time is not a valid instant; refusing to grant a fresh attempt budget'
      : routeStartedAtMs > entryMs
        ? `the native route start time is ${String(routeStartedAtMs - entryMs)}ms in the future; refusing to grant a fresh attempt budget`
        : null;
  if (routeStartProblem !== null) {
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unsupported',
      reason: routeStartProblem,
      walkAttempt: buildWalkAttempt(
        'unreachable',
        liveRoutesRemain,
        new Date(entryMs),
        startedAt,
        routeStartProblem,
        { kind: 'unknown' },
      ),
    };
  }

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

  // A managed Codex launch records the app-server it owns on the seat's state record, keyed to
  // the seat's current presence binding. That record is the one endpoint this seat's thread can
  // be reached at: when it is usable, the probe and the queue both take its URL exactly, never the
  // shared control socket or a home-derived path. On a managed seat an absent or unusable record
  // holds — a launch that could not record its socket is unproven, not legacy — while a seat with
  // no managed binding and no record keeps today's measured behavior. An explicit remote or
  // socket that names another endpoint is refused rather than split across two daemons.
  const seatState = readSeatState(target.root, target.home, target.session, target.seat);
  if (!seatState.ok) {
    const at = nowFn();
    const reason = `the seat state could not be read, so its recorded Codex endpoint cannot be checked (${seatState.why})`;
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unreachable',
      reason,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, reason, {
        kind: 'stored',
        id: message.id,
      }),
    };
  }
  const presenceBinding = seatState.state?.presence_binding;
  const recorded = inspectRecordedCodexEndpoint(seatState.state?.codex_endpoint, presenceBinding);
  let recordedRemote: string | undefined;
  if (recorded.kind === 'invalid') {
    const at = nowFn();
    const reason = `the seat's recorded Codex endpoint cannot be used (${recorded.why}); refusing the shared app-server path`;
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unreachable',
      reason,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, reason, {
        kind: 'stored',
        id: message.id,
      }),
    };
  }
  if (recorded.kind === 'ok') {
    recordedRemote = recorded.record.url;
    if (target.remote !== undefined) {
      const named = resolveCodexControlSocketPath(target.home, target.remote);
      const recordedPath = codexEndpointPath(recorded.record);
      if (named === null || recordedPath === null || resolvePath(named) !== resolvePath(recordedPath)) {
        const at = nowFn();
        const reason = `the explicit remote ${target.remote} names another endpoint than the seat's recorded ${recorded.record.url}; refusing to probe one and enqueue to another`;
        return {
          route: CODEX_NATIVE_ROUTE,
          outcome: 'unsupported',
          reason,
          receipt: copyReceipt,
          walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, reason, {
            kind: 'stored',
            id: message.id,
          }),
        };
      }
    }
  } else if (isPresenceBinding(presenceBinding)) {
    const at = nowFn();
    const reason = 'the managed seat records no Codex endpoint its launch wrote; refusing the shared app-server path';
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unreachable',
      reason,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, reason, {
        kind: 'stored',
        id: message.id,
      }),
    };
  }

  // The endpoint a live probe reads is the one the queue below is given. Left to their own
  // defaults the two can name different daemons: the probe reads the team home's `.codex` while
  // `codex queue` reads the queue process's inherited `CODEX_HOME`. A contradictory pair of
  // options is refused here, before either operation, rather than probing one endpoint and
  // enqueuing to the other. A recorded managed endpoint replaces both defaults with itself.
  const endpoint = resolveCodexAttemptEndpoint(target.home, recordedRemote ?? target.remote, options.socketPath);
  if (!endpoint.ok) {
    const at = nowFn();
    return {
      route: CODEX_NATIVE_ROUTE,
      outcome: 'unsupported',
      reason: endpoint.why,
      receipt: copyReceipt,
      walkAttempt: buildWalkAttempt('unreachable', liveRoutesRemain, at, startedAt, endpoint.why, {
        kind: 'stored',
        id: message.id,
      }),
    };
  }
  if (options.liveProbe !== undefined && options.liveProbe !== false) {
    const elapsedBeforeProbeMs = Math.max(0, nowFn().getTime() - routeStartedAtMs);
    const remainingBeforeProbeMs = budget.timeoutMs - elapsedBeforeProbeMs;
    if (remainingBeforeProbeMs <= 0) {
      const at = nowFn();
      const reason = `codex queue timed out before live probe (${String(budget.timeoutMs)}ms attempt budget exhausted during preparation)`;
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

    const live = await probeCodexLiveReadiness({
      root: target.root,
      home: target.home,
      session: target.session,
      seat: target.seat,
      id: message.id,
      sender: target.sender,
      pointer: precheck.pointer,
      agentSession: precheck.threadId,
      ...(endpoint.remote !== undefined ? { remote: endpoint.remote } : {}),
      codexDaemon: 'on',
      sessionBinding: { kind: 'bound', recorded: precheck.recorded },
      timeoutMs: Math.min(CODEX_PREPROBE_TIMEOUT_MS, remainingBeforeProbeMs),
      socketPath: endpoint.socketPath,
      ...(typeof options.liveProbe === 'function' ? { liveProbe: options.liveProbe } : {}),
    });

    if (live.status !== 'ready') {
      const at = nowFn();
      const timedOut = live.status !== 'would-hold' && live.timedOut === true;
      const wouldHold = live.status === 'would-hold';
      const outcome = live.status === 'refused' ? 'unsupported' : 'unreachable';
      return {
        route: CODEX_NATIVE_ROUTE,
        outcome,
        reason: live.reason,
        ...(timedOut ? { timedOut: true } : {}),
        ...(wouldHold ? { wouldHold: true } : {}),
        receipt: copyReceipt,
        walkAttempt: buildWalkAttempt(
          timedOut ? 'timeout' : 'unreachable',
          liveRoutesRemain,
          at,
          startedAt,
          live.reason,
          { kind: 'stored', id: message.id },
        ),
      };
    }
  }

  const elapsedMs = Math.max(0, nowFn().getTime() - routeStartedAtMs);
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

  const queueRemote = endpoint.remote;
  const adapter =
    options.adapter
    ?? codexPushAdapter({
      ...(options.binary !== undefined ? { binary: options.binary } : {}),
      ...(queueRemote !== undefined ? { remote: queueRemote } : {}),
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
