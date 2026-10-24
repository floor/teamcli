// The client's own inbox: the folder a seat's replies land in, the authenticated read that lists
// them, and the write-once ack receipt that marks one read.
//
// The inbox is `<teamRoot>/.agents/send-drops/<session>/.clients/<client id>/`. The leading dot is
// what keeps it out of every seat reader: `team messages`, `team reply`, `team drops`, the watch
// and bus reconcile all filter the session folder's first segment with a name pattern that a
// leading dot cannot match. Nothing here writes under a seat folder except the `replied` receipt
// the reply path already writes there.
//
// The folder is created 0700 by `mkdir` and never chmod'ed. A folder found with a group or other
// bit is refused, naming the repair, rather than repaired in place. Records and receipts are
// written whole at mode 0600 through a temporary file linked onto the final name: publication
// never replaces an existing name, and no `chmod` call runs on the inbox or its files.
//
// A read is a signed, replay-checked request: the v2 request carries the cursor, the ack and the
// page bound inside its signature, and its request id is claimed under the grant lock before any
// row is scanned or printed. Rows are shown only when the record verifies, names this client and
// its own thread, and was written by the seat and agent the thread's originating canonical grant
// signed. The grant need not still be active: history survives revocation and reissue. It does
// have to be in the canonical store.

import { clientPaneGuard } from './pane-guard.ts';
import { randomBytes, type KeyObject } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Args } from '../args.ts';
import { heldAt } from '../launch/rules-file.ts';
import type { Io } from '../io.ts';
import {
  contextLine,
  formatRelativeTime,
  pluralCount,
  renderDifferences,
  renderNotes,
  renderTable,
  summaryCounts,
  ttyStyle,
  toJsonDifference,
  type OutputDifference,
} from '../output/index.ts';
import {
  receiptHolds,
  readRecord,
  recordFile,
  recordNameOk,
  signReceiptPayload,
  verifyRecord,
  type RecordPayload,
  type ReceiptPayload,
  type SignedReceipt,
} from '../send/record.ts';
import { messageKeyState } from '../store/keys.ts';
import { claimClientRequest } from './replay.ts';
import {
  KEY_ISOLATION_LINE,
  activeClientGrant,
  readClientGrant,
  readClientGrantFile,
  resolveEntityCoordinator,
  withClientGrantLock,
  type ClientGrantRecord,
  type EntityCoordinator,
} from './records.ts';
import { CLIENT_REPLY_ID_PATTERN, verifyClientRead, type ClientReadRequest } from './verify.ts';
import { recordDir } from '../commands/messages.ts';

/** The default page bound, and the largest page a read admits. */
export const CLIENT_READ_DEFAULT_LIMIT = 20;
export const CLIENT_READ_MAX_LIMIT = 100;

/** The name a client id has in a path: one lowercase word, digits and hyphens. */
const CLIENT_WORD_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One file or receipt name in the inbox: a record id, no separators. */
function inboxNameOk(name: string): boolean {
  return recordNameOk(name) && !name.startsWith('.');
}

/** The inbox folder: `<root>/.agents/send-drops/<session>/.clients/<clientId>`. */
export function clientInboxFolder(root: string, session: string, clientId: string): string {
  return join(root, '.agents', 'send-drops', session, '.clients', clientId);
}

/** The read receipt beside one reply: `<id>.read.json`. */
export function clientInboxReceiptPath(dir: string, id: string): string {
  return join(dir, `${id}.read.json`);
}

function sameFolder(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(left) === real(right);
}

type FolderCheck = { ok: true } | { ok: false; why: string };

/**
 * Checks one inbox folder after creation: a plain directory of this user, mode 0700. A folder with
 * any group or other bit, a link, or another user's folder is refused with the repair named, never
 * chmod'ed into place.
 */
