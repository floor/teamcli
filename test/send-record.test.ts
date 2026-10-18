// The signed message record (§3.1–3.3): the one file a send writes into the recipient's folder,
// its name the message's id, its payload carrying both registry ids and the admitting rule, its
// signature the checkout's message key. The file is written whole at 0600 and never replaced: a
// second record of one id is the receiver's duplicate to drop. Status is derived from the
// receipt records beside it — `held`, `delivered`, `read`, `replied` — and a receipt counts only
// when it names this message, seat, session and checkout and the key signed it.
//
// Fixtures only: a scratch home and a scratch record folder, both removed at the end.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageKeyOf } from '../src/store/keys.ts';
import {
  ensureRecord,
  readRecord,
  receiptFile,
  RECEIPT_STATUSES,
  recordFile,
  recordNameOk,
  recordPayloadOf,
  signReceiptPayload,
  signRecord,
  signedRecordOf,
  statusOf,
  verifyReceipt,
  verifyRecord,
  writeReceipt,
  writeRecord,
  type ReceiptPayload,
  type RecordPayload,
} from '../src/send/record.ts';

function scratch(): { home: string; dropDir: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'team-record-'));
  const dropDir = join(base, 'root', '.agents', 'send-drops', 'acme', 'lead');
  mkdirSync(dropDir, { recursive: true });
  return { home: join(base, 'home'), dropDir, done: () => rmSync(base, { recursive: true, force: true }) };
}

function payload(overrides: Partial<RecordPayload> = {}): RecordPayload {
  return {
    kind: 'message',
    id: 'c0ffee00-1111-4222-8333-444455556666',
    to: 'lead',
    to_id: 'agent-lead',
    root: '/scratch/root',
    session: 'acme',
    at: '2026-10-18T00:00:00.000Z',
    body: 'from the owner — admitted by: the owner\n\nhello',
    from: 'owner',
    from_id: null,
    rule: 'the owner writes to any seat',
    thread: 'c0ffee00-1111-4222-8333-444455556666',
    ...overrides,
  };
}

function receipt(overrides: Partial<ReceiptPayload> = {}): ReceiptPayload {
  const one = payload();
  return {
    kind: 'receipt',
    status: 'delivered',
    id: one.id,
    to: one.to,
    root: one.root,
    session: one.session,
    at: '2026-10-18T00:00:01.000Z',
    ...overrides,
  };
}

const context = { to: 'lead', root: '/scratch/root', session: 'acme' };

