// The `manager` client grant bundle: one owner-signed grant that carries the observer and operator lists
// plus the team's lifecycle (`restart`, `reload`, `add`, `remove`) for ONE team at ONE folder, never the
// commands that change who may do what. Synthetic homes only: a fake credential store stands in for
// Touch ID, fake launches and a fake herdr stand in for the machine; no real team is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import {
  type BundleOp,
  BUNDLE_ELIGIBLE_OPS,
  BUNDLE_FORBIDDEN_COMMANDS,
  BUNDLE_HARD_MAX_DAYS,
  BUNDLE_OP_ROUTES,
  DEFAULT_BUNDLE_SPECS,
  DEVELOPER_DEFAULT_OPS,
  DEVELOPER_ELIGIBLE_OPS,
  DEVELOPER_NEVER_COMMANDS,
  MANAGER_DEFAULT_OPS,
  MANAGER_ELIGIBLE_OPS,
  OPERATOR_DEFAULT_OPS,
  canonicalBundleOps,
  isEligibleBundleOp,
  isForbiddenBundleCommand,
  parseBundlePolicy,
} from '../src/client/bundle-ops.ts';
import { bundleCard, expandBundle } from '../src/client/bundles.ts';
import {
  CLIENT_BUNDLE_VOCABULARY_VERSION,
  CLIENT_DEVELOPER_VOCABULARY_VERSION,
  CLIENT_GRANT_DOMAIN,
  CLIENT_MANAGER_VOCABULARY_VERSION,
  clientGrantPath,
  clientGrantsFolder,
  clientKeyDir,
  newClientKeyPair,
  planClientBundleGrant,
  readClientUpGrant,
  writeClientKeyFiles,
} from '../src/client/records.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch, DownSources } from '../src/commands/down.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runHold } from '../src/commands/hold.ts';
import { runPause } from '../src/commands/pause.ts';
import { runResume } from '../src/commands/resume.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runSeat } from '../src/commands/seat.ts';
import { runSeats } from '../src/commands/seats.ts';
import { runSessions } from '../src/commands/sessions.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { Launch } from '../src/commands/up.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { LOG_FILE, readState } from '../src/state.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';
import { storePath } from '../src/store/store.ts';
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

const seatedWorlds = new WeakSet<object>();

