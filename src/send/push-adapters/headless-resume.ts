// Headless one-turn session resume adapter and relay bridge for Gemini (`0.64.0`, `gemini`) and
// Cursor (`2026.10.16`, `cursor-agent`) seats on the `headless-resume` delivery leg.
//
// Invariants enforced here:
//   - Requires a trusted session binding resolved via `recordedSeatSession` (`src/registry/resume.ts`)
//     where `team.state.json` (read beside `loadTeamFile(root, { home })`) and the agent registry
//     record (`agents/<id>.yaml` `reach.agent_session`) agree on the exact session token. Never
//     opens or inspects owner CLI homes (`~/.gemini`, `~/.cursor`, `~/.claude`, `~/.codex`,
//     `~/.grok`, `~/.config/muse`) and never guesses a session id from a seat name, herdr session,
//     or `"latest"`.
//   - Measured CLI invocations (`gemini --help` on `0.64.0` + `src/profiles/gemini.yaml`, and
//     `cursor-agent --help` on `2026.10.16-e3cb207` + `src/profiles/cursor.yaml`):
//       * `gemini`: `gemini --approval-mode yolo --resume <session_id> -p <pointer>`
//       * `cursor`: `cursor-agent --force --sandbox disabled --approve-mcps --trust --resume <session_id> -p <pointer>`
//     Both run with `AGENT_UNATTENDED=1`, `stdio: ['ignore', 'pipe', 'pipe']`, in the seat's
//     working directory (`target.cwd ?? target.root`).
//   - Forwards the single-line signed-record pointer (`pushPointer(id, sender)`) verbatim and
//     unchanged (`<= TRIGGER_MAX` chars, no newlines or NUL bytes). Never carries or substitutes a
//     message body.
//   - Resolves signed `deliveryTimeout` (`budgets.native` = 15s default from
//     `DELIVERY_TIMEOUT_DEFAULTS.native`) first, fails closed on `{ ok: false }`, clamps any
//     optional `timeoutMs` override so it can only shorten, and deducts elapsed preparation time
//     since `routeStartedAt` / `startedAt` before spawning.
//   - Preserves `enqueue != delivered (read)`: process exit `0` returns `outcome: 'enqueue'`
//     (headless turn invocation completed, `receipt: { kind: 'maybe-consumed' }` on the
//     fallback-walk transport fact). Signed `<id>.read.json` receipt verification and user-facing
//     `delivered (read)` vs `sent (unconfirmed)` classification stay in `src/commands/send.ts`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTeamConfig } from '../../file/team-config.ts';
import {
  stage as relayStage,
  type CopyTarget,
  type RelayReceipt as PackageRelayReceipt,
} from '../../../packages/relay/index.js';
import {
  DELIVERY_RECEIPT_SECONDS,
  receiptSecondsFor,
  type DeliveryTimeoutInForce,
} from '../../policy/delivery.ts';
import {
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
  type RuntimePushRequest,
} from '../push.ts';

/** Canonical leg name in `DELIVERY_LEGS`. */
export const HEADLESS_RESUME_ROUTE = 'headless-resume' as const;

/** CLI profiles supported by the `headless-resume` runtime in this build. */
export const HEADLESS_RESUME_CLIS = ['gemini', 'cursor'] as const;
export type HeadlessResumeCli = (typeof HEADLESS_RESUME_CLIS)[number];

/** Default attempt budget for the `headless-resume` route in milliseconds (`15_000` ms). */
export const HEADLESS_RESUME_TIMEOUT_MS = DELIVERY_TIMEOUT_DEFAULTS.native * 1000;

/** Post-submit read-receipt `--wait` window in seconds (`120` s from `DELIVERY_RECEIPT_SECONDS`). */
export const HEADLESS_RESUME_RECEIPT_TIMEOUT_SECONDS = DELIVERY_RECEIPT_SECONDS;

