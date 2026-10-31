// Independent receiver safety cases. Every key, message and receipt belongs to a synthetic
// temporary home; no live inbox, signing material or process state is used.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage, receiptPath, type InboxTarget } from '../src/mcp/inbox.ts';
import {
  isRead,
  signReceiptPayload,
  signedReceiptOf,
  verifyReceipt,
  type ReceiptPayload,
  type RecordPayload,
  type SignedReceipt,
} from '../src/send/record.ts';
import { messageKeyOf, MESSAGE_DOMAIN, RECEIPT_DOMAIN, signDomain, verifyDomain, type Json } from '../src/store/keys.ts';
import { version } from '../src/version.ts';

const ID = '7e845e08-8fe7-49f0-8ae2-c01c59496110';
const BODY = 'Synthetic message body for the independent schema matrix.';
const SESSION = 'acme';
const EPOCH = 'run_123456abcdef';
// The earlier signer accepts the first two arguments and ignores options. Keeping the same
// fixture callable on that committed base makes the missing provenance a reproducible red.
const receiptSigner: (payload: ReceiptPayload, home: string, options?: { epoch?: string }) => SignedReceipt = signReceiptPayload;
const made: string[] = [];

afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scene() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-schema-independent-')));
  made.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  const otherHome = join(base, 'other-home');
  const dropDir = join(root, '.agents', 'send-drops', SESSION, 'lead');
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(otherHome, { mode: 0o700 });
  const key = messageKeyOf(home);
  const target: InboxTarget = { root, dropDir, seat: 'lead', session: SESSION };
  const payload: RecordPayload = {
    kind: 'message', id: ID, to: 'lead', to_id: null, root, session: SESSION,
    at: '2026-10-23T08:00:00.000Z', body: BODY, from: 'worker', from_id: null,
    rule: 'a synthetic worker to its declared lead', thread: ID,
  };
  const path = join(dropDir, ID);
  const receipt = receiptPath(dropDir, ID);
  const put = (value: object, signer = key) => {
    const record = {
      payload: value,
      signature: signDomain(MESSAGE_DOMAIN, value as Json, signer),
    };
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
    return record;
  };
  const read = () => readMessage(target, ID, home);
  const parsedReceipt = () => {
    const value = signedReceiptOf(JSON.parse(readFileSync(receipt, 'utf8')));
    if (value === null) throw new Error('synthetic receipt did not parse');
    return value;
  };
  return { base, root, home, otherHome, dropDir, key, target, payload, path, receipt, put, read, parsedReceipt };
}

function refusedWithoutReceipt(at: ReturnType<typeof scene>, rule: string) {
  const got = at.read();
  expect(existsSync(at.receipt)).toBe(false);
  expect(got.ok).toBe(false);
  if (got.ok) throw new Error('an unauthenticated synthetic record exposed its body');
  expect(String(got.refusal?.rule)).toBe(rule);
  expect(JSON.stringify(got)).not.toContain(BODY);
  return got;
}

function legacyReceipt(at: ReturnType<typeof scene>) {
  // Sign the legacy payload directly: using the current receipt signer would add provenance.
  const payload = {
    kind: 'receipt', status: 'read', id: ID, to: 'lead', root: at.root, session: SESSION,
    at: '2026-10-23T08:01:00.000Z',
  };
  const signature = signDomain(RECEIPT_DOMAIN, payload, at.key);
  writeFileSync(at.receipt, JSON.stringify({ payload, signature }), { mode: 0o600 });
  return readFileSync(at.receipt, 'utf8');
}