async function seated(w: World): Promise<void> {
  if (seatedWorlds.has(w)) return;
  seatedWorlds.add(w);
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



const NEVER = [
  'grant', 'revoke', 'delegate', 'owner-seat', 'policy set', 'policy unset', 'settings set', 'settings unset', 'development-mode set',
  'answer', 'config', 'broker', 'bus', 'daemon', 'register', 'client keygen', 'init', 'tempo', 'raise', 'queue', 'worktree', 'lock', 'unlock',
];
const MANAGER_OPS: BundleOp[] = [
  'status', 'list', 'check', 'feed', 'messages', 'seats', 'seat', 'sessions', 'usage', 'drops', 'projects', 'issues', 'plan', 'next', 'brief', 'watch', 'doctor', 'commits',
  'send', 'reply', 'ack', 'ask-show', 'up', 'down', 'restart', 'reload', 'add', 'remove',
];

const recordOf = (path: string) => JSON.parse(readFileSync(path, 'utf8')).client_grant;
const teamPathOf = (w: World) => join(w.docs, '.agents', 'team.yaml');
const logOf = (w: World): string => {
  const path = join(w.docs, '.agents', LOG_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const noTerminal = { kind: 'owner-no-tty' } as const;
const approvalFile = (w: World): string => join(storePath('docs', w.docs, w.home), 'approval.json');

/** The docs team gains a human's pane and a spare worker the manager can remove; the grant is signed after. */
function furnish(w: World): void {
  const text = readFileSync(teamPathOf(w), 'utf8');
  writeFileSync(teamPathOf(w), `${text}${seat('scribe', 'implementer', ['    human: true'])}\n${seat('spare', 'implementer', [])}\n`);
}

function doctorOf(w: World, now: () => Date): DoctorSources {
  return { version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now, home: w.home };
}

type Made = { launch: Launch; creates: string[]; commands: string[]; session: 'absent' | 'running' };

/** A launch whose every effect is recorded: no herdr, no pane, no process. */
function launchOf(now: () => Date): Made {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  const made: Made = { launch: {} as Launch, creates: [], commands: [], session: 'absent' };
  made.launch = {
    sessionState: () => made.session,
    startServer() { made.session = 'running'; return true; },
    sessionUp: () => made.session === 'running',
    createWorkspace(_s, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: CLAUDE_IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_s, pane, command) {
      made.commands.push(command);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_s, workspace) => [`${workspace}:p1`],
    paneText: (_s, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex'],
    sleep: async () => {},
    now,
  };
  return made;
}

function addSources(w: World, made: Made, now: () => Date): AddSources {
  return { home: w.home, sessionState: () => made.session, agents: () => [], workspaces: () => [], doctor: doctorOf(w, now), now, launch: made.launch };
}

async function clientAdd(w: World, grantPath: string | null, keyPath: string, argv: string[], at: { caller?: Caller; now?: Date; cwd?: string } = {}) {
  const now = () => at.now ?? new Date();
  const made = launchOf(now);
  const io = testIo(at.cwd ?? w.docs, at.caller ?? noTerminal);
  const flags = grantPath === null ? [] : ['--client', grantPath, '--key', keyPath];
  const code = await runAdd([...argv, ...flags], io, addSources(w, made, now));
  return { code, out: io.out, err: io.err, made, log: logOf(w) };
}

function removeSources(w: World, now: () => Date): RemoveSources {
  const launch: DownLaunch = {
    typeText: () => true, sendKey: () => true, pressEnter: () => true, agentPanes: () => [], closeWorkspace: () => true, stopSession: () => true,
    deleteSession: () => true, kill: () => true, sleep: async () => {}, now,
  };
  return {
    sessionRunning: () => false, agents: () => [], alive: () => false, screen: () => ({ kind: 'idle' }), screenText: () => '', status: () => 'idle',
    foreground: () => ['zsh'], now, home: w.home, standing: () => ({ kind: 'none' }), launch,
  } as unknown as RemoveSources;
}

async function clientRemove(w: World, grantPath: string | null, keyPath: string, argv: string[], at: { caller?: Caller; now?: Date } = {}) {
  const now = () => at.now ?? new Date();
  const io = testIo(w.docs, at.caller ?? noTerminal);
  const flags = grantPath === null ? [] : ['--client', grantPath, '--key', keyPath];
  const code = await runRemove([...argv, ...flags], io, removeSources(w, now));
  return { code, out: io.out, err: io.err, log: logOf(w) };
}

const NEVER_LIVE = { running: false, agents: [], workspaces: [], screens: {} };
const statusSources = (w: World, now?: Date): StatusSources => ({ live: () => NEVER_LIVE, branch: () => 'main', standing: () => ({ kind: 'none' }), now: () => now ?? new Date(), home: w.home });

describe('the manager bundle: what the owner signs is an explicit list, and never more', () => {
  test('the release default expands into the explicit ops, in one canonical order, capped at ninety days', () => {
    expect([...MANAGER_ELIGIBLE_OPS] as BundleOp[]).toEqual(MANAGER_OPS);
    expect([...MANAGER_DEFAULT_OPS]).toEqual(MANAGER_OPS);
    expect(DEFAULT_BUNDLE_SPECS.manager.ops).toEqual(MANAGER_OPS as never);
    expect(DEFAULT_BUNDLE_SPECS.manager.expiryDays).toBe(BUNDLE_HARD_MAX_DAYS);
    const expanded = expandBundle('/nonexistent-home-never-read', 'manager', 'floor', null);
    expect(expanded.ok && expanded.ops).toEqual(MANAGER_OPS);
    expect(expanded.ok && expanded.expiryDays).toBe(90);
    expect(canonicalBundleOps(['add', 'status', 'restart'], 'manager')).toEqual(['status', 'restart', 'add']);
    // The operator list is untouched: the manager is a superset and not a rename.
    expect([...OPERATOR_DEFAULT_OPS]).toEqual(['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down']);
    expect([...BUNDLE_ELIGIBLE_OPS]).toEqual(['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down']);
  });

  test('the owner card says what the manager may do, and that it cannot widen itself', () => {
    const card = bundleCard({ clientId: 'grok-bot', project: 'docs', ops: ['status', 'send', 'up', 'down', 'restart', 'add', 'remove'], seats: ['orchestrator'], expires: '2027-01-21T09:00:00.000Z', fileFingerprint: 'abc123def456' });
    expect(card).toContain('Grok Bot may, for team docs until 2027-01-21 09:00 UTC:');
    expect(card).toContain('add a seat');
    expect(card).toContain('remove a seat');
    expect(card).toContain('It cannot change permissions');
  });

  test('every op a manager can name is either wired to a client route or says honestly that it is not yet', () => {
    const wired = MANAGER_OPS.filter((op) => BUNDLE_OP_ROUTES[op]);
    expect(wired).toEqual(['status', 'seats', 'seat', 'sessions', 'send', 'up', 'down', 'restart', 'reload', 'add', 'remove']);
    const card = bundleCard({ clientId: 'grok-bot', project: 'docs', ops: ['status', 'drops'], seats: [], expires: '2027-01-21T09:00:00.000Z' });
    expect(card).toContain('Not usable yet in this build: drops');
  });
});

describe('the forbidden list stays authoritative; add and remove are narrowed for the manager alone', () => {
  test('no command that changes who may do what is eligible for the manager, spelled either way', () => {
    for (const name of NEVER) {
      for (const spelled of [name, name.replace(/ /g, '-')]) {
        expect(isForbiddenBundleCommand(spelled, 'manager'), spelled).toBe(true);
        expect(isForbiddenBundleCommand(spelled), spelled).toBe(true);
        expect(isEligibleBundleOp(spelled, 'manager'), spelled).toBe(false);
        expect(canonicalBundleOps(['status', spelled], 'manager'), spelled).toBeNull();
        expect(parseBundlePolicy(`manager=status,${spelled}`).ok, spelled).toBe(false);
      }
    }
    for (const name of NEVER) expect((MANAGER_ELIGIBLE_OPS as readonly string[]).includes(name.replace(/ /g, '-')), name).toBe(false);
    for (const name of MANAGER_ELIGIBLE_OPS) {
      if (name !== 'add' && name !== 'remove') expect(isForbiddenBundleCommand(name, 'manager'), name).toBe(false);
    }
    for (const name of ['rename', 'swap', 'pause', 'resume', 'hold', 'release']) {
      expect(isEligibleBundleOp(name, 'manager'), name).toBe(false);
      expect(isForbiddenBundleCommand(name, 'manager'), name).toBe(true);
    }
    expect(BUNDLE_FORBIDDEN_COMMANDS).toContain('add');
    expect(BUNDLE_FORBIDDEN_COMMANDS).toContain('remove');
  });

  test('observer and operator never carry add or remove, and a policy cannot give them to either', () => {
    for (const name of ['add', 'remove', 'seat-add', 'seat-remove', 'seat add', 'seat remove']) {
      for (const bundle of ['observer', 'operator'] as const) {
        expect(isForbiddenBundleCommand(name, bundle), `${bundle} ${name}`).toBe(true);
        expect(isEligibleBundleOp(name, bundle), `${bundle} ${name}`).toBe(false);
        expect(canonicalBundleOps(['status', name], bundle), `${bundle} ${name}`).toBeNull();
        expect(parseBundlePolicy(`${bundle}=status,${name.replace(/ /g, '-')}`).ok, `${bundle} ${name}`).toBe(false);
      }
    }
    expect(isEligibleBundleOp('add')).toBe(false);
    expect(isEligibleBundleOp('remove')).toBe(false);
    expect(isEligibleBundleOp('add', 'manager')).toBe(true);
    expect(isEligibleBundleOp('remove', 'manager')).toBe(true);
    expect(parseBundlePolicy('manager=status,add,remove@30d')).toMatchObject({ ok: true });
  });

  test('the planner refuses a forbidden op for every bundle, and add or remove for observer and operator', () => {
    const w = world();
    const plan = (bundle: 'observer' | 'operator' | 'manager', ops: string[]) => planClientBundleGrant(w.home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir,
      bundle, ops, up: { project: 'docs', teamId: w.docsId, root: w.docs, fingerprints: { sections: {}, seats: {} } },
    } as never);
    for (const name of NEVER) {
      const planned = plan('manager', ['status', name.replace(/ /g, '-')]);
      expect(planned.ok, name).toBe(false);
      if (!planned.ok) expect(planned.why).toContain('can never be in a bundle');
    }
    for (const bundle of ['observer', 'operator'] as const) {
      for (const name of ['add', 'remove']) {
        const planned = plan(bundle, ['status', name]);
        expect(planned.ok, `${bundle} ${name}`).toBe(false);
        if (!planned.ok) expect(planned.why).toContain('can never be in a bundle');
      }
    }
    expect(plan('manager', ['status', 'add', 'remove']).ok).toBe(true);
  });

  test('a hand-built manager record that lists a forbidden op is nothing, even carrying a real owner signature', () => {
    const w = world();
    const base = (ops: string[], extra: Record<string, unknown> = {}) => ({
      grant_id: `cg_${'a'.repeat(24)}`, client_id: 'grok-bot', entity: 'floor', public_key: w.grok.pair.publicKey, key_id: w.grok.pair.keyId, key_dir: w.grok.dir,
      bundle: 'manager', allowed_ops: ops, seats: ops.includes('send') ? ['orchestrator'] : [],
      issued: new Date().toISOString(), expires: new Date(Date.now() + DAY).toISOString(), vocabulary: CLIENT_MANAGER_VOCABULARY_VERSION,
      team: { project: 'docs', team_id: w.docsId, root: w.docs, ...(ops.includes('up') ? { fingerprints: { sections: {}, seats: { lead: 'a'.repeat(64) } } } : {}) },
      ...extra,
    });
    const sign = (grant: Record<string, unknown>, grantId = grant.grant_id as string) => {
      const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: grantId, client_grant: grant as never }, keyOf(w.home));
      const path = clientGrantPath(w.home, grantId);
      mkdirSync(clientGrantsFolder(w.home), { recursive: true });
      writeFileSync(path, JSON.stringify({ client_grant: grant, signature }));
      return grantId;
    };
    const read = (id: string) => readClientUpGrant(w.home, id);
    // Whole, it reads: the same builder with no forbidden op.
    const fine = sign(base(['status', 'send', 'up', 'down', 'restart', 'add', 'remove']));
    expect(read(fine).ok, read(fine).ok ? '' : (read(fine) as { why: string }).why).toBe(true);
    let n = 0;
    for (const name of NEVER) {
      for (const spelled of [name, name.replace(/ /g, '-')]) {
        n += 1;
        const id = sign(base(['status', spelled]), `cg_${n.toString(16).padStart(24, '0')}`);
        expect(read(id).ok, spelled).toBe(false);
      }
    }
    // The vocabulary says who may carry what: the manager's ops need version 6, and 5 never reads them.
    const asFive = sign(base(['status', 'add'], { vocabulary: CLIENT_BUNDLE_VOCABULARY_VERSION }), `cg_${'e1'.repeat(12)}`);
    expect(read(asFive).ok).toBe(false);
    const operatorAsSix = sign(base(['status', 'send', 'up', 'down'], { bundle: 'operator' }), `cg_${'e2'.repeat(12)}`);
    expect(read(operatorAsSix).ok).toBe(false);
    // An observer or an operator record that lists add or remove, at the vocabulary it should be, is nothing.
    for (const [bundle, ops] of [['observer', ['status', 'add']], ['operator', ['status', 'remove']]] as const) {
      const id = sign(base([...ops], { bundle, vocabulary: CLIENT_BUNDLE_VOCABULARY_VERSION }), `cg_${bundle === 'observer' ? 'f1' : 'f2'}${'0'.repeat(22)}`);
      expect(read(id).ok, bundle).toBe(false);
    }
    // Ninety days is the cap and the manager is for one team.
    expect(read(sign(base(['status'], { expires: new Date(Date.now() + 91 * DAY).toISOString() }), `cg_${'a1'.repeat(12)}`)).ok).toBe(false);
    expect(read(sign(base(['status'], { team: undefined }), `cg_${'a2'.repeat(12)}`)).ok).toBe(false);
  });
});

describe('request, owner-seat answer, execute: the manager bundle', () => {
  test('one signature covers the whole manager list for one team, signed at vocabulary 6 for ninety days', async () => {
    const w = world();
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    expect(w.store.prompts).toHaveLength(1);
    expect(w.store.prompts[0]).toContain('Allow Grok Bot (client grok-bot) on team docs, manager bundle');
    expect(w.store.prompts[0]).toContain('manage seats');
    expect(w.store.prompts[0]).toContain('(up/down)');
    const record = recordOf(g.path);
    expect(record).toMatchObject({ client_id: 'grok-bot', entity: 'floor', bundle: 'manager', vocabulary: CLIENT_MANAGER_VOCABULARY_VERSION, seats: ['orchestrator'] });
    expect(record.allowed_ops).toEqual(MANAGER_OPS);
    expect(record.team).toMatchObject({ project: 'docs', team_id: teamIdOf(w.docs), root: w.docs });
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(BUNDLE_HARD_MAX_DAYS * DAY);
    const read = readClientUpGrant(w.home, g.grantId);
    expect(read.ok && (read.grant.ops as string[])).toEqual(MANAGER_OPS);
  });

  test('a manager grant is for one team: without --team it is refused, and a longer life is refused', async () => {
    const w = world();
    await seated(w);
    const flags = (extra: string[]) => ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--bundle', 'manager', ...extra, '--request', '--json'];
    const bare = capture(w);
    const code = await runGrant(flags([]), bare.io, { home: w.home, notify: () => false });
    expect(code).not.toBe(0);
    expect(bare.out() + bare.err()).toContain('--team');
    const tooLong = await request(w, 'manager', ['--expires', new Date(Date.now() + 91 * DAY).toISOString()]);
    expect(tooLong.code).toBe(1);
    expect(tooLong.json.error.message).toContain('90 days');
    const ninety = await request(w, 'manager', ['--expires', new Date(Date.now() + 89 * DAY).toISOString()]);
    expect(ninety.code, ninety.out + ninety.err).toBe(0);
  });

  test('observer and operator requests still refuse a manager op the owner might try by policy', async () => {
    const w = world();
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status,add' }, { now: new Date() }).ok).toBe(false);
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'manager=status,restart,add,remove@30d' }, { now: new Date() }).ok).toBe(true);
    const narrowed = expandBundle(w.home, 'manager', 'floor', null);
    expect(narrowed.ok && narrowed.ops).toEqual(['status', 'restart', 'add', 'remove']);
    expect(narrowed.ok && narrowed.expiryDays).toBe(30);
    // The other bundles keep their release defaults when the policy names only the manager.
    const operator = expandBundle(w.home, 'operator', 'floor', null);
    expect(operator.ok && operator.ops).toEqual([...OPERATOR_DEFAULT_OPS]);
  });
});

