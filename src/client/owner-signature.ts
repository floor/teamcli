// The owner seat's signature rule, with nothing else: the signer records, the answer bytes and
// their passkey challenge, and the check of one signature or passkey assertion over exactly those
// bytes. It reads no file and imports nothing of TeamCLI's own, so the owner helper of a machine
// whose accounts share one owner (src/client/owner-spend.ts) verifies with this rule and no more.
// src/client/owner-seat.ts re-exports all of it.

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export type SignerType = 'mac-keystore' | 'webauthn';

export type OwnerSigner = {
  name: string;
  type: SignerType;
  public_key: string;
  /** mac-keystore: the credential-store key label. webauthn: the credential-store pin label. */
  label: string;
  /** webauthn only. */
  credential_id?: string;
  rp_id?: string;
  added: string;
};

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

export function ownerSeatPublicKey(rawHex: string): KeyObject | null {
  if (!/^04[0-9a-f]{128}$/.test(rawHex)) return null;
  try {
    return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

export const OWNER_SEAT_ANSWER_DOMAIN = 'team-owner-seat-answer-v2\n';

/** One owner-seat answer. `kind` keeps a grant answer and a team-create answer apart; `scope`
 *  is signed so an `always` answer can stand as its own rule. */
export type OwnerSeatAnswer = {
  kind: 'grant' | 'team-create' | 'approval-mode' | 'owner-action';
  request_id: string;
  params_sha256: string;
  choice: 'once' | 'always' | 'deny';
  team: string;
  seat: 'owner';
  at: string;
  scope?: string;
};

export function ownerSeatAnswerBytes(answer: OwnerSeatAnswer): Buffer {
  const canonical = {
    kind: answer.kind, request_id: answer.request_id, params_sha256: answer.params_sha256, choice: answer.choice,
    team: answer.team, seat: answer.seat, at: answer.at, scope: answer.scope ?? null,
  };
  return Buffer.from(OWNER_SEAT_ANSWER_DOMAIN + JSON.stringify(canonical), 'utf8');
}

/** The WebAuthn challenge an answer is signed under: base64url SHA-256 of the answer bytes. */
export function webauthnChallenge(answer: OwnerSeatAnswer): string {
  return createHash('sha256').update(ownerSeatAnswerBytes(answer)).digest('base64url');
}

export type SignedOwnerAnswer = {
  owner_seat_answer: OwnerSeatAnswer;
  signer: string;
  signature: string;
  /** webauthn signers: the assertion's authenticator data and client data JSON (base64url). */
  webauthn?: { authenticator_data: string; client_data_json: string };
};

function ecdsaOk(publicKey: string, data: Buffer, signature: string): boolean {
  const key = ownerSeatPublicKey(publicKey);
  if (key === null || !/^[0-9a-f]+$/.test(signature)) return false;
  try {
    return cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

/** One signature (or WebAuthn assertion) under a confirmed signer, over exactly these bytes.
 *  The pinned owner seat (src/client/owner-pin.ts) checks its records with this same rule. */
export function signatureOk(
  signer: OwnerSigner,
  publicKey: string,
  bytes: Buffer,
  challenge: string,
  signature: string,
  webauthn: { authenticator_data: string; client_data_json: string } | undefined,
  what: string,
): { ok: true } | { ok: false; why: string } {
  if (signer.type === 'mac-keystore') {
    if (!ecdsaOk(publicKey, bytes, signature)) return { ok: false, why: `the ${what} does not verify under the owner seat's key for signer "${signer.name}"` };
    return { ok: true };
  }
  if (webauthn === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey; the ${what} carries no assertion` };
  let clientData: { type?: string; challenge?: string };
  const authData = Buffer.from(webauthn.authenticator_data, 'base64url');
  const clientJson = Buffer.from(webauthn.client_data_json, 'base64url');
  try {
    clientData = JSON.parse(clientJson.toString('utf8'));
  } catch {
    return { ok: false, why: 'the passkey assertion carries no readable client data' };
  }
  if (clientData.type !== 'webauthn.get' || clientData.challenge !== challenge) return { ok: false, why: `the passkey assertion is not over this ${what}` };
  if (authData.length < 37 || !authData.subarray(0, 32).equals(createHash('sha256').update(signer.rp_id ?? '').digest())) return { ok: false, why: 'the passkey assertion is for another relying party' };
  if ((authData[32]! & 0x01) === 0) return { ok: false, why: 'the passkey assertion carries no user presence' };
  const data = Buffer.concat([authData, createHash('sha256').update(clientJson).digest()]);
  if (!ecdsaOk(publicKey, data, signature)) return { ok: false, why: `the passkey assertion does not verify under signer "${signer.name}"` };
  return { ok: true };
}
