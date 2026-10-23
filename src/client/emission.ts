// Conversational grant emission: the `grant-emission` entity policy and the pending-request path
// it admits. Under `owner-terminal` (the default, and what an absent, unsigned or tampered policy
// reads as) nothing here runs: a client grant is the owner's, at a terminal, as before. Under
// `conversational`, `team grant --client … --request` records the full grant parameters and their
// hash as a pending request, signed by this machine's owner key, and `team grant --execute <id>`
// writes the grant only with an owner approval bound to that hash: single use, fifteen minutes.
//
// The approval is never the requester's word. It comes through an approval adapter: the one-time
// code adapter shows a six-digit code on the owner's screen through a channel the requesting agent
// does not read (a system notification, never stdout, stderr or a file) and stores only a seal of
// it that needs the owner key to check; the local user-presence adapter is the interface for a
// system authentication dialog, not built in this build. The core text names no product.

import { createHash, randomBytes, randomInt, type KeyObject } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { loadAndResolvePolicyChain } from '../policy/sources.ts';
import { keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import { readOwnerSeat, signOwnerAnswer, systemOwnerSeatKeyStore, verifyOwnerAnswer, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';
import type { Fingerprints } from '../approve/fingerprint.ts';
import { CLIENT_EXPIRY_MAX_MS, canonicalTeamOps, resolveEntityCoordinator, teamGrantLabel, planClientGrant, planClientUpGrant, planClientBundleGrant, writeClientBundleGrant, writeClientGrant, writeClientUpGrant, type ClientBundleGrantRequest, type ClientGrantRequest, type ClientGrantRecord, type ClientGrantScope, type ClientTeamOp, type ClientUpGrantRecord, type ClientUpGrantRequest } from './records.ts';
import { upBindingProblem } from './up-grant.ts';
import { BUNDLE_DEFAULT_DAYS, type BundleName, type BundleOp } from './bundle-ops.ts';
import { GRANT_DURATION_DEFAULT_DAYS, expiryPhrase, type GrantDurationKind } from './duration-policy.ts';
import { chooseGrantExpiry, projectIdOfTeamId } from './grant-duration.ts';
import { bundleCard, bundleSpecsInForce, projectIdOfTeam } from './bundles.ts';

export type GrantEmission = 'owner-terminal' | 'conversational';

/** The enforced `grant-emission` word for one entity; anything that does not read and verify is
 *  `owner-terminal`, today's behaviour, never an imagined `conversational`. */
export function grantEmissionOf(home: string, entity: string, now: Date = new Date()): { mode: GrantEmission; why?: string } {
  let chain;
  try {
    chain = loadAndResolvePolicyChain({ home, entity, projectId: null, teamRoot: null, team: null }, { now, upToLevel: 'entity' });
  } catch {
    return { mode: 'owner-terminal', why: 'the policy chain cannot be read' };
  }
  if (!chain.ok) return { mode: 'owner-terminal', why: chain.refusals[0]?.message ?? 'the policy chain cannot be read or verified' };
  return { mode: chain.policies['grant-emission']?.value === 'conversational' ? 'conversational' : 'owner-terminal' };
}

/** The pending record's signature domain, and the code seal's: neither is any other signature. */
export const GRANT_REQUEST_DOMAIN = 'team-grant-emission-request-v1\n';
export const GRANT_CODE_DOMAIN = 'team-grant-emission-code-v1\n';
export const GRANT_AUDIT_DOMAIN = 'team-grant-emission-audit-v1\n';

/** How long a pending request may be approved: fifteen minutes. */
export const GRANT_REQUEST_TTL_MS = 15 * 60 * 1000;
export const GRANT_REQUEST_ID_PATTERN = /^gr_[0-9a-f]{24}$/;

/** The full parameters of one client grant, exactly what an owner-issued `team grant --client` takes. */
export type PendingGrantParams = {
  client_id: string;
  entity: string;
  public_key: string;
  key_id: string;
  key_dir: string;
  team: string | null;
  seat: string | null;
  expires: string | null;
  /** `--expires never`: the request asks for a grant with no end date. Written only when true, so
   *  every other request hashes as it did; part of the hashed parameters, so the owner's answer
   *  approves exactly "no end date" and a request for a dated grant can never be executed as one. */
  expires_never?: boolean;
  inbox: boolean;
  allow_grant: boolean;
  grant_scope: ClientGrantScope | null;
  /** An up grant's binding — the one team, its registry id, its real root and the fingerprints of
   *  its file — or absent. Part of the hashed parameters, so the owner's answer approves exactly
   *  this team and this file; written only when set, so every other request hashes as it did. */
  up?: PendingUpBinding | null;
  /** What the team grant carries: `down` or `up` and `down`. Absent means `up` alone, as before; so a
   *  request for an up grant hashes as it always did, and one that adds `down` hashes differently —
   *  the owner's answer approves exactly these ops. */
  team_ops?: ClientTeamOp[];
  /** A bundle grant's name: a display label, never authority. Present with `up` (the binding). */
  bundle?: BundleName;
  /** The bundle as it expanded at the request, explicitly: what the owner's answer approves and the
   *  record carries. A policy changed since never widens it, and a request is refused if it narrowed. */
  bundle_ops?: BundleOp[];
  /** The seats `send` reaches, when the bundle carries it. */
  bundle_seats?: string[];
};

/** The binding as a pending request stores it: plain JSON, snake_case. */
export type PendingUpBinding = { project: string; team_id: string; root: string; fingerprints: Fingerprints };

/** Every key of a record in order, so equal records give equal bytes whatever order they were read in. */
function sorted<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function canonicalUp(up: PendingUpBinding): Json {
  return { project: up.project, team_id: up.team_id, root: up.root, fingerprints: { sections: sorted(up.fingerprints.sections), seats: sorted(up.fingerprints.seats) } };
}

/** Any client grant this module writes: a send-family grant, or an up grant. */
export type IssuedClientGrant = ClientGrantRecord | ClientUpGrantRecord;

function upRequestOf(p: PendingGrantParams): ClientUpGrantRequest | null {
  if (p.up === undefined || p.up === null) return null;
  return {
    clientId: p.client_id,
    entity: p.entity,
    publicKey: p.public_key,
    keyId: p.key_id,
    keyDir: p.key_dir,
    ...(p.expires !== null ? { expires: p.expires } : {}),
    ...(p.expires_never === true ? { neverExpires: true } : {}),
    up: { project: p.up.project, teamId: p.up.team_id, root: p.up.root, fingerprints: p.up.fingerprints },
    ...(p.team_ops !== undefined ? { ops: p.team_ops } : {}),
  };
}

/** The ops a request's team grant carries, canonical; `up` alone when it names none. */
export function teamOpsOf(p: PendingGrantParams): ClientTeamOp[] {
  return canonicalTeamOps(p.team_ops) ?? ['up'];
}

/** The ops a request's grant carries: a bundle's explicit expansion, or the one-op team grant's. */
function grantOpsOf(p: PendingGrantParams): BundleOp[] {
  return p.bundle !== undefined ? [...(p.bundle_ops ?? [])] : teamOpsOf(p);
}

/** The bundle request a pending request's parameters stand for, or null when it is not a bundle. */
function bundleRequestOf(p: PendingGrantParams, specs?: ClientBundleGrantRequest['specs']): ClientBundleGrantRequest | null {
  if (p.bundle === undefined || p.up === undefined || p.up === null) return null;
  return {
    clientId: p.client_id,
    entity: p.entity,
    publicKey: p.public_key,
    keyId: p.key_id,
    keyDir: p.key_dir,
    bundle: p.bundle,
    ops: p.bundle_ops ?? [],
    seats: p.bundle_seats ?? [],
    ...(p.expires !== null ? { expires: p.expires } : {}),
    ...(p.expires_never === true ? { neverExpires: true } : {}),
    up: { project: p.up.project, teamId: p.up.team_id, root: p.up.root, fingerprints: p.up.fingerprints },
    ...(specs !== undefined ? { specs } : {}),
  };
}

function canonicalParams(p: PendingGrantParams): Json {
  return {
    client_id: p.client_id,
    entity: p.entity,
    public_key: p.public_key,
    key_id: p.key_id,
    key_dir: p.key_dir,
    team: p.team,
    seat: p.seat,
    expires: p.expires,
    ...(p.expires_never === true ? { expires_never: true } : {}),
    inbox: p.inbox,
    allow_grant: p.allow_grant,
    grant_scope: p.grant_scope === null ? null : { entities: [...p.grant_scope.entities], projects: [...p.grant_scope.projects], teams: [...p.grant_scope.teams] },
    ...(p.up !== undefined && p.up !== null ? { up: canonicalUp(p.up) } : {}),
    ...(p.up !== undefined && p.up !== null && p.bundle === undefined && teamOpsOf(p).join(',') !== 'up' ? { team_ops: teamOpsOf(p) } : {}),
    ...(p.bundle !== undefined ? { bundle: p.bundle, bundle_ops: [...(p.bundle_ops ?? [])], bundle_seats: [...(p.bundle_seats ?? [])] } : {}),
  };
}

/** The hash an approval binds: SHA-256 over the canonical parameter JSON. */
export function pendingGrantHash(p: PendingGrantParams): string {
  return createHash('sha256').update(JSON.stringify(canonicalParams(p)), 'utf8').digest('hex');
}

export type PendingGrantRecord = {
  request_id: string;
  params: PendingGrantParams;
  params_sha256: string;
  created: string;
  expires_at: string;
  adapter: string;
  seal: string;
};

/** Context an approval adapter sees: never the owner key itself, only a sealing function. */
export type ApprovalContext = { requestId: string; paramsSha256: string; summary: string; seal: (secret: string) => string };

/**
 * One way the owner approves a pending request. `issue` runs at `--request` and returns the seal
 * to store (or a refusal, and then no request stands); `verify` runs at `--execute` against what
 * the caller presented. A seal is opaque to the requester: checking it needs the owner key.
 */
export type GrantApprovalAdapter = {
  name: string;
  available: () => boolean;
  issue: (ctx: ApprovalContext) => { ok: true; seal: string } | { ok: false; why: string };
  verify: (ctx: ApprovalContext, stored: string, presented: { code?: string }) => boolean;
};

/** Shows text to the owner on screen. Returns false when it could not. */
export type OwnerNotifier = (title: string, text: string) => boolean;

/** The default notifier: a desktop notification on macOS. The script goes on stdin, never argv,
 *  so the code is not in the process list. Other systems have none in this build. */
export const systemNotifier: OwnerNotifier = (title, text) => {
  if (platform() !== 'darwin') return false;
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  try {
    execFileSync('/usr/bin/osascript', ['-'], { input: `display notification ${quote(text)} with title ${quote(title)}\n`, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

/** The one-time code adapter: six digits, shown only through the notifier, sealed with the owner key. */
export function oneTimeCodeAdapter(notify: OwnerNotifier = systemNotifier): GrantApprovalAdapter {
  return {
    name: 'one-time-code',
    available: () => true,
    issue: (ctx) => {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const seal = ctx.seal(code);
      const shown = notify('TeamCLI grant approval', `Code ${code} approves ${ctx.requestId}: ${ctx.summary}. Tell it to the agent only if you approve.`);
      if (!shown) return { ok: false, why: 'the approval code could not be shown on the owner\'s screen; no request was recorded' };
      return { ok: true, seal };
    },
    verify: (ctx, stored, presented) => presented.code !== undefined && /^[0-9]{6}$/.test(presented.code) && ctx.seal(presented.code) === stored,
  };
}

/**
 * The local user-presence adapter: the interface for a system authentication dialog invoked by
 * `--execute` on the owner's machine. TODO: a native helper calling the system's
 * local-authentication facility; until then it is unavailable and approves nothing.
 */
export const localPresenceAdapter: GrantApprovalAdapter = {
  name: 'local-presence',
  available: () => false,
  issue: () => ({ ok: false, why: 'local user-presence confirmation is not built in this build' }),
  verify: () => false,
};

/** The owner's terminal answer: `team grant --answer <id> <word>`, admitted by the same owner
 *  gate as every owner-only command, written as an owner-signed record bound to id and hash. */
export const OWNER_ANSWER_ADAPTER = 'owner-answer';
export const GRANT_ANSWER_DOMAIN = 'team-grant-emission-answer-v1\n';
const ownerAnswerAdapter: GrantApprovalAdapter = {
  name: OWNER_ANSWER_ADAPTER,
  available: () => true,
  issue: () => ({ ok: true, seal: '' }),
  verify: () => true, // the answer record was verified before the claim
};

/** The words an owner answer reads: approve once, always, or deny. */
export function answerChoiceOf(word: string): 'once' | 'always' | 'deny' | null {
  const w = word.trim().toLowerCase();
  if (['oui', 'approved', 'approve', 'yes', 'autorisation', 'autorise', 'once'].includes(w)) return 'once';
  if (w === 'always' || w === 'toujours') return 'always';
  if (['non', 'deny', 'denied', 'no'].includes(w)) return 'deny';
  return null;
}

/** The confirmation line the owner reads for a request. */
export function confirmationLine(requestId: string, p: PendingGrantParams, now: Date, home?: string): string {
  return `Grant request ${requestId}: ${pendingSummary(p, now, home).text} Authorized? reply oui/approved, always, or non/deny (team grant --answer ${requestId} <oui|always|non>)`;
}

/**
 * Records the owner's answer to one pending request. The caller has passed the owner gate; the
 * answer names the request id and its parameter hash and is signed with the owner key, so it
 * approves exactly that request. One answer per request.
 */
export function answerPendingGrant(home: string, requestId: string, word: string, now: Date = new Date()): { ok: true; choice: 'once' | 'always' | 'deny'; summary: string } | { ok: false; why: string } {
  if (!GRANT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false, why: `"${requestId}" is not a grant request id` };
  const choice = answerChoiceOf(word);
  if (choice === null) return { ok: false, why: `"${word}" is not an answer: oui/approved/yes, always, or non/deny` };
  const key = ownerKey(home);
  if (key === null) return { ok: false, why: 'the owner signing key is absent or unreadable' };
  const record = readPending(home, requestId, key);
  if (typeof record === 'string') return { ok: false, why: record };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, why: `request ${requestId} expired at ${record.expires_at}` };
  if (choice === 'always' && record.params.allow_grant) return { ok: false, why: 'a master grant is never approved always; answer oui to approve it once' };
  if (choice === 'always' && record.params.up) return { ok: false, why: UP_NEVER_ALWAYS };
  if (choice === 'always' && record.params.expires_never === true) return { ok: false, why: NO_END_NEVER_ALWAYS };
  const body = { request_id: requestId, params_sha256: record.params_sha256, choice, by: 'owner', at: now.toISOString() };
  const signature = signDomain(GRANT_ANSWER_DOMAIN, { name: requestId, grant_answer: body }, key);
  const written = writeExclusive(join(grantRequestsFolder(home), `${requestId}.answer.json`), `${JSON.stringify({ grant_answer: body, signature }, null, 2)}\n`);
  if (written === 'exists') return { ok: false, why: `request ${requestId} was already answered` };
  if (written === 'failed') return { ok: false, why: `the answer to ${requestId} could not be written` };
  if (choice === 'deny') writeExclusive(join(grantRequestsFolder(home), `${requestId}.used`), `denied ${now.toISOString()}\n`);
  return { ok: true, choice, summary: pendingSummary(record.params, now, home).text };
}

/** A team grant is bound to one team (an up grant, to one file by fingerprint), so a standing rule that
 *  renewed it unasked would bless whatever the team became. Each is answered once; the grant itself
 *  lasts up to ninety days. */
const UP_NEVER_ALWAYS = 'an up or down grant is never approved always: a standing rule would renew it unasked for a team the owner never looked at again; answer oui, the grant lasts up to 90 days';

/** A grant with no end date is the largest thing one answer can sign, so a standing rule never covers it. */
const NO_END_NEVER_ALWAYS = 'a grant with no end date is never approved always: answer oui to approve this one grant once; it stays valid until the owner revokes it with team revoke';

const ownerSeatAdapter: GrantApprovalAdapter = { name: 'owner-seat', available: () => true, issue: () => ({ ok: true, seal: '' }), verify: () => true };

/**
 * The owner seat answers one request: the answer (request id, parameter hash, choice) is signed by
 * the owner seat's key in the credential store, which prompts for user presence. No owner key,
 * message key or caller walk is involved: the signature is the proof.
 */
export function approveAsOwnerSeat(
  home: string,
  requestId: string,
  word: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  via: { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string }; at?: string } = {},
): { ok: true; choice: 'once' | 'always' | 'deny'; summary: string } | { ok: false; why: string } {
  if (!GRANT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false, why: `"${requestId}" is not a grant request id` };
  const choice = answerChoiceOf(word);
  if (choice === null) return { ok: false, why: `"${word}" is not an answer: oui/approved/yes, always, or non/deny` };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered: the owner runs team grant --add-owner-seat --team <team> --signer <name>' };
  const key = ownerKey(home);
  if (key === null) return { ok: false, why: 'the owner signing key is absent or unreadable: the pending request cannot be read' };
  const record = readPending(home, requestId, key);
  if (typeof record === 'string') return { ok: false, why: record };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, why: `request ${requestId} expired at ${record.expires_at}` };
  if (choice === 'always' && record.params.allow_grant) return { ok: false, why: 'a master grant is never approved always; answer oui to approve it once' };
  if (choice === 'always' && record.params.up) return { ok: false, why: UP_NEVER_ALWAYS };
  if (choice === 'always' && record.params.expires_never === true) return { ok: false, why: NO_END_NEVER_ALWAYS };
  const answer: OwnerSeatAnswer = { kind: 'grant', request_id: requestId, params_sha256: record.params_sha256, choice, team: seat.team, seat: 'owner', at: via.at ?? now.toISOString() };
  const summary = pendingSummary(record.params, now, home).text;
  const signed = signOwnerAnswer(home, answer, via.signer, store, `TeamCLI: ${choice} for ${summary}`, via.assertion);
  if (!signed.ok) return signed;
  const path = join(grantRequestsFolder(home), `${requestId}.seat-answer.json`);
  const text = `${JSON.stringify(signed.signed, null, 2)}\n`;
  const written = writeExclusive(path, text);
  if (written === 'failed') return { ok: false, why: `the answer to ${requestId} could not be written` };
  if (written === 'exists') {
    // Only an answer that verifies as the owner seat's blocks this one. A file any same-user
    // process could have dropped there first (unsigned, forged, for another request) is replaced.
    if (readOwnerSeatAnswer(home, record, store, now).ok) return { ok: false, why: `request ${requestId} was already answered by the owner seat` };
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    if (writeExclusive(temp, text) !== 'written') return { ok: false, why: `the answer to ${requestId} could not be written` };
    try {
      renameSync(temp, path);
    } catch {
      try { unlinkSync(temp); } catch {}
      return { ok: false, why: `the answer to ${requestId} could not be written` };
    }
  }
  return { ok: true, choice, summary };
}

function readOwnerSeatAnswer(home: string, record: PendingGrantRecord, store: OwnerSeatKeyStore, now: Date): { ok: true; choice: 'once' | 'always' | 'deny' } | { ok: false; why: string } {
  let parsed: SignedOwnerAnswer;
  try {
    parsed = JSON.parse(readFileSync(join(grantRequestsFolder(home), `${record.request_id}.seat-answer.json`), 'utf8'));
  } catch {
    return { ok: false, why: `the owner-seat answer to ${record.request_id} cannot be read` };
  }
  // The owner-signers policy read is the one of the entity the request acts on, not the seat's.
  const verified = verifyOwnerAnswer(home, parsed, store, now, record.params.entity);
  if (!verified.ok) return verified;
  const answer = verified.answer;
  if (answer.kind !== 'grant' || answer.request_id !== record.request_id || answer.params_sha256 !== record.params_sha256) {
    return { ok: false, why: `the owner-seat answer is not bound to request ${record.request_id} and its parameters` };
  }
  if (!(Date.parse(answer.at) <= Date.parse(record.expires_at))) return { ok: false, why: `the owner-seat answer to ${record.request_id} was given after the request expired` };
  return answer.choice === 'once' || answer.choice === 'always' || answer.choice === 'deny' ? { ok: true, choice: answer.choice } : { ok: false, why: 'the owner-seat answer carries no choice' };
}

function readOwnerAnswer(home: string, record: PendingGrantRecord, key: KeyObject): { ok: true; choice: 'once' | 'always' | 'deny' } | { ok: false; why: string } {
  const no = (why: string) => ({ ok: false as const, why });
  const path = join(grantRequestsFolder(home), `${record.request_id}.answer.json`);
  let parsed: { grant_answer?: Record<string, unknown>; signature?: unknown };
  try {
    if (!lstatSync(path).isFile()) return no(`the answer to ${record.request_id} is not a plain file`);
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return no(`request ${record.request_id} has no owner answer yet: the owner runs team grant --answer ${record.request_id} oui from the owner terminal, or team grant --approve-as-owner-seat ${record.request_id} oui from the owner seat (or passes --code)`);
  }
  const body = parsed.grant_answer;
  if (body === undefined || typeof parsed.signature !== 'string') return no(`the answer to ${record.request_id} is not signed`);
  if (!verifyDomain(GRANT_ANSWER_DOMAIN, { name: record.request_id, grant_answer: body as Json }, parsed.signature, key)) {
    return no(`the answer to ${record.request_id} does not verify as the owner's`);
  }
  if (body.request_id !== record.request_id || body.params_sha256 !== record.params_sha256 || body.by !== 'owner') {
    return no(`the answer is not bound to request ${record.request_id} and its parameters`);
  }
  const choice = body.choice;
  return choice === 'once' || choice === 'always' || choice === 'deny' ? { ok: true, choice } : no(`the answer to ${record.request_id} carries no choice`);
}

export function grantRequestsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'grant-requests');
}

export function grantEmissionAuditFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'grant-emission-audit');
}

