// Proposed v1 wire contract for synthetic owner answers. No device adapter, enrollment,
// credential lookup or authority write is reachable from this module.
import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import type { Json } from '../store/keys.ts';

export const OWNER_STATEMENT_FORMAT = 'team-owner-statement-v1';
export const OWNER_TRANSCRIPT_FORMAT = 'team-owner-transcript-v1';
export const OWNER_STATEMENT_DOMAIN = 'team-owner-statement-v1\n';
export const OWNER_PROOF_MAX_AGE_MS = 30_000;
export const OWNER_PROOF_FUTURE_SKEW_MS = 5_000;
export const OWNER_SIGNER_TYPES = ['mac-keystore', 'webauthn', 'phone-passkey', 'fido2-key', 'terminal'] as const;
export type OwnerSignerType = (typeof OWNER_SIGNER_TYPES)[number];
export type OwnerDecision = 'once' | 'always' | 'deny';
export type OwnerStandingRule = {
  kind: string;
  scope: { [key: string]: Json };
  bounds: { [key: string]: Json };
  expires_at: string;
};
export type OwnerStatement = {
  format: typeof OWNER_STATEMENT_FORMAT;
  request_id: string;
  params_hash: string;
  act_digest: string;
  nonce: string;
  choice: OwnerDecision;
  standing_rule: OwnerStandingRule | null;
  signer_id: string;
  signer_type: OwnerSignerType;
  time: string;
};
export type OwnerTranscript = {
  format: typeof OWNER_TRANSCRIPT_FORMAT;
  scheme: 'synthetic-ed25519';
  statement: OwnerStatement;
  challenge: string;
  signature: string;
};

export function ownerObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    && (Object.getPrototypeOf(raw) === Object.prototype || Object.getPrototypeOf(raw) === null);
}
export function ownerExactKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(raw).length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}
export function ownerTime(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const value = Date.parse(raw);
  return Number.isFinite(value) && new Date(value).toISOString() === raw;
}
export function ownerId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw);
}
export function ownerHash(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw);
}

/** UTF-8 canonical JSON, sorted object keys, dense arrays, safe integers only. No domain
 * prefix is included in these bytes. Reject accessors, cycles, prototypes and extra array
 * properties instead of letting JSON.stringify silently discard or rewrite them. */
export function canonicalOwnerBytes(raw: unknown): Buffer {
  const active = new Set<object>();
  let nodes = 0;
  const encode = (value: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 32) throw new Error('owner-wire.invalid-json');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
    if (typeof value !== 'object' || value === null || active.has(value)) throw new Error('owner-wire.invalid-json');
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('owner-wire.invalid-json');
        return `[${Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('owner-wire.invalid-json');
          return encode(descriptor.value, depth + 1);
        }).join(',')}]`;
      }
      if (!ownerObject(value)) throw new Error('owner-wire.invalid-json');
      const keys = Object.keys(value).sort();
      if (!ownerExactKeys(value, keys)) throw new Error('owner-wire.invalid-json');
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1)}`).join(',')}}`;
    } finally {
      active.delete(value);
    }
  };
  const bytes = Buffer.from(encode(raw, 0), 'utf8');
  if (bytes.length > 262_144) throw new Error('owner-wire.invalid-json');
  return bytes;
}
export function ownerValueHash(raw: unknown): string {
  return createHash('sha256').update(canonicalOwnerBytes(raw)).digest('hex');
}
export function ownerSnapshot<T>(raw: T): T {
  const value = JSON.parse(canonicalOwnerBytes(raw).toString('utf8')) as T;
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(value);
  return value;
}

export function validOwnerStatement(raw: unknown): raw is OwnerStatement {
  try {
    canonicalOwnerBytes(raw);
    if (!ownerObject(raw) || !ownerExactKeys(raw, ['format', 'request_id', 'params_hash', 'act_digest', 'nonce', 'choice', 'standing_rule', 'signer_id', 'signer_type', 'time'])) return false;
    if (raw.format !== OWNER_STATEMENT_FORMAT || !ownerId(raw.request_id) || !ownerId(raw.signer_id)
      || !ownerHash(raw.params_hash) || !ownerHash(raw.act_digest) || !ownerHash(raw.nonce)
      || !ownerTime(raw.time) || raw.signer_type === 'terminal' || !(OWNER_SIGNER_TYPES as readonly unknown[]).includes(raw.signer_type)) return false;
    if (raw.choice !== 'once' && raw.choice !== 'always' && raw.choice !== 'deny') return false;
    if (raw.choice !== 'always') return raw.standing_rule === null;
    const rule = raw.standing_rule;
    return ownerObject(rule) && ownerExactKeys(rule, ['kind', 'scope', 'bounds', 'expires_at'])
      && typeof rule.kind === 'string' && rule.kind.length > 0 && ownerObject(rule.scope)
      && ownerObject(rule.bounds) && ownerTime(rule.expires_at) && Date.parse(rule.expires_at) > Date.parse(raw.time);
  } catch {
    return false;
  }
}

/** The nonce is already a payload field. The challenge is SHA-256 of the complete canonical
 * payload WITHOUT a domain prefix; it is never inserted back into the signed payload. */
export function ownerStatementChallenge(statement: OwnerStatement): string {
  if (!validOwnerStatement(statement)) throw new Error('owner-wire.invalid-statement');
  return ownerValueHash(statement);
}
function signatureInput(statement: OwnerStatement): Buffer {
  return Buffer.concat([Buffer.from(OWNER_STATEMENT_DOMAIN, 'utf8'), Buffer.from(ownerStatementChallenge(statement), 'hex')]);
}

/** Test seam only. The private key is supplied by the synthetic host, never loaded here.
 * Exactly one signature binds the statement through its challenge. */
export function signSyntheticOwnerStatement(statement: OwnerStatement, key: KeyObject): OwnerTranscript {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519' || statement.signer_type === 'terminal') throw new Error('owner-wire.synthetic-key');
  const captured = ownerSnapshot(statement);
  return ownerSnapshot({ format: OWNER_TRANSCRIPT_FORMAT, scheme: 'synthetic-ed25519', statement: captured,
    challenge: ownerStatementChallenge(captured), signature: sign(null, signatureInput(captured), key).toString('hex') });
}

/** Cryptographic binding only, not enrollment, device presence or policy admission. The key
 * is the host's registered key, never a field supplied by the transcript. */
export function verifySyntheticOwnerTranscript(raw: unknown, key: KeyObject): raw is OwnerTranscript {
  try {
    canonicalOwnerBytes(raw);
    if (!ownerObject(raw) || !ownerExactKeys(raw, ['format', 'scheme', 'statement', 'challenge', 'signature'])
      || raw.format !== OWNER_TRANSCRIPT_FORMAT || raw.scheme !== 'synthetic-ed25519'
      || !validOwnerStatement(raw.statement) || raw.statement.signer_type === 'terminal'
      || raw.challenge !== ownerStatementChallenge(raw.statement) || typeof raw.signature !== 'string'
      || !/^[0-9a-f]{128}$/.test(raw.signature) || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, signatureInput(raw.statement), key, Buffer.from(raw.signature, 'hex'));
  } catch {
    return false;
  }
}
