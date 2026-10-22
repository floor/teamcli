// The `security-profile` policy: which security rules are relaxed on this machine, signed by the
// owner's own device.
//
// Every relaxable rule has an id (SECURITY_RULES). A guard never asks "is this dev mode?"; it asks
// `ruleRelaxed(home, id)`, and the answer comes only from the signed profile record. The profile is
// `strict` (nothing relaxed, the default) or `relaxed` (alias `dev`, every rule in the preset).
//
// The one anchor that is never relaxable: the record itself. It is signed by an owner-seat signer
// (the Secure Enclave key behind Touch ID, or a passkey on the owner's phone), it must carry an
// expiry (at most MAX_PROFILE_DAYS ahead), and every set, refusal and use is appended to an audit
// log. A record that is missing, malformed, unsigned, expired, or whose signer key the credential
// store does not confirm relaxes nothing: the profile reads as strict (fail closed). An agent can
// prepare a proposal, but only the owner's device can produce the signature that makes it count.

import { createHash, verify as cryptoVerify } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { confirmedSignerKey, ownerSeatPublicKey, readOwnerSeat, type OwnerSeatKeyStore, type OwnerSigner } from '../client/owner-seat.ts';

export const SECURITY_RULES = {
  'team-create.owner-answer': 'team init --execute needs a per-request owner-seat answer (oui/always)',
  'grant.owner-answer.low-risk': 'a low-risk grant needs a per-request owner-seat answer',
  'approval.standing-auto': 'a standing (always) approval must be confirmed before it applies',
  'gate.owner-terminal': 'owner-only steps must run from an owner terminal outside herdr',
  'signer.presence-per-action': 'each approved action needs its own Touch ID / passkey signature',
} as const;
export type SecurityRuleId = keyof typeof SECURITY_RULES;

/** Never relaxable, whatever a record lists: the record's own signature, expiry and audit. */
export const SECURITY_ANCHORS = ['policy.owner-signed-write', 'policy.signature-verify', 'policy.expiry'] as const;

export const SECURITY_PROFILES = ['strict', 'relaxed'] as const;
export type SecurityProfileName = (typeof SECURITY_PROFILES)[number];
export const PROFILE_PRESETS: Record<SecurityProfileName, SecurityRuleId[]> = {
  strict: [],
  relaxed: Object.keys(SECURITY_RULES) as SecurityRuleId[],
};
export const MAX_PROFILE_DAYS = 30;
export const SECURITY_PROFILE_DOMAIN = 'team-security-profile-v1\n';

export type SecurityProfileBody = {
  format: 1;
  policy: 'security-profile';
  profile: SecurityProfileName;
  relaxed: SecurityRuleId[];
  team: string;
  signer: string;
  reason: string;
  set_at: string;
  expires: string;
  generation: number;
};
export type SignedSecurityProfile = SecurityProfileBody & {
  signature: string;
  webauthn?: { authenticator_data: string; client_data_json: string };
};

export type SecurityProfileState =
  | { profile: 'strict'; source: 'default'; note: null }
  | { profile: 'strict'; source: 'refused'; note: string }
  | { profile: SecurityProfileName; source: 'record'; record: SignedSecurityProfile; note: null };

export function securityProfilePath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'security-profile.json');
}
export function securityProfileProposalPath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'security-profile.proposal.json');
}
export function securityProfileAuditPath(home: string = homedir()): string {
  return join(home, '.config', 'team', 'security-profile.log');
}

export function profileNameOf(word: string): SecurityProfileName | null {
  if (word === 'strict') return 'strict';
  if (word === 'relaxed' || word === 'dev') return 'relaxed';
  return null;
}

export function securityProfileBytes(body: SecurityProfileBody): Buffer {
  const canonical = {
    format: body.format, policy: body.policy, profile: body.profile, relaxed: [...body.relaxed].sort(), team: body.team,
    signer: body.signer, reason: body.reason, set_at: body.set_at, expires: body.expires, generation: body.generation,
  };
  return Buffer.from(SECURITY_PROFILE_DOMAIN + JSON.stringify(canonical), 'utf8');
}

/** The WebAuthn challenge a passkey signs for this body: base64url SHA-256 of its bytes. */
export function securityProfileChallenge(body: SecurityProfileBody): string {
  return createHash('sha256').update(securityProfileBytes(body)).digest('base64url');
}

