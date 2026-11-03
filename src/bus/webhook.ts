// The seat's webhook delivery adapter: every accepted signed message for a seat that configures
// one is POSTed to its routine. The drop folder record is the backup, never a fallback that gets
// consumed — this module never consumes or changes it: the inbox body shape reads the record the
// arrival names for the message it carries, and writes nothing, so a 2xx that arrives after the
// seat's pull simply delivers twice, and a refusal leaves the message where it was.
//
// The hand-off is `fanOut` in `src/bus/server.ts` (builder-4's file): the returned function is
// synchronous and schedules its work, so it never blocks a reconcile pass or a publish, and it
// never throws into the caller — every refusal and every failure is a line on `stderr` instead.
// The bus rebuilds the rows when the root's registry record changes (`reload`); a delivery
// already scheduled keeps the row it started with, so a reload never drops one in flight.
// The record is already durable and identical to the one live subscribers receive; nothing here
// assumes it was written this tick, and a duplicate never reaches `fanOut` at all.
//
// The request shape and the way the secret authenticates live in `webhookRequest`, one function,
// until the routine's own contract is forwarded. Everything else here reads files and counts
// answers.
//
// The send that writes an arrival posts it too: `postArrivalWebhook` builds the same request,
// one attempt, and leaves a `<id>.posted` mark beside the record on a 2xx. `deliverWebhook`
// skips a marked record before it reads the route, so one arrival is posted once — by the send
// when it gets there first, by the bus when it does not.
//
// Both posters hold a claim beside the record while their request is in flight: `<id>.posting`,
// created exclusively, so of a send and any number of bus passes exactly one can post. The claim
// names its state — `claimed` until the bytes are handed to the transport, `sent` from then on.
// A `claimed` claim left behind by a poster that died before sending is taken over, exactly once,
// after `claimStaleMs`; a `sent` claim is never posted again, because the request may have
// reached the routine and the owner's rule is that a routine never gets the same message twice.
// A poster that knows the request never left (a refused connection, a non-2xx) removes the claim,
// so the bus and the seat's pull keep the fallback they always had.
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SeatWebhook, TeamFile } from '../file/types.ts';
import type { SignedRecord } from '../send/record.ts';
import { webhookRouteOf, type WebhookRoute } from '../send/webhook.ts';
import type { SignedEventRecord } from './log.ts';

/** How hard one record is tried when the request could not be sent at all: three attempts in
 *  total, five seconds each, then one and four seconds between them — about twenty seconds. A
 *  routine that answered, or one whose answer was not seen before the bound, is never asked
 *  again: the POST may already have started a run, and a second one is worse than a report. The
 *  claim's stale age is the second bound: a `claimed` claim older than it proves its poster died
 *  before the request was sent, and the fallback may take it over once. At least twice the
 *  timeout, so a live attempt is never mistaken for a dead one. */
export type WebhookPolicy = {
  timeoutMs: number;
  attempts: number;
  backoffMs: readonly number[];
  claimStaleMs: number;
};

export const WEBHOOK_POLICY: WebhookPolicy = {
  timeoutMs: 5000,
  attempts: 3,
  backoffMs: [1000, 4000],
  claimStaleMs: 30_000,
};

/** The longest a send's own arrival post waits on the routine. The bus delivery has the adapter's
 *  budget (three attempts, five seconds each); a person's `team send` never sits on a webhook for
 *  it: the post is a wake beside the record, and the record is already staged for the bus and the
 *  seat's pull. A row's own shorter bound still applies; this one only caps a longer one. A post
 *  that times out leaves its claim in `sent`, the state that forbids a second post, and the bus
 *  reports the record instead. */
export const SENDER_POST_DEADLINE_MS = 1000;

/** What one delivery ended as: the routine took it (`delivered`, only after a 2xx), the request
 *  could not be sent and its attempts ran out (`failed`), the body may have reached the routine
 *  and no answer was read (`sent-unknown`), the seat's files could not be read so nothing was
 *  posted (`refused`), or the record was skipped because it carries the send's `posted` mark or a
 *  claim another poster holds — one still in flight, or one in `sent` whose fate is unknown and
 *  which is therefore never posted again (`skipped`). */
export type WebhookOutcome = 'delivered' | 'failed' | 'refused' | 'sent-unknown' | 'skipped';

/** What one delivery did, beyond its outcome: the attempts it made and the fixed-words reason
 *  the last one ended on. The bus records this beside the seat so a failure is read there. */
export type WebhookFacts = {
  outcome: WebhookOutcome;
  attempts: number;
  reason: string;
};

/** What one routine is sent: the body shape, and how the secret travels. A row that names
 *  neither header nor body posts the form every earlier row had. */
export type WebhookShape =
  | { header?: string; body: 'event' }
  | { header?: string; body: 'inbox'; message: SignedRecord };

