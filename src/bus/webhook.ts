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
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SeatWebhook, TeamFile } from '../file/types.ts';
import type { SignedRecord } from '../send/record.ts';
import { webhookRouteOf, type WebhookRoute } from '../send/webhook.ts';
import type { SignedEventRecord } from './log.ts';

/** How hard one record is tried when the request could not be sent at all: three attempts in
 *  total, five seconds each, then one and four seconds between them — about twenty seconds. A
 *  routine that answered, or one whose answer was not seen before the bound, is never asked
 *  again: the POST may already have started a run, and a second one is worse than a report. */
export type WebhookPolicy = {
  timeoutMs: number;
  attempts: number;
  backoffMs: readonly number[];
};

export const WEBHOOK_POLICY: WebhookPolicy = {
  timeoutMs: 5000,
  attempts: 3,
  backoffMs: [1000, 4000],
};

/** What one delivery ended as: the routine took it (`delivered`, only after a 2xx), the request
 *  could not be sent and its attempts ran out (`failed`), the body may have reached the routine
 *  and no answer was read (`sent-unknown`), or the seat's files could not be read so nothing was
 *  posted (`refused`). */
export type WebhookOutcome = 'delivered' | 'failed' | 'refused' | 'sent-unknown';

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
 * was for the seat's own pull. A route that cannot be read is refused before any POST.
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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // A redirect is never followed: it would carry the secret to a destination the routine's
      // own address never named. The policy rides on the attempt, not on the request object, so a
      // row that names neither new field builds exactly the request object it always did.
      const response = await fetchFn(request.url, { ...prepared, redirect: 'error', signal: AbortSignal.timeout(policy.timeoutMs) });
      if (response.status >= 200 && response.status < 300) {
        return done({ outcome: 'delivered', attempts: attempt, reason: `HTTP ${response.status}` });
      }
      // The routine answered and refused: it was reached, so it is not asked a second time.
      const reason = `HTTP ${response.status}`;
      say(input.report, `webhook: ${input.seat}: not delivered after ${attemptsWord(attempt)} (${reason}); the drop file stays in place`);
      return done({ outcome: 'failed', attempts: attempt, reason });
    } catch (error) {
      if (redirected(error)) {
        const reason = 'a redirect the adapter does not follow';
        say(input.report, `webhook: ${input.seat}: not delivered after ${attemptsWord(attempt)} (${reason}); the drop file stays in place`);
        return done({ outcome: 'failed', attempts: attempt, reason });
      }
      const unsent = unsentReason(error);
      if (unsent === null) {
        // The body may have reached the routine. An answer we did not read is reported, never
        // retried: a second POST could start a second run far side.
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
  // The loop returns on every path; this is the type's floor, not a reachable ending.
  return done({ outcome: 'failed', attempts, reason: 'could not connect' });
}

export type WebhookFactoryInput = {
  /** The team file the bus was started with: its webhook rows are the routes until `reload`. */
  team: TeamFile;
  /** The project root, so an inbox-body row can read the record its arrival names. */
  root?: string;
  /** Where the bus says a refusal or a final failure. Absent, the adapter stays silent. */
  stderr?: (text: string) => void;
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
      void deliverWebhook({
        seat: to,
        webhook,
        record,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.policy === undefined ? {} : { policy: input.policy }),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
        ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
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
