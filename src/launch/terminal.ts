import { hostedCommit } from '../host/request-scope.ts';
// Reading one key from the owner's terminal.
//
// Raw mode is entered for one read and left the instant the read ends, so the terminal is never
// in raw mode between reads — during pane polls, focus changes, or any other work the pause does.
// Every exit from a read restores it: the key arriving, the timeout, end of input, a setup error,
// and, while a read is in flight, SIGINT, SIGTERM or SIGHUP. A signal restores the mode first,
// removes these handlers and re-raises the signal, so the process dies by the signal's own
// default action and never leaves the owner's terminal raw. In raw mode the line discipline is
// off, so a Ctrl-C arrives as the byte 0x03 rather than as SIGINT: that byte is read as `q`.
//
// One chunk is one key only when the chunk is exactly one byte of the four; anything else —
// several bytes that arrived together (a paste, a held key, a fast keystroke pair), an escape
// sequence, any other byte — reads as `other` and changes nothing. A chunk's first byte is never
// taken as its key: `sq` pasted at the prompt would otherwise stop the run. Type-ahead is
// discarded instead of answered: `drain()` reads and throws away every byte already pending, and
// the pause drains before every prompt. What remains possible on this runtime: bytes that have
// not reached Node's stream yet when `drain()` runs (the terminal's own buffer, or a paste
// arriving between the drain and the read) are still read by the next `key()`, where the
// one-chunk rule keeps a multi-byte paste from ever acting as a key; a trailing single byte of a
// paste split across two data events is the one byte that can still act, and it can only be `o`,
// `s`, `q` or Ctrl-C — the four the owner could have pressed.

/** One read's result. Anything that is not `o`, `s`, `q` or Ctrl-C is `other`. */
export type Key = 'o' | 's' | 'q' | 'other' | 'timeout' | 'eof';

/** The parts of a TTY stream one read uses; a test hands in a fake that records the calls.
 *  `read` is the stream's non-flowing pull, used by `drain` alone. */
export type KeyStream = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause?(): void;
  read?(): unknown;
  on(event: 'data' | 'end', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data' | 'end', listener: (chunk: string | Buffer) => void): unknown;
};

/** The process signals watched while a read holds the terminal raw, behind a seam a test owns. */
export type Signals = {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
  /** What the process would do with the signal were every handler gone. */
  reRaise(signal: NodeJS.Signals): void;
};

export const processSignals: Signals = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.removeListener(signal, handler);
  },
  reRaise: (signal) => {
    hostedCommit('process.kill');
    process.kill(process.pid, signal);
  },
};

/** The signals watched for the length of a read: the ones a terminal hangs up with. */
export const HELD_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export type Terminal = {
  /** One key, at most `ms` (no timeout when it is not a finite positive number). */
  key(ms: number): Promise<Key>;
  /** Every byte already pending, read and discarded. Never blocks: a stream with nothing
   *  pending returns null on its first read. */
  drain(): void;
};

function keyOf(chunk: string): Key {
  // Exactly one byte, and one of ours. A multi-byte chunk is never a key: it is a paste, a
  // burst of keystrokes, or an escape sequence, and its first byte must not act for it.
  if (chunk.length !== 1) return 'other';
  if (chunk === 'o') return 'o';
  if (chunk === 's') return 's';
  if (chunk === 'q' || chunk === '\x03') return 'q';
  return 'other';
}

export function terminalReader(stream: KeyStream, signals: Signals = processSignals): Terminal {
  // A stream that ended stays ended: every later read is `eof` at once, never an endless wait,
  // and never a `q`. (Node does not deliver a second 'end'.)
  let ended = false;
  return {
    key(ms: number): Promise<Key> {
      if (ended) return Promise.resolve('eof');
      return new Promise<Key>((resolve, reject) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const held: Array<() => void> = [];
        const restore = () => {
          try {
            stream.setRawMode?.(false);
          } catch {
            // The stream is gone; there is no mode left to restore.
          }
        };
        const teardown = () => {
          if (timer) clearTimeout(timer);
          stream.removeListener('data', onData);
          stream.removeListener('end', onEnd);
          for (const off of held) off();
          restore();
          stream.pause?.();
        };
        const cleanup = (result: Key) => {
          if (done) return;
          done = true;
          teardown();
          resolve(result);
        };
        const onData = (chunk: string | Buffer) => {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          if (text.length === 0) return;
          cleanup(keyOf(text));
        };
        const onEnd = () => {
          ended = true;
          cleanup('eof');
        };

        try {
          stream.setRawMode?.(true);
          stream.resume();
          for (const signal of HELD_SIGNALS) {
            const handler = () => {
              // The terminal first, then the process's own death: never left raw.
              restore();
              for (const off of held) off();
              signals.reRaise(signal);
            };
            signals.on(signal, handler);
            held.push(() => signals.off(signal, handler));
          }
          stream.on('data', onData);
          stream.on('end', onEnd);
        } catch (error) {
          done = true;
          teardown();
          reject(error);
          return;
        }
        if (Number.isFinite(ms) && ms > 0) {
          timer = setTimeout(() => cleanup('timeout'), ms);
        }
      });
    },
    drain(): void {
      // The stream is paused between reads, so every byte that arrived since the last read sits
      // in its buffer; `read()` pulls it out chunk by chunk, and the chunks are dropped. A
      // stream with no `read` (or one that throws because it was destroyed) drains nothing.
      try {
        for (;;) {
          const chunk = stream.read?.() as string | Buffer | null | undefined;
          if (chunk == null || chunk.length === 0) break;
          // Discarded: bytes typed for a prompt that is already over.
        }
      } catch {
        // The stream is gone; there is nothing left to drain.
      }
    },
  };
}