/**
 * The one place the routine's contract lives: the body it is sent and the way the secret
 * authenticates it. Two bodies: the bus envelope, every row's default, and the seat-inbox record
 * shape the front's own webhook pushed. The secret is `Authorization: Bearer <secret>` unless the
 * row names a header, which then carries the secret file's line verbatim. No caller reads the
 * secret otherwise. A row that names neither new field builds the request object every earlier
 * row built, byte for byte; the delivery applies its own redirect policy, so a 3xx is never
 * followed — a redirect would carry the secret to a destination the routine's own address never
 * named, and it fails the attempt like any other refusal to answer.
 */
export function webhookRequest(
  record: SignedEventRecord,
  url: string,
  secret: string,
  shape: WebhookShape = { body: 'event' },
): { url: string; init: RequestInit } {
  // The map has no prototype: a header name is the row's to pick, and `__proto__` on a plain
  // object would run the inherited setter instead of adding a field, so the routine would answer
  // 2xx without ever receiving its authentication header. A prototype-free map takes every valid
  // name as a field of its own.
  const headers = Object.create(null) as Record<string, string>;
  headers['content-type'] = 'application/json';
  if (shape.header === undefined) headers.authorization = `Bearer ${secret}`;
  else headers[shape.header] = secret;
  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: shape.body === 'inbox' ? JSON.stringify(inboxBody(shape.message)) : JSON.stringify({ v: 1, event: record }),
    },
  };
}

/**
 * The seat-inbox record shape the front's webhook pushed, flattened from the signed message the
 * arrival names. The bridge's signed-inbox identity fields — a key id, a wire version, a
 * per-record nonce — have no TeamCLI counterpart and are absent rather than invented; `signature`
 * is the record's own hex message signature, not a bridge signature.
 */
function inboxBody(message: SignedRecord): Record<string, unknown> {
  const payload = message.payload;
  return {
    id: payload.id,
    from: payload.from,
    kind: payload.kind,
    created_at: payload.at,
    body: payload.body,
    signature: message.signature,
  };
}

/** The name a record id may be as a drop file: the alphabet the drop folder itself uses. */
const DROP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** One path segment of a drop folder: a name that cannot leave the folder it is joined to. */
function segmentOk(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** The seat's own drop folder, resolved, with every link along the way refused: a linked
 *  ancestor — the project's, the session's, the seat's — could lead into another project, and
 *  the record it holds there is not this project's to post. The file's own real path must sit
 *  directly in that folder, so a linked drop file is refused too. */
function ownDropPath(
  root: string,
  session: string,
  to: string,
  id: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!segmentOk(session) || !segmentOk(to)) {
    return { ok: false, reason: 'the arrival cannot name a drop folder' };
  }
  const dir = join(root, '.agents', 'send-drops', session, to);
  let expected: string;
  let realDir: string;
  try {
    expected = join(realpathSync(root), '.agents', 'send-drops', session, to);
    realDir = realpathSync(dir);
  } catch {
    return { ok: false, reason: `the message record ${id} is not in the seat's drop folder` };
  }
  if (realDir !== expected) {
    return { ok: false, reason: 'the seat\'s drop folder is a link that leads outside the project' };
  }
  let realFile: string;
  try {
    realFile = realpathSync(join(dir, id));
  } catch {
    return { ok: false, reason: `the message record ${id} is not in the seat's drop folder` };
  }
  if (dirname(realFile) !== realDir) {
    return { ok: false, reason: `the message record ${id} is a link that leads outside the seat's drop folder` };
  }
  return { ok: true, path: join(dir, id) };
}

/** The mark a send leaves beside a record it posted itself: `<id>.posted`, written only after the
 *  routine answered 2xx. The adapter skips a record that carries it, so one arrival is posted
 *  once whether the send or the bus is first. */
const POSTED_SUFFIX = '.posted';

/** The claim both posters hold while their request is in flight, and the marks it ends as. */
const CLAIM_SUFFIX = '.posting';

/** The seat's own drop folder for this record, resolved through real paths: a linked folder that
 *  leads outside the project proves nothing and is never posted into or marked. Null when the
 *  folder cannot be proven — no root, an unsafe segment, a missing or linked folder. */
function dropDirAt(root: string | undefined, session: string, to: string): string | null {
  if (root === undefined) return null;
  if (!segmentOk(session) || !segmentOk(to)) return null;
  try {
    const realRoot = realpathSync(root);
    const expected = join(realRoot, '.agents', 'send-drops', session, to);
    const realDir = realpathSync(expected);
    return realDir === expected ? realDir : null;
  } catch {
    return null;
  }
}

/** Whether the send that wrote this record posted it itself, resolved through the seat's own drop
 *  folder: a linked folder, another user's mark or anything that is not a regular file proves
 *  nothing, and an unproved mark is never an excuse to skip the delivery. */
function postedMarkAt(root: string | undefined, session: string, to: string, id: string): boolean {
  if (!DROP_NAME.test(id)) return false;
  const dir = dropDirAt(root, session, to);
  if (dir === null) return false;
  let held;
  try {
    held = lstatSync(join(dir, `${id}${POSTED_SUFFIX}`));
  } catch {
    return false;
  }
  if (!held.isFile()) return false;
  if (process.getuid !== undefined && held.uid !== process.getuid()) return false;
  return true;
}

