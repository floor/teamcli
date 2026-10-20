// The signed record a settings change leaves. A setting is a value, and the value a seat holds is
// witnessed the way every owner choice is: one canonical payload — the key, the value, the level
// and target it was set for, the setter, the date and the key generation — signed under its own
// domain, so a settings record can never be read as a policy record or the other way round.
//
// These are the primitives only. Where a record is kept and how a chain of levels composes are
// the storage ruling's, in sources.ts: the registry's own records, inheritance by absence. How
// the team file's fields migrate into records is a decision this release has not taken; a reader
// that finds a record verifies it first and refuses a record that does not verify, and never
// reads half of one.

import type { KeyObject } from 'node:crypto';
import type { Json } from '../store/keys.ts';
import { signDomain, verifyDomain } from '../store/keys.ts';
import type { ConfigKey, ConfigLevel, ConfigValue } from './registry.ts';

/** Domain tag for signed settings records; distinct from `POLICY_DOMAIN` so a signature over one
 *  shape never verifies the other. */
export const CONFIG_DOMAIN = 'team-config-v1\n';

/** The fields a record signs. `target` is what the record sets — a seat's identity — and the
 *  generation is the owner key's, so a rotated key cannot revive a stale record. */
export type ConfigRecordInput = {
  key: ConfigKey;
  value: ConfigValue;
  level: ConfigLevel;
  target: string;
  setter: string;
  date: string;
  generation: number;
};

export type SignedConfigRecord = ConfigRecordInput & { signature: string };

/** A setting's value as JSON: an order as a fresh array, so the signed bytes never depend on the
 *  caller's array afterwards. */
function jsonValue(value: ConfigValue): Json {
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return [...value];
}

/** Whether a value read off disk is one this record can carry. The record comes from a file a
 *  user can edit: a null, a number or an object where a value belongs is a corrupt record, and
 *  the verifier answers false for it rather than throwing out of the reader. */
function isConfigValue(value: unknown): value is ConfigValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return Array.isArray(value) && value.every((one) => typeof one === 'string');
}

/** The canonical payload (the signer canonicalizes object keys itself). */
export function configSignaturePayload(entry: ConfigRecordInput): Json {
  return {
    key: entry.key,
    value: jsonValue(entry.value),
    level: entry.level,
    target: entry.target,
    setter: entry.setter,
    date: entry.date,
    generation: entry.generation,
  };
}

/** Sign one record with the owner's key. */
export function signConfigRecord(entry: ConfigRecordInput, key: KeyObject): SignedConfigRecord {
  return { ...entry, signature: signDomain(CONFIG_DOMAIN, configSignaturePayload(entry), key) };
}

/** Whether the record's signature is this key's over this payload: a record that does not verify
 *  is refused whole, never read for its fields first. The key is the owner's key as `keyOf`
 *  hands it out — the private half, whose public half the verifier derives.
 *
 *  The record is untrusted disk JSON, so the answer is a boolean and never an exception: a value
 *  of the wrong shape or a signature that is not a string is a false like a tampered payload. */
export function verifyConfigRecord(record: SignedConfigRecord, key: KeyObject): boolean {
  if (!isConfigValue(record.value)) return false;
  if (typeof record.signature !== 'string') return false;
  try {
    return verifyDomain(CONFIG_DOMAIN, configSignaturePayload(record), record.signature, key);
  } catch {
    return false;
  }
}
