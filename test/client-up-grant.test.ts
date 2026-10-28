// The client `up` grant: the owner's durable, signed permission for one client (no terminal, not a
// seat) to run `team up` for ONE team at ONE folder. Request, owner-seat answer (a fake credential
// store stands in for Touch ID), execute, then the client's own `team up --client <grant> --key
// <key>` in an isolated HOME with a fake launch. The refusals hold the rest of the contract: wrong
// team, expired, revoked, tampered, a changed team file, another key, a send grant used for up, an
// up grant used for send, a sub-grant that tries to carry up. Synthetic homes only; no herdr.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { clientGrantPath, clientKeyDir, newClientKeyPair, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { LOG_FILE } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const made: string[] = [];
const realTmp = process.env.TMPDIR;
afterEach(() => {
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'ignore', env: gitEnv() });
}

function seat(name: string, role: string, extra: string[] = []): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra,
  ].join('\n');
}

/** A team file with no `entity:` — the shape of the real `docs` team — and a trust list the launch accepts. */
function teamText(project: string, base: string, root: string, home: string, extraSeat = '', extra = ''): string {
  return `format: 1
project: ${project}
coordinator: lead
operator: lead
session: ${project}
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seat('worker', 'implementer', ['    count: 1'])}
${extraSeat}${extra}`;
}

function repo(base: string, name: string, text: (root: string) => string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, `${name}-remote.git`));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), `${name}\n`);
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, '.agents', 'team.yaml'), text(root));
  return root;
}

function fakeStore(): OwnerSeatKeyStore & { prompts: string[] } {
  const keys = new Map<string, ReturnType<typeof generateKeyPairSync>>();
  const pins = new Map<string, string>();
  const prompts: string[] = [];
  const point = (pair: ReturnType<typeof generateKeyPairSync>) => {
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return `04${Buffer.from(jwk.x, 'base64url').toString('hex')}${Buffer.from(jwk.y, 'base64url').toString('hex')}`;
  };
  return {
    name: 'fake-credential-store', prompts,
    available: () => true,
    pinSet: (label, value) => (pins.has(label) ? { ok: false, why: 'exists' } : (pins.set(label, value), { ok: true })),
    pinGet: (label) => (pins.has(label) ? { ok: true, value: pins.get(label)! } : { ok: false, why: 'no pin' }),
    create: (label) => {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      keys.set(label, pair);
      return { ok: true, publicKey: point(pair) };
    },
    publicKey: (label) => {
      const pair = keys.get(label);
      return pair ? { ok: true, publicKey: point(pair) } : { ok: false, why: 'no key' };
    },
    sign: (label, message, reason) => {
      prompts.push(reason);
      const pair = keys.get(label);
      if (!pair) return { ok: false, why: 'no key' };
      return { ok: true, signature: cryptoSign('sha256', message, { key: pair.privateKey, dsaEncoding: 'der' }).toString('hex') };
    },
  };
}

function world() {
  // The world sits in the OS temp directory, outside every repository: a lobby inside one is refused.
  // A client key may not sit in the OS temp directory either, so for the length of the test the OS
  // temp directory is a different, empty folder.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'client-up-grant-')));
  made.push(base);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'client-up-scratch-')));
  made.push(scratch);
  process.env.TMPDIR = scratch;
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const docs = repo(base, 'docs', (root) => teamText('docs', base, root, home));
  const other = repo(base, 'other', (root) => teamText('other', base, root, home));
  const keys = (clientId: string) => {
    const pair = newClientKeyPair();
    const dir = clientKeyDir(home, clientId);
    const written = writeClientKeyFiles(dir, pair);
    if (!written.ok) throw new Error(written.why);
    return { pair, dir, keyPath: written.keyPath, pubPath: written.pubPath };
  };
  const grok = keys('grok-bot');
  const stranger = keys('acme-bot');
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name: 'grant-emission', value: 'conversational' }, { now: new Date() });
  if (!wrote.ok) throw new Error(wrote.why);
  const store = fakeStore();
  const w = { base, home, docs, other, grok, stranger, store, docsText: () => readFileSync(join(docs, '.agents', 'team.yaml'), 'utf8') };
  return w;
}
type World = ReturnType<typeof world>;

function capture(w: World, caller?: Caller): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const io: Io = { stdout: (t) => { out += t; }, stderr: (t) => { err += t; }, cwd: w.docs, env: {}, stdinIsTTY: false, ...(caller ? { caller } : {}) };
  return { io, out: () => out, err: () => err };
}

