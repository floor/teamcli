// Conversational grant emission: the signed `grant-emission` entity policy, pending requests,
// one-time-code approvals bound to the request hash, and standing 'always' rules. Synthetic homes
// only; the on-screen notifier is replaced by a capture, never printed.

import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { clientKeyDir, newClientKeyPair, writeClientGrant, writeClientKeyFiles, type ClientGrantScope } from '../src/client/records.ts';
import { grantApprovalsFolder, grantEmissionAuditFolder, grantEmissionOf, grantRequestsFolder } from '../src/client/emission.ts';
import { runGrant } from '../src/commands/grant.ts';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { acceptedSigners, readOwnerSeat, ownerSeatAnswerBytes, ownerSignerLabel, ownerSeatFile, ownerSeatInbox, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { messageKeyOf, signDomain as signShared } from '../src/store/keys.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { keyOf } from '../src/store/keys.ts';
import { storePath, writeApproval } from '../src/store/store.ts';

const TEAM_ID = 'cccccccccccc';
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
  const base = realpathSync(mkdtempSync(join(process.cwd(), `.grant-emission-${label}-`)));
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

function capture(w: World): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd: w.root, env: {}, stdinIsTTY: false };
  return { io, out: () => out, err: () => err };
}

function conversational(w: World): void {
  const wrote = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'grant-emission', value: 'conversational' }, { now: new Date() });
  if (!wrote.ok) throw new Error(wrote.why);
}

function screen() {
  const codes: string[] = [];
  return { codes, notify: (_title: string, text: string) => { codes.push(/Code ([0-9]{6})/.exec(text)![1]!); return true; } };
}

const ask = (w: World, extra: string[] = []) => ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--request', ...extra];

async function requestOf(w: World, s: ReturnType<typeof screen>, extra: string[] = [], now?: Date) {
  const io = capture(w);
  const code = await runGrant([...ask(w, extra), '--json'], io.io, { home: w.home, notify: s.notify, ...(now ? { now } : {}) });
  return { code, io, json: code === 0 ? JSON.parse(io.out()) : null };
}

async function execute(w: World, id: string, extra: string[], now?: Date, ownerSeatStore?: OwnerSeatKeyStore) {
  const io = capture(w);
  const code = await runGrant(['--execute', id, ...extra], io.io, { home: w.home, ...(now ? { now } : {}), ...(ownerSeatStore ? { ownerSeatStore } : {}) });
  return { code, io };
}

const SHAPE = (path: string) => {
  const g = JSON.parse(readFileSync(path, 'utf8')).client_grant;
  delete g.grant_id; delete g.issued;
  return g;
};

describe('grant-emission: owner-terminal by default', () => {
  test('absent policy: a request is refused and the direct form still needs the owner terminal', async () => {
    const w = world('default');
    expect(grantEmissionOf(w.home, 'floor').mode).toBe('owner-terminal');
    const s = screen();
    const r = await requestOf(w, s);
    expect(r.code).toBe(1);
    expect(s.codes).toHaveLength(0);
    const direct = capture(w);
    expect(await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath], direct.io, { home: w.home })).toBe(1);
    expect(direct.err()).toContain('only the owner runs this');
  });

  test('a tampered policy falls back to owner-terminal', async () => {
    const w = world('tampered');
    conversational(w);
    expect(grantEmissionOf(w.home, 'floor').mode).toBe('conversational');
    const files = execFileSync('grep', ['-rl', 'grant-emission', join(w.home, '.config')]).toString().trim().split('\n');
    for (const file of files) writeFileSync(file, readFileSync(file, 'utf8').replace(/[0-9a-f]{128}/g, (sig) => (sig[0] === '0' ? '1' : '0') + sig.slice(1)));
    expect(grantEmissionOf(w.home, 'floor').mode).toBe('owner-terminal');
    const r = await requestOf(w, screen());
    expect(r.code).toBe(1);
  });
});

