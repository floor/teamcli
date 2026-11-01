// The seat's webhook adapter, read from what the team file names: the URL and the secret are the
// contents of two files, read when a delivery is posted rather than when the record was written.
// The record holds paths only, so a rotated URL or secret applies without touching the team file,
// and neither value is ever printed, logged or written into a record.
//
// The secret file follows the drop files' stance: a regular file owned by the running user with
// no group or other permission bits. Anything else is refused in plain words, naming the path
// and — when the mode is the problem — the mode, never the value. The URL file carries no
// secrecy, but it is read the same careful way: a regular file, non-empty, and an http(s) URL.
//
// `webhookRouteOf` is the one reader both halves of a send share: the dry run names the route it
// would take and the delivery class reads it as push evidence, so the two can never disagree.
import { lstatSync, readFileSync } from 'node:fs';
import type { SeatWebhook } from '../file/types.ts';

/** The most a URL or secret file may hold; both are one line of text, not documents. */
export const WEBHOOK_FILE_LIMIT = 4096;

/** What reading one webhook file found: the value, or a plain-words reason it cannot be used. */
export type WebhookFileRead = { ok: true; value: string } | { ok: false; reason: string };

/** Where the adapter would post, or why it cannot: `null` when the seat configures none. */
export type WebhookRoute = { ok: true; url: string; secret: string } | { ok: false; reason: string };

/** A regular file, read and trimmed, with the two problems every file here shares: missing or
 *  unreadable, and empty. */
function readRegularFile(path: string, what: string): WebhookFileRead {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return { ok: false, reason: `the ${what} file ${path} is missing or unreadable` };
  }
  if (!stats.isFile()) return { ok: false, reason: `the ${what} file ${path} is not a regular file` };
  if (stats.size > WEBHOOK_FILE_LIMIT) {
    return { ok: false, reason: `the ${what} file ${path} is larger than ${WEBHOOK_FILE_LIMIT} bytes` };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: `the ${what} file ${path} is missing or unreadable` };
  }
  const value = text.trim();
  if (value === '') return { ok: false, reason: `the ${what} file ${path} is empty` };
  return { ok: true, value };
}

/** The secret's own rules, checked before its contents are read: a regular file, owned by the
 *  running user, and readable by that user alone. */
function readSecretFile(path: string): WebhookFileRead {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    return { ok: false, reason: `the secret file ${path} is missing or unreadable` };
  }
  if (!stats.isFile()) return { ok: false, reason: `the secret file ${path} is not a regular file` };
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    return { ok: false, reason: `the secret file ${path} is not owned by the user running the team` };
  }
  if ((stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8).padStart(4, '0');
    return {
      ok: false,
      reason: `the secret file ${path} is readable by group or others (mode ${mode}); write it 0600, readable by its owner alone`,
    };
  }
  return readRegularFile(path, 'secret');
}

/** The URL file's contents as an http(s) URL: the one shape a routine's address takes. */
function readUrlFile(path: string): WebhookFileRead {
  const read = readRegularFile(path, 'URL');
  if (!read.ok) return read;
  try {
    const url = new URL(read.value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: `the URL file ${path} does not hold an http(s) URL` };
    }
  } catch {
    return { ok: false, reason: `the URL file ${path} does not hold an http(s) URL` };
  }
  return read;
}

/**
 * The route a seat's webhook adapter names right now, or the first reason it cannot post.
 * `null` when the seat configures no adapter. Never throws: a refusal is a sentence, not an
 * exception, because both a dry run and a delivery pass read this.
 */
export function webhookRouteOf(webhook: SeatWebhook | undefined): WebhookRoute | null {
  if (webhook === undefined) return null;
  try {
    const url = readUrlFile(webhook.urlFile);
    if (!url.ok) return url;
    const secret = readSecretFile(webhook.secretFile);
    if (!secret.ok) return secret;
    return { ok: true, url: url.value, secret: secret.value };
  } catch {
    return { ok: false, reason: 'the webhook files could not be read' };
  }
}

/** The reason a configured adapter cannot deliver, or `null` when it can (or none is set). */
export function webhookRefusal(webhook: SeatWebhook | undefined): string | null {
  const route = webhookRouteOf(webhook);
  return route !== null && !route.ok ? route.reason : null;
}
