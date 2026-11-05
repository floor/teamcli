// Message-schema authentication: the signature covers the complete raw payload exactly as it was
// parsed, before any field is projected or read.
//
// The defect this file proves fixed: a fixed-field reconstruction was verified instead of the
// bytes on disk, so a field inserted after signing was dropped before the check and a record with
// an injected `future_authority` was served (`readMessage` returned its body and wrote a read
// receipt), while a record carrying a legitimate future field could never verify at all.
//
// Every refusal here is counted, never inferred: the read's body is checked absent, the receipt
// name is checked absent, and the folder's entry count is checked unchanged.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage, receiptPath } from '../src/mcp/inbox.ts';
import { publishRecordRead } from '../src/send/read-receipt.ts';
import {
  closeFile,
  receiptAuthOf,
  receiptFile,
  recordAuthOf,
  sealedRecordOf,
  signClose,
  signReceiptPayload,
  signRecord,
  statusOf,
  verifyClose,
  verifyReceipt,
  verifyRecord,
  writeReceipt,
  type ClosePayload,
  type ReceiptPayload,
} from '../src/send/record.ts';
import { MESSAGE_DOMAIN, messageKeyOf, RECEIPT_DOMAIN, signDomain, type Json } from '../src/store/keys.ts';

const SESSION = 'acme';
const SEAT = 'lead';
const ID = '4f0b8d82-7a8e-4da2-9e6f-9b5aac2d3e45';
const BODY = 'the body only the signed record may expose';
const AT = '2026-10-23T09:00:00.000Z';

type Place = { base: string; root: string; home: string; dropDir: string; cleanup(): void };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-schema-auth-')));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  const dropDir = join(root, '.agents', 'send-drops', SESSION, SEAT);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  return { base, root, home, dropDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** The record a send writes, before any extra field is added. */
function recordPayload(at: Place, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'message',
    id: ID,
    to: SEAT,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: AT,
    body: BODY,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: ID,
    ...extra,
  };
}

/** The envelope as a writer with any payload would sign it: the test's stand-in for a future or
 *  earlier build, signing the domain this build has always signed. */
function envelope(domain: string, payload: Record<string, unknown>, home: string): { payload: Record<string, unknown>; signature: string } {
  return { payload, signature: signDomain(domain, payload as unknown as Json, messageKeyOf(home)) };
}

