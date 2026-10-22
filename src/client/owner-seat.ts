// The owner seat: the human owner's own seat. It holds one or more signers, none of whose private
// keys is on disk, and an approval it signs is verifiable without trusting the shared message key
// or the owner key file, which every process running as the owner's user can read.
//
// A signer has a type:
// - `mac-keystore`: a P-256 key in the system credential store behind user presence (biometric
//   or password on each signature), reached through the credential-store adapter's helper.
// - `webauthn`: a passkey (on a phone or a computer); an approval is a WebAuthn assertion whose
//   challenge is the hash of the answer.
// No signer type is preferred. Which signers an entity accepts is its signed `owner-signers`
// policy (a list of signer names) with `owner-signer-mode: any`; with no policy, every registered
// signer is accepted (the documented fallback).
//
// Pinning: the record (`~/.config/team/owner-seat.json`) is a user-writable file and is never
// trusted alone. A `mac-keystore` signer's public key is read back from the credential store; a
// `webauthn` signer's public key is compared with a pin the credential store keeps for it. A
// store that is unavailable or disagrees fails closed.

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';

/** One credential store: user-presence signing keys, plus pins for keys held elsewhere. */
export type OwnerSeatKeyStore = {
  name: string;
  available: () => boolean;
  /** Creates a key under `label`; returns its public key (uncompressed P-256 point, hex). */
  create: (label: string) => { ok: true; publicKey: string } | { ok: false; why: string };
  /** Reads an existing key's public key back (no prompt). */
  publicKey: (label: string) => { ok: true; publicKey: string } | { ok: false; why: string };
  /** Signs `message` (ECDSA P-256 SHA-256, DER, hex), prompting for user presence with `reason`. */
  sign: (label: string, message: Buffer, reason: string) => { ok: true; signature: string } | { ok: false; why: string };
  /** Stores a pin (a public key held elsewhere) under `label`; never overwrites one. */
  pinSet: (label: string, value: string) => { ok: true } | { ok: false; why: string };
  /** Reads a pin back. */
  pinGet: (label: string) => { ok: true; value: string } | { ok: false; why: string };
};

export function ownerSeatHelperPath(home: string = homedir()): string {
  return join(home, '.config', 'team-owner-seat', 'owner-seat-keystore');
}

/** The system adapter: the compiled helper (`helpers/owner-seat-keystore.swift`). */
export function systemOwnerSeatKeyStore(helper: string = ownerSeatHelperPath()): OwnerSeatKeyStore {
  const run = (args: string[], input?: string, timeout = 120_000): string =>
    execFileSync(helper, args, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout, ...(input !== undefined ? { input } : {}) }).trim();
  const point = (out: string) => /^04[0-9a-f]{128}$/.test(out);
  return {
    name: 'system-credential-store',
    available: () => platform() === 'darwin' && existsSync(helper),
    create: (label) => {
      try {
        const out = run(['create', label]);
        return point(out) ? { ok: true, publicKey: out } : { ok: false, why: 'the helper returned no public key' };
      } catch (error) {
        return { ok: false, why: `the credential store refused to create the key (${String((error as { stderr?: string }).stderr ?? '').trim() || 'helper failed'})` };
      }
    },
    publicKey: (label) => {
      try {
        const out = run(['public', label], undefined, 30_000);
        return point(out) ? { ok: true, publicKey: out } : { ok: false, why: 'the helper returned no public key' };
      } catch {
        return { ok: false, why: `the credential store holds no key "${label}"` };
      }
    },
    sign: (label, message, reason) => {
      try {
        const out = run(['sign', label, reason], message.toString('hex'));
        return /^[0-9a-f]+$/.test(out) ? { ok: true, signature: out } : { ok: false, why: 'the helper returned no signature' };
      } catch {
        return { ok: false, why: 'the signature was refused or the user-presence prompt was cancelled' };
      }
    },
    pinSet: (label, value) => {
      try {
        run(['pin-set', label], value, 30_000);
        return { ok: true };
      } catch {
        return { ok: false, why: `the credential store refused the pin "${label}" (one may exist already)` };
      }
    },
    pinGet: (label) => {
      try {
        return { ok: true, value: run(['pin-get', label], undefined, 30_000) };
      } catch {
        return { ok: false, why: `the credential store holds no pin "${label}"` };
      }
    },
  };
}

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

