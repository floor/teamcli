// The seat's inbox: the drop folder `team send` already writes, read from the seat's own side.
//
// `team send` writes one message per file, whole and 0600, into
// `<root>/.agents/send-drops/<session>/<seat>/<uuid>`. The MCP inbox adds nothing to the message:
// a listener marker says a server is there, and an `inbox_read` call writes the same signed status
// receipt `team messages` writes — `<id>.read.json`, `status: read`, signed with the checkout's
// message key — so every reader of a status agrees on what the file is. The drop file is still the
// message; both sidecars are conveniences written atomically at 0600 — the drop by rename, the
// read receipt by an exclusive, no-clobber `link`.
// A read parses the record and verifies its signature with the message key before it writes the
// receipt or shows a body: a tampered or unsigned file is refused, so the receipt never proves a
// read of something the server could not authenticate. The read receipt is published with an
// exclusive, no-clobber `link`, so exactly one reader can create it and no reader can replace it.
//
// Path rules, which the server never relaxes: the seat and session are the launch's, never a tool
// argument's; the folder is checked step by step so a link at `.agents`, `send-drops`, the
// session or the seat refuses service; an id is a lowercase UUID — or the `unread-<uuid>` name a
// build before 0.5.3 wrote for a runtime report to a lead — and nothing else, so no id can name a
// path; a drop or receipt that is a link is refused, never followed.
import type { KeyObject } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  briefBindingOf,
  currentBriefClaim,
  GENERAL_BRIEF_FROM,
  GENERAL_BRIEF_RULE,
  type CurrentBriefClaim,
} from '../launch/general-brief.ts';
import type { BriefBinding } from '../launch/brief-id.ts';
import { heldAt } from '../launch/rules-file.ts';
import { readNoFollow } from '../send/history.ts';
import { dropMessage } from '../send/native.ts';
import { readState } from '../state.ts';
import {
  isRead,
  readRecord,
  receiptFile,
  signReceiptPayload,
  verifyRecord,
  type ReceiptPayload,
  type StatusContext,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';
import type { BuildIdentity } from '../version.ts';
import { flushReceipt, publishReadReceipt } from './inbox-admission.ts';

/** The listener marker's name in the seat's own drop folder. */
export const LISTENER_FILE = '.inbox-listener';

/** The only names the server serves: the ids `team send` writes (`randomUUID`, lowercase). */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The name a build before 0.5.3 gave a runtime report drop addressed to a team's lead: the source
 * message's own lowercase UUID under `unread-`. The drop is a signed message record then and now;
 * only its name kept it out of this inbox, so `team drops --json` listed it while `team drops
 * --read` never served it and never wrote its receipt. Those files are residual state, not
 * something this build writes — a current report drop carries the bare UUID — and this inbox
 * serves one like any other record so the listing and the read agree on what is waiting.
 */
export const LEGACY_REPORT_ID = /^unread-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `name` is a record name this inbox serves: a bare message id, or the `unread-<uuid>`
 *  name an earlier build wrote for a lead's runtime report. Both are fixed shapes, so no other
 *  string reaches the filesystem. */
export function messageNameOk(name: string): boolean {
  return MESSAGE_ID.test(name) || LEGACY_REPORT_ID.test(name);
}

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

/** What a running server leaves beside the inbox so `team send` can tell the leg is live. The
 *  build fields are the identity of the code serving the inbox; a marker written before they
 *  existed lacks them, and the reader treats that marker as a runtime it cannot vouch for. */
export type InboxListener = {
  v: 1;
  seat: string;
  session: string;
  root: string;
  cli: string;
  pid: number;
  ts: string;
  version?: string;
  build?: string | null;
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
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.build === 'string' || parsed.build === null ? { build: parsed.build } : {}),
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

/**
 * Whether a live marker's runtime is the build asking. A server started from an older build has
 * that build's parsers in memory for as long as its process runs: a signed record this build
 * writes can carry fields the older parser drops before it verifies, and the read it attempts
 * fails on the signature. Installing a build does not reload a running server, so the marker's
 * identity is how a sender tells the two apart instead of writing a drop nothing can read.
 * A marker written without an identity is not vouched for: its start time can prove it predates
 * this build, and nothing can prove it does not. The fix is always the seat's own restart — no
 * check is downgraded and no process is killed from here.
 */
export type ListenerRuntime = { kind: 'current' } | { kind: 'stale'; reason: string };

export function listenerRuntime(listener: InboxListener, build: BuildIdentity): ListenerRuntime {
  const restart = "restart the seat's CLI host so its MCP server reloads this build";
  if (listener.version !== undefined) {
    if (listener.version !== build.version) {
      return { kind: 'stale', reason: `the inbox listener runs ${listener.version}, this build is ${build.version}; ${restart}` };
    }
    if (listener.build != null && build.build != null && listener.build !== build.build) {
      return { kind: 'stale', reason: `the inbox listener runs a different build of ${build.version}; ${restart}` };
    }
    return { kind: 'current' };
  }
  const started = Date.parse(listener.ts);
  if (Number.isFinite(started) && build.builtAt > 0 && started < build.builtAt) {
    return {
      kind: 'stale',
      reason: `the inbox listener started before this build (${build.version}) was installed and records no build identity; ${restart}`,
    };
  }
  return { kind: 'stale', reason: `the inbox listener records no build identity; ${restart}` };
}

export type InboxLiveness = { live: true; listener: InboxListener } | { live: false; reason: string };

/**
 * Whether a server is serving exactly this inbox: a well-formed marker for this seat, this
 * session and this root, whose process is still there and — when the caller names the build it
 * is — whose runtime is that build. Anything else — no marker, a malformed one, a dead pid, a
 * marker naming another inbox — is `no live inbox listener`, and the send hands the message to
 * the next leg instead of writing into a folder nothing is reading. A live marker from another
 * build is reported as such, so the walk records the stale runtime and the seat is restarted
 * rather than silently fed. A caller that names no build keeps the liveness-only answer.
 */
export function inboxLive(
  dropDir: string,
  root: string,
  session: string,
  seat: string,
  build?: BuildIdentity | null,
): InboxLiveness {
  const listener = readListener(dropDir);
  if (listener === null) return { live: false, reason: NO_INBOX_LISTENER };
  if (listener.seat !== seat || listener.session !== session || !sameRoot(listener.root, root)) {
    return { live: false, reason: NO_INBOX_LISTENER };
  }
  if (!listenerLive(listener)) return { live: false, reason: NO_INBOX_LISTENER };
  if (build !== undefined && build !== null) {
    const runtime = listenerRuntime(listener, build);
    if (runtime.kind === 'stale') return { live: false, reason: runtime.reason };
  }
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

/** The time a message's own record names when that record verifies with this checkout's key, and
 *  null otherwise. The `.pending` marker beside a message is unsigned, and a file's mtime is the
 *  filesystem's: neither may date a record the key signed, so a listing counts from this when it
 *  is there and falls back only for a record this key cannot vouch for. */
function signedTimeOf(path: string, id: string, key: KeyObject): string | null {
  const looked = readRecord(path, id);
  if (!looked.ok || looked.record === null || !verifyRecord(looked.record, key)) return null;
  const at = looked.record.payload.at;
  return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
}

/** The current claim of one seat's general seat brief, read from the checkout's state; null when
 *  the state cannot be read or holds no current claim. */
export function currentClaimIn(root: string, session: string, seat: string): CurrentBriefClaim | null {
  try {
    return currentBriefClaim(readState(join(root, '.agents')).sessions[session]?.briefs?.[seat]);
  } catch {
    return null;
  }
}

/**
 * Every message waiting in this seat's own folder: a record-named regular file (a message id, or
 * the `unread-<uuid>` name an earlier build wrote for a lead's runtime report) with no signed read
 * receipt beside it. Oldest first. Anything else in the folder — a link, a marker, a directory —
 * is not a message and is skipped; a receipt the message key did not sign proves nothing, so the
 * message still waits. An earlier delivery of the seat's general seat brief is not waiting mail:
 * the claim names the ids it replaced, and a read could only refuse them as superseded. A receipt
 * at the current claim's own id counts only when it binds that claim, so a read of an earlier
 * delivery — or an ordinary one — never hides the delivery the claim names: the drop is listed,
 * and the read refuses the occupied name with no body.
 *
 * A message whose record verifies is dated by the record's own signed `at`. The `.pending` marker
 * beside it is unsigned, and the file's mtime is the filesystem's; neither can age a record this
 * checkout's key signed, so a planted marker cannot make a message due for a wake or a report.
 */
export function listUnread(dropDir: string, context: StatusContext, home: string): InboxMessage[] {
  let names: string[];
  try {
    names = readdirSync(dropDir);
  } catch {
    return [];
  }
  const key = messageKeyState(home);
  const claim = currentClaimIn(context.root, context.session, context.to);
  const superseded = new Set(claim?.superseded ?? []);
  const messages: InboxMessage[] = [];
  for (const name of names) {
    if (!messageNameOk(name)) continue;
    if (superseded.has(name)) continue;
    const at = join(dropDir, name);
    if (heldAt(at).kind !== 'file') continue;
    const binding = claim !== null && name === claim.id ? briefBindingOf(claim) : undefined;
    if (key.kind === 'key' && isRead(dropDir, name, context, key.key, binding)) continue;
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
    // A record this key signed is dated by its own `at`; an unsigned marker or the file's mtime
    // dates only a record the key cannot vouch for.
    const signed = key.kind === 'key' ? signedTimeOf(at, name, key.key) : null;
    messages.push({
      id: name,
      ...(marker.from !== undefined ? { from: marker.from } : {}),
      ts: signed ?? marker.ts ?? new Date(mtime).toISOString(),
      bytes: size,
    });
  }
  return messages.sort((a, b) => (Date.parse(a.ts) - Date.parse(b.ts)) || a.id.localeCompare(b.id));
}

/** The text as JSON, or undefined when it is not JSON at all. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Whether the file at `path` is a drop an earlier build wrote: plain text, not JSON at all. This
 * build can never serve one — it is unsigned, and nothing in it can be verified — so the inbox
 * neither lists it nor raises its refusal to the owner; `team drops --read` skips and counts the
 * same file. Only a regular file of this user's is classified; a link, a FIFO, a directory,
 * another user's file or one that cannot be read is answered exactly as before — for a link, a
 * FIFO or a directory at the drop's name, that answer is a tool error with no refusal event. A
 * file that opens as JSON is not classified either: a tampered or truncated signed record starts
 * as a JSON object, and is never mistaken for old plain-text mail.
 */
export function legacyDropAt(path: string): boolean {
  const held = heldAt(path);
  if (held.kind !== 'file' || (process.getuid !== undefined && held.uid !== process.getuid())) return false;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  if (parsedJson(text) !== undefined) return false;
  return !text.trimStart().startsWith('{');
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
  // `served` marks a race the gate decided without a body: `already-served` when a verifiable
  // receipt won the name. `busy` stays in the union for callers and fixtures that predate the
  // receipt-only gate; this version never emits it.
  | { ok: false; reason: string; refusal?: InboxRefusal; superseded?: true; served?: 'already-served' | 'busy' };

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
 * receipt written. The id is a lowercase UUID, or the `unread-<uuid>` name an earlier build gave a
 * lead's runtime report; no other string reaches the filesystem.
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
 *
 * A message is served at most once. The signed read receipt is the per-id gate: a receipt that
 * already verifies for this message under this read's binding is proof the content went out, so
 * the read returns `already-served` and no body. Otherwise the read publishes its own signed
 * receipt with `link` (`inbox-admission.ts`) before it returns the body; the name is created
 * exclusively and never replaced, so exactly one reader wins and every rival is served nothing. A
 * file at the read or replied receipt name that does not verify for this message is uncertainty
 * about an earlier exposure: it is preserved and the read returns no body, never a rewritten
 * receipt. The receipt is flushed to disk before the body leaves. The honest guarantee is
 * at-most-once content exposure: a crash after the receipt but before the body spends the
 * message, and a crash before the receipt leaves no shared trace, so a later reader may serve.
 */
export function readMessage(target: InboxTarget, id: string, home: string, brief?: BriefRead): InboxRead {
  if (!messageNameOk(id)) return { ok: false, reason: `no message ${JSON.stringify(id)} in this inbox` };
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
  // Read-once admission. The signed receipt is the per-id gate: a receipt that already verifies
  // under this read's binding proves the content went out, and the read shows nothing. Any other
  // entry at the read or replied receipt name is uncertainty about an earlier exposure, so it is
  // preserved and no body is returned. Otherwise this reader races every other reader to publish
  // the signed receipt with `link`; exactly one wins, and only the winner returns the body.
  const context: StatusContext = { to: target.seat, root: target.root, session: target.session };
  const receiptHeldNow = (): boolean => isRead(target.dropDir, id, context, key.key, binding);
  const alreadyServed = (): InboxRead => ({
    ok: false,
    reason: `message ${JSON.stringify(id)} was already served in this inbox`,
    served: 'already-served',
  });
  const readName = receiptPath(target.dropDir, id);
  const repliedName = receiptFile(target.dropDir, id, 'replied');
  const occupied = (): InboxRead => ({
    ok: false,
    reason: binding === undefined
      ? `the read receipt name is held by a file that does not verify for message ${JSON.stringify(id)}`
      : 'the read receipt name is held by a file that does not verify for this brief',
  });
  if (receiptHeldNow()) return alreadyServed();
  const atRead = heldAt(readName);
  if (atRead.kind === 'file') return receiptHeldNow() ? alreadyServed() : occupied();
  if (atRead.kind !== 'missing') {
    return { ok: false, reason: 'the receipt path is held by something that is not a file' };
  }
  const atReplied = heldAt(repliedName);
  if (atReplied.kind === 'file') {
    // A replied receipt is a read that came before its answer. One that does not verify for this
    // message may still be proof an earlier exposure happened, so it is never replaced.
    return receiptHeldNow()
      ? alreadyServed()
      : { ok: false, reason: `the replied receipt name is held by a file that does not verify for message ${JSON.stringify(id)}` };
  }
  if (atReplied.kind !== 'missing') {
    return { ok: false, reason: 'the replied receipt path is held by something that is not a file' };
  }
  // The launch's claim is resolved once more directly before the receipt: a delivery that landed
  // while the record was being verified must not be served under the earlier binding.
  if (launchRecord) {
    const current = brief?.claim() ?? null;
    if (current === null || servedClaim === undefined
      || current.id !== servedClaim.id || current.incarnation !== servedClaim.incarnation
      || current.sha256 !== servedClaim.sha256 || current.epoch !== servedClaim.epoch) {
      return { ok: false, reason: 'the general seat brief has been superseded by a later delivery', superseded: true };
    }
  }
  // The signed status receipt `team messages` also writes: one shape under one name, so `statusOf`,
  // `team drops` and the watch all read it. This reader publishes it with `link`, so the name is
  // created once and never replaced: a rival's receipt, valid or not, is left exactly as it is.
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
  const published = publishReadReceipt(readName, `${JSON.stringify(signReceiptPayload(receipt, home), null, 2)}\n`);
  if (published === 'exists') {
    // A rival won the name between the check and this link. Its receipt is the single serving of
    // this id: verify it, and never replace it. If it does not verify, the name is uncertain and
    // stays as evidence; either way this read returns no body.
    return receiptHeldNow() ? alreadyServed() : occupied();
  }
  if (published === 'failed') {
    return { ok: false, reason: 'the receipt could not be written, so the message is not returned' };
  }
  // The receipt must survive a crash before any body is shown. A receipt that cannot be
  // flushed is not proof, so the read returns nothing (and the message stays spent).
  if (!flushReceipt(readName, target.dropDir)) {
    return { ok: false, reason: 'the receipt could not be made durable, so the message is not returned' };
  }
  return { ok: true, body: payload.body };
}

/**
 * Whether the message carries a signed read (or replied) receipt that verifies with the checkout's
 * message key: the one proof an `inbox_read` or a `team messages` read leaves before the body is
 * shown. A file at a receipt's name that does not parse, that was not signed by this key, or that
 * names another message, seat, checkout or session proves nothing — the send must not report a
 * read it cannot point at. When `id` names the seat's current general-brief claim, `brief`
 * narrows the receipt to that claim — a read of an earlier delivery is not a read of this one —
 * and every other message passes none.
 */
export function receiptHeld(
  dropDir: string,
  id: string,
  context: StatusContext,
  home: string,
  brief?: BriefBinding,
): boolean {
  const key = messageKeyState(home);
  return key.kind === 'key' && isRead(dropDir, id, context, key.key, brief);
}

/** The claim binding a receipt must carry when `id` names the seat's current brief; undefined for
 *  every other message. This is the same binding `listUnread` applies when it decides what waits,
 *  so a reader that calls it cannot promote a stale receipt the reading already refused. */
export function claimBindingIn(root: string, session: string, seat: string, id: string): BriefBinding | undefined {
  const claim = currentClaimIn(root, session, seat);
  return claim !== null && claim.id === id ? briefBindingOf(claim) : undefined;
}

/**
 * Waits up to `timeoutMs` for the receipt, looking once, then every `pollMs`. The
 * caller's grace bounds the wait even while the disk keeps answering; a timeout of zero is the
 * one look and no wait at all. `brief` is the claim binding `claimBindingIn` derives for this
 * message; a receipt that does not carry it cannot satisfy the wait, as on every other route.
 */
export async function awaitReceipt(
  dropDir: string,
  id: string,
  context: StatusContext,
  home: string,
  timeoutMs: number,
  brief?: BriefBinding,
  pollMs = INBOX_POLL_MS,
): Promise<boolean> {
  if (receiptHeld(dropDir, id, context, home, brief)) return true;
  const deadline = Date.now() + timeoutMs;
  for (let left = deadline - Date.now(); left > 0; left = deadline - Date.now()) {
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollMs, left));
    });
    if (receiptHeld(dropDir, id, context, home, brief)) return true;
  }
  return false;
}