describe('independent signed message schema matrix', () => {
  for (const subject of [undefined, 'Synthetic subject']) {
    test(`a complete signed ${subject === undefined ? 'older' : 'subject-bearing'} payload is read once`, () => {
      const at = scene();
      const payload = { ...at.payload, ...(subject === undefined ? {} : { subject }) };
      const signed = at.put(payload);
      expect(verifyDomain(MESSAGE_DOMAIN, payload, signed.signature, at.key)).toBe(true);
      expect(at.read()).toEqual({ ok: true, body: BODY });
      expect(verifyReceipt(at.parsedReceipt(), at.key)).toBe(true);
      const before = readFileSync(at.receipt, 'utf8');
      expect(at.read()).toMatchObject({ ok: false, served: 'already-served' });
      expect(readFileSync(at.receipt, 'utf8')).toBe(before);
    });
  }

  for (const field of ['body', 'subject'] as const) {
    test(`changing a signed ${field} refuses the body and publishes no receipt`, () => {
      const at = scene();
      const signed = at.put({ ...at.payload, subject: 'Synthetic subject' });
      const altered = { ...signed, payload: { ...signed.payload, [field]: 'Synthetic altered value' } };
      writeFileSync(at.path, JSON.stringify(altered));
      refusedWithoutReceipt(at, 'signature');
    });
  }

  for (const operation of ['insertion', 'modification', 'removal'] as const) {
    for (const existingReceipt of [false, true]) {
      test(`unsigned future field ${operation} is refused with ${existingReceipt ? 'an existing receipt preserved' : 'no receipt published'}`, () => {
        const at = scene();
        const value: Record<string, Json> = { ...at.payload };
        if (operation !== 'insertion') value.future_authority = { allow: false };
        const signed = at.put(value);
        const altered: Record<string, Json> = { ...value };
        if (operation === 'removal') delete altered.future_authority;
        else altered.future_authority = { allow: true, act: 'synthetic-admin' };
        expect(verifyDomain(MESSAGE_DOMAIN, altered, signed.signature, at.key)).toBe(false);
        writeFileSync(at.path, JSON.stringify({ ...signed, payload: altered }));
        if (existingReceipt) {
          const before = legacyReceipt(at);
          const got = at.read();
          expect(readFileSync(at.receipt, 'utf8')).toBe(before);
          expect(got.ok).toBe(false);
          if (got.ok) throw new Error('tampered synthetic message exposed its body');
          expect(got.refusal?.rule).toBe('signature');
          expect(got.served).toBeUndefined();
          expect(JSON.stringify(got)).not.toContain(BODY);
        } else refusedWithoutReceipt(at, 'signature');
      });
    }
  }

  for (const field of ['future_display', 'future_authority']) {
    test(`a signed ${field} authenticates but is explicitly unsupported`, () => {
      const at = scene();
      const payload = { ...at.payload, [field]: { allow: true, label: 'synthetic extension' } };
      const signed = at.put(payload);
      expect(verifyDomain(MESSAGE_DOMAIN, payload, signed.signature, at.key)).toBe(true);
      const got = refusedWithoutReceipt(at, 'unsupported');
      expect(got.reason).toContain(field);
    });
  }

  test('a signed invalid known field is unsupported after authentication', () => {
    const at = scene();
    const payload = { ...at.payload, subject: { unsupported: 'synthetic subject object' } };
    const signed = at.put(payload);
    expect(verifyDomain(MESSAGE_DOMAIN, payload, signed.signature, at.key)).toBe(true);
    refusedWithoutReceipt(at, 'unsupported');
  });

  test('a malformed known field under the wrong key is refused at authentication first', () => {
    const at = scene();
    at.put({ ...at.payload, subject: { unsupported: true } }, messageKeyOf(at.otherHome));
    refusedWithoutReceipt(at, 'signature');
  });

  test('signed client authority with an extra scope is unsupported', () => {
    const at = scene();
    const payload = {
      ...at.payload, from: 'client:synthetic-client',
      from_client: { client_id: 'synthetic-client', grant_id: 'synthetic-grant', scope: 'synthetic-admin' },
    };
    const signed = at.put(payload);
    expect(verifyDomain(MESSAGE_DOMAIN, payload, signed.signature, at.key)).toBe(true);
    refusedWithoutReceipt(at, 'unsupported');
  });

  test('an unrecognized field under the wrong key is an authentication refusal', () => {
    const at = scene();
    const otherKey = messageKeyOf(at.otherHome);
    at.put({ ...at.payload, future_authority: { allow: true } }, otherKey);
    refusedWithoutReceipt(at, 'signature');
  });

  test('an extra unsigned envelope key is a shape refusal', () => {
    const at = scene();
    const signed = at.put(at.payload);
    writeFileSync(at.path, JSON.stringify({ ...signed, unsigned_authority: { allow: true } }));
    refusedWithoutReceipt(at, 'shape');
  });

  test('a valid legacy receipt still suppresses a body without reader provenance', () => {
    const at = scene();
    at.put({ ...at.payload, subject: 'Synthetic subject' });
    const before = legacyReceipt(at);
    expect(verifyReceipt(at.parsedReceipt(), at.key)).toBe(true);
    expect(isRead(at.dropDir, ID, { root: at.root, session: SESSION, to: 'lead' }, at.key)).toBe(true);
    expect(at.read()).toMatchObject({ ok: false, served: 'already-served' });
    expect(readFileSync(at.receipt, 'utf8')).toBe(before);
  });

  test('the reader signs its version, process id and supplied runtime epoch into the receipt', () => {
    const at = scene();
    at.put(at.payload);
    expect(readMessage(at.target, ID, at.home, { claim: () => null, epoch: EPOCH })).toEqual({ ok: true, body: BODY });
    const raw = JSON.parse(readFileSync(at.receipt, 'utf8'));
    expect(raw.payload.writer).toEqual({ version: version(), pid: process.pid, epoch: EPOCH });
    expect(verifyReceipt(at.parsedReceipt(), at.key)).toBe(true);
  });

  test('a reader with no runtime epoch does not invent one', () => {
    const at = scene();
    at.put(at.payload);
    expect(at.read()).toEqual({ ok: true, body: BODY });
    const raw = JSON.parse(readFileSync(at.receipt, 'utf8'));
    expect(raw.payload.writer).toEqual({ version: version(), pid: process.pid });
  });

  test('the receipt signer overwrites caller-supplied writer provenance', () => {
    const at = scene();
    const payload = {
      kind: 'receipt' as const, status: 'read' as const, id: ID, to: 'lead', root: at.root, session: SESSION,
      at: '2026-10-23T08:01:00.000Z',
      writer: { version: 'synthetic-forged-writer', pid: 1, epoch: 'run_000000000000' },
    };
    const signed = receiptSigner(payload, at.home, { epoch: EPOCH });
    const raw = JSON.parse(JSON.stringify(signed));
    expect(raw.payload.writer).toEqual({ version: version(), pid: process.pid, epoch: EPOCH });
    expect(verifyReceipt(signed, at.key)).toBe(true);
  });

  for (const authenticated of [false, true]) {
    test(`${authenticated ? 'signed unsupported' : 'unsigned inserted'} receipt authority never counts or gets overwritten`, () => {
      const at = scene();
      at.put(at.payload);
      const payload = {
        kind: 'receipt', status: 'read', id: ID, to: 'lead', root: at.root, session: SESSION,
        at: '2026-10-23T08:01:00.000Z',
      };
      const extended = { ...payload, future_authority: { allow: true } };
      const raw = { payload: extended, signature: signDomain(RECEIPT_DOMAIN, authenticated ? extended : payload, at.key) };
      expect(verifyDomain(RECEIPT_DOMAIN, raw.payload, raw.signature, at.key)).toBe(authenticated);
      writeFileSync(at.receipt, JSON.stringify(raw));
      const before = readFileSync(at.receipt, 'utf8');
      const parsed = signedReceiptOf(raw);
      expect(parsed !== null && verifyReceipt(parsed, at.key)).toBe(false);
      expect(isRead(at.dropDir, ID, { root: at.root, session: SESSION, to: 'lead' }, at.key)).toBe(false);
      const got = at.read();
      expect(got.ok).toBe(false);
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(readFileSync(at.receipt, 'utf8')).toBe(before);
    });
  }

  for (const field of ['version', 'pid', 'epoch']) {
    test(`receipt writer ${field} is authenticated and tampering cannot count as a read`, () => {
      const at = scene();
      at.put(at.payload);
      const payload: ReceiptPayload = {
        kind: 'receipt', status: 'read', id: ID, to: 'lead', root: at.root, session: SESSION,
        at: '2026-10-23T08:01:00.000Z',
      };
      const signed = receiptSigner(payload, at.home, { epoch: EPOCH });
      const raw = JSON.parse(JSON.stringify(signed));
      expect(raw.payload.writer).toEqual({ version: version(), pid: process.pid, epoch: EPOCH });
      raw.payload.writer[field] = field === 'pid' ? process.pid + 1 : 'synthetic-tamper';
      writeFileSync(at.receipt, JSON.stringify(raw), { mode: 0o600 });
      const before = readFileSync(at.receipt, 'utf8');
      const parsed = signedReceiptOf(raw);
      expect(parsed !== null && verifyReceipt(parsed, at.key)).toBe(false);
      expect(isRead(at.dropDir, ID, { root: at.root, session: SESSION, to: 'lead' }, at.key)).toBe(false);
      const got = at.read();
      expect(got.ok).toBe(false);
      expect(JSON.stringify(got)).not.toContain(BODY);
      expect(readFileSync(at.receipt, 'utf8')).toBe(before);
    });
  }
});