describe('add --client: no terminal, the exact team, the owner approves the roster', () => {
  test('a manager grant adds a copy of a seat from a caller with no terminal, and says the owner approves the roster', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const before = readFileSync(teamPathOf(w), 'utf8');
    expect(existsSync(approvalFile(w))).toBe(false);
    const run = await clientAdd(w, g.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs']);
    expect(run.code, run.out + run.err).toBe(0);
    const after = readFileSync(teamPathOf(w), 'utf8');
    expect(after).toContain('name: Desk');
    // The copy sits beside its source; every line the file had is still there.
    for (const line of before.split('\n')) expect(after.includes(line), line).toBe(true);
    // The roster change is the owner's: the approval record was not written, and the run says so.
    expect(existsSync(approvalFile(w))).toBe(false);
    expect(run.err).toContain('the roster change is for the owner to approve with the owner seat');
    expect(run.err).toContain('--bundle manager --request');
    expect(run.log).toContain('client-add-authorized');
    expect(run.log).toContain(`grant ${g.grantId} client grok-bot team docs`);
    expect(run.log).toContain('client:grok-bot');
    expect(run.made.creates).toContain('Desk');
  });

  test('the same invocation without --client is the old refusal, unchanged', async () => {
    const w = world();
    furnish(w);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const run = await clientAdd(w, null, w.grok.keyPath, ['Desk', '--like', 'worker']);
    expect(run.code).toBe(1);
    expect(run.err).toContain('only the owner or an approved delegate runs this, from a terminal outside herdr or its own pane');
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
    // --key and --team alone are the client form's, and say so.
    const stray = await clientAdd(w, null, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs']);
    expect(stray.code).toBe(2);
    expect(stray.err).toContain('--team belongs to the --client form');
  });

  test('the dry run verifies and plans, and writes nothing, not even the audit line', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const run = await clientAdd(w, g.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs', '--dry-run']);
    expect(run.code, run.out + run.err).toBe(0);
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
    expect(run.log).not.toContain('client-add-authorized');
    expect(run.made.creates).toEqual([]);
  });

  test('a human seat is never a source or a target, and a lead seat is never started by a client', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const human = await clientAdd(w, g.path, w.grok.keyPath, ['Desk', '--like', 'scribe', '--team', 'docs']);
    expect(human.code).toBe(1);
    expect(human.err).toContain("human's pane");
    const target = await clientAdd(w, g.path, w.grok.keyPath, ['scribe', '--team', 'docs']);
    expect(target.code).toBe(1);
    expect(target.err).toContain("human's pane");
    const lead = await clientAdd(w, g.path, w.grok.keyPath, ['lead', '--team', 'docs']);
    expect(lead.code).toBe(1);
    expect(lead.err).toContain('never starts a lead seat');
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
    expect(existsSync(approvalFile(w))).toBe(false);
  });

  test('the owner-only flags and a missing team are invocation errors, before anything is read', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const before = readFileSync(teamPathOf(w), 'utf8');
    for (const extra of [['--model', 'x'], ['--effort', 'high'], ['--session', 'docs'], ['--file', join(w.docs, '.agents', 'team.yaml')]]) {
      const run = await clientAdd(w, g.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs', ...extra]);
      expect(run.code, extra.join(' ')).toBe(2);
      expect(run.err, extra.join(' ')).toContain("are the owner's and take no --client");
    }
    const noTeam = await clientAdd(w, g.path, w.grok.keyPath, ['Desk', '--like', 'worker']);
    expect(noTeam.code).toBe(2);
    expect(noTeam.err).toContain('--client needs --team');
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
  });

  test('an observer or operator grant, an expired grant, a foreign team and another client key are all refused, with nothing written', async () => {
    const w = world();
    furnish(w);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const operator = await issued(w, 'operator', ['--seat', 'orchestrator']);
    const refusedOperator = await clientAdd(w, operator.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs']);
    expect(refusedOperator.code).toBe(1);
    expect(refusedOperator.err).toContain('not add; the owner requests one that carries add');
    const manager = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const foreign = await clientAdd(w, manager.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'other']);
    expect(foreign.code).toBe(1);
    expect(foreign.err).toContain('other');
    const elsewhere = await clientAdd(w, manager.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs'], { cwd: w.other });
    expect(elsewhere.code, elsewhere.out + elsewhere.err).toBe(0);
    // Rewind: the run above stood in another folder and still acted on the grant's own team only.
    expect(readFileSync(join(w.other, '.agents', 'team.yaml'), 'utf8')).not.toContain('Desk');
    writeFileSync(teamPathOf(w), before);
    const expired = await clientAdd(w, manager.path, w.grok.keyPath, ['Desk', '--like', 'worker', '--team', 'docs'], { now: new Date(Date.now() + 91 * DAY) });
    expect(expired.code).toBe(1);
    expect(expired.err).toContain('expired');
    const stranger = await clientAdd(w, manager.path, w.stranger.keyPath, ['Desk', '--like', 'worker', '--team', 'docs']);
    expect(stranger.code).toBe(1);
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
  });
});

describe('remove --client: the same door, narrower still', () => {
  test('a manager grant removes a declared seat and says the owner approves the roster; the approval record is not touched', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const run = await clientRemove(w, g.path, w.grok.keyPath, ['spare', '--team', 'docs']);
    expect(run.code, run.out + run.err).toBe(0);
    expect(readFileSync(teamPathOf(w), 'utf8')).not.toContain('name: spare');
    expect(run.out).toContain('removed spare');
    expect(run.out).toContain('the roster change is for the owner to approve with the owner seat');
    expect(existsSync(approvalFile(w))).toBe(false);
    expect(run.log).toContain('client-remove-authorized');
    expect(run.log).toContain('client:grok-bot');
  });

  test('the orchestrator, the operator, a human seat, --keep and --abandon are refused, and nothing changes', async () => {
    const w = world();
    furnish(w);
    const g = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const lead = await clientRemove(w, g.path, w.grok.keyPath, ['lead', '--team', 'docs']);
    expect(lead.code).toBe(1);
    expect(lead.err).toContain('never removes a lead seat');
    const human = await clientRemove(w, g.path, w.grok.keyPath, ['scribe', '--team', 'docs']);
    expect(human.code).toBe(1);
    expect(human.err).toContain("human's pane");
    for (const flag of ['--keep', '--abandon']) {
      const run = await clientRemove(w, g.path, w.grok.keyPath, ['spare', '--team', 'docs', flag]);
      expect(run.code, flag).toBe(2);
      expect(run.err, flag).toContain("are the owner's and take no --client");
    }
    const noTeam = await clientRemove(w, g.path, w.grok.keyPath, ['spare']);
    expect(noTeam.code).toBe(2);
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
  });

  test('without --client the old refusal stands; an operator grant, an expired grant and a foreign team are refused', async () => {
    const w = world();
    furnish(w);
    const before = readFileSync(teamPathOf(w), 'utf8');
    const plain = await clientRemove(w, null, w.grok.keyPath, ['spare']);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain('terminal outside herdr or its own pane');
    const operator = await issued(w, 'operator', ['--seat', 'orchestrator']);
    const refusedOperator = await clientRemove(w, operator.path, w.grok.keyPath, ['spare', '--team', 'docs']);
    expect(refusedOperator.code).toBe(1);
    expect(refusedOperator.err).toContain('not remove; the owner requests one that carries remove');
    const manager = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const foreign = await clientRemove(w, manager.path, w.grok.keyPath, ['spare', '--team', 'other']);
    expect(foreign.code).toBe(1);
    const expired = await clientRemove(w, manager.path, w.grok.keyPath, ['spare', '--team', 'docs'], { now: new Date(Date.now() + 91 * DAY) });
    expect(expired.code).toBe(1);
    expect(expired.err).toContain('expired');
    expect(readFileSync(teamPathOf(w), 'utf8')).toBe(before);
  });
});

