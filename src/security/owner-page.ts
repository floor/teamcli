// The owner page: a tiny WebAuthn page served by `team owner-seat serve` on 127.0.0.1, so the
// owner never types a command. Iris starts the server and sends the link; the owner opens it in
// the Mac's browser and approves with a passkey: Touch ID on the Mac, or the iPhone through the
// browser's "use a phone" QR code (hybrid transport). The relying party is `localhost`, a secure
// context for WebAuthn without a certificate.
//
// What the page can do, each completed only by an owner-device signature:
// - register a passkey as an owner signer (the existing Secure Enclave signer confirms with Touch ID);
// - sign the waiting security-profile proposal;
// - answer a waiting team-create request (oui / always / non).
// Every API call carries the per-run token from the link and must come to Host localhost:<port>.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { addOwnerSigner, ownerSeatMessages, ownerSeatPublicKey, readOwnerSeat, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { approveTeamCreate } from '../client/team-create.ts';
import { readProposal, readSecurityProfile, securityProfileChallenge, securityProfileLine, signSecurityProfile } from './profile.ts';

export const OWNER_PAGE_RP_ID = 'localhost';
export const ADD_SIGNER_DOMAIN = 'team-owner-seat-add-signer-v1\n';

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

export function ownerPageHandler(options: OwnerPageOptions & { port: number; token: string }) {
  const { home, store, token } = options;
  const now = options.now ?? (() => new Date());
  const registrations = new Map<string, number>();
  const pendingAnswers = new Map<string, { at: Date; challenge: string }>();

  const signerOfCredential = (credentialId: string) => readOwnerSeat(home)?.signers.find((s) => s.type === 'webauthn' && s.credential_id === credentialId);
  const assertionOf = (a: Assertion) => ({ authenticator_data: a.authenticatorData, client_data_json: a.clientDataJSON, signature: derB64urlToHex(a.signature) });

  const state = () => {
    const seat = readOwnerSeat(home);
    const proposal = readProposal(home);
    return {
      seat: seat === null ? null : { team: seat.team, signers: seat.signers.map((s) => ({ name: s.name, type: s.type, credential_id: s.credential_id ?? null })) },
      profile: securityProfileLine(readSecurityProfile(home, store, now())),
      proposal: proposal === null ? null : { profile: proposal.profile, expires: proposal.expires, signer: proposal.signer, challenge: securityProfileChallenge(proposal) },
      requests: ownerSeatMessages(home).filter((m) => (m as { kind?: string }).kind === 'team-create-confirmation').map((m) => ({ id: m.request_id, text: m.text })),
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
      const seat = readOwnerSeat(home)!;
      // The existing Secure Enclave signer confirms the new passkey: one Touch ID on the Mac.
      const confirmer = seat.signers.find((s) => s.type === 'mac-keystore');
      if (confirmer === undefined) return { status: 409, body: { error: 'no Secure Enclave signer to confirm a new passkey' } };
      const statement = Buffer.from(ADD_SIGNER_DOMAIN + JSON.stringify({ team: seat.team, signer: name, public_key: point, credential_id: credentialId, rp_id: OWNER_PAGE_RP_ID }), 'utf8');
      const confirmed = store.sign(confirmer.label, statement, `Add passkey "${name}" as a TeamCLI owner signer`);
      if (!confirmed.ok) return { status: 403, body: { error: confirmed.why } };
      const added = addOwnerSigner(home, { signer: name, type: 'webauthn', publicKey: point, credentialId, rpId: OWNER_PAGE_RP_ID }, store, now());
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
      const probe = approveTeamCreate(home, id, word, store, at, { signer: signer.name });
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
      const answered = approveTeamCreate(home, a.id, a.word, store, pending.at, { signer: signer.name, assertion: assertionOf(a) });
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
      resolve({ server, url: `http://localhost:${port}/?t=${token}`, port, token });
    });
  });
}

/** Fingerprint shown on the page so the owner can match it with what Iris said. */
export function challengeWords(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex').slice(0, 8);
}

export const OWNER_PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamCLI – siège propriétaire</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:640px;margin:2em auto;padding:0 1em;color:#222}
button{font-size:16px;padding:.6em 1em;margin:.3em .3em .3em 0;border-radius:8px;border:1px solid #888;background:#f4f4f4}
.relaxed{color:#b00;font-weight:600}.card{border:1px solid #ddd;border-radius:10px;padding:1em;margin:1em 0}#log{color:#555;white-space:pre-wrap}</style></head>
<body><h1>Siège propriétaire</h1><p id="profile"></p><div id="cards"></div><p id="log"></p>
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
  const name = prompt('Nom de ce passkey (ex. iphone)', 'iphone'); if (!name) return;
  const o = await api('POST', '/api/register/options');
  const c = await navigator.credentials.create({ publicKey: { challenge: unb64u(o.challenge), rp: { id: o.rp_id, name: 'TeamCLI owner seat' }, user: { id: unb64u(o.user_id), name: 'owner-' + name, displayName: 'TeamCLI owner (' + name + ')' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 120000 } });
  log('Confirmez avec Touch ID sur le Mac…');
  await api('POST', '/api/register', { signer: name, credentialId: b64u(c.rawId), publicKey: b64u(c.response.getPublicKey()), clientDataJSON: b64u(c.response.clientDataJSON) });
  log('Passkey ' + name + ' enregistré.'); load();
}
async function signProfile() { const a = await assertOver(S.proposal.challenge); const r = await api('POST', '/api/profile/sign', a); log('Profil signé. ' + r.profile); load(); }
async function answer(id, word) {
  const first = S.seat.signers.find(s => s.type === 'webauthn');
  const ch = await api('POST', '/api/team-create/challenge', { id, word, credentialId: first.credential_id });
  const a = await assertOver(ch.challenge);
  const r = await api('POST', '/api/team-create/answer', { ...a, id, word }); log('Réponse enregistrée : ' + r.choice); load();
}
const run = (f) => (...a) => f(...a).catch(e => log('Refusé : ' + e.message));
async function load() {
  S = await api('GET', '/api/state');
  const p = document.getElementById('profile'); p.textContent = S.profile; p.className = /RELAXED/.test(S.profile) ? 'relaxed' : '';
  const cards = document.getElementById('cards'); cards.innerHTML = '';
  const card = (html) => { const d = document.createElement('div'); d.className = 'card'; d.innerHTML = html; cards.appendChild(d); return d; };
  if (!S.seat) { card('Aucun siège propriétaire. Demandez à Iris de lancer la mise en place.'); return; }
  const hasPasskey = S.seat.signers.some(s => s.type === 'webauthn');
  const reg = card('<b>Passkey</b> : ' + (hasPasskey ? 'enregistré.' : 'aucun.') + '<br><button>Ajouter un passkey (iPhone ou Mac)</button>'); reg.querySelector('button').onclick = run(register);
  if (S.proposal && hasPasskey) { const d = card('<b>Profil de sécurité proposé</b> : ' + S.proposal.profile + ' jusqu\\u2019au ' + S.proposal.expires + '<br><button>Approuver avec mon passkey</button>'); d.querySelector('button').onclick = run(signProfile); }
  for (const r of S.requests) { if (!hasPasskey) break; const d = card(r.text.replace(/</g,'&lt;') + '<br><button data-w="oui">Oui</button><button data-w="always">Toujours</button><button data-w="non">Non</button>'); d.querySelectorAll('button').forEach(btn => btn.onclick = run(() => answer(r.id, btn.dataset.w))); }
}
load().catch(e => log(e.message));
</script></body></html>
`;
