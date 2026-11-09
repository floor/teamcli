// Independent command-level routing and authority scenes. Every home, registry, repository,
// signature and pane below belongs to the fixture. The terminal host refuses all real calls.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { approvalOf } from '../src/approve/approval.ts';
import { approveOwnerAction, createOwnerActionRequest, type OwnerAction } from '../src/client/owner-action.ts';
import { CLIENT_GRANT_DOMAIN, CLIENT_MANAGER_VOCABULARY_VERSION, clientGrantPath, clientGrantsFolder,
  clientKeyDir, newClientKeyPair, readClientUpGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runConfig } from '../src/commands/config.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runRemove } from '../src/commands/remove.ts';
import { realSources as restartSources, runRestart } from '../src/commands/restart.ts';
import { runSettings } from '../src/commands/settings.ts';
import { runSetup } from '../src/commands/setup.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { addressedTeam, teamBinding } from '../src/registry/binding.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { resolveTarget } from '../src/send/resolve.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fakeOwnerStore, seatOwner } from './helpers/owner-seat.ts';

const NOW = () => new Date('2026-11-09T10:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const made: string[] = [];
beforeEach(() => setHerdrRun(() => { throw new Error('no real terminal host in these scenes'); }));
afterEach(() => {
  setHerdrRun(null);
  discardFixtures(made.splice(0), { roots: [dirname(process.env.TEAMCLI_TEST_SCRATCH ?? '')] });
});

function teamText(home: string, root: string, name: string, callerLeads: boolean): string {
  const seat = (name: string, role: string) => `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  return `format: 1
project: ${name}
session: ${name}
coordinator: ${callerLeads ? 'caller' : 'lead'}
operator: ${callerLeads ? 'caller' : 'lead'}
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator')}${seat('caller', 'operator')}${seat('worker', 'implementer')}`;
}

function world(betaLeads = true) {
  const base = fixtureBase('pane-command-independent-');
  made.push(base);
  const home = join(base, 'home');
  const beta = join(base, 'outer');
  const alpha = join(beta, 'nested');
  const away = join(base, 'away');
  for (const folder of [home, alpha, away, lobbyDir(home)]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  for (const [root, name, leads] of [[beta, 'beta', betaLeads], [alpha, 'alpha', true]] as const) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(home, root, name, leads));
    upsertTeam(home, teamIdOf(root), { root, project: name, session: name, entity: null,
      roster: ['lead', 'caller', 'worker'].map(seat => ({ seat, role: 'operator', agent: '' })) });
    updateState(join(root, '.agents'), state => {
      const session = state.sessions[name] ??= emptySession();
      session.seats.caller = { stage: 'ready', pane: `${name}-caller` };
    });
    registerAgent(home, { name: 'worker', signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
      lab: 'anthropic', cli: 'claude-code', launcher: null, launch: 'claude --model claude-opus-5-5',
      reach: { team: teamIdOf(root), seat: 'worker', session: name, pane: `${name}-worker`, address: null },
      mcp: [], skills: [], lifecycle: 'running', by: 'the independent scene' });
  }
  return { base, home, beta, alpha, away, store: fakeOwnerStore(), effects: [] as string[] };
}
type World = ReturnType<typeof world>;
const caller = (team = 'beta'): Caller => ({ kind: 'seat', name: 'caller', pane: `${team}-caller`, session: team });
const file = (root: string) => join(root, '.agents', 'team.yaml');
const bytes = (root: string) => readFileSync(file(root), 'utf8');
const seats = (root: string, team: string) => readState(join(root, '.agents')).sessions[team]?.seats;