describe('the other manager routes verify the same grant on the same team', () => {
  test('status, seats, seat and sessions read the grant\'s team; an operator grant does not carry the manager reads', async () => {
    const w = world();
    furnish(w);
    const manager = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const operator = await issued(w, 'operator', ['--seat', 'orchestrator']);
    const status = testIo(w.docs, noTerminal);
    await runStatus(['--client', manager.path, '--key', w.grok.keyPath], status, statusSources(w));
    expect(status.out).toContain('team docs, session "docs"');
    const seats = testIo(w.docs, noTerminal);
    expect(await runSeats(['--client', manager.path, '--key', w.grok.keyPath], seats, statusSources(w)), seats.err).toBe(0);
    expect(seats.out).toContain('worker');
    const one = testIo(w.docs, noTerminal);
    expect(await runSeat(['worker', '--client', manager.path, '--key', w.grok.keyPath], one, statusSources(w)), one.err).toBe(0);
    const sessions = testIo(w.docs, noTerminal);
    expect(await runSessions(['--client', manager.path, '--key', w.grok.keyPath], sessions, { home: w.home, now: () => new Date() }), sessions.err).toBe(0);
    for (const [name, run] of [
      ['seats', () => runSeats(['--client', operator.path, '--key', w.grok.keyPath], testIo(w.docs, noTerminal), statusSources(w))],
      ['sessions', () => runSessions(['--client', operator.path, '--key', w.grok.keyPath], testIo(w.docs, noTerminal), { home: w.home, now: () => new Date() })],
    ] as const) {
      expect(await run(), name).toBe(1);
    }
    expect(logOf(w)).toContain('client-seats-authorized');
    expect(logOf(w)).toContain('client-sessions-authorized');
  });

  test('restart and reload verify before any gate: an operator grant is refused, a manager grant reaches the seat check', async () => {
    const w = world();
    furnish(w);
    const manager = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const operator = await issued(w, 'operator', ['--seat', 'orchestrator']);
    const now = () => new Date();
    const restartSources = { home: w.home, now, standing: () => ({ kind: 'none' }) } as unknown as RestartSources;
    const reloadSources = { home: w.home, now, launch: launchOf(now).launch } as unknown as ReloadSources;
    const refusedRestart = testIo(w.docs, noTerminal);
    expect(await runRestart(['worker', '--client', operator.path, '--key', w.grok.keyPath], refusedRestart, restartSources)).toBe(1);
    expect(refusedRestart.err).toContain('not restart; the owner requests one that carries restart');
    const refusedReload = testIo(w.docs, noTerminal);
    expect(await runReload(['worker', '--client', operator.path, '--key', w.grok.keyPath], refusedReload, reloadSources)).toBe(1);
    expect(refusedReload.err).toContain('not reload; the owner requests one that carries reload');
    // The manager grant is past the "terminal outside herdr" gate: the run goes on to the seat check.
    const restart = testIo(w.docs, noTerminal);
    expect(await runRestart(['ghost', '--client', manager.path, '--key', w.grok.keyPath], restart, restartSources)).toBe(1);
    expect(restart.err).toContain('ghost is not a signed declared seat');
    const reload = testIo(w.docs, noTerminal);
    expect(await runReload(['ghost', '--client', manager.path, '--key', w.grok.keyPath], reload, reloadSources)).toBe(1);
    expect(reload.err).toContain('no seat of that name');
    // The owner-only flags take no --client.
    const flagged = testIo(w.docs, noTerminal);
    expect(await runRestart(['worker', '--client', manager.path, '--key', w.grok.keyPath, '--abandon'], flagged, restartSources)).toBe(2);
    expect(flagged.err).toContain("are the owner's and take no --client");
  });
});

