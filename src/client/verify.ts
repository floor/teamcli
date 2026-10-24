// The request one external client signs with its own app key: the send operation, the entity and
// orchestrator it is addressed to, the body's digest and a request id used once. The app key is
// bound to a grant's public key, so a request signed with any other key is refused. The signature
// covers a domain of its own, so it is never an approval, a message or a grant.
//
// The request id is what makes a retried invocation safe: the send path claims it before the drop
// is written and refuses a second claim, including one left by a crashed attempt.

import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  CLIENT_EXPIRY_MAX_MS,
  CLIENT_GRANT_ID_PATTERN,
  CLIENT_MASTER_VOCABULARY_VERSION,
  CLIENT_PUBLIC_KEY_PATTERN,
  activeClientGrant,
  canonicalClientGrant,
  clientAddressOf,
  clientAdmission,
  clientGrantExpired,
  clientGrantScopeAdmits,
  clientMasterRevocation,
  clientRevocations,
  publicKeyObject,
  readClientGrantFile,
  readClientPrivateKey,
  resolveEntityCoordinator,
  type ClientGrantRecord,
} from './records.ts';
import { ofTeam } from '../registry/projects.ts';
import { DAY_MS, endsAtMs } from './duration-policy.ts';
import { grantDurationInForce, projectIdOfTeamId } from './grant-duration.ts';
import { signDomain, verifyDomain, type Json } from '../store/keys.ts';

/** The domain tag a client send request signature carries. */
export const CLIENT_REQUEST_DOMAIN = 'team-client-request-v1\n';

/** The domain tag a client read request signature carries. A read is a different operation under
 *  a different domain, so no v1 send signature can be replayed as a read and no v2 read signature
 *  can be presented to the send verifier. */
export const CLIENT_READ_REQUEST_DOMAIN = 'team-client-request-v2\n';

/** A request id names a file in the replay store: one path segment, no separators. */
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A reply id a read names in `since` or `ack`: one path segment, no separators. */
export const CLIENT_REPLY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** One signed request, exactly the fields the signature covers. */
export type ClientRequest = {
  v: 1;
  grant_id: string;
  client_id: string;
  key_id: string;
  op: 'send';
  entity: string;
  recipient_id: string;
  recipient_seat: string;
  body_sha256: string;
  request_id: string;
  issued_at: string;
  challenge: null;
};

/** The exact payload the signature covers. */
export function clientRequestBody(request: ClientRequest): Json {
  return {
    v: request.v,
    grant_id: request.grant_id,
    client_id: request.client_id,
    key_id: request.key_id,
    op: request.op,
    entity: request.entity,
    recipient_id: request.recipient_id,
    recipient_seat: request.recipient_seat,
    body_sha256: request.body_sha256,
    request_id: request.request_id,
    issued_at: request.issued_at,
    challenge: request.challenge,
  };
}

export function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export function clientRequestId(): string {
  return `rq_${randomBytes(12).toString('hex')}`;
}

/** Signs a request with the client's own key. */
export function signClientRequest(request: ClientRequest, privatePem: string): string {
  return signDomain(CLIENT_REQUEST_DOMAIN, clientRequestBody(request), createPrivateKey(privatePem));
}

/** Whether `signature` is the app key's over this request. */
export function clientRequestVerifies(request: ClientRequest, signature: string, publicKey: KeyObject): boolean {
  return verifyDomain(CLIENT_REQUEST_DOMAIN, clientRequestBody(request), signature, publicKey);
}

export type ClientRequestVerification =
  | { ok: true; grant: ClientGrantRecord; request: ClientRequest; signature: string }
  | { ok: false; why: string };

/** One signed read request: the cursor, the ack and the page bound are signed fields, so no
 *  part of what steers the read can be changed after signing. */
export type ClientReadRequest = {
  v: 2;
  op: 'messages';
  grant_id: string;
  client_id: string;
  key_id: string;
  entity: string;
  /** The reply id the read continues after, or null for no cursor. */
  since: string | null;
  /** The reply id this read acknowledges, or null for none. */
  ack: string | null;
  /** The page bound, 1..100. */
  limit: number;
  request_id: string;
  issued_at: string;
  challenge: null;
};

/** The exact payload the read signature covers. */
export function clientReadRequestBody(request: ClientReadRequest): Json {
  return {
    v: request.v,
    op: request.op,
    grant_id: request.grant_id,
    client_id: request.client_id,
    key_id: request.key_id,
    entity: request.entity,
    since: request.since,
    ack: request.ack,
    limit: request.limit,
    request_id: request.request_id,
    issued_at: request.issued_at,
    challenge: request.challenge,
  };
}