describe('conversational requests and approvals', () => {
  test('a request records, shows the code only on screen, and offers once | always | deny', async () => {
    const w = world('request');
    conversational(w);
    const s = screen();
    const r = await requestOf(w, s);
    expect(r.code).toBe(0);
    expect(s.codes).toHaveLength(1);
    expect(r.io.out()).not.toContain(s.codes[0]!);
    expect(r.io.err()).not.toContain(s.codes[0]!);
    const record = readFileSync(join(grantRequestsFolder(w.home), `${r.json.target}.json`), 'utf8');
    expect(record).not.toContain(`"${s.codes[0]}"`);
    expect(r.json.status).toBe('requested');
    expect(r.json.choices.map((c: { id: string }) => c.id)).toEqual(['once', 'always', 'deny']);
    expect(r.json.summary).toMatchObject({ client: 'grok-bot', entity: 'floor', team: 'floor', seat: 'orchestrator', ops: ['send'] });
    expect(readdirSync(join(w.home, '.config', 'team', 'grants')).filter((n) => n.startsWith('cg_'))).toHaveLength(0);
  });

  test('a request for an unregistered team is refused; an execute that cannot write the grant does not spend the request', async () => {
    const w = world('unspent');
    conversational(w);
    const s = screen();
    const ghost = await requestOf(w, s, ['--team', 'ghost']);
    expect(ghost.code).not.toBe(0);
    expect(JSON.parse(ghost.io.out()).error.message).toContain('no team "ghost"');
    const a = await requestOf(w, s);
    expect(a.code).toBe(0);
    const teams = join(w.home, '.config', 'team', 'teams.yaml');
    const live = readFileSync(teams, 'utf8');
    writeFileSync(teams, live.replace('lifecycle: running', 'lifecycle: archived'));
    const failed = await execute(w, a.json.target, ['--code', s.codes[0]!]);
    expect(failed.code).toBe(1);
    expect(failed.io.err()).toContain('is not spent');
    expect(existsSync(join(grantRequestsFolder(w.home), `${a.json.target}.used`))).toBe(false);
    writeFileSync(teams, live);
    expect((await execute(w, a.json.target, ['--code', s.codes[0]!])).code).toBe(0);
  });

  test('no code, a wrong code (which spends the request) and a reused approval are refused', async () => {
    const w = world('codes');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    const unanswered = await execute(w, a.json.target, []);
    expect(unanswered.code).toBe(1);
    expect(unanswered.io.err()).toContain('no owner answer yet');
    expect(unanswered.io.err()).toContain(`--approve-as-owner-seat ${a.json.target}`);
    const wrong = s.codes[0] === '000000' ? '111111' : '000000';
    expect((await execute(w, a.json.target, ['--code', wrong])).code).toBe(1);
    const burned = await execute(w, a.json.target, ['--code', s.codes[0]!]);
    expect(burned.code).toBe(1);
    expect(burned.io.err()).toContain('already used');
    const b = await requestOf(w, s);
    expect((await execute(w, b.json.target, ['--code', s.codes[1]!])).code).toBe(0);
    const reuse = await execute(w, b.json.target, ['--code', s.codes[1]!]);
    expect(reuse.code).toBe(1);
    expect(reuse.io.err()).toContain('single-use');
  });

  test('an expired request, changed parameters and an edited pending file are refused', async () => {
    const w = world('expired');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    const later = new Date(Date.now() + 16 * 60 * 1000);
    const expired = await execute(w, a.json.target, ['--code', s.codes[0]!], later);
    expect(expired.code).toBe(1);
    expect(expired.io.err()).toContain('expired');
    const b = await requestOf(w, s);
    const changed = await execute(w, b.json.target, ['--code', s.codes[1]!, '--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--inbox']);
    expect(changed.code).toBe(1);
    expect(changed.io.err()).toContain('hash mismatch');
    const c = await requestOf(w, s);
    const path = join(grantRequestsFolder(w.home), `${c.json.target}.json`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"inbox": false', '"inbox": true'));
    expect((await execute(w, c.json.target, ['--code', s.codes[2]!])).code).toBe(1);
  });

  test('a valid approval writes the same grant the owner would, and audits the adapter', async () => {
    const w = world('valid');
    conversational(w);
    const s = screen();
    const expires = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const a = await requestOf(w, s, ['--expires', expires]);
    const done = await execute(w, a.json.target, ['--code', s.codes[0]!]);
    expect(done.code).toBe(0);
    const path = /grant file: (.*)/.exec(done.io.out())![1]!;
    const owner = writeClientGrant(w.home, { clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir, expires }, { key: w.ownerKey });
    if (!owner.ok) throw new Error(owner.why);
    expect(SHAPE(path)).toEqual(SHAPE(owner.path));
    const audit = JSON.parse(readFileSync(join(grantEmissionAuditFolder(w.home), `${a.json.target}.json`), 'utf8'));
    expect(audit.grant_emission_audit.adapter).toBe('one-time-code');
    expect(audit.grant_emission_audit.choice).toBe('once');
  });

  test('deny spends a request and writes nothing', async () => {
    const w = world('deny');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    const io = capture(w);
    expect(await runGrant(['--deny', a.json.target], io.io, { home: w.home })).toBe(0);
    expect((await execute(w, a.json.target, ['--code', s.codes[0]!])).code).toBe(1);
    expect(readdirSync(join(w.home, '.config', 'team', 'grants')).filter((n) => n.startsWith('cg_'))).toHaveLength(0);
  });
});

describe('always: standing approval rules', () => {
  test('stored only with a valid approval; a request inside it is auto-approved and audited with the rule id', async () => {
    const w = world('always');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    const wrong = s.codes[0] === '000000' ? '111111' : '000000';
    expect((await execute(w, a.json.target, ['--approve', 'always', '--code', wrong])).code).toBe(1);
    expect(existsSync(grantApprovalsFolder(w.home))).toBe(false);
    const b = await requestOf(w, s);
    const ok = await execute(w, b.json.target, ['--approve', 'always', '--code', s.codes[1]!]);
    expect(ok.code).toBe(0);
    const ruleId = /standing rule: (ar_[0-9a-f]{24})/.exec(ok.io.out())![1]!;
    const before = s.codes.length;
    const auto = await requestOf(w, s);
    expect(auto.code).toBe(0);
    expect(auto.json.status).toBe('updated');
    expect(auto.json.rule_id).toBe(ruleId);
    expect(s.codes.length).toBe(before);
    const audits = readdirSync(grantEmissionAuditFolder(w.home)).filter((n) => n.startsWith('auto_'));
    expect(audits).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(grantEmissionAuditFolder(w.home), audits[0]!), 'utf8')).grant_emission_audit.rule_id).toBe(ruleId);
    const list = capture(w);
    expect(await runGrant(['--approvals', '--json'], list.io, { home: w.home })).toBe(0);
    const rules = JSON.parse(list.out()).rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ rule_id: ruleId, client_id: 'grok-bot', entity: 'floor', teams: ['floor'], seats: ['orchestrator'], ops: ['send'], approved_by: 'one-time-code' });
  });

  test('a rule lives for approval-rule-ttl: 30 days by default, 90 at most', async () => {
    const w = world('ttl');
    conversational(w);
    const s = screen();
    const b = await requestOf(w, s);
    expect((await execute(w, b.json.target, ['--approve', 'always', '--code', s.codes[0]!])).code).toBe(0);
    const day = 86_400_000;
    const at = (days: number) => new Date(Date.now() + days * day);
    expect((await requestOf(w, s, [], at(29))).json.status).toBe('updated');
    const stale = await requestOf(w, s, [], at(31));
    expect(stale.json.status).not.toBe('updated');
    const ttl = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'approval-rule-ttl', value: 90 }, { now: new Date() });
    if (!ttl.ok) throw new Error(ttl.why);
    expect((await requestOf(w, s, [], at(31))).json.status).toBe('updated');
    expect((await requestOf(w, s, [], at(91))).json.status).not.toBe('updated');
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'approval-rule-ttl', value: 120 }, { now: new Date() }).ok).toBe(false);
  });

  test('a wider request asks again; a master grant is never auto-approved nor approved always', async () => {
    const w = world('wider');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    expect((await execute(w, a.json.target, ['--approve', 'always', '--code', s.codes[0]!])).code).toBe(0);
    for (const extra of [['--inbox'], ['--seat', 'zeus'], ['--allow-grant', '--grant-entity', 'floor']]) {
      const r = await requestOf(w, s, extra);
      expect(r.code).toBe(0);
      expect(r.json.status).toBe('requested');
    }
    const master = await requestOf(w, s, ['--allow-grant', '--grant-entity', 'floor']);
    expect(master.json.choices.map((c: { id: string }) => c.id)).toEqual(['once', 'deny']);
    const refused = await execute(w, master.json.target, ['--approve', 'always', '--code', s.codes[s.codes.length - 1]!]);
    expect(refused.code).toBe(1);
    expect(refused.io.err()).toContain('never approved always');
  });

  test('a tampered rule is ignored, and a revoked rule stops matching at once', async () => {
    const w = world('rule-tamper');
    conversational(w);
    const s = screen();
    const a = await requestOf(w, s);
    const ok = await execute(w, a.json.target, ['--approve', 'always', '--code', s.codes[0]!]);
    const ruleId = /standing rule: (ar_[0-9a-f]{24})/.exec(ok.io.out())![1]!;
    const path = join(grantApprovalsFolder(w.home), `${ruleId}.json`);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, original.replace('"orchestrator"', '"zeus"'));
    expect((await requestOf(w, s, ['--seat', 'zeus'])).json.status).toBe('requested');
    const list = capture(w);
    await runGrant(['--approvals', '--json'], list.io, { home: w.home });
    expect(JSON.parse(list.out()).ignored).toEqual([ruleId]);
    writeFileSync(path, original);
    expect((await requestOf(w, s)).json.status).toBe('updated');
    const revoke = capture(w);
    expect(await runGrant(['--revoke-approval', ruleId], revoke.io, { home: w.home })).toBe(0);
    expect((await requestOf(w, s)).json.status).toBe('requested');
  });
});