/** Reason recorded when a seat's CLI has no headless-resume runtime in this build. */
export const HEADLESS_RESUME_UNAVAILABLE_REASON =
  'this build carries no headless resume runtime';

export function isHeadlessResumeCli(cli: string): cli is HeadlessResumeCli {
  return (HEADLESS_RESUME_CLIS as readonly string[]).includes(cli);
}

/**
 * Default binary for a supported `headless-resume` CLI profile (`src/profiles/gemini.yaml` and
 * `src/profiles/cursor.yaml`).
 */
export function headlessResumeBinaryFor(cli: HeadlessResumeCli): string {
  return cli === 'gemini' ? 'gemini' : 'cursor-agent';
}

/**
 * Builds the measured non-interactive one-turn resume argument list for a `gemini` (`0.64.0`) or
 * `cursor` (`2026.10.16`) seat:
 *   - `gemini`: `['--approval-mode', 'yolo', '--resume', sessionId, '-p', pointer]`
 *   - `cursor`: `['--force', '--sandbox', 'disabled', '--approve-mcps', '--trust', '--resume', sessionId, '-p', pointer]`
 */
export function buildHeadlessResumeArgs(
  cli: HeadlessResumeCli,
  sessionId: string,
  pointer: string,
): readonly string[] {
  if (cli === 'gemini') {
    return ['--approval-mode', 'yolo', '--resume', sessionId, '-p', pointer];
  }
  return [
    '--force',
    '--sandbox',
    'disabled',
    '--approve-mcps',
    '--trust',
    '--resume',
    sessionId,
    '-p',
    pointer,
  ];
}

export type HeadlessResumeCapabilities = {
  route: 'headless-resume';
  clis: readonly ['gemini', 'cursor'];
  timeoutMs: number;
  ack: false;
  proof: 'process-exit-0-only';
  profiles: {
    gemini: {
      version: string;
      binary: 'gemini';
      command: readonly [
        'gemini',
        '--approval-mode',
        'yolo',
        '--resume',
        '<agent_session>',
        '-p',
        '<pointer>',
      ];
    };
    cursor: {
      version: string;
      binary: 'cursor-agent';
      command: readonly [
        'cursor-agent',
        '--force',
        '--sandbox',
        'disabled',
        '--approve-mcps',
        '--trust',
        '--resume',
        '<agent_session>',
        '-p',
        '<pointer>',
      ];
    };
  };
  limitations: readonly string[];
};

/**
 * Pure, synchronous, zero-I/O capability descriptor for the Gemini (`0.64.0`) and Cursor
 * (`2026.10.16`) `headless-resume` bridge.
 */
export function headlessResumeCapabilities(
  versions: { gemini?: string; cursor?: string } = {},
): HeadlessResumeCapabilities {
  return {
    route: HEADLESS_RESUME_ROUTE,
    clis: HEADLESS_RESUME_CLIS,
    timeoutMs: HEADLESS_RESUME_TIMEOUT_MS,
    ack: false,
    proof: 'process-exit-0-only',
    profiles: {
      gemini: {
        version: versions.gemini ?? '0.64.0',
        binary: 'gemini',
        command: [
          'gemini',
          '--approval-mode',
          'yolo',
          '--resume',
          '<agent_session>',
          '-p',
          '<pointer>',
        ],
      },
      cursor: {
        version: versions.cursor ?? '2026.10.16',
        binary: 'cursor-agent',
        command: [
          'cursor-agent',
          '--force',
          '--sandbox',
          'disabled',
          '--approve-mcps',
          '--trust',
          '--resume',
          '<agent_session>',
          '-p',
          '<pointer>',
        ],
      },
    },
    limitations: [
      'Supports gemini (0.64.0) and cursor (2026.10.16) seats only; other CLIs report that this build carries no headless resume runtime.',
      'Requires a bound recordedSeatSession (team.state.json + agents/<id>.yaml reach.agent_session); never inspects owner CLI homes (~/.gemini, ~/.cursor) and rejects unbound, mismatched, flag-like, or "latest" session tokens without spawning.',
      'Process exit 0 proves headless turn invocation only (receipt: maybe-consumed), never read confirmation; signed <id>.read.json verification stays in the sender walk (send.ts).',
    ],
  };
}