/** Signs a read request with the client's own key. */
export function signClientReadRequest(request: ClientReadRequest, privatePem: string): string {
  return signDomain(CLIENT_READ_REQUEST_DOMAIN, clientReadRequestBody(request), createPrivateKey(privatePem));
}

/** Whether `signature` is the app key's over this read request. */
export function clientReadRequestVerifies(request: ClientReadRequest, signature: string, publicKey: KeyObject): boolean {
  return verifyDomain(CLIENT_READ_REQUEST_DOMAIN, clientReadRequestBody(request), signature, publicKey);
}

/** A read verification failure that names whose side it is on: the key file and the request
 *  signature are `key`; every other admission refusal is `refused`. */
export type ClientReadFailure = { ok: false; why: string; kind: 'key' | 'refused' };

export type ClientReadVerification =
  | { ok: true; grant: ClientGrantRecord; request: ClientReadRequest; signature: string }
  | ClientReadFailure;

/** What a request must be addressed to: the entity and the orchestrator's own registry id. */
export type ClientTarget = { entity: string; recipientId: string; recipientSeat: string };

/**
 * Verifies one send request end to end, in the order that reads least first: the presented grant
 * file verifies under the owner key; the key file passes its file-hygiene rules and is the grant's
 * own public key; the request built from the invocation signs and verifies with that key; its
 * bindings name the grant's client, entity and resolved recipient, the body's digest and one
 * well-formed request id; and the grant is canonical, unexpired and unrevoked. The canonical and
 * revocation reads are repeated under the grant lock immediately before the effect.
 */
export function verifyClientRequest(input: {
  home: string;
  grantFile: string;
  keyFile: string;
  body: string;
  target: ClientTarget;
  now: Date;
  requestId?: string;
  issuedAt?: Date;
}): ClientRequestVerification {
  const presented = readClientGrantFile(input.home, input.grantFile);
  if (!presented.ok) return { ok: false, why: presented.why };
  const grant = presented.grant;
  const admitted = clientAdmission(input.home, grant.clientId, grant.entity);
  if (!admitted.ok) return { ok: false, why: admitted.why };
  if (!grant.allowedOps.includes('send')) return { ok: false, why: `the grant ${grant.grantId} does not admit send` };
  if (grant.allowedRoles[0] !== 'orchestrator') {
    return { ok: false, why: `the grant ${grant.grantId} does not admit the orchestrator role` };
  }
  if (grant.entity !== input.target.entity) {
    return { ok: false, why: `the grant ${grant.grantId} is for entity "${grant.entity}", not "${input.target.entity}"` };
  }
  if (input.target.recipientSeat !== grant.recipientSeat) {
    return { ok: false, why: `a client grant sends only to ${clientAddressOf(grant)}` };
  }
  // The grant's signed recipient is the one the request may name: resolving some other agent now
  // does not change what the signature binds.
  if (input.target.recipientId !== grant.recipientId || input.target.recipientSeat !== grant.recipientSeat) {
    return { ok: false, why: `the resolved ${grant.recipientSeat} is not the recipient the grant ${grant.grantId} signs` };
  }

  const key = readClientPrivateKey(input.home, input.keyFile);
  if (!key.ok) return { ok: false, why: key.why };
  if (key.publicKey !== grant.publicKey) {
    return { ok: false, why: `the key file is not the app key the grant ${grant.grantId} names` };
  }
  if (key.keyId !== grant.keyId) {
    return { ok: false, why: `the key file's id is not the grant ${grant.grantId}'s key id` };
  }

  const requestId = input.requestId ?? clientRequestId();
  if (!CLIENT_REQUEST_ID_PATTERN.test(requestId)) {
    return { ok: false, why: `"${requestId}" is not a request id: one word of letters, digits, dots, hyphens or underscores` };
  }
  if (!CLIENT_GRANT_ID_PATTERN.test(grant.grantId)) {
    return { ok: false, why: `"${grant.grantId}" is not a client grant id` };
  }
  const request: ClientRequest = {
    v: 1,
    grant_id: grant.grantId,
    client_id: grant.clientId,
    key_id: grant.keyId,
    op: 'send',
    entity: grant.entity,
    recipient_id: grant.recipientId,
    recipient_seat: grant.recipientSeat,
    body_sha256: bodyDigest(input.body),
    request_id: requestId,
    issued_at: (input.issuedAt ?? input.now).toISOString(),
    challenge: null,
  };
  let signature: string;
  try {
    signature = signClientRequest(request, key.privatePem);
  } catch {
    return { ok: false, why: 'the request could not be signed with the app key' };
  }
  const publicKey = publicKeyObject(grant.publicKey);
  if (publicKey === null || !clientRequestVerifies(request, signature, publicKey)) {
    return { ok: false, why: 'the request signature does not verify under the grant\'s app key' };
  }

  const canonical = canonicalClientGrant(input.home, presented);
  if (!canonical.ok) return { ok: false, why: canonical.why };
  if (clientGrantExpired(canonical.grant.expires, input.now)) {
    return { ok: false, why: `the grant ${grant.grantId} expired at ${grant.expires}` };
  }
  const revocation = clientRevocations(input.home, grant.grantId);
  if (!revocation.ok) return { ok: false, why: revocation.why };
  if (revocation.records[0] !== undefined) {
    return { ok: false, why: `the grant ${grant.grantId} was revoked at ${revocation.records[0].at}` };
  }
  const masterRevoked = clientMasterRevocation(input.home, grant);
  if (masterRevoked !== null) return { ok: false, why: masterRevoked };

  return { ok: true, grant, request, signature };
}