describe('the owner answers a request from the owner terminal', () => {
  const owner = (w: World) => {
    const c = capture(w);
    return { ...c, io: { ...c.io, caller: { kind: 'owner' } as Io['caller'] } as Io };
  };
  const noScreen = { notify: () => false };

  test('grok-bot requests a master grant for itself; the owner answers oui; execute writes it once', async () => {
    const w = world('answer');
    conversational(w);
    const r = await requestOf(w, noScreen as never, ['--allow-grant', '--grant-entity', 'floor']);
    expect(r.code).toBe(0);
    expect(r.json.prompt).toContain(`Grant request ${r.json.target}:`);
    expect(r.json.prompt).toContain('MASTER grant');
    expect((await execute(w, r.json.target, [])).code).toBe(1);
    const o = owner(w);
    expect(await runGrant(['--answer', r.json.target, 'oui'], o.io, { home: w.home })).toBe(0);
    const done = await execute(w, r.json.target, []);
    expect(done.io.err()).toBe('');
    expect(done.code).toBe(0);
    const path = /grant file: (.*)/.exec(done.io.out())![1]!;
    const g = JSON.parse(readFileSync(path, 'utf8')).client_grant;
    expect(g.allowed_ops).toEqual(['send', 'grant']);
    expect(g.grant_scope.entities).toEqual(['floor']);
    expect((await execute(w, r.json.target, [])).code).toBe(1);
  });

  test('an answer not from the owner, a forged answer, an answer for another id and a deny are refused', async () => {
    const w = world('answer-refuse');
    conversational(w);
    const a = await requestOf(w, noScreen as never);
    const bot = capture(w);
    expect(await runGrant(['--answer', a.json.target, 'oui'], bot.io, { home: w.home })).toBe(1);
    expect(bot.err()).toContain('only the owner runs this');
    const folder = grantRequestsFolder(w.home);
    writeFileSync(join(folder, `${a.json.target}.answer.json`), JSON.stringify({ grant_answer: { request_id: a.json.target, params_sha256: a.json.request.params_sha256, choice: 'once', by: 'owner', at: new Date().toISOString() }, signature: '00'.repeat(64) }));
    const forged = await execute(w, a.json.target, []);
    expect(forged.code).toBe(1);
    expect(forged.io.err()).toContain("does not verify as the owner's");
    const b = await requestOf(w, noScreen as never);
    const c = await requestOf(w, noScreen as never, ['--inbox']);
    expect(await runGrant(['--answer', b.json.target, 'approved'], owner(w).io, { home: w.home })).toBe(0);
    writeFileSync(join(folder, `${c.json.target}.answer.json`), readFileSync(join(folder, `${b.json.target}.answer.json`)));
    const other = await execute(w, c.json.target, []);
    expect(other.code).toBe(1);
    expect(other.io.err()).toContain("does not verify as the owner's");
    const d = await requestOf(w, noScreen as never);
    expect(await runGrant(['--answer', d.json.target, 'non'], owner(w).io, { home: w.home })).toBe(0);
    expect((await execute(w, d.json.target, [])).code).toBe(1);
  });

  test('always from the owner stores a rule that auto-approves the same request and revoke stops it', async () => {
    const w = world('answer-always');
    conversational(w);
    const a = await requestOf(w, noScreen as never);
    expect(await runGrant(['--answer', a.json.target, 'always'], owner(w).io, { home: w.home })).toBe(0);
    const done = await execute(w, a.json.target, []);
    expect(done.code).toBe(0);
    const ruleId = /standing rule: (ar_[0-9a-f]{24})/.exec(done.io.out())![1]!;
    expect((await requestOf(w, noScreen as never)).json.rule_id).toBe(ruleId);
    expect((await requestOf(w, noScreen as never, ['--allow-grant', '--grant-entity', 'floor'])).json.status).toBe('requested');
    expect(await runGrant(['--revoke-approval', ruleId], capture(w).io, { home: w.home })).toBe(0);
    expect((await requestOf(w, noScreen as never)).json.status).toBe('requested');
  });
});


