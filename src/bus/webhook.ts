// The seat's webhook delivery adapter: every accepted signed message for a seat that configures
// one is POSTed to its routine. The drop folder record is the backup, never a fallback that gets
// consumed — this module reads it not at all and writes nothing, so a 2xx that arrives after the
// seat's pull simply delivers twice, and a refusal leaves the message where it was.
//
// The hand-off is `fanOut` in `src/bus/server.ts` (builder-4's file): the returned function is
// synchronous and schedules its work, so it never blocks a reconcile pass or a publish, and it
// never throws into the caller — every refusal and every failure is a line on `stderr` instead.
// The record is already durable and identical to the one live subscribers receive; nothing here
// assumes it was written this tick, and a duplicate never reaches `fanOut` at all.
//
// The request shape and the way the secret authenticates live in `webhookRequest`, one function,
// until the routine's own contract is forwarded. Everything else here reads files and counts
// answers.
import type { SeatWebhook, TeamFile } from '../file/types.ts';
import { webhookRouteOf } from '../send/webhook.ts';
import type { SignedEventRecord } from './log.ts';

/** How hard one record is tried before the drop waits for the seat's own pull: three attempts in
 *  total, five seconds each, then one and four seconds between them — about twenty seconds. */
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

/** What one delivery ended as: the routine took it, the bound ran out, or the seat's files could
 *  not be read (so nothing was posted). */
export type WebhookOutcome = 'delivered' | 'failed' | 'refused';

/**
 * The one place the routine's contract lives: the body it is sent and the way the secret
 * authenticates it. Until the routine's own contract is forwarded this is a placeholder — a JSON
 * envelope carrying the signed record and a bearer header — pinned only by the tests. Replacing
 * this function replaces the scheme everywhere, and no caller reads the secret otherwise.
 */
export function webhookRequest(record: SignedEventRecord, url: string, secret: string): { url: string; init: RequestInit } {
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ v: 1, event: record }),
    },
  };
}

/** The seats that configure an adapter, by seat name, as the bus's team file names them. The bus
 *  reads this once at start: a changed row applies at the next bus start. */
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
  policy?: Partial<WebhookPolicy>;
  /** Where refusals and final failures are said; absent, they are contained and dropped. */
  report?: (text: string) => void;
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

/** The reason one attempt failed, in fixed words: a timeout says so, and anything else is a
 *  connection failure, with the error's class name as the only detail. */
function attemptReason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `no answer within ${timeoutMs} ms`;
  }
  const cls = errorClass(error);
  return cls === null ? 'could not connect' : `could not connect (${cls})`;
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
 * Posts one accepted record, within the policy's bound. A 2xx answer is delivered; any other
 * status, a timeout or a network error is retried, and after the last attempt the drop file is
 * left exactly where it was for the seat's own pull. A route that cannot be read is refused
 * before any POST and is not retried.
 */
export async function deliverWebhook(input: WebhookDeliveryInput): Promise<WebhookOutcome> {
  const route = webhookRouteOf(input.webhook);
  if (route === null || !route.ok) {
    say(
      input.report,
      `webhook: ${input.seat}: not posted: ${route === null ? 'no webhook adapter is configured' : route.reason}; the drop file stays in place`,
    );
    return 'refused';
  }
  const policy: WebhookPolicy = { ...WEBHOOK_POLICY, ...input.policy };
  const attempts = Math.max(1, policy.attempts);
  const fetchFn = input.fetch ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const request = webhookRequest(input.record, route.url, route.secret);
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
    return 'failed';
  }
  let reason = 'could not connect';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchFn(request.url, { ...prepared, signal: AbortSignal.timeout(policy.timeoutMs) });
      if (response.status >= 200 && response.status < 300) return 'delivered';
      reason = `HTTP ${response.status}`;
    } catch (error) {
      reason = attemptReason(error, policy.timeoutMs);
    }
    if (attempt < attempts) {
      const wait = policy.backoffMs[attempt - 1] ?? policy.backoffMs[policy.backoffMs.length - 1] ?? 0;
      await sleep(wait);
    }
  }
  say(input.report, `webhook: ${input.seat}: not delivered after ${attempts} attempts (${reason}); the drop file stays in place`);
  return 'failed';
}

export type WebhookFactoryInput = {
  /** The team file the bus was started with: its webhook rows are the routes. */
  team: TeamFile;
  /** Where the bus says a refusal or a final failure. Absent, the adapter stays silent. */
  stderr?: (text: string) => void;
  policy?: Partial<WebhookPolicy>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * The delivery function `fanOut` calls. The returned function never throws and never awaits: it
 * matches the record, schedules the bounded POST and returns. It is a no-op for any record other
 * than a `message.arrived` whose recipient configures an adapter — the record's payload is the
 * one live subscribers receive, and its `to` is the seat the arrival is for.
 */
export function makeWebhookDelivery(input: WebhookFactoryInput): (record: SignedEventRecord) => void {
  const routes = webhookRoutesOf(input.team);
  return (record: SignedEventRecord): void => {
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
}
