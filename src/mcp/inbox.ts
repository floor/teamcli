// The seat's inbox: the drop folder `team send` already writes, read from the seat's own side.
//
// `team send` writes one message per file, whole and 0600, into
// `<root>/.agents/send-drops/<session>/<seat>/<uuid>`. The MCP inbox adds nothing to the message:
// a listener marker says a server is there, and one receipt `<id>.read` says a message was read
// by an `inbox_read` call. The drop file is still the message; both sidecars are conveniences
// written with the same atomic 0600 rename the drop gets.
//
// Path rules, which the server never relaxes: the seat and session are the launch's, never a tool
// argument's; the folder is checked step by step so a link at `.agents`, `send-drops`, the
// session or the seat refuses service; an id is a lowercase UUID and nothing else, so no id can
// name a path; a drop or receipt that is a link is refused, never followed.
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { heldAt } from '../launch/rules-file.ts';
import { readNoFollow } from '../send/history.ts';
import { dropMessage } from '../send/native.ts';

/** The listener marker's name in the seat's own drop folder. */
export const LISTENER_FILE = '.inbox-listener';

/** What a read appends to the message's own name. */
export const RECEIPT_SUFFIX = '.read';

/** The only names the server serves: the ids `team send` writes (`randomUUID`, lowercase). */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a running server leaves beside the inbox so `team send` can tell the leg is live. */
export type InboxListener = {
  v: 1;
  seat: string;
  session: string;
  root: string;
  cli: string;
  pid: number;
  ts: string;
};

/** What an `inbox_read` call leaves beside the message: the proof the call happened. */
export type InboxReceipt = {
  v: 1;
  id: string;
  seat: string;
  session: string;
  tool: 'inbox_read';
  ts: string;
  pid: number;
};

/** One waiting message, as `inbox_check` names it. `from` and the marker's `ts` are there when
 *  the send left a `.pending` record beside the drop; otherwise `ts` is the file's own time. */
export type InboxMessage = { id: string; from?: string; ts: string; bytes: number };

export function listenerPath(dropDir: string): string {
  return join(dropDir, LISTENER_FILE);
}

export function receiptPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}${RECEIPT_SUFFIX}`);
}

/**
 * Whether `<root>/.agents/send-drops/<session>/<seat>` is a real folder at every step. A missing
 * step is false here: the server creates the folder before it serves and re-checks this on every
 * call, so a folder that disappears or becomes a link stops service instead of being followed.
 */
export function inboxFolderHeld(root: string, session: string, seat: string): boolean {
  let at = root;
  for (const part of ['.agents', 'send-drops', session, seat]) {
    at = join(at, part);
    if (heldAt(at).kind !== 'folder') return false;
  }
  return true;
}

/**
 * Creates the inbox folder one checked step at a time, 0700 like the drop tree it belongs to, and
 * returns it. Null when a link, a fifo or a file stands where a folder must be, or a step cannot
 * be made: the caller refuses to serve rather than serve through it.
 */
export function ensureInboxFolder(root: string, session: string, seat: string): string | null {
  let at = root;
  for (const part of ['.agents', 'send-drops', session, seat]) {
    at = join(at, part);
    const held = heldAt(at);
    if (held.kind === 'folder') continue;
    if (held.kind !== 'missing') return null;
    try {
      mkdirSync(at, { mode: 0o700 });
      chmodSync(at, 0o700);
    } catch {
      return null;
    }
    if (heldAt(at).kind !== 'folder') return null;
  }
  return at;
}

/** Writes the listener marker whole at 0600 by rename; false when it cannot be written. */
export function writeListener(dropDir: string, listener: InboxListener): boolean {
  try {
    dropMessage(dropDir, LISTENER_FILE, `${JSON.stringify(listener)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The listener marker, when it is a regular file holding a well-formed record; null otherwise.
 *  A marker that is a link is never followed. */
export function readListener(dropDir: string): InboxListener | null {
  const text = readNoFollow(listenerPath(dropDir));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<InboxListener>;
    if (parsed.v !== 1 || typeof parsed.seat !== 'string' || typeof parsed.session !== 'string'
      || typeof parsed.root !== 'string' || typeof parsed.cli !== 'string'
      || typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0
      || typeof parsed.ts !== 'string') return null;
    return {
      v: 1,
      seat: parsed.seat,
      session: parsed.session,
      root: parsed.root,
      cli: parsed.cli,
      pid: parsed.pid,
      ts: parsed.ts,
    };
  } catch {
    return null;
  }
}

