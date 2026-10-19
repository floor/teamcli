// The seat's inbox: the drop folder `team send` already writes, read from the seat's own side.
//
// `team send` writes one message per file, whole and 0600, into
// `<root>/.agents/send-drops/<session>/<seat>/<uuid>`. The MCP inbox adds nothing to the message:
// a listener marker says a server is there, and an `inbox_read` call writes the same signed status
// receipt `team messages` writes — `<id>.read.json`, `status: read`, signed with the checkout's
// message key — so every reader of a status agrees on what the file is. The drop file is still the
// message; both sidecars are conveniences written with the same atomic 0600 rename the drop gets.
// A read parses the record and verifies its signature with the message key before it writes the
// receipt or shows a body: a tampered or unsigned file is refused, so the receipt never proves a
// read of something the server could not authenticate.
//
// Path rules, which the server never relaxes: the seat and session are the launch's, never a tool
// argument's; the folder is checked step by step so a link at `.agents`, `send-drops`, the
// session or the seat refuses service; an id is a lowercase UUID and nothing else, so no id can
// name a path; a drop or receipt that is a link is refused, never followed.
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_RULE,
  type CurrentBriefClaim,
} from '../launch/general-brief.ts';
import { heldAt } from '../launch/rules-file.ts';
import { readNoFollow } from '../send/history.ts';
import { dropMessage } from '../send/native.ts';
import {
  isRead,
  readRecord,
  receiptFile,
  signReceiptPayload,
  verifyRecord,
  writeReceipt,
  type ReceiptPayload,
  type StatusContext,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';

/** The listener marker's name in the seat's own drop folder. */
export const LISTENER_FILE = '.inbox-listener';

/** The only names the server serves: the ids `team send` writes (`randomUUID`, lowercase). */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How long a send on the mcp-inbox leg waits for the read receipt before it reports
 *  `sent (unconfirmed)`: long enough for a seat that checks its inbox at a turn boundary, short
 *  enough not to block a sender. Nothing waits longer than this. */
export const INBOX_GRACE_MS = 2_000;

/** How often that wait looks for the receipt. */
export const INBOX_POLL_MS = 25;

/** The one reason a send skips the mcp-inbox leg: no server is serving this inbox. A marker that
 *  is absent, malformed, dead, or names another seat, session or root says the same thing — there
 *  is no listener here that could take the message. */
export const NO_INBOX_LISTENER = 'no live inbox listener';

/** How long an unread inbox message waits before the watch types its drop as the fallback: the
 *  same ten-minute window the native leg allows for a confirmation, so a live inbox never delays
 *  a message longer than the frame path does. */
export const INBOX_FALLBACK_MS = 10 * 60_000;

/** The reason a typed fall-through records: the inbox had a live listener, and the message was
 *  still unread when the fallback window ended. */
export const INBOX_FALLBACK_REASON = `mcp-inbox: no receipt within ${String(INBOX_FALLBACK_MS / 60_000)}m`;

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

/** One waiting message, as `inbox_check` names it. `from` and the marker's `ts` are there when
 *  the send left a `.pending` record beside the drop; otherwise `ts` is the file's own time. */
export type InboxMessage = { id: string; from?: string; ts: string; bytes: number };

export function listenerPath(dropDir: string): string {
  return join(dropDir, LISTENER_FILE);
}

/** The read receipt's path: the record spine's status-in-the-name sidecar (`<id>.read.json`),
 *  so a drop's read receipt has one name everywhere — the inbox, `team drops` and the watch. */
export function receiptPath(dropDir: string, id: string): string {
  return receiptFile(dropDir, id, 'read');
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

/** Whether two roots are the same folder once links are resolved. `root` reaches the sender from
 *  a team file or a registry record, and the listener wrote its own root at launch. */
function sameRoot(left: string, right: string): boolean {
  const real = (at: string): string => {
    try {
      return realpathSync(at);
    } catch {
      return at;
    }
  };
  return real(left) === real(right);
}

export type InboxLiveness = { live: true; listener: InboxListener } | { live: false; reason: string };

/**
 * Whether a server is serving exactly this inbox: a well-formed marker for this seat, this
 * session and this root, whose process is still there. Anything else — no marker, a malformed
 * one, a dead pid, a marker naming another inbox — is `no live inbox listener`, and the send
 * hands the message to the next leg instead of writing into a folder nothing is reading.
 */
export function inboxLive(dropDir: string, root: string, session: string, seat: string): InboxLiveness {
  const listener = readListener(dropDir);
  if (listener === null) return { live: false, reason: NO_INBOX_LISTENER };
  if (listener.seat !== seat || listener.session !== session || !sameRoot(listener.root, root)) {
    return { live: false, reason: NO_INBOX_LISTENER };
  }
  if (!listenerLive(listener)) return { live: false, reason: NO_INBOX_LISTENER };
  return { live: true, listener };
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
 * Every message waiting in this seat's own folder: a UUID-named regular file with no signed read
 * receipt beside it. Oldest first. Anything else in the folder — a link, a marker, a directory —
 * is not a message and is skipped; a receipt the message key did not sign proves nothing, so the
 * message still waits.
 */
export function listUnread(dropDir: string, context: StatusContext, home: string): InboxMessage[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const key = messageKeyState(home);
  const messages: InboxMessage[] = [];
  for (const name of names) {
    if (!MESSAGE_ID.test(name)) continue;
    const at = join(dropDir, name);
    if (heldAt(at).kind !== 'file') continue;
    if (key.kind === 'key' && isRead(dropDir, name, context, key.key)) continue;
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

/** Why a record was refused, as the rule and the object a refusal event names. The rule is one
 *  of the checks the read makes; the object is the record's id, the seat whose inbox it holds,
 *  and its path. A missing file or a bad id is not a refusal of a record and carries none. */
export type InboxRefusal = {
  rule: 'shape' | 'seat' | 'session' | 'root' | 'key' | 'signature';
  id: string;
  seat: string;
  path: string;
};

export type InboxRead =
  | { ok: true; body: string }
  | { ok: false; reason: string; refusal?: InboxRefusal; superseded?: true };

/**
 * The claim a brief's read is served under. `claim` is resolved again immediately before the
 * receipt is written, so a delivery that landed while the record was being verified is seen: its
 * id, incarnation, digest and epoch must all still be the ones the served record names. `epoch`
 * is the runtime the reader was started under; absent — a manual `team drops --read` — the read
 * binds the claim it serves, which is the same epoch on the receipt.
 */
export type BriefRead = { claim: () => CurrentBriefClaim | null; epoch?: string };

/** The inbox a read serves: the launch's own folder, root, seat and session. */
export type InboxTarget = { dropDir: string; root: string; seat: string; session: string };

/**
 * Reads one message, verifies it, and only then writes its receipt **before** returning the body:
 * a read that cannot leave proof is refused, so `delivered (read)` can never rest on a body the
 * client saw without the receipt on disk. The record is parsed as the signed envelope `team send`
 * writes, its signature is checked with the checkout's message key, and it must name this inbox —
 * its seat, session and root — before any body is shown. A file that is not a record, a tampered
 * signature, an absent key and a record bound elsewhere are all refused with no body and no
 * receipt written. The id is a lowercase UUID; no other string reaches the filesystem.
 *
 * A record the launch wrote is read only as the seat's **current** brief: when `brief` is given,
 * the record's sender and rule must be the launch's, and the id, incarnation and delivered
 * digest on it must be the claim's — resolved again directly before the receipt, so a delivery
 * that replaced the claim mid-read is not served. An earlier brief is not a refusal: the read
 * returns `superseded`, writes nothing and moves on. The runtime epoch the reader was started
 * with (`brief.epoch`) must be the claim's too: a process started under an earlier runtime
 * serves nothing until its seat is launched again. The receipt carries the claim's binding and
 * the claim's diagnostics, and a name already held by a file that does not verify for this
 * claim is refused rather than replaced — only the rollout's recovery may move past it.
 */
export function readMessage(target: InboxTarget, id: string, home: string, brief?: BriefRead): InboxRead {
  if (!MESSAGE_ID.test(id)) return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
  const at = join(target.dropDir, id);
  if (heldAt(at).kind !== 'file') return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
  const atReceipt = heldAt(receiptPath(target.dropDir, id));
  if (atReceipt.kind !== 'missing' && atReceipt.kind !== 'file') {
    return { ok: false, reason: 'the receipt path is held by something that is not a file' };
  }
  const refused = (rule: InboxRefusal['rule'], reason: string): InboxRead => ({
    ok: false,
    reason,
    refusal: { rule, id, seat: target.seat, path: at },
  });
  const looked = readRecord(at, id);
  if (!looked.ok) {
    return refused('shape', `message ${JSON.stringify(id)} is not a signed record: ${looked.reason}`);
  }
  if (looked.record === null) return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
  const payload = looked.record.payload;
  if (payload.to !== target.seat) {
    return refused('seat', `message ${JSON.stringify(id)} is not addressed to this inbox`);
  }
  if (payload.session !== target.session) {
    return refused('session', `message ${JSON.stringify(id)} is not addressed to this inbox`);
  }
  if (!sameRoot(payload.root, target.root)) {
    return refused('root', `message ${JSON.stringify(id)} is bound to another checkout`);
  }
  const key = messageKeyState(home);
  if (key.kind !== 'key') {
    return refused(
      'key',
      key.kind === 'unreadable' ? `the message key is unreadable: ${key.why}` : 'no message key; nothing was shown',
    );
  }
  if (!verifyRecord(looked.record, key.key)) {
    return refused('signature', `message ${JSON.stringify(id)} does not verify against this message key`);
  }
  // The launch's own record is served only as the seat's current brief. The claim is resolved
  // again directly before the receipt so a delivery that landed during this read is noticed.
  const launchRecord = payload.from === GENERAL_BRIEF_FROM && payload.rule === GENERAL_BRIEF_RULE;
  let binding: { incarnation: string; sha256: string; epoch: string } | undefined;
  let servedClaim: CurrentBriefClaim | undefined;
  if (launchRecord) {
    const claim = brief?.claim() ?? null;
    const epoch = brief?.epoch ?? claim?.epoch;
    const serves = claim !== null
      && claim.id === id
      && claim.incarnation === payload.incarnation
      && claim.sha256 === payload.brief_sha256
      && epoch === claim.epoch;
    if (!serves) return { ok: false, reason: 'the general seat brief has been superseded by a later delivery', superseded: true };
    const again = brief?.claim() ?? null;
    if (again === null || again.id !== claim.id || again.incarnation !== claim.incarnation
      || again.sha256 !== claim.sha256 || again.epoch !== claim.epoch) {
      return { ok: false, reason: 'the general seat brief has been superseded by a later delivery', superseded: true };
    }
    binding = { incarnation: claim.incarnation, sha256: claim.sha256, epoch: claim.epoch };
    servedClaim = claim;
  }
  // The signed status receipt `team messages` also writes: one shape under one name, so `statusOf`,
  // `team drops` and the watch all read it. It is write-once — a second read finds it there and
  // changes nothing, and no read can move the status backward.
  const receipt: ReceiptPayload = {
    kind: 'receipt',
    status: 'read',
    id,
    to: target.seat,
    root: target.root,
    session: target.session,
    at: new Date().toISOString(),
    ...(binding === undefined ? {} : {
      brief_sha256: binding.sha256,
      incarnation: binding.incarnation,
      brief_epoch: binding.epoch,
      ...(servedClaim?.seat_handle === undefined ? {} : { brief_seat_handle: servedClaim.seat_handle }),
      ...(servedClaim?.pane_root_pid === undefined ? {} : { brief_pane_root_pid: servedClaim.pane_root_pid }),
    }),
  };
  const written = writeReceipt(target.dropDir, signReceiptPayload(receipt, home), home, binding);
  if (!written.ok) {
    if (written.reason === 'the read receipt name is held by a file that does not verify for this brief') {
      return { ok: false, reason: written.reason };
    }
    return { ok: false, reason: 'the receipt could not be written, so the message is not returned' };
  }
  return { ok: true, body: payload.body };
}

/**
 * Whether the message carries a signed read (or replied) receipt that verifies with the checkout's
 * message key: the one proof an `inbox_read` or a `team messages` read leaves before the body is
 * shown. A file at a receipt's name that does not parse, that was not signed by this key, or that
 * names another message, seat, checkout or session proves nothing — the send must not report a
 * read it cannot point at.
 */
export function receiptHeld(dropDir: string, id: string, context: StatusContext, home: string): boolean {
  const key = messageKeyState(home);
  return key.kind === 'key' && isRead(dropDir, id, context, key.key);
}

/**
 * Waits up to `timeoutMs` for the receipt, looking once, then every `pollMs`. The
 * caller's grace bounds the wait even while the disk keeps answering; a timeout of zero is the
 * one look and no wait at all.
 */
export async function awaitReceipt(
  dropDir: string,
  id: string,
  context: StatusContext,
  home: string,
  timeoutMs: number,
  pollMs = INBOX_POLL_MS,
): Promise<boolean> {
  if (receiptHeld(dropDir, id, context, home)) return true;
  const deadline = Date.now() + timeoutMs;
  for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollMs, left));
    });
    if (receiptHeld(dropDir, id, context, home)) return true;
  }
  return false;
}