function checkInboxFolder(folder: string): FolderCheck {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(folder);
  } catch {
    return { ok: false, why: `the client inbox folder "${folder}" cannot be read` };
  }
  if (stat.isSymbolicLink()) {
    return { ok: false, why: `the client inbox folder "${folder}" is a symbolic link; the inbox is a plain folder` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, why: `the client inbox folder "${folder}" is not a folder; remove it and retry` };
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    return { ok: false, why: `the client inbox folder "${folder}" belongs to another user; the owner checks it` };
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      why: `the client inbox folder "${folder}" is readable by a group or another user (mode ${mode.toString(8)}); the owner runs \`chmod 700 "${folder}"\` and retries`,
    };
  }
  if ((mode & 0o700) !== 0o700) {
    return {
      ok: false,
      why: `the client inbox folder "${folder}" is not writable by its owner (mode ${mode.toString(8)}); the owner runs \`chmod 700 "${folder}"\` and retries`,
    };
  }
  return { ok: true };
}

/**
 * Creates and checks the inbox folders: `.clients` and `.clients/<clientId>`, both 0700 at
 * creation. No `chmod` runs: a folder that already exists with broader bits is refused.
 */
export function ensureClientInbox(root: string, session: string, clientId: string): { ok: true; dir: string } | { ok: false; why: string } {
  if (!CLIENT_WORD_PATTERN.test(clientId)) return { ok: false, why: `"${clientId}" is not a client id` };
  const clients = join(root, '.agents', 'send-drops', session, '.clients');
  const dir = join(clients, clientId);
  for (const folder of [clients, dir]) {
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, why: `the client inbox folder "${folder}" cannot be created` };
    }
  }
  for (const folder of [clients, dir]) {
    const check = checkInboxFolder(folder);
    if (!check.ok) return check;
  }
  return { ok: true, dir };
}

/**
 * Publishes one file whole at mode 0600: a dot-named temporary in the same folder, written and
 * flushed, then linked onto the final name. `exists` means a file already holds the name and was
 * not replaced. No `chmod` call runs on the folder or the file.
 */