export type ResolvedHeadlessResumeBudget =
  | { ok: true; timeoutMs: number; attemptSeconds: number }
  | { ok: false; why: string };

/**
 * Resolves the signed `DeliveryTimeoutInForce` (from `deliveryTimeoutInForce` in
 * `src/policy/delivery.ts`), a route-budget map (`seconds`), or a milliseconds number first,
 * rejects any failed signed result (`{ ok: false }`), and clamps any optional `overrideTimeoutMs`
 * so an override can only shorten (never lengthen or bypass) the signed attempt budget.
 */
export function resolveHeadlessResumeAttemptTimeoutMs(
  resolved?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number,
  overrideTimeoutMs?: number,
): ResolvedHeadlessResumeBudget {
  let baseTimeoutMs = HEADLESS_RESUME_TIMEOUT_MS;
  let baseAttemptSeconds: number = DELIVERY_TIMEOUT_DEFAULTS.native;

  if (resolved !== undefined) {
    if (typeof resolved === 'number') {
      if (!Number.isFinite(resolved) || resolved <= 0) {
        return { ok: false, why: 'the headless-resume attempt timeout budget must be above 0ms' };
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
        return { ok: false, why: 'the headless-resume attempt timeout budget must be above 0s' };
      }
      baseTimeoutMs = Math.round(seconds * 1000);
      baseAttemptSeconds = seconds;
    }
  }

  if (overrideTimeoutMs !== undefined) {
    if (typeof overrideTimeoutMs !== 'number' || !Number.isFinite(overrideTimeoutMs) || overrideTimeoutMs <= 0) {
      return { ok: false, why: 'the headless-resume attempt timeout override must be above 0ms' };
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

export type HeadlessResumeSpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type HeadlessResumeSpawn = (
  binary: string,
  args: readonly string[],
  options: { timeoutMs: number; cwd?: string },
) => Promise<HeadlessResumeSpawnResult> | HeadlessResumeSpawnResult;

/**
 * Default non-blocking process runner for headless one-turn resume (`gemini` / `cursor-agent`).
 * Never reads or passes owner CLI homes directly; stdin is closed immediately, `AGENT_UNATTENDED=1`
 * is set in the environment, and stdout/stderr are collected up to `timeoutMs`.
 */
export const defaultHeadlessResumeSpawn: HeadlessResumeSpawn = (binary, args, options) =>
  new Promise<HeadlessResumeSpawnResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: HeadlessResumeSpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(binary, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...process.env, AGENT_UNATTENDED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        status: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: Error) => {
      finish({ status: null, stdout, stderr, error });
    });

    child.on('close', (code: number | null) => {
      finish({ status: code, stdout, stderr });
    });

    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Process already exited.
      }
      finish({
        status: null,
        stdout,
        stderr,
        error: new Error(`timed out after ${String(options.timeoutMs)}ms`),
      });
    }, options.timeoutMs);
  });

type SeatStateRead = { ok: true; state: SeatState | undefined } | { ok: false; why: string };

/**
 * Reads the seat's state record beside the team file that loads for `root` (`.agents/team.state.json`
 * or custom layout), failing closed when the team file or `team.state.json` cannot be read.
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
    return {
      ok: false,
      why: 'no trusted runtime session is recorded for this seat (seat state could not be read)',
    };
  }
}

export type HeadlessResumeProbeInput = {
  cli: string;
  root: string;
  home: string;
  session: string;
  seat: string;
  id: string;
  sender: PushSender;
  pointer?: string | null;
  agentSession?: string | null;
  /** Optional explicit binary override for `gemini` or `cursor-agent`. */
  binary?: string;
  /** Optional already-resolved session binding from `recordedSeatSession`. */
  sessionBinding?: RecordedSeatSessionRead;
};

