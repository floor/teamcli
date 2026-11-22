// A pinned owner seat, verified on its own: the export's shape, bytes and fingerprint, its
// signature, the pin file and the machine record beside it, and an owner-seat answer checked
// against the pinned signers. It writes nothing and imports only the signature rule, the request
// record's machine binding and the owner-state resolver, so the owner helper of a machine whose
// accounts share one owner (src/client/owner-spend.ts) verifies with exactly this rule.
// src/client/owner-pin.ts re-exports all of it.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { ownerSeatAnswerBytes, ownerSeatPublicKey, signatureOk, webauthnChallenge, type OwnerSeatAnswer, type OwnerSigner, type SignedOwnerAnswer } from './owner-signature.ts';
import { validMachineBinding, type MachineBinding } from './owner-request-record.ts';
import type { OwnerStateRead } from './owner-pin-path.ts';

export const OWNER_SEAT_EXPORT_FORMAT = 'team-owner-seat-export-v1';
const OWNER_SEAT_EXPORT_DOMAIN = `${OWNER_SEAT_EXPORT_FORMAT}\n`;
const OWNER_SEAT_FINGERPRINT_DOMAIN = 'team-owner-seat-fingerprint-v1\n';
export const OWNER_SEAT_PIN_FORMAT = 'team-owner-seat-pin-v1';
export const MACHINE_FORMAT = 'team-machine-v1';
/** A file carried between machines (an export, a request, an answer) is small: anything larger is refused unread. */
export const CARRIED_FILE_MAX_BYTES = 256 * 1024;
const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIGNER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LABEL = /^[A-Za-z0-9._-]{1,160}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{8,1024}$/;
const RP_ID = /^[a-z0-9.-]{1,253}$/;
const MAX_SIGNERS = 16;

/** The owner seat's public half, as one machine hands it to another. */
export type OwnerSeatExport = {
  format: typeof OWNER_SEAT_EXPORT_FORMAT;
  team: string;
  entity: string;
  /** The owner seat file's own signer records: public material and the store label only. */
  signers: OwnerSigner[];
  /** The signer names the seat entity's owner-signers policy accepted when it was exported. */
  accepted: string[];
  exported_at: string;
};

/** An export and its signature, in the envelope a signed owner-seat answer uses. */
export type SignedOwnerSeatExport = {
  owner_seat_export: OwnerSeatExport;
  signer: string;
  signature: string;
  webauthn?: { authenticator_data: string; client_data_json: string };
};

export type MachineRecord = MachineBinding & { format: typeof MACHINE_FORMAT; created: string };

export type PinFile = {
  format: typeof OWNER_SEAT_PIN_FORMAT;
  fingerprint: string;
  pinned_at: string;
  previous: string | null;
  export: SignedOwnerSeatExport;
};

export type OwnerPin = {
  kind: 'pinned';
  body: OwnerSeatExport;
  signed: SignedOwnerSeatExport;
  fingerprint: string;
  pinnedAt: string;
  machine: MachineRecord;
};

export type OwnerPinRead = { kind: 'none' } | OwnerPin | { kind: 'refused'; why: string };

export function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function canonicalSigner(signer: OwnerSigner, withAdded: boolean): Record<string, string | null> {
  return {
    name: signer.name,
    type: signer.type,
    public_key: signer.public_key,
    label: signer.label,
    credential_id: signer.credential_id ?? null,
    rp_id: signer.rp_id ?? null,
    ...(withAdded ? { added: signer.added } : {}),
  };
}

function byName(a: OwnerSigner, b: OwnerSigner): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The bytes an export's signature covers: the domain, then every field in a fixed order. */
export function ownerSeatExportBytes(body: OwnerSeatExport): Buffer {
  const canonical = {
    format: body.format,
    team: body.team,
    entity: body.entity,
    signers: [...body.signers].sort(byName).map((signer) => canonicalSigner(signer, true)),
    accepted: [...body.accepted].sort(),
    exported_at: body.exported_at,
  };
  return Buffer.from(OWNER_SEAT_EXPORT_DOMAIN + JSON.stringify(canonical), 'utf8');
}