export function writeClientInboxFile(dir: string, name: string, content: string): 'written' | 'exists' | 'failed' {
  if (!inboxNameOk(name)) return 'failed';
  const final = join(dir, name);
  const temporary = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(temporary, 'wx', 0o600);
  } catch {
    return 'failed';
  }
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(temporary);
    } catch {}
    return 'failed';
  }
  closeSync(fd);
  try {
    linkSync(temporary, final);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
  try {
    const handle = openSync(dir, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  } catch {}
  return 'written';
}

export type ReceiptState = 'missing' | 'verified' | 'invalid';

/**
 * The ack receipt beside one reply: absent, a verified `read` receipt for this client and reply,
 * or something at the name that does not verify. `invalid` fails closed at the ack: it is never
 * trusted as already-acked and never overwritten, so a planted or damaged receipt cannot fork the
 * idempotence handle.
 */
export function clientInboxReceiptState(
  dir: string,
  id: string,
  context: { to: string; root: string; session: string },
  key: KeyObject,
): ReceiptState {
  const path = clientInboxReceiptPath(dir, id);
  const held = heldAt(path);
  if (held.kind === 'missing') return 'missing';
  if (held.kind !== 'file') return 'invalid';
  return receiptHolds(path, id, 'read', context, key) ? 'verified' : 'invalid';
}

/** One reply this read can show: every provenance check passed, and its body may be printed. */
export type ShownReply = {
  id: string;
  at: string;
  from: string;
  from_id: string;
  to: string;
  body: string;
  thread: string;
  grantId: string;
};

/** One file in the inbox that is not a verified reply; its body is never printed. */
export type RefusedReply = {
  id: string;
  at: string | null;
  from: string | null;
  to: string | null;
  why: string;
};

export type InboxScan = { shown: ShownReply[]; refused: RefusedReply[] };

type ScanContext = { home: string; root: string; session: string; clientId: string; key: KeyObject };

/** The marker names a seat's reply leaves beside a record; none of them is a reply. */
function isMarkerName(name: string): boolean {
  return name.endsWith('.json') || name.endsWith('.pending') || name.endsWith('.taken') || name.endsWith('.read') || name.startsWith('work-');
}

/** A difference's `who`: the owner checks a damaged inbox row. */
function refusedRow(id: string, payload: RecordPayload | null, why: string): RefusedReply {
  return {
    id,
    at: payload?.at ?? null,
    from: payload?.from ?? null,
    to: payload?.to ?? null,
    why,
  };
}

type ThreadRead =
  | { ok: true; grant: ClientGrantRecord; root: RecordPayload }
  | { ok: false; why: string; payload: RecordPayload | null };

/**
 * Whether `payload` is a reply onto this client's own verified thread, and what the thread's
 * originating grant is. Every check is provenance: the addressee is the client, the thread root
 * sits in the thread grant's recipient seat folder and names the same grant, and the writer is
 * exactly that grant's signed recipient seat and agent id. The grant is read from the canonical
 * store and must verify under the owner key; it need not still be active — history stays readable.
 */
function threadOf(context: ScanContext, payload: RecordPayload): ThreadRead {
  if (payload.to_client === undefined) {
    return { ok: false, why: 'the record is not addressed to a client (it carries no to_client)', payload };
  }
  if (payload.to !== `client:${context.clientId}`) {
    return { ok: false, why: `the record is addressed to ${payload.to}, not to client:${context.clientId}`, payload };
  }
  if (payload.to_id !== null) {
    return { ok: false, why: 'a reply to a client carries a null to_id', payload };
  }
  if (payload.to_client.client_id !== context.clientId) {
    return { ok: false, why: `the record names client "${payload.to_client.client_id}", not "${context.clientId}"`, payload };
  }
  if (payload.in_reply_to === undefined || payload.thread !== payload.in_reply_to) {
    return { ok: false, why: 'the record does not answer the thread it names (thread !== in_reply_to)', payload };
  }
  if (!sameFolder(payload.root, context.root)) {
    return { ok: false, why: 'the record is bound to another checkout', payload };
  }
  if (payload.session !== context.session) {
    return { ok: false, why: `the record is bound to session ${JSON.stringify(payload.session)}`, payload };
  }
  const grantId = payload.to_client.grant_id;
  const grant = readClientGrant(context.home, grantId);
  if (!grant.ok) {
    return { ok: false, why: `the thread's originating grant ${grantId} does not verify in the canonical store: ${grant.why}`, payload };
  }
  if (grant.grant.clientId !== context.clientId) {
    return { ok: false, why: `the thread's grant ${grantId} names client "${grant.grant.clientId}", not "${context.clientId}"`, payload };
  }
  if (payload.from !== grant.grant.recipientSeat) {
    return { ok: false, why: `the reply names sender "${payload.from}", not the thread grant's seat "${grant.grant.recipientSeat}"`, payload };
  }
  if (payload.from_id === null || payload.from_id !== grant.grant.recipientId) {
    return { ok: false, why: `the reply's from_id is not the thread grant's agent id ${grant.grant.recipientId}`, payload };
  }

  const seatDir = recordDir(context.root, context.session, grant.grant.recipientSeat);
  const rootPath = recordFile(seatDir, payload.thread);
  const rootRead = readRecord(rootPath, payload.thread);
  if (!rootRead.ok) {
    return { ok: false, why: `the thread root ${payload.thread} cannot be read: ${rootRead.reason}`, payload };
  }
  if (rootRead.record === null) {
    return { ok: false, why: `the thread root ${payload.thread} waits in no folder of the thread grant's seat`, payload };
  }
  if (!verifyRecord(rootRead.record, context.key)) {
    return { ok: false, why: `the thread root ${payload.thread} does not verify against this message key`, payload };
  }
  const root = rootRead.record.payload;
  if (root.from_client === undefined || root.to_client !== undefined) {
    return { ok: false, why: `the thread root ${payload.thread} was not written by a client`, payload };
  }
  if (root.from_client.client_id !== context.clientId) {
    return { ok: false, why: `the thread root ${payload.thread} names client "${root.from_client.client_id}", not "${context.clientId}"`, payload };
  }
  if (root.from_client.grant_id !== grantId) {
    return { ok: false, why: `the thread root names grant ${root.from_client.grant_id}, not the reply's ${grantId}`, payload };
  }
  if (root.thread !== root.id) {
    return { ok: false, why: `the thread root ${payload.thread} is not its own thread`, payload };
  }
  if (root.to !== grant.grant.recipientSeat) {
    return { ok: false, why: `the thread root is addressed to "${root.to}", not the grant's seat "${grant.grant.recipientSeat}"`, payload };
  }
  if (root.to_id !== grant.grant.recipientId) {
    return { ok: false, why: `the thread root's to_id is not the grant's agent id ${grant.grant.recipientId}`, payload };
  }
  if (root.session !== context.session || !sameFolder(root.root, context.root)) {
    return { ok: false, why: 'the thread root is bound to another session or checkout', payload };
  }
  return { ok: true, grant: grant.grant, root };
}

/**
 * Reads the client's own inbox: every reply that passes the provenance checks, and every other
 * record-like file as a refused row with the reason. Only `.clients/<client id>/` is scanned.
 */
export function scanClientInbox(context: ScanContext): { ok: true; scan: InboxScan } | { ok: false; why: string } {
  const dir = clientInboxFolder(context.root, context.session, context.clientId);
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, scan: { shown: [], refused: [] } };
    return { ok: false, why: `the client inbox "${dir}" cannot be read` };
  }
  const scan: InboxScan = { shown: [], refused: [] };
  for (const name of names) {
    if (!inboxNameOk(name) || isMarkerName(name)) continue;
    const path = join(dir, name);
    const read = readRecord(path, name);
    if (!read.ok) {
      scan.refused.push(refusedRow(name, null, `"${name}" cannot be read as a record: ${read.reason}`));
      continue;
    }
    if (read.record === null) continue;
    const payload = read.record.payload;
    if (!verifyRecord(read.record, context.key)) {
      scan.refused.push(refusedRow(name, payload, `"${name}" does not verify against this message key`));
      continue;
    }
    const thread = threadOf(context, payload);
    if (!thread.ok) {
      scan.refused.push(refusedRow(name, payload, `"${name}" is not a verified reply to this client: ${thread.why}`));
      continue;
    }
    scan.shown.push({
      id: name,
      at: payload.at,
      from: payload.from,
      from_id: payload.from_id as string,
      to: payload.to,
      body: payload.body,
      thread: payload.thread,
      grantId: thread.grant.grantId,
    });
  }
  return { ok: true, scan };
}