async function seated(w: World): Promise<void> {
  const code = await runGrant(['--add-owner-seat', '--team', 'floor', '--signer', 'mac'], capture(w, { kind: 'owner' }).io, { home: w.home, ownerSeatStore: w.store });
  expect(code).toBe(0);
}

const upFlags = (w: World, extra: string[] = []) => ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs', '--up', ...extra];

async function request(w: World, extra: string[] = [], now?: Date) {
  const c = capture(w);
  const code = await runGrant([...upFlags(w, ['--request', ...extra]), '--json'], c.io, { home: w.home, notify: () => false, ...(now ? { now } : {}) });
  const text = c.out().trim();
  return { code, out: c.out(), err: c.err(), json: text.startsWith('{') ? JSON.parse(text) : null };
}

const answer = (w: World, id: string, word: string) => {
  const c = capture(w);
  return runGrant(['--approve-as-owner-seat', id, word], c.io, { home: w.home, ownerSeatStore: w.store }).then((code) => ({ code, out: c.out(), err: c.err() }));
};

async function execute(w: World, id: string, now?: Date) {
  const c = capture(w);
  const code = await runGrant(['--execute', id], c.io, { home: w.home, ownerSeatStore: w.store, ...(now ? { now } : {}) });
  return { code, out: c.out(), err: c.err() };
}

/** request → owner-seat "oui" → execute; the grant's id and file. */
async function issued(w: World, extra: string[] = []) {
  await seated(w);
  const asked = await request(w, extra);
  expect(asked.code, asked.out + asked.err).toBe(0);
  const id = asked.json.target as string;
  expect((await answer(w, id, 'oui')).code).toBe(0);
  const done = await execute(w, id);
  expect(done.code, done.err).toBe(0);
  const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out)![1]!;
  return { requestId: id, grantId, path: clientGrantPath(w.home, grantId), done };
}

type UpRun = { code: number; out: string; err: string; workspaces: { label: string; cwd: string }[]; log: string };

/** A fake launch whose every effect is recorded: no herdr, no pane, no process. */
function sourcesOf(w: World, now: () => Date): { sources: UpSources; workspaces: { label: string; cwd: string }[] } {
  const workspaces: { label: string; cwd: string }[] = [];
  const panes = new Map<string, string>();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => session,
    startServer() { session = 'running'; return true; },
    sessionUp: () => session === 'running',
    createWorkspace(_s, cwd, label) {
      n += 1;
      workspaces.push({ label, cwd });
      panes.set(`made-${n}`, CLAUDE_IDLE);
      return { pane: `made-${n}`, workspace: `ws-${n}` };
    },
    paneRun(_s, pane) { panes.set(pane, CLAUDE_IDLE); return true; },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes.keys()],
    agents: () => [],
    paneText: (_s, pane) => panes.get(pane) ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now, home: w.home,
  };
  return {
    workspaces,
    sources: { sessionRunning: () => session === 'running', sessionState: () => session, agents: () => [], home: w.home, doctor, launch, now },
  };
}