/** The challenge a passkey signs an export under: base64url SHA-256 of the export bytes. */
export function ownerSeatExportChallenge(body: OwnerSeatExport): string {
  return createHash('sha256').update(ownerSeatExportBytes(body)).digest('base64url');
}

/**
 * The fingerprint of an owner seat: SHA-256 over the team, the entity, every signer's public
 * material and label, and the accepted names. Not over the export time or when a signer was
 * added: the same seat exported twice has one fingerprint.
 */
export function ownerSeatFingerprint(body: Pick<OwnerSeatExport, 'team' | 'entity' | 'signers' | 'accepted'>): string {
  const canonical = {
    team: body.team,
    entity: body.entity,
    signers: [...body.signers].sort(byName).map((signer) => canonicalSigner(signer, false)),
    accepted: [...body.accepted].sort(),
  };
  return createHash('sha256').update(OWNER_SEAT_FINGERPRINT_DOMAIN + JSON.stringify(canonical), 'utf8').digest('hex');
}

/** A fingerprint as the owner compares it: its first 128 bits, in eight groups of four. */
export function fingerprintText(hex: string): string {
  return (hex.slice(0, 32).match(/.{1,4}/g) ?? []).join('-');
}

function signerProblem(raw: unknown): string | null {
  if (!plainObject(raw)) return 'a signer record is not an object';
  if (typeof raw.name !== 'string' || !SIGNER_NAME.test(raw.name)) return 'a signer record has no valid name';
  if (raw.type !== 'mac-keystore' && raw.type !== 'webauthn') return `signer "${raw.name}" has a type this build does not read`;
  if (typeof raw.public_key !== 'string' || ownerSeatPublicKey(raw.public_key) === null) return `signer "${raw.name}" carries no P-256 public key`;
  if (typeof raw.label !== 'string' || !LABEL.test(raw.label)) return `signer "${raw.name}" carries no valid label`;
  if (!isoTime(raw.added)) return `signer "${raw.name}" carries no time it was added`;
  if (raw.type === 'webauthn') {
    if (typeof raw.credential_id !== 'string' || !CREDENTIAL_ID.test(raw.credential_id)) return `passkey "${raw.name}" carries no credential id`;
    if (typeof raw.rp_id !== 'string' || !RP_ID.test(raw.rp_id)) return `passkey "${raw.name}" carries no relying party`;
  } else if (raw.credential_id !== undefined || raw.rp_id !== undefined) {
    return `signer "${raw.name}" is a device key and carries passkey fields`;
  }
  const known = new Set(['name', 'type', 'public_key', 'label', 'credential_id', 'rp_id', 'added']);
  const extra = Object.keys(raw).find((key) => !known.has(key));
  if (extra !== undefined) return `signer "${raw.name}" carries a field this build does not read (${extra})`;
  return null;
}