function sealWith(key: KeyObject, requestId: string, paramsSha256: string): (secret: string) => string {
  return (secret) => createHash('sha256').update(signDomain(GRANT_CODE_DOMAIN, { request_id: requestId, params_sha256: paramsSha256, secret }, key)).digest('hex');
}

function recordJson(r: PendingGrantRecord): Json {
  return {
    request_id: r.request_id,
    params: canonicalParams(r.params),
    params_sha256: r.params_sha256,
    created: r.created,
    expires_at: r.expires_at,
    adapter: r.adapter,
    seal: r.seal,
  };
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

function ownerKey(home: string): KeyObject | null {
  const state = keyState(home);
  return state.kind === 'key' ? state.key : null;
}

function summaryOf(p: PendingGrantParams): string {
  const noEnd = p.expires_never === true ? ' with NO END DATE' : '';
  if (p.bundle !== undefined && p.up !== undefined && p.up !== null) return `${p.bundle} bundle for ${p.client_id} to team ${p.up.project} at ${p.up.root}: ${(p.bundle_ops ?? []).join(', ')}${noEnd}`;
  if (p.up !== undefined && p.up !== null) return `${teamGrantLabel(teamOpsOf(p))} for ${p.client_id} to team ${p.up.project} at ${p.up.root} (file ${fileFingerprintOf(p.up)})${noEnd}`;
  const where = `${p.seat ?? 'orchestrator'}@${p.team ?? p.entity}`;
  return `client grant for ${p.client_id} to ${where}${p.inbox ? ' with inbox' : ''}${p.allow_grant ? ' as a MASTER grant' : ''}${p.expires_never === true ? ' with NO END DATE' : ''}`;
}

/** Records one pending request under `conversational`; the approval adapter delivers its secret. */
export function createPendingGrant(
  home: string,
  params: PendingGrantParams,
  options: { now?: Date; adapter?: GrantApprovalAdapter } = {},
): { ok: true; record: PendingGrantRecord; path: string } | { ok: false; why: string } {
  const now = options.now ?? new Date();
  const emission = grantEmissionOf(home, params.entity, now);
  if (emission.mode !== 'conversational') {
    return { ok: false, why: `grant-emission for entity "${params.entity}" is owner-terminal${emission.why ? ` (${emission.why})` : ''}: the owner runs team grant from a terminal` };
  }
  const key = ownerKey(home);
  if (key === null) return { ok: false, why: 'the owner signing key is absent or unreadable: no request can be recorded' };
  // A request for a grant that could not be written (an unregistered team, an unlisted seat…) is refused now.
  const planned = planPending(home, params, now);
  if (!planned.ok) return { ok: false, why: planned.why };
  const adapter = options.adapter ?? oneTimeCodeAdapter();
  if (!adapter.available()) return { ok: false, why: `the ${adapter.name} approval adapter is not available` };
  const requestId = `gr_${randomBytes(12).toString('hex')}`;
  const paramsSha256 = pendingGrantHash(params);
  const ctx: ApprovalContext = { requestId, paramsSha256, summary: summaryOf(params), seal: sealWith(key, requestId, paramsSha256) };
  // The owner's terminal answer (`team grant --answer`) is always an approval path; the screen
  // code is an extra one. When the screen cannot show it, the request still stands on the answer.
  const issuedRaw = adapter.issue(ctx);
  const issued = issuedRaw.ok ? issuedRaw : { ok: true as const, seal: '' };
  const adapterName = issuedRaw.ok ? adapter.name : OWNER_ANSWER_ADAPTER;
  const record: PendingGrantRecord = {
    request_id: requestId,
    params,
    params_sha256: paramsSha256,
    created: now.toISOString(),
    expires_at: new Date(now.getTime() + GRANT_REQUEST_TTL_MS).toISOString(),
    adapter: adapterName,
    seal: issued.seal,
  };
  const body = recordJson(record);
  const signature = signDomain(GRANT_REQUEST_DOMAIN, { name: requestId, grant_request: body }, key);
  const folder = grantRequestsFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, why: `the requests folder "${folder}" cannot be created` };
  }
  const path = join(folder, `${requestId}.json`);
  if (writeExclusive(path, `${JSON.stringify({ grant_request: body, signature }, null, 2)}\n`) !== 'written') {
    return { ok: false, why: `the pending request could not be written in "${folder}"` };
  }
  return { ok: true, record, path };
}