/** Writes the mark beside the record, atomically: the bytes go to a dot-name the folder's readers
 *  already ignore, and the rename makes the mark either wholly there or not there. Best effort —
 *  the routine has already answered 2xx, and a mark that cannot be written only means the bus may
 *  post the same record once more. */
function writePostedMark(dropDir: string, id: string, now: () => Date): void {
  try {
    const temp = join(dropDir, `.${id}${POSTED_SUFFIX}.tmp`);
    writeFileSync(temp, `${now().toISOString()}\n`, { mode: 0o600 });
    renameSync(temp, join(dropDir, `${id}${POSTED_SUFFIX}`));
  } catch {
    // The delivery itself is unaffected.
  }
}

/** The two states a claim names: `claimed` proves the request was never handed to the transport,
 *  so a stale one may be taken over; `sent` says the bytes may have reached the routine, so it is
 *  never posted again. */
type ClaimState = 'claimed' | 'sent';

function claimPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}${CLAIM_SUFFIX}`);
}

function claimText(state: ClaimState): string {
  return `${JSON.stringify({ state, at: new Date().toISOString() })}\n`;
}

/** Creates the claim, exclusively: `wx` fails on an occupied name, so of a send and any number of
 *  bus passes exactly one holds it and may post. */
function takeClaim(dropDir: string, id: string): boolean {
  try {
    writeFileSync(claimPath(dropDir, id), claimText('claimed'), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Rewrites the claim to `sent`, atomically, at the last moment before the request is handed to
 *  the transport. Failure is reported to the caller, which then posts nothing: a claim left in
 *  `claimed` would let the fallback post a request that may have left. */
function markClaimSent(dropDir: string, id: string): boolean {
  try {
    const temp = join(dropDir, `.${id}${CLAIM_SUFFIX}.tmp`);
    writeFileSync(temp, claimText('sent'), { mode: 0o600 });
    renameSync(temp, claimPath(dropDir, id));
    return true;
  } catch {
    return false;
  }
}

/** Ends a delivered claim: the `posted` mark is the same file renamed, so no reader ever sees
 *  both or neither — and if the rename fails, the mark is written on its own. */
function finishClaim(dropDir: string, id: string, now: () => Date): void {
  try {
    renameSync(claimPath(dropDir, id), join(dropDir, `${id}${POSTED_SUFFIX}`));
  } catch {
    writePostedMark(dropDir, id, now);
  }
}

/** Gives the claim up: the request provably never left, so the bus and the seat's pull keep the
 *  fallback they always had. */
function releaseClaim(dropDir: string, id: string): void {
  try {
    unlinkSync(claimPath(dropDir, id));
  } catch {
    // Already gone, or a folder that cannot be written: nothing to release.
  }
}

/** What a claim read found: no claim at all, a readable claim with its state and age (the time
 *  since it was last written — the `sent` rewrite resets it), or something at the claim's name
 *  that is not a claim this process can trust. */
type HeldClaim =
  | { kind: 'none' }
  | { kind: 'held'; state: ClaimState; ageMs: number }
  | { kind: 'unreadable'; ageMs: number };

function readHeldClaim(dropDir: string, id: string): HeldClaim {
  let held;
  try {
    held = lstatSync(claimPath(dropDir, id));
  } catch {
    return { kind: 'none' };
  }
  const ageMs = Math.max(0, Date.now() - held.mtimeMs);
  if (!held.isFile()) return { kind: 'unreadable', ageMs };
  if (process.getuid !== undefined && held.uid !== process.getuid()) return { kind: 'unreadable', ageMs };
  let state: ClaimState | null = null;
  try {
    const parsed = JSON.parse(readFileSync(claimPath(dropDir, id), 'utf8')) as { state?: unknown };
    if (parsed !== null && (parsed.state === 'claimed' || parsed.state === 'sent')) state = parsed.state;
  } catch {
    // Unreadable is handled below, the same as any other claim that cannot be trusted.
  }
  return state === null ? { kind: 'unreadable', ageMs } : { kind: 'held', state, ageMs };
}

/** Reads a claim file this process has just taken over, after the rename: what was stale a moment
 *  ago may have been rewritten `sent` by a poster that was alive after all. */
function readTakenClaim(path: string): { state: ClaimState | null; ageMs: number } {
  try {
    const held = lstatSync(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { state?: unknown };
    const state = parsed !== null && (parsed.state === 'claimed' || parsed.state === 'sent') ? parsed.state : null;
    return { state, ageMs: Math.max(0, Date.now() - held.mtimeMs) };
  } catch {
    return { state: null, ageMs: Number.POSITIVE_INFINITY };
  }
}

/** Takes the claim for one record before posting it, or says the delivery must not post: another
 *  poster holds a fresh claim, a stale claim says the request may already have been sent, or the
 *  name holds something this process cannot trust. A stale `claimed` claim is taken over exactly
 *  once — the rename is the election, and of two passes only one can win it — and the winner
 *  leaves its own exclusive claim where the dead poster's was. */
function holdClaim(dropDir: string, id: string, staleMs: number, report: ((text: string) => void) | undefined, seat: string): 'held' | 'busy' {
  const claim = readHeldClaim(dropDir, id);
  if (claim.kind === 'none') return takeClaim(dropDir, id) ? 'held' : 'busy';
  if (claim.kind === 'unreadable') {
    say(report, `webhook: ${seat}: not posted: a claim beside the record cannot be read; it is not posted again`);
    return 'busy';
  }
  if (claim.state === 'sent') {
    if (claim.ageMs >= staleMs) {
      say(report, `webhook: ${seat}: not posted: an earlier post was sent and its answer was never read; it is not posted again`);
    }
    return 'busy';
  }
  if (claim.ageMs < staleMs) return 'busy';
  const taken = join(dropDir, `.${id}${CLAIM_SUFFIX}.take-${String(process.pid)}-${String(Math.random()).slice(2)}`);
  try {
    renameSync(claimPath(dropDir, id), taken);
  } catch {
    // Another pass won the election, or the poster released its claim a moment ago.
    return 'busy';
  }
  const held = readTakenClaim(taken);
  if (held.state !== 'claimed' || held.ageMs < staleMs) {
    // A live poster rewrote the claim after the read that called it stale: put it back, unless
    // one of its own newer claims already stands at the name. A `sent` claim that is stale now
    // is reported exactly as the plain read above reports one.
    try {
      if (existsSync(claimPath(dropDir, id))) unlinkSync(taken);
      else renameSync(taken, claimPath(dropDir, id));
    } catch {
      try {
        unlinkSync(taken);
      } catch {
        // Nothing more can be done with this name.
      }
    }
    if (held.state === 'sent' && held.ageMs >= staleMs) {
      say(report, `webhook: ${seat}: not posted: an earlier post was sent and its answer was never read; it is not posted again`);
    }
    return 'busy';
  }
  const made = takeClaim(dropDir, id);
  try {
    unlinkSync(taken);
  } catch {
    // The dead claim is released piecemeal; the new claim is what counts.
  }
  return made ? 'held' : 'busy';
}

/** The message record's reader, loaded the first time a row asks for the record shape. The
 *  default body never loads it: the record module's import graph reaches the launch profiles,
 *  which read data files from beside the module, and the adapter is also run on its own where a
 *  data file does not follow — a plain-runtime bundle, a test's scratch build. The runtime caches
 *  the module, so only the first record-shaped delivery pays for it. */
async function messageReader(): Promise<typeof import('../send/record.ts') | null> {
  try {
    return await import('../send/record.ts');
  } catch {
    return null;
  }
}

/** The event log's signer, loaded only when a send posts the bus-envelope shape: the same lazy
 *  load as the record reader, for the same reason. */
async function logSigner(): Promise<typeof import('./log.ts') | null> {
  try {
    return await import('./log.ts');
  } catch {
    return null;
  }
}

/** The shape one delivery posts, or why the inbox shape cannot be built right now: its body is
 *  the signed record the arrival names, read from the seat's drop folder. The read consumes and
 *  changes nothing, so the backup the seat's own pull reads stays exactly where it was. */
async function shapeOf(
  route: Extract<WebhookRoute, { ok: true }>,
  record: SignedEventRecord,
  root: string | undefined,
): Promise<{ ok: true; value: WebhookShape } | { ok: false; reason: string }> {
  const header = route.header === undefined ? {} : { header: route.header };
  if (route.body !== 'inbox') return { ok: true, value: { body: 'event', ...header } };
  const payload = record.payload;
  if (root === undefined) {
    return { ok: false, reason: 'the inbox body shape reads the message record, and this adapter was built without the project root' };
  }
  const to = payload.to;
  if (to === undefined || to === '') return { ok: false, reason: 'the arrival names no seat' };
  const id = payload.record_id;
  if (!DROP_NAME.test(id)) return { ok: false, reason: "the arrival's record id cannot name a drop file" };
  const own = ownDropPath(root, payload.session, to, id);
  if (!own.ok) return { ok: false, reason: own.reason };
  const reader = await messageReader();
  if (reader === null) {
    return { ok: false, reason: 'the inbox body shape could not load the message record reader' };
  }
  const read = reader.readRecord(own.path, id);
  if (!read.ok) return { ok: false, reason: `the message record ${id} could not be read: ${read.reason}` };
  if (read.record === null) return { ok: false, reason: `the message record ${id} is not in the seat's drop folder` };
  // The record must be this arrival's own: the seat it was sent to, the session, and the project
  // folder it was written for. A record that is not is never posted, whatever folder it sits in.
  const written = read.record.payload;
  if (written.to !== to || written.session !== payload.session || !reader.sameFolder(written.root, root)) {
    return { ok: false, reason: `the message record ${id} is not addressed to this seat in this project` };
  }
  return { ok: true, value: { body: 'inbox', ...header, message: read.record } };
}

