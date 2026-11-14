// The owner seat pinned from another machine.
//
// A machine with no owner signer of its own (a headless server, for one) cannot show the owner a
// Touch ID card, and cannot enrol a passkey either: enrolment needs the signer machine to confirm
// it. So it pins the owner seat's PUBLIC signer records from the machine that holds them, and
// verifies the owner's answers against them. Nothing private leaves the signer machine.
//
//   export  on the signer machine: the seat's signer records — the same records the owner seat
//           file holds (Secure Enclave public key; passkey public key, credential id and relying
//           party), each confirmed against the credential store first — and the names the
//           owner-signers policy accepts. An accepted Secure Enclave signer signs the export
//           under one Touch ID card that shows its fingerprint.
//   pin     on the other machine: the export's signature must verify under a signer the export
//           itself names, and the fingerprint is printed so the owner compares it with the one
//           the export printed. The first pin is trust on first use: this machine believes the
//           first export the owner, at a terminal here, gives it. A changed set needs a newer
//           export signed by a signer already pinned here; the same set changes nothing.
//
// The pin, the machine record (a random id made at the first pin, and a display name) and the
// ledger that spends each carried approval once live where one resolver says
// (src/client/owner-pin-path.ts): a protected system folder when one is present, else the
// account's own config folder, never a folder the environment names. Every owner request made on
// a pinned machine names that machine in its signed parameters, so an answer is bound to it and
// is never accepted on another. In the account's own folder the owner state is as safe as the
// account's own files: a process of the account can replace it (the pin's own output says so).
//
// On a machine whose accounts share one owner (Linux), the system folder is the only place: the
// administrator pins there (as root), each request also names the account it was made by, and an
// approval is spent only by the owner helper, in that account's own ledger folder
// (src/client/owner-spend.ts). No process of an entity account writes any of it.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import {
  acceptedSigners,
  confirmedSignerKey,
  ownerSeatAnswerBytes,
  ownerSeatFile,
  ownerSeatPublicKey,
  readOwnerSeat,
  signatureOk,
  webauthnChallenge,
  type OwnerSeatAnswer,
  type OwnerSeatKeyStore,
  type OwnerSigner,
  type SignedOwnerAnswer,
} from './owner-seat.ts';
import { ACCOUNT_NAME_PATTERN, ownerMachinePinned, ownerStateOf, systemOwnerUid, type OwnerStatePlace, type OwnerStateRead } from './owner-pin-path.ts';

export const OWNER_SEAT_EXPORT_FORMAT = 'team-owner-seat-export-v1';
const OWNER_SEAT_EXPORT_DOMAIN = `${OWNER_SEAT_EXPORT_FORMAT}\n`;
const OWNER_SEAT_FINGERPRINT_DOMAIN = 'team-owner-seat-fingerprint-v1\n';
export const OWNER_SEAT_PIN_FORMAT = 'team-owner-seat-pin-v1';
export const MACHINE_FORMAT = 'team-machine-v1';
export const MACHINE_ID_PATTERN = /^m_[0-9a-f]{24}$/;
export const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,62}$/;
/** A file carried between machines (an export, a request, an answer) is small: anything larger is refused unread. */
export const CARRIED_FILE_MAX_BYTES = 256 * 1024;
/** An export dated further ahead than this is refused: a pin must never wait on a future clock. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

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

/** This machine, as a request names it: a random id and a name the owner reads on the card. */
export type MachineBinding = { id: string; name: string };

export type MachineRecord = MachineBinding & { format: typeof MACHINE_FORMAT; created: string };