function readPending(home: string, requestId: string, key: KeyObject): PendingGrantRecord | string {
  const path = join(grantRequestsFolder(home), `${requestId}.json`);
  let parsed: { grant_request?: Record<string, unknown>; signature?: unknown };
  try {
    if (!lstatSync(path).isFile()) return `the pending request ${requestId} is not a plain file`;
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `no pending request ${requestId} can be read`;
  }
  const body = parsed.grant_request;
  if (body === undefined || typeof parsed.signature !== 'string') return `the pending request ${requestId} is not a signed request`;
  if (!verifyDomain(GRANT_REQUEST_DOMAIN, { name: requestId, grant_request: body as Json }, parsed.signature, key)) {
    return `the pending request ${requestId} does not verify under the owner key`;
  }
  const record = body as unknown as PendingGrantRecord;
  if (record.request_id !== requestId) return `the pending request ${requestId} names another id`;
  if (pendingGrantHash(record.params) !== record.params_sha256) return `the pending request ${requestId}'s parameters do not match its hash`;
  return record;
}

/**
 * Executes one pending request with an owner approval. In order: the record verifies under the
 * owner key and its parameters hash to the signed hash; presented parameters, when given, hash the
 * same (anything changed after the request is refused); the entity is still `conversational`; the
 * request is unexpired; the request is claimed single-use (a used marker created exclusively, so a
 * wrong code burns it and a replay finds it taken); the adapter verifies the approval. Then the
 * grant is written by the owner issuer and an audit entry names the adapter.
 */