function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  return {
    pinSet: (label, value) => {
      if (pins.has(label)) return { ok: false, why: 'exists' };
      pins.set(label, value);
      return { ok: true };
    },
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
    name: 'fake-credential-store', prompts,
    available: () => true,
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      return { ok: true, publicKey: `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}` };
    },
    publicKey: (label) => {
      const pair = keys.get(label);
      if (!pair) return { ok: false, why: 'no key' };
      const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
      return { ok: true, publicKey: `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}` };
    },
    sign: (label, message, reason) => {
      prompts.push(reason);
      const pair = keys.get(label);
      if (!pair) return { ok: false, why: 'no key' };
      return { ok: true, signature: cryptoSign('sha256', message, { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex') };
    },
  };
}

describe('the owner seat approves with its own credential-store key', () => {
  const ownerIo = (w: World) => ({ ...capture(w).io, caller: { kind: 'owner' } as Io['caller'] } as Io);
  const noScreen = { notify: () => false };
  async function seated(label: string) {
    const w = world(label);
    conversational(w);
    const store = fakeStore();
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], capture(w).io, { home: w.home, ownerSeatStore: store })).toBe(1);
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], ownerIo(w), { home: w.home, ownerSeatStore: store })).toBe(0);
    const seat = JSON.parse(readFileSync(ownerSeatFile(w.home), 'utf8'));
    expect(seat).toMatchObject({ seat: 'owner', role: 'owner', human: true, lifecycle: 'running', signers: [{ name: 'mac', type: 'mac-keystore' }], provenance: { note: 'created for the human owner' } });
    expect(JSON.stringify(seat)).not.toContain('PRIVATE');
    // Registering the seat from the owner terminal also makes its first signer accepted.
    expect(acceptedSigners(w.home, readOwnerSeat(w.home)!)).toEqual({ names: ['mac'], source: 'policy' });
    return { w, store };
  }
  const approve = (w: World, store: OwnerSeatKeyStore, id: string, word: string) => runGrant(['--approve-as-owner-seat', id, word], capture(w).io, { home: w.home, ownerSeatStore: store });

  test('request lands in the owner seat inbox; owner seat oui (with a presence prompt) lets execute write the grant once', async () => {
    const { w, store } = await seated('seat-ok');
    const r = await requestOf(w, noScreen as never, ['--allow-grant', '--grant-entity', 'floor']);
    expect(r.json.owner_seat.delivered).toBe(true);
    expect(readdirSync(ownerSeatInbox(w.home))).toEqual([`${r.json.target}.json`]);
    expect(await approve(w, store, r.json.target, 'oui')).toBe(0);
    expect(store.prompts).toHaveLength(1);
    const done = await execute(w, r.json.target, [], undefined, store);
    expect(done.code).toBe(0);
    expect(done.io.out()).toContain('approved by: owner-seat');
    expect((await execute(w, r.json.target, [], undefined, store)).code).toBe(1);
  });

  test('a forged seat answer dropped first never blocks the owner seat, nor the terminal answer', async () => {
    const { w, store } = await seated('seat-squat');
    const folder = grantRequestsFolder(w.home);
    const a = await requestOf(w, noScreen as never);
    writeFileSync(join(folder, `${a.json.target}.seat-answer.json`), '{"owner_seat_answer":{},"signer":"mac","signature":"00"}');
    expect(await approve(w, store, a.json.target, 'oui')).toBe(0);
    expect(await approve(w, store, a.json.target, 'oui')).toBe(1);
    const done = await execute(w, a.json.target, [], undefined, store);
    expect(done.code).toBe(0);
    expect(done.io.out()).toContain('approved by: owner-seat');
    // A squatted seat answer and a real terminal answer: the terminal answer stands.
    const b = await requestOf(w, noScreen as never);
    writeFileSync(join(folder, `${b.json.target}.seat-answer.json`), 'not json');
    expect(await runGrant(['--answer', b.json.target, 'oui'], ownerIo(w), { home: w.home })).toBe(0);
    expect((await execute(w, b.json.target, [], undefined, store)).code).toBe(0);
  });

  test('another seat key, the shared message key, another id and an expired request are refused', async () => {
    const { w, store } = await seated('seat-refuse');
    const folder = grantRequestsFolder(w.home);
    const a = await requestOf(w, noScreen as never);
    const answer = { kind: 'grant' as const, request_id: a.json.target, params_sha256: a.json.request.params_sha256, choice: 'once' as const, team: 'floor', seat: 'owner' as const, at: new Date().toISOString() };
    const other = fakeStore();
    other.create('x');
    const sig = (other.sign('x', ownerSeatAnswerBytes(answer), 'r') as { signature: string }).signature;
    writeFileSync(join(folder, `${a.json.target}.seat-answer.json`), JSON.stringify({ owner_seat_answer: answer, signer: 'mac', signature: sig }));
    const r1 = await execute(w, a.json.target, [], undefined, store);
    expect(r1.code).toBe(1);
    expect(r1.io.err()).toContain("does not verify under the owner seat's key");
    const b = await requestOf(w, noScreen as never);
    const bAnswer = { ...answer, request_id: b.json.target, params_sha256: b.json.request.params_sha256 };
    writeFileSync(join(folder, `${b.json.target}.seat-answer.json`), JSON.stringify({ owner_seat_answer: bAnswer, signer: 'mac', signature: signShared('team-owner-seat-answer-v2\n', bAnswer, messageKeyOf(w.home)) }));
    expect((await execute(w, b.json.target, [], undefined, store)).code).toBe(1);
    const c = await requestOf(w, noScreen as never);
    const d = await requestOf(w, noScreen as never, ['--inbox']);
    expect(await approve(w, store, c.json.target, 'oui')).toBe(0);
    writeFileSync(join(folder, `${d.json.target}.seat-answer.json`), readFileSync(join(folder, `${c.json.target}.seat-answer.json`)));
    const r3 = await execute(w, d.json.target, [], undefined, store);
    expect(r3.code).toBe(1);
    expect(r3.io.err()).toContain('not bound');
    const e = await requestOf(w, noScreen as never);
    const late = new Date(Date.now() + 16 * 60 * 1000);
    expect(await runGrant(['--approve-as-owner-seat', e.json.target, 'oui'], capture(w).io, { home: w.home, ownerSeatStore: store, now: late })).toBe(1);
    expect(await approve(w, store, e.json.target, 'oui')).toBe(0);
    expect((await execute(w, e.json.target, [], late, store)).code).toBe(1);
  });

  test('always via the owner seat stores a rule; the terminal answer still works as a fallback', async () => {
    const { w, store } = await seated('seat-always');
    const a = await requestOf(w, noScreen as never);
    expect(await approve(w, store, a.json.target, 'always')).toBe(0);
    const done = await execute(w, a.json.target, [], undefined, store);
    expect(done.code).toBe(0);
    expect(done.io.out()).toContain('standing rule: ar_');
    expect((await requestOf(w, noScreen as never)).json.status).toBe('updated');
    const b = await requestOf(w, noScreen as never, ['--inbox']);
    expect(await runGrant(['--answer', b.json.target, 'oui'], ownerIo(w), { home: w.home })).toBe(0);
    expect((await execute(w, b.json.target, [], undefined, store)).code).toBe(0);
  });

  test('a swapped owner-seat record is refused, and a missing store fails closed with the terminal answer still working', async () => {
    const { w, store } = await seated('seat-swap');
    const attacker = fakeStore();
    const forgedKey = attacker.create(ownerSignerLabel(w.home, 'floor', 'mac')) as { publicKey: string };
    const path = ownerSeatFile(w.home);
    const original = readFileSync(path, 'utf8');
    const swapped = JSON.parse(original);
    swapped.signers[0].public_key = forgedKey.publicKey;
    writeFileSync(path, JSON.stringify(swapped));
    const a = await requestOf(w, noScreen as never);
    // The attacker signs "oui" with its own key, matching the swapped record.
    expect(await approve(w, attacker, a.json.target, 'oui')).toBe(0);
    const forged = await execute(w, a.json.target, [], undefined, store);
    expect(forged.code).toBe(1);
    expect(forged.io.err()).toContain('does not match the key in the credential store');
    // Restored record but no credential store: fail closed.
    writeFileSync(path, original);
    const b = await requestOf(w, noScreen as never);
    expect(await approve(w, store, b.json.target, 'oui')).toBe(0);
    const unavailable = { ...store, available: () => false };
    const closed = await execute(w, b.json.target, [], undefined, unavailable);
    expect(closed.code).toBe(1);
    expect(closed.io.err()).toContain('cannot be verified');
    const missingKey = { ...store, publicKey: () => ({ ok: false as const, why: 'no key' }) };
    expect((await execute(w, b.json.target, [], undefined, missingKey)).code).toBe(1);
    expect((await execute(w, b.json.target, [], undefined, store)).code).toBe(0);
    const c = await requestOf(w, noScreen as never, ['--inbox']);
    expect(await runGrant(['--answer', c.json.target, 'oui'], ownerIo(w), { home: w.home })).toBe(0);
    expect((await execute(w, c.json.target, [], undefined, unavailable)).code).toBe(0);
  });
});

