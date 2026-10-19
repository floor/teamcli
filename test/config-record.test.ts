import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  CONFIG_DOMAIN,
  configSignaturePayload,
  signConfigRecord,
  verifyConfigRecord,
  type ConfigRecordInput,
  type SignedConfigRecord,
} from '../src/config/record.ts';
import type { DeliveryLeg } from '../src/settings/inherit.ts';
import { POLICY_DOMAIN } from '../src/policy/index.ts';
import { signDomain } from '../src/store/keys.ts';

/** The owner's key as `keyOf` hands it out: the private half, from which verification derives
 *  the public half. */
function ownerKey(): KeyObject {
  return generateKeyPairSync('ed25519').privateKey;
}

const ENTRY: ConfigRecordInput = {
  key: 'delivery_order',
  value: ['mcp-inbox', 'typed'],
  level: 'seat',
  target: 'builder-2',
  setter: 'owner',
  date: '2026-10-19T00:00:00Z',
  generation: 3,
};

describe('signing a settings record', () => {
  test('a record verifies with the key that signed it', () => {
    const key = ownerKey();
    const record = signConfigRecord(ENTRY, key);
    expect(record.signature).toMatch(/^[0-9a-f]+$/);
    expect(verifyConfigRecord(record, key)).toBe(true);
  });

  test('the payload carries every signed field, and the order as its legs', () => {
    expect(configSignaturePayload(ENTRY)).toEqual({
      key: 'delivery_order',
      value: ['mcp-inbox', 'typed'],
      level: 'seat',
      target: 'builder-2',
      setter: 'owner',
      date: '2026-10-19T00:00:00Z',
      generation: 3,
    });
  });

  test('a boolean value signs as itself', () => {
    const key = ownerKey();
    const record = signConfigRecord({ ...ENTRY, key: 'human', value: true }, key);
    expect(verifyConfigRecord(record, key)).toBe(true);
  });

  test('the array in the payload is a copy: changing the caller\'s array changes no payload already built', () => {
    const value: DeliveryLeg[] = ['mcp-inbox', 'typed'];
    const payload = configSignaturePayload({ ...ENTRY, value });
    value.push('drop');
    expect(payload).toEqual({
      key: 'delivery_order',
      value: ['mcp-inbox', 'typed'],
      level: 'seat',
      target: 'builder-2',
      setter: 'owner',
      date: '2026-10-19T00:00:00Z',
      generation: 3,
    });
  });
});

describe('a record that changed after signing', () => {
  const key = ownerKey();
  const signed = signConfigRecord(ENTRY, key);

  const tampered: [string, SignedConfigRecord][] = [
    ['the value', { ...signed, value: ['mcp-inbox', 'drop', 'typed'] }],
    ['the key', { ...signed, key: 'model', value: 'claude-opus-5-5' }],
    ['the level', { ...signed, level: 'team' }],
    ['the target', { ...signed, target: 'tester-1' }],
    ['the setter', { ...signed, setter: 'someone-else' }],
    ['the date', { ...signed, date: '2026-10-20T00:00:00Z' }],
    ['the generation', { ...signed, generation: 4 }],
    ['the signature', { ...signed, signature: signed.signature.replace(/^./, (c) => (c === '0' ? '1' : '0')) }],
  ];

  for (const [what, record] of tampered) {
    test(`refuses a record whose ${what} changed`, () => {
      expect(verifyConfigRecord(record, key)).toBe(false);
    });
  }

  test('refuses another key', () => {
    expect(verifyConfigRecord(signed, ownerKey())).toBe(false);
  });

  test('refuses a signature made under the policy domain', () => {
    const underPolicy = signDomain(POLICY_DOMAIN, configSignaturePayload(ENTRY), key);
    expect(verifyConfigRecord({ ...signed, signature: underPolicy }, key)).toBe(false);
  });

  test('refuses a signature that is not hex', () => {
    expect(verifyConfigRecord({ ...signed, signature: 'not-a-signature' }, key)).toBe(false);
  });

  test('refuses a corrupt disk value with false, never a throw', () => {
    // The record is read from a file a user can edit: a value that is not one of the record's
    // shapes is a false like any other mismatch, and the reader must not crash on it.
    for (const value of [null, 123, {}, 0]) {
      expect(verifyConfigRecord({ ...signed, value: value as never }, key)).toBe(false);
    }
  });
});

describe('the domain', () => {
  test('is its own tag, not the policy tag', () => {
    expect(CONFIG_DOMAIN).toBe('team-config-v1\n');
    expect(CONFIG_DOMAIN).not.toBe(POLICY_DOMAIN);
  });
});
