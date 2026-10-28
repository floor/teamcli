// The client `down` grant: the owner's durable, signed permission for one client (no terminal, not a
// seat) to run `team down` for ONE team at ONE folder, alone or in the same record as `up`. Request,
// owner-seat answer (a fake credential store stands in for Touch ID), execute, then the client's own
// `team down --client <grant> --key <key>` in an isolated HOME with a fake herdr. The refusals hold
// the rest of the contract: wrong team, expired, revoked, tampered, another key, a send grant used for
// down, an up-only grant used for down; and the one rule that differs from up: a team file that
// changed does not stop a stop. Synthetic homes only; no herdr, no real team.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { verifyClientUp } from '../src/client/up-grant.ts';
import { clientGrantPath, clientKeyDir, newClientKeyPair, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import type { OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Io } from '../src/io.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'client-down-grant-')));
  made.push(base);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'client-down-scratch-')));
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

/** `--client … --team docs --up` / `--down` / both, as the owner types them. */
const flagsOf = (w: World, ops: ('up' | 'down')[], extra: string[] = []) => ['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs', ...ops.map((op) => `--${op}`), ...extra];

async function request(w: World, ops: ('up' | 'down')[], extra: string[] = [], now?: Date) {
  const c = capture(w);
  const code = await runGrant([...flagsOf(w, ops, ['--request', ...extra]), '--json'], c.io, { home: w.home, notify: () => false, ...(now ? { now } : {}) });
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
async function issued(w: World, ops: ('up' | 'down')[], extra: string[] = []) {
  await seated(w);
  const asked = await request(w, ops, extra);
  expect(asked.code, asked.out + asked.err).toBe(0);
  const id = asked.json.target as string;
  expect((await answer(w, id, 'oui')).code).toBe(0);
  const done = await execute(w, id);
  expect(done.code, done.err).toBe(0);
  const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out)![1]!;
  return { requestId: id, grantId, path: clientGrantPath(w.home, grantId), done };
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

const verifyAs = (w: World, grantPath: string, op: 'up' | 'down', at: { now?: Date; cwd?: string } = {}) =>
  verifyClientUp({ home: w.home, grantFile: grantPath, keyFile: w.grok.keyPath, cwd: at.cwd ?? w.docs, now: at.now ?? new Date(), op, io: null });

describe('request, owner-seat answer, execute, then the client stops the team', () => {
  test('a down grant binds one team and its folder, and the client stops it with no terminal and no prompt', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    expect(w.store.prompts).toHaveLength(1);
    expect(w.store.prompts[0]).toContain('down');
    expect(w.store.prompts[0]).toContain(w.docs);
    const record = JSON.parse(readFileSync(g.path, 'utf8')).client_grant;
    expect(record).toMatchObject({ client_id: 'grok-bot', entity: 'floor', allowed_ops: ['down'], vocabulary: 4 });
    // A record that carries down keeps its binding under `team`; only the up-only form says `up`.
    expect(record.up).toBeUndefined();
    expect(record.team).toMatchObject({ project: 'docs', team_id: teamIdOf(w.docs), root: w.docs });
    expect(record.recipient_seat).toBeUndefined();
    expect(record.grant_scope).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('PRIVATE');
    expect(Date.parse(record.expires) - Date.parse(record.issued)).toBe(90 * DAY);

    const run = await clientDown(w, g.path, w.grok.keyPath);
    expect(run.err).toContain('key isolation: enforced against team panes');
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.closed).toEqual(['lead-ws']);
    expect(run.typed.length).toBeGreaterThan(0);
    expect(run.log).toContain(`client-down-authorized: grant ${g.grantId} client grok-bot team docs root ${w.docs}`);
    expect(run.log).toContain('lead: stopped');
    // Never a prompt: nothing waited for a key, and the grant was the whole of the admission.
    expect(run.out).not.toContain('press');
    expect(run.err).not.toContain('only the owner');
  });

  test('one grant can carry up and down: the same record admits both, and the request form asks for both', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['up', 'down']);
    expect(w.store.prompts[0]).toContain('team up and team down');
    const record = JSON.parse(readFileSync(g.path, 'utf8')).client_grant;
    expect(record.allowed_ops).toEqual(['up', 'down']);
    expect(record.team.root).toBe(w.docs);
    expect(verifyAs(w, g.path, 'up').ok).toBe(true);
    expect(verifyAs(w, g.path, 'down').ok).toBe(true);
    const run = await clientDown(w, g.path, w.grok.keyPath);
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.closed).toEqual(['lead-ws']);
  });

  test('--up alone still writes the record it always did, and it does not admit down', async () => {
    const w = world();
    const g = await issued(w, ['up']);
    const record = JSON.parse(readFileSync(g.path, 'utf8')).client_grant;
    expect(record.allowed_ops).toEqual(['up']);
    expect(record.up.root).toBe(w.docs);
    expect(record.team).toBeUndefined();
    const run = await clientDown(w, g.path, w.grok.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('admits up only, not down');
    expect(run.err).toContain(`team grant --client grok-bot --entity floor --public-key ${w.grok.pubPath} --team docs --up --down --request`);
    expect(run.closed).toEqual([]);
    expect(run.log).toContain('client-down-refused');
  });

  test('a down-only grant does not admit up', async () => {
    const w = world();
    const g = await issued(w, ['down']);
    const asUp = verifyAs(w, g.path, 'up');
    expect(asUp.ok).toBe(false);
    if (!asUp.ok) {
      expect(asUp.why).toContain('admits down only, not up');
      expect(asUp.why).toContain('--up --down --request');
    }
  });

  test('the dry run verifies, plans and writes nothing; it runs from anywhere when it names the team', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    const run = await clientDown(w, g.path, w.grok.keyPath, ['--team', 'docs', '--dry-run'], { cwd: w.base });
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.out).toContain('dry run: nothing was run');
    expect(run.closed).toEqual([]);
    expect(run.typed).toEqual([]);
    expect(run.log).not.toContain('client-down-authorized');
    const wrongKey = await clientDown(w, g.path, w.stranger.keyPath, ['--dry-run']);
    expect(wrongKey.code).toBe(1);
  });

  test('a team that is already stopped is a plain idle answer, still logged as the client\'s', async () => {
    const w = world();
    const g = await issued(w, ['down']);
    const run = await clientDown(w, g.path, w.grok.keyPath, [], { running: false });
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain('nothing to stop');
    expect(run.log).toContain(`client-down-authorized: grant ${g.grantId}`);
  });

  test('--expires sets the length, capped at ninety days; the request summary names down', async () => {
    const w = world();
    await seated(w);
    const long = await request(w, ['down'], ['--expires', new Date(Date.now() + 91 * DAY).toISOString()]);
    expect(long.code).toBe(1);
    expect(long.json.error.message).toContain('90 days');
    expect(long.json.error.message).toContain('down grant');
    const short = await request(w, ['down'], ['--expires', new Date(Date.now() + 30 * DAY).toISOString()]);
    expect(short.code).toBe(0);
    expect(short.json.summary.ops).toEqual(['down']);
    expect(short.json.summary.text).toContain('team down');
    expect(short.json.summary.text).toContain(w.docs);
    const both = await request(w, ['up', 'down']);
    expect(both.json.summary.ops).toEqual(['up', 'down']);
  });

  test('the owner at a terminal can still issue it directly, without a request', async () => {
    const w = world();
    teamRunning(w);
    const c = capture(w, { kind: 'owner' });
    expect(await runGrant(flagsOf(w, ['down']), c.io, { home: w.home })).toBe(0);
    expect(c.out()).toContain('down: team docs');
    const refused = capture(w);
    expect(await runGrant(flagsOf(w, ['down']), refused.io, { home: w.home })).toBe(1);
    expect(refused.err()).toContain('only the owner runs this');
    const id = /client grant: (cg_[0-9a-f]{24})/.exec(c.out())![1]!;
    expect((await clientDown(w, clientGrantPath(w.home, id), w.grok.keyPath, ['--dry-run'])).code).toBe(0);
  });
});