/** `at` ascending, then id ascending by code unit. */
export function orderClientReplies(replies: readonly ShownReply[]): ShownReply[] {
  return [...replies].sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** The positive integer page bound, or null when the value is not one. */
export function clientLimitOf(value: string | undefined): number | null {
  if (value === undefined) return CLIENT_READ_DEFAULT_LIMIT;
  if (!/^[0-9]+$/.test(value)) return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > CLIENT_READ_MAX_LIMIT) return null;
  return limit;
}

type ClientReading = {
  project: string;
  session: string;
  clientId: string;
  rows: { reply: ShownReply; body?: string }[];
  refused: RefusedReply[];
  notes: string[];
  differences: OutputDifference[];
  ack?: { id: string; status: 'acknowledged' | 'already-acked' | 'refused'; written: boolean; message?: string };
};

type AckOutcome = NonNullable<ClientReading['ack']>;

type ClientReadOutcome =
  | {
      ok: true;
      grant: ClientGrantRecord;
      coordinator: EntityCoordinator;
      inboxDir: string;
      scan: InboxScan;
      key: KeyObject;
      presented: { grant: ClientGrantRecord; signature: string };
      request: ClientReadRequest;
    }
  | { ok: false; kind: 'key' | 'refused'; why: string };

/**
 * Admits one read under the grant lock: re-reads the presented grant, resolves the checkout from
 * the registry (never from cwd), requires the signed binding to be the current coordinator, builds
 * and verifies the signed v2 request, requires the grant still active, claims the request id, and
 * only then scans the inbox. Any failure leaves no row scanned and no receipt written.
 */