// ---------------------------------------------------------------------------------------------------
// The developer bundle: the manager's list plus pacing, naming and work commands. One team, ninety days,
// the same verification on the exact team, and the owner's own commands never inside.

const DEVELOPER_EXTRA: BundleOp[] = ['rename', 'swap', 'pause', 'resume', 'hold', 'release', 'tempo', 'queue', 'lock', 'unlock', 'worktree', 'raise', 'route', 'pr', 'workflow', 'proc'];
const DEVELOPER_OPS: BundleOp[] = [...MANAGER_OPS, ...DEVELOPER_EXTRA];
const DEVELOPER_NEVER = [
  'grant', 'revoke', 'delegate', 'owner-seat', 'policy set', 'policy unset', 'settings set', 'settings unset', 'development-mode set',
  'answer', 'config', 'broker', 'bus', 'daemon', 'register', 'client keygen', 'init',
];

describe('the developer bundle: the manager\'s list plus the pacing and work commands, and never the owner\'s own', () => {
  test('the release default expands into the explicit 44 ops in one canonical order, capped at ninety days', () => {
    expect(DEVELOPER_OPS).toHaveLength(44);
    expect([...DEVELOPER_ELIGIBLE_OPS] as BundleOp[]).toEqual(DEVELOPER_OPS);
    expect([...DEVELOPER_DEFAULT_OPS]).toEqual(DEVELOPER_OPS);
    expect(DEFAULT_BUNDLE_SPECS.developer.ops).toEqual(DEVELOPER_OPS as never);
    expect(DEFAULT_BUNDLE_SPECS.developer.expiryDays).toBe(BUNDLE_HARD_MAX_DAYS);
    const expanded = expandBundle('/nonexistent-home-never-read', 'developer', 'floor', null);
    expect(expanded.ok && expanded.ops).toEqual(DEVELOPER_OPS);
    expect(expanded.ok && expanded.expiryDays).toBe(90);
    // A superset of the manager's, and pause and resume are first-class entries of it.
    for (const op of MANAGER_OPS) expect(DEVELOPER_OPS.includes(op), op).toBe(true);
    expect(DEVELOPER_OPS).toContain('pause');
    expect(DEVELOPER_OPS).toContain('resume');
    expect(canonicalBundleOps(['resume', 'status', 'pause', 'add'], 'developer')).toEqual(['status', 'add', 'pause', 'resume']);
    // The other bundles are untouched.
    expect([...MANAGER_ELIGIBLE_OPS] as BundleOp[]).toEqual(MANAGER_OPS);
    expect([...BUNDLE_ELIGIBLE_OPS]).toEqual(['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down']);
    expect([...OPERATOR_DEFAULT_OPS]).toEqual(['status', 'list', 'check', 'feed', 'messages', 'send', 'up', 'down']);
  });

  test('the owner card says what the developer may do, pause and resume included, and what it never can', () => {
    const card = bundleCard({ clientId: 'grok-bot', project: 'docs', ops: ['status', 'pause', 'resume', 'rename'], seats: [], expires: '2027-01-21T09:00:00.000Z' });
    expect(card).toContain('Grok Bot may, for team docs until 2027-01-21 09:00 UTC:');
    expect(card).toContain('pause the team (seats finish their work; no new work starts until resume)');
    expect(card).toContain('resume the team');
    expect(card).toContain('Not usable yet in this build: rename.');
    expect(card).not.toContain('Not usable yet in this build: pause');
    expect(card).toContain('It cannot change permissions, grant, revoke or delegate access, change policy or settings');
  });

  test('pause, resume and hold have a client route; the rest of the developer\'s own ops admit nothing yet', () => {
    expect(DEVELOPER_OPS.filter((op) => BUNDLE_OP_ROUTES[op])).toEqual(['status', 'seats', 'seat', 'sessions', 'send', 'up', 'down', 'restart', 'reload', 'add', 'remove', 'pause', 'resume', 'hold']);
    expect(DEVELOPER_EXTRA.filter((op) => !BUNDLE_OP_ROUTES[op])).toEqual(['rename', 'swap', 'release', 'tempo', 'queue', 'lock', 'unlock', 'worktree', 'raise', 'route', 'pr', 'workflow', 'proc']);
  });

  test('the owner\'s own commands are never eligible for the developer, spelled either way, and every other bundle refuses its extras', () => {
    for (const name of DEVELOPER_NEVER) {
      for (const spelled of [name, name.replace(/ /g, '-')]) {
        expect(isForbiddenBundleCommand(spelled, 'developer'), spelled).toBe(true);
        expect(isEligibleBundleOp(spelled, 'developer'), spelled).toBe(false);
        expect(canonicalBundleOps(['status', spelled], 'developer'), spelled).toBeNull();
        expect(parseBundlePolicy(`developer=status,${spelled}`).ok, spelled).toBe(false);
      }
    }
    for (const name of DEVELOPER_NEVER) expect((DEVELOPER_ELIGIBLE_OPS as readonly string[]).includes(name.replace(/ /g, '-')), name).toBe(false);
    // The never list is the forbidden list less the narrowings, and it holds everything the owner named.
    for (const name of ['grant', 'revoke', 'delegate', 'owner-seat', 'policy', 'settings', 'development-mode', 'answer', 'config', 'broker', 'bus', 'daemon', 'register', 'client', 'init']) {
      expect(DEVELOPER_NEVER_COMMANDS, name).toContain(name);
    }
    // The developer's own extras are narrowed for the developer alone.
    for (const name of DEVELOPER_EXTRA.filter((op) => (BUNDLE_FORBIDDEN_COMMANDS as readonly string[]).includes(op))) {
      expect(isForbiddenBundleCommand(name, 'developer'), name).toBe(false);
      expect(isEligibleBundleOp(name, 'developer'), name).toBe(true);
      for (const bundle of ['observer', 'operator', 'manager'] as const) {
        expect(isForbiddenBundleCommand(name, bundle), `${bundle} ${name}`).toBe(true);
        expect(isEligibleBundleOp(name, bundle), `${bundle} ${name}`).toBe(false);
        expect(canonicalBundleOps(['status', name], bundle), `${bundle} ${name}`).toBeNull();
        expect(parseBundlePolicy(`${bundle}=status,${name}`).ok, `${bundle} ${name}`).toBe(false);
      }
    }
    for (const name of ['route', 'pr', 'workflow', 'proc']) {
      for (const bundle of ['observer', 'operator', 'manager'] as const) expect(isEligibleBundleOp(name, bundle), `${bundle} ${name}`).toBe(false);
    }
    // observer and operator still never carry add or remove, and the developer does.
    for (const bundle of ['observer', 'operator'] as const) expect(isEligibleBundleOp('add', bundle)).toBe(false);
    expect(isEligibleBundleOp('add', 'developer')).toBe(true);
    expect(isEligibleBundleOp('remove', 'developer')).toBe(true);
    expect(parseBundlePolicy('developer=status,pause,resume@30d')).toMatchObject({ ok: true });
    expect(parseBundlePolicy('manager=status,pause').ok).toBe(false);
  });

  test('the planner refuses the owner\'s own commands for the developer and a developer op for the manager', () => {
    const w = world();
    const plan = (bundle: 'observer' | 'operator' | 'manager' | 'developer', ops: string[]) => planClientBundleGrant(w.home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir,
      bundle, ops, up: { project: 'docs', teamId: w.docsId, root: w.docs, fingerprints: { sections: {}, seats: {} } },
    } as never);
    for (const name of DEVELOPER_NEVER) {
      const planned = plan('developer', ['status', name.replace(/ /g, '-')]);
      expect(planned.ok, name).toBe(false);
      if (!planned.ok) expect(planned.why).toContain('can never be in a bundle');
    }
    expect(plan('developer', ['status', 'pause', 'resume', 'hold', 'add']).ok).toBe(true);
    for (const bundle of ['observer', 'operator', 'manager'] as const) {
      const planned = plan(bundle, ['status', 'pause']);
      expect(planned.ok, bundle).toBe(false);
      if (!planned.ok) expect(planned.why).toContain('can never be in a bundle');
    }
    const unbound = planClientBundleGrant(w.home, {
      clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir,
      bundle: 'developer', ops: ['status'], up: { project: '', teamId: '', root: '', fingerprints: { sections: {}, seats: {} } },
    } as never);
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) expect(unbound.why).toContain('a developer bundle is for one team');
  });

  test('a hand-built developer record that lists a never-command is nothing, even carrying a real owner signature', () => {
    const w = world();
    const base = (ops: string[], extra: Record<string, unknown> = {}) => ({
      grant_id: `cg_${'b'.repeat(24)}`, client_id: 'grok-bot', entity: 'floor', public_key: w.grok.pair.publicKey, key_id: w.grok.pair.keyId, key_dir: w.grok.dir,
      bundle: 'developer', allowed_ops: ops, seats: ops.includes('send') ? ['orchestrator'] : [],
      issued: new Date().toISOString(), expires: new Date(Date.now() + DAY).toISOString(), vocabulary: CLIENT_DEVELOPER_VOCABULARY_VERSION,
      team: { project: 'docs', team_id: w.docsId, root: w.docs, ...(ops.includes('up') ? { fingerprints: { sections: {}, seats: { lead: 'a'.repeat(64) } } } : {}) },
      ...extra,
    });
    const sign = (grant: Record<string, unknown>, grantId = grant.grant_id as string) => {
      const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: grantId, client_grant: grant as never }, keyOf(w.home));
      mkdirSync(clientGrantsFolder(w.home), { recursive: true });
      writeFileSync(clientGrantPath(w.home, grantId), JSON.stringify({ client_grant: grant, signature }));
      return grantId;
    };
    const read = (id: string) => readClientUpGrant(w.home, id);
    const fine = sign(base([...DEVELOPER_OPS]));
    expect(read(fine).ok, read(fine).ok ? '' : (read(fine) as { why: string }).why).toBe(true);
    let n = 0;
    for (const name of DEVELOPER_NEVER) {
      for (const spelled of [name, name.replace(/ /g, '-')]) {
        n += 1;
        const id = sign(base(['status', 'pause', spelled]), `cg_${(n + 100).toString(16).padStart(24, '0')}`);
        expect(read(id).ok, spelled).toBe(false);
      }
    }
    // Each vocabulary holds only its own bundles: 7 is the developer's, 6 the manager's, 5 the base.
    expect(read(sign(base(['status', 'pause'], { vocabulary: CLIENT_MANAGER_VOCABULARY_VERSION }), `cg_${'d1'.repeat(12)}`)).ok).toBe(false);
    expect(read(sign(base(['status', 'pause'], { vocabulary: CLIENT_BUNDLE_VOCABULARY_VERSION }), `cg_${'d2'.repeat(12)}`)).ok).toBe(false);
    expect(read(sign(base(['status', 'add'], { bundle: 'manager' }), `cg_${'d3'.repeat(12)}`)).ok).toBe(false);
    // A manager record (vocabulary 6) that lists a developer op is nothing, and so is one that lists pause at 5.
    for (const [bundle, vocabulary] of [['manager', CLIENT_MANAGER_VOCABULARY_VERSION], ['operator', CLIENT_BUNDLE_VOCABULARY_VERSION], ['observer', CLIENT_BUNDLE_VOCABULARY_VERSION]] as const) {
      for (const op of ['pause', 'resume', 'hold', 'rename']) {
        const id = sign(base(['status', op], { bundle, vocabulary }), `cg_${bundle.slice(0, 2)}${op.slice(0, 2)}${'0'.repeat(20)}`.replace(/[^0-9a-f_]/g, '0'));
        expect(read(id).ok, `${bundle} ${op}`).toBe(false);
      }
    }
    // Ninety days is the cap, and the developer is for one team.
    expect(read(sign(base(['status'], { expires: new Date(Date.now() + 91 * DAY).toISOString() }), `cg_${'c1'.repeat(12)}`)).ok).toBe(false);
    expect(read(sign(base(['status'], { team: undefined }), `cg_${'c2'.repeat(12)}`)).ok).toBe(false);
  });
});