type PinFile = {
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isoTime(value: unknown): value is string {
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
function exportBodyOf(raw: unknown): OwnerSeatExport | string {
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

/** The Touch ID card an export is signed under: what it does, and the fingerprint to compare. */
export function exportPrompt(fingerprint: string): string {
  return `Pin the owner seat on another machine — Share the owner seat's public keys with another machine. OK? — Fingerprint ${fingerprintText(fingerprint)}`;
}

/**
 * Builds and signs this machine's owner-seat export. The seat must be this machine's own (not a
 * pin), every signer's key is confirmed against the credential store, and the accepted names are
 * the entity's owner-signers policy. The signature is one Touch ID by an accepted Secure Enclave
 * signer, and it is checked under that signer's key before the export is returned.
 */
export function exportOwnerSeat(
  home: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  signerName?: string,
): { ok: true; signed: SignedOwnerSeatExport; fingerprint: string } | { ok: false; why: string } {
  if (ownerMachinePinned(home)) return { ok: false, why: "this machine's owner seat is pinned from another machine; the export is made on the machine that holds the signers" };
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered on this machine' };
  const accepted = acceptedSigners(home, record, now);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  const names = accepted.names.filter((name, index) => accepted.names.indexOf(name) === index && record.signers.some((s) => s.name === name));
  if (names.length === 0) return { ok: false, why: 'the owner-signers policy accepts none of the seat\'s registered signers' };
  for (const signer of record.signers) {
    const confirmed = confirmedSignerKey(signer, store);
    if (!confirmed.ok) return { ok: false, why: `signer "${signer.name}" cannot be confirmed (${confirmed.why})` };
  }
  const eligible = record.signers.filter((s) => s.type === 'mac-keystore' && names.includes(s.name));
  const signer = signerName === undefined
    ? (eligible.length === 1 ? eligible[0] : undefined)
    : record.signers.find((s) => s.name === signerName);
  if (signer === undefined) {
    return { ok: false, why: signerName === undefined
      ? (eligible.length === 0 ? 'no accepted device key of this machine can sign the export' : `name the signer with --signer (${eligible.map((s) => s.name).join(', ')})`)
      : `"${signerName}" is not a registered owner signer` };
  }
  if (signer.type !== 'mac-keystore') return { ok: false, why: `signer "${signer.name}" is a passkey; the export is signed by a device key of this machine` };
  if (!names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${names.join(', ')})` };
  const body: OwnerSeatExport = {
    format: OWNER_SEAT_EXPORT_FORMAT,
    team: record.team,
    entity: record.entity,
    // The record's own fields, and nothing else a file on disk might carry beside them.
    signers: record.signers.map((s) => ({
      name: s.name,
      type: s.type,
      public_key: s.public_key,
      label: s.label,
      ...(s.credential_id !== undefined ? { credential_id: s.credential_id } : {}),
      ...(s.rp_id !== undefined ? { rp_id: s.rp_id } : {}),
      added: s.added,
    })),
    accepted: names,
    exported_at: now.toISOString(),
  };
  const shaped = exportBodyOf(body);
  if (typeof shaped === 'string') return { ok: false, why: `the owner seat cannot be exported (${shaped})` };
  const fingerprint = ownerSeatFingerprint(body);
  const bytes = ownerSeatExportBytes(body);
  const signed = store.sign(signer.label, bytes, exportPrompt(fingerprint));
  if (!signed.ok) return { ok: false, why: signed.why };
  const sig = signatureOk(signer, signer.public_key, bytes, ownerSeatExportChallenge(body), signed.signature, undefined, 'owner seat export');
  if (!sig.ok) return sig;
  return { ok: true, signed: { owner_seat_export: body, signer: signer.name, signature: signed.signature }, fingerprint };
}

/** The fingerprint an export of this machine's own owner seat would carry now, or null when this
 *  machine holds none (or its owner-signers policy accepts none of its signers). Nothing is signed. */
export function localOwnerSeatFingerprint(home: string, now: Date = new Date()): string | null {
  if (ownerMachinePinned(home)) return null;
  const record = readOwnerSeat(home);
  if (record === null) return null;
  const accepted = acceptedSigners(home, record, now);
  if ('why' in accepted) return null;
  const names = accepted.names.filter((name, index) => accepted.names.indexOf(name) === index && record.signers.some((s) => s.name === name));
  if (names.length === 0) return null;
  return ownerSeatFingerprint({ team: record.team, entity: record.entity, signers: record.signers, accepted: names });
}

/** A machine's display name from its own name: lower case, plain characters, at most 63. */
export function defaultMachineName(raw: string = hostname()): string {
  const plain = raw.toLowerCase().split('.')[0]!.replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 63);
  return MACHINE_NAME_PATTERN.test(plain) ? plain : 'machine';
}

export function validMachineBinding(raw: unknown): raw is MachineBinding {
  return plainObject(raw)
    && typeof raw.id === 'string' && MACHINE_ID_PATTERN.test(raw.id)
    && typeof raw.name === 'string' && MACHINE_NAME_PATTERN.test(raw.name)
    && Object.keys(raw).every((key) => key === 'id' || key === 'name');
}

/** This machine's record, where the resolver keeps the owner state, or null when there is none or
 *  it cannot be read whole. */
export function readMachine(home: string): MachineRecord | null {
  const state = ownerStateOf(home);
  return state.kind === 'present' ? readMachineAt(state.place.machine) : null;
}

function readMachineAt(path: string): MachineRecord | null {
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

/** A system folder's entries are read by every account of the machine; an account's are its own. */
function modeFor(place: OwnerStatePlace): number {
  return place.kind === 'system' ? 0o644 : 0o600;
}

function writeExclusive(path: string, text: string, mode = 0o600): 'written' | 'exists' | 'failed' {
  let fd: number;
  try {
    fd = openSync(path, 'wx', mode);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
  try {
    // The mode asked for, whatever the process's file-creation mask: a system entry every
    // account must read is never left readable by its writer alone.
    if (mode !== 0o600) fchmodSync(fd, mode);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return 'written';
}

function replaceFile(path: string, text: string, mode = 0o600): boolean {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  if (writeExclusive(temporary, text, mode) !== 'written') return false;
  try {
    renameSync(temporary, path);
    return true;
  } catch {
    try { unlinkSync(temporary); } catch { /* already gone */ }
    return false;
  }
}

/** The machine record, made at the first pin in `place`: a random id, never reused, and a display name. */
function ensureMachine(place: OwnerStatePlace, name: string | undefined, now: Date): MachineRecord | string {
  const held = readMachineAt(place.machine);
  if (held !== null) return held;
  if (existsSync(place.machine)) return "this machine's record cannot be read; nothing was pinned";
  const chosen = name ?? defaultMachineName();
  if (!MACHINE_NAME_PATTERN.test(chosen)) return `"${chosen}" is not a machine name: lower case letters, digits, dots and dashes`;
  const record: MachineRecord = { format: MACHINE_FORMAT, id: `m_${randomBytes(12).toString('hex')}`, name: chosen, created: now.toISOString() };
  if (place.kind === 'account') mkdirSync(place.dir, { recursive: true, mode: 0o700 });
  const written = writeExclusive(place.machine, `${JSON.stringify(record, null, 2)}\n`, modeFor(place));
  if (written === 'exists') return readMachineAt(place.machine) ?? "this machine's record cannot be read; nothing was pinned";
  if (written === 'failed') return "this machine's record could not be written; nothing was pinned";
  return record;
}

/**
 * The owner seat this machine pinned, where the resolver keeps the owner state. `none` only when
 * the machine was never pinned. A machine pinned once whose pin is missing, and a pin that is not
 * a plain file, is too large, is not whole JSON, does not verify, disagrees with its own
 * fingerprint, or has no machine record beside it, are `refused`: never `none`, so damaging or
 * removing the pin turns no terminal back into the owner and admits no answer.
 */
export function readOwnerPin(home: string): OwnerPinRead {
  return readOwnerPinIn(ownerStateOf(home));
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

function sameSigner(a: OwnerSigner, b: OwnerSigner): boolean {
  return a.name === b.name && a.type === b.type && a.public_key === b.public_key && a.label === b.label
    && (a.credential_id ?? null) === (b.credential_id ?? null) && (a.rp_id ?? null) === (b.rp_id ?? null);
}

export type PinOutcome = {
  ok: true;
  /** `pinned`: the first pin (trust on first use). `repinned`: a changed set, signed by a signer
   *  already pinned. `same`: this set is pinned already, and nothing was written. */
  kind: 'pinned' | 'repinned' | 'same';
  /** Where the pin is kept: the system folder shared by every account, or this account's own. */
  place: 'system' | 'account';
  fingerprint: string;
  previous: string | null;
  team: string;
  signers: string[];
  machine: MachineRecord;
};

/**
 * Pins one owner-seat export on this machine. Who may ask is the command's question: the first pin
 * is the owner's, at a terminal on a machine with no pin yet; a re-pin is admitted by its signature.
 * Here: the export must verify; this machine must hold no owner seat of its own; a pin that cannot
 * be read is never replaced; the same fingerprint writes nothing; a changed set must be newer and
 * signed by a signer already pinned and accepted here.
 */
export function pinOwnerSeat(home: string, raw: unknown, now: Date = new Date(), options: { name?: string } = {}): PinOutcome | { ok: false; why: string } {
  if (existsSync(ownerSeatFile(home))) return { ok: false, why: `this machine has an owner seat of its own (${ownerSeatFile(home)}); a pin is for a machine that holds no owner signer` };
  const verified = verifyOwnerSeatExport(raw);
  if (!verified.ok) return { ok: false, why: verified.why };
  if (Date.parse(verified.body.exported_at) > now.getTime() + FUTURE_SKEW_MS) return { ok: false, why: `the export is dated ${verified.body.exported_at}, ahead of this machine's clock` };
  const state = ownerStateOf(home);
  // A machine whose accounts share one owner: the administrator pins in the system folder, the
  // first time into a folder its install set up, and no entity account ever does.
  const shared = state.kind === 'present' ? state.place.shared !== undefined : state.kind === 'refused' && state.setup !== undefined;
  if (shared && process.getuid?.() !== systemOwnerUid()) return { ok: false, why: "this machine's owner state is kept in the system folder for all its accounts; only its administrator pins there (sudo team owner-seat pin --from <file>, from the owner's own account); nothing was changed" };
  if (state.kind === 'refused' && state.setup === undefined) return { ok: false, why: `${state.why}; nothing was changed` };
  const place = state.kind === 'present' ? state.place : state.kind === 'refused' ? state.setup! : state.write;
  if (place === null) return { ok: false, why: 'this account has no home folder the pin can be kept in; nothing was pinned' };
  if (place.kind === 'system' && !shared) return { ok: false, why: "this machine's owner state is kept in the system folder; it is changed there, not by this command" };
  const current = state.kind === 'refused' ? { kind: 'none' as const } : readOwnerPin(home);
  if (current.kind === 'refused') return { ok: false, why: `${current.why}; nothing was changed` };
  if (current.kind === 'pinned') {
    const result = { team: verified.body.team, signers: verified.body.signers.map((s) => s.name), machine: current.machine, place: place.kind };
    if (current.fingerprint === verified.fingerprint) return { ok: true, kind: 'same', fingerprint: current.fingerprint, previous: current.fingerprint, ...result };
    const held = current.body.signers.find((s) => s.name === verified.signer.name);
    if (held === undefined || !sameSigner(held, verified.signer) || !current.body.accepted.includes(held.name)) {
      return { ok: false, why: `a changed owner seat needs an export signed by a signer already pinned here (${current.body.accepted.join(', ')}); "${verified.signer.name}" is not one, and nothing was changed` };
    }
    if (!(Date.parse(verified.body.exported_at) > Date.parse(current.body.exported_at))) {
      return { ok: false, why: `the export (${verified.body.exported_at}) is not newer than the one pinned here (${current.body.exported_at}); nothing was changed` };
    }
  }
  const machine = ensureMachine(place, options.name, now);
  if (typeof machine === 'string') return { ok: false, why: machine };
  const pin: PinFile = {
    format: OWNER_SEAT_PIN_FORMAT,
    fingerprint: verified.fingerprint,
    pinned_at: now.toISOString(),
    previous: current.kind === 'pinned' ? current.fingerprint : null,
    export: verified.signed,
  };
  if (place.kind === 'account') mkdirSync(place.dir, { recursive: true, mode: 0o700 });
  if (!replaceFile(place.pin, `${JSON.stringify(pin, null, 2)}\n`, modeFor(place))) return { ok: false, why: 'the pin could not be written; nothing was changed' };
  return {
    ok: true,
    kind: current.kind === 'pinned' ? 'repinned' : 'pinned',
    place: place.kind,
    fingerprint: verified.fingerprint,
    previous: pin.previous,
    team: verified.body.team,
    signers: verified.body.signers.map((s) => s.name),
    machine,
  };
}

const LEDGER_ENTRY = /^oa_[0-9a-f]{24}\.[a-z-]{1,40}$/;

/**
 * Spends one carried approval for one action in the ledger the resolver names: created once, never
 * replaced. A machine that is not pinned has no ledger here; a ledger that cannot be written —
 * the system folder's, which no command of this account writes, among them — spends nothing.
 */
export function claimInLedger(home: string, id: string, action: string, at: Date): { ok: true } | { ok: false; why: string } {
  const entry = `${id}.${action}`;
  if (!LEDGER_ENTRY.test(entry)) return { ok: false, why: `request ${id} cannot be spent for ${action}` };
  const state = ownerStateOf(home);
  if (state.kind !== 'present') return { ok: false, why: state.kind === 'refused' ? state.why : "this machine's owner seat is not pinned; there is no ledger to spend it in" };
  // A shared machine's ledger is the owner helper's: an approval is spent there through it, never here.
  if (state.place.shared !== undefined) return { ok: false, why: 'on this machine an approval is spent only by the owner helper; nothing was spent' };
  if (state.place.kind === 'account') {
    try {
      mkdirSync(state.place.ledger, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, why: 'the approval ledger cannot be made; nothing was spent' };
    }
  }
  const written = writeExclusive(join(state.place.ledger, entry), `${at.toISOString()}\n`);
  if (written === 'exists') return { ok: false, why: `request ${id} was already used for ${action}: an approval is single-use` };
  if (written === 'failed') return { ok: false, why: 'the approval ledger cannot be written; nothing was spent' };
  return { ok: true };
}

/** Whether the ledger has spent `id` — for `action`, or for any action. A ledger that cannot be
 *  read answers that it has. */
export function ledgerSpent(home: string, id: string, action?: string): boolean {
  const state = ownerStateOf(home);
  if (state.kind === 'refused') return true;
  if (state.kind === 'none') return false;
  try {
    return readdirSync(state.place.ledger).some((name) => (action === undefined ? name.startsWith(`${id}.`) : name === `${id}.${action}`));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** This machine as its owner requests name it, or null when its owner seat is not pinned (or the pin cannot be read). */
export function machineBindingOf(home: string): MachineBinding | null {
  const pin = readOwnerPin(home);
  return pin.kind === 'pinned' ? { id: pin.machine.id, name: pin.machine.name } : null;
}

/** The account a request names on a machine whose accounts share one owner, or null elsewhere
 *  (and when the owner state there cannot be read). */
export function accountBindingOf(home: string): string | null {
  const state = ownerStateOf(home);
  return state.kind === 'present' && state.place.shared !== undefined ? state.place.shared.account : null;
}

export function validAccountBinding(raw: unknown): raw is string {
  return typeof raw === 'string' && ACCOUNT_NAME_PATTERN.test(raw);
}

/**
 * Whether a request may run here, by the machine (and, on a machine whose accounts share one
 * owner, the account) it names. A request that names a machine runs only on that machine, which
 * must be pinned; on a pinned machine a request that names none is refused, because no answer
 * from the signer machine can have been bound to it. On a shared machine a request runs only for
 * the account it names. A machine with a local owner (no pin) runs its own unnamed requests as
 * before. Null when the request may run.
 */
export function requestMachineProblem(home: string, machine: unknown, id: string, account?: unknown): string | null {
  const here = accountBindingOf(home);
  if (account !== undefined && !validAccountBinding(account)) return `request ${id} names an account this build cannot read`;
  if (here !== null && account === undefined) return `request ${id} names no account; on this machine every owner request names the account it was made by (record it again with --request)`;
  if (account !== undefined && account !== here) return here === null ? `request ${id} is for account ${account} of a machine whose accounts share one owner; it runs only there` : `request ${id} is for account ${account}, not this one (${here})`;
  const pinned = ownerMachinePinned(home);
  if (machine === undefined) {
    return pinned ? `request ${id} names no machine; on a machine whose owner signs on another machine, every owner request names this machine (record it again with --request)` : null;
  }
  if (!validMachineBinding(machine)) return `request ${id} names a machine this build cannot read`;
  if (!pinned) return `request ${id} is for machine ${machine.name} (${machine.id}); it runs only there`;
  const record = readMachine(home);
  if (record === null) return `this machine has no readable machine record, so request ${id} for ${machine.name} (${machine.id}) cannot be matched`;
  if (record.id !== machine.id) return `request ${id} is for machine ${machine.name} (${machine.id}), not this one (${record.name}, ${record.id})`;
  return null;
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
