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

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { loadAndResolvePolicyChain, writePolicySet } from '../policy/sources.ts';
import { ownerMachinePinned } from './owner-pin-path.ts';
import {
  OWNER_SEAT_ANSWER_DOMAIN,
  ownerSeatAnswerBytes,
  ownerSeatPublicKey,
  signatureOk,
  webauthnChallenge,
  type OwnerSeatAnswer,
  type OwnerSigner,
  type SignedOwnerAnswer,
  type SignerType,
} from './owner-signature.ts';

export { OWNER_SEAT_ANSWER_DOMAIN, ownerSeatAnswerBytes, ownerSeatPublicKey, signatureOk, webauthnChallenge };
export type { OwnerSeatAnswer, OwnerSigner, SignedOwnerAnswer, SignerType };

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
  /** Signs every message under one user-presence prompt with `reason`, one signature per message
   *  in order. Absent, or `unsupported` (a helper older than this build), each message is signed
   *  with `sign` and its own prompt. */
  signMany?: (label: string, messages: readonly Buffer[], reason: string) => { ok: true; signatures: string[] } | { ok: false; why: string; unsupported?: true };
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
    signMany: (label, messages, reason) => {
      try {
        const out = run(['sign-many', label, reason], messages.map((message) => message.toString('hex')).join('\n'));
        const signatures = out.split('\n').map((line) => line.trim());
        if (signatures.length !== messages.length || !signatures.every((one) => /^[0-9a-f]+$/.test(one))) return { ok: false, why: 'the helper did not return one signature per answer' };
        return { ok: true, signatures };
      } catch (error) {
        const said = String((error as { stderr?: string }).stderr ?? '');
        if (said.includes('unknown command sign-many')) return { ok: false, why: 'the credential helper predates signing several answers at once', unsupported: true };
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

const SIGNER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

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
/** The credential-store label of one signer. The store is per user, not per HOME, so the label
 *  carries a short digest of the home folder: two homes (a test home, a second profile) never
 *  share or collide on one key. A record keeps its own label, so seats registered earlier hold. */
export function ownerSignerLabel(home: string, team: string, signer: string): string {
  let at = home;
  try {
    at = realpathSync(home);
  } catch {}
  return `owner-${team}-${signer}-${createHash('sha256').update(at).digest('hex').slice(0, 8)}`;
}

export function registerOwnerSeat(
  home: string,
  input: { team: string; entity?: string; signer: string },
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
): { ok: true; record: OwnerSeatRecord; path: string } | { ok: false; why: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.team)) return { ok: false, why: `"${input.team}" is not a team name` };
  if (!SIGNER_NAME.test(input.signer)) return { ok: false, why: `"${input.signer}" is not a signer name` };
  if (existsSync(ownerSeatFile(home))) return { ok: false, why: `an owner seat is already registered (${ownerSeatFile(home)}); add a signer with --add-owner-signer` };
  if (ownerMachinePinned(home)) return { ok: false, why: "this machine's owner seat is pinned from another machine; the owner's signers live on the machine that holds them" };
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available; build the helper: swiftc helpers/owner-seat-keystore.swift -o ${ownerSeatHelperPath(home)}` };
  const label = ownerSignerLabel(home, input.team, input.signer);
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
  if (ownerMachinePinned(home)) return { ok: false, why: "this machine's owner seat is pinned from another machine; a signer is added on the machine that holds the seat, then exported and pinned again" };
  if (!SIGNER_NAME.test(input.signer)) return { ok: false, why: `"${input.signer}" is not a signer name` };
  if (record.signers.some((s) => s.name === input.signer)) return { ok: false, why: `signer "${input.signer}" is already registered` };
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const label = ownerSignerLabel(home, record.team, input.signer);
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

/** The signer names an entity accepts: its `owner-signers` policy. No policy, no signer (approvals.md rule 6: no fallback).
 *  `entity` is the entity the approved request acts on; it defaults to the owner seat's own. */
export function acceptedSigners(home: string, record: OwnerSeatRecord, now: Date = new Date(), entity: string = record.entity): { names: string[]; source: 'policy' } | { why: string; missing?: true } {
  let chain;
  try {
    chain = loadAndResolvePolicyChain({ home, entity, projectId: null, teamRoot: null, team: null }, { now, upToLevel: 'entity' });
  } catch {
    return { why: 'the owner-signer policy cannot be read' };
  }
  if (!chain.ok) return { why: chain.refusals[0]?.message ?? 'the owner-signer policy cannot be read or verified' };
  const mode = chain.policies['owner-signer-mode']?.value;
  if (mode !== undefined && mode !== 'any') return { why: `owner-signer-mode "${String(mode)}" is not one this build reads` };
  const listed = chain.policies['owner-signers']?.value;
  if (Array.isArray(listed)) return { names: listed.filter((n): n is string => typeof n === 'string'), source: 'policy' };
  const names = record.signers.map((x) => x.name).join(',') || '<signer>';
  return { missing: true, why: `no owner-signers policy is set for entity "${entity}", so no owner-seat answer is accepted yet. To accept your registered signers, run: team policy set entity owner-signers ${names} --entity ${entity}` };
}

/**
 * Makes `signer` one the entity's `owner-signers` policy accepts: writes the policy with it when
 * none is set, or adds it to the list. Only the owner-gated registration commands call this, so
 * registering a signer is the one explicit step that makes it count (no implicit fallback).
 */
export function acceptOwnerSigner(home: string, entity: string, signer: string, now: Date = new Date()): { ok: true; names: string[] } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered' };
  const current = acceptedSigners(home, record, now, entity);
  // Only an absent policy is written fresh; one that cannot be read or verified is left for the owner.
  if ('why' in current && current.missing !== true) return { ok: false, why: current.why };
  const names = 'names' in current ? current.names : [];
  if (names.includes(signer)) return { ok: true, names };
  const next = [...names, signer];
  const wrote = writePolicySet(home, { level: 'entity', target: entity, name: 'owner-signers', value: next }, { now });
  return wrote.ok ? { ok: true, names: next } : { ok: false, why: wrote.why };
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
  return writeExclusive(path, inboxText(message)) === 'written' ? path : null;
}

/** Rewrites the one card for `request_id`. A merge of concurrent requests keeps a single inbox file. */
export function replaceOwnerSeatMessage(home: string, message: { request_id: string; params_sha256: string; text: string; summary: unknown; at: string; kind?: string }): string | null {
  if (readOwnerSeat(home) === null) return null;
  const path = join(ownerSeatInbox(home), `${message.request_id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, inboxText(message), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    return path;
  } catch {
    return null;
  }
}