/**
 * Verifies one read request end to end: the presented grant file verifies under the owner key and
 * is a vocabulary-2 grant carrying `send` and `messages`; the key file passes its file-hygiene
 * rules and is the grant's own key; the request built from the invocation signs and verifies with
 * that key; every field that steers the read (`since`, `ack`, `limit`) is inside the signature;
 * and the grant is canonical, unexpired and unrevoked. The caller repeats the canonical, expiry
 * and revocation reads under the grant lock immediately before scanning or writing.
 */
export function verifyClientRead(input: {
  home: string;
  grantFile: string;
  keyFile: string;
  since: string | null;
  ack: string | null;
  limit: number;
  now: Date;
  requestId?: string;
}): ClientReadVerification {
  const presented = readClientGrantFile(input.home, input.grantFile);
  if (!presented.ok) return { ok: false, why: presented.why, kind: 'refused' };
  const grant = presented.grant;
  const admitted = clientAdmission(input.home, grant.clientId, grant.entity);
  if (!admitted.ok) return { ok: false, why: admitted.why, kind: 'refused' };
  if (!grant.allowedOps.includes('messages')) {
    return {
      ok: false,
      why: `the grant ${grant.grantId} is send-only and does not admit messages; the owner issues a new grant with --inbox`,
      kind: 'refused',
    };
  }
  if (!grant.allowedOps.includes('send') || grant.allowedRoles[0] !== 'orchestrator') {
    return { ok: false, why: `the grant ${grant.grantId} does not admit the client send and orchestrator role`, kind: 'refused' };
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    return { ok: false, why: `the limit ${String(input.limit)} is not a page bound between 1 and 100`, kind: 'refused' };
  }
  for (const [name, value] of [['since', input.since], ['ack', input.ack]] as const) {
    if (value !== null && !CLIENT_REPLY_ID_PATTERN.test(value)) {
      return { ok: false, why: `"${value}" is not a reply id for --${name}`, kind: 'refused' };
    }
  }

  const key = readClientPrivateKey(input.home, input.keyFile);
  if (!key.ok) return { ok: false, why: key.why, kind: 'key' };
  if (key.publicKey !== grant.publicKey) {
    return { ok: false, why: `the key file is not the app key the grant ${grant.grantId} names`, kind: 'key' };
  }
  if (key.keyId !== grant.keyId) {
    return { ok: false, why: `the key file's id is not the grant ${grant.grantId}'s key id`, kind: 'key' };
  }

  const requestId = input.requestId ?? clientRequestId();
  if (!CLIENT_REQUEST_ID_PATTERN.test(requestId)) {
    return {
      ok: false,
      why: `"${requestId}" is not a request id: one word of letters, digits, dots, hyphens or underscores`,
      kind: 'refused',
    };
  }
  if (!CLIENT_GRANT_ID_PATTERN.test(grant.grantId)) {
    return { ok: false, why: `"${grant.grantId}" is not a client grant id`, kind: 'refused' };
  }
  const request: ClientReadRequest = {
    v: 2,
    op: 'messages',
    grant_id: grant.grantId,
    client_id: grant.clientId,
    key_id: grant.keyId,
    entity: grant.entity,
    since: input.since,
    ack: input.ack,
    limit: input.limit,
    request_id: requestId,
    issued_at: input.now.toISOString(),
    challenge: null,
  };
  let signature: string;
  try {
    signature = signClientReadRequest(request, key.privatePem);
  } catch {
    return { ok: false, why: 'the request could not be signed with the app key', kind: 'key' };
  }
  const publicKey = publicKeyObject(grant.publicKey);
  if (publicKey === null || !clientReadRequestVerifies(request, signature, publicKey)) {
    return { ok: false, why: "the request signature does not verify under the grant's app key", kind: 'key' };
  }

  const canonical = canonicalClientGrant(input.home, presented);
  if (!canonical.ok) return { ok: false, why: canonical.why, kind: 'refused' };
  if (clientGrantExpired(canonical.grant.expires, input.now)) {
    return { ok: false, why: `the grant ${grant.grantId} expired at ${grant.expires}`, kind: 'refused' };
  }
  const revocation = clientRevocations(input.home, grant.grantId);
  if (!revocation.ok) return { ok: false, why: revocation.why, kind: 'refused' };
  if (revocation.records[0] !== undefined) {
    return { ok: false, why: `the grant ${grant.grantId} was revoked at ${revocation.records[0].at}`, kind: 'refused' };
  }
  const masterRevoked = clientMasterRevocation(input.home, grant);
  if (masterRevoked !== null) return { ok: false, why: masterRevoked, kind: 'refused' };

  return { ok: true, grant, request, signature };
}

