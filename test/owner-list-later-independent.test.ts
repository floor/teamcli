// Independent verification of feat/owner-list-later (7fe17669d):
// Security surface: signed owner deferral records, answer windows, 7-day cap, and lead notices.
// 1. A deferral hides a pending card (team-create, owner-action, grant) and returns it by the clock,
//    granting one 15-minute answer window from `until` before expiring; a second deferral is refused
//    via exclusive create (`wx`) without replacing the existing record.
// 2. An unsigned, tampered, unaccepted-signer, misbound (`request_id`, `params_sha256`, `kind`), or
//    over-cap (`> created_at + 7 days`) record extends nothing (and sign-time refuses `> 7 days`
//    while read-time clamps any pre-signed `until` at `created_at + 7 days`).
// 3. A deferral is never an answer: no `.seat-answer.json`, `.answer.json`, or `.used` file is
//    written, and `admitTeamCreate`, `admitOwnerAction`, and `executePendingGrant` refuse an
//    unanswered deferred request both before and after `until`.
// 4. The blocked team's lead note for both owner-action and team-grant cards is signed with the
//    message key and reads as `from: "owner page"` / `rule: "owner page"` (never `"owner"`), while
//    a `team-create` card leaves no note.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import {
  approveAsOwnerSeat,
  deferUntilOf,
  executePendingGrant,
  grantRequestsFolder,
} from '../src/client/emission.ts';
import { admitOwnerAction, createOwnerActionRequest } from '../src/client/owner-action.ts';
import {
  ownerSeatLaterBytes,
  registerOwnerSeat,
  signOwnerLater,
  verifyOwnerLater,
  type OwnerSeatKeyStore,
  type OwnerSeatLater,
  type SignedOwnerLater,
} from '../src/client/owner-seat.ts';
import { clientKeyDir, newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { actionRequestsFolder, admitTeamCreate, createTeamCreateRequest } from '../src/client/team-create.ts';
import { runGrant } from '../src/commands/grant.ts';
import { recordDir, runMessages } from '../src/commands/messages.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { serveOwnerPage } from '../src/security/owner-page.ts';
import { verifyRecord } from '../src/send/record.ts';
import { keyOf, messageKeyOf } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { fixtureBase, gitEnv, recordAt, testIo } from './helpers.ts';

const T0 = new Date('2026-11-04T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TTL_MS = 15 * MINUTE;
const CAP_MS = 7 * DAY;
const TEAM_ID = 'dddddddddddd';

const cleanupDirs: string[] = [];
const activeServers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const srv of activeServers.splice(0)) srv.close();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rawPublicKeyHex(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
}

function makeFakeStore(): OwnerSeatKeyStore {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  return {
    name: 'synthetic-owner-store',
    available: () => true,
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: rawPublicKeyHex(pair.publicKey) };
    },
    publicKey: (label) =>
      keys.has(label)
        ? { ok: true, publicKey: rawPublicKeyHex(keys.get(label)!.publicKey) }
        : { ok: false, why: 'no key' },
    sign: (label, message) =>
      keys.has(label)
        ? {
            ok: true,
            signature: cryptoSign('sha256', message, {
              key: keys.get(label)!.privateKey,
              dsaEncoding: 'der',
            }).toString('hex'),
          }
        : { ok: false, why: 'no key' },
    pinSet: (label, value) =>
      pins.has(label) ? { ok: false, why: 'already pinned' } : (pins.set(label, value), { ok: true }),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
  };
}

function makePasskey(idLabel = 'passkey-cred-01') {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = Buffer.from(idLabel).toString('base64url');
  const assert = (challenge: string) => {
    const authData = Buffer.concat([
      createHash('sha256').update('localhost').digest(),
      Buffer.from([0x05, 0, 0, 0, 1]),
    ]);
    const clientData = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost' }),
    );
    const sig = cryptoSign(
      'sha256',
      Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
      { key: pair.privateKey, dsaEncoding: 'der' },
    );
    return {
      credentialId,
      authenticatorData: authData.toString('base64url'),
      clientDataJSON: clientData.toString('base64url'),
      signature: sig.toString('base64url'),
    };
  };
  const spki = (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url');
  return { pair, credentialId, assert, spki };
}