/** Whether `pid` is a live process this user may signal. `EPERM` is alive and not ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the marker names a process that is still there. A server that died without cleaning
 *  up leaves a stale marker: the pid is how the send side tells the two apart. */
export function listenerLive(listener: InboxListener): boolean {
  return pidAlive(listener.pid);
}

/** Removes the listener marker at exit, but only while it is still this process's own. */
export function removeListener(dropDir: string, pid: number): void {
  const listener = readListener(dropDir);
  if (listener === null || listener.pid !== pid) return;
  try {
    unlinkSync(listenerPath(dropDir));
  } catch {
    // Already gone: nothing stands in the way of the next server.
  }
}

/** The sender and time `team send` left beside the drop, when a marker is there and names it. */
function markerOf(dropDir: string, id: string): { from?: string; ts?: string } {
  const text = readNoFollow(join(dropDir, `${id}.pending`));
  if (text === null || text === '') return {};
  try {
    const parsed = JSON.parse(text) as { id?: unknown; from?: unknown; ts?: unknown };
    if (parsed.id !== id) return {};
    return {
      ...(typeof parsed.from === 'string' ? { from: parsed.from } : {}),
      ...(typeof parsed.ts === 'string' ? { ts: parsed.ts } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Every message waiting in this seat's own folder: a UUID-named regular file with no receipt
 * beside it. Oldest first. Anything else in the folder — a link, a marker, a directory — is not a
 * message and is skipped; a receipt that is a link is skipped too, since it proves nothing.
 */
export function listUnread(dropDir: string): InboxMessage[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const messages: InboxMessage[] = [];
  for (const name of names) {
    if (!MESSAGE_ID.test(name)) continue;
    const at = join(dropDir, name);
    if (heldAt(at).kind !== 'file') continue;
    if (heldAt(receiptPath(dropDir, name)).kind !== 'missing') continue;
    let size = 0;
    let mtime: number;
    try {
      const stat = lstatSync(at);
      if (!stat.isFile()) continue;
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch {
      continue;
    }
    const marker = markerOf(dropDir, name);
    messages.push({
      id: name,
      ...(marker.from !== undefined ? { from: marker.from } : {}),
      ts: marker.ts ?? new Date(mtime).toISOString(),
      bytes: size,
    });
  }
  return messages.sort((a, b) => (Date.parse(a.ts) - Date.parse(b.ts)) || a.id.localeCompare(b.id));
}

export type InboxRead =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/**
 * Reads one message and writes its receipt **before** returning the body: a read that cannot
 * leave proof is refused, so `delivered (read)` can never rest on a body the client saw without
 * the receipt on disk. The id is a lowercase UUID; no other string reaches the filesystem.
 */
export function readMessage(dropDir: string, id: string, seat: string, session: string, pid: number): InboxRead {
  if (!MESSAGE_ID.test(id)) return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
  const at = join(dropDir, id);
  if (heldAt(at).kind !== 'file') return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
  const receipt = heldAt(receiptPath(dropDir, id));
  if (receipt.kind !== 'missing' && receipt.kind !== 'file') {
    return { ok: false, reason: 'the receipt path is held by something that is not a file' };
  }
  const body = readNoFollow(at);
  if (body === null) return { ok: false, reason: `message ${JSON.stringify(id)} could not be read` };
  const record: InboxReceipt = { v: 1, id, seat, session, tool: 'inbox_read', ts: new Date().toISOString(), pid };
  try {
    dropMessage(dropDir, `${id}${RECEIPT_SUFFIX}`, `${JSON.stringify(record)}\n`);
  } catch {
    return { ok: false, reason: 'the receipt could not be written, so the message is not returned' };
  }
  return { ok: true, body };
}