function admitRead(
  input: { home: string; grantFile: string; keyFile: string; since: string | null; ack: string | null; limit: number; requestId?: string; now: Date },
): ClientReadOutcome {
  const presented = readClientGrantFile(input.home, input.grantFile);
  if (!presented.ok) return { ok: false, kind: 'refused', why: presented.why };
  const grant = presented.grant;
  const resolved = resolveEntityCoordinator(input.home, grant.entity, { seat: grant.recipientSeat, clientId: grant.clientId, ...(grant.team !== undefined ? { team: grant.team } : {}) });
  if (!resolved.ok) return { ok: false, kind: 'refused', why: resolved.why };
  const coordinator = resolved.coordinator;
  if (
    coordinator.teamId !== grant.teamId ||
    coordinator.recipientId !== grant.recipientId ||
    coordinator.recipientSeat !== grant.recipientSeat
  ) {
    return { ok: false, kind: 'refused', why: `the registry no longer names the coordinator and recipient the grant ${grant.grantId} signs` };
  }
  const verified = verifyClientRead({
    home: input.home,
    grantFile: input.grantFile,
    keyFile: input.keyFile,
    since: input.since,
    ack: input.ack,
    limit: input.limit,
    now: input.now,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  });
  if (!verified.ok) return { ok: false, kind: verified.kind, why: verified.why };
  // `verified.signature` is the request's signature; the active check wants the grant file's.
  const active = activeClientGrant(input.home, { grant: verified.grant, signature: presented.signature }, input.now);
  if (!active.ok) return { ok: false, kind: 'refused', why: active.why };
  // The registry binding is re-resolved after the active check: a rebinding that landed before
  // this point is seen here, before any row or claim.
  const rebound = resolveEntityCoordinator(input.home, active.grant.entity, { seat: active.grant.recipientSeat, clientId: active.grant.clientId, ...(active.grant.team !== undefined ? { team: active.grant.team } : {}) });
  if (!rebound.ok) return { ok: false, kind: 'refused', why: rebound.why };
  const current = rebound.coordinator;
  if (
    current.teamId !== active.grant.teamId ||
    current.recipientId !== active.grant.recipientId ||
    current.recipientSeat !== active.grant.recipientSeat ||
    !sameFolder(current.teamRoot, coordinator.teamRoot) ||
    current.session !== coordinator.session
  ) {
    return { ok: false, kind: 'refused', why: `the coordinator binding changed before the read; nothing was read` };
  }
  const claim = claimClientRequest(current.teamRoot, active.grant.clientId, verified.request.request_id, input.now);
  if (!claim.ok) return { ok: false, kind: 'refused', why: claim.why };
  const inbox = ensureClientInbox(current.teamRoot, current.session, active.grant.clientId);
  if (!inbox.ok) return { ok: false, kind: 'refused', why: inbox.why };
  const keyState = messageKeyState(input.home);
  if (keyState.kind !== 'key') {
    const why = keyState.kind === 'missing' ? 'no message key; nothing was shown' : `${keyState.why}; nothing was shown`;
    return { ok: false, kind: 'key', why };
  }
  const scanned = scanClientInbox({
    home: input.home,
    root: current.teamRoot,
    session: current.session,
    clientId: active.grant.clientId,
    key: keyState.key,
  });
  if (!scanned.ok) return { ok: false, kind: 'refused', why: scanned.why };
  return {
    ok: true,
    grant: active.grant,
    coordinator: current,
    inboxDir: inbox.dir,
    scan: scanned.scan,
    key: keyState.key,
    // The grant file's own signature, not the request's: the active check and every later re-check
    // read exactly the grant the signed request was built from, never a second read of the file.
    presented: { grant: verified.grant, signature: presented.signature },
    request: verified.request,
  };
}

