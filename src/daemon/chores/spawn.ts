// Starting one chores child, and reading the token it was started with.
//
// A child is a second process running the child entry beside this module, so it has its own
// heap and its own event loop: work that holds one child still cannot hold the daemon's socket,
// its health answer or another root's child. The child proves it was started from here by reading
// a one-use token under the machine folder (mode 0600); it unlinks that token as it starts, and a
// command line without one is refused before any work is read.
//
// The child speaks one newline-framed JSON line per message on its standard streams. Its stderr
// is not a protocol channel: complete lines there become notes on the daemon's own log.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHORES_FRAME_LIMIT,
  parseChoresFrame,
  readChildMessage,
  type ChoresChildConfig,
  type ChoresChildMessage,
  type ChoresHostMessage,
} from './protocol.ts';
import { writeChoresInherit } from './token.ts';

export type ChoresChildEvent =
  | { kind: 'message'; message: ChoresChildMessage }
  | { kind: 'note'; text: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };

/** The daemon's handle on one child: send it a message, hear what it says, and end it. */
export type ChoresChild = {
  pid: number | null;
  /** True until the child's process has exited, however it left. A beat to a child that has
   *  left is a beat written into a pipe with no reader, so the supervisor asks first. */
  readonly alive: boolean;
  /** Writes one frame. False when the child is already gone or its input is closed. */
  send(message: ChoresHostMessage): boolean;
  /** Listens for the child's messages, notes and exit; the returned function unsubscribes. */
  subscribe(listener: (event: ChoresChildEvent) => void): () => void;
  /** Ends the child: terminate, then force after `graceMs`. `evenIfWorking` asks for the forced
   *  end even when the process is still consuming CPU, which an ordinary end must never do: the
   *  hung ceiling is the one caller that asks. Idempotent and never throws. */
  kill(why: string, graceMs?: number, options?: { evenIfWorking?: boolean }): void;
  /** Settles when the child's process is gone, however it left. Never rejects. */
  readonly exited: Promise<void>;
};

export type SpawnChoresInput = {
  config: ChoresChildConfig;
  /** The program entry the child runs. The default is the child entry beside this module; a test
   *  names a fixture entry so a scene drives the protocol itself. */
  entry?: string;
  /** Extra environment for the child. `HOME` is always the config's home. */
  env?: Record<string, string>;
};

/** How long a terminated child gets before it is forced. */
const DEFAULT_KILL_GRACE_MS = 2_000;

/** The child's program entry: the `entry.ts` (source) or `entry.js` (installed build) beside this
 *  module. It loads the child loop and the token reader only, never the command table, so a
 *  child's heap carries the chores and nothing else. */
