// The owner page: a tiny WebAuthn page served by `team owner-seat serve` on 127.0.0.1, so the
// owner never types a command. The orchestrator starts the server and sends the link; the owner opens it in
// the Mac's browser and approves with a passkey: Touch ID on the Mac, or the iPhone through the
// browser's "use a phone" QR code (hybrid transport). The relying party is `localhost`, a secure
// context for WebAuthn without a certificate.
//
// What the page can do, each completed only by an owner-device signature:
// - register a passkey as an owner signer (the existing Secure Enclave signer confirms with Touch ID);
// - sign the waiting security-profile proposal;
// - answer a waiting team-create request, a grant, or a team import / add / up request
//   (approve once, always allow, or deny; the posted word stays oui / always / non).
// Every API call carries the per-run token from the link and must come to Host localhost:<port>.

import { msg } from '../client/grant-messages.ts';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { clearOwnerPageLink, writeOwnerPageLink } from '../client/owner-page-link.ts';
import { addOwnerSigner, ownerSeatMessages, ownerSeatPublicKey, readOwnerSeat, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { grantCard, ownerActionCard, ownerActionDetails, teamCreateCard, teamCreateDetails } from '../client/approval-card.ts';
import { actionRequestsFolder, approveTeamCreate, type TeamCreateParams } from '../client/team-create.ts';
import { approveOwnerAction, OWNER_ACTION_ID_PATTERN, OWNER_ACTIONS, type OwnerAction, type OwnerActionParams } from '../client/owner-action.ts';
import { approveAsOwnerSeat, GRANT_REQUEST_ID_PATTERN, grantRequestsFolder, pendingGrantPrompt } from '../client/emission.ts';
import { existsSync, readFileSync } from 'node:fs';
import { openRequestLink } from '../client/request-link.ts';
import { join } from 'node:path';
import { ownerDeviceConsent, readProposal, readSecurityProfile, securityProfileChallenge, securityProfileLine, signSecurityProfile } from './profile.ts';

export const OWNER_PAGE_RP_ID = 'localhost';

/** The uncompressed P-256 point (hex) inside a SubjectPublicKeyInfo, as `getPublicKey()` returns it. */
export function spkiToPoint(spki: Buffer): string | null {
  if (spki.length < 65) return null;
  const point = spki.subarray(spki.length - 65).toString('hex');
  return point.startsWith('04') && ownerSeatPublicKey(point) !== null ? point : null;
}

/** A DER ECDSA signature is what WebAuthn returns for ES256; the store wants it in hex. */
export function derB64urlToHex(signature: string): string {
  return Buffer.from(signature, 'base64url').toString('hex');
}

type Assertion = { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };

export type OwnerPageOptions = { home: string; store: OwnerSeatKeyStore; port?: number; token?: string; now?: () => Date };

const MIGRATION_ACTIONS = new Set<OwnerAction>(['team-migrate']);

export type OwnerPageRequest = {
  id: string;
  /** The inbox line. The page shows the card instead of this prompt. */
  text: string;
  /** The card's title line, in plain words: `TeamCLI: change the team's record`. */
  title: string;
  /** The card's question, one sentence. */
  description: string;
  /** The card's third line, when the kind has one: who asked and what the answer covers. */
  scope?: string;
  /** Approve once and Deny only. Migrations, and grants a standing rule cannot cover. */
  onceOnly: boolean;
  /**
   * The record, folded under the card: request id, repository, HEAD, bound arguments, hashes. It
   * is never a card line; the card carries at most three plain lines.
   */
  details?: string;
};

/** The refusal the page shows when the passkey or signer is already on the owner seat. */
export const ALREADY_REGISTERED = msg('page.already_registered');

const SHOWN_KINDS = new Set(['team-create-confirmation', 'owner-action-confirmation', 'grant-confirmation']);

function strippedPrompt(text: string): string {
  return text.replace(/\s*Authorized\?[\s\S]*$/, '').trim();
}

function isOwnerAction(summary: unknown): summary is OwnerActionParams {
  if (typeof summary !== 'object' || summary === null) return false;
  const s = summary as { kind?: unknown; actions?: unknown };
  // Every action must be one this build knows, or its card has no words: such a message gets the
  // generic card instead of an exception while the page renders.
  return s.kind === 'owner-action' && Array.isArray(s.actions) && s.actions.length > 0 && s.actions.every((action) => typeof action === 'string' && (OWNER_ACTIONS as readonly string[]).includes(action));
}

function isTeamCreate(summary: unknown): summary is TeamCreateParams {
  return typeof summary === 'object' && summary !== null && (summary as { kind?: string }).kind === 'team-create';
}

type GrantCard = { text?: string; master?: boolean; up?: unknown; expires?: string | null };

function isGrantCard(summary: unknown): summary is GrantCard {
  return typeof summary === 'object' && summary !== null && typeof (summary as { text?: unknown }).text === 'string';
}

/**
 * The card for one inbox message: title, question, and at most one scope line, all from the
 * message catalog, plus the record folded into `details`. A message with no readable summary
 * (one written by an older build) gets the generic card and its text in the details; nothing
 * recorded is dropped, and nothing recorded is printed on the card.
 */
export function ownerPageRequest(message: { request_id: string; text?: string; kind?: string; summary?: unknown; params_sha256?: unknown }, grantPrompt: string | null = null): OwnerPageRequest {
  const id = message.request_id;
  const text = typeof message.text === 'string' ? message.text : '';
  const kind = message.kind ?? '';
  const summary = message.summary;
  const hash = typeof message.params_sha256 === 'string' ? message.params_sha256 : undefined;
  const unknown = (what: string): OwnerPageRequest => ({
    id, text, title: msg('card.title.approval'), description: msg('card.question.approval'), onceOnly: false,
    details: [msg('card.details.request', { id }), what].join('\n'),
  });
  if (kind === 'owner-action-confirmation' || isOwnerAction(summary)) {
    if (!isOwnerAction(summary)) return unknown(strippedPrompt(text));
    const params = summary;
    const card = ownerActionCard(params);
    const onceOnly = params.actions.some((action) => MIGRATION_ACTIONS.has(action));
    const details = ownerActionDetails({ request_id: id, params, ...(hash === undefined ? {} : { params_sha256: hash }) });
    return { id, text, title: card.title, description: card.question, ...(card.scope === undefined ? {} : { scope: card.scope }), onceOnly, details: details.join('\n') };
  }
  if (kind === 'team-create-confirmation' || isTeamCreate(summary)) {
    if (!isTeamCreate(summary)) return unknown(strippedPrompt(text));
    const card = teamCreateCard(summary);
    const details = teamCreateDetails({ request_id: id, params: summary, ...(hash === undefined ? {} : { params_sha256: hash }) });
    return { id, text, title: card.title, description: card.question, ...(card.scope === undefined ? {} : { scope: card.scope }), onceOnly: false, details: details.join('\n') };
  }
  if (kind === 'grant-confirmation' || id.startsWith('gr_')) {
    const grant = isGrantCard(summary) ? summary : null;
    const onceOnly = grant !== null && (grant.master === true || grant.up != null || grant.expires === null);
    const prompt = grantPrompt ?? (typeof (summary as { prompt?: unknown } | null)?.prompt === 'string' ? (summary as { prompt: string }).prompt : null);
    const card = grantCard({ prompt: prompt ?? msg('card.grant.question'), ...(grant?.master === true ? { master: true } : {}), ...(grant?.up != null ? { up: true } : {}) });
    const full = grant?.text ?? strippedPrompt(text);
    const details = [msg('card.details.request', { id }), full].join('\n');
    return { id, text, title: card.title, description: card.question, ...(onceOnly ? { scope: msg('card.scope.once') } : {}), onceOnly, details };
  }
  return unknown(strippedPrompt(text));
}

export function ownerPageHandler(options: OwnerPageOptions & { port: number; token: string }) {
  const { home, store, token } = options;
  const now = options.now ?? (() => new Date());
  const registrations = new Map<string, number>();
  const pendingAnswers = new Map<string, { at: Date; challenge: string }>();

  const signerOfCredential = (credentialId: string) => readOwnerSeat(home)?.signers.find((s) => s.type === 'webauthn' && s.credential_id === credentialId);
  const assertionOf = (a: Assertion) => ({ authenticator_data: a.authenticatorData, client_data_json: a.clientDataJSON, signature: derB64urlToHex(a.signature) });

  // A request already answered, or past its fifteen minutes, is not shown again.
  const answeredOrExpired = (id: string): boolean => {
    const folder = GRANT_REQUEST_ID_PATTERN.test(id) ? grantRequestsFolder(home) : actionRequestsFolder(home);
    try {
      if (existsSync(join(folder, `${id}.seat-answer.json`))) return true;
      if (GRANT_REQUEST_ID_PATTERN.test(id) && (existsSync(join(folder, `${id}.answer.json`)) || existsSync(join(folder, `${id}.used`)))) return true;
      // A grant request is stored signed ({ grant_request, signature }): its expiry is inside.
      // Reading only the top level hid every pending grant from the page.
      const raw = JSON.parse(readFileSync(join(folder, `${id}.json`), 'utf8')) as { expires_at?: string | null; grant_request?: { expires_at?: string | null } };
      const expires = raw.grant_request !== undefined && typeof raw.grant_request === 'object' && raw.grant_request !== null ? raw.grant_request.expires_at : raw.expires_at;
      if (expires === null) return false;
      return typeof expires !== 'string' || Date.parse(expires) <= now().getTime();
    } catch {
      return true;
    }
  };
  // One answer route: a grant id (gr_), an owner-action id (oa_), or a team-create id (tc_).
  const approveAny = (
    id: string,
    word: string,
    at: Date,
    via: { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string } },
  ) => {
    if (GRANT_REQUEST_ID_PATTERN.test(id)) return approveAsOwnerSeat(home, id, word, store, at, via);
    if (OWNER_ACTION_ID_PATTERN.test(id)) return approveOwnerAction(home, id, word, store, at, via);
    return approveTeamCreate(home, id, word, store, at, via);
  };
  // The page signs with a passkey: the first webauthn owner signer is the one the prompt names.
  const webauthnSignerName = () => readOwnerSeat(home)?.signers.find((s) => s.type === 'webauthn')?.name ?? null;
  const state = () => {
    const seat = readOwnerSeat(home);
    const proposal = readProposal(home);
    return {
      seat: seat === null ? null : { team: seat.team, signers: seat.signers.map((s) => ({ name: s.name, type: s.type, credential_id: s.credential_id ?? null })) },
      profile: securityProfileLine(readSecurityProfile(home, store, now())),
      proposal: proposal === null ? null : { profile: proposal.profile, expires: proposal.expires, signer: proposal.signer, challenge: securityProfileChallenge(proposal) },
      requests: ownerSeatMessages(home)
        .filter((m) => SHOWN_KINDS.has((m as { kind?: string }).kind ?? ''))
        .filter((m) => !answeredOrExpired(m.request_id))
        .map((m) => ownerPageRequest(m as { request_id: string; text?: string; kind?: string; summary?: unknown }, GRANT_REQUEST_ID_PATTERN.test(m.request_id) ? pendingGrantPrompt(home, m.request_id, now(), webauthnSignerName()) : null)),
      rp_id: OWNER_PAGE_RP_ID,
    };
  };

  const routes: Record<string, (body: Record<string, unknown>) => { status: number; body: unknown }> = {
    'GET /api/state': () => ({ status: 200, body: state() }),
    'POST /api/register/options': () => {
      if (readOwnerSeat(home) === null) return { status: 409, body: { error: 'no owner seat yet: the orchestrator runs team owner-seat setup first' } };
      const challenge = randomBytes(32).toString('base64url');
      registrations.set(challenge, now().getTime());
      return { status: 200, body: { challenge, rp_id: OWNER_PAGE_RP_ID, user_id: randomBytes(16).toString('base64url') } };
    },
    'POST /api/register': (b) => {
      const name = String(b.signer ?? '');
      const credentialId = String(b.credentialId ?? '');
      let clientData: { type?: string; challenge?: string };
      try {
        clientData = JSON.parse(Buffer.from(String(b.clientDataJSON ?? ''), 'base64url').toString('utf8'));
      } catch {
        return { status: 400, body: { error: 'no client data' } };
      }
      const issued = registrations.get(clientData.challenge ?? '');
      if (clientData.type !== 'webauthn.create' || issued === undefined || now().getTime() - issued > 5 * 60_000) return { status: 400, body: { error: 'the registration is not for a challenge this page issued' } };
      registrations.delete(clientData.challenge!);
      const point = spkiToPoint(Buffer.from(String(b.publicKey ?? ''), 'base64url'));
      if (point === null) return { status: 400, body: { error: 'the passkey is not a P-256 key (ES256)' } };
      // Already on the owner seat (same name, credential or key): nothing to do, said plainly,
      // before any Touch ID prompt.
      const known = readOwnerSeat(home)?.signers.some((s) => s.name === name || s.public_key === point || (s.credential_id !== undefined && s.credential_id === credentialId)) ?? false;
      if (known) return { status: 409, body: { error: ALREADY_REGISTERED, already_registered: true } };
      // The existing Secure Enclave signer confirms the new passkey: one Touch ID on the Mac,
      // verified under the key the credential store confirms, and audited.
      const confirmed = ownerDeviceConsent(home, store, { act: 'add-passkey-signer', signer: name, public_key: point, credential_id: credentialId, rp_id: OWNER_PAGE_RP_ID }, `Add passkey "${name}" as a TeamCLI owner signer`, now());
      if (!confirmed.ok) return { status: 403, body: { error: confirmed.why } };
      const added = addOwnerSigner(home, { signer: name, type: 'webauthn', publicKey: point, credentialId, rpId: OWNER_PAGE_RP_ID }, store, now());
      if (!added.ok && /already registered/.test(added.why)) return { status: 409, body: { error: ALREADY_REGISTERED, already_registered: true } };
      return added.ok ? { status: 200, body: { ok: true, signer: name } } : { status: 400, body: { error: added.why } };
    },
    'POST /api/profile/sign': (b) => {
      const a = b as unknown as Assertion;
      const signer = signerOfCredential(a.credentialId);
      const proposal = readProposal(home);
      if (signer === undefined || proposal === null || proposal.signer !== signer.name) return { status: 400, body: { error: 'this passkey is not the signer the proposal names' } };
      const signed = signSecurityProfile(home, store, assertionOf(a), now());
      return signed.ok ? { status: 200, body: { ok: true, profile: securityProfileLine(readSecurityProfile(home, store, now())) } } : { status: 400, body: { error: signed.why } };
    },
    'POST /api/team-create/challenge': (b) => {
      const id = String(b.id ?? '');
      const word = String(b.word ?? '');
      const signer = signerOfCredential(String(b.credentialId ?? ''));
      if (signer === undefined) return { status: 400, body: { error: 'unknown passkey' } };
      const at = now();
      // Asked without an assertion, the signer names the exact challenge; nothing is written.
      const probe = approveAny(id, word, at, { signer: signer.name });
      const challenge = !probe.ok ? /sign challenge (\S+)/.exec(probe.why)?.[1] : undefined;
      if (challenge === undefined) return { status: 400, body: { error: probe.ok ? 'unexpected' : probe.why } };
      pendingAnswers.set(`${id}:${word}:${signer.name}`, { at, challenge });
      return { status: 200, body: { challenge } };
    },
    'POST /api/team-create/answer': (b) => {
      const a = b as unknown as Assertion & { id: string; word: string };
      const signer = signerOfCredential(a.credentialId);
      const pending = signer === undefined ? undefined : pendingAnswers.get(`${a.id}:${a.word}:${signer.name}`);
      if (signer === undefined || pending === undefined) return { status: 400, body: { error: 'no challenge was issued for this answer' } };
      pendingAnswers.delete(`${a.id}:${a.word}:${signer.name}`);
      const answered = approveAny(a.id, a.word, pending.at, { signer: signer.name, assertion: assertionOf(a) });
      return answered.ok ? { status: 200, body: { ok: true, choice: answered.choice } } : { status: 400, body: { error: answered.why } };
    },
  };

  // One-request link sessions: opened once with the link's nonce, bound to that one request id,
  // in memory only, never longer than the request. A session reads that card and may ask for an
  // answer; the answer is written only by approveAsOwnerSeat, which needs an owner-signer signature.
  const linkSessions = new Map<string, { id: string; until: number }>();
  const LINK_SESSION_MS = 15 * 60_000;
  const sessionFor = (id: string, b: Record<string, unknown>): boolean => {
    const s = linkSessions.get(String(b.session ?? ''));
    return s !== undefined && s.id === id && s.until > now().getTime() && !answeredOrExpired(id);
  };
  const cardOf = (id: string) => {
    const message = ownerSeatMessages(home).find((m) => m.request_id === id) as { request_id: string; text?: string; kind?: string; summary?: unknown } | undefined;
    const prompt = pendingGrantPrompt(home, id, now(), webauthnSignerName());
    return ownerPageRequest(message ?? { request_id: id, kind: 'grant-confirmation' }, prompt);
  };
  const linkRoute = (method: string, id: string, action: string, b: Record<string, unknown>): { status: number; body: unknown } => {
    if (method === 'POST' && action === 'open') {
      const opened = openRequestLink(home, id, String(b.nonce ?? ''), now());
      if (!opened.ok || answeredOrExpired(id)) return { status: 403, body: { error: opened.ok ? 'this request is already answered or expired' : opened.why } };
      const session = randomBytes(18).toString('base64url');
      linkSessions.set(session, { id, until: now().getTime() + LINK_SESSION_MS });
      const seat = readOwnerSeat(home);
      return { status: 200, body: { session, request: cardOf(id), rp_id: OWNER_PAGE_RP_ID, signers: (seat?.signers ?? []).map((x) => ({ name: x.name, type: x.type, credential_id: x.credential_id })) } };
    }
    if (method !== 'POST' || !sessionFor(id, b)) return { status: 403, body: { error: 'open this request from its link first' } };
    const word = String(b.word ?? '');
    if (action === 'challenge') return routes['POST /api/team-create/challenge']!({ id, word, credentialId: b.credentialId });
    if (action === 'answer') return routes['POST /api/team-create/answer']!({ ...b, id, word });
    if (action === 'touch-id') {
      // The Mac's Secure Enclave signer: Touch ID in the owner's session signs the answer.
      const signer = readOwnerSeat(home)?.signers.find((x) => x.type === 'mac-keystore');
      if (signer === undefined) return { status: 400, body: { error: 'no Touch ID signer on the owner seat' } };
      const answered = approveAsOwnerSeat(home, id, word, store, now(), { signer: signer.name });
      return answered.ok ? { status: 200, body: { ok: true, choice: answered.choice } } : { status: 400, body: { error: answered.why } };
    }
    return { status: 404, body: { error: 'not found' } };
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.headers.host !== `localhost:${options.port}`) return send(403, { error: 'open the page at http://localhost:' + options.port });
    // The one-request link: no page token; the nonce (fragment, posted once) opens one card.
    const linkPage = /^\/r\/(gr_[0-9a-f]{24})$/.exec(url.pathname);
    if (req.method === 'GET' && linkPage !== null) return send(200, REQUEST_PAGE_HTML, 'text/html; charset=utf-8');
    const linkApi = /^\/api\/r\/(gr_[0-9a-f]{24})\/(open|challenge|answer|touch-id)$/.exec(url.pathname);
    if (linkApi !== null) {
      if (req.method !== 'POST') return send(405, { error: 'POST only' });
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(400, { error: 'not JSON' });
      }
      try {
        const out = linkRoute(req.method, linkApi[1]!, linkApi[2]!, b);
        return send(out.status, out.body);
      } catch (error) {
        return send(500, { error: String((error as Error).message ?? error) });
      }
    }
    if (url.searchParams.get('t') !== token) return send(403, { error: 'missing or wrong page token' });
    if (req.method === 'GET' && url.pathname === '/') return send(200, OWNER_PAGE_HTML, 'text/html; charset=utf-8');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route === undefined) return send(404, { error: 'not found' });
    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(400, { error: 'not JSON' });
      }
    }
    try {
      const out = route(body);
      return send(out.status, out.body);
    } catch (error) {
      return send(500, { error: String((error as Error).message ?? error) });
    }
  };
}