function inboxText(message: { request_id: string; params_sha256: string; text: string; summary: unknown; at: string; kind?: string }): string {
  return `${JSON.stringify({ to: 'owner', kind: message.kind ?? 'grant-confirmation', ...message }, null, 2)}\n`;
}

export function ownerSeatMessages(home: string): Array<{ request_id: string; text: string; at: string }> {
  try {
    return readdirSync(ownerSeatInbox(home)).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(readFileSync(join(ownerSeatInbox(home), n), 'utf8')));
  } catch {
    return [];
  }
}

/** The signer of a signed record, confirmed: registered, accepted by the entity's owner-signers
 *  policy, and its key read back from the credential store. */
function verifyingSigner(
  home: string,
  record: OwnerSeatRecord,
  signerName: string,
  store: OwnerSeatKeyStore,
  now: Date,
  entity: string | undefined,
): { ok: true; signer: OwnerSigner; publicKey: string } | { ok: false; why: string } {
  const signer = record.signers.find((s) => s.name === signerName);
  if (signer === undefined) return { ok: false, why: `"${signerName}" is not a registered owner signer` };
  const accepted = acceptedSigners(home, record, now, entity ?? record.entity);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  if (!accepted.names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${accepted.names.join(', ') || 'none'})` };
  const confirmed = confirmedSignerKey(signer, store);
  if (!confirmed.ok) return confirmed;
  return { ok: true, signer, publicKey: confirmed.publicKey };
}

/**
 * Verifies one signed answer: its signer is registered and accepted by policy, the signer's key is
 * confirmed against the credential store, and the signature (or WebAuthn assertion, with its
 * challenge, relying party and user-presence flag) holds over exactly this answer.
 */
export function verifyOwnerAnswer(home: string, signed: SignedOwnerAnswer, store: OwnerSeatKeyStore, now: Date = new Date(), entity?: string): { ok: true; answer: OwnerSeatAnswer; signer: OwnerSigner } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'an owner-seat answer exists but no owner seat is registered to verify it' };
  const answer = signed.owner_seat_answer;
  if (answer === undefined || typeof signed.signature !== 'string' || typeof signed.signer !== 'string') return { ok: false, why: 'the owner-seat answer is not signed' };
  const who = verifyingSigner(home, record, signed.signer, store, now, entity);
  if (!who.ok) return who;
  if (answer.team !== record.team || answer.seat !== 'owner') return { ok: false, why: 'the owner-seat answer names another seat' };
  const sig = signatureOk(who.signer, who.publicKey, ownerSeatAnswerBytes(answer), webauthnChallenge(answer), signed.signature, signed.webauthn, 'answer');
  if (!sig.ok) return sig;
  return { ok: true, answer, signer: who.signer };
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
  // Before any Touch ID prompt or passkey challenge: a signer the owner-signers policy does not
  // name cannot produce an answer `--approval` would accept. The page reads this refusal as the
  // challenge error and never starts the ceremony.
  const accepted = acceptedSigners(home, record);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  if (!accepted.names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${accepted.names.join(', ') || 'none'})` };
  if (signer.type === 'webauthn') {
    if (assertion === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey: sign challenge ${webauthnChallenge(answer)} and pass --assertion <file>` };
    return { ok: true, signed: { owner_seat_answer: answer, signer: signer.name, signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } } };
  }
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const signed = store.sign(signer.label, ownerSeatAnswerBytes(answer), reason);
  if (!signed.ok) return signed;
  return { ok: true, signed: { owner_seat_answer: answer, signer: signer.name, signature: signed.signature } };
}

/** Which signer an answer signed with `signerName` is signed by: the one named, or the only one. */
export function resolvedOwnerSigner(home: string, signerName: string | undefined): { ok: true; name: string } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered: the owner runs team grant --add-owner-seat --team <team> --signer <name>' };
  const signer = signerName === undefined
    ? (record.signers.length === 1 ? record.signers[0] : undefined)
    : record.signers.find((s) => s.name === signerName);
  if (signer === undefined) return { ok: false, why: signerName === undefined ? `name the signer with --signer (${record.signers.map((s) => s.name).join(', ')})` : `"${signerName}" is not a registered owner signer` };
  return { ok: true, name: signer.name };
}

/**
 * Several answers, and any further messages (a batch manifest), signed by one signer under one
 * user-presence prompt (`signMany`), each its own signature over its own bytes, so each answer
 * verifies exactly as an answer signed alone. The same checks as `signOwnerAnswer` come first,
 * before any prompt. A passkey signs one challenge per ceremony, so it is refused here; a store
 * with no `signMany`, or a helper older than this build, signs each message with its own prompt,
 * and `prompts` says how many there were.
 */
export function signOwnerAnswers(home: string, answers: readonly OwnerSeatAnswer[], signerName: string | undefined, store: OwnerSeatKeyStore, reason: string, extra: readonly Buffer[] = []): { ok: true; signed: SignedOwnerAnswer[]; extraSignatures: string[]; signer: string; prompts: number } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered: the owner runs team grant --add-owner-seat --team <team> --signer <name>' };
  const named = resolvedOwnerSigner(home, signerName);
  if (!named.ok) return named;
  const signer = record.signers.find((s) => s.name === named.name)!;
  const accepted = acceptedSigners(home, record);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  if (!accepted.names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${accepted.names.join(', ') || 'none'})` };
  if (signer.type === 'webauthn') return { ok: false, why: `signer "${signer.name}" is a passkey, which signs one request per ceremony: answer each request on the owner page, or sign them one by one with --assertion` };
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const messages = [...answers.map((answer) => ownerSeatAnswerBytes(answer)), ...extra];
  let signatures: string[];
  let prompts: number;
  const together = store.signMany?.(signer.label, messages, reason);
  if (together !== undefined && together.ok) {
    signatures = together.signatures;
    prompts = 1;
  } else if (together !== undefined && !together.unsupported) {
    return together;
  } else {
    signatures = [];
    for (const message of messages) {
      const one = store.sign(signer.label, message, reason);
      if (!one.ok) return signatures.length === 0 ? one : { ok: false, why: `${one.why}; nothing was recorded` };
      signatures.push(one.signature);
    }
    prompts = messages.length;
  }
  return {
    ok: true,
    signed: answers.map((answer, index) => ({ owner_seat_answer: answer, signer: signer.name, signature: signatures[index]! })),
    extraSignatures: signatures.slice(answers.length),
    signer: signer.name,
    prompts,
  };
}