export function executePendingGrant(
  home: string,
  input: { requestId: string; code?: string; params?: PendingGrantParams; approve?: 'once' | 'always' },
  options: { now?: Date; adapters?: GrantApprovalAdapter[]; ownerSeatStore?: OwnerSeatKeyStore } = {},
): { ok: true; grant: IssuedClientGrant; path: string; adapter: string; audit: string; ruleId?: string } | { ok: false; why: string } {
  const now = options.now ?? new Date();
  if (!GRANT_REQUEST_ID_PATTERN.test(input.requestId)) return { ok: false, why: `"${input.requestId}" is not a grant request id` };
  const key = ownerKey(home);
  if (key === null) return { ok: false, why: 'the owner signing key is absent or unreadable' };
  const record = readPending(home, input.requestId, key);
  if (typeof record === 'string') return { ok: false, why: record };
  if (input.params !== undefined && pendingGrantHash(input.params) !== record.params_sha256) {
    return { ok: false, why: `the grant parameters differ from the ones request ${input.requestId} recorded (hash mismatch)` };
  }
  const emission = grantEmissionOf(home, record.params.entity, now);
  if (emission.mode !== 'conversational') return { ok: false, why: `grant-emission for entity "${record.params.entity}" is owner-terminal` };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, why: `request ${input.requestId} expired at ${record.expires_at}` };
  // With no code, the approval is the owner seat's answer (signed by its credential-store key)
  // when one was given, and otherwise the owner's terminal answer, both bound to this id and hash.
  let viaSeat = false;
  if (input.code === undefined) {
    const folder = grantRequestsFolder(home);
    const seat = existsSync(join(folder, `${record.request_id}.seat-answer.json`))
      ? readOwnerSeatAnswer(home, record, options.ownerSeatStore ?? systemOwnerSeatKeyStore(), now)
      : null;
    if (seat !== null && seat.ok) {
      if (seat.choice === 'deny') return { ok: false, why: `the owner seat denied request ${input.requestId}` };
      input = { ...input, approve: seat.choice };
      viaSeat = true;
    } else if (seat !== null && !existsSync(join(folder, `${record.request_id}.answer.json`))) {
      return seat;
    } else {
      // An owner-seat answer that does not verify never blocks the owner's terminal answer.
      const answer = readOwnerAnswer(home, record, key);
      if (!answer.ok) return seat !== null ? { ok: false, why: `${seat.why}; ${answer.why}` } : answer;
      if (answer.choice === 'deny') return { ok: false, why: `the owner denied request ${input.requestId}` };
      input = { ...input, approve: answer.choice };
    }
  }
  const adapters = options.adapters ?? [oneTimeCodeAdapter(), localPresenceAdapter];
  const adapter: GrantApprovalAdapter | undefined = viaSeat ? ownerSeatAdapter : input.code === undefined ? ownerAnswerAdapter : adapters.find((candidate) => candidate.name === record.adapter);
  if (adapter === undefined || !adapter.available()) return { ok: false, why: `the ${record.adapter} approval adapter is not available; the owner answers with team grant --answer ${input.requestId} oui` };
  const always = input.approve === 'always';
  if (always && record.params.allow_grant) return { ok: false, why: 'a master grant is never approved always: each one needs its own approval' };
  if (always && record.params.up) return { ok: false, why: UP_NEVER_ALWAYS };
  if (always && record.params.expires_never === true) return { ok: false, why: NO_END_NEVER_ALWAYS };
  // The grant is validated (team registered, seat listed, key placement, expiry) before the
  // request is spent: a grant that cannot be written leaves the request and its approval intact.
  const planned = planPending(home, record.params, now);
  if (!planned.ok) return { ok: false, why: `${planned.why}; request ${input.requestId} is not spent` };
  const used = writeExclusive(join(grantRequestsFolder(home), `${input.requestId}.used`), `${now.toISOString()}\n`);
  if (used === 'exists') return { ok: false, why: `request ${input.requestId} was already used: an approval is single-use` };
  if (used === 'failed') return { ok: false, why: `request ${input.requestId} could not be claimed` };
  const ctx: ApprovalContext = { requestId: record.request_id, paramsSha256: record.params_sha256, summary: summaryOf(record.params), seal: sealWith(key, record.request_id, record.params_sha256) };
  if (!adapter.verify(ctx, record.seal, input.code !== undefined ? { code: input.code } : {})) {
    return { ok: false, why: `the approval for ${input.requestId} does not verify; the request is spent and a new one is needed` };
  }
  const p = record.params;
  let ruleId: string | undefined;
  if (always) {
    const rule = writeApprovalRule(home, p, adapter.name, now, key);
    if (!rule.ok) return rule;
    ruleId = rule.rule.rule_id;
  }
  const written = issueFromParams(home, p, now, key);
  if (!written.ok) return written;
  const audited = writeEmissionAudit(home, { request_id: record.request_id, params_sha256: record.params_sha256, grant_id: written.grant.grantId, adapter: adapter.name, choice: always ? 'always' : 'once', ...(ruleId !== undefined ? { rule_id: ruleId } : {}), ...(p.up ? { op: grantOpsOf(p).join('+'), ...(p.bundle !== undefined ? { bundle: p.bundle } : {}), up_project: p.up.project, up_root: p.up.root, up_file: fileFingerprintOf(p.up) } : {}), at: now.toISOString() }, record.request_id, key);
  if (!audited.ok) return { ok: false, why: `the grant ${written.grant.grantId} was written but its audit entry could not be; the owner revokes it with team revoke` };
  return { ok: true, grant: written.grant, path: written.path, adapter: adapter.name, audit: audited.path, ...(ruleId !== undefined ? { ruleId } : {}) };
}