describe('request, owner-seat answer, execute: the developer bundle', () => {
  test('one signature covers the whole developer list for one team, signed at vocabulary 7 for ninety days', async () => {
    const w = world();
    const g = await issued(w, 'developer', ['--seat', 'orchestrator']);
    expect(w.store.prompts).toHaveLength(1);
    expect(w.store.prompts[0]).toContain(', default bundle');
    expect(w.store.prompts[0]).toContain('manage seats');
    const record = recordOf(g.path);
    expect(record).toMatchObject({ client_id: 'grok-bot', entity: 'floor', bundle: 'developer', vocabulary: CLIENT_DEVELOPER_VOCABULARY_VERSION, seats: ['orchestrator'] });
    expect(record.allowed_ops).toEqual(DEVELOPER_OPS);
    expect(record.team).toMatchObject({ project: 'docs', team_id: teamIdOf(w.docs), root: w.docs });
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(BUNDLE_HARD_MAX_DAYS * DAY);
    const read = readClientUpGrant(w.home, g.grantId);
    expect(read.ok && (read.grant.ops as string[])).toEqual(DEVELOPER_OPS);
  });

  test('a developer grant is for one team: without --team it is refused, and a longer life is refused', async () => {
    const w = world();
    await seated(w);
    const bare = capture(w);
    const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--bundle', 'developer', '--request', '--json'], bare.io, { home: w.home, notify: () => false });
    expect(code).not.toBe(0);
    expect(bare.out() + bare.err()).toContain('--team');
    const tooLong = await request(w, 'developer', ['--expires', new Date(Date.now() + 91 * DAY).toISOString()]);
    expect(tooLong.code).toBe(1);
    expect(tooLong.json.error.message).toContain('90 days');
    expect((await request(w, 'developer', ['--expires', new Date(Date.now() + 89 * DAY).toISOString()])).code).toBe(0);
  });

  test('the client-bundles policy can narrow the developer, and cannot hand its ops to another bundle', () => {
    const w = world();
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'operator=status,pause' }, { now: new Date() }).ok).toBe(false);
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'manager=status,pause' }, { now: new Date() }).ok).toBe(false);
    expect(writePolicySet(w.home, { level: 'entity', target: 'floor', name: 'client-bundles', value: 'developer=status,pause,resume@30d' }, { now: new Date() }).ok).toBe(true);
    const narrowed = expandBundle(w.home, 'developer', 'floor', null);
    expect(narrowed.ok && narrowed.ops).toEqual(['status', 'pause', 'resume']);
    expect(narrowed.ok && narrowed.expiryDays).toBe(30);
    const manager = expandBundle(w.home, 'manager', 'floor', null);
    expect(manager.ok && manager.ops).toEqual(MANAGER_OPS);
  });
});

