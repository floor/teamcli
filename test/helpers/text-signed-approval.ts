import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bumpGeneration, keyOf, signPayload } from '../../src/store/keys.ts';
import { mergeLedger, payloadOf, readLedger, type ApprovalRecord, type LedgerEntry } from '../../src/store/store.ts';

/**
 * Writes an approval the way versions before the canonical team record did: signed over the
 * stored file text (`team-approval-v1`), not over the record. This version never writes one;
 * it still verifies one (the compatibility path), and only such a record can carry a stored
 * copy that is not a team file — the case these tests exercise.
 */
export function writeTextSignedApproval(
  store: string,
  record: ApprovalRecord,
  seats: readonly LedgerEntry[],
  home: string = homedir(),
  now: Date = new Date(),
): number {
  const key = keyOf(home);
  const generation = bumpGeneration(record.approval.root, home, now);
  const signature = signPayload(payloadOf(record.approval, record.file, generation), key);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, 'ledger.json'), `${JSON.stringify(mergeLedger(readLedger(store), seats), null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(store, 'approval.json'), `${JSON.stringify({ ...record.approval, file: record.file, generation, signature }, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(store, 'approved.yaml'), record.file, { mode: 0o600 });
  return generation;
}
