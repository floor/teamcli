// The owner page: a tiny WebAuthn page served by `team owner-seat serve` on 127.0.0.1, so the
// owner never types a command. Iris starts the server and sends the link; the owner opens it in
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

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { clearOwnerPageLink, writeOwnerPageLink } from '../client/owner-page-link.ts';
import { addOwnerSigner, ownerSeatMessages, ownerSeatPublicKey, readOwnerSeat, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { actionRequestsFolder, approveTeamCreate, teamCreateSummary, type TeamCreateParams } from '../client/team-create.ts';
import { approveOwnerAction, OWNER_ACTION_ID_PATTERN, ownerActionSummary, type OwnerAction, type OwnerActionParams } from '../client/owner-action.ts';
import { approveAsOwnerSeat, GRANT_REQUEST_ID_PATTERN, grantRequestsFolder, pendingGrantPrompt } from '../client/emission.ts';
import { existsSync, readFileSync } from 'node:fs';
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

/** Card titles for every owner-seat action. The posted answer word is unchanged. */
const ACTION_TITLES: Record<OwnerAction, string> = {
  'team-create': 'Create a team',
  'team-import': 'Import a team file',
  'team-migrate': 'Migrate a team',
  'team-add': 'Add a seat',
  'team-up': 'Start the team',
  'team-send': 'Send a message',
  'team-down': 'Stop the team',
  'team-bus': 'Start the bus',
  'team-revoke-approval': 'Revoke an approval rule',
  'team-forget': 'Forget a team record',
};

const MIGRATION_ACTIONS = new Set<OwnerAction>(['team-migrate']);

export type OwnerPageRequest = {
  id: string;
  /** The inbox line. The page shows `title` and `description` instead of this prompt. */
  text: string;
  title: string;
  description: string;
  /** Approve once and Deny only. Migrations, and grants a standing rule cannot cover. */
  onceOnly: boolean;
  /** For a grant: the full permission list, shown folded under the short French line. */
  details?: string;
};

/** The refusal the page shows when the passkey or signer is already on the owner seat. */
export const ALREADY_REGISTERED_FR = 'Ce Mac est déjà enregistré, rien à faire.';

const SHOWN_KINDS = new Set(['team-create-confirmation', 'owner-action-confirmation', 'grant-confirmation']);

function strippedPrompt(text: string): string {
  return text.replace(/\s*Authorized\?[\s\S]*$/, '').trim();
}

function isOwnerAction(summary: unknown): summary is OwnerActionParams {
  return typeof summary === 'object' && summary !== null && (summary as { kind?: string }).kind === 'owner-action' && Array.isArray((summary as { actions?: unknown }).actions);
}

function isTeamCreate(summary: unknown): summary is TeamCreateParams {
  return typeof summary === 'object' && summary !== null && (summary as { kind?: string }).kind === 'team-create';
}

type GrantCard = { text?: string; master?: boolean; up?: unknown; expires?: string | null };

function isGrantCard(summary: unknown): summary is GrantCard {
  return typeof summary === 'object' && summary !== null && typeof (summary as { text?: unknown }).text === 'string';
}

/** English title, description and once/always choice for one inbox card. */
export function ownerPageRequest(message: { request_id: string; text?: string; kind?: string; summary?: unknown }, grantPrompt: string | null = null): OwnerPageRequest {
  const id = message.request_id;
  const text = typeof message.text === 'string' ? message.text : '';
  const kind = message.kind ?? '';
  const summary = message.summary;
  if (kind === 'owner-action-confirmation' || isOwnerAction(summary)) {
    const params = isOwnerAction(summary) ? summary : null;
    const actions = params?.actions ?? [];
    const onceOnly = actions.some((action) => MIGRATION_ACTIONS.has(action));
    const title = actions.length === 0 ? 'Approval' : actions.map((action) => ACTION_TITLES[action] ?? action).join(', then ');
    const described = params === null ? strippedPrompt(text) : ownerActionSummary(params);
    const description = onceOnly ? `${described} This migration needs a one-time approval.`.trim() : described;
    return { id, text, title, description, onceOnly };
  }
  if (kind === 'team-create-confirmation' || isTeamCreate(summary)) {
    const description = isTeamCreate(summary) ? teamCreateSummary(summary) : strippedPrompt(text);
    return { id, text, title: 'Create a team', description, onceOnly: false };
  }
  if (kind === 'grant-confirmation' || id.startsWith('gr_')) {
    const grant = isGrantCard(summary) ? summary : null;
    const onceOnly = grant !== null && (grant.master === true || grant.up != null || grant.expires === null);
    const title = grant?.master === true ? 'Autorisation maître' : grant?.up != null ? "Autorisation d'équipe" : 'Autorisation';
    const full = grant?.text ?? strippedPrompt(text);
    const promptFr = grantPrompt ?? (typeof (summary as { prompt_fr?: unknown } | null)?.prompt_fr === 'string' ? (summary as { prompt_fr: string }).prompt_fr : null);
    if (promptFr !== null) {
      const description = onceOnly ? `${promptFr} Approbation unique requise.` : promptFr;
      return { id, text, title, description, onceOnly, details: full };
    }
    const description = onceOnly ? `${full} This grant needs a one-time approval.`.trim() : full;
    return { id, text, title, description, onceOnly };
  }
  return { id, text, title: 'Approval', description: strippedPrompt(text), onceOnly: false };
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
      if (readOwnerSeat(home) === null) return { status: 409, body: { error: 'no owner seat yet: Iris runs team owner-seat setup first' } };
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
      if (known) return { status: 409, body: { error: ALREADY_REGISTERED_FR, already_registered: true } };
      // The existing Secure Enclave signer confirms the new passkey: one Touch ID on the Mac,
      // verified under the key the credential store confirms, and audited.
      const confirmed = ownerDeviceConsent(home, store, { act: 'add-passkey-signer', signer: name, public_key: point, credential_id: credentialId, rp_id: OWNER_PAGE_RP_ID }, `Add passkey "${name}" as a TeamCLI owner signer`, now());
      if (!confirmed.ok) return { status: 403, body: { error: confirmed.why } };
      const added = addOwnerSigner(home, { signer: name, type: 'webauthn', publicKey: point, credentialId, rpId: OWNER_PAGE_RP_ID }, store, now());
      if (!added.ok && /already registered/.test(added.why)) return { status: 409, body: { error: ALREADY_REGISTERED_FR, already_registered: true } };
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

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.headers.host !== `localhost:${options.port}`) return send(403, { error: 'open the page at http://localhost:' + options.port });
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

/** Fingerprint shown on the page so the owner can match it with what Iris said. */
export function challengeWords(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex').slice(0, 8);
}

export const OWNER_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamCLI – owner seat</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#222}
button{font-size:16px;padding:.6em 1em;margin:.3em .3em .3em 0;border-radius:8px;border:1px solid #888;background:#f4f4f4}
.relaxed{color:#b00;font-weight:600}.card{border:1px solid #ddd;border-radius:10px;padding:1em;margin:1em 0}
.hint{color:#555;font-size:14px;margin:.6em 0}.card p{margin:.4em 0}#log{color:#555;white-space:pre-wrap}</style></head>
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
const run = (f) => (...a) => { busy++; return f(...a).catch(e => log(/déjà enregistré/.test(e.message) ? e.message : 'Refused: ' + e.message)).finally(() => { busy--; }); };
let stamp = '';
async function load() {
  if (busy) return;
  const next = await api('GET', '/api/state');
  const mark = JSON.stringify([next.profile, next.proposal, (next.requests || []).map(r => r.id + '\\n' + (r.title || '') + '\\n' + r.onceOnly + '\\n' + (r.description || '') + '\\n' + (r.details || '') + '\\n' + r.text), next.seat]);
  S = next;
  if (mark === stamp) return;
  stamp = mark;
  const p = document.getElementById('profile'); p.textContent = S.profile; p.className = /RELAXED/.test(S.profile) ? 'relaxed' : '';
  const cards = document.getElementById('cards'); cards.innerHTML = '';
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const card = (html) => { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = html; cards.appendChild(d); return d; };
  if (!S.seat) { card('No owner seat yet. Ask Iris to run setup.'); return; }
  const hasPasskey = S.seat.signers.some(s => s.type === 'webauthn');
  const reg = card('<b>Passkey</b>: ' + (hasPasskey ? 'saved.' : 'none yet.') + '<br><button>Add a passkey (iPhone or Mac)</button>'); reg.querySelector('button').onclick = run(register);
  if (S.proposal && hasPasskey) { const d = card('<b>Proposed security profile</b>: ' + esc(S.proposal.profile) + ' until ' + esc(S.proposal.expires) + '<br><button>Approve with my passkey</button>'); d.querySelector('button').onclick = run(signProfile); }
  if (hasPasskey && S.requests.length === 0) card('<p class="hint">Aucune demande en attente</p>');
  for (const r of S.requests) {
    if (!hasPasskey) break;
    if (r.id.startsWith('gr_')) {
      const always = r.onceOnly ? '' : '<button data-w="always">Toujours autoriser</button>';
      const details = r.details ? '<details><summary>Détail des droits</summary><p class="hint">' + esc(r.details) + '</p></details>' : '';
      const d = card('<b>' + esc(r.title || 'Autorisation') + '</b> <span class="hint">' + esc(r.id) + '</span><p>' + esc(r.description) + '</p>' + details + '<button data-w="oui">Approuver une fois</button>' + always + '<button data-w="non">Refuser</button>');
      d.querySelectorAll('button').forEach(btn => btn.onclick = run(() => answer(r.id, btn.dataset.w)));
      continue;
    }
    const description = esc(r.description || String(r.text || '').replace(/\\s*Authorized\\?[\\s\\S]*$/, ''));
    const hint = r.onceOnly
      ? 'This needs a one-time approval. Choose Approve once.'
      : 'Approve once is a one-time approval. A migration needs that. Always allow also permits later runs of the same action in this folder.';
    const always = r.onceOnly ? '' : '<button data-w="always">Always allow</button>';
    const d = card('<b>' + esc(r.title || 'Approval') + '</b><p>' + description + '</p><p class="hint">' + hint + '</p><button data-w="oui">Approve once</button>' + always + '<button data-w="non">Deny</button>');
    d.querySelectorAll('button').forEach(btn => btn.onclick = run(() => answer(r.id, btn.dataset.w)));
  }
}
load().catch(e => log(e.message));
setInterval(() => { load().catch(() => {}); }, 2000);
</script></body></html>
`;
