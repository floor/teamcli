// The OpenAI Codex (0.161.0) runtime-push adapter: hands one pointer line to a running Codex
// thread via `codex queue --thread <agent_session> --message <pointer>`.
//
// Rules enforced here (OD45 §3.2 & §5.1, FLO-1053, FLO-1054):
//   - Requires a trusted session binding resolved via `recordedSeatSession` (`src/registry/resume.ts`)
//     and verified `codex-daemon` policy (`src/policy/codex-daemon.ts`). Never opens or inspects
//     the owner's `~/.codex` and never guesses a thread id from `request.seat` or `request.session`.
//   - Forwards `request.pointer` (including the signed-record-derived `From <seat>@<team>: …`
//     prefix from `pushPointer`) verbatim and unchanged. Never carries or substitutes a message
//     body.
//   - Maps `codex queue` exit 0 strictly to `{ kind: 'enqueue' }` (`sent (unconfirmed)`), never
//     `delivered (read)`.
//   - Maps missing/unbound `agentSession`, `codex-daemon: off`, or an older binary without `queue`
//     to `unsupported`, and daemon/thread refusals (`--no-daemon`, embedded app-server, spawn
//     errors) to `unreachable`, so the delivery walk falls through cleanly.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCodexDaemonPolicy, type CodexDaemonResolution } from '../../policy/codex-daemon.ts';
import { DELIVERY_TIMEOUT_DEFAULTS } from '../../policy/types.ts';
import { recordedSeatSession, type RecordedSeatSessionRead } from '../../registry/resume.ts';
import { readState, type SeatState } from '../../state.ts';
import { TRIGGER_MAX } from '../native.ts';
import type { RuntimePushAdapter, RuntimePushOutcome, RuntimePushRequest } from '../push.ts';

/** Default bound for one `codex queue` invocation, in milliseconds (`DELIVERY_TIMEOUT_DEFAULTS.native * 1000` = 15s). */
export const CODEX_QUEUE_TIMEOUT_MS = DELIVERY_TIMEOUT_DEFAULTS.native * 1000;

/** Reason returned when `codex-daemon` policy is `off` for the target seat. */
export const CODEX_DAEMON_OFF_REASON =
  'codex-daemon policy is off for this seat (seat runs with --no-daemon)';

export type CodexDaemonPolicyValue = 'on' | 'off';

/**
 * Applies the resolved `codex-daemon` policy (`on | off`, default `on`) to a Codex unattended
 * argument list: when `off`, reinjects `--no-daemon` if not already present; when `on`, omits it.
 */
export function withCodexDaemonLaunchArgs(
  args: readonly string[],
  codexDaemon: CodexDaemonPolicyValue = 'on',
): string[] {
  const filtered = args.filter((arg) => arg !== '--no-daemon');
  if (codexDaemon === 'off') {
    const altIdx = filtered.indexOf('--no-alt-screen');
    if (altIdx >= 0) {
      filtered.splice(altIdx, 0, '--no-daemon');
    } else {
      filtered.push('--no-daemon');
    }
  }
  return filtered;
}