async function clientUp(w: World, grantPath: string, keyPath: string, extra: string[] = [], at: { cwd?: string; now?: Date; caller?: Caller } = {}): Promise<UpRun> {
  const { sources, workspaces } = sourcesOf(w, () => at.now ?? new Date());
  const io = testIo(at.cwd ?? w.docs, at.caller ?? { kind: 'owner-no-tty' });
  const code = await runUp(['--client', grantPath, '--key', keyPath, ...extra], io, sources);
  const logPath = join(w.docs, '.agents', LOG_FILE);
  return { code, out: io.out, err: io.err, workspaces, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}

describe('request, owner-seat answer, execute, then the client brings the team up', () => {
  test('the grant binds one team and its folder, and the client launches it with no terminal and no prompt', async () => {
    const w = world();
    const g = await issued(w);
    expect(w.store.prompts).toHaveLength(1);
    expect(w.store.prompts[0]).toContain('start (up)');
    expect(w.store.prompts[0]).toContain('on team docs');
    const record = JSON.parse(readFileSync(g.path, 'utf8')).client_grant;
    expect(record).toMatchObject({ client_id: 'grok-bot', entity: 'floor', allowed_ops: ['up'], vocabulary: 4 });
    expect(record.up).toMatchObject({ project: 'docs', team_id: teamIdOf(w.docs), root: w.docs });
    expect(Object.keys(record.up.fingerprints.seats).sort()).toEqual(['lead', 'worker']);
    expect(record.recipient_seat).toBeUndefined();
    expect(record.allowed_roles).toBeUndefined();
    expect(record.grant_scope).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
    // Durable by default: ninety days, never the seven of a send grant.
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(90 * DAY);

    const run = await clientUp(w, g.path, w.grok.keyPath);
    expect(run.err).toContain('key isolation: enforced against team panes');
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.workspaces.map((one) => one.label)).toContain('lead');
    expect(run.workspaces.map((one) => one.label)).toContain('worker');
    expect(run.log).toContain(`client-up-authorized: grant ${g.grantId} client grok-bot team docs`);
    // Never a prompt: the launch ran in the no-terminal mode and no pause was read.
    expect(run.out).not.toContain('press');
  });

  test('the client runs from anywhere when it names the team; the dry run verifies, plans and writes nothing', async () => {
    const w = world();
    const g = await issued(w);
    const run = await clientUp(w, g.path, w.grok.keyPath, ['--team', 'docs', '--dry-run'], { cwd: w.base });
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.out).toContain('dry run: nothing was run');
    expect(run.workspaces).toEqual([]);
    expect(run.log).not.toContain('client-up-authorized');
    const wrongKey = await clientUp(w, g.path, w.stranger.keyPath, ['--dry-run']);
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.workspaces).toEqual([]);
  });

  test('a comment or a prompt edit in the team file does not need a new signature; the grant keeps working', async () => {
    const w = world();
    const g = await issued(w);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), `# a note the owner added later\n${w.docsText()}`);
    const run = await clientUp(w, g.path, w.grok.keyPath, ['--dry-run']);
    expect(run.code, run.err + run.out).toBe(0);
  });

  test('--expires sets the length, capped at ninety days', async () => {
    const w = world();
    await seated(w);
    const long = await request(w, ['--expires', new Date(Date.now() + 91 * DAY).toISOString()]);
    expect(long.code).toBe(1);
    expect(long.json.error.message).toContain('90 days');
    const short = await request(w, ['--expires', new Date(Date.now() + 30 * DAY).toISOString()]);
    expect(short.code).toBe(0);
    expect(short.json.summary.ops).toEqual(['up']);
    expect(short.json.summary.text).toContain(w.docs);
  });

  test('the owner at a terminal can still issue it directly, without a request', async () => {
    const w = world();
    const c = capture(w, { kind: 'owner' });
    expect(await runGrant(upFlags(w), c.io, { home: w.home })).toBe(0);
    const refused = capture(w);
    expect(await runGrant(upFlags(w), refused.io, { home: w.home })).toBe(1);
    expect(refused.err()).toContain('only the owner runs this');
    const id = /client grant: (cg_[0-9a-f]{24})/.exec(c.out())![1]!;
    expect((await clientUp(w, clientGrantPath(w.home, id), w.grok.keyPath, ['--dry-run'])).code).toBe(0);
  });
});

describe('the grant is for one team and one folder, and for nothing else', () => {
  test('another team, another folder, a name that is not the grant\'s: refused, with the next step', async () => {
    const w = world();
    const g = await issued(w);
    const elsewhere = await clientUp(w, g.path, w.grok.keyPath, [], { cwd: w.other });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(`for team "docs" at ${w.docs}`);
    expect(elsewhere.err).toContain('--team docs');
    expect(elsewhere.workspaces).toEqual([]);
    const named = await clientUp(w, g.path, w.grok.keyPath, ['--team', 'other'], { cwd: w.other });
    expect(named.code).toBe(1);
    expect(named.err).toContain('"other"');
    expect(named.workspaces).toEqual([]);
    const lost = await clientUp(w, g.path, w.grok.keyPath, [], { cwd: w.base });
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('--team docs');
  });

  test('a copy of the team in another folder with the same name is not the folder the owner signed', async () => {
    const w = world();
    const g = await issued(w);
    const twin = repo(w.base, 'docs-twin', (root) => teamText('docs', w.base, root, w.home));
    const run = await clientUp(w, g.path, w.grok.keyPath, ['--team', 'docs'], { cwd: twin });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`at ${w.docs}`);
    expect(run.workspaces).toEqual([]);
  });

  test('a team of another entity cannot be bound under this entity; the registry record is read, not assumed', async () => {
    const w = world();
    await seated(w);
    const teamId = teamIdOf(w.docs);
    upsertTeam(w.home, teamId, { project: 'docs', entity: 'other-entity', session: 'docs', root: w.docs, lobby: join(w.home, '.config', 'team', 'lobby'), roster: [], lifecycle: 'running' });
    const asked = await request(w);
    expect(asked.code).toBe(1);
    expect(asked.json.error.message).toContain('other-entity');
  });

  test('an up grant is never asked with a seat, an inbox, grant, or without the team', async () => {
    const w = world();
    const probe = async (extra: string[], drop?: string) => {
      const c = capture(w);
      const argv = upFlags(w, ['--request', ...extra]).filter((word, i, all) => drop === undefined || (word !== drop && all[i - 1] !== drop));
      return { code: await runGrant(argv, c.io, { home: w.home, notify: () => false }), err: c.err() };
    };
    for (const extra of [['--seat', 'orchestrator'], ['--inbox'], ['--allow-grant'], ['--grant-team', 'docs']]) {
      const r = await probe(extra);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.err).toContain('--up');
    }
    const noTeam = await probe([], '--team');
    expect(noTeam.code).toBe(2);
    expect(noTeam.err).toContain('--team');
  });

  test('an up grant is never approved "always": it is already durable', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w);
    const always = await answer(w, asked.json.target, 'always');
    expect(always.code).toBe(1);
    expect(always.err).toContain('never approved always');
    expect(readdirSync(join(w.home, '.config', 'team', 'grants')).filter((n) => n.startsWith('cg_'))).toHaveLength(0);
  });
});

