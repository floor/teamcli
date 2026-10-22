// The `grant` op: an owner-issued master client grant lets its holder have TeamCLI issue
// sub-grants inside a signed scope, with no owner terminal. The owner's rule — no agent widens its
// own grant — is held here: ops, scope, expiry, revocation, signature and seat admission.
// Synthetic homes only.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import {
  CLIENT_GRANT_DOMAIN,
  appendClientRevocation,
  clientGrantAuditFolder,
  clientKeyDir,
  newClientKeyPair,
  readClientGrantFile,
  writeClientGrant,
  writeClientKeyFiles,
  type ClientGrantScope,
} from '../src/client/records.ts';
import { resolveClientTarget } from '../src/client/send.ts';
import { admitClientGrantIssue, verifyClientGrantIssue, verifyClientRequest } from '../src/client/verify.ts';
import { runGrant } from '../src/commands/grant.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { keyOf, signDomain, type Json } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';

const TEAM_ID = 'bbbbbbbbbbbb';
const made: string[] = [];
afterAll(() => {
  for (const base of made) rmSync(base, { recursive: true, force: true });
});

const seat = (name: string, extra = '') => `  - role: ${name === 'orchestrator' ? 'orchestrator' : 'builder'}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
${extra}`;

const ENTITIES = 'floor:\n  clients:\n    grok-bot:\n      seats: [orchestrator, zeus]\n    acme-bot:\n      seats: [orchestrator]\n';

function world(label: string) {
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.client-grant-op-${label}-`)));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'floor');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), ENTITIES);
  const text = `format: 1\nproject: floor\noperator: steward\nworkspace:\n  mode: shared\nseats:\n${seat('orchestrator', '    leads: true\n')}${seat('zeus')}${seat('steward')}`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const ownerKey = keyOf(home);
  const agent = (name: string) => registerAgent(home, {
    name,
    signing: { model: 'M', version: '1', role: name },
    lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: TEAM_ID, seat: name, session: 'floor', pane: 'w1:p1', address: join(base, 'x.sock') },
    mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const orch = agent('orchestrator');
  const zeus = agent('zeus');
  const steward = agent('steward');
  writeFileSync(join(home, '.config', 'team', 'teams.yaml'), `teams:
  "${TEAM_ID}":
    project: floor
    project_id: null
    entity: floor
    session: floor
    root: ${root}
    lobby: ${join(base, 'lobby')}
    roster:
      - { agent: ${orch.id}, seat: orchestrator, role: orchestrator, leads: true }
      - { agent: ${zeus.id}, seat: zeus, role: builder }
      - { agent: ${steward.id}, seat: steward, role: builder }
    lifecycle: running
    provenance: { registered_by: test, registered_at: "2026-10-19T00:00:00.000Z", updated_at: "2026-10-19T00:00:00.000Z" }
`);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('floor', root, home), { approval: approvalOf(checked.team, root, new Date()), file: text }, [], home);
  const keys = (clientId: string) => {
    const pair = newClientKeyPair();
    const dir = clientKeyDir(home, clientId);
    const files = writeClientKeyFiles(dir, pair);
    if (!files.ok) throw new Error(files.why);
    return { pair, dir, keyPath: files.keyPath, pubPath: files.pubPath };
  };
  const grok = keys('grok-bot');
  const acme = keys('acme-bot');
  const master = (scope: ClientGrantScope | undefined, options: { now?: Date; expires?: string; inbox?: boolean } = {}) => {
    const written = writeClientGrant(home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: grok.pair.publicKey, keyId: grok.pair.keyId, keyDir: grok.dir,
      ...(scope !== undefined ? { grantScope: scope } : {}),
      ...(options.expires !== undefined ? { expires: options.expires } : {}),
      ...(options.inbox ? { inbox: true } : {}),
    }, { now: options.now ?? new Date(), key: ownerKey });
    if (!written.ok) throw new Error(written.why);
    return written;
  };
  return { base, home, root, ownerKey, grok, acme, master };
}

type World = ReturnType<typeof world>;

function capture(w: World, caller?: Caller): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = {
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
    cwd: w.root,
    env: {},
    stdinIsTTY: false,
    ...(caller === undefined ? {} : { caller }),
  };
  return { io, out: () => out, err: () => err };
}

const FLOOR: ClientGrantScope = { entities: ['floor'], projects: [], teams: [] };

function request(w: World, masterPath: string, extra: string[] = []): string[] {
  return ['--client-request', '--via', masterPath, '--key', w.grok.keyPath, '--client', 'acme-bot', '--entity', 'floor', '--public-key', w.acme.pubPath, ...extra];
}

function issueInput(w: World, masterFile: string, over: Partial<Parameters<typeof verifyClientGrantIssue>[0]> = {}) {
  return {
    home: w.home, masterFile, keyFile: w.grok.keyPath, clientId: 'acme-bot', entity: 'floor', team: null, seat: null,
    publicKey: w.acme.pair.publicKey, keyId: w.acme.pair.keyId, keyDir: w.acme.dir, expires: null, inbox: false, now: new Date(),
    ...over,
  };
}

function resign(w: World, path: string, edit: (grant: Record<string, unknown>) => void): string {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  edit(record.client_grant);
  const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: record.client_grant.grant_id, client_grant: record.client_grant as Json }, w.ownerKey);
  const out = join(w.base, `crafted-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(out, JSON.stringify({ client_grant: record.client_grant, signature }));
  return out;
}

