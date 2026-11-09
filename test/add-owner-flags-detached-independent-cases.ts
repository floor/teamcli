// Independent scenes for the owner-only add flags after a detached caller's admission. A caller
// with no terminal and a signed team-add approval is admitted by the owner-seat door, but the
// door does not hand it the owner's --file or --session: the refusal comes before any flagged
// file or session is read. An unapproved no-terminal caller keeps the routed detached sentence,
// and a placed lead aiming --file inside its own team root with its own session is still
// admitted. Every world here is synthetic; nothing reads a real store, pane or terminal.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { approveOwnerAction, boundWords, createOwnerActionRequest } from '../src/client/owner-action.ts';
import { headOf, teamNameAt } from '../src/client/owner-action-step.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { seatOwner } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-09T16:00:00Z');
const OWNER_ONLY = 'only the owner runs this, from a terminal outside herdr';
const DETACHED_ROUTE = 'only the owner or an approved delegate runs this, from a terminal outside herdr or its own pane';
const owned: string[] = [];

afterEach(() => {
  const paths = owned.splice(0).filter((p) => fs.existsSync(p));
  if (paths.length) discardFixtures(paths);
});

const SEATS = `seats:
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: helmsman
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const created: string[] = [];

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'adfd-'))); owned.push(base);
  const root = join(base, 'flags-team'), home = join(base, 'home');
  const dir = join(root, '.agents');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(home);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(join(root, 'README'), 'synthetic add flags fixture\n');
  git('add', 'README');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'synthetic fixture');
  const file = join(dir, 'team.yaml');
  fs.writeFileSync(file, `format: 1
project: flags
session: main
coordinator: lead
operator: helmsman
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
  base: main
${SEATS}`);
  fs.writeFileSync(join(dir, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { main: { seats: { lead: { stage: 'ready', pane: 'lead-pane' }, worker: { stage: 'ready', pane: 'worker-pane' } }, workspaces: {} } },
  }, null, 2)}\n`);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, root, home),
    { approval: approvalOf(loaded.team, root, NOW), file: fs.readFileSync(file, 'utf8') },
    loaded.team.seats, home, NOW,
  );
  upsertTeam(home, teamIdOf(root), { project: 'flags', session: 'main', root });
  const store = seatOwner(home);
  const sources = (): AddSources => ({
    home, ownerSeatStore: store,
    sessionState: (): 'running' => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: {
      version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
      herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => NOW, home,
    },
    now: () => NOW,
    launch: {
      sessionState: (): 'running' => 'running',
      startServer: () => true,
      sessionUp: () => true,
      createWorkspace: () => { created.push('createWorkspace'); return { pane: 'added-seat-pane', workspace: 'added-seat' }; },
      paneRun: () => { created.push('paneRun'); return true; },
      renameAgent: () => { created.push('renameAgent'); return true; },
      closeWorkspace: () => true,
      agentPanes: () => [] as string[],
      agents: () => [{ name: 'newcomer', agent: 'claude', pane: 'added-seat-pane', workspace: 'added-seat', status: 'idle', cwd: null }] as never[],
      paneText: () => CLAUDE_IDLE,
      foreground: () => ['claude'],
      sleep: async () => {},
      now: () => NOW,
    } as never,
  });
  // One approval per call: an admission's claim is single-use, so the plain and the --json runs
  // of the same words each carry their own signed request.
  const approved = (argv: readonly string[]): string => {
    const made = createOwnerActionRequest(home, {
      actions: ['team-add'], root, team: teamNameAt(root, home), head: headOf(root),
      args: { 'team-add': boundWords(argv) }, requestedBy: 'seat:worker',
    }, NOW);
    if (!made.ok) throw new Error(made.why);
    const signed = approveOwnerAction(home, made.record.request_id, 'oui', store, NOW);
    if (!signed.ok) throw new Error(signed.why);
    return made.record.request_id;
  };
  return { base, root, home, dir, file, state: join(dir, 'team.state.json'), sources, approved };
}
type World = ReturnType<typeof world>;

function detachedIo(w: World) {
  const io = testIo(w.root, { kind: 'owner-no-tty' });
  io.env = { ...io.env, HOME: w.home };
  return io;
}

test('the suite and all module defaults use the internally created HOME', () => { assertIndependentHome(); });

test('a signed approval does not hand a no-terminal caller the owner-only file flag', async () => {
  const w = world();
  const flagged = join(w.base, 'nowhere', 'brief.md');
  const id = w.approved(['newcomer', '--file', flagged]);
  const io = detachedIo(w);
  const code = await runAdd(['newcomer', '--file', flagged, '--approval', id], io, w.sources());
  expect(code).toBe(1);
  expect(io.err).toContain(OWNER_ONLY);
  expect(io.err).not.toContain(DETACHED_ROUTE);
  // The refusal is decided before any flagged file is read: the path never existed and is never
  // named back.
  expect(fs.existsSync(flagged)).toBe(false);
  expect(io.out + io.err).not.toContain('nowhere');
  const json = detachedIo(w);
  const jsonCode = await runAdd(['newcomer', '--file', flagged, '--approval', w.approved(['newcomer', '--file', flagged]), '--json'], json, w.sources());
  expect(jsonCode).toBe(1);
  expect(JSON.parse(json.out).error.id).toBe('add.file-owner');
});

test('a signed approval does not hand a no-terminal caller the owner-only session flag', async () => {
  const w = world();
  const id = w.approved(['newcomer', '--session', 'other-session']);
  const io = detachedIo(w);
  const code = await runAdd(['newcomer', '--session', 'other-session', '--approval', id], io, w.sources());
  expect(code).toBe(1);
  expect(io.err).toContain(OWNER_ONLY);
  expect(io.err).not.toContain(DETACHED_ROUTE);
  const json = detachedIo(w);
  const jsonCode = await runAdd(['newcomer', '--session', 'other-session', '--approval', w.approved(['newcomer', '--session', 'other-session']), '--json'], json, w.sources());
  expect(jsonCode).toBe(1);
  expect(JSON.parse(json.out).error.id).toBe('add.session-owner');
});

test('an unapproved no-terminal caller keeps the detached sentence', async () => {
  const w = world();
  const flagged = join(w.base, 'nowhere', 'brief.md');
  const io = detachedIo(w);
  const code = await runAdd(['newcomer', '--file', flagged], io, w.sources());
  expect(code).toBe(1);
  expect(io.err).toContain(DETACHED_ROUTE);
  expect(io.err).not.toContain(OWNER_ONLY);
  const json = detachedIo(w);
  const jsonCode = await runAdd(['newcomer', '--file', flagged, '--json'], json, w.sources());
  expect(jsonCode).toBe(1);
  expect(JSON.parse(json.out).error.id).toBe('add.detached');
});

test('a placed lead aiming its own team root and session is still admitted', async () => {
  const w = world();
  created.length = 0;
  const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'main' });
  io.env = { ...io.env, HOME: w.home };
  const code = await runAdd(['newcomer', '--like', 'worker', '--file', w.file, '--session', 'main'], io, w.sources());
  expect(code).toBe(0);
  expect(io.out).toContain('newcomer: ready');
  expect(io.err).toBe('');
  // The flags were never the refusal: the launch ran, and the record keeps the new seat.
  expect(created).toEqual(['createWorkspace', 'paneRun']);
  expect(fs.readFileSync(w.file, 'utf8')).toContain('name: newcomer');
  expect(fs.readFileSync(w.state, 'utf8')).toContain('newcomer');
});