/**
 * `team messages --client <grant-file> --key <key-file> [--since <id>] [--ack <id>]
 * [--limit <n>] [--request-id <id>] [--json]`.
 *
 * The read prints the client's own unacked replies (narrowed by `--since` and `--limit`) and
 * writes the ack receipt for `--ack` when it verifies and none exists. Every client invocation
 * prints the key-isolation line first, including a usage refusal. Exit 0 when the reading
 * completes (an empty one included), 1 when a row does not verify or the ack is refused, 2 when
 * the invocation cannot be read.
 */
export function runClientMessages(args: Args, io: Io, sources: { home: string; now(): Date }, json: boolean): number {
  // The declared limitation goes out exactly once per client invocation, before any outcome; the
  // JSON documents carry the same line in `key_isolation`.
  io.stderr(`${KEY_ISOLATION_LINE}\n`);
  // The client documents carry the same `error.code` shape the client send writes, so a client
  // reads one refusal format on both operations; `key_isolation` rides on every one.
  const errorDoc = (code: string, message: string): string =>
    `${JSON.stringify({ error: { code, message }, key_isolation: KEY_ISOLATION_LINE })}\n`;
  const usage = (why: string): number => {
    if (json) io.stdout(errorDoc('messages.client-usage', why));
    else io.stderr(`team messages: ${why}\n`);
    return 2; // exit: messages.client-usage
  };
  const keyRefusal = (why: string): number => {
    if (json) io.stdout(errorDoc('messages.client-key', why));
    else io.stderr(`team messages: ${why}\n`);
    return 1; // exit: messages.client-key
  };
  // Every refusal that is not about the key file leaves through this one site. `afterReading` is
  // set when the reading was already printed: the refused rows or the refused ack carry the
  // reason there, so the command only chooses the exit. An admission refusal prints no reading
  // and carries its own sentence.
  const refused = (why: string, afterReading = false): number => {
    if (!afterReading) {
      if (json) io.stdout(errorDoc('messages.client-refused', why));
      else io.stderr(`team messages: refused: ${why}\n`);
    }
    return 1; // exit: messages.client-refused
  };

  if (args.error !== undefined) return usage(args.error);
  if (args.rest.length > 0) return usage(`unexpected "${args.rest[0]}"`);
  const grantFile = args.values.client;
  const keyFile = args.values.key;
  if (grantFile === undefined) return usage('--key needs --client and its grant file');
  if (keyFile === undefined) return usage('--client needs --key <key file>');
  const since = args.values.since ?? null;
  const ackId = args.values.ack ?? null;
  for (const [name, value] of [['since', since], ['ack', ackId]] as const) {
    if (value !== null && !CLIENT_REPLY_ID_PATTERN.test(value)) {
      return usage(`"${value}" is not a reply id for --${name}`);
    }
  }
  // The pane guard, judged before the grant or the key is opened (see src/client/pane-guard.ts).
  const pane = clientPaneGuard(io, 'messages', sources.home);
  if (!pane.ok) {
    if (json) io.stdout(errorDoc('messages.client-pane', pane.why));
    else io.stderr(`team messages: refused: ${pane.why}\n`);
    return 1; // exit: messages.client-pane
  }
  if (pane.warning !== undefined) io.stderr(`${pane.warning}\n`);
  const limit = clientLimitOf(args.values.limit);
  if (limit === null) return usage(`--limit is a page bound between 1 and ${String(CLIENT_READ_MAX_LIMIT)}`);

  let outcome: ClientReadOutcome;
  try {
    outcome = withClientGrantLock(
      sources.home,
      () =>
        admitRead({
          home: sources.home,
          grantFile,
          keyFile,
          since,
          ack: ackId,
          limit,
          ...(args.values['request-id'] !== undefined ? { requestId: args.values['request-id'] } : {}),
          now: sources.now(),
        }),
    );
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'the client grant lock could not be taken');
  }
  if (!outcome.ok) return outcome.kind === 'key' ? keyRefusal(outcome.why) : refused(outcome.why);

  const ordered = orderClientReplies(outcome.scan.shown);
  let selected = ordered.filter(
    (reply) => clientInboxReceiptState(outcome.inboxDir, reply.id, { to: `client:${outcome.grant.clientId}`, root: outcome.coordinator.teamRoot, session: outcome.coordinator.session }, outcome.key) === 'missing',
  );
  if (since !== null) {
    const cursor = ordered.find((reply) => reply.id === since);
    if (cursor === undefined) {
      return refused(`--since names ${since}, and no verified reply in this inbox carries that id`);
    }
    selected = selected.filter((reply) => reply.at > cursor.at || (reply.at === cursor.at && reply.id > cursor.id));
  }
  selected = selected.slice(0, limit);

  // An explicit ack is validated on its own: it must be a verified reply in this inbox, whether or
  // not the selection above returned it. A body outside the selected page is never printed.
  let ack: AckOutcome | undefined;
  if (ackId !== null) {
    const named = ordered.find((reply) => reply.id === ackId);
    if (named === undefined) {
      const damaged = outcome.scan.refused.find((row) => row.id === ackId);
      return refused(
        damaged === undefined
          ? `--ack names ${ackId}, and no record in this inbox carries that id`
          : `--ack names ${ackId}, and that record does not verify: ${damaged.why}`,
      );
    }
  }

  const context = { to: `client:${outcome.grant.clientId}`, root: outcome.coordinator.teamRoot, session: outcome.coordinator.session };
  if (ackId !== null) {
    const state = clientInboxReceiptState(outcome.inboxDir, ackId, context, outcome.key);
    if (state === 'verified') {
      ack = { id: ackId, status: 'already-acked', written: false };
    } else if (state === 'invalid') {
      ack = {
        id: ackId,
        status: 'refused',
        written: false,
        message: `the read receipt beside ${ackId} does not verify for this client and reply; the owner checks ${clientInboxReceiptPath(outcome.inboxDir, ackId)} and removes it`,
      };
    } else {
      // The ack's own grant re-check and write run under the grant lock: a revocation or expiry
      // that wins the lock is seen before the receipt is published, never after the check.
      type AckLock = { kind: 'ack'; ack: AckOutcome } | { kind: 'key'; why: string };
      let locked: AckLock;
      try {
        locked = withClientGrantLock(sources.home, (): AckLock => {
          const still = activeClientGrant(sources.home, outcome.presented, sources.now());
          if (!still.ok) {
            return {
              kind: 'ack',
              ack: { id: ackId, status: 'refused', written: false, message: `the grant was revoked or expired before the ack: ${still.why}` },
            };
          }
          const receipt: ReceiptPayload = {
            kind: 'receipt',
            status: 'read',
            id: ackId,
            to: `client:${outcome.grant.clientId}`,
            root: outcome.coordinator.teamRoot,
            session: outcome.coordinator.session,
            at: sources.now().toISOString(),
          };
          let signed: SignedReceipt;
          try {
            signed = signReceiptPayload(receipt, sources.home);
          } catch {
            return { kind: 'key', why: 'the ack receipt could not be signed with the message key; nothing was written' };
          }
          const wrote = writeClientInboxFile(outcome.inboxDir, `${ackId}.read.json`, `${JSON.stringify(signed, null, 2)}\n`);
          if (wrote === 'written') {
            return { kind: 'ack', ack: { id: ackId, status: 'acknowledged', written: true } };
          }
          if (wrote === 'exists') {
            // A file appeared at the name while the receipt was being published. Trust it only when
            // it verifies; otherwise fail closed exactly as an existing invalid receipt does.
            const now = clientInboxReceiptState(outcome.inboxDir, ackId, context, outcome.key);
            return {
              kind: 'ack',
              ack: now === 'verified'
                ? { id: ackId, status: 'already-acked', written: false }
                : { id: ackId, status: 'refused', written: false, message: `the read receipt beside ${ackId} does not verify for this client and reply; the owner checks ${clientInboxReceiptPath(outcome.inboxDir, ackId)} and removes it` },
            };
          }
          return { kind: 'ack', ack: { id: ackId, status: 'refused', written: false, message: 'the read receipt could not be written' } };
        });
      } catch (error) {
        return refused(error instanceof Error ? error.message : 'the client grant lock could not be taken');
      }
      if (locked.kind === 'key') return keyRefusal(locked.why);
      ack = locked.ack;
    }
  }

  const differences: OutputDifference[] = outcome.scan.refused.map((row) => ({
    what: row.why,
    repair: `the owner checks the record in ${join('.agents', 'send-drops', outcome.coordinator.session, '.clients', outcome.grant.clientId, row.id)} and removes it, or has the sending seat re-send it`,
    who: 'the owner',
  }));
  const reading: ClientReading = {
    project: outcome.grant.entity,
    session: outcome.coordinator.session,
    clientId: outcome.grant.clientId,
    rows: selected.map((reply) => ({ reply, body: reply.body })),
    refused: outcome.scan.refused,
    notes: differences.length === 0 && selected.length === 0 && ack?.status !== 'refused' ? ['nothing is waiting'] : [],
    differences,
    ...(ack !== undefined ? { ack } : {}),
  };
  printReading(io, reading, json, sources.now());

  if (differences.length > 0 || ack?.status === 'refused') {
    return refused(
      ack?.status === 'refused' ? (ack.message ?? 'the ack was refused') : 'one or more records in the client inbox do not verify',
      true,
    );
  }
  if (reading.rows.length === 0 && reading.refused.length === 0) {
    return 0; // exit: messages.client-none
  }
  return 0; // exit: messages.client-shown
}