// ---- sub-grant requests under a master grant ----------------------------------------------

/** The domain tag a sub-grant request carries: never a send, a read or an owner signature. */
export const CLIENT_GRANT_REQUEST_DOMAIN = 'team-client-grant-request-v1\n';

/** One signed sub-grant request, exactly the fields the master key's signature covers. */
export type ClientGrantIssueRequest = {
  v: 1;
  op: 'grant';
  master_grant_id: string;
  master_key_id: string;
  client_id: string;
  entity: string;
  team: string | null;
  seat: string | null;
  public_key: string;
  key_id: string;
  key_dir: string;
  expires: string | null;
  inbox: boolean;
  request_id: string;
  issued_at: string;
};

export function clientGrantIssueRequestBody(request: ClientGrantIssueRequest): Json {
  return { ...request };
}

export function signClientGrantIssueRequest(request: ClientGrantIssueRequest, privatePem: string): string {
  return signDomain(CLIENT_GRANT_REQUEST_DOMAIN, clientGrantIssueRequestBody(request), createPrivateKey(privatePem));
}

export function clientGrantIssueRequestVerifies(request: ClientGrantIssueRequest, signature: string, publicKey: KeyObject): boolean {
  return verifyDomain(CLIENT_GRANT_REQUEST_DOMAIN, clientGrantIssueRequestBody(request), signature, publicKey);
}

/** What an admitted request resolves to: the master in force and the sub-grant's exact expiry. */
export type ClientGrantIssueAdmission =
  | { ok: true; master: ClientGrantRecord; request: ClientGrantIssueRequest; signature: string; expires: string }
  | { ok: false; why: string };

/**
 * Admits one signed sub-grant request against a presented master grant. Every invariant the owner
 * set is checked here, in order: the signature verifies under the master's own app key; the master
 * is a vocabulary-3 grant carrying `grant`, canonical, unexpired and unrevoked; the request names
 * that master and its key; the requested ops stay inside the master's, minus `grant` (a sub-grant
 * never carries `grant`); the target entity, team and project are inside the master's scope (an
 * empty scope admits nothing); and the sub-grant's expiry is at most the master's — absent, it is
 * clamped to the earlier of seven days and the master's expiry. Seat admission is the issuer's
 * (`planClientGrant`), the same as on the owner path.
 */