export type OwnerSeatRecord = {
  format: 2;
  team: string;
  entity: string;
  seat: 'owner';
  role: 'owner';
  human: true;
  lifecycle: 'running';
  signers: OwnerSigner[];
  provenance: { registered_by: 'owner'; note: 'created for the human owner'; registered_at: string };
};

export function ownerSeatFile(home: string = homedir()): string {
  return join(home, '.config', 'team', 'owner-seat.json');
}

export function ownerSeatInbox(home: string = homedir()): string {
  return join(home, '.config', 'team', 'owner-seat', 'inbox');
}

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const SIGNER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function ownerSeatPublicKey(rawHex: string): KeyObject | null {
  if (!/^04[0-9a-f]{128}$/.test(rawHex)) return null;
  try {
    return createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(rawHex, 'hex')]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function writeExclusive(path: string, text: string): 'written' | 'exists' | 'failed' {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return 'written';
}

function replaceRecord(home: string, record: OwnerSeatRecord): boolean {
  const path = ownerSeatFile(home);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/** Registers the owner seat with its first signer, a `mac-keystore` key created in the store. */
export function registerOwnerSeat(
  home: string,
  input: { team: string; entity?: string; signer: string },
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
): { ok: true; record: OwnerSeatRecord; path: string } | { ok: false; why: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.team)) return { ok: false, why: `"${input.team}" is not a team name` };
  if (!SIGNER_NAME.test(input.signer)) return { ok: false, why: `"${input.signer}" is not a signer name` };
  if (existsSync(ownerSeatFile(home))) return { ok: false, why: `an owner seat is already registered (${ownerSeatFile(home)}); add a signer with --add-owner-signer` };
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available; build the helper: swiftc helpers/owner-seat-keystore.swift -o ${ownerSeatHelperPath(home)}` };
  const label = `owner-${input.team}-${input.signer}`;
  const created = store.create(label);
  if (!created.ok) return created;
  if (ownerSeatPublicKey(created.publicKey) === null) return { ok: false, why: 'the credential store returned a key that is not a P-256 public key' };
  const record: OwnerSeatRecord = {
    format: 2, team: input.team, entity: input.entity ?? input.team, seat: 'owner', role: 'owner', human: true, lifecycle: 'running',
    signers: [{ name: input.signer, type: 'mac-keystore', public_key: created.publicKey, label, added: now.toISOString() }],
    provenance: { registered_by: 'owner', note: 'created for the human owner', registered_at: now.toISOString() },
  };
  mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
  const path = ownerSeatFile(home);
  if (writeExclusive(path, `${JSON.stringify(record, null, 2)}\n`) !== 'written') return { ok: false, why: 'the owner seat record could not be written' };
  return { ok: true, record, path };
}

/**
 * Adds a signer to the registered owner seat. `mac-keystore` creates a new store key; `webauthn`
 * records a passkey's public key (from a WebAuthn registration) and pins it in the store.
 */
export function addOwnerSigner(
  home: string,
  input: { signer: string; type: SignerType; publicKey?: string; credentialId?: string; rpId?: string },
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
): { ok: true; signer: OwnerSigner } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered' };
  if (!SIGNER_NAME.test(input.signer)) return { ok: false, why: `"${input.signer}" is not a signer name` };
  if (record.signers.some((s) => s.name === input.signer)) return { ok: false, why: `signer "${input.signer}" is already registered` };
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const label = `owner-${record.team}-${input.signer}`;
  let signer: OwnerSigner;
  if (input.type === 'mac-keystore') {
    const created = store.create(label);
    if (!created.ok) return created;
    signer = { name: input.signer, type: 'mac-keystore', public_key: created.publicKey, label, added: now.toISOString() };
  } else {
    if (input.publicKey === undefined || ownerSeatPublicKey(input.publicKey) === null) return { ok: false, why: 'a webauthn signer needs --public-key <uncompressed P-256 point, hex>' };
    if (input.credentialId === undefined || !/^[A-Za-z0-9_-]{8,1024}$/.test(input.credentialId)) return { ok: false, why: 'a webauthn signer needs --credential-id <base64url>' };
    if (input.rpId === undefined || !/^[a-z0-9.-]{1,253}$/.test(input.rpId)) return { ok: false, why: 'a webauthn signer needs --rp-id <relying party id>' };
    const pinned = store.pinSet(label, input.publicKey);
    if (!pinned.ok) return pinned;
    signer = { name: input.signer, type: 'webauthn', public_key: input.publicKey, label, credential_id: input.credentialId, rp_id: input.rpId, added: now.toISOString() };
  }
  if (!replaceRecord(home, { ...record, signers: [...record.signers, signer] })) return { ok: false, why: 'the owner seat record could not be updated' };
  return { ok: true, signer };
}

export function readOwnerSeat(home: string): OwnerSeatRecord | null {
  try {
    if (!lstatSync(ownerSeatFile(home)).isFile()) return null;
    const record = JSON.parse(readFileSync(ownerSeatFile(home), 'utf8')) as OwnerSeatRecord;
    if (record.format !== 2 || record.seat !== 'owner' || record.role !== 'owner' || !Array.isArray(record.signers)) return null;
    return record;
  } catch {
    return null;
  }
}

/** The signer names an entity accepts: its `owner-signers` policy, or every registered signer. */
export function acceptedSigners(home: string, record: OwnerSeatRecord, now: Date = new Date()): { names: string[]; source: 'policy' | 'fallback' } | { why: string } {
  let chain;
  try {
    chain = loadAndResolvePolicyChain({ home, entity: record.entity, projectId: null, teamRoot: null, team: null }, { now, upToLevel: 'entity' });
  } catch {
    return { why: 'the owner-signer policy cannot be read' };
  }
  if (!chain.ok) return { why: chain.refusals[0]?.message ?? 'the owner-signer policy cannot be read or verified' };
  const mode = chain.policies['owner-signer-mode']?.value;
  if (mode !== undefined && mode !== 'any') return { why: `owner-signer-mode "${String(mode)}" is not one this build reads` };
  const listed = chain.policies['owner-signers']?.value;
  if (Array.isArray(listed)) return { names: listed.filter((n): n is string => typeof n === 'string'), source: 'policy' };
  return { names: record.signers.map((s) => s.name), source: 'fallback' };
}

/** A signer's public key, confirmed against the credential store; fails closed. */
export function confirmedSignerKey(signer: OwnerSigner, store: OwnerSeatKeyStore): { ok: true; publicKey: string } | { ok: false; why: string } {
  if (!store.available()) {
    return { ok: false, why: `the ${store.name} adapter is not available to confirm signer "${signer.name}"; an owner-seat answer cannot be verified (use team grant --answer or --code)` };
  }
  const held = signer.type === 'mac-keystore' ? store.publicKey(signer.label) : (() => {
    const pin = store.pinGet(signer.label);
    return pin.ok ? { ok: true as const, publicKey: pin.value } : pin;
  })();
  if (!held.ok) return { ok: false, why: `${held.why}; an owner-seat answer cannot be verified` };
  if (held.publicKey !== signer.public_key) {
    return { ok: false, why: `the owner seat record does not match the key in the credential store for signer "${signer.name}"; no owner-seat answer is accepted` };
  }
  return { ok: true, publicKey: held.publicKey };
}

export function deliverToOwnerSeat(home: string, message: { request_id: string; params_sha256: string; text: string; summary: unknown; at: string; kind?: string }): string | null {
  if (readOwnerSeat(home) === null) return null;
  const folder = ownerSeatInbox(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, `${message.request_id}.json`);
  return writeExclusive(path, `${JSON.stringify({ to: 'owner', kind: message.kind ?? 'grant-confirmation', ...message }, null, 2)}\n`) === 'written' ? path : null;
}

export function ownerSeatMessages(home: string): Array<{ request_id: string; text: string; at: string }> {
  try {
    return readdirSync(ownerSeatInbox(home)).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(readFileSync(join(ownerSeatInbox(home), n), 'utf8')));
  } catch {
    return [];
  }
}

export const OWNER_SEAT_ANSWER_DOMAIN = 'team-owner-seat-answer-v2\n';

/** One owner-seat answer. `kind` keeps a grant answer and a team-create answer apart; `scope`
 *  is signed so an `always` answer can stand as its own rule. */
export type OwnerSeatAnswer = {
  kind: 'grant' | 'team-create';
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

/**
 * Verifies one signed answer: its signer is registered and accepted by policy, the signer's key is
 * confirmed against the credential store, and the signature (or WebAuthn assertion, with its
 * challenge, relying party and user-presence flag) holds over exactly this answer.
 */
export function verifyOwnerAnswer(home: string, signed: SignedOwnerAnswer, store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; answer: OwnerSeatAnswer; signer: OwnerSigner } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'an owner-seat answer exists but no owner seat is registered to verify it' };
  const answer = signed.owner_seat_answer;
  if (answer === undefined || typeof signed.signature !== 'string' || typeof signed.signer !== 'string') return { ok: false, why: 'the owner-seat answer is not signed' };
  const signer = record.signers.find((s) => s.name === signed.signer);
  if (signer === undefined) return { ok: false, why: `"${signed.signer}" is not a registered owner signer` };
  const accepted = acceptedSigners(home, record, now);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  if (!accepted.names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${accepted.names.join(', ') || 'none'})` };
  const confirmed = confirmedSignerKey(signer, store);
  if (!confirmed.ok) return confirmed;
  if (answer.team !== record.team || answer.seat !== 'owner') return { ok: false, why: 'the owner-seat answer names another seat' };
  if (signer.type === 'mac-keystore') {
    if (!ecdsaOk(confirmed.publicKey, ownerSeatAnswerBytes(answer), signed.signature)) return { ok: false, why: `the answer does not verify under the owner seat's key for signer "${signer.name}"` };
  } else {
    const w = signed.webauthn;
    if (w === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey; the answer carries no assertion` };
    let clientData: { type?: string; challenge?: string };
    const authData = Buffer.from(w.authenticator_data, 'base64url');
    const clientJson = Buffer.from(w.client_data_json, 'base64url');
    try {
      clientData = JSON.parse(clientJson.toString('utf8'));
    } catch {
      return { ok: false, why: 'the passkey assertion carries no readable client data' };
    }
    if (clientData.type !== 'webauthn.get' || clientData.challenge !== webauthnChallenge(answer)) return { ok: false, why: 'the passkey assertion is not over this answer' };
    if (authData.length < 37 || !authData.subarray(0, 32).equals(createHash('sha256').update(signer.rp_id ?? '').digest())) return { ok: false, why: 'the passkey assertion is for another relying party' };
    if ((authData[32]! & 0x01) === 0) return { ok: false, why: 'the passkey assertion carries no user presence' };
    const data = Buffer.concat([authData, createHash('sha256').update(clientJson).digest()]);
    if (!ecdsaOk(confirmed.publicKey, data, signed.signature)) return { ok: false, why: `the passkey assertion does not verify under signer "${signer.name}"` };
  }
  return { ok: true, answer, signer };
}

/** Signs an answer with a `mac-keystore` signer (user-presence prompt). A `webauthn` signer signs
 *  in a browser or on a phone; its assertion is presented with `--assertion <file>`. */
export function signOwnerAnswer(home: string, answer: OwnerSeatAnswer, signerName: string | undefined, store: OwnerSeatKeyStore, reason: string, assertion?: { authenticator_data: string; client_data_json: string; signature: string }): { ok: true; signed: SignedOwnerAnswer } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered: the owner runs team grant --add-owner-seat --team <team> --signer <name>' };
  const signer = signerName === undefined
    ? (record.signers.length === 1 ? record.signers[0] : undefined)
    : record.signers.find((s) => s.name === signerName);
  if (signer === undefined) return { ok: false, why: signerName === undefined ? `name the signer with --signer (${record.signers.map((s) => s.name).join(', ')})` : `"${signerName}" is not a registered owner signer` };
  if (signer.type === 'webauthn') {
    if (assertion === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey: sign challenge ${webauthnChallenge(answer)} and pass --assertion <file>` };
    return { ok: true, signed: { owner_seat_answer: answer, signer: signer.name, signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } } };
  }
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const signed = store.sign(signer.label, ownerSeatAnswerBytes(answer), reason);
  if (!signed.ok) return signed;
  return { ok: true, signed: { owner_seat_answer: answer, signer: signer.name, signature: signed.signature } };
}