function writeRecordFile(at: Place, value: unknown, name = ID): string {
  const path = join(at.dropDir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function refuse(at: Place): { ok: false; rule: string | undefined; reason: string; wrote: boolean; entries: number } {
  const before = readdirSync(at.dropDir).length;
  const got = readMessage({ dropDir: at.dropDir, root: at.root, seat: SEAT, session: SESSION }, ID, at.home);
  const entries = readdirSync(at.dropDir).length;
  if (got.ok) throw new Error('the read served a body it must not have shown');
  return { ok: false, rule: got.refusal?.rule, reason: got.reason, wrote: existsSync(receiptPath(at.dropDir, ID)), entries: entries - before };
}

describe('a record authenticates over its complete raw payload', () => {
  test('a signed record verifies with the subject absent, and a record carrying the subject verifies too', () => {
    const at = place();
    try {
      const key = messageKeyOf(at.home);
      const without = signRecord(recordPayload(at) as never, at.home);
      const withSubject = signRecord(recordPayload(at, { subject: 'the schema lane' }) as never, at.home);
      expect(verifyRecord(without, key)).toBe(true);
      expect(verifyRecord(withSubject, key)).toBe(true);
      // The subject is optional and signed with the rest: neither form is refused.
      expect(recordAuthOf(JSON.parse(JSON.stringify(without)), key).kind).toBe('ok');
      expect(recordAuthOf(JSON.parse(JSON.stringify(withSubject)), key).kind).toBe('ok');
    } finally {
      at.cleanup();
    }
  });

  test('a field inserted after signing is tampered: no body, no receipt, nothing written', () => {
    const at = place();
    try {
      const signed = signRecord(recordPayload(at) as never, at.home);
      const held = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      // The injection operator-1 proved: an unsigned authority field, added after the signature.
      held.payload.future_authority = { grant: 'anything' };
      writeRecordFile(at, held);
      expect(sealedRecordOf(held)).not.toBeNull();
      expect(recordAuthOf(held, messageKeyOf(at.home)).kind).toBe('tampered');
      expect(verifyRecord(signedRecordOfHeld(held), messageKeyOf(at.home))).toBe(false);
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'signature', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('a field altered after signing is tampered, whatever the fields now claim', () => {
    const at = place();
    try {
      const signed = signRecord(recordPayload(at) as never, at.home);
      const held = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      held.payload.body = 'something else';
      held.payload.to = 'someone-else';
      writeRecordFile(at, held);
      expect(recordAuthOf(held, messageKeyOf(at.home)).kind).toBe('tampered');
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'signature', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('a field removed after signing is tampered: the signature no longer covers the payload', () => {
    const at = place();
    try {
      const signed = signRecord(recordPayload(at, { subject: 'signed with the rest' }) as never, at.home);
      const held = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      delete held.payload.subject;
      writeRecordFile(at, held);
      expect(recordAuthOf(held, messageKeyOf(at.home)).kind).toBe('tampered');
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'signature', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('an envelope with a key beside payload and signature is a shape refusal', () => {
    const at = place();
    try {
      const signed = signRecord(recordPayload(at) as never, at.home);
      writeRecordFile(at, { ...JSON.parse(JSON.stringify(signed)), note: 'outside the signature' });
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'shape', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });
});

describe('a signed field this version does not read is refused on its own ground', () => {
  test('a signed future field authenticates and is refused as unsupported, never as a signature failure', () => {
    const at = place();
    try {
      const future = envelope(MESSAGE_DOMAIN, recordPayload(at, { future_display: { colour: 'amber' } }), at.home);
      writeRecordFile(at, future);
      const auth = recordAuthOf(future, messageKeyOf(at.home));
      expect(auth.kind).toBe('unsupported');
      expect(auth.kind === 'unsupported' ? auth.reason : '').toContain('future_display');
      expect(verifyRecord(signedRecordOfHeld(future), messageKeyOf(at.home))).toBe(false);
      const got = refuse(at);
      expect(got).toMatchObject({ ok: false, rule: 'unsupported', wrote: false, entries: 0 });
      expect(got.reason).toContain('future_display');
      expect(got.reason).not.toContain('does not verify against this message key');
    } finally {
      at.cleanup();
    }
  });

  test('a signed authority-bearing field is authenticated and then refused, never interpreted', () => {
    const at = place();
    try {
      const future = envelope(MESSAGE_DOMAIN, recordPayload(at, { future_authority: { mayDelegate: true } }), at.home);
      writeRecordFile(at, future);
      expect(recordAuthOf(future, messageKeyOf(at.home)).kind).toBe('unsupported');
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'unsupported', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('an unsigned insertion on top of signed unknown fields is tampered, not unsupported', () => {
    const at = place();
    try {
      const future = envelope(MESSAGE_DOMAIN, recordPayload(at, { future_display: 'signed' }), at.home);
      future.payload.future_authority = { unsigned: true };
      writeRecordFile(at, future);
      // Authentication decides first: the injected field breaks the signature over the raw
      // payload, so the unknown-field question never arises.
      expect(recordAuthOf(future, messageKeyOf(at.home)).kind).toBe('tampered');
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'signature', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });

  test('a signed record with a known field outside this version schema is unsupported, not shape', () => {
    const at = place();
    try {
      const bad = envelope(MESSAGE_DOMAIN, recordPayload(at, { at: 'not a date' }), at.home);
      writeRecordFile(at, bad);
      expect(recordAuthOf(bad, messageKeyOf(at.home)).kind).toBe('unsupported');
      expect(refuse(at)).toMatchObject({ ok: false, rule: 'unsupported', wrote: false, entries: 0 });
    } finally {
      at.cleanup();
    }
  });
});

describe('a known field with a value this version does not know', () => {
  test('a message kind this version does not know is served as a plain message, never refused', () => {
    const at = place();
    try {
      const key = messageKeyOf(at.home);
      // A writer this version does not know signs a kind value it does know how to write, and a
      // work item this version does read. The field is known; only the value is ahead of us.
      const future = envelope(MESSAGE_DOMAIN, recordPayload(at, { message_kind: 'future-kind', work: '#9001' }), at.home);
      writeRecordFile(at, future);
      const auth = recordAuthOf(future, key);
      expect(auth.kind).toBe('ok');
      if (auth.kind !== 'ok') return;
      // The value is not interpreted: the kind is dropped, so the record reads as the ordinary
      // message it cannot be shown to be anything else than.
      expect(auth.value.payload.message_kind).toBeUndefined();
      expect(auth.value.payload.work).toBe('#9001');
      // The inbox serves it, body and all, where an unsupported verdict refused it whole.
      const got = readMessage({ dropDir: at.dropDir, root: at.root, seat: SEAT, session: SESSION }, ID, at.home);
      expect(got).toEqual({ ok: true, body: BODY });
      // A signed FIELD this version does not read is still refused on its own ground: the
      // forward-compatible reading is for a known field's unknown value, not for an unknown field.
      const unknownField = envelope(MESSAGE_DOMAIN, recordPayload(at, { future_display: 'amber' }), at.home);
      expect(recordAuthOf(unknownField, key).kind).toBe('unsupported');
    } finally {
      at.cleanup();
    }
  });
});

describe('receipts and closes: the same order, and signed writer provenance', () => {
  function receipt(extra: Record<string, unknown> = {}): ReceiptPayload {
    return {
      kind: 'receipt',
      status: 'read',
      id: ID,
      to: SEAT,
      root: '/tmp/somewhere',
      session: SESSION,
      at: AT,
      ...extra,
    } as ReceiptPayload;
  }

  test('a legacy receipt with no writer verifies and counts toward the status', () => {
    const at = place();
    try {
      const legacy = envelope(RECEIPT_DOMAIN, receipt() as unknown as Record<string, unknown>, at.home);
      expect(receiptAuthOf(legacy, messageKeyOf(at.home)).kind).toBe('ok');
      expect(verifyReceipt(legacy as never, messageKeyOf(at.home))).toBe(true);
      writeFileSync(receiptFile(at.dropDir, ID, 'read'), `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
      expect(statusOf(at.dropDir, ID, { to: SEAT, root: '/tmp/somewhere', session: SESSION }, messageKeyOf(at.home))).toBe('read');
    } finally {
      at.cleanup();
    }
  });

  test('a signed receipt names its writer, and the signer replaces a caller-supplied one', () => {
    const at = place();
    try {
      const signed = signReceiptPayload(receipt({ writer: { version: 'spoofed', pid: 1 } }), at.home);
      const writer = signed.payload.writer;
      expect(writer?.version).not.toBe('spoofed');
      expect(writer?.pid).toBe(process.pid);
      expect(writer?.epoch).toBeUndefined();
      expect(verifyReceipt(signed, messageKeyOf(at.home))).toBe(true);
      // Written and read back, the provenance is the writer's, and the receipt counts.
      const written = writeReceipt(at.dropDir, signed, at.home);
      if (!written.ok) throw new Error(written.reason);
      expect(statusOf(at.dropDir, ID, { to: SEAT, root: '/tmp/somewhere', session: SESSION }, messageKeyOf(at.home))).toBe('read');
    } finally {
      at.cleanup();
    }
  });

  test('a runtime epoch rides in the writer when the process was started under one', () => {
    const at = place();
    try {
      const signed = signReceiptPayload(receipt(), at.home, { epoch: 'run_ab12cd34ef56' });
      expect(signed.payload.writer?.epoch).toBe('run_ab12cd34ef56');
      expect(verifyReceipt(signed, messageKeyOf(at.home))).toBe(true);
      // A string that is not a runtime epoch is refused where it is passed: the receipt names
      // the runtime its writer ran under, never a key's generation.
      expect(() => signReceiptPayload(receipt(), at.home, { epoch: 'generation-3' })).toThrow();
    } finally {
      at.cleanup();
    }
  });

  test('a read receipt published under a runtime epoch carries it in the signed writer', () => {
    const at = place();
    try {
      const outcome = publishRecordRead({
        dropDir: at.dropDir,
        id: ID,
        to: SEAT,
        root: '/tmp/somewhere',
        session: SESSION,
        home: at.home,
        key: messageKeyOf(at.home),
        at: AT,
        epoch: 'run_ab12cd34ef56',
      });
      expect(outcome.kind).toBe('published');
      const held = JSON.parse(readFileSync(receiptFile(at.dropDir, ID, 'read'), 'utf8')) as {
        payload: { writer?: { version: string; pid: number; epoch?: string } };
      };
      expect(held.payload.writer?.epoch).toBe('run_ab12cd34ef56');
      expect(held.payload.writer?.pid).toBe(process.pid);
      expect(verifyReceipt(held as never, messageKeyOf(at.home))).toBe(true);
    } finally {
      at.cleanup();
    }
  });

  test('a receipt whose writer was altered after signing is tampered and does not count', () => {
    const at = place();
    try {
      const signed = signReceiptPayload(receipt(), at.home);
      const held = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      held.payload.writer = { ...(held.payload.writer as Record<string, unknown>), version: 'another build' };
      writeFileSync(receiptFile(at.dropDir, ID, 'read'), `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
      expect(receiptAuthOf(held, messageKeyOf(at.home)).kind).toBe('tampered');
      expect(verifyReceipt(held as never, messageKeyOf(at.home))).toBe(false);
      expect(statusOf(at.dropDir, ID, { to: SEAT, root: '/tmp/somewhere', session: SESSION }, messageKeyOf(at.home))).toBe('sent');
    } finally {
      at.cleanup();
    }
  });

  test('a receipt carrying a signed field this version does not read is unsupported and does not count', () => {
    const at = place();
    try {
      const injected = envelope(RECEIPT_DOMAIN, { ...receipt(), future_grant: true }, at.home);
      expect(receiptAuthOf(injected, messageKeyOf(at.home)).kind).toBe('unsupported');
      expect(verifyReceipt(injected as never, messageKeyOf(at.home))).toBe(false);
      writeFileSync(receiptFile(at.dropDir, ID, 'read'), `${JSON.stringify(injected, null, 2)}\n`, { mode: 0o600 });
      expect(statusOf(at.dropDir, ID, { to: SEAT, root: '/tmp/somewhere', session: SESSION }, messageKeyOf(at.home))).toBe('sent');
    } finally {
      at.cleanup();
    }
  });

  test('an unsigned field inserted into a receipt is tampered and does not count', () => {
    const at = place();
    try {
      const signed = signReceiptPayload(receipt(), at.home);
      const held = JSON.parse(JSON.stringify(signed)) as { payload: Record<string, unknown>; signature: string };
      held.payload.read_by = 'nobody';
      expect(receiptAuthOf(held, messageKeyOf(at.home)).kind).toBe('tampered');
      writeFileSync(receiptFile(at.dropDir, ID, 'read'), `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
      expect(statusOf(at.dropDir, ID, { to: SEAT, root: '/tmp/somewhere', session: SESSION }, messageKeyOf(at.home))).toBe('sent');
    } finally {
      at.cleanup();
    }
  });

  test('a close verifies only over its raw payload, and a signed unknown field is unsupported', () => {
    const at = place();
    try {
      const close: ClosePayload = { kind: 'thread-close', id: ID, thread: ID, by: 'worker', root: '/tmp/somewhere', session: SESSION, at: AT };
      const signed = signClose(close, at.home);
      expect(verifyClose(JSON.parse(JSON.stringify(signed)) as never, messageKeyOf(at.home))).toBe(true);
      const future = envelope(RECEIPT_DOMAIN, { ...close, future_reason: 'merged' }, at.home);
      writeFileSync(closeFile(at.dropDir, ID), `${JSON.stringify(future, null, 2)}\n`, { mode: 0o600 });
      expect(verifyClose(future as never, messageKeyOf(at.home))).toBe(false);
    } finally {
      at.cleanup();
    }
  });
});

/** The projection a reader gets from a file: the raw payload is kept beside the projection. */
function signedRecordOfHeld(value: unknown): Parameters<typeof verifyRecord>[0] {
  const record = sealedRecordOf(value);
  if (record === null) throw new Error('the fixture is not a signed envelope');
  return {
    payload: record.payload as never,
    signature: record.signature,
    raw: record.payload,
    unknown: [],
  };
}
