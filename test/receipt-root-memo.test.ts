// The receipt check reuses one checkout's resolved folder for a few seconds instead of resolving
// it for every receipt of a pass. The reuse only scopes the check's cache key: a receipt for
// another checkout, seat or session is still refused, warm or cold, and a checkout reached
// through a link resolves to the same folder. Homes and folders are scratch.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageKeyOf } from '../src/store/keys.ts';
import { receiptFile, receiptHolds, signReceiptPayload, writeReceipt, type ReceiptPayload } from '../src/send/record.ts';

const made: string[] = [];
afterEach(() => {
  for (const one of made.splice(0)) rmSync(one, { recursive: true, force: true });
});

const ID = 'c0ffee00-1111-4222-8333-444455556677';

function scene(): { home: string; root: string; link: string; other: string; dropDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'team-receipt-memo-'));
  made.push(base);
  const root = join(base, 'root');
  const other = join(base, 'other');
  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(dropDir, { recursive: true });
  mkdirSync(other, { recursive: true });
  const link = join(base, 'root-link');
  symlinkSync(root, link);
  return { home: join(base, 'home'), root, link, other, dropDir };
}

function readReceipt(root: string): ReceiptPayload {
  return { kind: 'receipt', status: 'read', id: ID, to: 'lead', root, session: 'acme', at: '2026-11-17T12:00:00.000Z' };
}

test('a warm check still refuses another checkout, seat and session, and takes the linked checkout', () => {
  const s = scene();
  const key = messageKeyOf(s.home);
  const written = writeReceipt(s.dropDir, signReceiptPayload(readReceipt(s.root), s.home), s.home);
  if (!written.ok) throw new Error(written.reason);
  const path = receiptFile(s.dropDir, ID, 'read');
  const own = { to: 'lead', root: s.root, session: 'acme' };
  for (let pass = 0; pass < 3; pass++) {
    expect(receiptHolds(path, ID, 'read', own, key)).toBe(true);
    expect(receiptHolds(path, ID, 'read', { ...own, root: s.link }, key)).toBe(true);
    expect(receiptHolds(path, ID, 'read', { ...own, root: s.other }, key)).toBe(false);
    expect(receiptHolds(path, ID, 'read', { ...own, to: 'worker' }, key)).toBe(false);
    expect(receiptHolds(path, ID, 'read', { ...own, session: 'other' }, key)).toBe(false);
    expect(receiptHolds(path, ID, 'replied', own, key)).toBe(false);
  }
});