export type HeadlessResumeProbeOutcome =
  | {
      status: 'ready';
      cli: HeadlessResumeCli;
      binary: string;
      args: readonly string[];
      sessionId: string;
      pointer: string;
      recorded: RecordedSeatSession;
    }
  | {
      status: 'unsupported' | 'unavailable' | 'refused';
      reason: string;
    };

/**
 * Synchronous local pre-validation for the `headless-resume` route (zero child-process spawn):
 * verifies that `input.cli` is `'gemini'` or `'cursor'`, validates the single-line signed-sender
 * pointer (`pushPointer`), and verifies the bound `recordedSeatSession` (`src/registry/resume.ts`).
 */
export function probeHeadlessResumeRoute(
  input: HeadlessResumeProbeInput,
): HeadlessResumeProbeOutcome {
  if (!isHeadlessResumeCli(input.cli)) {
    return {
      status: 'unsupported',
      reason: HEADLESS_RESUME_UNAVAILABLE_REASON,
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
      seat: { name: input.seat, cli: input.cli },
      state: read.state,
    });
  }

  if (binding.kind !== 'bound') {
    return {
      status: 'unavailable',
      reason:
        binding.kind === 'none' && binding.why === 'no agent record for this seat' && input.agentSession == null
          ? 'no runtime session is recorded for this seat'
          : `no trusted runtime session is recorded for this seat (${binding.why})`,
    };
  }

  if (binding.recorded.cli !== input.cli) {
    return {
      status: 'unavailable',
      reason: `no trusted runtime session is recorded for this seat (the record ran ${binding.recorded.cli}, the seat now declares ${input.cli})`,
    };
  }

  if (
    input.agentSession !== undefined
    && input.agentSession !== null
    && input.agentSession.trim() !== ''
    && input.agentSession.trim() !== binding.recorded.sessionId
  ) {
    return {
      status: 'unavailable',
      reason: 'the seat state and the agent record name different sessions',
    };
  }

  const sessionId = binding.recorded.sessionId.trim();
  if (sessionId === '') {
    return { status: 'unavailable', reason: 'no runtime session is recorded for this seat' };
  }
  if (
    sessionId.startsWith('-')
    || /[\s\0]/.test(sessionId)
    || sessionId.toLowerCase() === 'latest'
  ) {
    return {
      status: 'unavailable',
      reason: 'the recorded runtime session is not a valid session id',
    };
  }

  const binary = input.binary ?? headlessResumeBinaryFor(input.cli);
  const args = buildHeadlessResumeArgs(input.cli, sessionId, pointer);

  return {
    status: 'ready',
    cli: input.cli,
    binary,
    args,
    sessionId,
    pointer,
    recorded: binding.recorded,
  };
}

function singleLineDetail(stderr: string, stdout: string, status: number | null): string {
  const raw = stderr.trim() || stdout.trim();
  if (raw === '') return `exit ${String(status)}`;
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
  return firstLine === '' ? `exit ${String(status)}` : firstLine;
}

const UNSUPPORTED_OPTION_RE = /\b(unknown|unrecognized)\s+(subcommand|command|option|argument|flag)\b/i;