export type CodexSpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type CodexSpawn = (
  binary: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<CodexSpawnResult> | CodexSpawnResult;

export type CodexPushAdapterOptions = {
  /** Binary name or path; defaults to `codex`. */
  binary?: string;
  /** Optional explicit app-server endpoint (`ws://host:port`, `wss://host:port`, `unix://`, or `unix://PATH`). */
  remote?: string;
  /**
   * Optional `codex-daemon` policy value (`'on' | 'off'` or already-resolved `CodexDaemonResolution`,
   * default resolved from the signed `entity -> project -> team -> seat` policy chain) or per-request
   * resolver. When `'off'` or when any signed policy source in the chain is unreadable/invalid,
   * `push()` fails closed (`unsupported`) without spawning `codex queue`.
   */
  codexDaemon?:
    | CodexDaemonPolicyValue
    | CodexDaemonResolution
    | ((request: RuntimePushRequest) => CodexDaemonPolicyValue | CodexDaemonResolution);
  /**
   * Optional per-request session-binding resolver. Defaults to `recordedSeatSession`
   * (`src/registry/resume.ts`).
   */
  resolveSession?: (request: RuntimePushRequest) => RecordedSeatSessionRead;
  /** Injectable process runner for deterministic unit tests without spawning a real CLI. */
  spawn?: CodexSpawn;
  /** Per-call timeout in milliseconds; defaults to `CODEX_QUEUE_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/**
 * Validates a `codex queue --remote <ADDR>` endpoint against the forms documented by
 * `codex queue --help` (`0.161.0`): `ws://host:port`, `wss://host:port`, `unix://`, or
 * `unix://PATH` (single line, no whitespace or NUL bytes).
 */
export function isValidCodexRemote(remote: string): boolean {
  if (remote === '' || /[\s\0]/.test(remote)) return false;
  if (remote === 'unix://') return true;
  if (remote.startsWith('unix:///') && remote.length > 'unix:///'.length) return true;
  if (/^wss?:\/\/[^/\s:@]+:\d+$/.test(remote)) return true;
  return false;
}

/**
 * Default non-blocking process runner for `codex queue`. Never passes or reads the owner's
 * `~/.codex` state directly; stdin is closed immediately and stdout/stderr are collected up to
 * `timeoutMs`.
 */
export const defaultCodexSpawn: CodexSpawn = (binary, args, options) =>
  new Promise<CodexSpawnResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: CodexSpawnResult): void => {
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

function singleLineDetail(stderr: string, stdout: string, status: number | null): string {
  const raw = stderr.trim() || stdout.trim();
  if (raw === '') return `exit ${String(status)}`;
  const firstLine = raw.split(/\r?\n/)[0]?.trim() ?? '';
  return firstLine === '' ? `exit ${String(status)}` : firstLine;
}

const UNSUPPORTED_SUBCOMMAND_RE = /\b(unknown|unrecognized)\s+(subcommand|command|option|argument)\b/i;

/**
 * Builds the `RuntimePushAdapter` for `codex` (`0.161.0`).
 */
export function codexPushAdapter(options: CodexPushAdapterOptions = {}): RuntimePushAdapter {
  const binary = options.binary ?? 'codex';
  const remote = options.remote;
  const runSpawn = options.spawn ?? defaultCodexSpawn;
  const timeoutMs = options.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS;

  return {
    clis: ['codex'] as const,
    async push(request: RuntimePushRequest): Promise<RuntimePushOutcome> {
      if (options.codexDaemon !== undefined) {
        const daemonPolicy = typeof options.codexDaemon === 'function'
          ? options.codexDaemon(request)
          : options.codexDaemon;
        if (typeof daemonPolicy === 'object' && daemonPolicy !== null) {
          if (!daemonPolicy.ok) {
            return {
              kind: 'unsupported',
              reason: `codex-daemon policy could not be verified (${daemonPolicy.why})`,
            };
          }
          if (daemonPolicy.value === 'off') {
            return {
              kind: 'unsupported',
              reason: CODEX_DAEMON_OFF_REASON,
            };
          }
        } else if (daemonPolicy === 'off') {
          return {
            kind: 'unsupported',
            reason: CODEX_DAEMON_OFF_REASON,
          };
        }
      } else {
        const policy = resolveCodexDaemonPolicy({
          home: request.home,
          root: request.root,
          seat: request.seat,
          session: request.session,
        });
        if (!policy.ok) {
          return {
            kind: 'unsupported',
            reason: `codex-daemon policy could not be verified (${policy.why})`,
          };
        }
        if (policy.value === 'off') {
          return {
            kind: 'unsupported',
            reason: CODEX_DAEMON_OFF_REASON,
          };
        }
      }
      if (remote !== undefined && !isValidCodexRemote(remote)) {
        return {
          kind: 'unsupported',
          reason: 'the configured codex remote endpoint is not a valid ws://, wss://, or unix:// address',
        };
      }

      const dir = join(request.root, '.agents');
      let state: SeatState | undefined;
      if (existsSync(join(dir, 'team.state.json'))) {
        try {
          state = readState(dir).sessions[request.session]?.seats[request.seat];
        } catch {
          return {
            kind: 'unsupported',
            reason: 'no trusted runtime session is recorded for this seat (seat state could not be read)',
          };
        }
      }
      const binding = options.resolveSession
        ? options.resolveSession(request)
        : recordedSeatSession({
            home: request.home,
            root: request.root,
            herdrSession: request.session,
            seat: { name: request.seat, cli: 'codex' },
            state,
          });
      if (binding.kind !== 'bound') {
        return {
          kind: 'unsupported',
          reason:
            binding.kind === 'none' && binding.why === 'no agent record for this seat' && request.agentSession === null
              ? 'no runtime session is recorded for this seat'
              : `no trusted runtime session is recorded for this seat (${binding.why})`,
        };
      }
      if (
        request.agentSession !== null
        && request.agentSession.trim() !== ''
        && request.agentSession.trim() !== binding.recorded.sessionId
      ) {
        return {
          kind: 'unsupported',
          reason: 'the seat state and the agent record name different sessions',
        };
      }
      const rawSession: string | null = binding.recorded.sessionId;

      const threadId = rawSession.trim();
      if (threadId === '') {
        return {
          kind: 'unsupported',
          reason: 'no runtime session is recorded for this seat',
        };
      }
      if (threadId.startsWith('-') || /[\s\0]/.test(threadId)) {
        return {
          kind: 'unsupported',
          reason: 'the recorded runtime session is not a valid thread id',
        };
      }
      if (
        request.pointer === ''
        || request.pointer.includes('\n')
        || request.pointer.includes('\r')
        || request.pointer.includes('\0')
        || request.pointer.length > TRIGGER_MAX
      ) {
        return {
          kind: 'unsupported',
          reason: 'the runtime pointer is not a valid single line',
        };
      }

      const callTimeoutMs = request.timeoutMs ?? timeoutMs;
      if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
        return {
          kind: 'unsupported',
          reason: 'codex queue timeout budget must be a positive number of milliseconds',
        };
      }

      const argv = remote === undefined
        ? (['queue', '--thread', threadId, '--message', request.pointer] as const)
        : (['queue', '--remote', remote, '--thread', threadId, '--message', request.pointer] as const);
      let outcome: CodexSpawnResult;
      try {
        outcome = await runSpawn(binary, argv, { timeoutMs: callTimeoutMs });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const timedOut = /timed out after \d+ms/i.test(msg);
        return {
          kind: 'unreachable',
          reason: `codex queue failed: ${msg}`,
          ...(timedOut ? { timedOut: true } : {}),
        };
      }

      if (outcome.error !== undefined) {
        const timedOut = /timed out after \d+ms/i.test(outcome.error.message);
        return {
          kind: 'unreachable',
          reason: `codex queue could not run: ${outcome.error.message}`,
          ...(timedOut ? { timedOut: true } : {}),
        };
      }

      if (outcome.status !== 0) {
        const detail = singleLineDetail(outcome.stderr, outcome.stdout, outcome.status);
        if (UNSUPPORTED_SUBCOMMAND_RE.test(detail)) {
          return {
            kind: 'unsupported',
            reason: `codex queue is not supported by this binary (${detail})`,
          };
        }
        return {
          kind: 'unreachable',
          reason: `codex queue refused the pointer (${detail})`,
        };
      }

      return { kind: 'enqueue' };
    },
  };
}

/** The default `codex` runtime-push adapter instance. */
export const CODEX_PUSH_ADAPTER: RuntimePushAdapter = codexPushAdapter();