function issueFromParams(home: string, p: PendingGrantParams, now: Date, key: KeyObject): { ok: true; grant: IssuedClientGrant; path: string } | { ok: false; why: string } {
  const bundle = bundleRequestOf(p, bundleSpecsFor(home, p, now));
  if (bundle !== null) return writeClientBundleGrant(home, bundle, { now, key });
  const up = upRequestOf(p);
  return up !== null ? writeClientUpGrant(home, up, { now, key }) : writeClientGrant(home, grantRequestOf(p), { now, key });
}

/** Validates one request's parameters as the grant it would write, without writing it. An up
 *  grant is also checked against the live team: the answer is for the file in front of the owner
 *  now, so a file that changed since the request refuses here and the request is not spent. */
function planPending(home: string, p: PendingGrantParams, now: Date): { ok: true } | { ok: false; why: string } {
  if (p.bundle !== undefined) {
    // The policy in force NOW bounds the ops and the days; the ops themselves are the ones the
    // request hashed, so a policy loosened since never adds one.
    const specs = bundleSpecsInForce(home, p.entity, p.up ? projectIdOfTeam(home, p.up.team_id) : null, now);
    if (!specs.ok) return specs;
    const request = bundleRequestOf(p, specs.specs);
    if (request === null) return { ok: false, why: 'a bundle request names its team' };
    const planned = planClientBundleGrant(home, request, { now });
    if (!planned.ok) return planned;
    const live = upBindingProblem(home, p.entity, request.up, planned.grant.ops.includes('up') ? 'up' : 'status');
    if (live === null) return { ok: true };
    if (live.kind === 'drift') return { ok: false, why: `the team file of ${request.up.project} changed since the request (${live.changes.join('; ')}); ask again so the owner answers for the file as it is now` };
    return { ok: false, why: live.why };
  }
  const up = upRequestOf(p);
  if (up === null) {
    const planned = planClientGrant(home, grantRequestOf(p), { now });
    return planned.ok ? { ok: true } : planned;
  }
  const planned = planClientUpGrant(home, up, { now });
  if (!planned.ok) return planned;
  // A grant that carries `up` is answered for the file in front of the owner now, so drift refuses
  // here. A down-only grant never reads the file's fingerprints (a stop must stay possible when the
  // file changed), so a file that moved since the request does not spend it.
  const live = upBindingProblem(home, p.entity, up.up, teamOpsOf(p).includes('up') ? 'up' : 'down');
  if (live === null) return { ok: true };
  if (live.kind === 'drift') return { ok: false, why: `the team file of ${up.up.project} changed since the request (${live.changes.join('; ')}); ask again so the owner answers for the file as it is now` };
  return { ok: false, why: live.why };
}