/** The reading in the two shapes: the `team.messages.client` document, or the table and bodies. */
function printReading(io: Io, reading: ClientReading, json: boolean, now: Date): void {
  const rows = [
    ...reading.rows.map((row) => ({
      id: row.reply.id,
      from: row.reply.from,
      to: row.reply.to,
      sent: row.reply.at,
      sent_display: formatRelativeTime(row.reply.at, now),
      status: 'shown' as const,
      ...(row.body !== undefined ? { body: row.body } : {}),
    })),
    ...reading.refused.map((row) => ({
      id: row.id,
      from: row.from,
      to: row.to,
      sent: row.at,
      sent_display: formatRelativeTime(row.at, now),
      status: 'refused' as const,
    })),
  ];
  if (json) {
    io.stdout(
      `${JSON.stringify(
        {
          schema: { name: 'team.messages.client', version: 1 },
          format: 1,
          project: reading.project,
          session: reading.session,
          client: reading.clientId,
          rows,
          notes: reading.notes,
          differences: reading.differences.map(toJsonDifference),
          summary: summaryCounts(reading.differences),
          counts: {
            messages: rows.length,
            shown: reading.rows.length,
            refused: reading.refused.length,
          },
          ...(reading.ack !== undefined ? { ack: reading.ack } : {}),
          key_isolation: KEY_ISOLATION_LINE,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const style = ttyStyle(io);
  const lines = [contextLine(reading.project, reading.session)];
  lines.push(
    ...renderTable({
      headers: ['ID', 'FROM', 'TO', 'SENT', 'STATUS'],
      rows: rows.map((row) => [row.id, row.from, row.to, row.sent_display, row.status]),
      indent: '  ',
      style,
    }),
  );
  for (const row of reading.rows) {
    lines.push('', `${row.reply.id}:`, ...bodyLines(row.body ?? ''));
  }
  if (reading.notes.length > 0) lines.push('', ...renderNotes(reading.notes));
  if (reading.differences.length > 0) lines.push('', ...renderDifferences(reading.differences, style));
  if (reading.ack !== undefined) {
    lines.push('', ackLine(reading.ack));
  }
  lines.push('', pluralCount(rows.length, 'message'));
  io.stdout(`${lines.join('\n')}\n`);
}

function ackLine(ack: AckOutcome): string {
  if (ack.status === 'acknowledged') return `ack: ${ack.id} acknowledged`;
  if (ack.status === 'already-acked') return `ack: ${ack.id} already acknowledged`;
  return `ack: ${ack.id} refused: ${ack.message ?? 'the receipt does not verify'}`;
}

function bodyLines(body: string): string[] {
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  return trimmed.split('\n');
}