export function admitClientGrantIssue(
  home: string,
  presented: { grant: ClientGrantRecord; signature: string },
  request: ClientGrantIssueRequest,
  signature: string,
  now: Date,
): ClientGrantIssueAdmission {
  const master = presented.grant;
  const publicKey = publicKeyObject(master.publicKey);
  if (publicKey === null || !clientGrantIssueRequestVerifies(request, signature, publicKey)) {
    return { ok: false, why: "the grant request signature does not verify under the master grant's app key" };
  }
  if (request.v !== 1 || request.op !== 'grant') return { ok: false, why: 'the grant request is not a version-1 grant request' };
  if (request.master_grant_id !== master.grantId || request.master_key_id !== master.keyId) {
    return { ok: false, why: `the grant request does not name the master grant ${master.grantId} and its key` };
  }
  if (master.vocabulary !== CLIENT_MASTER_VOCABULARY_VERSION || !master.allowedOps.includes('grant') || master.grantScope === undefined) {
    return { ok: false, why: `the grant ${master.grantId} does not carry grant: only an owner-issued master grant issues sub-grants` };
  }
  const active = activeClientGrant(home, presented, now);
  if (!active.ok) return { ok: false, why: active.why };
  if (request.inbox && !master.allowedOps.includes('messages')) {
    return { ok: false, why: `the master grant ${master.grantId} does not carry messages; a sub-grant never widens it with --inbox` };
  }
  if (!CLIENT_PUBLIC_KEY_PATTERN.test(request.public_key)) return { ok: false, why: 'the requested public key is not 64 hex' };
  const team = request.team ?? request.entity;
  const resolved = resolveEntityCoordinator(home, request.entity, {
    clientId: request.client_id,
    ...(request.team !== null && request.team !== request.entity ? { team: request.team } : {}),
    ...(request.seat !== null ? { seat: request.seat } : {}),
  });
  if (!resolved.ok) return { ok: false, why: resolved.why };
  let project: string;
  try {
    project = ofTeam(home, resolved.coordinator.teamId)?.id ?? team;
  } catch {
    return { ok: false, why: 'the project registry cannot be read' };
  }
  if (!clientGrantScopeAdmits(master, { entity: request.entity, team, project })) {
    return { ok: false, why: `${request.seat ?? 'orchestrator'}@${team} (entity ${request.entity}, project ${project}) is outside the master grant ${master.grantId}'s scope` };
  }
  // A master grant always carries an end date (its decoder refuses `null`), so this is a number.
  const masterExpires = endsAtMs(master.expires);
  const nowMs = now.getTime();
  let expires: string;
  if (request.expires === null) {
    // The default length is seven days or the `client-grant-max-duration` send cap when that is
    // shorter, and never past the master's own end. An unreadable chain refuses.
    const inForce = grantDurationInForce(home, request.entity, projectIdOfTeamId(home, resolved.coordinator.teamId), now);
    if (!inForce.ok) return { ok: false, why: `${inForce.why}; nothing was signed` };
    const sendCap = inForce.caps.send;
    const lengthMs = sendCap === null ? CLIENT_EXPIRY_MAX_MS : Math.min(CLIENT_EXPIRY_MAX_MS, sendCap * DAY_MS);
    expires = new Date(Math.min(nowMs + lengthMs, masterExpires)).toISOString();
  } else {
    const wanted = Date.parse(request.expires);
    if (!Number.isFinite(wanted)) return { ok: false, why: `"${request.expires}" is not a readable expiry timestamp` };
    if (wanted > masterExpires) {
      return { ok: false, why: `the expiry ${request.expires} is past the master grant's ${master.expires}: a sub-grant never outlives its master` };
    }
    expires = request.expires;
  }
  return { ok: true, master, request, signature, expires };
}

/**
 * Builds, signs and admits one sub-grant request from the invocation: the master file verifies
 * under the owner key; the key file passes its hygiene rules and is the master's own key; the
 * request is signed with it and then admitted ({@link admitClientGrantIssue}).
 */
export function verifyClientGrantIssue(input: {
  home: string;
  masterFile: string;
  keyFile: string;
  clientId: string;
  entity: string;
  team: string | null;
  seat: string | null;
  publicKey: string;
  keyId: string;
  keyDir: string;
  expires: string | null;
  inbox: boolean;
  now: Date;
  requestId?: string;
}): ClientGrantIssueAdmission {
  const presented = readClientGrantFile(input.home, input.masterFile);
  if (!presented.ok) return { ok: false, why: presented.why };
  const master = presented.grant;
  const key = readClientPrivateKey(input.home, input.keyFile);
  if (!key.ok) return { ok: false, why: key.why };
  if (key.publicKey !== master.publicKey || key.keyId !== master.keyId) {
    return { ok: false, why: `the key file is not the app key the master grant ${master.grantId} names` };
  }
  const requestId = input.requestId ?? clientRequestId();
  if (!CLIENT_REQUEST_ID_PATTERN.test(requestId)) return { ok: false, why: `"${requestId}" is not a request id` };
  if (!CLIENT_GRANT_ID_PATTERN.test(master.grantId)) return { ok: false, why: `"${master.grantId}" is not a client grant id` };
  const request: ClientGrantIssueRequest = {
    v: 1,
    op: 'grant',
    master_grant_id: master.grantId,
    master_key_id: master.keyId,
    client_id: input.clientId,
    entity: input.entity,
    team: input.team,
    seat: input.seat,
    public_key: input.publicKey,
    key_id: input.keyId,
    key_dir: input.keyDir,
    expires: input.expires,
    inbox: input.inbox,
    request_id: requestId,
    issued_at: input.now.toISOString(),
  };
  let signature: string;
  try {
    signature = signClientGrantIssueRequest(request, key.privatePem);
  } catch {
    return { ok: false, why: 'the grant request could not be signed with the app key' };
  }
  return admitClientGrantIssue(input.home, presented, request, signature, input.now);
}
