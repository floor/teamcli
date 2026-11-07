// The one frame the cross-session socket channel carries, and the line every frame ends with:
// how its receiver answers, and how it says it read the message without answering.
//
// A frame is normally transport, never the record: the signed copy lands in the receiver's folder
// first, and the frame is what its CLI shows. Under `messaging.store: none` there is no stored
// copy, so the frame carries the signed record's bytes itself (`record`) — signed, never stored —
// and a reader verifies those bytes with `carriedRecordOf` exactly as it would have verified the
// file in the drop folder. The reader line names the message id — the same id the frame carries
// in `msg_id` — because an answering seat runs `team reply <id>` and a seat that needs no answer
// runs `team ack <id>`, and both acts write the seat's own signed read receipt. An earlier build
// kept the id out of the content; ADR D3 supersedes that: the line cannot tell a reader what to
// run without it, and the id is no secret. The line is one line, the same for every sender — the
// owner included — because both commands address the record by id, never by the sender's name.

import { readdirSync } from 'node:fs';
import { recordNameOk } from './record.ts';
import { attributedBody } from './sender-claim.ts';

export const MIN_ID_PREFIX_LEN = 8;

/**
 * The shortest prefix of `id` (at least `MIN_ID_PREFIX_LEN` characters when `id` is that long)
 * that no other record id in `existingIds` shares.
 */
export function shortIdPrefix(id: string, existingIds: Iterable<string> = []): string {
  const others: string[] = [];
  for (const candidate of existingIds) {
    if (candidate !== id) others.push(candidate);
  }
  let len = Math.min(id.length, MIN_ID_PREFIX_LEN);
  while (len < id.length) {
    const prefix = id.slice(0, len);
    if (!others.some((other) => other.startsWith(prefix))) return prefix;
    len += 1;
  }
  return id;
}

/**
 * Every record filename currently in `dropDir`, excluding sidecar files (`.read.json`,
 * `.replied.json`, `.closed.json`, `.pending`, `.woken`, `.reported`). Returns `[]` when the
 * folder does not exist yet.
 */
export function existingRecordIdsIn(dropDir: string): string[] {
  try {
    return readdirSync(dropDir).filter(
      (name) =>
        recordNameOk(name) &&
        !name.endsWith('.pending') &&
        !name.endsWith('.taken') &&
        !name.endsWith('.read') &&
        !name.endsWith('.woken') &&
        !name.endsWith('.reported') &&
        !name.endsWith('.json') &&
        !name.startsWith('work-'),
    );
  } catch {
    return [];
  }
}

/**
 * The line every socket frame ends with. It names the shortest unique message id prefix twice —
 * once for the answer that marks the message read, once for the acknowledgement that needs no
 * answer — so a reader who saw the frame can settle it with the record they were given. One line:
 * `↩ team reply <prefix> "…" · team ack <prefix>`
 */
export function readerLine(msgId: string, existingIds: Iterable<string> = []): string {
  const prefix = shortIdPrefix(msgId, existingIds);
  return `↩ team reply ${prefix} "…" · team ack ${prefix}`;
}

/**
 * The line a compact socket frame (`compact_delivery: true`) ends with. It adds `team show
 * <prefix>` in front of `team reply` and `team ack`, using the same shortest unique id prefix:
 * `↩ team show <prefix> · team reply <prefix> · team ack <prefix>`
 */
export function compactReaderLine(msgId: string, existingIds: Iterable<string> = []): string {
  const prefix = shortIdPrefix(msgId, existingIds);
  return `↩ team show ${prefix} · team reply ${prefix} · team ack ${prefix}`;
}

export type SocketMessageFrameOptions = {
  from?: string;
  from_id?: string | null;
  rule?: string | null;
  cli?: string | null;
  displayName?: string | null;
  senderLabel?: string | null;
  compact?: boolean;
  existingIds?: Iterable<string>;
  human?: boolean;
  carried?: string;
  home?: string;
  root?: string;
};

/**
 * Builds a rendered socket message frame with the compact sender header, the body (or first
 * content line when `compact: true`), and the appropriate reader footer (`compactReaderLine` when
 * `compact: true`, `readerLine` otherwise, or `null` for a human pane).
 */
export function socketMessageFrame(
  _session: string,
  _seat: string,
  body: string,
  msgId: string,
  options: SocketMessageFrameOptions = {},
): string {
  const rendered = attributedBody(body, options.from ?? '', {
    cli: options.cli,
    displayName: options.displayName,
    senderLabel: options.senderLabel,
    rule: options.rule,
    compact: options.compact,
    home: options.home,
    root: options.root,
  });
  const reply = options.human
    ? null
    : options.compact
      ? compactReaderLine(msgId, options.existingIds)
      : readerLine(msgId, options.existingIds);
  return frameFor(rendered, msgId, reply, options.carried);
}

/** The one frame this channel carries: `type:"user"`, the whole body, the reader line as its own
 *  last line when the seat has one, and the id. A person-pane seat gets no reader line — a person
 *  answers in their own client — and the id stays in `msg_id` beside the line's own copy. Under
 *  `messaging.store: none`, `carried` is the signed record's exact text; it rides in `record`
 *  beside the id, so the receiver verifies the same bytes it would have read from its folder. */
export function frameFor(body: string, msgId: string, reply: string | null, carried?: string): string {
  const content = reply === null ? body : `${body}\n\n${reply}`;
  const frame: { type: 'user'; message: { role: 'user'; content: string }; msg_id: string; record?: string } = {
    type: 'user',
    message: { role: 'user', content },
    msg_id: msgId,
  };
  if (carried !== undefined) frame.record = carried;
  return `${JSON.stringify(frame)}\n`;
}