describe('the grant fails closed', () => {
  test('expired: refused, with the exact command that renews it', async () => {
    const w = world();
    const g = await issued(w, ['--expires', new Date(Date.now() + 10 * 60_000).toISOString()]);
    const run = await clientUp(w, g.path, w.grok.keyPath, [], { now: new Date(Date.now() + 20 * 60_000) });
    expect(run.code).toBe(1);
    expect(run.err).toContain('expired');
    expect(run.err).toContain(`team grant --client grok-bot --entity floor --public-key ${w.grok.pubPath} --team docs --up --request`);
    expect(run.workspaces).toEqual([]);
  });

  test('revoked: the owner revokes it at any time, and the next run is refused', async () => {
    const w = world();
    const g = await issued(w);
    expect((await clientUp(w, g.path, w.grok.keyPath, ['--dry-run'])).code).toBe(0);
    const stranger = capture(w);
    expect(await runRevoke([g.grantId], stranger.io, { home: w.home })).toBe(1);
    const owner = capture(w, { kind: 'owner' });
    expect(await runRevoke([g.grantId], owner.io, { home: w.home })).toBe(0);
    expect(owner.out()).toContain(`client grant revoked: ${g.grantId}`);
    const run = await clientUp(w, g.path, w.grok.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('revoked');
    expect(run.err).toContain('--up --request');
    expect(run.workspaces).toEqual([]);
    expect(run.log).toContain(`client-up-refused: grant ${g.grantId}`);
  });

  test('tampered: a grant file edited after the owner signed it verifies as nothing', async () => {
    const w = world();
    const g = await issued(w);
    const file = JSON.parse(readFileSync(g.path, 'utf8'));
    file.client_grant.expires = new Date(Date.now() + 900 * DAY).toISOString();
    const forged = join(w.base, 'forged.json');
    writeFileSync(forged, JSON.stringify(file));
    const edited = await clientUp(w, forged, w.grok.keyPath);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain('not a verified owner-signed up grant');
    const root = JSON.parse(readFileSync(g.path, 'utf8'));
    root.client_grant.up.root = w.other;
    writeFileSync(forged, JSON.stringify(root));
    const moved = await clientUp(w, forged, w.grok.keyPath, [], { cwd: w.other });
    expect(moved.code).toBe(1);
    expect(moved.err).toContain('not a verified owner-signed up grant');
    expect(moved.workspaces).toEqual([]);
  });

  test('changed team file: a new seat, a changed seat or an owner section needs a new signature, and the refusal says how', async () => {
    const w = world();
    const g = await issued(w);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, `${seat('intruder', 'implementer')}\n`));
    const run = await clientUp(w, g.path, w.grok.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('changed since the owner signed');
    expect(run.err).toContain('seat intruder is not in the last approval');
    expect(run.err).toContain(`team grant --client grok-bot --entity floor --public-key ${w.grok.pubPath} --team docs --up --request`);
    expect(run.workspaces).toEqual([]);
    expect(run.log).toContain('client-up-refused');
    expect(run.log).toContain('intruder');
    // The owner re-signs, and the client runs again.
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, '', 'tempo: urgent\n'));
    const trust = await clientUp(w, g.path, w.grok.keyPath, ['--dry-run']);
    expect(trust.code).toBe(1);
    expect(trust.err).toContain('`tempo` changed');
  });

  test('a team file that drifted between the request and the answer is refused at execute, and the request is not spent', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w);
    expect((await answer(w, asked.json.target, 'oui')).code).toBe(0);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, `${seat('late', 'implementer')}\n`));
    const done = await execute(w, asked.json.target);
    expect(done.code).toBe(1);
    expect(done.err).toContain('changed since the request');
    expect(done.err).toContain('is not spent');
    expect(readdirSync(join(w.home, '.config', 'team', 'grants')).filter((n) => n.startsWith('cg_'))).toHaveLength(0);
  });

  test('another client key: refused even with the real grant file', async () => {
    const w = world();
    const g = await issued(w);
    const run = await clientUp(w, g.path, w.stranger.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('not the app key the grant');
    expect(run.workspaces).toEqual([]);
  });

  test('a send grant opens no up, and an up grant opens no send', async () => {
    const w = world();
    // A floor coordinator and a send grant, as the shipped slice has them.
    const floor = repo(w.base, 'floor', (root) => `format: 1\nproject: floor\nentity: floor\ncoordinator: orchestrator\noperator: orchestrator\nsession: acme\nworkspace:\n  mode: shared\nseats:\n${seat('orchestrator', 'coordinator', ['    leads: true'])}\n`);
    const floorId = teamIdOf(floor);
    const orch = registerAgent(w.home, {
      name: 'orchestrator', signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
      reach: { team: floorId, seat: 'orchestrator', session: 'acme', pane: 'w1:p1', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
    });
    upsertTeam(w.home, floorId, { project: 'floor', entity: 'floor', session: 'acme', root: floor, lobby: join(w.base, 'lobby'), roster: [{ agent: orch.id, seat: 'orchestrator', role: 'orchestrator', leads: true }], lifecycle: 'running' });
    const sendGrant = writeClientGrant(w.home, { clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir }, { key: keyOf(w.home) });
    if (!sendGrant.ok) throw new Error(sendGrant.why);
    const asUp = await clientUp(w, sendGrant.path, w.grok.keyPath);
    expect(asUp.code).toBe(1);
    expect(asUp.err).toContain('is not an up grant');
    expect(asUp.err).toContain('--up --request');
    expect(asUp.workspaces).toEqual([]);

    const g = await issued(w);
    const io = testIo(floor, { kind: 'owner' });
    const host = { home: w.home, now: () => new Date(), sendId: () => '00000001-1111-4111-8111-111111111111' } as unknown as SendHost;
    const code = await runSend(['--client', g.path, '--key', w.grok.keyPath, 'orchestrator@floor', 'hello'], io, host);
    expect(code).toBe(1);
    expect(io.err).toContain('up grant');
    expect(io.err).toContain('team up --client');
  });

  test('a sub-grant can never carry up: not by --client-request, not through an up grant used as master', async () => {
    const w = world();
    const g = await issued(w);
    const viaUp = capture(w);
    const closed = await runGrant(['--client-request', '--via', g.path, '--key', w.grok.keyPath, ...upFlags(w).slice(0, -1).concat('--up')], viaUp.io, { home: w.home });
    expect(closed).toBe(2);
    expect(viaUp.err()).toContain('--up');
    const asMaster = capture(w);
    const code = await runGrant(['--client-request', '--via', g.path, '--key', w.grok.keyPath, '--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs'], asMaster.io, { home: w.home });
    expect(code).toBe(1);
    expect(asMaster.err()).toContain('up grant');
  });
});