// The later answer: a signed deferral is not an approval. It hides one request until a return
// instant, extends that request's answer window by one normal window after it, and changes nothing
// else. A signed record names the request id and its parameter hash, a verified record alone counts,
// and no record may put the return instant past the request's creation + 7 days.

export const OWNER_SEAT_LATER_DOMAIN = 'team-owner-seat-later-v1\n';
export const OWNER_SEAT_LATER_CAP_MS = 7 * 24 * 60 * 60 * 1000;

export type OwnerSeatLater = {
  kind: 'grant' | 'team-create' | 'owner-action';
  request_id: string;
  params_sha256: string;
  /** The return instant: the item is hidden before it and listed at it. */
  until: string;
  /** The word the owner answered (`later`, `tomorrow`, a weekday), kept for display. */
  word: string;
  /** The blocked team, when the request names one; team-create has none. */
  team: string | null;
  seat: 'owner';
  at: string;
};

export function ownerSeatLaterBytes(later: OwnerSeatLater): Buffer {
  const canonical = {
    kind: later.kind, request_id: later.request_id, params_sha256: later.params_sha256, until: later.until,
    word: later.word, team: later.team ?? null, seat: later.seat, at: later.at,
  };
  return Buffer.from(OWNER_SEAT_LATER_DOMAIN + JSON.stringify(canonical), 'utf8');
}