describe('issuing a master grant (owner only)', () => {
  test('--allow-grant writes vocabulary 3 with grant and the scope', async () => {
    const w = world('issue');
    const io = capture(w, { kind: 'owner' } as Caller);
    const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--allow-grant', '--grant-entity', 'floor'], io.io, { home: w.home });
    expect(code).toBe(0);
    const path = /grant file: (.*)/.exec(io.out())![1]!;
    const record = JSON.parse(readFileSync(path, 'utf8')).client_grant;
    expect(record.vocabulary).toBe(3);
    expect(record.allowed_ops).toEqual(['send', 'grant']);
    expect(record.grant_scope).toEqual({ entities: ['floor'], projects: [], teams: [] });
    expect(record.issued_by).toBeUndefined();
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  test('scope flags without --allow-grant, and --allow-grant on a request, are invocation errors', async () => {
    const w = world('flags');
    const owner = capture(w, { kind: 'owner' } as Caller);
    expect(await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--grant-entity', 'floor'], owner.io, { home: w.home })).toBe(2);
    const m = w.master(FLOOR);
    const req = capture(w);
    expect(await runGrant([...request(w, m.path), '--allow-grant'], req.io, { home: w.home })).toBe(2);
    expect(req.err()).toContain('never carries grant');
  });

  test('a direct team grant --client with no owner terminal is still refused', async () => {
    const w = world('notty');
    const io = capture(w);
    const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--allow-grant', '--grant-entity', 'floor'], io.io, { home: w.home });
    expect(code).toBe(1);
    expect(io.err()).toContain('only the owner runs this');
    expect(existsSync(join(w.home, '.config', 'team', 'grants'))).toBe(false);
  });
});

describe('the decoder', () => {
  test('vocabulary 1 and 2 grants keep their exact shape and still read', () => {
    const w = world('compat');
    const v1 = w.master(undefined);
    const v2 = w.master(undefined, { inbox: true });
    for (const [written, vocabulary, ops] of [[v1, 1, ['send']], [v2, 2, ['send', 'messages']]] as const) {
      const disk = JSON.parse(readFileSync(written.path, 'utf8')).client_grant;
      expect(disk.vocabulary).toBe(vocabulary);
      expect(disk.allowed_ops).toEqual([...ops]);
      expect(Object.keys(disk)).not.toContain('grant_scope');
      expect(Object.keys(disk)).not.toContain('issued_by');
      expect(readClientGrantFile(w.home, written.path).ok).toBe(true);
    }
  });

  test('crafted owner-signed shapes outside the vocabulary are refused', () => {
    const w = world('crafted');
    const v2 = w.master(undefined, { inbox: true });
    const m = w.master(FLOOR);
    const bad = [
      resign(w, v2.path, (g) => { g.grant_scope = FLOOR; }),
      resign(w, v2.path, (g) => { g.allowed_ops = ['send', 'messages', 'grant']; }),
      resign(w, m.path, (g) => { delete g.grant_scope; }),
      resign(w, m.path, (g) => { g.allowed_ops = ['send', 'messages']; }),
      resign(w, m.path, (g) => { g.allowed_ops = ['grant']; }),
      resign(w, m.path, (g) => { g.issued_by = 'cg_000000000000000000000000'; }),
      resign(w, m.path, (g) => { g.grant_scope = { entities: ['floor'], projects: [] }; }),
    ];
    for (const path of bad) expect(readClientGrantFile(w.home, path).ok).toBe(false);
    expect(readClientGrantFile(w.home, m.path).ok).toBe(true);
  });
});

describe('a sub-grant requested under a master grant', () => {
  test('in scope: written with no owner terminal, names its master, audited, and usable with team send', async () => {
    const w = world('ok');
    const m = w.master(FLOOR);
    const io = capture(w);
    expect(await runGrant(request(w, m.path), io.io, { home: w.home })).toBe(0);
    expect(io.out()).toContain(`issued by master grant: ${m.grant.grantId}`);
    const path = /grant file: (.*)/.exec(io.out())![1]!;
    const sub = readClientGrantFile(w.home, path);
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    expect(sub.grant.clientId).toBe('acme-bot');
    expect(sub.grant.allowedOps).toEqual(['send']);
    expect(sub.grant.vocabulary).toBe(1);
    expect(sub.grant.issuedBy).toBe(m.grant.grantId);
    expect(sub.grant.grantScope).toBeUndefined();
    expect(Date.parse(sub.grant.expires)).toBeLessThanOrEqual(Date.parse(m.grant.expires));
    const audit = JSON.parse(readFileSync(join(clientGrantAuditFolder(w.home), `${sub.grant.grantId}.json`), 'utf8'));
    expect(audit.client_grant_audit.master_grant_id).toBe(m.grant.grantId);
    expect(resolveClientTarget(w.home, 'orchestrator@floor', sub.grant).ok).toBe(true);
    const send = verifyClientRequest({
      home: w.home, grantFile: path, keyFile: w.acme.keyPath, body: 'hello',
      target: { entity: 'floor', recipientId: sub.grant.recipientId, recipientSeat: 'orchestrator' }, now: new Date(),
    });
    expect(send.ok).toBe(true);
  });

  test('out of scope, and an empty scope, grant nothing', async () => {
    const w = world('scope');
    for (const scope of [{ entities: ['labs'], projects: [], teams: [] }, { entities: [], projects: [], teams: ['teamcli'] }, { entities: [], projects: [], teams: [] }]) {
      const m = w.master(scope);
      const io = capture(w);
      expect(await runGrant(request(w, m.path), io.io, { home: w.home })).toBe(1);
      expect(io.err()).toContain('outside the master grant');
    }
    const byTeam = w.master({ entities: [], projects: [], teams: ['floor'] });
    expect(verifyClientGrantIssue(issueInput(w, byTeam.path)).ok).toBe(true);
    const byProject = w.master({ entities: [], projects: ['floor'], teams: [] });
    expect(verifyClientGrantIssue(issueInput(w, byProject.path)).ok).toBe(true);
  });

  test('no chaining: a sub-grant is never a master, and no grant carries both', async () => {
    const w = world('chain');
    const m = w.master(FLOOR);
    const io = capture(w);
    expect(await runGrant(request(w, m.path, ['--client', 'grok-bot', '--public-key', w.grok.pubPath]), io.io, { home: w.home })).toBe(0);
    const subPath = /grant file: (.*)/.exec(io.out())![1]!;
    const again = verifyClientGrantIssue(issueInput(w, subPath));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.why).toContain('does not carry grant');
    const plain = w.master(undefined);
    expect(verifyClientGrantIssue(issueInput(w, plain.path)).ok).toBe(false);
    const both = writeClientGrant(w.home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir,
      grantScope: FLOOR, issuedBy: m.grant.grantId,
    }, { key: w.ownerKey });
    expect(both.ok).toBe(false);
  });

  test('ops never widen: --inbox needs a master that carries messages', () => {
    const w = world('inbox');
    const sendOnly = w.master(FLOOR);
    const refused = verifyClientGrantIssue(issueInput(w, sendOnly.path, { inbox: true }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.why).toContain('does not carry messages');
    const withInbox = w.master(FLOOR, { inbox: true });
    expect(withInbox.grant.allowedOps).toEqual(['send', 'messages', 'grant']);
    expect(verifyClientGrantIssue(issueInput(w, withInbox.path, { inbox: true })).ok).toBe(true);
  });

  test('expiry: clamped to the master by default, refused past it, and an expired master grants nothing', () => {
    const w = world('expiry');
    const now = new Date();
    const masterExpires = new Date(now.getTime() + 2 * 24 * 3600 * 1000).toISOString();
    const m = w.master(FLOOR, { now, expires: masterExpires });
    const clamped = verifyClientGrantIssue(issueInput(w, m.path, { now }));
    expect(clamped.ok).toBe(true);
    if (clamped.ok) expect(clamped.expires).toBe(masterExpires);
    const past = verifyClientGrantIssue(issueInput(w, m.path, { now, expires: new Date(now.getTime() + 3 * 24 * 3600 * 1000).toISOString() }));
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.why).toContain('never outlives its master');
    const later = verifyClientGrantIssue(issueInput(w, m.path, { now: new Date(Date.parse(masterExpires) + 1000) }));
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.why).toContain('expired');
  });

  test('a revoked master refuses new requests and stops the sub-grants it issued', async () => {
    const w = world('revoked');
    const m = w.master(FLOOR);
    const io = capture(w);
    expect(await runGrant(request(w, m.path), io.io, { home: w.home })).toBe(0);
    const subPath = /grant file: (.*)/.exec(io.out())![1]!;
    const sub = readClientGrantFile(w.home, subPath);
    if (!sub.ok) throw new Error(sub.why);
    expect(appendClientRevocation(w.home, m.grant.grantId, { key: w.ownerKey }).ok).toBe(true);
    const after = capture(w);
    expect(await runGrant(request(w, m.path), after.io, { home: w.home })).toBe(1);
    expect(after.err()).toContain('revoked');
    const send = verifyClientRequest({
      home: w.home, grantFile: subPath, keyFile: w.acme.keyPath, body: 'hello',
      target: { entity: 'floor', recipientId: sub.grant.recipientId, recipientSeat: 'orchestrator' }, now: new Date(),
    });
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.why).toContain('master grant');
  });

  test('a tampered request or a signature from another key is refused', () => {
    const w = world('tamper');
    const m = w.master(FLOOR);
    const ok = verifyClientGrantIssue(issueInput(w, m.path));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const presented = { grant: ok.master, signature: (JSON.parse(readFileSync(m.path, 'utf8')) as { signature: string }).signature };
    const now = new Date();
    for (const edit of [{ entity: 'labs' }, { seat: 'zeus' }, { client_id: 'grok-bot' }, { expires: '2099-01-01T00:00:00.000Z' }, { inbox: true }]) {
      const tampered = admitClientGrantIssue(w.home, presented, { ...ok.request, ...edit }, ok.signature, now);
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.why).toContain('signature does not verify');
    }
    const wrongKey = verifyClientGrantIssue(issueInput(w, m.path, { keyFile: w.acme.keyPath }));
    expect(wrongKey.ok).toBe(false);
    if (!wrongKey.ok) expect(wrongKey.why).toContain('is not the app key');
  });

  test('seat admission still applies: the operator and unlisted seats are refused', () => {
    const w = world('seats');
    const m = w.master(FLOOR);
    for (const seatName of ['steward', 'zeus']) {
      const refused = verifyClientGrantIssue(issueInput(w, m.path, { seat: seatName }));
      expect(refused.ok).toBe(false);
    }
    expect(verifyClientGrantIssue(issueInput(w, m.path, { clientId: 'grok-bot', seat: 'zeus', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir })).ok).toBe(true);
    const unknown = verifyClientGrantIssue(issueInput(w, m.path, { clientId: 'nobody-bot' }));
    expect(unknown.ok).toBe(false);
  });
});
