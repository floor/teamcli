// Body-carrying wakes and their post-delivery receipt. Resolution and admission stay with
// the caller; a receipt is published only after that caller proves transport acceptance.
import { bodyActor, bodyExposure, exposurePointer, type BodyLeg } from '../queue/exposure.ts';
import { join } from 'node:path';
import { currentClaimIn, readMessage } from '../mcp/inbox.ts';
import { messageKeyState } from '../store/keys.ts';
import { attributedBody } from './sender-claim.ts';
import { fullReaderLine, takesReaderLine } from './frame.ts';
import { isGeneralBriefRecord } from '../launch/general-brief.ts';
import { profileFor } from '../profiles/index.ts';
import { verifiedRecordAt, type RecordPayload } from './record.ts';

export const RUNTIME_WAKE_MAX = 64 * 1024;
export const TYPED_WAKE_MAX = 200;

/** The longest typed wake for this CLI: its profile's measured `typed_wake_max`, or 200. */
export function typedWakeMaxFor(cli: string | undefined): number {
  return (cli === undefined ? null : profileFor(cli)?.typedWakeMax ?? null) ?? TYPED_WAKE_MAX;
}

export function oversizedWake(payload: RecordPayload): string {
  return `Message from ${payload.from}: body too long for this wake. Read it with: team drops --read --id ${payload.id} --seat ${payload.to}`;
}

/** The body a wake carries, ending with the reader line when the record takes one. A typed wake
 *  (`shape: 'typed'`) keeps the id on the body's last row instead (` ↩ team reply <id>`): a
 *  composer draws a few rows only, and a paragraph of its own makes the box unreadable. Both
 *  shapes name the whole id: a wake is built without the receiving mailbox, so a prefix it
 *  printed could be shared by another record there, which `team reply` refuses as ambiguous. */
export function inlineWake(payload: RecordPayload, home: string, limit = RUNTIME_WAKE_MAX, shape: 'runtime' | 'typed' = 'runtime'): string | null {
  const attributed = attributedBody(payload.body, payload.from, { record: payload, home, root: payload.root, compact: false });
  const text = !takesReaderLine(payload, isGeneralBriefRecord(payload))
    ? attributed
    : shape === 'typed'
      ? `${attributed} ↩ team reply ${payload.id}`
      : `${attributed}\n\n${fullReaderLine(payload.id)}`;
  return Buffer.byteLength(text, 'utf8') <= limit && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text) ? text : null;
}

/** The same verified reader used by inbox_read, without printing the body a second time. */
export function recordDeliveredBody(input: {
  dropDir: string; id: string; root: string; session: string; seat: string; home: string;
  wake?: string;
  /** The leg that carried the body (rfc-event-comms §3): its exposure claim is continued here.
   *  Absent: a typed-shape wake is `typed`, a runtime-shape wake `native`, no wake `channel`. */
  leg?: BodyLeg;
}): boolean {
  try {
    const key = messageKeyState(input.home);
    if (key.kind !== 'key') return false;
    const payload = verifiedRecordAt(join(input.dropDir, input.id), input.id, key.key);
    if (payload === null || payload.to !== input.seat || payload.session !== input.session) return false;
    // The wake must be this record's own body, in either shape a wake carries it.
    if (input.wake !== undefined && inlineWake(payload, input.home) !== input.wake
      && inlineWake(payload, input.home, RUNTIME_WAKE_MAX, 'typed') !== input.wake) return false;
    const leg: BodyLeg = input.leg
      ?? (input.wake === undefined ? 'channel' : inlineWake(payload, input.home, RUNTIME_WAKE_MAX, 'typed') === input.wake ? 'typed' : 'native');
    const read = readMessage({ dropDir: input.dropDir, root: input.root, session: input.session, seat: input.seat }, input.id, input.home,
      { claim: () => currentClaimIn(input.root, input.session, input.seat) }, undefined, undefined, bodyActor(leg, input.id));
    return read.ok || read.served === 'already-served';
  } catch {
    return false;
  }
}

/**
 * The inline body a leg may carry for `payload` (rfc-event-comms §3): `inlineWake`'s text when this
 * leg holds (or creates) the message's exposure claim, or when no fence applies; null when another
 * leg already exposed it, so the caller sends its pointer instead. Called by the leg immediately
 * before it carries the body.
 */
export function exposedInline(payload: RecordPayload, home: string, leg: BodyLeg, limit = RUNTIME_WAKE_MAX, shape: 'runtime' | 'typed' = 'runtime'): string | null {
  const text = inlineWake(payload, home, limit, shape);
  if (text === null) return null;
  const decision = bodyExposure({ root: payload.root, session: payload.session, seat: payload.to, msgId: payload.id }, leg, home);
  return decision.kind === 'pointer' ? null : text;
}

export { exposurePointer };

/** The text a runtime leg carries: the inline body when this leg may expose it, the exposure
 *  pointer when another leg already did, or the oversized pointer when the body does not fit. */
export function wakeTextFor(payload: RecordPayload, home: string, leg: BodyLeg): string {
  const inline = exposedInline(payload, home, leg);
  if (inline !== null) return inline;
  return inlineWake(payload, home) !== null ? exposurePointer(payload.id, null) : oversizedWake(payload);
}