/** The bundle specs in force for a request's team, for the write's own check (defaults on a chain that will not read: the plan refused first). */
function bundleSpecsFor(home: string, p: PendingGrantParams, now: Date) {
  const specs = bundleSpecsInForce(home, p.entity, p.up ? projectIdOfTeam(home, p.up.team_id) : null, now);
  return specs.ok ? specs.specs : undefined;
}

/** Twelve hex of the digest of the file fingerprints: the short name an owner reads on screen. */
export function fileFingerprintOf(up: PendingUpBinding): string {
  return createHash('sha256').update(JSON.stringify(canonicalUp(up)), 'utf8').digest('hex').slice(0, 12);
}

/** The client-grant request a pending request's parameters stand for. */
function grantRequestOf(p: PendingGrantParams): ClientGrantRequest {
  return {
    clientId: p.client_id,
    entity: p.entity,
    publicKey: p.public_key,
    keyId: p.key_id,
    keyDir: p.key_dir,
    ...(p.expires !== null ? { expires: p.expires } : {}),
    ...(p.expires_never === true ? { neverExpires: true } : {}),
    ...(p.inbox ? { inbox: true } : {}),
    ...(p.seat !== null ? { seat: p.seat } : {}),
    ...(p.team !== null ? { team: p.team } : {}),
    ...(p.allow_grant && p.grant_scope !== null ? { grantScope: p.grant_scope } : {}),
  };
}

function writeEmissionAudit(home: string, audit: Record<string, string>, name: string, key: KeyObject): { ok: true; path: string } | { ok: false } {
  const signature = signDomain(GRANT_AUDIT_DOMAIN, { name, grant_emission_audit: audit }, key);
  const folder = grantEmissionAuditFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {}
  const path = join(folder, `${name}.json`);
  if (writeExclusive(path, `${JSON.stringify({ grant_emission_audit: audit, signature }, null, 2)}\n`) !== 'written') return { ok: false };
  return { ok: true, path };
}

/** The ops a pending request asks for: never `grant` outside a master. */
export function pendingOps(p: PendingGrantParams): string[] {
  if (p.up !== undefined && p.up !== null) return grantOpsOf(p);
  return [...(p.inbox ? ['send', 'messages'] : ['send']), ...(p.allow_grant ? ['grant'] : [])];
}

/** The sentence added to a card whose grant has no end date, so the owner reads it where they sign. */
export const NO_END_DATE_NOTICE = 'NO END DATE: it stays valid until you end it with team revoke.';

/**
 * The end the grant would be signed with, for the card: `null` for no end date, the named date, or
 * the default length under the policy in force (the shorter of the kind's default and the cap). The
 * card says what the policy allows; the signing re-checks it, and a request that no longer fits is
 * refused there, so this is never what authorizes anything.
 */