export type HeadlessResumeAdapterOptions = {
  /** Target CLI profile (`'gemini'` or `'cursor'`). */
  cli: HeadlessResumeCli;
  /** Optional binary name or path override; defaults to `'gemini'` or `'cursor-agent'`. */
  binary?: string;
  /** Optional working directory for the spawned headless process; defaults to `request.root`. */
  cwd?: string;
  /** Optional per-request session-binding resolver; defaults to `recordedSeatSession`. */
  resolveSession?: (request: RuntimePushRequest) => RecordedSeatSessionRead;
  /** Injectable process runner for deterministic synthetic fixture tests. */
  spawn?: HeadlessResumeSpawn;
  /** Per-call timeout in milliseconds; defaults to `HEADLESS_RESUME_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Builds the `RuntimePushAdapter` for a `'gemini'` (`0.64.0`) or `'cursor'` (`2026.10.16`) seat on
 * the `headless-resume` leg.
 */
export function headlessResumePushAdapter(
  options: HeadlessResumeAdapterOptions,
): RuntimePushAdapter {
  const cli = options.cli;
  const runSpawn = options.spawn ?? defaultHeadlessResumeSpawn;
  const defaultTimeoutMs = options.timeoutMs ?? HEADLESS_RESUME_TIMEOUT_MS;

  return {
    clis: [cli] as const,
    async push(request: RuntimePushRequest): Promise<RuntimePushOutcome> {
      const precheck = probeHeadlessResumeRoute({
        cli,
        root: request.root,
        home: request.home,
        session: request.session,
        seat: request.seat,
        id: request.id,
        sender: request.sender,
        pointer: request.pointer,
        agentSession: request.agentSession,
        ...(options.binary === undefined ? {} : { binary: options.binary }),
        ...(options.resolveSession === undefined ? {} : { sessionBinding: options.resolveSession(request) }),
      });

      if (precheck.status !== 'ready') {
        return {
          kind: 'unsupported',
          reason: precheck.reason,
        };
      }

      const callTimeoutMs =
        request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
          ? Math.round(request.timeoutMs)
          : defaultTimeoutMs;

      const result = await runSpawn(precheck.binary, precheck.args, {
        timeoutMs: callTimeoutMs,
        cwd: options.cwd ?? request.root,
      });

      if (result.error !== undefined) {
        const msg = result.error.message || String(result.error);
        const timedOut = /timed out after \d+ms/i.test(msg);
        return {
          kind: 'unreachable',
          reason: `${precheck.binary} headless resume failed: ${msg}`,
          ...(timedOut ? { timedOut: true } : {}),
        };
      }

      if (result.status === 0) {
        return { kind: 'enqueue' };
      }

      const detail = singleLineDetail(result.stderr, result.stdout, result.status);
      if (UNSUPPORTED_OPTION_RE.test(detail)) {
        return {
          kind: 'unsupported',
          reason: `${precheck.binary} does not support headless session resume (${detail})`,
        };
      }

      return {
        kind: 'unreachable',
        reason: `${precheck.binary} headless resume refused (${detail})`,
      };
    },
  };
}

export const GEMINI_HEADLESS_RESUME_ADAPTER: RuntimePushAdapter = headlessResumePushAdapter({
  cli: 'gemini',
});

export const CURSOR_HEADLESS_RESUME_ADAPTER: RuntimePushAdapter = headlessResumePushAdapter({
  cli: 'cursor',
});

export const HEADLESS_RESUME_ADAPTERS: readonly RuntimePushAdapter[] = [
  GEMINI_HEADLESS_RESUME_ADAPTER,
  CURSOR_HEADLESS_RESUME_ADAPTER,
];

export function headlessResumeAdapterFor(
  cli: string,
  adapters: readonly RuntimePushAdapter[] = HEADLESS_RESUME_ADAPTERS,
): RuntimePushAdapter | null {
  return adapters.find((adapter) => adapter.clis.includes(cli)) ?? null;
}

export type HeadlessResumeTarget = {
  route: 'headless-resume';
  cli: string;
  copy: CopyTarget;
  root: string;
  home: string;
  session: string;
  seat: string;
  sender: PushSender;
  /** Optional working directory for the headless CLI turn; defaults to `target.root`. */
  cwd?: string;
  /** Optional caller-supplied runtime session id; must match the bound `recordedSeatSession`. */
  agentSession?: string | null;
};

export type HeadlessResumeMessage = {
  id: string;
  /** The opaque signed record JSON text to stage at `target.copy`. Never parsed by the bridge. */
  record: string;
  /**
   * Optional pre-built single-line pointer (`pushPointer(id, sender)`). When omitted, built from
   * `message.id` and `target.sender` via `pushPointer`.
   */
  pointer?: string;
};

export type HeadlessResumeDeliverOptions = {
  now?: () => Date;
  /** Start timestamp (ms) of the overall `send` walk for `WalkAttempt.ms` accounting. */
  startedAt?: number;
  /**
   * Start timestamp (`ms` or `Date`) of the `headless-resume` route attempt in the caller, used to
   * deduct caller route preparation time (including when `skipStage: true`) from the overall
   * attempt deadline. Defaults to `startedAt` when provided, otherwise `now().getTime()`.
   */
  routeStartedAt?: number | Date;
  /**
   * Already-resolved `DeliveryTimeoutInForce` from `deliveryTimeoutInForce` in
   * `src/policy/delivery.ts` (or a route-budget map in seconds).
   */
  deliveryTimeout?:
    | DeliveryTimeoutInForce
    | Readonly<Partial<Record<DeliveryTimeoutRoute, number>>>
    | number;
  /**
   * Optional explicit attempt timeout override in milliseconds; clamped to the resolved
   * `deliveryTimeout` budget so it can only shorten (never lengthen or bypass) the signed policy.
   */
  timeoutMs?: number;
  /**
   * Whether another live delivery route remains after `headless-resume` in the recipient's delivery
   * order. Defaults to `true`.
   */
  liveRoutesRemain?: boolean;
  /** Optional already-resolved session binding from `recordedSeatSession`. */
  sessionBinding?: RecordedSeatSessionRead;
  /**
   * When `true`, skips calling `stage()` because the caller (`src/commands/send.ts`) has already
   * staged the durable signed record at `join(target.copy.dir, target.copy.name)`.
   */
  skipStage?: boolean;
  /** Optional injected `RuntimePushAdapter` (or `spawn` / `binary` for `headlessResumePushAdapter`). */
  adapter?: RuntimePushAdapter;
  binary?: string;
  spawn?: HeadlessResumeSpawn;
};

export type HeadlessResumeAttempt =
  | {
      route: 'headless-resume';
      /**
       * `enqueue` means the headless resume turn exited `0` after receiving the pointer.
       * It is transport invocation only — never `read` or `delivered (read)` until a signed
       * `<id>.read.json` receipt verifies in `src/commands/send.ts`.
       */
      outcome: 'enqueue';
      receipt: PackageRelayReceipt;
      walkAttempt: WalkAttempt;
    }
  | {
      route: 'headless-resume';
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
    route: HEADLESS_RESUME_ROUTE,
    outcome,
    liveRoutesRemain,
    at,
    ms: Math.max(0, at.getTime() - startedAt),
    reason,
    receipt,
  };
}

