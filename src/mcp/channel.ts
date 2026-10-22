// The channel leg: a message the seat's own inbox server pushes to its CLI, and the one signed
// receipt that proves the seat read it.
//
// The channel is a development mode of the seat's launch, not a second transport an operator
// turns on separately: the seat's launch line carries the development-channels flag and names
// this team server, and the server then declares `experimental["claude/channel"]` and pushes one
// `notifications/claude/channel` per message that arrives after it starts. The body and the
// meta travel together; the signed record stays in the inbox for `inbox_read` and for every later
// reader, untouched. The push itself proves only that the notification was written — the client
// acknowledges nothing — so the server leaves a `<id>.channel-push.json` marker beside the record
// and the sender reads that marker to end its walk as `sent (channel)`.
//
// A pushed message with no signed `read` receipt after the confirmation window is the one case
// the watch redelivers. It redelivers exactly once (`redelivered: channel unconfirmed`), and only
// for an id with no receipt: an acknowledged message is never touched again.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The launch flag that loads a development channel, and the value that names this server. */
export const CHANNEL_FLAG = '--dangerously-load-development-channels';
export const CHANNEL_SERVER = 'team-inbox';

/** The capability a channel server declares, and the notification method the client renders. */
export const CHANNEL_CAPABILITY = 'claude/channel';
export const CHANNEL_METHOD = 'notifications/claude/channel';

/** The server's marker beside a pushed record. It is not a read receipt: only the signed
 *  `<id>.read.json` proves a read. */
export const CHANNEL_PUSH_RECEIPT = 'channel-push';
export const CHANNEL_PUSH_STATUS = 'sent (channel)';

/** The marker a sender leaves at the push marker's name when its own walk already wakes the seat
 *  through another leg. Any serving server treats a marker for the id as a push and skips it —
 *  including a long-lived server running an install this sender has already replaced, whose own
 *  push after the fallback would be a second wake. It is not a push, and the sender's own wait
 *  never reads it as one. */
export const CHANNEL_HELD_RECEIPT = 'channel-held';

/** How long a send waits for the server's push marker: the server polls its inbox on a short
 *  timer, so this is several polls, never a wait on the seat. */
export const CHANNEL_PUSH_GRACE_MS = 2_000;

/** How often the serving inbox looks for a record it has not pushed yet. */
export const CHANNEL_TICK_MS = 250;

/** How long a pushed message waits for its signed read receipt before the watch redelivers it
 *  through the next leg. Three minutes is long enough for a handling turn, short enough that a
 *  lost push is not lost for the ten-minute inbox fallback. */
export const CHANNEL_CONFIRM_MS = 3 * 60_000;

/** The reason a push was redelivered, as the marker's own `redelivered` value: the channel had
 *  no signed receipt when its confirmation window ended. */
export const CHANNEL_UNCONFIRMED = 'channel unconfirmed';

/** The note a redelivery records, on the marker and on the history line. */
export const CHANNEL_UNCONFIRMED_REASON = `redelivered: ${CHANNEL_UNCONFIRMED}`;

/** The read receipt's `read_by` for an acknowledgement made through the channel tool. */
export const CHANNEL_READ_BY = 'channel';

/** The one sentence the server gives its client when the channel is on. The model acknowledges
 *  the id from the notification's meta in the same turn, before it reads or acts on anything. */
export const CHANNEL_INSTRUCTIONS =
  'When a channel notification arrives, call the ack tool with the id from its meta in the same handling turn, before you read the message or act on it.';

/**
 * Whether a launch line starts its CLI with the development channel naming this team server.
 * The flag is the one measured on the client; its value is `server:<name>`, one or more of them,
 * comma-separated. Any other spelling, or a line without the flag, is no channel at all.
 */
export function channelLaunchEnabled(launch: string | undefined | null, server: string = CHANNEL_SERVER): boolean {
  if (typeof launch !== 'string' || launch.trim() === '') return false;
  const words = launch.trim().split(/\s+/);
  const chosen = `server:${server}`;
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at]!;
    if (word === CHANNEL_FLAG) {
      const value = words[at + 1];
      if (value !== undefined && value.split(',').includes(chosen)) return true;
      continue;
    }
    if (word.startsWith(`${CHANNEL_FLAG}=`)) {
      if (word.slice(CHANNEL_FLAG.length + 1).split(',').includes(chosen)) return true;
    }
  }
  return false;
}

/** The push marker's path: the record's own name, then the marker's suffix. */
export function channelPushPath(dropDir: string, id: string): string {
  return join(dropDir, `${id}.${CHANNEL_PUSH_RECEIPT}.json`);
}

/** Whether a marker for exactly this id is present and readable. The marker is either the
 *  server's push or the sender's held marker; both say this id is not to be pushed. A file that
 *  does not parse, or that names another id, is no marker. */
export function channelPushHeld(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id;
  } catch {
    return false;
  }
}

/** Whether the server itself wrote the push marker for this id. The sender's held marker sits at
 *  the same name but is not a push: the channel leg has not delivered anything when only that one
 *  is there, and its walk goes on. */
export function channelPushed(dropDir: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(channelPushPath(dropDir, id), 'utf8')) as { id?: unknown; kind?: unknown };
    return parsed !== null && typeof parsed === 'object' && parsed.id === id && parsed.kind !== CHANNEL_HELD_RECEIPT;
  } catch {
    return false;
  }
}

/** The sender's marker: its walk takes the message on another leg, so no serving channel may
 *  push it. `reason` says which walk left it; `at` is the sender's clock, not a push time. */
export type ChannelHeldReceipt = {
  v: 1;
  kind: 'channel-held';
  id: string;
  at: string;
  reason: string;
};

/**
 * Writes the sender's held marker whole, mode 0600. `wx` is the reservation: a marker already at
 * the name is the server's push of the same id, and a push that already happened is never
 * replaced. False when the marker could not be written or one was already there — the send goes
 * on either way; the marker only ever prevents a later push.
 */
export function recordChannelHeld(dropDir: string, receipt: ChannelHeldReceipt): boolean {
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The marker the server leaves after it writes one channel notification. The meta is kept as
 *  it travelled, so a reader can join the push to the message it named. */
export type ChannelPushReceipt = {
  v: 1;
  kind: 'channel-push';
  id: string;
  seat: string;
  session: string;
  root: string;
  at: string;
  meta: { id: string; from: string; seat: string; team: string };
  content_sha256: string;
  status: typeof CHANNEL_PUSH_STATUS;
};

/**
 * Writes the push marker whole, mode 0600. `wx` is the reservation: a marker already at the name
 * belongs to an earlier push of the same id, and the second write is refused rather than
 * replacing it. False when the marker could not be written or was already there — the caller
 * has already written the notification, so a marker that cannot be recorded never stops the
 * server.
 */
export function recordChannelPush(dropDir: string, receipt: ChannelPushReceipt): boolean {
  try {
    writeFileSync(channelPushPath(dropDir, receipt.id), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