export function serveOwnerPage(options: OwnerPageOptions): Promise<{ server: Server; url: string; port: number; token: string }> {
  const token = options.token ?? randomBytes(18).toString('base64url');
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7391, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 7391);
      server.on('request', ownerPageHandler({ ...options, port, token }));
      const link = { pid: process.pid, port, url: `http://localhost:${port}/?t=${token}` };
      writeOwnerPageLink(options.home, link);
      server.on('close', () => clearOwnerPageLink(options.home, link));
      resolve({ server, url: link.url, port, token });
    });
  });
}

/** Fingerprint shown on the page so the owner can match it with what the orchestrator said. */
export function challengeWords(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex').slice(0, 8);
}

export const OWNER_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamCLI – owner seat</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#222}
button{font-size:16px;padding:.6em 1em;margin:.3em .3em .3em 0;border-radius:8px;border:1px solid #888;background:#f4f4f4}
.relaxed{color:#b00;font-weight:600}.card{border:1px solid #ddd;border-radius:10px;padding:1em;margin:1em 0}
.hint{color:#555;font-size:14px;margin:.6em 0;white-space:pre-wrap}.card p{margin:.4em 0}#log{color:#555;white-space:pre-wrap}</style></head>
<body><h1>Owner seat</h1><p id="profile"></p><div id="cards"></div><p id="log"></p>
<script>
const t = new URLSearchParams(location.search).get('t');
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length+3)%4)), c => c.charCodeAt(0));
const api = async (method, path, body) => { const r = await fetch(path + '?t=' + encodeURIComponent(t), { method, headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
const log = (m) => { document.getElementById('log').textContent = m; };
let S;
async function assertOver(challenge) {
  const allow = S.seat.signers.filter(s => s.type === 'webauthn').map(s => ({ type: 'public-key', id: unb64u(s.credential_id) }));
  const c = await navigator.credentials.get({ publicKey: { challenge: unb64u(challenge), rpId: S.rp_id, allowCredentials: allow, userVerification: 'required', timeout: 120000 } });
  return { credentialId: b64u(c.rawId), authenticatorData: b64u(c.response.authenticatorData), clientDataJSON: b64u(c.response.clientDataJSON), signature: b64u(c.response.signature) };
}
async function register() {
  const name = prompt('Name for this passkey (for example, iphone)', 'iphone'); if (!name) return;
  const o = await api('POST', '/api/register/options');
  const c = await navigator.credentials.create({ publicKey: { challenge: unb64u(o.challenge), rp: { id: o.rp_id, name: 'TeamCLI owner seat' }, user: { id: unb64u(o.user_id), name: 'owner-' + name, displayName: 'TeamCLI owner (' + name + ')' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 120000 } });
  log('Confirm with Touch ID on the Mac…');
  await api('POST', '/api/register', { signer: name, credentialId: b64u(c.rawId), publicKey: b64u(c.response.getPublicKey()), clientDataJSON: b64u(c.response.clientDataJSON) });
  log('Passkey ' + name + ' saved.'); load();
}
async function signProfile() { const a = await assertOver(S.proposal.challenge); const r = await api('POST', '/api/profile/sign', a); log('Profile signed. ' + r.profile); load(); }
async function answer(id, word) {
  const first = S.seat.signers.find(s => s.type === 'webauthn');
  const ch = await api('POST', '/api/team-create/challenge', { id, word, credentialId: first.credential_id });
  const a = await assertOver(ch.challenge);
  const r = await api('POST', '/api/team-create/answer', { ...a, id, word }); log('Answer saved: ' + r.choice); load();
}
let busy = 0;
const run = (f) => (...a) => { busy++; return f(...a).catch(e => log(/already registered/.test(e.message) ? e.message : 'Refused: ' + e.message)).finally(() => { busy--; }); };
let stamp = '';
async function load() {
  if (busy) return;
  const next = await api('GET', '/api/state');
  const mark = JSON.stringify([next.profile, next.proposal, (next.requests || []).map(r => r.id + '\\n' + (r.title || '') + '\\n' + r.onceOnly + '\\n' + (r.description || '') + '\\n' + (r.scope || '') + '\\n' + (r.details || '') + '\\n' + r.text), next.seat]);
  S = next;
  if (mark === stamp) return;
  stamp = mark;
  const p = document.getElementById('profile'); p.textContent = S.profile; p.className = /RELAXED/.test(S.profile) ? 'relaxed' : '';
  const cards = document.getElementById('cards'); cards.innerHTML = '';
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const card = (html) => { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = html; cards.appendChild(d); return d; };
  if (!S.seat) { card('No owner seat yet. Ask the orchestrator to run setup.'); return; }
  const hasPasskey = S.seat.signers.some(s => s.type === 'webauthn');
  const reg = card('<b>Passkey</b>: ' + (hasPasskey ? 'saved.' : 'none yet.') + '<br><button>Add a passkey (iPhone or Mac)</button>'); reg.querySelector('button').onclick = run(register);
  if (S.proposal && hasPasskey) { const d = card('<b>Proposed security profile</b>: ' + esc(S.proposal.profile) + ' until ' + esc(S.proposal.expires) + '<br><button>Approve with my passkey</button>'); d.querySelector('button').onclick = run(signProfile); }
  if (hasPasskey && S.requests.length === 0) card('<p class="hint">${msg('page.no_pending')}</p>');
  for (const r of S.requests) {
    if (!hasPasskey) break;
    // The card is at most three plain lines; the record is only in the fold. The request id is
    // in the fold too, never beside the title.
    const scope = r.scope ? '<p class="hint">' + esc(r.scope) + '</p>' : '';
    if (r.id.startsWith('gr_')) {
      const always = r.onceOnly ? '' : '<button data-w="always">${msg('page.always_allow')}</button>';
      const details = '<details><summary>${msg('page.details')}</summary><p class="hint">' + esc(r.details || '') + '</p></details>';
      const d = card('<b>' + esc(r.title || '${msg('page.title.grant')}') + '</b><p>' + esc(r.description) + '</p>' + scope + details + '<button data-w="oui">${msg('page.approve_once')}</button>' + always + '<button data-w="non">${msg('page.deny')}</button>');
      d.querySelectorAll('button').forEach(btn => btn.onclick = run(() => answer(r.id, btn.dataset.w)));
      continue;
    }
    const hint = r.onceOnly
      ? 'This needs a one-time approval. Choose Approve once.'
      : 'Approve once is a one-time approval. A migration needs that. Always allow also permits later runs of the same action in this folder.';
    const details = r.details ? '<details><summary>Details</summary><p class="hint">' + esc(r.details) + '</p></details>' : '';
    const always = r.onceOnly ? '' : '<button data-w="always">Always allow</button>';
    const d = card('<b>' + esc(r.title || 'Approval') + '</b><p>' + esc(r.description) + '</p>' + scope + details + '<p class="hint">' + hint + '</p><button data-w="oui">Approve once</button>' + always + '<button data-w="non">Deny</button>');
    d.querySelectorAll('button').forEach(btn => btn.onclick = run(() => answer(r.id, btn.dataset.w)));
  }
}
load().catch(e => log(e.message));
setInterval(() => { load().catch(() => {}); }, 2000);
</script></body></html>
`;

/** The one-request page: shows one card and answers it only with an owner signature. */
export const REQUEST_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>TeamCLI – one request</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#222}
button{font-size:16px;padding:.6em 1em;margin:.3em .3em .3em 0;border-radius:8px;border:1px solid #888;background:#f4f4f4}
.card{border:1px solid #ddd;border-radius:10px;padding:1em;margin:1em 0}.hint{color:#555;font-size:14px;white-space:pre-wrap}#log{color:#555;white-space:pre-wrap}</style></head>
<body><h1>Owner approval</h1><div id="card"></div><p id="log"></p>
<script>
const id = location.pathname.split('/').pop();
const nonce = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length+3)%4)), c => c.charCodeAt(0));
const post = async (action, body) => { const r = await fetch('/api/r/' + id + '/' + action, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
const log = (m) => { document.getElementById('log').textContent = m; };
const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let S;
async function answer(word) {
  const passkey = S.signers.find(s => s.type === 'webauthn');
  if (passkey) {
    const ch = await post('challenge', { session: S.session, word, credentialId: passkey.credential_id });
    const c = await navigator.credentials.get({ publicKey: { challenge: unb64u(ch.challenge), rpId: S.rp_id, allowCredentials: [{ type: 'public-key', id: unb64u(passkey.credential_id) }], userVerification: 'required', timeout: 120000 } });
    const r = await post('answer', { session: S.session, word, credentialId: b64u(c.rawId), authenticatorData: b64u(c.response.authenticatorData), clientDataJSON: b64u(c.response.clientDataJSON), signature: b64u(c.response.signature) });
    return log('Answer saved: ' + r.choice);
  }
  log('Confirm with Touch ID on the Mac…');
  const r = await post('touch-id', { session: S.session, word });
  log('Answer saved: ' + r.choice);
}
(async () => {
  S = await post('open', { nonce });
  const r = S.request;
  const always = r.onceOnly ? '' : '<button data-w="always">Always allow</button>';
  const d = document.getElementById('card'); d.className = 'card';
  const scope = r.scope ? '<p class="hint">' + esc(r.scope) + '</p>' : '';
  d.innerHTML = '<b>' + esc(r.title) + '</b><p>' + esc(r.description) + '</p>' + scope + (r.details ? '<details><summary>Details</summary><p class="hint">' + esc(r.details) + '</p></details>' : '') + '<button data-w="oui">Approve once</button>' + always + '<button data-w="non">Deny</button>';
  d.querySelectorAll('button').forEach(b => b.onclick = () => answer(b.dataset.w).catch(e => log('Refused: ' + e.message)));
})().catch(e => log(e.message));
</script></body></html>
`;