describe('the owner-seat prompt and the owner page grant card', () => {
  test('the Touch ID reason is the short prompt line; the terminal keeps the full list', async () => {
    const w = world('seat-fr');
    conversational(w);
    const store = fakeStore();
    const owner = { ...capture(w).io, caller: { kind: 'owner' } as Io['caller'] } as Io;
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], owner, { home: w.home, ownerSeatStore: store })).toBe(0);
    const r = await requestOf(w, { notify: () => false } as never);
    expect(r.code).toBe(0);
    const card = JSON.parse(readFileSync(join(ownerSeatInbox(w.home), `${r.json.target}.json`), 'utf8'));
    expect(card.summary.prompt).toStartWith('Allow Grok Bot (client grok-bot)');
    expect(card.summary.text).toContain('Grant for grok-bot');
    expect(await runGrant(['--approve-as-owner-seat', r.json.target, 'oui'], capture(w).io, { home: w.home, ownerSeatStore: store })).toBe(0);
    const reason = store.prompts[0]!;
    expect(reason).toStartWith('Allow Grok Bot (client grok-bot) on team floor');
    expect(reason).toContain('Signer: mac.');
    expect(reason).toContain('Expires ');
    expect(reason).not.toContain('is trying to');
    expect(reason.length).toBeLessThanOrEqual(210);
  });

  test('the owner page lists the pending grant with the prompt line and a passkey answer is verified by execute', async () => {
    const { serveOwnerPage } = await import('../src/security/owner-page.ts');
    const { addOwnerSigner } = await import('../src/client/owner-seat.ts');
    const { createHash } = await import('node:crypto');
    const w = world('seat-page');
    conversational(w);
    const store = fakeStore();
    const owner = { ...capture(w).io, caller: { kind: 'owner' } as Io['caller'] } as Io;
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], owner, { home: w.home, ownerSeatStore: store })).toBe(0);
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const credentialId = Buffer.from('iphone-credential-0001').toString('base64url');
    const added = addOwnerSigner(w.home, { signer: 'iphone', type: 'webauthn', publicKey: `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`, credentialId, rpId: 'localhost' }, store);
    expect(added.ok).toBe(true);
    const wrote = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac', 'iphone'] }, { now: new Date() });
    if (!wrote.ok) throw new Error(wrote.why);
    const page = await serveOwnerPage({ home: w.home, store, port: 0 });
    try {
      const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`http://localhost:${page.port}${path}?t=${page.token}`, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      expect((await call('GET', '/api/state')).body.requests).toEqual([]);
      const r = await requestOf(w, { notify: () => false } as never);
      const id = r.json.target as string;
      const requests = (await call('GET', '/api/state')).body.requests as Array<{ id: string; title: string; description: string; details?: string }>;
      expect(requests.map((x) => x.id)).toEqual([id]);
      expect(requests[0]!.description).toStartWith('Allow Grok Bot');
      expect(requests[0]!.description).toContain('Signer: iphone.');
      expect(requests[0]!.details).toContain('Grant for grok-bot');
      const ch = await call('POST', '/api/team-create/challenge', { id, word: 'oui', credentialId });
      expect(ch.status).toBe(200);
      const authData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 7])]);
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: String(ch.body.challenge), origin: 'http://localhost' }));
      const signature = cryptoSign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), { key: pair.privateKey, dsaEncoding: 'der' });
      const done = await call('POST', '/api/team-create/answer', { id, word: 'oui', credentialId, authenticatorData: authData.toString('base64url'), clientDataJSON: clientData.toString('base64url'), signature: signature.toString('base64url') });
      expect(done.status).toBe(200);
      expect((await call('GET', '/api/state')).body.requests).toEqual([]);
      const ran = await execute(w, id, [], undefined, store);
      expect(ran.code).toBe(0);
      expect(ran.io.out()).toContain('approved by: owner-seat');
    } finally {
      page.server.close();
    }
  });
});

