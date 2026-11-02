// The seat's webhook adapter, read from what the team file names: the URL and the secret are the
// contents of two files, read when a delivery is posted rather than when the record was written.
// The record holds paths only, so a rotated URL or secret applies without touching the team file,
// and neither value is ever printed, logged or written into a record.
//
// The secret file follows the drop files' stance: a regular file owned by the running user with
// no group or other permission bits. Anything else is refused in plain words, naming the path
// and — when the mode is the problem — the mode, never the value. Both files are opened once,
// without following a link and without waiting, and every check and the bytes themselves come
// from that one descriptor: a path replaced between the check and the read cannot substitute
// another file. The open is nonblocking so that a FIFO, which has no writer yet, is refused by
// its type rather than waited on indefinitely, and the refusal names the kind.
// Both files are read as one line and a value with a control character is refused too, because a
// platform error about such a value repeats it verbatim. The URL file carries no secrecy, but it
// is read the same careful way: a regular file, non-empty, an http(s) URL, and no userinfo
// credentials of its own — those belong in the secret file, and an error about them would echo
// the URL.
//
// `webhookRouteOf` is the one reader both halves of a send share: the dry run names the route it
// would take and the delivery class reads it as push evidence, so the two can never disagree.
import { closeSync, constants, fstatSync, openSync, readFileSync, type Stats } from 'node:fs';
import type { SeatWebhook, WebhookBodyShape } from '../file/types.ts';

/** The most a URL or secret file may hold; both are one line of text, not documents. */
export const WEBHOOK_FILE_LIMIT = 4096;

/** `O_NOFOLLOW` is POSIX, not plain JS: a platform without it gets 0, and the descriptor's own
 *  checks still hold the file to a regular one of the running user's, at 0600 or tighter. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** `O_NONBLOCK` is POSIX too, and it matters before the descriptor's checks run: a FIFO has no
 *  writer yet, so a blocking open waits for one instead of returning, and the type check that
 *  would refuse it is never reached. Nonblocking, the open returns at once on anything a read
 *  could otherwise wait on, and the descriptor's type decides. A platform without the flag gets
 *  0, and the checks still hold. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/** What reading one webhook file found: the value, or a plain-words reason it cannot be used. */
export type WebhookFileRead = { ok: true; value: string } | { ok: false; reason: string };

/** Where the adapter would post, or why it cannot: `null` when the seat configures none. The
 *  header and body words are the row's own, carried through as written; both are absent on a row
 *  that names neither, which keeps the form every earlier row had. */
export type WebhookRoute =
  | { ok: true; url: string; secret: string; header?: string; body?: WebhookBodyShape }
  | { ok: false; reason: string };

/** The plain words for what an opened path is, when it is not a regular file: the desk can say
 *  why it refused, and the owner can tell a mistyped path from a deliberately rare shape. */
function nonRegularKind(stats: Stats): string | null {
  if (stats.isFIFO()) return 'a FIFO';
  if (stats.isSocket()) return 'a socket';
  if (stats.isDirectory()) return 'a directory';
  if (stats.isCharacterDevice() || stats.isBlockDevice()) return 'a device';
  return null;
}

/** A regular file's text, or a plain-words reason it cannot be read. The file is opened once,
 *  without following a link and without waiting on a special file, and the type, the size, any
 *  `extra` check and the bytes themselves all come from that one descriptor: a path replaced
 *  after the open cannot swap the file that was checked for the one that is read. The text is
 *  not trimmed: the value's own bytes decide whether it is one line (`oneLine`). */
function readRegularFile(
  path: string,
  what: string,
  extra?: (stats: Stats) => string | null,
): WebhookFileRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return { ok: false, reason: `the ${what} file ${path} is missing or unreadable` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      const kind = nonRegularKind(stats);
      return { ok: false, reason: `the ${what} file ${path} is not a regular file${kind === null ? '' : ` (it is ${kind})`}` };
    }
    if (stats.size > WEBHOOK_FILE_LIMIT) {
      return { ok: false, reason: `the ${what} file ${path} is larger than ${WEBHOOK_FILE_LIMIT} bytes` };
    }
    const refused = extra?.(stats) ?? null;
    if (refused !== null) return { ok: false, reason: refused };
    return { ok: true, value: readFileSync(fd, 'utf8') };
  } catch {
    return { ok: false, reason: `the ${what} file ${path} is missing or unreadable` };
  } finally {
    closeSync(fd);
  }
}

/** The file's one line: a trailing newline is the editor's and is trimmed once. Every other
 *  byte, including a second newline or a space, is the value's own. */
function oneLine(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/** A value with any control character is refused before it is used, in words that never repeat
 *  it: such a value breaks a header, and the platform's own error then carries it verbatim. */
function controlReason(value: string, path: string, what: string): string | null {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return `the ${what} file ${path} holds a newline or control character; write it as one line with no control characters`;
    }
  }
  return null;
}

/** The secret's own rules, checked on the descriptor the value is read from: a regular file,
 *  owned by the running user, and readable by that user alone. */
function readSecretFile(path: string): WebhookFileRead {
  const read = readRegularFile(path, 'secret', (stats) => {
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
      return `the secret file ${path} is not owned by the user running the team`;
    }
    if ((stats.mode & 0o077) !== 0) {
      const mode = (stats.mode & 0o777).toString(8).padStart(4, '0');
      return `the secret file ${path} is readable by group or others (mode ${mode}); write it 0600, readable by its owner alone`;
    }
    return null;
  });
  if (!read.ok) return read;
  const value = oneLine(read.value);
  if (value.trim() === '') return { ok: false, reason: `the secret file ${path} is empty` };
  const control = controlReason(value, path, 'secret');
  if (control !== null) return { ok: false, reason: control };
  return { ok: true, value };
}

/** The URL file's contents as an http(s) URL: the one shape a routine's address takes. A URL
 *  that carries its own credentials is refused without repeating any of them; the secret has a
 *  file of its own. */
function readUrlFile(path: string): WebhookFileRead {
  const read = readRegularFile(path, 'URL');
  if (!read.ok) return read;
  const value = oneLine(read.value);
  if (value.trim() === '') return { ok: false, reason: `the URL file ${path} is empty` };
  const control = controlReason(value, path, 'URL');
  if (control !== null) return { ok: false, reason: control };
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') {
      return {
        ok: false,
        reason: `the URL file ${path} names credentials; the secret belongs in the secret file, never in the URL`,
      };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: `the URL file ${path} does not hold an http(s) URL` };
    }
  } catch {
    return { ok: false, reason: `the URL file ${path} does not hold an http(s) URL` };
  }
  return { ok: true, value };
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
    return {
      ok: true,
      url: url.value,
      secret: secret.value,
      ...(webhook.header === undefined ? {} : { header: webhook.header }),
      ...(webhook.body === undefined ? {} : { body: webhook.body }),
    };
  } catch {
    return { ok: false, reason: 'the webhook files could not be read' };
  }
}

/** The reason a configured adapter cannot deliver, or `null` when it can (or none is set). */
export function webhookRefusal(webhook: SeatWebhook | undefined): string | null {
  const route = webhookRouteOf(webhook);
  return route !== null && !route.ok ? route.reason : null;
}