describe('the record a send writes', () => {
  test('is one whole file at 0600, named by the id, carrying both ids and the admitting rule', () => {
    const s = scratch();
    try {
      const written = writeRecord(s.dropDir, signRecord(payload(), s.home));
      if (!written.ok) throw new Error(written.reason);
      expect(written.path).toBe(recordFile(s.dropDir, payload().id));
      expect(statSync(written.path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${written.path}.tmp`)).toBe(false);

      const read = readRecord(written.path, payload().id);
      if (!read.ok || read.record === null) throw new Error('the record did not read back');
      expect(read.record.payload).toEqual(payload());
      expect(read.record.payload.to_id).toBe('agent-lead');
      expect(read.record.payload.rule).toBe('the owner writes to any seat');
      expect(verifyRecord(read.record, messageKeyOf(s.home))).toBe(true);
    } finally {
      s.done();
    }
  });

  test('a reply carries the id it answers and its thread', () => {
    const one = payload({ id: 'reply-1', in_reply_to: payload().id, thread: payload().id });
    expect(recordPayloadOf(one)).toEqual(one);
    const stored = recordPayloadOf(JSON.parse(JSON.stringify(one)));
    expect(stored?.in_reply_to).toBe(payload().id);
    expect(stored?.thread).toBe(payload().id);
  });

  test('a payload without the admitting rule or the thread is not one this version wrote', () => {
    const noRule = { ...payload() } as Record<string, unknown>;
    delete noRule.rule;
    const noThread = { ...payload() } as Record<string, unknown>;
    delete noThread.thread;
    expect(recordPayloadOf(noRule)).toBeNull();
    expect(recordPayloadOf(noThread)).toBeNull();
  });

  test('a record rewritten after signing no longer verifies', () => {
    const s = scratch();
    try {
      const signed = signRecord(payload(), s.home);
      const written = writeRecord(s.dropDir, signed);
      if (!written.ok) throw new Error(written.reason);
      const held = JSON.parse(readFileSync(written.path, 'utf8')) as { payload: RecordPayload; signature: string };
      held.payload.body = 'from the owner\n\nsomething else';
      writeFileSync(written.path, `${JSON.stringify(held, null, 2)}\n`);

      const read = readRecord(written.path, payload().id);
      if (!read.ok || read.record === null) throw new Error('the rewritten record did not parse');
      expect(verifyRecord(read.record, messageKeyOf(s.home))).toBe(false);
    } finally {
      s.done();
    }
  });

  test('a signature from another checkout does not verify', () => {
    const one = scratch();
    const other = scratch();
    try {
      const signed = signRecord(payload(), other.home);
      expect(verifyRecord(signed, messageKeyOf(one.home))).toBe(false);
      expect(verifyRecord(signed, messageKeyOf(other.home))).toBe(true);
    } finally {
      one.done();
      other.done();
    }
  });

  test('a second record of one id is dropped, and the first stays as written', () => {
    const s = scratch();
    try {
      const first = writeRecord(s.dropDir, signRecord(payload(), s.home));
      if (!first.ok) throw new Error(first.reason);
      const before = readFileSync(first.path, 'utf8');

      const second = writeRecord(s.dropDir, signRecord(payload({ body: 'a different body' }), s.home));
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe('a record already holds that id');
      expect(readFileSync(first.path, 'utf8')).toBe(before);
    } finally {
      s.done();
    }
  });

  test('a handoff re-write under the same id keeps the record already there', () => {
    const s = scratch();
    try {
      const first = ensureRecord(s.dropDir, signRecord(payload(), s.home));
      expect(first.ok ? first.existing : undefined).toBeUndefined();
      const second = ensureRecord(s.dropDir, signRecord(payload(), s.home));
      expect(second).toMatchObject({ ok: true, existing: true });
    } finally {
      s.done();
    }
  });

  test('a file that is not a record at the id’s name is refused, not read as one', () => {
    const s = scratch();
    const path = recordFile(s.dropDir, payload().id);
    writeFileSync(path, 'not json at all');
    try {
      expect(readRecord(path, payload().id)).toEqual({ ok: false, reason: 'the record is not JSON' });
      expect(ensureRecord(s.dropDir, signRecord(payload(), s.home))).toEqual({
        ok: false,
        reason: 'a file that is not a record already holds that id',
      });
    } finally {
      s.done();
    }
  });

  test('an id that cannot be a file name is refused', () => {
    for (const id of ['', '.', '..', 'a/b', 'a\\b', 'a\0b']) expect(recordNameOk(id)).toBe(false);
    expect(recordNameOk('c0ffee00-1111-4222-8333-444455556666')).toBe(true);
    const s = scratch();
    try {
      expect(writeRecord(s.dropDir, signRecord(payload({ id: 'a/b' }), s.home))).toEqual({
        ok: false,
        reason: 'the record id cannot be a file name',
      });
    } finally {
      s.done();
    }
  });

  test('a record file that is a symbolic link is not followed', () => {
    const s = scratch();
    try {
      writeFileSync(join(s.dropDir, 'elsewhere'), '{}');
      symlinkSync(join(s.dropDir, 'elsewhere'), recordFile(s.dropDir, payload().id));
      expect(readRecord(recordFile(s.dropDir, payload().id), payload().id)).toEqual({
        ok: false,
        reason: 'a symbolic link was found and not followed',
      });
    } finally {
      s.done();
    }
  });
});

describe('the status derived from the receipts beside a message', () => {
  test('no receipt is `sent`', () => {
    const s = scratch();
    try {
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(s.home))).toBe('sent');
    } finally {
      s.done();
    }
  });

  test('each receipt moves the status, and the highest verified one stands', () => {
    const s = scratch();
    try {
      const key = messageKeyOf(s.home);
      for (const status of RECEIPT_STATUSES) {
        const written = writeReceipt(s.dropDir, signReceiptPayload(receipt({ status }), s.home), s.home);
        if (!written.ok) throw new Error(written.reason);
        expect(statSync(written.path).mode & 0o777).toBe(0o600);
        expect(statusOf(s.dropDir, payload().id, context, key)).toBe(status);
      }
      // A late `held` does not move the status back.
      writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'held' }), s.home), s.home);
      expect(statusOf(s.dropDir, payload().id, context, key)).toBe('replied');
    } finally {
      s.done();
    }
  });

  test('the receipt file carries its status in its name', () => {
    const s = scratch();
    try {
      const written = writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'read' }), s.home), s.home);
      if (!written.ok) throw new Error(written.reason);
      expect(written.path).toBe(receiptFile(s.dropDir, payload().id, 'read'));
      expect(written.path.endsWith('.read.json')).toBe(true);
      const parsed = JSON.parse(readFileSync(written.path, 'utf8')) as { payload: ReceiptPayload; signature: string };
      expect(verifyReceipt({ payload: parsed.payload, signature: parsed.signature }, messageKeyOf(s.home))).toBe(true);
    } finally {
      s.done();
    }
  });

  test('a receipt for another message, seat, session or checkout does not count', () => {
    const s = scratch();
    try {
      const key = messageKeyOf(s.home);
      const wrongs: Partial<ReceiptPayload>[] = [
        { id: 'another-id' },
        { to: 'someone-else' },
        { session: 'another-session' },
        { root: '/scratch/other-root' },
      ];
      for (const wrong of wrongs) {
        writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'delivered', ...wrong }), s.home), s.home);
        expect(statusOf(s.dropDir, payload().id, context, key)).toBe('sent');
      }
    } finally {
      s.done();
    }
  });

  test('a receipt signed by another checkout does not count', () => {
    const s = scratch();
    const other = scratch();
    try {
      writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'delivered' }), other.home), other.home);
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(s.home))).toBe('sent');
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(other.home))).toBe('delivered');
    } finally {
      s.done();
      other.done();
    }
  });

  test('a receipt is write-once: the status already recorded is not rewritten', () => {
    const s = scratch();
    try {
      const first = writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'delivered' }), s.home), s.home);
      if (!first.ok) throw new Error(first.reason);
      const before = readFileSync(first.path, 'utf8');
      const second = writeReceipt(
        s.dropDir,
        signReceiptPayload(receipt({ status: 'delivered', at: '2026-10-18T09:00:00.000Z' }), s.home),
        s.home,
      );
      expect(second).toMatchObject({ ok: true, existing: true });
      expect(readFileSync(first.path, 'utf8')).toBe(before);
    } finally {
      s.done();
    }
  });

  test('a file at a receipt\'s name that does not verify is replaced; a signed one is never', () => {
    const s = scratch();
    try {
      const path = receiptFile(s.dropDir, payload().id, 'read');
      // A file that proves nothing — unsigned, unreadable — must not keep the status at `sent`
      // forever: the signed receipt replaces it.
      writeFileSync(path, 'not a receipt');
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(s.home))).toBe('sent');
      const written = writeReceipt(s.dropDir, signReceiptPayload(receipt({ status: 'read' }), s.home), s.home);
      if (!written.ok) throw new Error(written.reason);
      expect(written.path).toBe(path);
      expect('existing' in written).toBe(false);
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(s.home))).toBe('read');
      // The signed receipt now at the name is the read that happened first, and is not rewritten.
      const before = readFileSync(path, 'utf8');
      const second = writeReceipt(
        s.dropDir,
        signReceiptPayload(receipt({ status: 'read', at: '2026-10-18T09:30:00.000Z' }), s.home),
        s.home,
      );
      expect(second).toMatchObject({ ok: true, existing: true });
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      s.done();
    }
  });

  test('an unreadable receipt changes nothing', () => {
    const s = scratch();
    try {
      writeFileSync(receiptFile(s.dropDir, payload().id, 'read'), 'not a receipt');
      expect(statusOf(s.dropDir, payload().id, context, messageKeyOf(s.home))).toBe('sent');
      expect(signedRecordOf({ payload: payload(), signature: 'not-a-signature' })?.signature).toBe('not-a-signature');
    } finally {
      s.done();
    }
  });
});
