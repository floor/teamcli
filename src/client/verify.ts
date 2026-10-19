// The request one external client signs with its own app key: the send operation, the entity and
// orchestrator it is addressed to, the body's digest and a request id used once. The app key is
// bound to a grant's public key, so a request signed with any other key is refused. The signature
// covers a domain of its own, so it is never an approval, a message or a grant.
//
// The request id is what makes a retried invocation safe: the send path claims it before the drop
// is written and refuses a second claim, including one left by a crashed attempt.

import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { CLIENT_GRANT_ID_PATTERN, CLIENT_SLICE_CLIENT_ID, CLIENT_SLICE_ENTITY, CLIENT_SLICE_SEAT, canonicalClientGrant, clientRevocations, publicKeyObject, readClientGrantFile, readClientPrivateKey, type ClientGrantRecord } from './records.ts';
import { signDomain, verifyDomain, type Json } from '../store/keys.ts';

/** The domain tag a client request signature carries. */
export const CLIENT_REQUEST_DOMAIN = 'team-client-request-v1\n';

/** A request id names a file in the replay store: one path segment, no separators. */
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  if (grant.clientId !== CLIENT_SLICE_CLIENT_ID) {
    return { ok: false, why: `this build admits one client principal, "${CLIENT_SLICE_CLIENT_ID}"` };
  }
  if (grant.entity !== CLIENT_SLICE_ENTITY) {
    return { ok: false, why: `this build admits one entity, "${CLIENT_SLICE_ENTITY}"` };
  }
  if (grant.allowedOps[0] !== 'send') return { ok: false, why: `the grant ${grant.grantId} does not admit send` };
  if (grant.allowedRoles[0] !== 'orchestrator') {
    return { ok: false, why: `the grant ${grant.grantId} does not admit the orchestrator role` };
  }
  if (grant.entity !== input.target.entity) {
    return { ok: false, why: `the grant ${grant.grantId} is for entity "${grant.entity}", not "${input.target.entity}"` };
  }
  if (input.target.recipientSeat.toLowerCase() !== CLIENT_SLICE_SEAT) {
    return { ok: false, why: `a client grant sends only to ${CLIENT_SLICE_SEAT}@${CLIENT_SLICE_ENTITY}` };
  }
  // The grant's signed recipient is the one the request may name: resolving some other agent now
  // does not change what the signature binds.
  if (input.target.recipientId !== grant.recipientId || input.target.recipientSeat !== grant.recipientSeat) {
    return { ok: false, why: `the resolved ${CLIENT_SLICE_SEAT} is not the recipient the grant ${grant.grantId} signs` };
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
  const expiresMs = Date.parse(canonical.grant.expires);
  if (!Number.isFinite(expiresMs) || expiresMs <= input.now.getTime()) {
    return { ok: false, why: `the grant ${grant.grantId} expired at ${grant.expires}` };
  }
  const revocation = clientRevocations(input.home, grant.grantId);
  if (!revocation.ok) return { ok: false, why: revocation.why };
  if (revocation.records[0] !== undefined) {
    return { ok: false, why: `the grant ${grant.grantId} was revoked at ${revocation.records[0].at}` };
  }

  return { ok: true, grant, request, signature };
}
