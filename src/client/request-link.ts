// One-request link: `team grant --request` prints `http://localhost:7392/r/<request_id>#<nonce>`.
// The nonce sits in the fragment, so a browser never sends it in a request line, a log or a
// Referer; the page posts it once to open the card. It is bound to one request id, single-use, and
// expires with the request. It authorizes nothing by itself: it only lets the owner page show that
// one card, and every answer on it still needs an owner-signer signature (a passkey assertion, or
// the Secure Enclave key behind Touch ID) bound to the request id and its parameter hash.
// Only the nonce's SHA-256 is stored.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { GRANT_REQUEST_ID_PATTERN, grantRequestsFolder } from './emission.ts';

/** The port the one-request link names: `team owner-seat serve --port 7392`. */
export const REQUEST_LINK_PORT = 7392;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

type LinkRecord = { request_id: string; nonce_sha256: string; expires_at: string };

function hashOf(nonce: string): string {
  return createHash('sha256').update(`team-request-link-v1\n${nonce}`, 'utf8').digest('hex');
}

function writeExclusive(path: string, text: string): 'written' | 'exists' | 'failed' {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return 'written';
}

export function requestLinkUrl(requestId: string, nonce: string, port: number = REQUEST_LINK_PORT): string {
  return `http://localhost:${port}/r/${requestId}#${nonce}`;
}

/** Creates the one link of one request. A second link for the same request is refused. */
export function createRequestLink(home: string, requestId: string, expiresAt: string, port: number = REQUEST_LINK_PORT): { ok: true; url: string; nonce: string } | { ok: false; why: string } {
  if (!GRANT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false, why: `"${requestId}" is not a grant request id` };
  const nonce = randomBytes(24).toString('base64url');
  const record: LinkRecord = { request_id: requestId, nonce_sha256: hashOf(nonce), expires_at: expiresAt };
  try {
    mkdirSync(grantRequestsFolder(home), { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, why: 'the requests folder cannot be created' };
  }
  const written = writeExclusive(join(grantRequestsFolder(home), `${requestId}.link.json`), `${JSON.stringify(record)}\n`);
  if (written !== 'written') return { ok: false, why: written === 'exists' ? `request ${requestId} already has a link` : 'the link could not be written' };
  return { ok: true, url: requestLinkUrl(requestId, nonce, port), nonce };
}

/** Opens a link once: right request, right nonce, unexpired, never opened before. Grants nothing. */
export function openRequestLink(home: string, requestId: string, nonce: string, now: Date = new Date()): { ok: true } | { ok: false; why: string } {
  const refused = { ok: false as const, why: 'this link is not valid for this request, already used, or expired' };
  if (!GRANT_REQUEST_ID_PATTERN.test(requestId) || !NONCE_PATTERN.test(nonce)) return refused;
  let record: LinkRecord;
  try {
    record = JSON.parse(readFileSync(join(grantRequestsFolder(home), `${requestId}.link.json`), 'utf8')) as LinkRecord;
  } catch {
    return refused;
  }
  if (record.request_id !== requestId || typeof record.nonce_sha256 !== 'string' || record.nonce_sha256.length !== 64) return refused;
  if (!timingSafeEqual(Buffer.from(record.nonce_sha256, 'hex'), Buffer.from(hashOf(nonce), 'hex'))) return refused;
  if (!(Date.parse(record.expires_at) > now.getTime())) return refused;
  // Single use: the first open claims it, exclusively.
  if (writeExclusive(join(grantRequestsFolder(home), `${requestId}.link-used`), `${now.toISOString()}\n`) !== 'written') return refused;
  return { ok: true };
}
