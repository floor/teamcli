// The reply side of the cross-session message socket: the listener a `--wait` send opens at
// its own pid's measured name, and the reading of one reply line.
//
// Measured, on this Mac against the live sessions of Claude Code 2.1.295 (2026-10-10): a
// message's `from` address is `uds:<tmp>/cc-socks/<sender pid>.sock` — the pid is the one the
// receiving session verified on the connection, and the path is that pid's socket in the
// sockets folder. A reply is a message addressed back there, so a sender that wants an answer
// listens at its own pid's path. The listener takes the first complete JSON line of the first
// connection; a line that is not this channel's frame is kept whole as the reply.
//
// The socket is a measured observation, not a stable API (see uds.ts).
import { existsSync } from 'node:fs';
import { unlinkSync } from '../host/guarded-fs.ts';
import { join } from 'node:path';
import { FRAME_LIMIT } from './uds.ts';
import { dialing, serving, socketRuntime, type Conn, type SocketError } from '../runtime/bun-socket.ts';
import { hostedCommit } from '../host/request-scope.ts';

/** The wait's ending: a reply line came back, or the window closed. */
export type ReplyWait = { kind: 'answered'; line: string } | { kind: 'timeout' };

export type ReplyListener = {
  path: string;
  /** The first complete line, or `timeout` after `ms`. A line that arrived earlier resolves now. */
  wait(ms: number): Promise<ReplyWait>;
  /** Stop listening. The socket file is removed. */
  close(): void;
};

export type OpenReply = { ok: true; listener: ReplyListener } | { ok: false; reason: string };

/** How long the liveness probe of an existing file at our own path may take. */
const PROBE_MS = 500;

/**
 * Opens the listener at `<dir>/<pid>.sock`. A file already there is probed first: a listener
 * that answers is refused (never displaced); a dead file — a pid's leftover — is removed.
 */
export async function openReplyListener(dir: string, pid: number): Promise<OpenReply> {
  const path = join(dir, `${String(pid)}.sock`);
  if (existsSync(path) && (await answers(path))) {
    return { ok: false, reason: `a listener already answers at ${path}; nothing was sent` };
  }
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      return { ok: false, reason: `${path} holds a dead socket file that cannot be removed; nothing was sent` };
    }
  }
  hostedCommit('Bun.listen');
  const sockets = new Set<Conn>();
  let line: string | null = null;
  let waiter: ((outcome: ReplyWait) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let buffer = '';

  const accept = (socket: Conn) => {
    sockets.add(socket);
    socket.onClose(() => sockets.delete(socket));
    const text = (chunk: string): void => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) {
        // A sender that writes a line over the measured limit is not this channel; drop it.
        if (buffer.length > FRAME_LIMIT) {
          buffer = '';
          socket.destroy();
        }
        return;
      }
      settle({ kind: 'answered', line: buffer.slice(0, end) });
    };
    return { text };
  };

  const settle = (outcome: ReplyWait): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (waiter) {
      const done = waiter;
      waiter = null;
      done(outcome);
    } else line = outcome.kind === 'answered' ? outcome.line : null;
  };

  const Bun = socketRuntime();
  let server: ReturnType<typeof Bun.listen>;
  try {
    server = Bun.listen(serving(path, accept));
  } catch (error) {
    const code = (error as SocketError).code;
    return { ok: false, reason: code === 'EADDRINUSE' ? `a listener already answers at ${path}; nothing was sent` : `the reply listener could not be opened (${code ?? 'unknown error'})` };
  }

  function close(): void {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.stop(true);
    // Stopping removes the file (measured); this covers a path left by a race.
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // A file we cannot remove is the next run's probed refusal, not this run's error.
    }
  }

  return {
    ok: true,
    listener: {
      path,
      wait: (ms) =>
        new Promise<ReplyWait>((resolve) => {
          if (line !== null) {
            const had = line;
            line = null;
            resolve({ kind: 'answered', line: had });
            return;
          }
          waiter = resolve;
          timer = setTimeout(() => settle({ kind: 'timeout' }), ms);
        }),
      close,
    },
  };
}

/** Whether a socket at `path` answers a connection. Used before displacing anything. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    hostedCommit('Bun.connect');
    let settled = false;
    const done = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    const Bun = socketRuntime();
    const { conn: socket, options, refused } = dialing(path, { open: () => done(true), close: () => done(false) });
    const timer = setTimeout(() => done(true), PROBE_MS);
    Bun.connect(options).catch(refused);
  });
}

/**
 * What a replying Claude session's harness stamps around what it relays: measured on this Mac
 * (2026-10-10) by listening at a live session's pid path and sending to it through the session's
 * own message tool — the content arrived as
 * `<cross-session-message from="uds:/tmp/cc-socks/14495.sock" from-name="lobby-93"
 * from-mode="bypass">\nprobe ping\n</cross-session-message>`, with the sent frame's own msg_id.
 */
const WRAPPED = /^<cross-session-message(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/cross-session-message>$/;

/** The body inside the measured wrapper, or the text unchanged when it is not one. */
function unwrap(content: string): string {
  const match = WRAPPED.exec(content);
  return match ? (match[1] as string) : content;
}

/**
 * One reply line, read: the content of this channel's frame when it is one — the wrapper peeled
 * off, when the replying harness stamped one — and the whole line otherwise. `msg_id` is the
 * frame's own, for a reader's correlation; null when the line is not this channel's frame (or
 * carries none).
 */
export function readReply(line: string): { reply: string; msg_id: string | null } {
  try {
    const frame = JSON.parse(line) as { message?: { content?: unknown }; msg_id?: unknown };
    const content = frame.message?.content;
    if (typeof content === 'string') {
      return { reply: unwrap(content), msg_id: typeof frame.msg_id === 'string' ? frame.msg_id : null };
    }
  } catch {
    // Not JSON: the line is the reply, kept whole.
  }
  return { reply: line, msg_id: null };
}
