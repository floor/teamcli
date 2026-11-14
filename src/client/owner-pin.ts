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

import { randomBytes } from 'node:crypto';
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
import { MACHINE_ID_PATTERN, MACHINE_NAME_PATTERN, validAccountBinding, validMachineBinding, type MachineBinding } from './owner-request-record.ts';

export { MACHINE_ID_PATTERN, MACHINE_NAME_PATTERN, validAccountBinding, validMachineBinding };
export type { MachineBinding };
import {
  CARRIED_FILE_MAX_BYTES,
  exportBodyOf,
  fingerprintText,
  MACHINE_FORMAT,
  OWNER_SEAT_EXPORT_FORMAT,
  OWNER_SEAT_PIN_FORMAT,
  ownerSeatExportBytes,
  ownerSeatExportChallenge,
  ownerSeatFingerprint,
  readMachineAt,
  readOwnerPinIn,
  verifyOwnerSeatExport,
  verifyPinnedOwnerAnswer,
  type MachineRecord,
  type OwnerPin,
  type OwnerPinRead,
  type OwnerSeatExport,
  type PinFile,
  type SignedOwnerSeatExport,
} from './owner-pin-verify.ts';

export { CARRIED_FILE_MAX_BYTES, fingerprintText, MACHINE_FORMAT, OWNER_SEAT_EXPORT_FORMAT, OWNER_SEAT_PIN_FORMAT, ownerSeatExportBytes, ownerSeatExportChallenge, ownerSeatFingerprint, readOwnerPinIn, verifyOwnerSeatExport, verifyPinnedOwnerAnswer };
export type { MachineRecord, OwnerPin, OwnerPinRead, OwnerSeatExport, SignedOwnerSeatExport };
import { ownerMachinePinned, ownerPinCommand, ownerStateOf, systemOwnerUid, type OwnerStatePlace, type OwnerStateRead } from './owner-pin-path.ts';

/** An export dated further ahead than this is refused: a pin must never wait on a future clock. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

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

/** This machine's record, where the resolver keeps the owner state, or null when there is none or
 *  it cannot be read whole. */
export function readMachine(home: string): MachineRecord | null {
  const state = ownerStateOf(home);
  return state.kind === 'present' ? readMachineAt(state.place.machine) : null;
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
  if (shared && process.getuid?.() !== systemOwnerUid()) return { ok: false, why: `this machine's owner state is kept in the system folder for all its accounts; only its administrator pins there, from the owner's own account: ${ownerPinCommand()}; nothing was changed` };
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