/** The export body, whole and of known shape, or why not. Nothing about its signature is judged here. */
export function exportBodyOf(raw: unknown): OwnerSeatExport | string {
  if (!plainObject(raw)) return 'the export carries no owner seat';
  if (raw.format !== OWNER_SEAT_EXPORT_FORMAT) return `the export is not a ${OWNER_SEAT_EXPORT_FORMAT} record`;
  if (typeof raw.team !== 'string' || !TEAM_NAME.test(raw.team)) return 'the export names no valid team';
  if (typeof raw.entity !== 'string' || !ENTITY_NAME.test(raw.entity)) return 'the export names no valid entity';
  if (!isoTime(raw.exported_at)) return 'the export carries no export time';
  if (!Array.isArray(raw.signers) || raw.signers.length === 0 || raw.signers.length > MAX_SIGNERS) return `the export carries 1 to ${MAX_SIGNERS} signers`;
  for (const signer of raw.signers) {
    const problem = signerProblem(signer);
    if (problem !== null) return problem;
  }
  const signers = raw.signers as OwnerSigner[];
  if (new Set(signers.map((s) => s.name)).size !== signers.length) return 'the export names one signer twice';
  if (new Set(signers.map((s) => s.label)).size !== signers.length) return 'the export gives two signers one label';
  if (!Array.isArray(raw.accepted) || raw.accepted.length === 0 || !raw.accepted.every((name) => typeof name === 'string')) return 'the export accepts no signer';
  const accepted = raw.accepted as string[];
  if (new Set(accepted).size !== accepted.length) return 'the export accepts one signer twice';
  const unknown = accepted.find((name) => !signers.some((s) => s.name === name));
  if (unknown !== undefined) return `the export accepts "${unknown}", which it does not carry`;
  const known = new Set(['format', 'team', 'entity', 'signers', 'accepted', 'exported_at']);
  const extra = Object.keys(raw).find((key) => !known.has(key));
  if (extra !== undefined) return `the export carries a field this build does not read (${extra})`;
  return { format: OWNER_SEAT_EXPORT_FORMAT, team: raw.team, entity: raw.entity, signers: signers.map((s) => ({ ...s })), accepted: [...accepted], exported_at: raw.exported_at };
}

/**
 * Verifies an export on its own: whole, of known shape, and signed by an accepted signer it names,
 * over exactly its bytes (a Secure Enclave signature, or a passkey assertion with its challenge,
 * relying party and user presence). The signature proves the export was made by the holder of that
 * key; whether this machine should believe that key is the pin's question, not this one.
 */
export function verifyOwnerSeatExport(raw: unknown): { ok: true; signed: SignedOwnerSeatExport; body: OwnerSeatExport; fingerprint: string; signer: OwnerSigner } | { ok: false; why: string } {
  if (!plainObject(raw)) return { ok: false, why: 'the export is not an object' };
  const body = exportBodyOf(raw.owner_seat_export);
  if (typeof body === 'string') return { ok: false, why: body };
  if (typeof raw.signer !== 'string' || typeof raw.signature !== 'string' || !/^[0-9a-f]{16,512}$/.test(raw.signature)) return { ok: false, why: 'the export is not signed' };
  const signer = body.signers.find((s) => s.name === raw.signer);
  if (signer === undefined) return { ok: false, why: `the export is signed by "${raw.signer}", which it does not carry` };
  if (!body.accepted.includes(signer.name)) return { ok: false, why: `the export is signed by "${signer.name}", which its owner-signers do not accept` };
  let webauthn: SignedOwnerSeatExport['webauthn'];
  if (raw.webauthn !== undefined) {
    if (!plainObject(raw.webauthn) || typeof raw.webauthn.authenticator_data !== 'string' || typeof raw.webauthn.client_data_json !== 'string') return { ok: false, why: 'the export carries a passkey assertion that cannot be read' };
    webauthn = { authenticator_data: raw.webauthn.authenticator_data, client_data_json: raw.webauthn.client_data_json };
  }
  const bytes = ownerSeatExportBytes(body);
  const sig = signatureOk(signer, signer.public_key, bytes, ownerSeatExportChallenge(body), raw.signature, webauthn, 'owner seat export');
  if (!sig.ok) return sig;
  const signed: SignedOwnerSeatExport = { owner_seat_export: body, signer: signer.name, signature: raw.signature, ...(webauthn !== undefined ? { webauthn } : {}) };
  return { ok: true, signed, body, fingerprint: ownerSeatFingerprint(body), signer };
}

export function readMachineAt(path: string): MachineRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!plainObject(raw) || raw.format !== MACHINE_FORMAT || !isoTime(raw.created)) return null;
    const binding = { id: raw.id, name: raw.name };
    if (!validMachineBinding(binding)) return null;
    return { format: MACHINE_FORMAT, id: binding.id, name: binding.name, created: raw.created };
  } catch {
    return null;
  }
}