describe('honest owner delivery: confirmed channels, Touch ID presence, one-request link', () => {
  const seated = async (w: World, store: OwnerSeatKeyStore) => {
    const owner = { ...capture(w).io, caller: { kind: 'owner' } as Io['caller'] } as Io;
    expect(await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], owner, { home: w.home, ownerSeatStore: store })).toBe(0);
  };
  const request = async (w: World, options: Record<string, unknown>, json = true) => {
    const io = capture(w);
    const code = await runGrant([...ask(w), ...(json ? ['--json'] : [])], io.io, { home: w.home, ...options });
    return { code, io, json: code === 0 && json ? JSON.parse(io.out()) : null };
  };

  test('a banner that exits cleanly but cannot confirm delivery is not marked shown; the link is printed', async () => {
    const { systemNotifier } = await import('../src/client/emission.ts');
    expect(systemNotifier.confirmsDelivery).toBe(false);
    const w = world('dropped');
    conversational(w);
    const calls: string[] = [];
    const dropped = Object.assign((_t: string, text: string) => { calls.push(text); return 'unconfirmed' as const; }, {});
    const r = await request(w, { notify: dropped, present: false });
    expect(r.code).toBe(0);
    expect(calls.length).toBe(1);
    expect(r.json.request.adapter).toBe('owner-answer');
    expect(r.json.notified.delivered).toBe(false);
    expect(r.json.choices.every((c: { needs_code: boolean }) => !c.needs_code)).toBe(true);
    expect(r.json.link).toMatch(new RegExp(`^http://localhost:7392/r/${r.json.target}#[A-Za-z0-9_-]{32}$`));
    // A notifier that says it can never confirm is not even sent a code.
    const blind = Object.assign(() => { calls.push('x'); return true; }, { confirmsDelivery: false });
    const r2 = await request(w, { notify: blind, present: false }, false);
    expect(calls.length).toBe(1);
    expect(r2.io.out()).toContain('owner NOT notified');
    expect(r2.io.out()).toMatch(/link: http:\/\/localhost:7392\/r\/gr_[0-9a-f]{24}#/);
    expect(r2.io.out()).not.toContain('owner notified via');
  });

  test('a confirmed screen code says notified via screen-code', async () => {
    const w = world('confirmed');
    conversational(w);
    const s = screen();
    const r = await request(w, { notify: s.notify, present: false });
    expect(r.json.notified).toEqual({ delivered: true, channel: 'screen-code', approved: false });
    expect(r.json.request.adapter).toBe('one-time-code');
  });

  test('Touch ID presence: a verified owner-seat signature is the approval; a cancelled prompt is not delivered', async () => {
    const w = world('presence');
    conversational(w);
    const store = fakeStore();
    await seated(w, store);
    const r = await request(w, { notify: () => false, ownerSeatStore: store });
    expect(r.json.notified).toEqual({ delivered: true, channel: 'touch-id', approved: true });
    expect(store.prompts.at(-1)).toStartWith('Allow Grok Bot');
    const done = await execute(w, r.json.target, [], undefined, store);
    expect(done.code).toBe(0);
    expect(done.io.out()).toContain('approved by: owner-seat');
    // Cancelled: the store refuses to sign. Nothing is recorded, the agent is told to relay the link.
    const cancelled: OwnerSeatKeyStore = { ...store, sign: () => ({ ok: false, why: 'the user-presence prompt was cancelled' }) };
    const c = await request(w, { notify: () => false, ownerSeatStore: cancelled });
    expect(c.json.notified.delivered).toBe(false);
    expect(c.json.notified.why).toContain('cancelled');
    expect(existsSync(join(grantRequestsFolder(w.home), `${c.json.target}.seat-answer.json`))).toBe(false);
    expect((await execute(w, c.json.target, [], undefined, store)).code).not.toBe(0);
  });

  test('a signature from any other key is never taken as the owner\'s, at request or at execute', async () => {
    const w = world('forged');
    conversational(w);
    const store = fakeStore();
    await seated(w, store);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forging: OwnerSeatKeyStore = { ...store, sign: (_l, message) => ({ ok: true, signature: cryptoSign('sha256', message, { key: other.privateKey, dsaEncoding: 'der' }).toString('hex') }) };
    const r = await request(w, { notify: () => false, ownerSeatStore: forging });
    expect(r.json.notified.delivered).toBe(false);
    expect((await execute(w, r.json.target, [], undefined, store)).code).not.toBe(0);
  });

  test('the link nonce: wrong, other-request, reused and expired are refused; it never approves', async () => {
    const { openRequestLink } = await import('../src/client/request-link.ts');
    const w = world('link');
    conversational(w);
    const a = await request(w, { notify: () => false, present: false });
    const b = await request(w, { notify: () => false, present: false });
    const nonceA = String(a.json.link).split('#')[1]!;
    const nonceB = String(b.json.link).split('#')[1]!;
    expect(openRequestLink(w.home, a.json.target, nonceB).ok).toBe(false);
    expect(openRequestLink(w.home, a.json.target, 'x'.repeat(32)).ok).toBe(false);
    expect(openRequestLink(w.home, b.json.target, nonceB, new Date(Date.now() + 16 * 60_000)).ok).toBe(false);
    expect(openRequestLink(w.home, a.json.target, nonceA).ok).toBe(true);
    expect(openRequestLink(w.home, a.json.target, nonceA).ok).toBe(false);
    expect(readdirSync(grantRequestsFolder(w.home)).some((f) => /answer/.test(f))).toBe(false);
    expect((await execute(w, a.json.target, [])).code).not.toBe(0);
  });

  test('the link page: no page token needed, one card, single open, session bound to its request, answer still needs the owner signature', async () => {
    const { serveOwnerPage } = await import('../src/security/owner-page.ts');
    const w = world('link-page');
    conversational(w);
    const store = fakeStore();
    await seated(w, store);
    const a = await request(w, { notify: () => false, present: false });
    const b = await request(w, { notify: () => false, present: false });
    const page = await serveOwnerPage({ home: w.home, store, port: 0 });
    try {
      const post = async (path: string, body: unknown) => {
        const res = await fetch(`http://localhost:${page.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      const id = a.json.target as string;
      const nonce = String(a.json.link).split('#')[1]!;
      expect((await fetch(`http://localhost:${page.port}/r/${id}`)).status).toBe(200);
      expect((await fetch(`http://localhost:${page.port}/api/state`)).status).toBe(403);
      expect((await post(`/api/r/${b.json.target}/open`, { nonce })).status).toBe(403);
      const opened = await post(`/api/r/${id}/open`, { nonce });
      expect(opened.status).toBe(200);
      expect((opened.body.request as { id: string }).id).toBe(id);
      expect((await post(`/api/r/${id}/open`, { nonce })).status).toBe(403);
      const session = String(opened.body.session);
      // The session does not reach the other request, and opening wrote no answer.
      expect((await post(`/api/r/${b.json.target}/touch-id`, { session, word: 'oui' })).status).toBe(403);
      expect(existsSync(join(grantRequestsFolder(w.home), `${id}.seat-answer.json`))).toBe(false);
      expect((await execute(w, id, [], undefined, store)).code).not.toBe(0);
      // The answer is made only by the owner signer's Touch ID signature, then verified by execute.
      const before = store.prompts.length;
      const signed = await post(`/api/r/${id}/touch-id`, { session, word: 'oui' });
      expect(signed.status).toBe(200);
      expect(store.prompts.length).toBe(before + 1);
      expect((await execute(w, id, [], undefined, store)).code).toBe(0);
    } finally {
      page.server.close();
    }
  });
});
