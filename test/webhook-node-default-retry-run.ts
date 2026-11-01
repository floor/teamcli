// Runs the webhook delivery's default retry wait under the plain runtime. The test bundles this
// file for node and runs it there: the production build's types carry the standard library only,
// and the installed CLI runs where a bundler's own sleep does not exist, so the default path
// must not reach for one. The injected fetch answers 503 so the retry is the thing under test;
// the default sleep is the one used, because `sleep` is not passed at all.
//
// The URL file names a loopback address nothing listens on: no POST reaches it, since the
// injected fetch answers instead. The secret is synthetic. No real URL, no real secret.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverWebhook } from '../src/bus/webhook.ts';
import type { SignedEventRecord } from '../src/bus/log.ts';

const base = mkdtempSync(join(tmpdir(), 'team-webhook-node-retry-'));
const urlFile = join(base, 'hook-url');
const secretFile = join(base, 'hook-secret');
writeFileSync(urlFile, 'http://127.0.0.1:1/synthetic\n');
writeFileSync(secretFile, 'synthetic-secret-value\n', { mode: 0o600 });

const record: SignedEventRecord = {
  signature: 'sig-node-retry',
  payload: {
    v: 1,
    seq: 1,
    ts: '2026-11-01T00:00:00.000Z',
    kind: 'message.arrived',
    session: 'acme',
    record_id: 'msg-node-retry',
    from: 'lead',
    to: 'synthetic',
    seat: 'synthetic',
  },
};

let attempts = 0;
const started = Date.now();
const outcome = await deliverWebhook({
  seat: 'synthetic',
  webhook: { urlFile, secretFile },
  record,
  // The second attempt is the point: it only happens if the wait between them returned.
  policy: { attempts: 2, timeoutMs: 50, backoffMs: [60] },
  fetch: (async () => {
    attempts += 1;
    return new Response('', { status: 503 });
  }) as unknown as typeof fetch,
});
console.log(JSON.stringify({ runtime: process.version, attempts, outcome, elapsedMs: Date.now() - started }));
