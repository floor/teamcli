// Body-carrying wakes and their post-delivery receipt. Resolution and admission stay with
// the caller; a receipt is published only after that caller proves transport acceptance.
import { exposeBody, exposurePointer, type BodyLeg, type ExposureHandle } from '../queue/exposure.ts';
import { takeCopyNumber, unwrapCopy, wrapCopy } from '../queue/handover.ts';
import { isStampedPayload } from './record.ts';
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
  /** The owned exposure claim the carrying leg holds (rfc-event-comms §3, E6): the read is sealed
   *  through that claim only. Absent: the legacy read (the root is not active). */
  owner?: string;
}): boolean {
  try {
    const key = messageKeyState(input.home);
    if (key.kind !== 'key') return false;
    const payload = verifiedRecordAt(join(input.dropDir, input.id), input.id, key.key);
    if (payload === null || payload.to !== input.seat || payload.session !== input.session) return false;
    // The wake must be this record's own body, in either shape a wake carries it.
    // A stamped record is never settled by its carrier: only its recipient acknowledges it (E7b).
    if (isStampedPayload(payload)) return false;
    if (input.wake !== undefined && inlineWake(payload, input.home) !== unwrapCopy(input.wake, input.id)
      && inlineWake(payload, input.home, RUNTIME_WAKE_MAX, 'typed') !== unwrapCopy(input.wake, input.id)) return false;
    const brief = { claim: () => currentClaimIn(input.root, input.session, input.seat) };
    if (input.owner !== undefined) {
      // The seal of one hand-over (E3): the same owned claim, adopted; never a new exposure.
      const handed = readMessage({ dropDir: input.dropDir, root: input.root, session: input.session, seat: input.seat }, input.id, input.home,
        brief, undefined, { receipt: 'after', owner: input.owner, adopt: true });
      return handed.ok ? (handed.seal?.() ?? false) : false;
    }
    const read = readMessage({ dropDir: input.dropDir, root: input.root, session: input.session, seat: input.seat }, input.id, input.home, brief);
    return read.ok || read.served === 'already-served';
  } catch {
    return false;
  }
}

/** What one leg carries for one message (E6): the text, whether it is the body, and the hand-over
 *  handle that settles it. Built once, immediately before the leg's frame; its settle is the only
 *  way the leg's read receipt is written. */
export type LegBody = { text: string | null; carriesBody: boolean; handle: ExposureHandle | null };

export function legBody(payload: RecordPayload, home: string, leg: BodyLeg, dropDir: string, limit = RUNTIME_WAKE_MAX, shape: 'runtime' | 'typed' = 'runtime'): LegBody {
  const text = inlineWake(payload, home, limit, shape);
  if (text === null) return { text: null, carriesBody: false, handle: null };
  if (isStampedPayload(payload)) {
    // E7b: a stamped record's copy is numbered, durably, immediately before it leaves. History
    // that cannot be written sends no body now (the pointer); the record stays due.
    const n = takeCopyNumber(dropDir, payload.id, leg);
    if (n === null) return { text: null, carriesBody: false, handle: null };
    return { text: wrapCopy(text, payload.id, n), carriesBody: true, handle: null };
  }
  const decision = exposeBody({ dropDir, root: payload.root, session: payload.session, seat: payload.to, msgId: payload.id }, leg, home);
  if (decision.kind === 'pointer') return { text: exposurePointer(payload.id, null), carriesBody: false, handle: null };
  return { text, carriesBody: true, handle: decision.kind === 'expose' ? decision : null };
}

/** The runtime pointer field: the leg's text, or the oversized pointer when no body fits. */
export function legText(body: LegBody, payload: RecordPayload): string {
  return body.text ?? oversizedWake(payload);
}

/** E3 for a leg: records the read only for a body that was carried and handed over. */
export function settleLegBody(body: LegBody, handedOver: 'yes' | 'no' | 'unknown', input?: { dropDir: string; id: string; root: string; session: string; seat: string; home: string; wake?: string }): void {
  if (!body.carriesBody) return;
  if (input === undefined) {
    if (handedOver !== 'yes') body.handle?.settle(handedOver, () => false);
    return;
  }
  if (body.handle === null) {
    if (handedOver === 'yes') recordDeliveredBody(input);
    return;
  }
  body.handle.settle(handedOver, (owner) => recordDeliveredBody({ ...input, owner }));
}

export { exposurePointer };