export function choresEntryOf(here: string = fileURLToPath(import.meta.url)): string | null {
  const name = here.endsWith('.ts') ? 'entry.ts' : 'entry.js';
  const candidate = join(dirname(here), name);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Starts one chores child from a freshly written token. A spawn that throws is reported to the
 * caller as a child that already left, never as an exception: the supervisor's restart path is
 * the one place a failed start is decided.
 */
export function spawnChoresChild(input: SpawnChoresInput): ChoresChild {
  const entry = input.entry ?? choresEntryOf();
  const listeners = new Set<(event: ChoresChildEvent) => void>();
  let settled = false;
  /** The process has exited. A beat may still be in flight when this turns true, so `send`
   *  reads it together with the input stream's own state. */
  let gone = false;
  /** The input stream reported an error (a peer that left first raises EPIPE): the child takes
   *  no more frames, and the error is a note instead of the daemon's last breath. */
  let inputBroken = false;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const emit = (event: ChoresChildEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener's failure is not the child's.
      }
    }
  };
  const settle = (): void => {
    if (settled) return;
    settled = true;
    resolveExited();
  };

  const refuse = (why: string): ChoresChild => {
    queueMicrotask(() => {
      emit({ kind: 'note', text: why });
      emit({ kind: 'exit', code: null, signal: null });
      settle();
    });
    return {
      pid: null,
      alive: false,
      send: () => false,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      kill: () => undefined,
      exited,
    };
  };

  if (entry === null) return refuse('the program entry for a chores child was not found');

  let nonce: string;
  try {
    nonce = writeChoresInherit(input.config);
  } catch (error) {
    return refuse(`the chores token could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry, '--inherited', nonce], {
      cwd: input.config.routes[0]?.root ?? dirname(entry),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: input.config.home, ...input.env },
    });
  } catch (error) {
    return refuse(`the chores child could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }

  let killed = false;
  const kill = (why: string, graceMs: number = DEFAULT_KILL_GRACE_MS): void => {
    if (killed || settled) return;
    killed = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone; the exit below settles the handle.
    }
    const forced = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, Math.max(1, graceMs));
    forced.unref();
    void exited.then(() => clearTimeout(forced));
    emit({ kind: 'note', text: `the child was ended: ${why}` });
  };

  // Every stream this handle writes to or reads from carries an error listener from the moment
  // it exists. A child that left between two beats closes the read end of its input, and the
  // write that follows raises EPIPE as an event: without a listener that event is unhandled and
  // takes the whole daemon down with the child.
  const inputFailed = (error: Error): void => {
    if (inputBroken) return;
    inputBroken = true;
    emit({ kind: 'note', text: `the child's input closed: ${error.message}` });
  };
  child.stdin?.on('error', inputFailed);
  child.stdout?.on('error', (error: Error) => emit({ kind: 'note', text: `the child's output failed: ${error.message}` }));
  child.stderr?.on('error', (error: Error) => emit({ kind: 'note', text: `the child's errors failed: ${error.message}` }));

  child.stdout?.setEncoding('utf8');
  let stdoutBuffer = '';
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let nl = stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      nl = stdoutBuffer.indexOf('\n');
      if (line.trim() === '') continue;
      if (line.length > CHORES_FRAME_LIMIT) {
        emit({ kind: 'note', text: 'a child frame exceeded the frame limit and was dropped' });
        continue;
      }
      const raw = parseChoresFrame(line);
      const message = raw === null ? null : readChildMessage(raw);
      if (message === null) {
        emit({ kind: 'note', text: 'a child frame was not a message the daemon understands' });
        continue;
      }
      emit({ kind: 'message', message });
    }
    if (stdoutBuffer.length > CHORES_FRAME_LIMIT) {
      stdoutBuffer = '';
      emit({ kind: 'note', text: 'a child frame exceeded the frame limit and was dropped' });
    }
  });

  let stderrBuffer = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl).trim();
      stderrBuffer = stderrBuffer.slice(nl + 1);
      nl = stderrBuffer.indexOf('\n');
      if (line !== '') emit({ kind: 'note', text: line });
    }
  });

  child.on('error', (error: Error) => emit({ kind: 'note', text: `the child failed: ${error.message}` }));
  // The process' own exit is the instant its pipe has no reader. The group is told here, before
  // the next beat, and the streams are released: a `close` that waits for stdio a child's
  // grandchild inherited must not delay the replacement.
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (gone) return;
    gone = true;
    child.stdin?.destroy();
    emit({ kind: 'exit', code, signal });
    settle();
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    // A spawn that never produced a process leaves without `exit`; its close is the exit.
    if (!gone) {
      gone = true;
      emit({ kind: 'exit', code, signal });
    }
    settle();
    child.stdin?.destroy();
  });

  return {
    pid: child.pid ?? null,
    get alive(): boolean {
      return !gone;
    },
    send(message: ChoresHostMessage): boolean {
      const input = child.stdin;
      if (settled || gone || inputBroken || input === null || input.destroyed || !input.writable) return false;
      try {
        input.write(`${JSON.stringify(message)}\n`, (error: Error | null | undefined) => {
          if (error) inputFailed(error);
        });
        return true;
      } catch (error) {
        inputFailed(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kill,
    exited,
  };
}
