// Body-carrying wakes and their post-delivery receipt. Resolution and admission stay with
// the caller; a receipt is published only after that caller proves transport acceptance.
import { join } from 'node:path';
import { currentClaimIn, readMessage } from '../mcp/inbox.ts';
import { messageKeyState } from '../store/keys.ts';
import { attributedBody } from './sender-claim.ts';
import { verifiedRecordAt, type RecordPayload } from './record.ts';

export const RUNTIME_WAKE_MAX = 64 * 1024;
export const TYPED_WAKE_MAX = 200;

export function oversizedWake(payload: RecordPayload): string {
  return `Message from ${payload.from}: body too long for this wake. Read it with: team drops --read --id ${payload.id} --seat ${payload.to}`;
}

export function inlineWake(payload: RecordPayload, home: string, limit = RUNTIME_WAKE_MAX): string | null {
  const text = attributedBody(payload.body, payload.from, { record: payload, home, root: payload.root, compact: false });
  return Buffer.byteLength(text, 'utf8') <= limit && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text) ? text : null;
}

/** The same verified reader used by inbox_read, without printing the body a second time. */
export function recordDeliveredBody(input: {
  dropDir: string; id: string; root: string; session: string; seat: string; home: string;
  wake?: string;
}): boolean {
  try {
    const key = messageKeyState(input.home);
    if (key.kind !== 'key') return false;
    const payload = verifiedRecordAt(join(input.dropDir, input.id), input.id, key.key);
    if (payload === null || payload.to !== input.seat || payload.session !== input.session) return false;
    if (input.wake !== undefined && inlineWake(payload, input.home) !== input.wake) return false;
    const read = readMessage({ dropDir: input.dropDir, root: input.root, session: input.session, seat: input.seat }, input.id, input.home,
      { claim: () => currentClaimIn(input.root, input.session, input.seat) });
    return read.ok || read.served === 'already-served';
  } catch {
    return false;
  }
}
