// The thin client side of the warm send host (rfc-bus-send-server §2.1, §2.2). It imports only
// node built-ins, version.ts and the Bun socket declaration, so a `team send` that the host
// serves never loads the CLI. It connects with Bun's own socket (node:net cost ~4–5 ms of every
// start).
//
// The rule: the client runs a line locally only when the host can never run it — nothing was
// submitted (no socket, no Bun runtime, connect refused or not done in time, or the connection
// gone before any byte of the request was written), or the host answered `fallback`. Once any
// byte is written, every other failure is ambiguous and ends the line with exit 1, never a retry:
// a retry would be a second send.
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { bunSockets, type BunSocket } from '../runtime/bun-socket.ts';
import { version } from '../version.ts';

export const HOSTED_COMMANDS: ReadonlySet<string> = new Set(['send', 'reply', 'ack']);
/** How long a connect may take before the line runs locally instead (nothing is written yet). */
export const CONNECT_WINDOW_MS = 50;
/** How long a submitted line may take; past it the line ends ambiguous (exit 1). */
export const ANSWER_WINDOW_MS = 15 * 60_000;

export const AMBIGUOUS =
  'team: the send host did not answer; the line may have run. Check `team show` or `team messages` before sending again.\n';

export type ClientOutcome =
  | { kind: 'not-submitted'; why: string }
  | { kind: 'fallback'; why: string }
  | { kind: 'ran'; code: number; stdout: string; stderr: string }
  | { kind: 'ambiguous'; why: string };

export type ClientInput = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
  cliEntry: string;
  socketPath?: string;
  connectWindowMs?: number;
  answerWindowMs?: number;
};

/** The build identity file `scripts/build.ts` writes beside the CLI entry: one digest over every
 *  emitted file (path and bytes), so a rebuild that changes any module, not only the entry, is
 *  another build. */
export const BUILD_ID_FILE = 'build-id';

/** The same stamp the host computes (server.ts `buildStampOf`), without importing the server.
 *  Null when the build identity cannot be read: such a client never submits to the host. */
export function clientBuildStamp(cliEntry: string): string | null {
  try {
    const id = readFileSync(join(dirname(realpathSync(cliEntry)), BUILD_ID_FILE), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(id) ? `${version()}+${id}` : null;
  } catch {
    return null;
  }
}

export function clientSocketPath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'send-host.sock');
}

export async function tryHost(input: ClientInput): Promise<ClientOutcome> {
  const path = input.socketPath ?? clientSocketPath();
  try {
    if (!lstatSync(path).isSocket()) return { kind: 'not-submitted', why: 'no send host socket' };
  } catch {
    return { kind: 'not-submitted', why: 'no send host socket' };
  }
  const stamp = clientBuildStamp(input.cliEntry);
  if (stamp === null) return { kind: 'not-submitted', why: 'the build identity cannot be read' };
  const frame = `${JSON.stringify({ v: 1, build: stamp, argv: input.argv, cwd: input.cwd, env: input.env, tty: input.tty })}\n`;
  // Named `Bun` so the call below reads as Bun's own at its site (src/runtime/bun-socket.ts).
  const Bun = bunSockets();
  if (Bun === null) return { kind: 'not-submitted', why: 'this runtime has no Bun sockets' };
  const bytes = new TextEncoder().encode(frame);
  return new Promise((settle) => {
    /** True once any byte of the request is written: from then on no failure is not-submitted. */
    let submitted = false;
    let settled = false;
    let written = 0;
    let held: BunSocket | null = null;
    let buffer = '';
    const decoder = new TextDecoder();
    let answerTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ClientOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(answerTimer);
      held?.terminate();
      settle(outcome);
    };
    const failed = (afterBytes: string, beforeBytes: string): void => {
      finish(submitted ? { kind: 'ambiguous', why: afterBytes } : { kind: 'not-submitted', why: beforeBytes });
    };
    const connectTimer = setTimeout(() => {
      if (!submitted) finish({ kind: 'not-submitted', why: 'the send host did not take the connection in time' });
    }, input.connectWindowMs ?? CONNECT_WINDOW_MS);
    // The socket is unbuffered: each write takes what the kernel takes now, and the rest waits
    // for `drain`. Only the returned count moves the request on.
    const pump = (socket: BunSocket): void => {
      while (!settled && written < bytes.length) {
        const count = socket.write(bytes, written, bytes.length - written);
        if (count < 0) {
          failed('the send host closed the connection', 'the connection closed before the request');
          return;
        }
        if (count === 0) return;
        written += count;
        submitted = true;
      }
    };
    const answered = (): void => {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let value: { v?: unknown; kind?: unknown; why?: unknown; code?: unknown; stdout?: unknown; stderr?: unknown };
      try {
        value = JSON.parse(buffer.slice(0, end)) as typeof value;
      } catch {
        finish({ kind: 'ambiguous', why: 'the answer is not JSON' });
        return;
      }
      if (value.v === 1 && value.kind === 'fallback' && typeof value.why === 'string') {
        finish({ kind: 'fallback', why: value.why });
      } else if (value.v === 1 && value.kind === 'ran' && typeof value.code === 'number' && typeof value.stdout === 'string' && typeof value.stderr === 'string') {
        finish({ kind: 'ran', code: value.code, stdout: value.stdout, stderr: value.stderr });
      } else {
        finish({ kind: 'ambiguous', why: 'the answer is not one this client reads' });
      }
    };
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          if (settled) {
            socket.terminate();
            return;
          }
          held = socket;
          clearTimeout(connectTimer);
          answerTimer = setTimeout(() => failed('no answer in time', 'the request could not be written in time'), input.answerWindowMs ?? ANSWER_WINDOW_MS);
          pump(socket);
        },
        drain(socket) {
          pump(socket);
        },
        data(_socket, chunk) {
          if (settled) return;
          buffer += decoder.decode(chunk, { stream: true });
          answered();
        },
        error(_socket, error) {
          failed(error.message, error.message);
        },
        connectError(_socket, error) {
          failed(error.message, error.message);
        },
        end() {
          failed('the send host closed the connection', 'the connection closed before the request');
        },
        close(_socket, error) {
          failed(error?.message ?? 'the send host closed the connection', error?.message ?? 'the connection closed before the request');
        },
      },
    }).catch((error: unknown) => {
      const why = error instanceof Error ? error.message : String(error);
      failed(why, why);
    });
  });
}