export function audit(home: string, event: string, fields: Record<string, unknown>, now: Date = new Date()): void {
  try {
    mkdirSync(dirname(securityProfileAuditPath(home)), { recursive: true, mode: 0o700 });
    appendFileSync(securityProfileAuditPath(home), `${JSON.stringify({ at: now.toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // the audit is best effort for reads; a write path checks its own result
  }
}

function ecdsaOk(publicKey: string, data: Buffer, signature: string): boolean {
  const key = ownerSeatPublicKey(publicKey);
  if (key === null || !/^[0-9a-f]+$/.test(signature)) return false;
  try {
    return cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function verifySignature(body: SecurityProfileBody, signed: { signature: string; webauthn?: { authenticator_data: string; client_data_json: string } }, signer: OwnerSigner, publicKey: string): string | null {
  if (signer.type === 'mac-keystore') return ecdsaOk(publicKey, securityProfileBytes(body), signed.signature) ? null : 'the signature does not verify under the owner signer';
  const w = signed.webauthn;
  if (w === undefined) return 'a passkey signer needs an assertion';
  const authData = Buffer.from(w.authenticator_data, 'base64url');
  const clientJson = Buffer.from(w.client_data_json, 'base64url');
  let clientData: { type?: string; challenge?: string };
  try {
    clientData = JSON.parse(clientJson.toString('utf8'));
  } catch {
    return 'the passkey assertion carries no readable client data';
  }
  if (clientData.type !== 'webauthn.get' || clientData.challenge !== securityProfileChallenge(body)) return 'the passkey assertion is not over this profile';
  if (authData.length < 37 || !authData.subarray(0, 32).equals(createHash('sha256').update(signer.rp_id ?? '').digest())) return 'the passkey assertion is for another relying party';
  if ((authData[32]! & 0x01) === 0) return 'the passkey assertion carries no user presence';
  return ecdsaOk(publicKey, Buffer.concat([authData, createHash('sha256').update(clientJson).digest()]), signed.signature) ? null : 'the passkey assertion does not verify';
}

function bodyProblem(body: SecurityProfileBody, now: Date): string | null {
  if (body.format !== 1 || body.policy !== 'security-profile') return 'not a security-profile record';
  if (!SECURITY_PROFILES.includes(body.profile)) return `unknown profile "${String(body.profile)}"`;
  if (!Array.isArray(body.relaxed) || body.relaxed.some((id) => !(id in SECURITY_RULES))) return 'the record lists an unknown rule id';
  const expires = Date.parse(body.expires);
  const setAt = Date.parse(body.set_at);
  if (!Number.isFinite(expires) || !Number.isFinite(setAt)) return 'the record has no readable expiry';
  if (expires - setAt > MAX_PROFILE_DAYS * 86_400_000) return `the expiry is more than ${MAX_PROFILE_DAYS} days after signing`;
  if (expires <= now.getTime()) return `expired at ${body.expires}`;
  return null;
}

function verifyRecord(home: string, record: SignedSecurityProfile, store: OwnerSeatKeyStore, now: Date): string | null {
  const problem = bodyProblem(record, now);
  if (problem !== null) return problem;
  const seat = readOwnerSeat(home);
  if (seat === null) return 'no owner seat is registered to verify it';
  if (seat.team !== record.team) return 'the record names another owner seat';
  const signer = seat.signers.find((s) => s.name === record.signer);
  if (signer === undefined) return `"${record.signer}" is not a registered owner signer`;
  const confirmed = confirmedSignerKey(signer, store);
  if (!confirmed.ok) return confirmed.why;
  const { signature, webauthn, ...body } = record;
  return verifySignature(body, { signature, ...(webauthn !== undefined ? { webauthn } : {}) }, signer, confirmed.publicKey);
}

/** Reads and verifies the machine's profile. Anything unverifiable reads as strict. */
export function readSecurityProfile(home: string, store: OwnerSeatKeyStore, now: Date = new Date()): SecurityProfileState {
  const path = securityProfilePath(home);
  if (!existsSync(path)) return { profile: 'strict', source: 'default', note: null };
  let record: SignedSecurityProfile;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as SignedSecurityProfile;
  } catch {
    return { profile: 'strict', source: 'refused', note: 'the security-profile record is unreadable; strict applies' };
  }
  const why = verifyRecord(home, record, store, now);
  if (why !== null) return { profile: 'strict', source: 'refused', note: `the security-profile record does not count (${why}); strict applies` };
  return { profile: record.profile, source: 'record', record, note: null };
}

/**
 * The one question guards ask. `true` only when a verified, unexpired, owner-signed record lists
 * the rule. Each relaxed use is audited with the rule id and what it skipped.
 */
export function ruleRelaxed(home: string, rule: SecurityRuleId, store: OwnerSeatKeyStore, context: { now?: Date; what?: string } = {}): boolean {
  const now = context.now ?? new Date();
  const state = readSecurityProfile(home, store, now);
  if (state.source !== 'record' || !state.record.relaxed.includes(rule)) return false;
  audit(home, 'rule-relaxed', { rule, profile: state.profile, expires: state.record.expires, ...(context.what !== undefined ? { what: context.what } : {}) }, now);
  return true;
}

/** One line for `team status` / `team security-profile`. */
export function securityProfileLine(state: SecurityProfileState): string {
  if (state.source === 'default') return 'security profile: strict (default; every rule enforced)';
  if (state.source === 'refused') return `security profile: strict (${state.note})`;
  if (state.profile === 'strict') return `security profile: strict (signed by ${state.record.signer}, until ${state.record.expires})`;
  return `SECURITY PROFILE: RELAXED: ${state.record.relaxed.length} rules relaxed (${state.record.relaxed.join(', ')}) until ${state.record.expires}, signed by owner signer ${state.record.signer}`;
}

/** An agent prepares the body; nothing counts until the owner's device signs it. */
export function proposeSecurityProfile(
  home: string,
  input: { profile: SecurityProfileName; days: number; reason: string; signer?: string },
  now: Date = new Date(),
): { ok: true; body: SecurityProfileBody; challenge: string; path: string } | { ok: false; why: string } {
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered: register it first (team grant --add-owner-seat)' };
  if (!Number.isFinite(input.days) || input.days <= 0 || input.days > MAX_PROFILE_DAYS) return { ok: false, why: `the expiry must be 1 to ${MAX_PROFILE_DAYS} days` };
  const signer = input.signer === undefined ? (seat.signers.length === 1 ? seat.signers[0] : undefined) : seat.signers.find((s) => s.name === input.signer);
  if (signer === undefined) return { ok: false, why: input.signer === undefined ? `name the signer (${seat.signers.map((s) => s.name).join(', ')})` : `"${input.signer}" is not a registered owner signer` };
  let generation = 1;
  try {
    generation = (JSON.parse(readFileSync(securityProfilePath(home), 'utf8')) as { generation?: number }).generation! + 1 || 1;
  } catch {
    generation = 1;
  }
  const body: SecurityProfileBody = {
    format: 1, policy: 'security-profile', profile: input.profile, relaxed: PROFILE_PRESETS[input.profile], team: seat.team, signer: signer.name,
    reason: input.reason.slice(0, 200), set_at: now.toISOString(), expires: new Date(now.getTime() + input.days * 86_400_000).toISOString(), generation,
  };
  const path = securityProfileProposalPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ ...body, challenge: securityProfileChallenge(body) }, null, 2)}\n`, { mode: 0o600 });
  audit(home, 'proposed', { profile: body.profile, expires: body.expires, signer: body.signer, generation }, now);
  return { ok: true, body, challenge: securityProfileChallenge(body), path };
}

export function readProposal(home: string): SecurityProfileBody | null {
  try {
    const { challenge: _c, ...body } = JSON.parse(readFileSync(securityProfileProposalPath(home), 'utf8')) as SecurityProfileBody & { challenge: string };
    return body;
  } catch {
    return null;
  }
}

/**
 * Completes a proposal with the owner device's signature: the Secure Enclave helper (Touch ID
 * prompt) for a mac-keystore signer, or a passkey assertion. Verified before it is written.
 */
export function signSecurityProfile(
  home: string,
  store: OwnerSeatKeyStore,
  assertion?: { authenticator_data: string; client_data_json: string; signature: string },
  now: Date = new Date(),
): { ok: true; record: SignedSecurityProfile } | { ok: false; why: string } {
  const body = readProposal(home);
  if (body === null) return { ok: false, why: 'no security-profile proposal is waiting' };
  const problem = bodyProblem(body, now);
  if (problem !== null) return { ok: false, why: problem };
  const seat = readOwnerSeat(home);
  const signer = seat?.signers.find((s) => s.name === body.signer);
  if (seat === null || signer === undefined) return { ok: false, why: `"${body.signer}" is not a registered owner signer` };
  let record: SignedSecurityProfile;
  if (signer.type === 'webauthn') {
    if (assertion === undefined) return { ok: false, why: `signer "${signer.name}" is a passkey: sign challenge ${securityProfileChallenge(body)} on the owner page` };
    record = { ...body, signature: assertion.signature, webauthn: { authenticator_data: assertion.authenticator_data, client_data_json: assertion.client_data_json } };
  } else {
    if (!store.available()) return { ok: false, why: `the ${store.name} adapter is not available` };
    const signed = store.sign(signer.label, securityProfileBytes(body), `Set the TeamCLI security profile to ${body.profile} until ${body.expires}`);
    if (!signed.ok) return signed;
    record = { ...body, signature: signed.signature };
  }
  const why = verifyRecord(home, record, store, now);
  if (why !== null) {
    audit(home, 'refused', { profile: body.profile, why }, now);
    return { ok: false, why };
  }
  const path = securityProfilePath(home);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  audit(home, 'set', { profile: record.profile, relaxed: record.relaxed, expires: record.expires, signer: record.signer, generation: record.generation }, now);
  return { ok: true, record };
}
