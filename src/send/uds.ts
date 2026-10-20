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
// `ENOTSOCK` label in the relay package's dial, and the two socket tests in
// `test/send.test.ts`, are this build's own measured runs against a real listener.
//
// The client itself lives in `packages/relay` (index.js) with the rest of the transport. This
// module keeps the names TeamCLI imports and the build's own policy flag beside them.
import { FRAME_LIMIT as RELAY_FRAME_LIMIT, SEND_TIMEOUT_MS as RELAY_SEND_TIMEOUT_MS, dial as relayDial } from '../../packages/relay/index.js';

/** An accepted frame, or the reason the socket did not take it. */
export type SendOutcome = { ok: true } | { ok: false; reason: string };

/** The listener's measured buffer limit, in characters. A frame longer than this is refused
 *  before any connection is made — never truncated. */
export const FRAME_LIMIT = RELAY_FRAME_LIMIT;

/** How long the socket has to take the frame: connecting and writing it. */
export const SEND_TIMEOUT_MS = RELAY_SEND_TIMEOUT_MS;

/**
 * Whether this build may open another session's cross-session socket at all. On: the channel
 * is carried, and a send dials it only for a receiving Claude session that itself declares
 * `crossSessionInbound: "accept"` (`src/send/inbound.ts`). Hold, refuse and unset are skipped
 * before a connection is made, so no frame lands at a box that would hold it. A sender that
 * cannot use the socket — the receiver is another CLI, or declares nothing — walks the rest of
 * its order. The socket takes a frame without acknowledging it, so a write is transport, never
 * a read; only a signed receipt makes a message read.
 */
export const SOCKET_SEND: boolean = true;

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
  return relayDial(socketPath, frame, timeoutMs);
}