function doctor(w: World): DoctorSources {
  return { version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
    herdrVersion: () => '0.7.1', sessionRunning: () => true, agentList: () => [], now: NOW, home: w.home,
    getuid: () => process.getuid?.() ?? 0, runCheck: () => null, standing: () => ({ kind: 'none' }),
    paneText: () => '', watchAlive: () => false, processComm: () => null, watchPane: () => null,
    command: () => ({ status: 0, stdout: '', stderr: '' }) };
}
function launch(w: World): Launch {
  const effect = () => { w.effects.push('launch'); return true; };
  return { sessionState: () => 'running', startServer: effect, sessionUp: () => true,
    createWorkspace: () => { w.effects.push('create'); return { pane: 'synthetic-new', workspace: 'synthetic-new' }; },
    paneRun: effect, renameAgent: effect, closeWorkspace: effect, agentPanes: () => [], agents: () => [],
    paneText: () => '', foreground: () => ['claude'], sleep: async () => {}, now: NOW,
    conversationExists: () => null, applySidebar: () => ({ kind: 'unchanged', reloaded: [], failed: [] }),
    checkSidebarConfig: () => ({ ok: true, text: '' }), reloadSidebar: () => ({ applied: true, text: '' }),
    recordSidebarReload: () => {}, processStartOf: () => null, processInfo: () => null };
}
function downSources(w: World): DownSources {
  const effect = () => { w.effects.push('stop'); return true; };
  const downLaunch: DownLaunch = { typeText: effect, sendKey: effect, pressEnter: effect, agentPanes: () => [],
    closeWorkspace: effect, stopSession: effect, deleteSession: effect, kill: effect, sleep: async () => {}, now: NOW };
  return { home: w.home, ownerSeatStore: w.store, sessionRunning: () => true, agents: () => [],
    alive: () => false, commandOf: () => null, startOf: () => null, cwdOf: () => null,
    screen: () => ({ kind: 'idle' }), screenText: () => '', status: () => 'idle', foreground: () => [],
    shellBack: () => null, foregroundCwd: () => null, processes: () => null, workspacePanes: () => [],
    now: NOW, sleep: async () => {}, standing: () => ({ kind: 'none' }), launch: downLaunch,
    codexEndpoint: { stop: () => ({ stopped: true }) }, inboxRemove: () => null };
}
function restartHost(w: World) {
  const { machine: _machine, codexThreads: _threads, launch: _launch, codexEndpoint: _endpoint, inboxRemove: _inbox, ...base } = restartSources;
  return { ...base, ...downSources(w), sessionState: () => 'running' as const, workspaces: () => [],
    doctor: doctor(w), upLaunch: launch(w) };
}
function addSources(w: World): AddSources {
  return { home: w.home, ownerSeatStore: w.store, sessionState: () => 'absent', agents: () => [],
    workspaces: () => [], doctor: doctor(w), now: NOW, launch: launch(w) };
}
const operations = ['restart', 'remove', 'add', 'down', 'config'] as const;
type Operation = typeof operations[number];
async function invoke(op: Operation, w: World, who: Caller, cwd = w.alpha, extra: string[] = []) {
  const io = testIo(cwd, who);
  const args = [...extra, '--json'];
  let code: number;
  if (op === 'restart') code = await runRestart(['worker', '--dry-run', ...args], io, restartHost(w));
  else if (op === 'remove') code = await runRemove(['worker', ...args], io, downSources(w));
  else if (op === 'add') code = await runAdd(['new-worker', '--like', 'worker', '--dry-run', ...args], io, addSources(w));
  else if (op === 'down') code = await runDown(['--dry-run', ...args], io, downSources(w));
  else code = await runConfig(['set', 'seats.worker.label', 'changed', ...args], io,
    { home: w.home, ownerSeatStore: w.store, now: NOW });
  return { code, text: io.out + io.err, out: io.out, err: io.err };
}
async function charter(w: World, root: string) {
  const io = testIo(root, { kind: 'unplaced', reason: 'synthetic setup' });
  expect(await runSetup(['--signer', 'touch-id', '--team', 'acme', '--roots', root], io,
    { home: w.home, store: w.store, now: NOW }), io.err).toBe(0);
}
function approveAlpha(w: World) {
  const loaded = loadTeamFile(w.alpha, { home: w.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath('alpha', w.alpha, w.home), { approval: approvalOf(loaded.team, loaded.root, NOW()), file: bytes(w.alpha) }, loaded.team.seats, w.home, NOW());
  expect(approvalStanding(w.alpha, w.home).kind).toBe('verified');
  expect(approvalStanding(w.beta, w.home).kind).toBe('none');
}

for (const op of operations) {
  test(`${op}: a recorded outer caller working in a nested team addresses the outer team`, async () => {
    const w = world();
    if (op === 'config') await charter(w, w.beta);
    const alpha = bytes(w.alpha);
    const result = await invoke(op, w, caller());
    expect(result.code, result.text).toBe(0);
    expect(bytes(w.alpha)).toBe(alpha);
    if (op === 'config') expect(bytes(w.beta)).toContain('label: changed');
    else if (op === 'remove') expect(bytes(w.beta)).not.toContain('name: worker');
    else expect(JSON.parse(result.out).project).toBe('beta');
    expect(w.effects).toEqual([]);
  }, 20_000);

  test(`${op}: without a placed caller the nested folder still addresses the inner team`, async () => {
    const w = world();
    const beta = bytes(w.beta);
    const result = await invoke(op, w, OWNER);
    expect(result.code, result.text).toBe(0);
    expect(bytes(w.beta)).toBe(beta);
    if (op === 'config') expect(bytes(w.alpha)).toContain('label: changed');
    else if (op === 'remove') expect(bytes(w.alpha)).not.toContain('name: worker');
    else expect(JSON.parse(result.out).project).toBe('alpha');
    expect(w.effects).toEqual([]);
  }, 20_000);

  test(`${op}: approval and lead status of the cwd team confer no authority over the pane team`, async () => {
    const w = world(false);
    approveAlpha(w);
    const before = [bytes(w.alpha), bytes(w.beta), seats(w.alpha, 'alpha'), seats(w.beta, 'beta')];
    const result = await invoke(op, w, caller());
    expect(result.code, result.text).toBe(1);
    expect([bytes(w.alpha), bytes(w.beta), seats(w.alpha, 'alpha'), seats(w.beta, 'beta')]).toEqual(before);
    expect(w.effects).toEqual([]);
  }, 20_000);

  test(`${op}: a charter covering the cwd team does not admit changes to the pane team`, async () => {
    const w = world(false);
    await charter(w, w.alpha);
    const before = [bytes(w.alpha), bytes(w.beta), seats(w.alpha, 'alpha'), seats(w.beta, 'beta')];
    const result = await invoke(op, w, caller());
    expect(result.code, result.text).toBe(1);
    expect([bytes(w.alpha), bytes(w.beta), seats(w.alpha, 'alpha'), seats(w.beta, 'beta')]).toEqual(before);
    expect(w.effects).toEqual([]);
  }, 20_000);
}

for (const op of ['restart', 'remove', 'add', 'down'] as const) {
  test(`${op}: the owner's explicit file still names that file instead of the cwd`, async () => {
    const w = world();
    const alpha = bytes(w.alpha);
    const result = await invoke(op, w, OWNER, w.alpha, ['--file', file(w.beta)]);
    expect(result.code, result.text).toBe(0);
    expect(bytes(w.alpha)).toBe(alpha);
    if (op === 'remove') expect(bytes(w.beta)).not.toContain('name: worker');
    else expect(JSON.parse(result.out).project).toBe('beta');
    expect(w.effects).toEqual([]);
  }, 20_000);
  test(`${op}: being placed does not grant the owner's explicit-file door`, async () => {
    const w = world();
    const before = [bytes(w.alpha), bytes(w.beta)];
    const result = await invoke(op, w, caller(), w.alpha, ['--file', file(w.alpha)]);
    expect(result.code, result.text).toBe(1);
    expect([bytes(w.alpha), bytes(w.beta)]).toEqual(before);
    expect(w.effects).toEqual([]);
  }, 20_000);
}

for (const scene of ['placed', 'unplaced', 'cwd-approval', 'cwd-charter'] as const) {
  test(`config edit: ${scene} selects the proper record and never opens a refused editor`, async () => {
    const w = world(scene !== 'cwd-approval' && scene !== 'cwd-charter');
    if (scene === 'placed') await charter(w, w.beta);
    if (scene === 'cwd-charter') await charter(w, w.alpha);
    if (scene === 'cwd-approval') approveAlpha(w);
    const before = [bytes(w.alpha), bytes(w.beta)];
    const opened: string[] = [];
    const io = testIo(w.alpha, scene === 'unplaced' ? OWNER : caller());
    const code = await runConfig(['edit', '--json'], io, { home: w.home, ownerSeatStore: w.store, now: NOW,
      editor: path => {
        const text = readFileSync(path, 'utf8');
        opened.push(text);
        writeFileSync(path, text.replace('name: worker\n', 'name: worker\n    label: edited\n'));
        return 0;
      } });
    if (scene === 'placed' || scene === 'unplaced') {
      expect(code, io.out + io.err).toBe(0);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain(`project: ${scene === 'placed' ? 'beta' : 'alpha'}\n`);
      const target = scene === 'placed' ? w.beta : w.alpha;
      const other = scene === 'placed' ? w.alpha : w.beta;
      expect(bytes(target)).toContain('label: edited');
      expect(bytes(other)).toBe(scene === 'placed' ? before[0]! : before[1]!);
    } else {
      expect(code, io.out + io.err).toBe(1);
      expect(opened).toEqual([]);
      expect([bytes(w.alpha), bytes(w.beta)]).toEqual(before);
    }
    expect(w.effects).toEqual([]);
  }, 20_000);
}

test('folder binding stays folder-first while command addressing asks the recorded pane first', () => {
  const w = world();
  const io = testIo(w.alpha, caller());
  const folder = teamBinding(w.home, w.alpha, 'worker', io);
  const command = addressedTeam(w.home, w.alpha, 'worker', io);
  expect(folder.kind).toBe('bound');
  expect(command.kind).toBe('bound');
  if (folder.kind === 'bound') expect(folder.team.root).toBe(w.alpha);
  if (command.kind === 'bound') expect(command.team.root).toBe(w.beta);
});

test('a shared seat name outside every root is still refused without placement', async () => {
  const w = world();
  const io = testIo(w.away, OWNER);
  expect(await runSettings(['worker', '--json'], io, { home: w.home }), io.err).toBe(2);
  for (const root of [w.alpha, w.beta]) expect(io.out).toContain(teamIdOf(root));
  const result = await invoke('restart', w, OWNER, w.away);
  expect(result.code, result.text).toBe(2);
  expect(w.effects).toEqual([]);
});

test('an explicit seat at team address keeps its target when the cwd is another team', () => {
  const w = world();
  const result = resolveTarget(w.home, 'worker@beta', { cwd: w.alpha });
  expect('error' in result, JSON.stringify(result)).toBe(false);
  if (!('error' in result)) expect(result.team.root).toBe(w.beta);
});

for (const op of ['down', 'add', 'config'] as const) {
  test(`${op}: an owner action approved only for Alpha cannot be spent against pane team Beta`, async () => {
    const w = world(false);
    seatOwner(w.home, w.store);
    const action: OwnerAction = op === 'down' ? 'team-down' : op === 'add' ? 'team-add' : 'team-config';
    const words = op === 'down' ? [] : op === 'add' ? ['new-worker', '--like', 'worker'] : ['set', 'seats.worker.label', 'changed'];
    const request = createOwnerActionRequest(w.home, { actions: [action], root: w.alpha, team: 'alpha', head: null,
      args: { [action]: words }, requestedBy: 'caller' }, NOW(), () => {});
    if (!request.ok) throw new Error(request.why);
    expect(approveOwnerAction(w.home, request.record.request_id, 'always', w.store, NOW()).ok).toBe(true);
    const before = [bytes(w.alpha), bytes(w.beta), seats(w.beta, 'beta')];
    const result = await invoke(op, w, caller(), w.alpha, ['--approval', request.record.request_id]);
    expect(result.code, result.text).toBe(1);
    expect([bytes(w.alpha), bytes(w.beta), seats(w.beta, 'beta')]).toEqual(before);
    expect(w.effects).toEqual([]);
  }, 20_000);
}

function clientGrant(w: World) {
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(w.home, 'grok-bot');
  const keys = writeClientKeyFiles(keyDir, pair);
  if (!keys.ok) throw new Error(keys.why);
  const id = 'cg_' + 'a'.repeat(24);
  const grant = { grant_id: id, client_id: 'grok-bot', entity: 'floor', public_key: pair.publicKey,
    key_id: pair.keyId, key_dir: keyDir, bundle: 'manager',
    allowed_ops: ['status', 'down', 'restart', 'add', 'remove'], seats: [],
    issued: NOW().toISOString(), expires: new Date(NOW().getTime() + 86_400_000).toISOString(),
    vocabulary: CLIENT_MANAGER_VOCABULARY_VERSION,
    team: { project: 'beta', team_id: teamIdOf(w.beta), root: w.beta } };
  const signature = signDomain(CLIENT_GRANT_DOMAIN, { name: id, client_grant: grant }, keyOf(w.home));
  mkdirSync(clientGrantsFolder(w.home), { recursive: true });
  writeFileSync(clientGrantPath(w.home, id), JSON.stringify({ client_grant: grant, signature }));
  const read = readClientUpGrant(w.home, id);
  expect(read.ok, JSON.stringify(read)).toBe(true);
  return ['--client', clientGrantPath(w.home, id), '--key', keys.keyPath, '--team', 'beta'];
}

for (const op of ['restart', 'remove', 'add', 'down'] as const) {
  test(`${op}: a valid client outside the host still addresses its signed team from another cwd`, async () => {
    const w = world();
    const args = clientGrant(w);
    const alpha = bytes(w.alpha);
    const result = await invoke(op, w, { kind: 'owner-no-tty' }, w.alpha, args);
    expect(result.code, result.text).toBe(0);
    expect(bytes(w.alpha)).toBe(alpha);
    if (op === 'remove') expect(bytes(w.beta)).not.toContain('name: worker');
    else expect(JSON.parse(result.out).project).toBe('beta');
    expect(w.effects).toEqual([]);
  }, 20_000);

  test(`${op}: a recorded pane still cannot use a client key`, async () => {
    const w = world();
    const args = clientGrant(w);
    const before = [bytes(w.alpha), bytes(w.beta)];
    const result = await invoke(op, w, caller(), w.alpha, args);
    expect(result.code, result.text).toBe(1);
    expect(result.text).toContain('a client key is not used from inside a team pane');
    expect([bytes(w.alpha), bytes(w.beta)]).toEqual(before);
    expect(w.effects).toEqual([]);
  }, 20_000);
}
