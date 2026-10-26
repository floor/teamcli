// Reading and writing the signed charter. The signature is checked against the owner seat's
// key as the credential store confirms it. The public key written beside the signature is not
// authority: an agent that can write the file cannot make a charter that verifies.

import { verify as cryptoVerify } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { confirmedSignerKey, ownerSeatPublicKey, readOwnerSeat, systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import {
  CHARTER_OPERATIONS,
  canonicalCharter,
  charterPath,
  charterStatement,
  type CharterBody,
  type CharterLifetimes,
  type CharterOp,
  type SignedCharter,
} from './body.ts';

export type CharterRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; why: string }
  | { kind: 'ok'; charter: SignedCharter };

function isOp(value: string): value is CharterOp {
  return (CHARTER_OPERATIONS as readonly string[]).includes(value);
}

function lifetimesOf(value: unknown): CharterLifetimes | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const one = (key: string): number | null | undefined => {
    const held = raw[key];
    if (held === null) return null;
    if (typeof held === 'number' && Number.isFinite(held) && held >= 0) return held;
    return undefined;
  };
  const request = one('request');
  const rule = one('rule');
  const grant = one('grant');
  const unattended = one('unattended');
  if (request === undefined || rule === undefined || grant === undefined || unattended === undefined) return null;
  return { request, rule, grant, unattended };
}

function bodyOf(value: unknown): CharterBody | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== 1) return null;
  if (!Array.isArray(raw.roots) || raw.roots.length === 0 || raw.roots.some((root) => typeof root !== 'string' || root === '')) return null;
  const vendors = raw.vendors === 'all'
    ? 'all'
    : Array.isArray(raw.vendors) && raw.vendors.every((vendor) => typeof vendor === 'string')
      ? raw.vendors
      : null;
  if (vendors === null) return null;
  if (!Array.isArray(raw.operations) || raw.operations.length === 0 || raw.operations.some((op) => typeof op !== 'string' || !isOp(op))) return null;
  if (typeof raw.team_creation !== 'boolean' || typeof raw.grants !== 'boolean' || typeof raw.renewals !== 'boolean') return null;
  if (raw.grant_right !== false) return null;
  if (raw.expires_at !== null && typeof raw.expires_at !== 'string') return null;
  const lifetimes = lifetimesOf(raw.lifetimes);
  if (lifetimes === null) return null;
  return {
    format: 1,
    roots: [...raw.roots],
    vendors,
    operations: [...raw.operations],
    team_creation: raw.team_creation,
    grants: raw.grants,
    renewals: raw.renewals,
    grant_right: false,
    expires_at: raw.expires_at,
    lifetimes,
  };
}

/** The charter on disk. No file is `absent`. A file that does not verify is `invalid` (fail closed). */
export function readCharter(home: string, store: OwnerSeatKeyStore = systemOwnerSeatKeyStore()): CharterRead {
  const path = charterPath(home);
  if (!existsSync(path)) return { kind: 'absent' };
  let parsed: unknown;
  try {
    if (!lstatSync(path).isFile()) return { kind: 'invalid', why: 'the owner charter is not a plain file' };
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'invalid', why: 'the owner charter cannot be read' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid', why: 'the owner charter is not a record' };
  const file = parsed as Record<string, unknown>;
  if (file.grant_right === true || (file.body !== null && typeof file.body === 'object' && (file.body as { grant_right?: unknown }).grant_right === true)) {
    return { kind: 'invalid', why: 'a charter cannot carry the right to grant' };
  }
  const body = bodyOf(file.body);
  if (body === null || file.format !== 1 || typeof file.signer !== 'string' || typeof file.signature !== 'string') {
    return { kind: 'invalid', why: 'the owner charter is not whole' };
  }
  if (canonicalCharter(body) !== canonicalCharter(file.body as CharterBody)) {
    return { kind: 'invalid', why: 'the owner charter is not whole' };
  }
  const seat = readOwnerSeat(home);
  const signer = seat?.signers.find((one) => one.name === file.signer);
  if (signer === undefined) return { kind: 'invalid', why: `signer "${file.signer}" is not on the owner seat` };
  const confirmed = confirmedSignerKey(signer, store);
  if (!confirmed.ok) return { kind: 'invalid', why: confirmed.why };
  const key = ownerSeatPublicKey(confirmed.publicKey);
  if (key === null) return { kind: 'invalid', why: 'the credential store key is not a P-256 public key' };
  try {
    const ok = cryptoVerify('sha256', charterStatement(body), { key, dsaEncoding: 'der' }, Buffer.from(file.signature, 'hex'));
    if (!ok) return { kind: 'invalid', why: 'the owner charter signature does not verify' };
  } catch {
    return { kind: 'invalid', why: 'the owner charter signature does not verify' };
  }
  return { kind: 'ok', charter: { format: 1, body, signer: file.signer, signature: file.signature } };
}

/** Writes the charter only after the caller has verified `signature`. A failed write leaves the previous file. */
export function writeCharter(home: string, charter: SignedCharter): { ok: true; path: string } | { ok: false; why: string } {
  const path = charterPath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(charter, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return { ok: true, path };
  } catch {
    return { ok: false, why: 'the owner charter could not be written' };
  }
}