describe('the grant is for one team and one folder, and for nothing else', () => {
  test('another team, another folder, a name that is not the grant\'s: refused, with the next step', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    const elsewhere = await clientDown(w, g.path, w.grok.keyPath, [], { cwd: w.other });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toContain(`for team "docs" at ${w.docs}`);
    expect(elsewhere.err).toContain('team down --client');
    expect(elsewhere.err).toContain('--team docs');
    expect(elsewhere.closed).toEqual([]);
    const named = await clientDown(w, g.path, w.grok.keyPath, ['--team', 'other'], { cwd: w.other });
    expect(named.code).toBe(1);
    expect(named.err).toContain('not team "other"');
    expect(named.closed).toEqual([]);
    const lost = await clientDown(w, g.path, w.grok.keyPath, [], { cwd: w.base });
    expect(lost.code).toBe(1);
    expect(lost.err).toContain('--team docs');
    expect(lost.closed).toEqual([]);
  });

  test('a copy of the team in another folder with the same name is not the folder the owner signed', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    const twin = repo(w.base, 'docs-twin', (root) => teamText('docs', w.base, root, w.home));
    const run = await clientDown(w, g.path, w.grok.keyPath, ['--team', 'docs'], { cwd: twin });
    expect(run.code).toBe(1);
    expect(run.err).toContain(`at ${w.docs}`);
    expect(run.closed).toEqual([]);
  });

  test('the grant never widens itself: no seat, no abandon, no other file or session', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    for (const extra of [['--file', 'other.yaml'], ['--session', 'elsewhere']]) {
      const run = await clientDown(w, g.path, w.grok.keyPath, extra);
      expect(run.code, extra.join(' ')).toBe(2);
      expect(run.err).toContain('--client');
      expect(run.closed).toEqual([]);
    }
    // A plain down grant (no default bundle) still abandons nothing.
    const abandoned = await clientDown(w, g.path, w.grok.keyPath, ['--abandon']);
    expect(abandoned.code).toBe(1);
    expect(abandoned.err).toContain('default (developer) bundle');
    expect(abandoned.closed).toEqual([]);
  });

  test('the default bundle (--bundle default, alias developer) may --abandon with --client; --file and --session stay the owner\'s', async () => {
    for (const name of ['default', 'developer'] as const) {
      const w = world();
      teamRunning(w);
      const docsId = teamIdOf(w.docs);
      const lead = registerAgent(w.home, {
        name: 'lead', signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
        reach: { team: docsId, seat: 'lead', session: 'docs', pane: 'w1:p0', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
      });
      const orch = registerAgent(w.home, {
        name: 'orchestrator', signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
        reach: { team: docsId, seat: 'orchestrator', session: 'docs', pane: 'w1:p1', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
      });
      upsertTeam(w.home, docsId, { project: 'docs', entity: null, session: 'docs', root: w.docs, lobby: join(w.home, '.config', 'team', 'lobby'), lifecycle: 'running', roster: [{ agent: lead.id, seat: 'lead', role: 'coordinator', leads: true }, { agent: orch.id, seat: 'orchestrator', role: 'implementer' }] });
      await seated(w);
      const c = capture(w);
      const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs', '--bundle', name, '--seat', 'orchestrator', '--request', '--json'], c.io, { home: w.home, notify: () => false });
      expect(code, c.out() + c.err()).toBe(0);
      const id = JSON.parse(c.out().trim()).target as string;
      expect((await answer(w, id, 'oui')).code).toBe(0);
      const done = await execute(w, id);
      expect(done.code, done.err).toBe(0);
      const grantId = /client grant: (cg_[0-9a-f]{24})/.exec(done.out)![1]!;
      const path = clientGrantPath(w.home, grantId);
      const record = JSON.parse(readFileSync(path, 'utf8')).client_grant;
      expect(record.bundle).toBe('developer');
      expect(record.vocabulary).toBe(7);
      for (const extra of [['--file', 'other.yaml'], ['--session', 'elsewhere']]) {
        const run = await clientDown(w, path, w.grok.keyPath, [...extra, '--abandon']);
        expect(run.code, extra.join(' ')).toBe(2);
        expect(run.closed).toEqual([]);
      }
      const run = await clientDown(w, path, w.grok.keyPath, ['--abandon']);
      expect(run.code, run.err).toBe(0);
      expect(run.err).not.toContain('only the owner abandons');
    }
  });

  test('a --request naming a team and nothing narrower asks for the default bundle', async () => {
    const w = world();
    await seated(w);
    const c = capture(w);
    const code = await runGrant(['--client', 'grok-bot', '--entity', 'floor', '--public-key', w.grok.pubPath, '--team', 'docs', '--request', '--json'], c.io, { home: w.home, notify: () => false });
    // The default bundle carries send, and this team opens no seat to the client: the owner's
    // visibility still decides, so the request is refused, by the default bundle's name.
    expect(code).toBe(1);
    expect(c.out() + c.err()).toContain('the default bundle carries send');
  });


  test('a down grant is never asked with a seat, an inbox, grant, or without the team', async () => {
    const w = world();
    const probe = async (extra: string[], drop?: string) => {
      const c = capture(w);
      const argv = flagsOf(w, ['down'], ['--request', ...extra]).filter((word, i, all) => drop === undefined || (word !== drop && all[i - 1] !== drop));
      return { code: await runGrant(argv, c.io, { home: w.home, notify: () => false }), err: c.err() };
    };
    for (const extra of [['--seat', 'orchestrator'], ['--inbox'], ['--allow-grant'], ['--grant-team', 'docs']]) {
      const r = await probe(extra);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.err).toContain('--down');
    }
    const noTeam = await probe([], '--team');
    expect(noTeam.code).toBe(2);
    expect(noTeam.err).toContain('--team');
  });

  test('a down grant is never approved "always": it is already durable', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w, ['down']);
    const always = await answer(w, asked.json.target, 'always');
    expect(always.code).toBe(1);
    expect(always.err).toContain('never approved always');
    expect(readdirSync(join(w.home, '.config', 'team', 'grants')).filter((n) => n.startsWith('cg_'))).toHaveLength(0);
  });

  test('a send grant opens no down, and a down grant opens no send and cannot be a sub-grant', async () => {
    const w = world();
    // A floor coordinator and a send grant, as the shipped slice has them.
    const floor = repo(w.base, 'floor', () => `format: 1\nproject: floor\nentity: floor\ncoordinator: orchestrator\noperator: orchestrator\nsession: acme\nworkspace:\n  mode: shared\nseats:\n${seat('orchestrator', 'coordinator', ['    leads: true'])}\n`);
    const floorId = teamIdOf(floor);
    const orch = registerAgent(w.home, {
      name: 'orchestrator', signing: { model: 'Claude Opus', version: '5.5', role: 'orchestrator' }, lab: 'test', cli: 'claude-code', launcher: null, launch: 'true',
      reach: { team: floorId, seat: 'orchestrator', session: 'acme', pane: 'w1:p1', address: null }, mcp: [], skills: [], lifecycle: 'running', by: 'test',
    });
    upsertTeam(w.home, floorId, { project: 'floor', entity: 'floor', session: 'acme', root: floor, lobby: join(w.base, 'lobby'), roster: [{ agent: orch.id, seat: 'orchestrator', role: 'orchestrator', leads: true }], lifecycle: 'running' });
    const sendGrant = writeClientGrant(w.home, { clientId: 'grok-bot', entity: 'floor', publicKey: w.grok.pair.publicKey, keyId: w.grok.pair.keyId, keyDir: w.grok.dir }, { key: keyOf(w.home) });
    if (!sendGrant.ok) throw new Error(sendGrant.why);
    const asDown = await clientDown(w, sendGrant.path, w.grok.keyPath);
    expect(asDown.code).toBe(1);
    expect(asDown.err).toContain('is not a down grant');
    expect(asDown.err).toContain('--down --request');
    expect(asDown.closed).toEqual([]);

    const g = await issued(w, ['down']);
    const io = testIo(w.docs, { kind: 'owner' });
    const host = { home: w.home, now: () => new Date(), sendId: () => '00000001-1111-4111-8111-111111111111' } as unknown as SendHost;
    expect(await runSend(['--client', g.path, '--key', w.grok.keyPath, 'orchestrator@floor', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('down grant');
    const viaDown = capture(w);
    expect(await runGrant(['--client-request', '--via', g.path, '--key', w.grok.keyPath, ...flagsOf(w, ['down'])], viaDown.io, { home: w.home })).toBe(2);
    expect(viaDown.err()).toContain('--down');
  });
});

describe('the grant fails closed', () => {
  test('expired: refused, with the exact command that renews it', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down'], ['--expires', new Date(Date.now() + 10 * 60_000).toISOString()]);
    const run = await clientDown(w, g.path, w.grok.keyPath, [], { now: new Date(Date.now() + 20 * 60_000) });
    expect(run.code).toBe(1);
    expect(run.err).toContain('expired');
    expect(run.err).toContain(`team grant --client grok-bot --entity floor --public-key ${w.grok.pubPath} --team docs --down --request`);
    expect(run.closed).toEqual([]);
  });

  test('revoked: the owner revokes it at any time, and the next run is refused and logged', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    expect((await clientDown(w, g.path, w.grok.keyPath, ['--dry-run'])).code).toBe(0);
    const stranger = capture(w);
    expect(await runRevoke([g.grantId], stranger.io, { home: w.home })).toBe(1);
    const owner = capture(w, { kind: 'owner' });
    expect(await runRevoke([g.grantId], owner.io, { home: w.home })).toBe(0);
    expect(owner.out()).toContain(`client grant revoked: ${g.grantId}`);
    const run = await clientDown(w, g.path, w.grok.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('revoked');
    expect(run.err).toContain('--down --request');
    expect(run.closed).toEqual([]);
    expect(run.typed).toEqual([]);
    expect(run.log).toContain(`client-down-refused: grant ${g.grantId}`);
  });

  test('tampered: a grant file edited after the owner signed it verifies as nothing', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    const file = JSON.parse(readFileSync(g.path, 'utf8'));
    file.client_grant.expires = new Date(Date.now() + 900 * DAY).toISOString();
    const forged = join(w.base, 'forged.json');
    writeFileSync(forged, JSON.stringify(file));
    const edited = await clientDown(w, forged, w.grok.keyPath);
    expect(edited.code).toBe(1);
    expect(edited.err).toContain('not a verified owner-signed down grant');
    const widened = JSON.parse(readFileSync(g.path, 'utf8'));
    widened.client_grant.allowed_ops = ['up', 'down'];
    writeFileSync(forged, JSON.stringify(widened));
    const wider = await clientDown(w, forged, w.grok.keyPath);
    expect(wider.code).toBe(1);
    expect(wider.err).toContain('not a verified owner-signed down grant');
    const moved = JSON.parse(readFileSync(g.path, 'utf8'));
    moved.client_grant.team.root = w.other;
    writeFileSync(forged, JSON.stringify(moved));
    const other = await clientDown(w, forged, w.grok.keyPath, [], { cwd: w.other });
    expect(other.code).toBe(1);
    expect(other.closed).toEqual([]);
  });

  test('another client key: refused even with the real grant file', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    const run = await clientDown(w, g.path, w.stranger.keyPath);
    expect(run.code).toBe(1);
    expect(run.err).toContain('not the app key the grant');
    expect(run.closed).toEqual([]);
  });

  test('--client needs --key, and --key and --team need --client', async () => {
    const w = world();
    const g = await issued(w, ['down']);
    const { sources } = downSourcesOf(w, () => new Date());
    const noKey = testIo(w.docs, { kind: 'owner-no-tty' });
    expect(await runDown(['--client', g.path], noKey, sources)).toBe(2);
    expect(noKey.err).toContain('--key');
    const noClient = testIo(w.docs, { kind: 'owner-no-tty' });
    expect(await runDown(['--key', w.grok.keyPath], noClient, sources)).toBe(2);
    expect(noClient.err).toContain('--client');
    const teamOnly = testIo(w.docs, { kind: 'owner-no-tty' });
    expect(await runDown(['--team', 'docs'], teamOnly, sources)).toBe(2);
    expect(teamOnly.err).toContain('--client');
  });
});