describe('nothing else about `team up` changed', () => {
  test('without --client, a caller with no terminal is still refused, grant or no grant', async () => {
    const w = world();
    await issued(w);
    const { sources, workspaces } = sourcesOf(w, () => new Date());
    const io = testIo(w.docs, { kind: 'owner-no-tty' });
    const code = await runUp([], io, sources);
    expect(code).toBe(1);
    expect(io.err + io.out).toContain('only the owner or a `leads` seat runs this');
    expect(workspaces).toEqual([]);
  });

  test('--client takes no --file and no --session, and needs --key', async () => {
    const w = world();
    const g = await issued(w);
    for (const extra of [['--file', 'other.yaml'], ['--session', 'elsewhere']]) {
      const run = await clientUp(w, g.path, w.grok.keyPath, extra);
      expect(run.code, extra.join(' ')).toBe(2);
      expect(run.err).toContain('--client');
    }
    const { sources } = sourcesOf(w, () => new Date());
    const io = testIo(w.docs, { kind: 'owner-no-tty' });
    expect(await runUp(['--client', g.path], io, sources)).toBe(2);
    expect(io.err).toContain('--key');
    const lone = testIo(w.docs, { kind: 'owner-no-tty' });
    expect(await runUp(['--key', w.grok.keyPath], lone, sources)).toBe(2);
    expect(lone.err).toContain('--client');
  });
});
