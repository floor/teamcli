// Pure synthetic signatures complement the filesystem read-gate matrix. The key pair exists
// only in memory; these cases never use a key store, inbox or receipt writer.
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  closeAuthOf,
  receiptAuthOf,
  sealedCloseOf,
  sealedReceiptOf,
  signedCloseOf,
  verifyClose,
  verifySealedClose,
  verifySealedReceipt,
} from '../src/send/record.ts';
import { RECEIPT_DOMAIN, signDomain, type Json } from '../src/store/keys.ts';

const ID = '047ee1b9-eefb-4687-89a5-5191b7c6f210';
const EPOCH = 'run_123456abcdef';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const wrongKey = generateKeyPairSync('ed25519').publicKey;
const close = {
  kind: 'thread-close', id: ID, thread: ID, by: 'lead', root: '/synthetic/project',
  session: 'acme', at: '2026-10-23T08:00:00.000Z',
};
const receipt = {
  kind: 'receipt', status: 'read', id: ID, to: 'lead', root: '/synthetic/project',
  session: 'acme', at: '2026-10-23T08:01:00.000Z',
};

function seal(payload: Record<string, Json>) {
  return { payload, signature: signDomain(RECEIPT_DOMAIN, payload, privateKey) };
}

describe('independent complete-payload close authentication', () => {
  test('a legacy close with its signed author remains supported', () => {
    const signed = seal(close);
    const auth = closeAuthOf(signed, publicKey);
    expect(auth.kind).toBe('ok');
    if (auth.kind !== 'ok') throw new Error('synthetic legacy close was refused');
    expect(auth.value.payload.by).toBe('lead');
    expect(verifyClose(auth.value, publicKey)).toBe(true);
  });

  for (const field of ['future_authority', 'writer']) {
    test(`a signed close ${field} authenticates but cannot be acted on`, () => {
      const signed = seal({ ...close, [field]: { version: 'synthetic-reader', pid: 123, epoch: EPOCH } });
      const raw = sealedCloseOf(signed);
      expect(raw).not.toBeNull();
      if (raw === null) throw new Error('synthetic close envelope was lost');
      expect(verifySealedClose(raw, publicKey)).toBe(true);
      const auth = closeAuthOf(signed, publicKey);
      expect(auth.kind).toBe('unsupported');
      if (auth.kind === 'unsupported') expect(auth.reason).toContain(field);
      const projected = signedCloseOf(signed);
      expect(projected).not.toBeNull();
      if (projected === null) throw new Error('synthetic close projection was lost');
      expect(verifyClose(projected, publicKey)).toBe(false);
    });
  }

  for (const operation of ['insertion', 'modification', 'removal']) {
    test(`unsigned close field ${operation} is tampering before schema interpretation`, () => {
      const payload: Record<string, Json> = { ...close };
      if (operation !== 'insertion') payload.future_authority = { allow: false };
      const signed = seal(payload);
      const altered = { ...payload };
      if (operation === 'removal') delete altered.future_authority;
      else altered.future_authority = { allow: true };
      expect(closeAuthOf({ ...signed, payload: altered }, publicKey).kind).toBe('tampered');
    });
  }

  test('the closing author cannot be changed after signing', () => {
    const signed = seal(close);
    expect(closeAuthOf({ ...signed, payload: { ...close, by: 'worker' } }, publicKey).kind).toBe('tampered');
  });

  test('wrong-key signed unsupported close fields still fail authentication first', () => {
    expect(closeAuthOf(seal({ ...close, future_authority: { allow: true } }), wrongKey).kind).toBe('tampered');
  });

  test('an unsigned envelope extension is a shape refusal', () => {
    expect(closeAuthOf({ ...seal(close), unsigned_authority: true }, publicKey).kind).toBe('shape');
  });
});

describe('independent receipt provenance schema compatibility', () => {
  test('a legacy receipt without process provenance remains authenticated and supported', () => {
    expect(receiptAuthOf(seal(receipt), publicKey).kind).toBe('ok');
  });

  test('signed version, process id and runtime epoch remain supported', () => {
    const signed = seal({ ...receipt, writer: { version: 'synthetic-reader-1', pid: 123, epoch: EPOCH } });
    const auth = receiptAuthOf(signed, publicKey);
    expect(auth.kind).toBe('ok');
    if (auth.kind !== 'ok') throw new Error('synthetic receipt writer was refused');
    expect(auth.value.payload.writer).toEqual({ version: 'synthetic-reader-1', pid: 123, epoch: EPOCH });
  });

  const unsupportedWriters: Record<string, Json>[] = [
    { version: '', pid: 123 },
    { version: 'synthetic-reader-1', pid: 0 },
    { version: 'synthetic-reader-1', pid: -1 },
    { version: 'synthetic-reader-1', pid: '123' },
    { version: 'synthetic-reader-1', pid: 123, epoch: 'synthetic-invalid-epoch' },
    { version: 'synthetic-reader-1', pid: 123, epoch: EPOCH, authority: 'synthetic-admin' },
  ];
  for (const [index, writer] of unsupportedWriters.entries()) {
    test(`authenticated unsupported writer schema ${index + 1} is distinct from tampering`, () => {
      const signed = seal({ ...receipt, writer });
      const raw = sealedReceiptOf(signed);
      expect(raw).not.toBeNull();
      if (raw === null) throw new Error('synthetic receipt envelope was lost');
      expect(verifySealedReceipt(raw, publicKey)).toBe(true);
      expect(receiptAuthOf(signed, publicKey).kind).toBe('unsupported');
      expect(receiptAuthOf(signed, wrongKey).kind).toBe('tampered');
    });
  }
});