describe('a changed team file does not stop the stop', () => {
  test('a new seat in the file: down still runs, and the same grant\'s up is refused until it is re-signed', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['up', 'down']);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, `${seat('intruder', 'implementer')}\n`));
    const up = verifyAs(w, g.path, 'up');
    expect(up.ok).toBe(false);
    if (!up.ok) expect(up.why).toContain('seat intruder is not in the last approval');
    const run = await clientDown(w, g.path, w.grok.keyPath);
    expect(run.code, run.err + run.out).toBe(0);
    expect(run.closed).toEqual(['lead-ws']);
    expect(run.log).toContain(`client-down-authorized: grant ${g.grantId}`);
  });

  test('an owner section changed, or a file that no longer loads: the grant still names the folder, so down is not refused by the grant', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, '', 'tempo: urgent\n'));
    expect((await clientDown(w, g.path, w.grok.keyPath, ['--dry-run'])).code).toBe(0);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), 'format: 1\nproject: [oops\n');
    expect(verifyAs(w, g.path, 'down').ok).toBe(true);
  });

  test('the team renamed or moved to another entity is another team: refused', async () => {
    const w = world();
    teamRunning(w);
    const g = await issued(w, ['down']);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('renamed', w.base, w.docs, w.home));
    const run = await clientDown(w, g.path, w.grok.keyPath, ['--dry-run']);
    expect(run.code).toBe(1);
    expect(run.err).toContain('names team "renamed"');
  });

  test('a team file that drifted between the request and the answer does not spend a down-only request', async () => {
    const w = world();
    await seated(w);
    const asked = await request(w, ['down']);
    expect((await answer(w, asked.json.target, 'oui')).code).toBe(0);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, `${seat('late', 'implementer')}\n`));
    const done = await execute(w, asked.json.target);
    expect(done.code, done.err).toBe(0);
    // ...while a request that carries up still refuses the same drift, and is not spent.
    const withUp = await request(w, ['up', 'down']);
    expect((await answer(w, withUp.json.target, 'oui')).code).toBe(0);
    writeFileSync(join(w.docs, '.agents', 'team.yaml'), teamText('docs', w.base, w.docs, w.home, `${seat('later', 'implementer')}\n`));
    const refused = await execute(w, withUp.json.target);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('changed since the request');
    expect(refused.err).toContain('is not spent');
  });
});

describe('nothing else about `team down` changed', () => {
  test('without --client, a caller with no terminal is still refused, grant or no grant', async () => {
    const w = world();
    teamRunning(w);
    await issued(w, ['down']);
    const { sources, closed } = downSourcesOf(w, () => new Date());
    const io = testIo(w.docs, { kind: 'owner-no-tty' });
    const code = await runDown([], io, sources);
    expect(code).toBe(1);
    expect(io.err + io.out).toContain('only the owner or a `leads` seat runs this');
    expect(closed).toEqual([]);
  });
});