function cardExpiry(p: PendingGrantParams, now: Date, home: string | undefined, kind: GrantDurationKind): string | null {
  if (p.expires_never === true) return null;
  if (p.expires !== null) return p.expires;
  let days = kind === 'bundle' ? BUNDLE_DEFAULT_DAYS : GRANT_DURATION_DEFAULT_DAYS[kind];
  let narrow: number | null = null;
  let projectId: string | null = null;
  if (home !== undefined) {
    if (p.up !== undefined && p.up !== null) projectId = projectIdOfTeamId(home, p.up.team_id);
    else {
      const resolved = resolveEntityCoordinator(home, p.entity, { clientId: p.client_id, ...(p.seat !== null ? { seat: p.seat } : {}), ...(p.team !== null && p.team !== p.entity ? { team: p.team } : {}) });
      if (resolved.ok) projectId = projectIdOfTeamId(home, resolved.coordinator.teamId);
    }
    if (kind === 'bundle') {
      const specs = bundleSpecsInForce(home, p.entity, projectId, now);
      const spec = specs.ok && p.bundle !== undefined ? specs.specs[p.bundle] : undefined;
      if (spec !== undefined) {
        days = spec.expiryDays;
        narrow = spec.expiryExplicit === true ? spec.expiryDays : null;
      }
    }
    const chosen = chooseGrantExpiry({ home, kind, entity: p.entity, projectId, now, defaultDays: days, narrowDays: narrow });
    if (chosen.ok && chosen.expires !== null) return chosen.expires;
  }
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/** The human summary a requester shows or speaks, and the three choices it offers. `home`, when
 *  given, lets the card show the default length under the owner's `client-grant-max-duration`. */
export function pendingSummary(p: PendingGrantParams, now: Date, home?: string): { client: string; entity: string; team: string; seat: string; ops: string[]; expires: string | null; master: boolean; text: string; up?: { project: string; team_id: string; root: string; seats: string[]; file_fingerprint: string } } {
  if (p.bundle !== undefined && p.up !== undefined && p.up !== null) {
    const ops = grantOpsOf(p);
    const seats = Object.keys(p.up.fingerprints.seats);
    const expires = cardExpiry(p, now, home, 'bundle');
    const file = fileFingerprintOf(p.up);
    const card = bundleCard({ clientId: p.client_id, project: p.up.project, ops, seats: p.bundle_seats ?? [], expires, fileFingerprint: file });
    return { client: p.client_id, entity: p.entity, team: p.up.project, seat: (p.bundle_seats ?? []).join(',') || 'none', ops, expires, master: false, text: expires === null ? `${card} ${NO_END_DATE_NOTICE}` : card, up: { project: p.up.project, team_id: p.up.team_id, root: p.up.root, seats, file_fingerprint: file } };
  }
  if (p.up !== undefined && p.up !== null) {
    const expires = cardExpiry(p, now, home, 'up');
    const seats = Object.keys(p.up.fingerprints.seats);
    const ops = teamOpsOf(p);
    const label = teamGrantLabel(ops);
    const runs = ops.map((op) => `team ${op}`).join(' and ');
    const text = `${label.charAt(0).toUpperCase()}${label.slice(1)} for ${p.client_id}: run ${runs} for team ${p.up.project} at ${p.up.root} (entity ${p.entity}; file ${fileFingerprintOf(p.up)}; seats ${seats.join(', ')}) ${expiryPhrase(expires)}.${expires === null ? ` ${NO_END_DATE_NOTICE}` : ''}`;
    return { client: p.client_id, entity: p.entity, team: p.up.project, seat: 'none', ops, expires, master: false, text, up: { project: p.up.project, team_id: p.up.team_id, root: p.up.root, seats, file_fingerprint: fileFingerprintOf(p.up) } };
  }
  const expires = cardExpiry(p, now, home, 'send');
  const team = p.team ?? p.entity;
  const seat = p.seat ?? 'orchestrator';
  const ops = pendingOps(p);
  const text = `${p.allow_grant ? 'MASTER grant' : 'Grant'} for ${p.client_id}: ${ops.join(' + ')} to ${seat}@${team} (entity ${p.entity}) ${expiryPhrase(expires)}.${expires === null ? ` ${NO_END_DATE_NOTICE}` : ''}`;
  return { client: p.client_id, entity: p.entity, team, seat, ops, expires, master: p.allow_grant, text };
}

export const GRANT_CHOICES = ['once', 'always', 'deny'] as const;

/** `team grant --deny <id>`: spends a pending request without writing anything. Anyone may deny;
 *  it only narrows. */
export function denyPendingGrant(home: string, requestId: string, now: Date = new Date()): { ok: true; audit: string | null } | { ok: false; why: string } {
  if (!GRANT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false, why: `"${requestId}" is not a grant request id` };
  const folder = grantRequestsFolder(home);
  try {
    if (!lstatSync(join(folder, `${requestId}.json`)).isFile()) return { ok: false, why: `no pending request ${requestId}` };
  } catch {
    return { ok: false, why: `no pending request ${requestId}` };
  }
  const used = writeExclusive(join(folder, `${requestId}.used`), `denied ${now.toISOString()}\n`);
  if (used === 'exists') return { ok: false, why: `request ${requestId} was already used or denied` };
  if (used === 'failed') return { ok: false, why: `request ${requestId} could not be marked denied` };
  const key = ownerKey(home);
  if (key === null) return { ok: true, audit: null };
  const audit = writeEmissionAudit(home, { request_id: requestId, choice: 'deny', at: now.toISOString() }, requestId, key);
  return { ok: true, audit: audit.ok ? audit.path : null };
}

// ---- standing approval rules ('always') ----------------------------------------------------

export const APPROVAL_RULE_TTL_DEFAULT_DAYS = 30;
export const APPROVAL_RULE_TTL_MAX_DAYS = 90;

/** The `approval-rule-ttl` for an entity in days: 30 by default, never past 90; unreadable reads as the default. */
export function approvalRuleTtlDays(home: string, entity: string, now: Date = new Date()): number {
  try {
    const chain = loadAndResolvePolicyChain({ home, entity, projectId: null, teamRoot: null, team: null }, { now, upToLevel: 'entity' });
    const v = chain.ok ? chain.policies['approval-rule-ttl']?.value : undefined;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return Math.min(v, APPROVAL_RULE_TTL_MAX_DAYS);
  } catch {
    // the default below
  }
  return APPROVAL_RULE_TTL_DEFAULT_DAYS;
}

/** Whether a rule created at `created` is past the entity's approval-rule-ttl at `now`. */
export function approvalRuleExpired(home: string, entity: string, created: string, now: Date = new Date()): boolean {
  const at = Date.parse(created);
  if (!Number.isFinite(at)) return true;
  return now.getTime() >= at + approvalRuleTtlDays(home, entity, now) * 86_400_000;
}

export const GRANT_RULE_DOMAIN = 'team-grant-approval-rule-v1\n';
export const GRANT_RULE_ID_PATTERN = /^ar_[0-9a-f]{24}$/;

/** One standing approval: a later request fully inside it is approved without asking again. */
export type ApprovalRule = {
  rule_id: string;
  created: string;
  approved_by: string;
  client_id: string;
  entity: string;
  teams: string[];
  seats: string[];
  ops: string[];
  max_duration_seconds: number;
};

export function grantApprovalsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'grant-approvals');
}

