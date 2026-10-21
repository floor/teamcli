// The cross-session message socket, as a client.
//
// The listener is the one a Claude Code session exposes at `<tmp>/cc-socks/<pid>.sock`
// (`pid` is the session process). The team's own probe of that socket, on Claude Code
// 2.1.295 (2026-10-09; recorded outside this repository), measured: UTF-8 JSON lines, one
// frame per line, newline-terminated; a first-complete-line deadline of 30,000 ms; a buffer
// limit of 1,048,576 characters (1,048,577 `x` bytes made the receiver close); a
// `type:"user"` frame carrying `message:{role:"user",content:string}` is admitted; the
// sender's socket `recv` came back empty — there is no acknowledgement on the
// connection, so a frame the socket took is as far as a send can be proven. The
// receiving session's `crossSessionInbound` policy decides when the frame surfaces: the
// probe saw a standalone sender's message held as unidentified (`The sender did not
// attest its permission mode`) unless the seat was started with `accept`. The
// `ENOTSOCK` label in `reasonOf`, and the two socket tests in `test/send.test.ts`, are
// this build's own measured runs against a real listener.
import { createConnection } from 'node:net';

/** An accepted frame, or the reason the socket did not take it. */
export type SendOutcome = { ok: true } | { ok: false; reason: string };

/** The listener's measured buffer limit, in characters. A frame longer than this is refused
 *  before any connection is made — never truncated. */
export const FRAME_LIMIT = 1_048_576;

/** How long the socket has to take the frame: connecting and writing it. */
export const SEND_TIMEOUT_MS = 5_000;

/**
 * Whether a `team send` from this CLI process may open another session's cross-session
 * socket. Off: the channel is unattested — the receiving session's `crossSessionInbound`
 * policy holds a frame from a standalone sender as unidentified ("The sender did not
 * attest its permission mode"), and a held frame blocks the seat's box until a person
 * lets it through — so no send path dials while this is false: `team send` (with or
 * without `--wait`) walks the receiving seat's delivery order and waits on the thread,
 * and the daemon and the watch's nudge open no socket either. The socket code stays in
 * the tree, one constant away.
 */
export const SOCKET_SEND = false;

/**
 * Writes one frame to the socket at `socketPath` and reports whether it was taken.
 *
 * `frame` is the complete line, its trailing newline included; this function writes those
 * bytes as given and nothing else. The answer is `ok` when the write reached the kernel
 * (the write callback): with no acknowledgement on this channel, that is the whole of
 * what a client can know. Every other path is an `ok: false` with a reason a person can
 * read: a socket that is not there, nothing listening, a connection closed before the
 * frame was taken, or the deadline.
 */
export function sendFrame(socketPath: string, frame: string, timeoutMs = SEND_TIMEOUT_MS): Promise<SendOutcome> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const done = (outcome: SendOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => done({ ok: false, reason: `the socket did not take the frame within ${String(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
    socket.on('error', (error) => done({ ok: false, reason: reasonOf(error) }));
    socket.on('connect', () => {
      socket.write(frame, (error) => {
        if (error) done({ ok: false, reason: reasonOf(error) });
        else done({ ok: true });
      });
    });
  });
}

function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'nothing is listening there (the socket is gone)';
  if (code === 'ECONNREFUSED') return 'nothing is listening there (the connection was refused)';
  // Measured on this platform: a plain file left at the socket's path answers ENOTSOCK.
  if (code === 'ENOTSOCK') return 'nothing is listening there (the path is not a socket)';
  if (code === 'EPIPE' || code === 'ECONNRESET') return 'the session closed the connection before it took the frame';
  return `the socket could not be written (${code ?? 'unknown error'})`;
}