/** The WebAuthn challenge a deferral is signed under: base64url SHA-256 of the record bytes. */
export function webauthnLaterChallenge(later: OwnerSeatLater): string {
  return createHash('sha256').update(ownerSeatLaterBytes(later)).digest('base64url');
}

export type SignedOwnerLater = {
  owner_seat_later: OwnerSeatLater;
  signer: string;
  signature: string;
  /** webauthn signers: the assertion's authenticator data and client data JSON (base64url). */
  webauthn?: { authenticator_data: string; client_data_json: string };
};

function isLaterRecord(value: unknown): value is OwnerSeatLater {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.kind === 'grant' || v.kind === 'team-create' || v.kind === 'owner-action')
    && typeof v.request_id === 'string' && v.request_id !== ''
    && typeof v.params_sha256 === 'string'
    && typeof v.until === 'string' && Number.isFinite(Date.parse(v.until))
    && typeof v.word === 'string'
    && (v.team === null || typeof v.team === 'string')
    && v.seat === 'owner'
    && typeof v.at === 'string' && Number.isFinite(Date.parse(v.at));
}

/**
 * Verifies one signed deferral: its signer is registered and accepted by policy, the signer's key is
 * confirmed against the credential store, and the signature holds over exactly this record. The
 * return instant is not judged here; the 7-day cap is applied where the record is read.
 */
export function verifyOwnerLater(home: string, signed: SignedOwnerLater, store: OwnerSeatKeyStore, now: Date = new Date(), entity?: string): { ok: true; later: OwnerSeatLater; signer: OwnerSigner } | { ok: false; why: string } {
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'an owner-seat deferral exists but no owner seat is registered to verify it' };
  if (signed === null || typeof signed !== 'object') return { ok: false, why: 'the owner-seat deferral is not signed' };
  const later = signed.owner_seat_later as unknown;
  if (!isLaterRecord(later) || typeof signed.signature !== 'string' || typeof signed.signer !== 'string') return { ok: false, why: 'the owner-seat deferral is not signed' };
  const who = verifyingSigner(home, record, signed.signer, store, now, entity);
  if (!who.ok) return who;
  if (later.seat !== 'owner') return { ok: false, why: 'the owner-seat deferral names another seat' };
  const sig = signatureOk(who.signer, who.publicKey, ownerSeatLaterBytes(later), webauthnLaterChallenge(later), signed.signature, signed.webauthn, 'deferral');
  if (!sig.ok) return sig;
  return { ok: true, later, signer: who.signer };
}

/**
 * Signs one deferral with the owner seat. The cap is judged first, before the signer is chosen or
 * any user-presence prompt or passkey challenge starts: an instant past the request's creation +
 * 7 days is refused outright, so no gesture is spent on a record the readers would never honour.
 */