/** The seats that configure an adapter, by seat name, as the bus's team file names them. The bus
 *  reads this at start and rebuilds it when the root's registry record changes (`src/bus/server.ts`);
 *  a delivery already scheduled keeps the row it started with. */
export function webhookRoutesOf(team: TeamFile): Map<string, SeatWebhook> {
  const routes = new Map<string, SeatWebhook>();
  for (const seat of team.seats) {
    if (seat.webhook !== undefined) routes.set(seat.name, seat.webhook);
  }
  return routes;
}

export type WebhookDeliveryInput = {
  /** The seat the arrival is for, as the record names it. */
  seat: string;
  webhook: SeatWebhook;
  record: SignedEventRecord;
  /** The project root: the inbox body shape reads the record the arrival names beneath it. */
  root?: string;
  policy?: Partial<WebhookPolicy>;
  /** Where refusals and final failures are said; absent, they are contained and dropped. */
  report?: (text: string) => void;
  /** What the delivery did, in facts: the bus records them beside the seat. Absent, nobody
   *  asks — a scene that only reads the outcome passes none. */
  onResult?: (facts: WebhookFacts) => void;
  /** The POST itself, injectable so a test can watch it without a socket. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** The error's class name, the one detail a fixed-words report may carry. An error's own
 *  message is never printed: a credentials URL or an invalid header value repeats the URL or
 *  the secret in it. */
function errorClass(error: unknown): string | null {
  return error instanceof Error && error.name !== '' ? error.name : null;
}

/** The reason the request may have reached the routine and no answer was read, in fixed words:
 *  a timeout says so, and anything else is said as a request whose fate is unknown, with the
 *  error's class name as the only detail. */
function unknownReason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no answer within ${timeoutMs} ms`;
  }
  const cls = errorClass(error);
  return cls === null ? 'the request may have been sent' : `the request may have been sent (${cls})`;
}

/** The connection-stage codes that prove the request never left this machine. Measured here:
 *  Bun (v26.3.0) raises a TypeError whose `code` is 'ConnectionRefused' for a closed loopback
 *  port and 'ENOTFOUND' for a name that does not resolve; the plain runtime (node v26.8.1)
 *  wraps both in TypeError('fetch failed') with `cause.code` 'ECONNREFUSED' / 'ENOTFOUND'. The
 *  other three are the same stage's address and route failures. A code outside this list proves
 *  nothing about whether the body left, so the delivery is not retried on it. */
const UNSENT_CODES = new Set(['ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/** The error's code, from the error or the cause the plain runtime wraps it in. */
function codeOf(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null;
  const one = error as { code?: unknown; cause?: unknown };
  if (typeof one.code === 'string') return one.code;
  const cause = one.cause;
  if (cause !== null && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'string') {
    return (cause as { code: string }).code;
  }
  return null;
}

/** The reason a failure proves the request was never sent, or null when it proves nothing. Only
 *  a proven-unsent failure is retried: a timeout after the body may already have reached the
 *  routine, and asking again could start a second run. */
function unsentReason(error: unknown): string | null {
  const code = codeOf(error);
  return code !== null && UNSENT_CODES.has(code) ? `could not connect (${code})` : null;
}

/** Whether the failure is the adapter's own refusal to follow a redirect. The answer was read
 *  (a 3xx), so the request was sent: it is a failure, never a retry. Measured here: Bun
 *  (v26.3.0) raises code 'UnexpectedRedirect'; node (v26.8.1) wraps a cause whose message is
 *  'unexpected redirect' in TypeError('fetch failed'). */
function redirected(error: unknown): boolean {
  if (codeOf(error) === 'UnexpectedRedirect') return true;
  if (error === null || typeof error !== 'object') return false;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message === 'unexpected redirect';
}

/** `1 attempt`, `2 attempts`. */
function attemptsWord(count: number): string {
  return `${String(count)} attempt${count === 1 ? '' : 's'}`;
}

function say(report: ((text: string) => void) | undefined, text: string): void {
  try {
    report?.(text);
  } catch {
    // A reporter that throws is still not the delivery's failure to propagate.
  }
}

/** The wait between attempts when the caller injects none: a plain timer from the language, not
 *  a runtime's own sleep. The production build type-checks against the standard library alone and
 *  the installed CLI runs where a bundler-specific global does not exist, so the default path has
 *  to work on the plain runtime; a test runs it there. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Posts one accepted record, within the policy's bound. A 2xx answer is delivered; a request
 * proven never sent (a refused connection, a name that does not resolve) is retried; an answer
 * that is not 2xx, or one not read before the bound, is reported and never asked for twice,
 * because the body may already have reached the routine. The drop file is left exactly where it
 * was for the seat's own pull. A route that cannot be read is refused before any POST. A record
 * whose send already posted it — the `posted` mark beside it — is skipped before the route is
 * even read, so the send and the bus never post the same arrival twice. An arrival is posted
 * only while holding the record's claim, so a reconcile pass that runs inside the send's own post
 * cannot post it a second time; a stale claim left by a poster that died before sending is taken
 * over once, and one in `sent` is never posted again.
 */
export async function deliverWebhook(input: WebhookDeliveryInput): Promise<WebhookOutcome> {
  const done = (facts: WebhookFacts): WebhookOutcome => {
    try {
      input.onResult?.(facts);
    } catch {
      // A recorder that throws is still not the delivery's failure to propagate.
    }
    return facts.outcome;
  };
  const payload = input.record.payload;
  const to = payload.kind === 'message.arrived' ? payload.to : undefined;
  if (payload.kind === 'message.arrived' && to !== undefined && postedMarkAt(input.root, payload.session, to, payload.record_id)) {
    return done({ outcome: 'skipped', attempts: 0, reason: 'the send already posted this arrival' });
  }
  const route = webhookRouteOf(input.webhook);
  if (route === null || !route.ok) {
    const reason = route === null ? 'no webhook adapter is configured' : route.reason;
    say(input.report, `webhook: ${input.seat}: not posted: ${reason}; the drop file stays in place`);
    return done({ outcome: 'refused', attempts: 0, reason });
  }
  const shape = await shapeOf(route, input.record, input.root);
  if (!shape.ok) {
    say(input.report, `webhook: ${input.seat}: not posted: ${shape.reason}; the drop file stays in place`);
    return done({ outcome: 'refused', attempts: 0, reason: shape.reason });
  }
  // The row's own answer bound, when it names one, stands between the build's default and a
  // caller's injected policy: the routine's contract is the row's, and only a scene overrides it.
  const policy: WebhookPolicy = {
    ...WEBHOOK_POLICY,
    ...(input.webhook.timeoutMs === undefined ? {} : { timeoutMs: input.webhook.timeoutMs }),
    ...input.policy,
  };
  const attempts = Math.max(1, policy.attempts);
  const fetchFn = input.fetch ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const request = webhookRequest(input.record, route.url, route.secret, shape.value);
  // The request is built before the first attempt, so a value the platform refuses (an invalid
  // header, say) fails once in fixed words; its own error, which repeats the value, is never
  // printed.
  let prepared: RequestInit;
  try {
    prepared = { ...request.init, headers: new Headers(request.init.headers) };
  } catch (error) {
    const cls = errorClass(error);
    const why = cls === null ? 'request refused before sending' : `request refused before sending (${cls})`;
    say(input.report, `webhook: ${input.seat}: not delivered (${why}); the drop file stays in place`);
    return done({ outcome: 'failed', attempts: 0, reason: why });
  }
  // Who posts is decided by the claim, taken exclusively, never by arrival order: the send and
  // every bus pass race for it, and exactly one wins. The send may have finished between the
  // posted-mark read above and this claim — its mark is then checked again, because the rename
  // that left it also freed the claim's name.
  const claimId = payload.record_id;
  const claimDir = to !== undefined && payload.kind === 'message.arrived' && DROP_NAME.test(claimId)
    ? dropDirAt(input.root, payload.session, to)
    : null;
  if (claimDir !== null && to !== undefined) {
    if (holdClaim(claimDir, claimId, policy.claimStaleMs, input.report, input.seat) !== 'held') {
      return done({ outcome: 'skipped', attempts: 0, reason: 'another poster holds the arrival, or it was already sent' });
    }
    if (postedMarkAt(input.root, payload.session, to, claimId)) {
      releaseClaim(claimDir, claimId);
      return done({ outcome: 'skipped', attempts: 0, reason: 'the send already posted this arrival' });
    }
    if (!markClaimSent(claimDir, claimId)) {
      releaseClaim(claimDir, claimId);
      say(input.report, `webhook: ${input.seat}: not posted: the claim beside the record could not be marked sent; the drop file stays in place`);
      return done({ outcome: 'failed', attempts: 0, reason: 'the claim beside the record could not be marked sent' });
    }
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // A redirect is never followed: it would carry the secret to a destination the routine's
      // own address never named. The policy rides on the attempt, not on the request object, so a
      // row that names neither new field builds exactly the request object it always did.
      const response = await fetchFn(request.url, { ...prepared, redirect: 'error', signal: AbortSignal.timeout(policy.timeoutMs) });
      if (response.status >= 200 && response.status < 300) {
        if (claimDir !== null) finishClaim(claimDir, claimId, () => new Date());
        return done({ outcome: 'delivered', attempts: attempt, reason: `HTTP ${response.status}` });
      }
      // The routine answered and refused: it was reached, so it is not asked a second time. The
      // claim goes, as it always did for an answered failure, so the drop stays the fallback.
      const reason = `HTTP ${response.status}`;
      if (claimDir !== null) releaseClaim(claimDir, claimId);
      say(input.report, `webhook: ${input.seat}: not delivered after ${attemptsWord(attempt)} (${reason}); the drop file stays in place`);
      return done({ outcome: 'failed', attempts: attempt, reason });
    } catch (error) {
      if (redirected(error)) {
        const reason = 'a redirect the adapter does not follow';
        if (claimDir !== null) releaseClaim(claimDir, claimId);
        say(input.report, `webhook: ${input.seat}: not delivered after ${attemptsWord(attempt)} (${reason}); the drop file stays in place`);
        return done({ outcome: 'failed', attempts: attempt, reason });
      }
      const unsent = unsentReason(error);
      if (unsent === null) {
        // The body may have reached the routine. An answer we did not read is reported, never
        // retried: a second POST could start a second run far side. The claim stays in `sent`,
        // so no later pass posts the record either.
        const reason = unknownReason(error, policy.timeoutMs);
        say(input.report, `webhook: ${input.seat}: sent, response unknown: ${reason}; not retried, so the routine is not asked twice; the drop file stays in place`);
        return done({ outcome: 'sent-unknown', attempts: attempt, reason });
      }
      if (attempt < attempts) {
        const wait = policy.backoffMs[attempt - 1] ?? policy.backoffMs[policy.backoffMs.length - 1] ?? 0;
        await sleep(wait);
        continue;
      }
      say(input.report, `webhook: ${input.seat}: not delivered after ${attemptsWord(attempt)} (${unsent}); the drop file stays in place`);
      return done({ outcome: 'failed', attempts: attempt, reason: unsent });
    }
  }
  // Every attempt proved the request never left, so the fallback the drop always had is still
  // the seat's: the claim goes, and the bus or the seat's pull may try again.
  if (claimDir !== null) releaseClaim(claimDir, claimId);
  // The loop returns on every path; this is the type's floor, not a reachable ending.
  return done({ outcome: 'failed', attempts, reason: 'could not connect' });
}

/** Why the send's own post did nothing: the row names no usable route (`no-route`); another
 *  poster holds the record's claim, so this process may not post (`claim-held`); the route's
 *  `posted` mark appeared while the claim was being taken, so the arrival was already posted
 *  (`already-posted`); or an unexpected failure left the claim as it was (`unexpected`). */
export type SenderPostNone = 'no-route' | 'claim-held' | 'already-posted' | 'unexpected';

/** What the send's own post ended as: the routine answered 2xx within the adapter's timeout; the
 *  one attempt provably did not reach it (a non-2xx, a refused connection); the request may have
 *  been sent and no answer was read, so it is reported and never posted again; or nothing was
 *  tried here, with the reason the walk needs to decide whether its leg was taken. */
export type SenderPostOutcome =
  | { kind: 'posted'; ms: number }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'none'; why: SenderPostNone };

export type SenderPostInput = {
  /** The seat the record was written for, as the receiving team names it. */
  seat: string;
  /** The seat's adapter row, as the receiving team file declares it. */
  webhook: SeatWebhook;
  root: string;
  session: string;
  id: string;
  from: string;
  thread?: string;
  /** The signed message record the send just wrote: the body an inbox-shaped row reads. */
  message: SignedRecord;
  /** The folder the record was staged into: the claim and the marks are written beside it. */
  dropDir: string;
  home: string;
  now: () => Date;
  /** The POST itself, injectable so a test can watch it without a socket. */
  fetch?: typeof fetch;
};

/**
 * The send's own post of the arrival, right after the record is written and signed. It is the
 * adapter's request: the row's URL and secret files read by path, the row's header and body
 * shape, and the adapter's own timeout — but exactly one attempt, because a request that was
 * fully sent is not retried here; the unchanged record stays for the bus and the seat's pull.
 *
 * The post holds the record's claim, taken exclusively, so a bus pass that reaches the same
 * record first makes this send post nothing. A 2xx ends the claim as the `posted` mark the
 * adapter skips; a non-2xx or a connection that was refused releases it, and the bus and the
 * seat's pull keep the fallback; a failure that does not prove the request never left keeps the
 * claim in `sent` and reports the outcome as unknown, so no one posts it a second time. Never
 * throws and never fails the send.
 */
export async function postArrivalWebhook(input: SenderPostInput): Promise<SenderPostOutcome> {
  // What the claim currently says this process may do: nothing, still provably unsent, or sent.
  let held: 'none' | 'claimed' | 'sent' = 'none';
  const giveUp = (): void => {
    if (held !== 'none') releaseClaim(input.dropDir, input.id);
    held = 'none';
  };
  try {
    const route = webhookRouteOf(input.webhook);
    if (route === null || !route.ok) return { kind: 'none', why: 'no-route' };
    const header = route.header === undefined ? {} : { header: route.header };
    let shape: WebhookShape;
    let event: SignedEventRecord;
    if (route.body === 'inbox') {
      shape = { body: 'inbox', ...header, message: input.message };
      event = {
        payload: {
          v: 1,
          seq: 1,
          ts: input.now().toISOString(),
          kind: 'message.arrived',
          session: input.session,
          record_id: input.id,
          from: input.from,
          to: input.seat,
        },
        signature: '',
      };
    } else {
      // The body is the bus's envelope, and the bus is not there to append the arrival: the
      // envelope is signed here and posted, never appended, so the bus stays the only appender.
      // Its sequence is the send's own clock in milliseconds — a positive integer unique to this
      // post, so a routine that remembers sequences never mistakes one arrival for another.
      const log = await logSigner();
      const signed = log === null
        ? null
        : log.signEventRecord(
            {
              ts: input.now().toISOString(),
              kind: 'message.arrived',
              session: input.session,
              record_id: input.id,
              from: input.from,
              to: input.seat,
              ...(input.thread === undefined ? {} : { thread: input.thread }),
            },
            Math.max(1, input.now().getTime()),
            input.home,
          );
      if (signed === null) return { kind: 'failed', reason: 'the arrival envelope could not be signed' };
      event = signed;
      shape = { body: 'event', ...header };
    }
    const request = webhookRequest(event, route.url, route.secret, shape);
    // Built before the attempt, so a value the platform refuses fails once in fixed words; its
    // own error, which repeats the value, is never printed.
    let prepared: RequestInit;
    try {
      prepared = { ...request.init, headers: new Headers(request.init.headers) };
    } catch (error) {
      const cls = errorClass(error);
      return {
        kind: 'failed',
        reason: cls === null ? 'request refused before sending' : `request refused before sending (${cls})`,
      };
    }
    // Claim before posting, exclusively: of this send and every bus pass, exactly one posts.
    if (!takeClaim(input.dropDir, input.id)) return { kind: 'none', why: 'claim-held' };
    held = 'claimed';
    // The bus may have posted and marked the record while this send was building its request:
    // that mark is the newer word, and the claim this send just took is redundant.
    if (existsSync(join(input.dropDir, `${input.id}${POSTED_SUFFIX}`))) {
      giveUp();
      return { kind: 'none', why: 'already-posted' };
    }
    // From here on the claim says `sent`, whether or not the transport has taken the bytes: a
    // poster that dies after this rewrite is reported, never asked twice.
    if (!markClaimSent(input.dropDir, input.id)) {
      giveUp();
      return { kind: 'failed', reason: 'the claim beside the record could not be marked sent' };
    }
    held = 'sent';
    const started = input.now().getTime();
    // The row's own answer bound, when it names one, as the bus delivery reads it — capped by the
    // sender's own deadline: a send is a person's command and never waits out the bus's budget.
    const timeoutMs = Math.min(input.webhook.timeoutMs ?? WEBHOOK_POLICY.timeoutMs, SENDER_POST_DEADLINE_MS);
    try {
      const response = await (input.fetch ?? fetch)(request.url, {
        ...prepared,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) {
        finishClaim(input.dropDir, input.id, input.now);
        held = 'none';
        return { kind: 'posted', ms: Math.max(0, input.now().getTime() - started) };
      }
      giveUp();
      return { kind: 'failed', reason: `HTTP ${response.status}` };
    } catch (error) {
      const unsent = unsentReason(error);
      if (unsent !== null) {
        // The request provably never left: the fallback may post it.
        giveUp();
        return { kind: 'failed', reason: unsent };
      }
      // The body may have reached the routine and the answer was not read: the claim stays in
      // `sent`, and neither the bus nor a later pass posts the record again.
      return { kind: 'unknown', reason: unknownReason(error, timeoutMs) };
    }
  } catch {
    // An unexpected failure before the request was marked sent releases the claim, so the
    // fallback still posts it; after that, the claim stays and the routine is never asked twice.
    if (held === 'claimed') giveUp();
    return { kind: 'none', why: 'unexpected' };
  }
}

export type WebhookFactoryInput = {
  /** The team file the bus was started with: its webhook rows are the routes until `reload`. */
  team: TeamFile;
  /** The project root, so an inbox-body row can read the record its arrival names. */
  root?: string;
  /** Where the bus says a refusal or a final failure. Absent, the adapter stays silent. */
  stderr?: (text: string) => void;
  /** What one scheduled delivery did, with the seat it was for and the record it carried: the bus
   *  records the facts beside the seat. Absent, nothing is recorded. */
  onResult?: (seat: string, record: SignedEventRecord, facts: WebhookFacts) => void;
  policy?: Partial<WebhookPolicy>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/** The delivery function `fanOut` calls, and the one way a running bus replaces its rows. */
export type WebhookDelivery = ((record: SignedEventRecord) => void) & {
  /** Rebuild the routes from `team`. A delivery already scheduled keeps the row it started on:
   *  it captured that row's map entry, so a reload can never cancel it or send it elsewhere. */
  reload(team: TeamFile): void;
};

/**
 * The delivery function `fanOut` calls. The returned function never throws and never awaits: it
 * matches the record, schedules the bounded POST and returns. It is a no-op for any record other
 * than a `message.arrived` whose recipient configures an adapter — the record's payload is the
 * one live subscribers receive, and its `to` is the seat the arrival is for.
 */
export function makeWebhookDelivery(input: WebhookFactoryInput): WebhookDelivery {
  let routes = webhookRoutesOf(input.team);
  const deliver: WebhookDelivery = (record: SignedEventRecord): void => {
    try {
      if (record.payload.kind !== 'message.arrived') return;
      const to = record.payload.to;
      if (to === undefined) return;
      const webhook = routes.get(to);
      if (webhook === undefined) return;
      const report = (text: string): void => say(input.stderr, text);
      const onResult = input.onResult;
      void deliverWebhook({
        seat: to,
        webhook,
        record,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
        ...(onResult === undefined ? {} : { onResult: (facts: WebhookFacts) => onResult(to, record, facts) }),
        report,
      }).catch(() => {
        report(`webhook: ${to}: the delivery adapter failed; the drop file stays in place`);
      });
    } catch {
      // The bus's pass and its publish must never fail because of this adapter.
    }
  };
  deliver.reload = (team: TeamFile): void => {
    routes = webhookRoutesOf(team);
  };
  return deliver;
}