function ruleJson(r: ApprovalRule): Json {
  return { rule_id: r.rule_id, created: r.created, approved_by: r.approved_by, client_id: r.client_id, entity: r.entity, teams: [...r.teams], seats: [...r.seats], ops: [...r.ops], max_duration_seconds: r.max_duration_seconds };
}

/** The longest a standing rule covers: seven days, the release default of a send grant. A rule is the
 *  owner's standing 'always', set by this constant and never by `client-grant-max-duration`, so a
 *  raised cap never makes a rule approve a longer grant than the owner saw when answering. */
const APPROVAL_RULE_MAX_SECONDS = (GRANT_DURATION_DEFAULT_DAYS.send * 24 * 60 * 60);

function durationSeconds(p: PendingGrantParams, now: Date): number {
  if (p.expires_never === true) return Number.POSITIVE_INFINITY;
  if (p.expires === null) return CLIENT_EXPIRY_MAX_MS / 1000;
  return Math.ceil((Date.parse(p.expires) - now.getTime()) / 1000);
}

/** Writes one owner-signed rule; only reached after an adapter verified the owner's approval. */
function writeApprovalRule(home: string, p: PendingGrantParams, adapter: string, now: Date, key: KeyObject): { ok: true; rule: ApprovalRule } | { ok: false; why: string } {
  if (p.allow_grant) return { ok: false, why: 'a master grant is never approved always' };
  if (p.up) return { ok: false, why: UP_NEVER_ALWAYS };
  if (p.expires_never === true) return { ok: false, why: NO_END_NEVER_ALWAYS };
  const rule: ApprovalRule = {
    rule_id: `ar_${randomBytes(12).toString('hex')}`,
    created: now.toISOString(),
    approved_by: adapter,
    client_id: p.client_id,
    entity: p.entity,
    teams: [p.team ?? p.entity],
    seats: [p.seat ?? 'orchestrator'],
    ops: pendingOps(p),
    max_duration_seconds: Math.min(durationSeconds(p, now), APPROVAL_RULE_MAX_SECONDS),
  };
  const body = ruleJson(rule);
  const signature = signDomain(GRANT_RULE_DOMAIN, { name: rule.rule_id, approval_rule: body }, key);
  const folder = grantApprovalsFolder(home);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, why: `the approvals folder "${folder}" cannot be created` };
  }
  if (writeExclusive(join(folder, `${rule.rule_id}.json`), `${JSON.stringify({ approval_rule: body, signature }, null, 2)}\n`) !== 'written') {
    return { ok: false, why: 'the approval rule could not be written' };
  }
  return { ok: true, rule };
}

/** Every rule that verifies under the owner key; a file that does not is ignored and reported. */
export function listApprovalRules(home: string): { rules: ApprovalRule[]; ignored: string[] } {
  const folder = grantApprovalsFolder(home);
  const key = ownerKey(home);
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => /^ar_[0-9a-f]{24}\.json$/.test(name)).sort();
  } catch {
    return { rules: [], ignored: [] };
  }
  const rules: ApprovalRule[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const stem = name.slice(0, -'.json'.length);
    try {
      const path = join(folder, name);
      if (!lstatSync(path).isFile() || key === null) throw new Error('unverifiable');
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { approval_rule?: ApprovalRule; signature?: string };
      const rule = parsed.approval_rule;
      if (rule === undefined || typeof parsed.signature !== 'string' || rule.rule_id !== stem) throw new Error('shape');
      if (!verifyDomain(GRANT_RULE_DOMAIN, { name: stem, approval_rule: ruleJson(rule) }, parsed.signature, key)) throw new Error('signature');
      if (JSON.stringify(ruleJson(rule)) !== JSON.stringify(parsed.approval_rule)) throw new Error('extra fields');
      if (rule.ops.includes('grant')) throw new Error('grant op');
      rules.push(rule);
    } catch {
      ignored.push(stem);
    }
  }
  return { rules, ignored };
}

/** The rule a request sits fully inside, or null: same client and entity, team and seat listed,
 *  ops a subset, duration within the rule's, and never a master grant or the `grant` op. */
export function matchingApprovalRule(home: string, p: PendingGrantParams, now: Date): ApprovalRule | null {
  if (p.allow_grant || p.grant_scope !== null || (p.up !== undefined && p.up !== null)) return null;
  const ops = pendingOps(p);
  if (ops.includes('grant')) return null;
  const duration = durationSeconds(p, now);
  for (const rule of listApprovalRules(home).rules) {
    if (rule.client_id !== p.client_id || rule.entity !== p.entity) continue;
    if (approvalRuleExpired(home, rule.entity, rule.created, now)) continue;
    if (!rule.teams.includes(p.team ?? p.entity) || !rule.seats.includes(p.seat ?? 'orchestrator')) continue;
    if (!ops.every((op) => rule.ops.includes(op))) continue;
    if (!(duration > 0) || duration > rule.max_duration_seconds) continue;
    return rule;
  }
  return null;
}

/** Writes the grant for a request a standing rule covers, with an audit entry naming the rule. */
export function autoApprovePendingGrant(
  home: string,
  p: PendingGrantParams,
  rule: ApprovalRule,
  now: Date = new Date(),
): { ok: true; grant: IssuedClientGrant; path: string; audit: string } | { ok: false; why: string } {
  const key = ownerKey(home);
  if (key === null) return { ok: false, why: 'the owner signing key is absent or unreadable' };
  const written = issueFromParams(home, p, now, key);
  if (!written.ok) return written;
  const name = `auto_${written.grant.grantId}`;
  const audited = writeEmissionAudit(home, { grant_id: written.grant.grantId, params_sha256: pendingGrantHash(p), adapter: 'standing-rule', rule_id: rule.rule_id, choice: 'auto', at: now.toISOString() }, name, key);
  if (!audited.ok) return { ok: false, why: `the grant ${written.grant.grantId} was written but its audit entry could not be` };
  return { ok: true, grant: written.grant, path: written.path, audit: audited.path };
}

/** Removes one rule. Anyone may: it only narrows. A removed rule stops matching at once. */
export function revokeApprovalRule(home: string, ruleId: string): { ok: true } | { ok: false; why: string } {
  if (!GRANT_RULE_ID_PATTERN.test(ruleId)) return { ok: false, why: `"${ruleId}" is not an approval rule id` };
  try {
    unlinkSync(join(grantApprovalsFolder(home), `${ruleId}.json`));
  } catch {
    return { ok: false, why: `no approval rule ${ruleId}` };
  }
  return { ok: true };
}
