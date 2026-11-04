// The router's send. It carries a record the asking principal already signed and
// stages it through the command's own durable copy. It does not sign with the
// checkout message key, and it does not call the command's send, which would.
import type { KeyObject } from 'node:crypto';
import { stageSignedDrop } from '../../commands/send.ts';
import { verifyRecord, type SignedRecord } from '../../send/record.ts';
import type { MailboxSendResult } from './ask.ts';

export async function commandMailboxSend(input: {
  signed: SignedRecord;
  /** The asking principal's key. Never looked up from the checkout. */
  publicKey: KeyObject;
  dropDir: string;
  /** The receiving team's home, for the staging note only. */
  home: string;
  project: string;
  now: () => Date;
  wake(messageId: string): Promise<boolean>;
}): Promise<MailboxSendResult> {
  if (!verifyRecord(input.signed, input.publicKey)) {
    return { ok: false, why: 'the ask is not signed by the asking principal' };
  }
  const staged = await stageSignedDrop(input.dropDir, input.signed, input.home, input.now, input.project);
  if (!staged.ok) return { ok: false, why: staged.reason };
  const woken = await input.wake(input.signed.payload.id);
  return { ok: true, messageId: input.signed.payload.id, woken };
}