/**
 * Makes one bounded `headless-resume` attempt for a Gemini (`gemini`) or Cursor (`cursor`) seat:
 *   1. Validates `routeStartedAt` and resolves the caller-supplied `delivery-timeout` budget first,
 *      clamping any optional `timeoutMs` override to it.
 *   2. For unsupported CLIs (not `gemini` or `cursor`), returns `unsupported` (`this build carries
 *      no headless resume runtime`) before staging.
 *   3. Stages (or reuses when `skipStage: true`) the signed drop record under `message.id`.
 *   4. Runs synchronous local session-binding (`recordedSeatSession`) and pointer (`pushPointer`)
 *      pre-validation via `probeHeadlessResumeRoute`.
 *   5. Deducts elapsed preparation time since `routeStartedAt` from the attempt budget and spawns
 *      the headless CLI turn (`gemini` or `cursor-agent`) with `remainingTimeoutMs`.
 *   6. Returns both the `@teamcli/relay` receipt and the exact `WalkAttempt` for `FallbackWalk.note`
 *      (`receipt: { kind: 'maybe-consumed' }` on exit `0`; signed `<id>.read.json` verification
 *      stays in `src/commands/send.ts`).
 */
export async function deliverHeadlessResumeRoute(
  target: HeadlessResumeTarget,
  message: HeadlessResumeMessage,
  options: HeadlessResumeDeliverOptions = {},
): Promise<HeadlessResumeAttempt> {
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

  if (!isHeadlessResumeCli(target.cli)) {
    const at = nowFn();
    return {
      route: HEADLESS_RESUME_ROUTE,
      outcome: 'unsupported',
      reason: HEADLESS_RESUME_UNAVAILABLE_REASON,
      walkAttempt: buildWalkAttempt(
        'unreachable',
        liveRoutesRemain,
        at,
        startedAt,
        HEADLESS_RESUME_UNAVAILABLE_REASON,
        { kind: 'unknown' },
      ),
    };
  }

  const routeStartProblem =
    !Number.isFinite(routeStartedAtMs)
      ? 'the headless-resume route start time is not a valid instant; refusing to grant a fresh attempt budget'
      : routeStartedAtMs > entryMs
        ? `the headless-resume route start time is ${String(routeStartedAtMs - entryMs)}ms in the future; refusing to grant a fresh attempt budget`
        : null;
  if (routeStartProblem !== null) {
    return {
      route: HEADLESS_RESUME_ROUTE,
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

  const budget = resolveHeadlessResumeAttemptTimeoutMs(options.deliveryTimeout, options.timeoutMs);
  if (!budget.ok) {
    const at = nowFn();
    return {
      route: HEADLESS_RESUME_ROUTE,
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
        route: HEADLESS_RESUME_ROUTE,
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

  const precheck = probeHeadlessResumeRoute({
    cli: target.cli,
    root: target.root,
    home: target.home,
    session: target.session,
    seat: target.seat,
    id: message.id,
    sender: target.sender,
    ...(message.pointer !== undefined ? { pointer: message.pointer } : {}),
    ...(target.agentSession !== undefined ? { agentSession: target.agentSession } : {}),
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
    ...(options.sessionBinding !== undefined ? { sessionBinding: options.sessionBinding } : {}),
  });
  if (precheck.status !== 'ready') {
    const at = nowFn();
    const outcome =
      precheck.status === 'refused' || precheck.status === 'unsupported'
        ? 'unsupported'
        : 'unreachable';
    return {
      route: HEADLESS_RESUME_ROUTE,
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

  const elapsedMs = Math.max(0, nowFn().getTime() - routeStartedAtMs);
  const remainingTimeoutMs = budget.timeoutMs - elapsedMs;
  if (remainingTimeoutMs <= 0) {
    const at = nowFn();
    const reason = `${precheck.binary} headless resume timed out before spawn (${String(budget.timeoutMs)}ms attempt budget exhausted during preparation)`;
    return {
      route: HEADLESS_RESUME_ROUTE,
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
    ?? headlessResumePushAdapter({
      cli: precheck.cli,
      binary: precheck.binary,
      ...(target.cwd === undefined ? {} : { cwd: target.cwd }),
      resolveSession: () => ({ kind: 'bound', recorded: precheck.recorded }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
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
      agentSession: precheck.sessionId,
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
      route: HEADLESS_RESUME_ROUTE,
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
    route: HEADLESS_RESUME_ROUTE,
    outcome: 'enqueue',
    receipt,
    walkAttempt: buildWalkAttempt(
      'delivered',
      false,
      at,
      startedAt,
      `resumed ${precheck.cli} session headlessly; no read receipt yet`,
      { kind: 'maybe-consumed' },
    ),
  };
}

export { receiptSecondsFor };