export function signOwnerLater(
  home: string,
  later: OwnerSeatLater,
  created: string,
  signerName: string | undefined,
  store: OwnerSeatKeyStore,
  reason: string,
  assertion?: { authenticator_data: string; client_data_json: string; signature: string },
  now: Date = new Date(),
): { ok: true; signed: SignedOwnerLater } | { ok: false; why: string } {
  const from = Date.parse(created);
  const until = Date.parse(later.until);
  if (!Number.isFinite(from)) return { ok: false, why: `"${created}" is not the request's creation time` };
  if (!Number.isFinite(until)) return { ok: false, why: `"${later.until}" is not a return time` };
  if (until > from + OWNER_SEAT_LATER_CAP_MS) {
    return { ok: false, why: `the return time ${later.until} is past the 7-day cap: no later than ${new Date(from + OWNER_SEAT_LATER_CAP_MS).toISOString()}` };
  }
  const record = readOwnerSeat(home);
  if (record === null) return { ok: false, why: 'no owner seat is registered: the owner runs team grant --add-owner-seat --team <team> --signer <name>' };
  const signer = signerName === undefined
    ? (record.signers.length === 1 ? record.signers[0] : undefined)
    : record.signers.find((s) => s.name === signerName);
  if (signer === undefined) return { ok: false, why: signerName === undefined ? `name the signer with --signer (${record.signers.map((s) => s.name).join(', ')})` : `"${signerName}" is not a registered owner signer` };
  const accepted = acceptedSigners(home, record, now);
  if ('why' in accepted) return { ok: false, why: accepted.why };
  if (!accepted.names.includes(signer.name)) return { ok: false, why: `signer "${signer.name}" is not accepted by the owner-signers policy (${accepted.names.join(', ') || 'none'})` };
  if (signer.type === 'webauthn') {
    if (assertion === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey: sign challenge ${webauthnLaterChallenge(later)} and pass --assertion <file>` };
    return { ok: true, signed: { owner_seat_later: later, signer: signer.name, signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } } };
  }
  if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
  const signed = store.sign(signer.label, ownerSeatLaterBytes(later), reason);
  if (!signed.ok) return signed;
  return { ok: true, signed: { owner_seat_later: later, signer: signer.name, signature: signed.signature } };
}

/** One request's binding, as its own record states it: the signed parameter hash, the creation
 *  time (the cap counts from it), and the window's end (`null` when it never expires). */
export type AnswerWindow = { params_sha256: string; created: string; expires_at: string | null };

/**
 * The verified return instant of `id`'s deferral, clamped to the request's creation + 7 days, or
 * `null` when there is no record that verifies and binds to this id and parameter hash. Never a
 * plain read: a forged, unsigned, misbound or unaccepted record returns `null`.
 */
export function deferralUntil(
  home: string,
  folder: string,
  id: string,
  window: AnswerWindow,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  entity?: string,
): number | null {
  let signed: SignedOwnerLater;
  try {
    signed = JSON.parse(readFileSync(join(folder, `${id}.later.json`), 'utf8')) as SignedOwnerLater;
  } catch {
    return null;
  }
  const verified = verifyOwnerLater(home, signed, store, now, entity);
  if (!verified.ok) return null;
  const later = verified.later;
  if (later.request_id !== id || later.params_sha256 !== window.params_sha256) return null;
  const until = Date.parse(later.until);
  const created = Date.parse(window.created);
  if (!Number.isFinite(until) || !Number.isFinite(created)) return null;
  return Math.min(until, created + OWNER_SEAT_LATER_CAP_MS);
}

/**
 * The instant one request stops accepting an answer, as every reader compares it:
 * `expires_at`, extended by a verified deferral to one normal answer window after the clamped
 * return instant — `max(expires_at, min(until, created + 7 days) + ttlMs)`. The extra window is
 * required because readers refuse at `deadline <= now`; without it a card would return unanswerable.
 * A request that never expires (`null`) stays that way, and a record that does not verify changes
 * nothing.
 */
export function answerDeadline(
  home: string,
  folder: string,
  id: string,
  window: AnswerWindow,
  store: OwnerSeatKeyStore,
  now: Date,
  ttlMs: number,
  entity?: string,
): number {
  if (window.expires_at === null) return Infinity;
  const base = Date.parse(window.expires_at);
  const until = deferralUntil(home, folder, id, window, store, now, entity);
  if (until === null) return base;
  return Math.max(base, until + ttlMs);
}