/** The pinned owner seat in one resolved owner state (the owner helper resolves its caller's). */
export function readOwnerPinIn(state: OwnerStateRead): OwnerPinRead {
  if (state.kind === 'none') return { kind: 'none' };
  if (state.kind === 'refused') return { kind: 'refused', why: state.why };
  const path = state.place.pin;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'refused', why: 'this machine was pinned, and its pinned owner seat is missing' };
    return { kind: 'refused', why: 'the pinned owner seat cannot be read' };
  }
  if (!stat.isFile()) return { kind: 'refused', why: 'the pinned owner seat is not a plain file' };
  if (stat.size > CARRIED_FILE_MAX_BYTES) return { kind: 'refused', why: 'the pinned owner seat is too large to be one' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'refused', why: 'the pinned owner seat is not whole JSON' };
  }
  if (!plainObject(raw) || raw.format !== OWNER_SEAT_PIN_FORMAT || !isoTime(raw.pinned_at) || typeof raw.fingerprint !== 'string') {
    return { kind: 'refused', why: `the pinned owner seat is not a ${OWNER_SEAT_PIN_FORMAT} record` };
  }
  const verified = verifyOwnerSeatExport(raw.export);
  if (!verified.ok) return { kind: 'refused', why: `the pinned owner seat does not verify (${verified.why})` };
  if (verified.fingerprint !== raw.fingerprint) return { kind: 'refused', why: 'the pinned owner seat does not match its own fingerprint' };
  const machine = readMachineAt(state.place.machine);
  if (machine === null) return { kind: 'refused', why: "the pinned owner seat has no readable machine record beside it" };
  return { kind: 'pinned', body: verified.body, signed: verified.signed, fingerprint: verified.fingerprint, pinnedAt: raw.pinned_at, machine };
}

/**
 * Verifies one signed owner-seat answer against the pinned owner seat: its signer is pinned and
 * accepted, it names the pinned seat, and its signature (or passkey assertion) holds over exactly
 * this answer — the same bytes and the same check as an answer verified where the signer lives.
 * Which request it answers, and whether that request is for this machine, is the caller's check.
 */
export function verifyPinnedOwnerAnswer(pin: OwnerPin, signed: SignedOwnerAnswer): { ok: true; answer: OwnerSeatAnswer; signer: OwnerSigner } | { ok: false; why: string } {
  if (!plainObject(signed)) return { ok: false, why: 'the owner-seat answer is not signed' };
  const answer = signed.owner_seat_answer as unknown;
  if (!plainObject(answer) || typeof signed.signature !== 'string' || typeof signed.signer !== 'string') return { ok: false, why: 'the owner-seat answer is not signed' };
  if (typeof answer.kind !== 'string' || typeof answer.request_id !== 'string' || typeof answer.params_sha256 !== 'string' || typeof answer.choice !== 'string' || !isoTime(answer.at)) {
    return { ok: false, why: 'the owner-seat answer cannot be read' };
  }
  const signer = pin.body.signers.find((s) => s.name === signed.signer);
  if (signer === undefined) return { ok: false, why: `"${signed.signer}" is not a signer of the owner seat pinned on this machine` };
  if (!pin.body.accepted.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner seat pinned on this machine (${pin.body.accepted.join(', ')})` };
  const typed = answer as unknown as OwnerSeatAnswer;
  if (typed.team !== pin.body.team || typed.seat !== 'owner') return { ok: false, why: 'the owner-seat answer names another seat' };
  const sig = signatureOk(signer, signer.public_key, ownerSeatAnswerBytes(typed), webauthnChallenge(typed), signed.signature, signed.webauthn, 'answer');
  if (!sig.ok) return sig;
  return { ok: true, answer: typed, signer };
}
