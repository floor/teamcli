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
import { ownerSeatAnswerBytes, ownerSeatFile, ownerSeatInbox, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
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
    const signers = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'owner-signers', value: ['mac'] }, { now: new Date() });
    if (!signers.ok) throw new Error(signers.why);
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
    const forgedKey = attacker.create('owner-floor-mac') as { publicKey: string };
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
