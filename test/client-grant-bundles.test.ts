// Client grant bundles: one owner-signed grant that carries a named, fixed list of commands (an
// `observer` or an `operator` bundle) for ONE team at ONE folder. The record stores the explicit
// ops the owner signed, the bundle's name is only a label, and the commands that change who may do
// what are structurally ineligible. Synthetic homes only: a fake credential store stands in for
// Touch ID, a fake launch and a fake herdr stand in for the machine; no real team is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import {
  BUNDLE_ELIGIBLE_OPS,
  BUNDLE_FORBIDDEN_COMMANDS,
  BUNDLE_HARD_MAX_DAYS,
  DEFAULT_BUNDLE_SPECS,
  OBSERVER_DEFAULT_OPS,
  OPERATOR_DEFAULT_OPS,
  bundlePolicyWithin,
  canonicalBundleOps,
  isEligibleBundleOp,
  isForbiddenBundleCommand,
  parseBundlePolicy,
} from '../src/client/bundle-ops.ts';
import { bundleCard, bundleSpecsInForce, expandBundle } from '../src/client/bundles.ts';
import {
  CLIENT_BUNDLE_VOCABULARY_VERSION,
  CLIENT_GRANT_DOMAIN,
  clientGrantPath,
  clientGrantsFolder,
  clientKeyDir,
  newClientKeyPair,
  planClientBundleGrant,
  readClientGrant,
  readClientGrantFile,
  readClientUpGrant,
  writeClientBundleGrant,
  writeClientGrant,
  writeClientKeyFiles,
  writeClientUpGrant,
} from '../src/client/records.ts';
import { verifyClientUp } from '../src/client/up-grant.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

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
${seat('orchestrator', 'implementer', [])}
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'client-grant-bundles-')));
  made.push(base);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'client-bundles-scratch-')));
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
  // The docs team is registered with an orchestrator seat a client may be sent to.
  const docsId = teamIdOf(docs);
  const orch = registerAgent(home, {
    name: 'orchestrator', signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: docsId, seat: 'orchestrator', session: 'docs', pane: 'w1:p1', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  const lead = registerAgent(home, {
    name: 'lead', signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
    reach: { team: docsId, seat: 'lead', session: 'docs', pane: 'w1:p0', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
  upsertTeam(home, docsId, {
    project: 'docs', entity: null, session: 'docs', root: docs, lobby: join(home, '.config', 'team', 'lobby'), lifecycle: 'running',
    roster: [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }, { agent: orch.id, seat: 'orchestrator', role: 'implementer' }],
  });
  const w = { base, home, docs, docsId, other, grok, stranger, store, docsText: () => readFileSync(join(docs, '.agents', 'team.yaml'), 'utf8') };
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

const bundleFlags = (w: World, bundle: string, extra: string[] = []) => ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs', '--bundle', bundle, ...extra];

async function request(w: World, bundle: string, extra: string[] = [], now?: Date) {
  const c = capture(w);
  const code = await runGrant([...bundleFlags(w, bundle, ['--request', ...extra]), '--json'], c.io, { home: w.home, notify: () => false, ...(now ? { now } : {}) });
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
async function issued(w: World, bundle: string, extra: string[] = []) {
  await seated(w);
  const asked = await request(w, bundle, extra);
  expect(asked.code, asked.out + asked.err).toBe(0);
  const id = asked.json.target as string;
  expect((await answer(w, id, 'oui')).code).toBe(0);
  const done = await execute(w, id);
  expect(done.code, done.err).toBe(0);
  const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out)![1]!;
  return { requestId: id, grantId, path: clientGrantPath(w.home, grantId), done };
}


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


type DownRun = { code: number; out: string; err: string; closed: string[]; stopped: string[]; typed: string[]; log: string };

/** Never a real session: herdr answers from a fake whose one live seat, `lead`, closes when the exit text is typed. */
function downSourcesOf(w: World, now: () => Date, running = true): { sources: DownSources; closed: string[]; stopped: string[]; typed: string[] } {
  const closed: string[] = [];
  const stopped: string[] = [];
  const typed: string[] = [];
  let box = claudeBox('');
  let live = running;
  const people = (): HerdrAgent[] => (live ? [{ name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null }] : []);
  const launch: DownLaunch = {
    typeText(_session, _pane, text) { typed.push(text); box = claudeBox(text); return true; },
    sendKey: () => true,
    pressEnter() { live = false; return true; },
    agentPanes: () => people().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) { closed.push(workspace); return true; },
    stopSession(session) { stopped.push(session); return true; },
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now,
  };
  return {
    closed, stopped, typed,
    sources: {
      sessionRunning: () => running,
      agents: people,
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => box,
      status: () => 'idle',
      foreground: () => (live ? ['claude'] : ['zsh']),
      now,
      home: w.home,
      standing: () => ({ kind: 'none' }),
      launch,
    },
  };
}

/** The state `up` left: the team's session recorded with `lead` running in its pane. */
function teamRunning(w: World): void {
  updateState(join(w.docs, '.agents'), (file) => {
    file.sessions.docs = { ...emptySession(), seats: { lead: { stage: 'ready' as const, pane: 'lead-pane', workspace: 'lead-ws' } } };
  });
}

async function clientDown(w: World, grantPath: string, keyPath: string, extra: string[] = [], at: { cwd?: string; now?: Date; caller?: Caller; running?: boolean } = {}): Promise<DownRun> {
  const { sources, closed, stopped, typed } = downSourcesOf(w, () => at.now ?? new Date(), at.running ?? true);
  const io = testIo(at.cwd ?? w.docs, at.caller ?? { kind: 'owner-no-tty' });
  const code = await runDown(['--client', grantPath, '--key', keyPath, ...extra], io, sources);
  const logPath = join(w.docs, '.agents', LOG_FILE);
  return { code, out: io.out, err: io.err, closed, stopped, typed, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}


const NEVER_LIVE = { running: false, agents: [], workspaces: [], screens: {} };

type StatusRun = { code: number; out: string; err: string; log: string };

/** `team status --client`: no herdr, no pane; the team's own log is read back for the audit line. */
async function clientStatus(w: World, grantPath: string, keyPath: string, extra: string[] = [], at: { cwd?: string; now?: Date; caller?: Caller } = {}): Promise<StatusRun> {
  const sources: StatusSources = { live: () => NEVER_LIVE, branch: () => 'main', standing: () => ({ kind: 'none' }), now: () => at.now ?? new Date(), home: w.home };
  const io = testIo(at.cwd ?? w.docs, at.caller ?? { kind: 'owner-no-tty' });
  const code = await runStatus(['--client', grantPath, '--key', keyPath, ...extra], io, sources);
  const logPath = join(w.docs, '.agents', LOG_FILE);
  return { code, out: io.out, err: io.err, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}

let dropCounter = 0;

/** `team send --client <bundle> --key <key> <address> <text>`: one signed drop, or a refusal. */
async function clientSend(w: World, grantPath: string, keyPath: string, address: string, text: string, at: { cwd?: string; now?: Date; extra?: string[] } = {}) {
  dropCounter += 1;
  const io = testIo(at.cwd ?? w.docs, { kind: 'owner' });
  const sendId = () => `0000${String(dropCounter).padStart(4, '0')}-1111-4111-8111-111111111111`;
  const host = { home: w.home, now: () => at.now ?? new Date(), sendId } as unknown as SendHost;
  const code = await runSend(['--client', grantPath, '--key', keyPath, ...(at.extra ?? []), address, text], io, host);
  const logPath = join(w.docs, '.agents', LOG_FILE);
  return { code, out: io.out, err: io.err, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
}

const dropsOf = (w: World, seatName: string): string[] => {
  const folder = join(w.docs, '.agents', 'send-drops', 'docs', seatName);
  return existsSync(folder) ? readdirSync(folder) : [];
};

const recordOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')).client_grant;

/** The commands the invariant forbids, spelled exactly as the validated design lists them. */
const DESIGN_FORBIDDEN = [
  'grant', 'revoke', 'delegate', 'init', 'owner-seat', 'policy set', 'policy unset', 'settings set', 'settings unset',
  'development-mode set', 'add', 'remove', 'rename', 'swap', 'answer', 'tempo', 'broker', 'bus', 'daemon', 'register', 'queue',
  'hold', 'worktree', 'raise', 'client keygen', 'pause', 'resume',
];

describe('a bundle is a named, fixed list of commands; the record carries the explicit list', () => {
  test('the release defaults expand into explicit ops in one canonical order', () => {
    expect([...OBSERVER_DEFAULT_OPS]).toEqual(['status', 'list', 'check', 'feed', 'messages']);
    expect([...OPERATOR_DEFAULT_OPS]).toEqual([...OBSERVER_DEFAULT_OPS, 'send', 'up', 'down']);
    expect(DEFAULT_BUNDLE_SPECS.operator.ops).toEqual(OPERATOR_DEFAULT_OPS as never);
    const home = '/nonexistent-home-never-read';
    const operator = expandBundle(home, 'operator', 'floor', null);
    expect(operator.ok && operator.ops).toEqual([...OPERATOR_DEFAULT_OPS]);
    expect(operator.ok && operator.expiryDays).toBe(BUNDLE_HARD_MAX_DAYS);
    expect(canonicalBundleOps(['down', 'status', 'up'])).toEqual(['status', 'up', 'down']);
    expect(canonicalBundleOps([])).toBeNull();
  });

  test('the owner card says what the client may do, in order, and what it can never do', () => {
    const card = bundleCard({ clientId: 'grok-bot', project: 'docs', ops: ['status', 'send', 'up', 'down'], seats: ['orchestrator'], expires: '2027-01-21T09:00:00.000Z', fileFingerprint: 'abc123def456' });
    expect(card).toBe('Grok Bot may, for team docs until 2027-01-21 09:00 UTC: see status, send to orchestrator, start (file abc123def456), stop. It cannot change permissions, add or remove seats, or create teams.');
    const observer = bundleCard({ clientId: 'grok-bot', project: 'docs', ops: ['status'], seats: [], expires: '2027-01-21T09:00:00.000Z' });
    expect(observer).not.toContain('start');
    expect(observer).not.toContain('send');
  });
});

describe('the commands that change who may do what are ineligible by construction', () => {
  test('no forbidden command is eligible, and the eligible list and the forbidden list never meet', () => {
    for (const name of DESIGN_FORBIDDEN) {
      expect(isForbiddenBundleCommand(name), name).toBe(true);
      expect(isEligibleBundleOp(name), name).toBe(false);
      expect(isEligibleBundleOp(name.replace(/ /g, '-')), name).toBe(false);
      expect(canonicalBundleOps(['status', name]), name).toBeNull();
    }
    for (const name of BUNDLE_ELIGIBLE_OPS) expect(isForbiddenBundleCommand(name), name).toBe(false);
    for (const name of BUNDLE_FORBIDDEN_COMMANDS) expect((BUNDLE_ELIGIBLE_OPS as readonly string[]).includes(name), name).toBe(false);
    // The design's whole list is covered by the constant (it may name more, never fewer).
    for (const name of DESIGN_FORBIDDEN) expect(BUNDLE_FORBIDDEN_COMMANDS.includes(name.replace(/ /g, '-')), name).toBe(true);
  });

  test('a policy cannot put one in a bundle, and a bundle policy can only choose among eligible ops', () => {
    for (const name of DESIGN_FORBIDDEN) {
      const parsed = parseBundlePolicy(`operator=status,${name.replace(/ /g, '-')}`);
      expect(parsed.ok, name).toBe(false);
    }
    expect(parseBundlePolicy('operator=status,frobnicate').ok).toBe(false);
    expect(parseBundlePolicy('operator=status;operator=down').ok).toBe(false);
    expect(parseBundlePolicy('admin=status').ok).toBe(false);
    expect(parseBundlePolicy('operator=status@91d').ok).toBe(false);
    expect(parseBundlePolicy('operator=status,down@30d;observer=status')).toMatchObject({ ok: true });
  });

  test('the planner refuses a forbidden op even when it is handed one by hand', () => {
    const w = world();
    for (const name of DESIGN_FORBIDDEN) {
      const plan = planClientBundleGrant(w.home, {
        clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir,
        bundle: 'operator', ops: ['status', name.replace(/ /g, '-')], up: { project: 'docs', teamId: w.docsId, root: w.docs, fingerprints: { sections: {}, seats: {} } },
      });
      expect(plan.ok, name).toBe(false);
      if (!plan.ok) expect(plan.why).toContain('can never be in a bundle');
    }
  });

  test('a hand-built record that lists a forbidden op is nothing, even carrying a real owner signature', () => {
    const w = world();
    const base = (ops: string[], extra: Record<string, unknown> = {}) => ({
      grant_id: `cg_${'a'.repeat(24)}`, client_id: 'grok-bot', entity: 'floor', public_key: w.grok.pair.publicKey, key_id: w.grok.pair.keyId, key_dir: w.grok.dir,
      bundle: 'operator', allowed_ops: ops, seats: ops.includes('send') ? ['orchestrator'] : [],
      issued: new Date().toISOString(), expires: new Date(Date.now() + DAY).toISOString(), vocabulary: 5,
      team: { project: 'docs', team_id: w.docsId, root: w.docs, ...(ops.includes('up') ? { fingerprints: { sections: {}, seats: { lead: 'a'.repeat(64) } } } : {}) },
      ...extra,
    });
    const sign = (grant: Record<string, unknown>, grantId = grant.grant_id as string) => {
      const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: grantId, client_grant: grant as never }, keyOf(w.home));
      const path = clientGrantPath(w.home, grantId);
      mkdirSync(clientGrantsFolder(w.home), { recursive: true });
      writeFileSync(path, JSON.stringify({ client_grant: grant, signature }));
      return path;
    };
    // The record is accepted when it is whole: the same builder with no forbidden op reads.
    const fine = sign(base(['status', 'send', 'up', 'down']));
    expect(readClientUpGrantOf(w, fine).ok, readClientUpGrantOf(w, fine).ok ? '' : (readClientUpGrantOf(w, fine) as { why: string }).why).toBe(true);
    for (const name of DESIGN_FORBIDDEN) {
      for (const spelled of [name, name.replace(/ /g, '-')]) {
        const path = sign(base(['status', spelled]), `cg_${'b'.repeat(24)}`);
        expect(readClientUpGrantOf(w, path).ok, spelled).toBe(false);
        // …and no route reads it as another vocabulary.
        expect(readClientGrantFile(w.home, path).ok, spelled).toBe(false);
      }
    }
    // Unknown fields, a missing field and an out-of-order list are not records this build wrote.
    expect(readClientUpGrantOf(w, sign(base(['status'], { extra: 'x' }), `cg_${'c'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['down', 'status']), `cg_${'d'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['status', 'status']), `cg_${'e'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base([]), `cg_${'f'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['send'], { seats: [] }), `cg_${'1'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['status'], { seats: ['orchestrator'] }), `cg_${'2'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['status'], { bundle: 'admin' }), `cg_${'3'.repeat(24)}`)).ok).toBe(false);
    expect(readClientUpGrantOf(w, sign(base(['status'], { expires: new Date(Date.now() + 91 * DAY).toISOString() }), `cg_${'4'.repeat(24)}`)).ok).toBe(false);
  });
});

function readClientUpGrantOf(w: World, path: string) {
  return readClientUpGrant(w.home, /cg_[0-9a-f]{24}/.exec(path)![0]);
}

describe('request, owner-seat answer (one Touch ID), execute: the operator bundle', () => {
  test('one signature covers the whole operator list for one team; the record says exactly what was signed', async () => {
    const w = world();
    const g = await issued(w, 'operator', ['--seat', 'orchestrator']);
    // ONE owner signature, whose text is the card.
    expect(w.store.prompts).toHaveLength(1);
    expect(w.store.prompts[0]).toContain('Grok Bot may, for team docs until');
    expect(w.store.prompts[0]).toContain('see status');
    expect(w.store.prompts[0]).toContain('send to orchestrator');
    expect(w.store.prompts[0]).toMatch(/start \(file [0-9a-f]{12}\)/);
    expect(w.store.prompts[0]).toContain('stop');
    expect(w.store.prompts[0]).toContain('It cannot change permissions, add or remove seats, or create teams.');
    const record = recordOf(g.path);
    expect(record).toMatchObject({ client_id: 'grok-bot', entity: 'floor', bundle: 'operator', vocabulary: CLIENT_BUNDLE_VOCABULARY_VERSION, seats: ['orchestrator'] });
    expect(record.allowed_ops).toEqual([...OPERATOR_DEFAULT_OPS]);
    // The binding: one team by name, registry id (sha256 of the real root, twelve hex) and real root.
    expect(record.team).toMatchObject({ project: 'docs', team_id: teamIdOf(w.docs), root: w.docs });
    expect(record.team_id).toBeUndefined();
    expect(Object.keys(record.team.fingerprints.seats).sort()).toEqual(['lead', 'orchestrator', 'worker']);
    expect(record.key_id).toBe(w.grok.pair.keyId);
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(BUNDLE_HARD_MAX_DAYS * DAY);
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
    // Read back through the one reader: explicit ops decide.
    const read = readClientUpGrant(w.home, g.grantId);
    expect(read.ok && read.grant.ops).toEqual([...OPERATOR_DEFAULT_OPS]);
    expect(read.ok && read.grant.bundle).toBe('operator');
  });

  test('the observer bundle signs no file fingerprints (it never starts the team) and no seats', async () => {
    const w = world();
    const g = await issued(w, 'observer');
    const record = recordOf(g.path);
    expect(record.bundle).toBe('observer');
    expect(record.allowed_ops).toEqual([...OBSERVER_DEFAULT_OPS]);
    expect(record.seats).toEqual([]);
    expect(Object.keys(record.team).sort()).toEqual(['project', 'root', 'team_id']);
    expect(w.store.prompts[0]).not.toContain('start');
    expect(w.store.prompts[0]).not.toContain('send to');
  });

  test('the request defaults the seats to those the team admits and its roster holds; none open refuses with the next step', async () => {
    const w = world();
    await seated(w);
    // The default reach is the orchestrator, which the docs team's roster holds.
    const ok = await request(w, 'operator');
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.json.summary.text).toContain('send to orchestrator');
    expect(ok.json.summary.ops).toEqual([...OPERATOR_DEFAULT_OPS]);
    // A seat the team does not admit, the operator seat, and a seat that does not exist: refused.
    for (const seatName of ['worker', 'lead', 'ghost']) {
      const refused = await request(w, 'operator', ['--seat', seatName]);
      expect(refused.code, seatName).toBe(1);
      expect(refused.json.error.message, seatName).toContain(seatName);
    }
    const mixed = await request(w, 'observer', ['--seat', 'orchestrator']);
    expect(mixed.code).toBe(1);
    expect(mixed.json.error.message).toContain('does not carry send');
  });

  test('a bundle is never approved always, and only the owner answers; the requester cannot', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w, 'operator');
    expect(asked.code, asked.out + asked.err).toBe(0);
    expect(asked.json.choices.map((choice: { id: string }) => choice.id)).toEqual(['once', 'deny']);
    const id = asked.json.target as string;
    const always = await answer(w, id, 'always');
    expect(always.code).toBe(1);
    expect(always.err).toContain('never approved always');
    // The requester's own seat: no terminal, no owner. `--answer` and the unattended execute both refuse.
    const noOwner = capture(w);
    expect(await runGrant(['--answer', id, 'oui'], noOwner.io, { home: w.home })).toBe(1);
    expect(noOwner.err()).toContain('only the owner runs this');
    const unanswered = await execute(w, id);
    expect(unanswered.code).toBe(1);
    expect(readdirSync(clientGrantsFolder(w.home)).filter((name) => name.startsWith('cg_'))).toEqual([]);
  });

  test('the bundle flag excludes the one-op flags, a sub-grant, and the master flags', async () => {
    const w = world();
    for (const [extra, fragment] of [
      [['--up'], 'two forms'],
      [['--down'], 'two forms'],
      [['--inbox'], 'takes no --inbox'],
      [['--allow-grant'], 'never carries grant'],
      [['--client-request', '--via', 'x', '--key', w.grok.keyPath], 'sub-grant'],
    ] as const) {
      const c = capture(w, { kind: 'owner' });
      expect(await runGrant(bundleFlags(w, 'operator', [...extra]), c.io, { home: w.home }), extra.join(' ')).toBe(2);
      expect(c.err(), extra.join(' ')).toContain(fragment);
    }
    const unknown = capture(w, { kind: 'owner' });
    expect(await runGrant(bundleFlags(w, 'admin'), unknown.io, { home: w.home })).toBe(2);
    expect(unknown.err()).toContain('observer or operator');
    const bare = capture(w, { kind: 'owner' });
    expect(await runGrant(['team-less', '--bundle', 'operator', '--scope', 'x'], bare.io, { home: w.home })).toBe(2);
    expect(bare.err()).toContain('--bundle belongs to the --client form');
  });

  test('the owner at a terminal can still issue a bundle directly, and no one else can', async () => {
    const w = world();
    const owner = capture(w, { kind: 'owner' });
    expect(await runGrant(bundleFlags(w, 'operator', ['--seat', 'orchestrator']), owner.io, { home: w.home })).toBe(0);
    expect(owner.out()).toContain('bundle: operator');
    expect(owner.out()).toContain('card: Grok Bot may, for team docs');
    const refused = capture(w);
    expect(await runGrant(bundleFlags(w, 'operator'), refused.io, { home: w.home })).toBe(1);
    expect(refused.err()).toContain('only the owner runs this');
  });
});

describe('policy: the bundles, their ops and their expiry caps are values, not constants', () => {
  test('an entity policy narrows what the operator bundle expands to and how long it lasts', async () => {
    const w = world();
    const set = writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status,down@30d;observer=status@7d' }, { now: new Date() });
    expect(set.ok, set.ok ? '' : set.why).toBe(true);
    const expanded = expandBundle(w.home, 'operator', 'floor', null);
    expect(expanded.ok && expanded.ops).toEqual(['status', 'down']);
    expect(expanded.ok && expanded.expiryDays).toBe(30);
    const g = await issued(w, 'operator');
    const record = recordOf(g.path);
    expect(record.allowed_ops).toEqual(['status', 'down']);
    expect(record.seats).toEqual([]);
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(30 * DAY);
    // Past the cap is refused; shorter is fine.
    const tooLong = await request(w, 'operator', ['--expires', new Date(Date.now() + 31 * DAY).toISOString()]);
    expect(tooLong.code).toBe(1);
    expect(tooLong.json.error.message).toContain('30 days');
    const shorter = await request(w, 'operator', ['--expires', new Date(Date.now() + 5 * DAY).toISOString()]);
    expect(shorter.code, shorter.out).toBe(0);
  });

  test('the policy never lifts the structural limits: no forbidden op, no more than ninety days, and a bad word fails closed', async () => {
    const w = world();
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status,grant' }, { now: new Date() }).ok).toBe(false);
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status@120d' }, { now: new Date() }).ok).toBe(false);
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status@90d' }, { now: new Date() }).ok).toBe(true);
    // A lower level can only narrow.
    expect(bundlePolicyWithin('operator=status', 'operator=status,down')).toBe(true);
    expect(bundlePolicyWithin('operator=status,up', 'operator=status,down')).toBe(false);
    expect(bundlePolicyWithin('operator=status@60d', 'operator=status@30d')).toBe(false);
    expect(bundlePolicyWithin('', '')).toBe(true);
    // No entity, no project: the release defaults, with no policy read.
    expect(bundleSpecsInForce(w.home, null).ok).toBe(true);
  });

  test('a policy narrowed between the request and the execute refuses the request, which is then not spent', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w, 'operator');
    expect(asked.code).toBe(0);
    const id = asked.json.target as string;
    expect((await answer(w, id, 'oui')).code).toBe(0);
    // Narrowed after the answer: the request still means the ops it hashed, so it cannot be issued as it is.
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status,down' }, { now: new Date() }).ok).toBe(true);
    const run = await execute(w, id);
    expect(run.code).toBe(1);
    expect(run.err).toContain('no longer lets the operator bundle carry');
    expect(run.err).toContain('is not spent');
  });
});