describe('pause, resume and hold --client: graceful, one team, verified on the exact team', () => {
  const state = (w: World) => readState(join(w.docs, '.agents'));
  const owned = (w: World, now?: Date) => ({ home: w.home, ...(now ? { now: () => now } : {}) });

  test('a developer grant pauses and resumes its team from a caller with no terminal, and touches no pane', async () => {
    const w = world();
    const dev = await issued(w, 'developer', ['--seat', 'orchestrator']);
    const flags = ['--client', dev.path, '--key', w.grok.keyPath, '--team', 'docs'];
    const paused = testIo(w.docs, noTerminal);
    expect(await runPause([...flags, '--reason', 'release freeze'], paused, owned(w)), paused.err).toBe(0);
    expect(paused.out).toContain('release freeze');
    expect(paused.err).toContain(`client grant ${dev.grantId}: grok-bot for team docs`);
    expect(state(w).pause).toMatchObject({ by: 'client:grok-bot', reason: 'release freeze' });
    // It stands: a second pause is refused by name, and nothing else was written.
    const again = testIo(w.docs, noTerminal);
    expect(await runPause(flags, again, owned(w))).toBe(1);
    expect(again.err).toContain('already paused');
    const resumed = testIo(w.docs, noTerminal);
    expect(await runResume(flags, resumed, owned(w)), resumed.err).toBe(0);
    expect(state(w).pause).toBeUndefined();
    expect(logOf(w)).toContain('client-pause-authorized');
    expect(logOf(w)).toContain('client-resume-authorized');
    expect(logOf(w)).toContain(`grant ${dev.grantId} client grok-bot team docs`);
    expect(logOf(w)).toContain('client:grok-bot');
  });

  test('a developer grant places and releases the hold of its team', async () => {
    const w = world();
    const dev = await issued(w, 'developer', ['--seat', 'orchestrator']);
    const flags = ['--client', dev.path, '--key', w.grok.keyPath, '--team', 'docs'];
    const placed = testIo(w.docs, noTerminal);
    expect(await runHold(['freeze deploys', ...flags], placed, owned(w)), placed.err).toBe(0);
    expect(state(w).hold).toMatchObject({ reason: 'freeze deploys', by: 'client:grok-bot' });
    const released = testIo(w.docs, noTerminal);
    expect(await runHold(['--release', ...flags], released, owned(w)), released.err).toBe(0);
    expect(state(w).hold).toBeUndefined();
    expect(logOf(w)).toContain('client-hold-authorized');
  });

  test('the same invocation without --client is the old refusal, unchanged', async () => {
    const w = world();
    for (const [run, argv] of [[runPause, []], [runResume, []], [runHold, ['freeze deploys']]] as const) {
      const io = testIo(w.docs, noTerminal);
      expect(await run([...argv], io, owned(w)), argv.join(' ')).toBe(1);
      expect(io.err).toContain('from a terminal outside herdr or its own seat');
    }
    expect(state(w).pause).toBeUndefined();
    expect(state(w).hold).toBeUndefined();
  });

  test('the --client form is for the one team: <team>, --all and a different team are refused, and a manager grant does not carry pause', async () => {
    const w = world();
    const dev = await issued(w, 'developer', ['--seat', 'orchestrator']);
    const manager = await issued(w, 'manager', ['--seat', 'orchestrator']);
    const flags = ['--client', dev.path, '--key', w.grok.keyPath];
    for (const [run, name] of [[runPause, 'pause'], [runResume, 'resume']] as const) {
      const named = testIo(w.docs, noTerminal);
      expect(await run(['other', ...flags], named, owned(w)), name).toBe(2);
      expect(named.err).toContain("are the owner's and take no --client");
      const all = testIo(w.docs, noTerminal);
      expect(await run(['--all', ...flags], all, owned(w)), name).toBe(2);
      expect(all.err).toContain("are the owner's and take no --client");
    }
    // A grant for docs, asked about another team, refuses before any write.
    const elsewhere = testIo(w.other, noTerminal);
    expect(await runPause([...flags, '--team', 'other'], elsewhere, owned(w))).toBe(1);
    expect(elsewhere.err).toMatch(/team|folder|bound/);
    expect(existsSync(join(w.other, '.agents', 'team.state.json'))).toBe(false);
    const fromElsewhere = testIo(w.other, noTerminal);
    expect(await runPause(flags, fromElsewhere, owned(w))).toBe(1);
    expect(existsSync(join(w.other, '.agents', 'team.state.json'))).toBe(false);
    // The manager grant is a real grant for the same team that does not carry pause: it asks for a developer one.
    for (const [run, name] of [[runPause, 'pause'], [runResume, 'resume'], [runHold, 'hold']] as const) {
      const refused = testIo(w.docs, noTerminal);
      expect(await run(name === 'hold' ? ['stop', '--client', manager.path, '--key', w.grok.keyPath] : ['--client', manager.path, '--key', w.grok.keyPath], refused, owned(w)), name).toBe(1);
      expect(refused.err).toContain(`not ${name}; the owner requests one that carries ${name}`);
      expect(refused.err).toContain('--bundle developer');
    }
    expect(state(w).pause).toBeUndefined();
    expect(state(w).hold).toBeUndefined();
    expect(logOf(w)).toContain('client-pause-refused');
  });

  test('an expired grant and a key that is not the grant\'s refuse before any write', async () => {
    const w = world();
    const dev = await issued(w, 'developer', ['--seat', 'orchestrator']);
    const late = testIo(w.docs, noTerminal);
    expect(await runPause(['--client', dev.path, '--key', w.grok.keyPath], late, owned(w, new Date(Date.now() + 91 * DAY)))).toBe(1);
    expect(late.err).toContain('expired');
    const wrongKey = testIo(w.docs, noTerminal);
    expect(await runPause(['--client', dev.path, '--key', w.stranger.keyPath], wrongKey, owned(w))).toBe(1);
    expect(state(w).pause).toBeUndefined();
    // --key and --team are the --client form's alone.
    const keyOnly = testIo(w.docs, noTerminal);
    expect(await runPause(['--key', w.grok.keyPath], keyOnly, owned(w))).toBe(2);
    expect(keyOnly.err).toContain('--key belongs to the --client form');
  });
});