type Passkey = ReturnType<typeof makePasskey>;

async function setupStage() {
  const base = fixtureBase('.owner-later-ind-');
  cleanupDirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'demo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });

  writeFileSync(
    join(home, '.config', 'team', 'entities.yaml'),
    'demo:\n  clients:\n    ext-bot:\n      seats: [lead, worker]\n',
  );

  const teamText = `format: 1
project: demo
coordinator: lead
operator: lead
session: demo
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText);
  keyOf(home);

  const leadAgent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'M', version: '1', role: 'coordinator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: TEAM_ID, seat: 'lead', session: 'demo', pane: 'pane-lead', address: join(base, 'lead.sock') },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  const workerAgent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'M', version: '1', role: 'implementer' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: TEAM_ID, seat: 'worker', session: 'demo', pane: 'pane-worker', address: join(base, 'worker.sock') },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });

  writeFileSync(
    join(home, '.config', 'team', 'teams.yaml'),
    `teams:
  "${TEAM_ID}":
    project: demo
    project_id: null
    entity: demo
    session: demo
    root: ${root}
    lobby: ${join(base, 'lobby')}
    roster:
      - { agent: ${leadAgent.id}, seat: lead, role: coordinator, leads: true }
      - { agent: ${workerAgent.id}, seat: worker, role: implementer }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z" }
`,
  );

  const validated = validateTeamFile(teamText);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  writeApproval(storePath('demo', root, home), { approval: approvalOf(validated.team, root, T0), file: teamText }, [], home);

  const clientPair = newClientKeyPair();
  const keyFiles = writeClientKeyFiles(clientKeyDir(home, 'ext-bot'), clientPair);
  if (!keyFiles.ok) throw new Error(keyFiles.why);

  const store = makeFakeStore();
  const regSeat = registerOwnerSeat(home, { team: 'demo', signer: 'mac' }, store, T0);
  if (!regSeat.ok) throw new Error(regSeat.why);

  expect(
    writePolicySet(home, { level: 'entity', target: 'demo', name: 'grant-emission', value: 'conversational' }, { now: T0 }).ok,
  ).toBe(true);

  let clock = T0.getTime();
  const now = () => new Date(clock);
  const page = await serveOwnerPage({ home, store, port: 0, now });
  activeServers.push(page.server);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://localhost:${page.port}${path}?t=${page.token}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };

  const passkey = makePasskey();
  const regOpts = await call('POST', '/api/register/options');
  expect(regOpts.status).toBe(200);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.create', challenge: regOpts.body.challenge, origin: 'http://localhost' }),
  ).toString('base64url');
  const regDone = await call('POST', '/api/register', {
    signer: 'iphone',
    credentialId: passkey.credentialId,
    publicKey: passkey.spki,
    clientDataJSON,
  });
  expect(regDone.status).toBe(200);

  expect(
    writePolicySet(home, { level: 'entity', target: 'demo', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: T0 }).ok,
  ).toBe(true);

  return {
    base,
    home,
    root,
    store,
    passkey,
    pubPath: keyFiles.pubPath,
    call,
    now,
    setOffset: (ms: number) => {
      clock = T0.getTime() + ms;
    },
  };
}

type Stage = Awaited<ReturnType<typeof setupStage>>;

async function listedIds(s: Stage): Promise<string[]> {
  const res = await s.call('GET', '/api/state');
  return ((res.body.requests as Array<{ id: string }>) ?? []).map((r) => r.id).sort();
}

async function submitAnswer(s: Stage, id: string, word: string, pk: Passkey = s.passkey) {
  const ch = await s.call('POST', '/api/team-create/challenge', { id, word, credentialId: pk.credentialId });
  if (ch.status !== 200) return { challenge: ch, answer: null };
  const assertion = pk.assert(String(ch.body.challenge));
  const ans = await s.call('POST', '/api/team-create/answer', { ...assertion, id, word });
  return { challenge: ch, answer: ans };
}

async function createGrantCard(s: Stage, extraArgs: string[] = []): Promise<{ id: string; params_sha256: string }> {
  let out = '';
  let err = '';
  const io: Io = {
    cwd: s.root,
    env: {},
    stdinIsTTY: false,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  };
  const code = await runGrant(
    ['--client', 'ext-bot', '--entity', 'demo', '--public-key', s.pubPath, '--request', ...extraArgs, '--json'],
    io,
    { home: s.home, notify: () => false, now: s.now() },
  );
  if (code !== 0) throw new Error(`runGrant failed (${code}): ${out} ${err}`);
  const id = (JSON.parse(out) as { target: string }).target;
  const env = JSON.parse(readFileSync(join(grantRequestsFolder(s.home), `${id}.json`), 'utf8')) as {
    grant_request: { params_sha256: string };
  };
  return { id, params_sha256: env.grant_request.params_sha256 };
}

function handSignLater(p: Passkey, payload: OwnerSeatLater, signer = 'iphone'): SignedOwnerLater {
  const challenge = createHash('sha256').update(ownerSeatLaterBytes(payload)).digest('base64url');
  const assertion = p.assert(challenge);
  return {
    owner_seat_later: payload,
    signer,
    signature: Buffer.from(assertion.signature, 'base64url').toString('hex'),
    webauthn: {
      authenticator_data: assertion.authenticatorData,
      client_data_json: assertion.clientDataJSON,
    },
  };
}

describe('feat/owner-list-later independent security verification', () => {
  test('1. a deferral hides and returns by the clock across team-create, owner-action, and grant cards, and refuses duplicate deferrals', async () => {
    const s = await setupStage();

    // Schedule word resolution check
    expect(deferUntilOf('later', T0, 'UTC')?.toISOString()).toBe('2026-11-04T14:00:00.000Z');
    expect(deferUntilOf('tomorrow', T0, 'UTC')?.toISOString()).toBe('2026-11-05T08:00:00.000Z');
    expect(deferUntilOf('monday', T0, 'UTC')?.toISOString()).toBe('2026-11-09T08:00:00.000Z');
    expect(deferUntilOf('invalid-word', T0, 'UTC')).toBeNull();

    // Create one request of each kind at T0
    const tcRoot = join(s.base, 'new-repo');
    mkdirSync(tcRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: tcRoot, env: gitEnv(), stdio: 'ignore' });
    const tc = createTeamCreateRequest(s.home, tcRoot, null, s.now());
    if (!tc.ok) throw new Error(tc.why);

    const oa = createOwnerActionRequest(
      s.home,
      { actions: ['team-up'], root: s.root, team: 'demo', head: null, args: {}, requestedBy: 'seat:worker' },
      s.now(),
    );
    if (!oa.ok) throw new Error(oa.why);

    const gr = await createGrantCard(s, ['--team', 'demo', '--seat', 'worker']);

    const allIds = [tc.record.request_id, oa.record.request_id, gr.id].sort();
    expect(await listedIds(s)).toEqual(allIds);

    // Defer all three with "later" (+4 hours)
    for (const id of allIds) {
      const res = await submitAnswer(s, id, 'later');
      expect(res.challenge.status).toBe(200);
      expect(res.answer?.status).toBe(200);
      expect(res.answer?.body).toMatchObject({
        ok: true,
        choice: 'later',
        until: new Date(T0.getTime() + 4 * HOUR).toISOString(),
      });
    }

    // Attempting a second deferral when `.later.json` already exists is refused (`wx` exclusive write)
    const dup = await submitAnswer(s, tc.record.request_id, 'tomorrow');
    expect(dup.challenge.status).toBe(200);
    expect(dup.answer?.status).toBe(400);
    expect(String(dup.answer?.body.error)).toContain('already carries a deferral');

    // Hidden at T0 + 1m, T0 + 20m (past initial 15m TTL), and T0 + 4h - 1s
    for (const offset of [MINUTE, 20 * MINUTE, 4 * HOUR - 1000]) {
      s.setOffset(offset);
      expect(await listedIds(s)).toEqual([]);
    }

    // Returned by the clock at T0 + 4h and still listed at T0 + 4h + 14m
    s.setOffset(4 * HOUR);
    expect(await listedIds(s)).toEqual(allIds);
    s.setOffset(4 * HOUR + 14 * MINUTE);
    expect(await listedIds(s)).toEqual(allIds);

    // Past the returned 15-minute window (T0 + 4h + 15m + 1m), all three expire and cannot be answered
    s.setOffset(4 * HOUR + TTL_MS + MINUTE);
    expect(await listedIds(s)).toEqual([]);
    for (const id of allIds) {
      const late = await submitAnswer(s, id, 'oui');
      expect(late.challenge.status).toBe(400);
      expect(String(late.challenge.body.error)).toContain('expired at');
    }

    // Within the returned 15-minute window (T0 + 4h + 5m), all three can be answered `oui` and executed
    s.setOffset(4 * HOUR + 5 * MINUTE);
    for (const id of allIds) {
      const okAns = await submitAnswer(s, id, 'oui');
      expect(okAns.answer?.status).toBe(200);
    }
    expect(admitTeamCreate(s.home, tc.record.request_id, tcRoot, s.store, s.now())).toMatchObject({
      ok: true,
      via: 'owner-seat',
      signer: 'iphone',
    });
    expect(
      admitOwnerAction(
        s.home,
        oa.record.request_id,
        { action: 'team-up', root: s.root, team: 'demo', head: null, words: [], claim: false },
        s.store,
        s.now(),
      ),
    ).toMatchObject({ ok: true, via: 'owner-seat', signer: 'iphone' });
    const execGrant = executePendingGrant(s.home, { requestId: gr.id }, { now: s.now(), ownerSeatStore: s.store });
    expect(execGrant).toMatchObject({ ok: true, adapter: 'owner-seat' });
  });

  test('2. unsigned, misbound, unaccepted-signer, or over-cap records extend nothing', async () => {
    const s = await setupStage();

    const tcRootA = join(s.base, 'repo-a');
    const tcRootB = join(s.base, 'repo-b');
    mkdirSync(tcRootA, { recursive: true });
    mkdirSync(tcRootB, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: tcRootA, env: gitEnv(), stdio: 'ignore' });
    execFileSync('git', ['init', '-q'], { cwd: tcRootB, env: gitEnv(), stdio: 'ignore' });

    const reqA = createTeamCreateRequest(s.home, tcRootA, null, s.now());
    const reqB = createTeamCreateRequest(s.home, tcRootB, null, s.now());
    if (!reqA.ok || !reqB.ok) throw new Error('failed to create requests');
    const idA = reqA.record.request_id;
    const idB = reqB.record.request_id;

    const until4h = new Date(T0.getTime() + 4 * HOUR).toISOString();
    const fileA = join(actionRequestsFolder(s.home), `${idA}.later.json`);

    const invalidRecords: { label: string; record: unknown }[] = [
      {
        label: 'unsigned record (empty signature)',
        record: {
          owner_seat_later: {
            kind: 'team-create',
            request_id: idA,
            params_sha256: reqA.record.params_sha256,
            until: until4h,
            word: 'later',
            team: null,
            seat: 'owner',
            at: T0.toISOString(),
          },
          signer: 'iphone',
          signature: '',
        },
      },
      {
        label: 'misbound request_id (signed for B, planted on A)',
        record: handSignLater(s.passkey, {
          kind: 'team-create',
          request_id: idB,
          params_sha256: reqA.record.params_sha256,
          until: until4h,
          word: 'later',
          team: null,
          seat: 'owner',
          at: T0.toISOString(),
        }),
      },
      {
        label: 'misbound params_sha256',
        record: handSignLater(s.passkey, {
          kind: 'team-create',
          request_id: idA,
          params_sha256: '0'.repeat(64),
          until: until4h,
          word: 'later',
          team: null,
          seat: 'owner',
          at: T0.toISOString(),
        }),
      },
      {
        label: 'tampered return time after signing',
        record: {
          ...handSignLater(s.passkey, {
            kind: 'team-create',
            request_id: idA,
            params_sha256: reqA.record.params_sha256,
            until: until4h,
            word: 'later',
            team: null,
            seat: 'owner',
            at: T0.toISOString(),
          }),
          owner_seat_later: {
            kind: 'team-create',
            request_id: idA,
            params_sha256: reqA.record.params_sha256,
            until: new Date(T0.getTime() + 8 * HOUR).toISOString(),
            word: 'later',
            team: null,
            seat: 'owner',
            at: T0.toISOString(),
          },
        },
      },
      {
        label: 'unaccepted / unknown signer',
        record: handSignLater(
          s.passkey,
          {
            kind: 'team-create',
            request_id: idA,
            params_sha256: reqA.record.params_sha256,
            until: until4h,
            word: 'later',
            team: null,
            seat: 'owner',
            at: T0.toISOString(),
          },
          'rogue-signer',
        ),
      },
    ];

    for (const item of invalidRecords) {
      writeFileSync(fileA, `${JSON.stringify(item.record, null, 2)}\n`);
      // At T0 + 1m, invalid record does NOT hide idA
      s.setOffset(MINUTE);
      expect(await listedIds(s), `hiding check for ${item.label}`).toEqual([idA, idB].sort());

      // At T0 + 16m (past original 15m TTL), invalid record does NOT extend idA's window
      s.setOffset(TTL_MS + MINUTE);
      expect(await listedIds(s), `expiry list check for ${item.label}`).toEqual([]);
      const ch = await submitAnswer(s, idA, 'oui');
      expect(ch.challenge.status, `challenge status for ${item.label}`).toBe(400);
      expect(String(ch.challenge.body.error)).toContain('expired at');
      const admitted = admitTeamCreate(s.home, idA, tcRootA, s.store, s.now());
      expect(admitted.ok, `admit check for ${item.label}`).toBe(false);
    }

    // Over-cap (`> created_at + 7 days`):
    // (a) Sign-time refusal in `signOwnerLater`
    const overCapPayload: OwnerSeatLater = {
      kind: 'team-create',
      request_id: idB,
      params_sha256: reqB.record.params_sha256,
      until: new Date(T0.getTime() + CAP_MS + MINUTE).toISOString(),
      word: 'later',
      team: null,
      seat: 'owner',
      at: T0.toISOString(),
    };
    const signOverCap = signOwnerLater(s.home, overCapPayload, T0.toISOString(), 'mac', s.store, 'defer over cap');
    expect(signOverCap.ok).toBe(false);
    if (!signOverCap.ok) expect(signOverCap.why).toContain('7-day cap');

    // (b) Read-time clamping: a passkey-signed `.later.json` claiming `until = T0 + 10 days` is clamped
    // to `T0 + 7 days`, so at `T0 + 7d + 16m` (well before day 10) it is already expired and extends nothing!
    const tenDaysLater = handSignLater(s.passkey, {
      ...overCapPayload,
      until: new Date(T0.getTime() + 10 * DAY).toISOString(),
    });
    writeFileSync(join(actionRequestsFolder(s.home), `${idB}.later.json`), `${JSON.stringify(tenDaysLater, null, 2)}\n`);
    s.setOffset(CAP_MS + TTL_MS + MINUTE);
    expect(await listedIds(s)).toEqual([]);
    const lateOverCap = await submitAnswer(s, idB, 'oui');
    expect(lateOverCap.challenge.status).toBe(400);
    expect(String(lateOverCap.challenge.body.error)).toContain('expired at');
    expect(admitTeamCreate(s.home, idB, tcRootB, s.store, s.now()).ok).toBe(false);
  });

  test('3. a deferral is never an answer: nothing is approved, denied, or spent before or after until', async () => {
    const s = await setupStage();

    const tcRoot = join(s.base, 'never-answer-repo');
    mkdirSync(tcRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: tcRoot, env: gitEnv(), stdio: 'ignore' });
    const tc = createTeamCreateRequest(s.home, tcRoot, null, s.now());
    if (!tc.ok) throw new Error(tc.why);

    const oa = createOwnerActionRequest(
      s.home,
      { actions: ['team-up'], root: s.root, team: 'demo', head: null, args: {}, requestedBy: 'seat:worker' },
      s.now(),
    );
    if (!oa.ok) throw new Error(oa.why);

    const gr = await createGrantCard(s, ['--team', 'demo', '--seat', 'worker']);

    for (const id of [tc.record.request_id, oa.record.request_id, gr.id]) {
      const res = await submitAnswer(s, id, 'later');
      expect(res.answer?.status).toBe(200);
    }

    // Check at T0 + 2m (while deferred) and at T0 + 4h + 1m (after return, still unanswered)
    for (const offset of [2 * MINUTE, 4 * HOUR + MINUTE]) {
      s.setOffset(offset);

      for (const id of [tc.record.request_id, oa.record.request_id]) {
        const folder = actionRequestsFolder(s.home);
        expect(existsSync(join(folder, `${id}.seat-answer.json`))).toBe(false);
        expect(existsSync(join(folder, `${id}.answer.json`))).toBe(false);
        expect(existsSync(join(folder, `${id}.used`))).toBe(false);
      }
      expect(existsSync(join(grantRequestsFolder(s.home), `${gr.id}.seat-answer.json`))).toBe(false);
      expect(existsSync(join(grantRequestsFolder(s.home), `${gr.id}.used`))).toBe(false);

      const tcAdmit = admitTeamCreate(s.home, tc.record.request_id, tcRoot, s.store, s.now());
      expect(tcAdmit.ok).toBe(false);
      if (!tcAdmit.ok) expect(tcAdmit.why).toContain('no verified owner-seat answer');

      const oaAdmit = admitOwnerAction(
        s.home,
        oa.record.request_id,
        { action: 'team-up', root: s.root, team: 'demo', head: null, words: [], claim: false },
        s.store,
        s.now(),
      );
      expect(oaAdmit.ok).toBe(false);
      if (!oaAdmit.ok) expect(oaAdmit.why).toContain('no owner-seat answer');

      const grExec = executePendingGrant(s.home, { requestId: gr.id }, { now: s.now(), ownerSeatStore: s.store });
      expect(grExec.ok).toBe(false);
    }
  });

  test('4. the lead note reads as owner page, never as owner, for both owner-action and team-grant deferrals', async () => {
    const s = await setupStage();
    const untilIso = new Date(T0.getTime() + 4 * HOUR).toISOString();

    // 1. Defer an owner-action request for team `demo` and verify plain `runMessages`
    const oa = createOwnerActionRequest(
      s.home,
      { actions: ['team-up'], root: s.root, team: 'demo', head: null, args: {}, requestedBy: 'seat:worker' },
      s.now(),
    );
    if (!oa.ok) throw new Error(oa.why);
    const oaDefer = await submitAnswer(s, oa.record.request_id, 'later');
    expect(oaDefer.answer?.status).toBe(200);
    expect(String(oaDefer.answer?.body.notice)).toContain('lead of demo');

    const plainIo = testIo(s.root, { kind: 'owner' });
    expect(await runMessages([], plainIo, { home: s.home, now: () => s.now() })).toBe(0);
    expect(plainIo.out).toContain('owner page');
    expect(plainIo.out).toContain(oa.record.request_id);

    // 2. Defer a team-grant request for team `demo` and verify `--json` `runMessages`
    const gr = await createGrantCard(s, ['--team', 'demo', '--seat', 'worker']);
    const grDefer = await submitAnswer(s, gr.id, 'later');
    expect(grDefer.answer?.status).toBe(200);
    expect(String(grDefer.answer?.body.notice)).toContain('lead of demo');

    const jsonIo = testIo(s.root, { kind: 'owner' });
    expect(await runMessages(['--json'], jsonIo, { home: s.home, now: () => s.now() })).toBe(0);
    const parsed = JSON.parse(jsonIo.out) as { rows: Array<{ from: string; to: string; body: string }> };
    expect(parsed.rows).toHaveLength(2);
    for (const row of parsed.rows) {
      expect(row.from).toBe('owner page');
      expect(row.from).not.toBe('owner');
      expect(row.to).toBe('lead');
    }
    const bodies = parsed.rows.map((row) => row.body).join('\n');
    expect(bodies).toContain(oa.record.request_id);
    expect(bodies).toContain(gr.id);

    // 3. Defer a team-create request (no existing team -> no new note written)
    const tcRoot = join(s.base, 'no-note-repo');
    mkdirSync(tcRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: tcRoot, env: gitEnv(), stdio: 'ignore' });
    const tc = createTeamCreateRequest(s.home, tcRoot, null, s.now());
    if (!tc.ok) throw new Error(tc.why);
    const tcDefer = await submitAnswer(s, tc.record.request_id, 'later');
    expect(tcDefer.answer?.status).toBe(200);
    expect(String(tcDefer.answer?.body.notice)).toContain('no team is blocked yet');

    // Verify the 2 notes in the lead's drop folder
    const dropDir = recordDir(s.root, 'demo', 'lead');
    const files = readdirSync(dropDir).filter((name) => !name.includes('.'));
    expect(files).toHaveLength(2);

    for (const file of files) {
      const rec = recordAt(join(dropDir, file));
      expect(verifyRecord(rec, messageKeyOf(s.home))).toBe(true);
      expect(rec.payload.from).toBe('owner page');
      expect(rec.payload.from).not.toBe('owner');
      expect(rec.payload.from_id).toBeNull();
      expect(rec.payload.rule).toBe('owner page');
      expect(rec.payload.to).toBe('lead');
      expect(rec.payload.message_kind).toBe('blocked');
      expect(rec.payload.body).toContain(`until ${untilIso} (the owner answered "later")`);
      expect(rec.payload.body).toContain('Nothing was approved or denied, and nothing is needed from you until then.');
    }

    // Also verify `verifyOwnerLater` directly on the written `.later.json` files
    for (const [folder, id, expectedKind, expectedTeam] of [
      [actionRequestsFolder(s.home), oa.record.request_id, 'owner-action', 'demo'],
      [grantRequestsFolder(s.home), gr.id, 'grant', 'demo'],
      [actionRequestsFolder(s.home), tc.record.request_id, 'team-create', null],
    ] as const) {
      const rawLater = JSON.parse(readFileSync(join(folder, `${id}.later.json`), 'utf8')) as SignedOwnerLater;
      const verified = verifyOwnerLater(s.home, rawLater, s.store, s.now());
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.later.kind).toBe(expectedKind);
        expect(verified.later.team).toBe(expectedTeam);
        expect(verified.later.seat).toBe('owner');
      }
    }
  });
});
