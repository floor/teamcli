import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import { rootsFromAddedNotice, runningRegistryRoots } from '../src/daemon/registry-roots.ts';
import { darwinServiceManager } from '../src/daemon/service-darwin.ts';
import { startMachineDaemon, type StartMachineDaemonInput } from '../src/daemon/host.ts';
import { noteTeam, readTeams, teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { sha256, teamConfigRecordPath, writeStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { testIo } from './helpers.ts';

const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

const LOBBY_TEAM = `format: 1
project: acme
session: acme
coordinator: clerk
operator: clerk
workspace:
  mode: shared
seats:
  - name: clerk
    role: coordinator
    cli: claude-code
    vendor: synthetic
    model: Test
    version: "1"
    launch: claude
`;

function lobbyTeam(lifecycle: 'running' | 'stopped' | 'archived' = 'running') {
  const { home, root } = temp();
  const lobby = join(home, 'team-lobby');
  mkdirSync(join(lobby, '.agents'), { recursive: true });
  writeFileSync(join(lobby, '.agents/team.yaml'), LOBBY_TEAM);
  const id = teamIdOf(join(home, 'registry-row'));
  upsertTeam(home, id, { root: lobby, lobby, project: 'acme', session: 'acme', entity: null, lifecycle });
  upsertTeam(home, id, { root: '' });
  return { home, root, lobby, id };
}

function lobbyHost(home: string): NonNullable<StartMachineDaemonInput['sendHost']> {
  const refuse = (): never => { throw new Error('no live terminal host in lobby hosting tests'); };
  return { home, agents: () => [], processInfo: () => null, socketsDir: join(home, 'sockets'),
    deliver: async () => refuse(), now: () => new Date(),
    native: { typeText: refuse, pressEnter: refuse, status: refuse, wait: async () => refuse() } };
}

describe('lobby-only daemon discovery', () => {
  test('a running lobby-only team participates in the same registry root scan', () => {
    const { home, lobby } = lobbyTeam();
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([{ root: lobby, source: 'registry' }]);
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
  });

  test.each(['stopped', 'archived'] as const)('a %s lobby-only team is hosted unless archived', (lifecycle) => {
    const { home, lobby } = lobbyTeam(lifecycle);
    expect(runningRegistryRoots(readTeams(home), home)).toEqual(lifecycle === 'archived' ? [] : [{ root: lobby, source: 'registry' }]);
  });

  test('the matching checkout row supersedes the lobby-only row', () => {
    const { home, root, lobby } = lobbyTeam();
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, '.agents/team.yaml'), LOBBY_TEAM);
    upsertTeam(home, teamIdOf(root), { root, lobby, project: 'acme', session: 'acme', entity: null, lifecycle: 'running' });
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([{ root, source: 'registry' }]);
  });

  test.each([false, true])('real host serves the discovered team once (checkout row: %s)', async (checkout) => {
    const { home, root, lobby } = lobbyTeam();
    if (checkout) {
      mkdirSync(join(root, '.agents'));
      writeFileSync(join(root, '.agents/team.yaml'), LOBBY_TEAM);
      upsertTeam(home, teamIdOf(root), { root, lobby, project: 'acme', session: 'acme', entity: null, lifecycle: 'running' });
    }
    const hosted = checkout ? root : lobby;
    const started = await startMachineDaemon({
      home, roots: runningRegistryRoots(readTeams(home), home).map((one) => one.root),
      rootsFromRegistry: true, version: 'test', restoreSweep: false, heartbeatMs: 10_000,
      sendHost: lobbyHost(home),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      expect(started.daemon.routes).toHaveLength(1);
      expect(started.daemon.routes[0]).toMatchObject({ root: hosted, team: 'acme', session: 'acme' });
      expect(started.daemon.roots).toHaveLength(1);
      expect(started.daemon.roots[0]).toMatchObject({ root: hosted, send: 'serving', bus: 'serving', source: 'registry' });
    } finally { await started.daemon.close(); }
  });

  test('a later checkout row does not start a second host beside the running lobby route', async () => {
    const { home, root, lobby } = lobbyTeam();
    let scans = 0;
    const started = await startMachineDaemon({
      home, roots: [lobby], rootsFromRegistry: true, version: 'test', restoreSweep: false,
      heartbeatMs: 20, sendHost: lobbyHost(home),
      runningRoots: () => { scans++; return runningRegistryRoots(readTeams(home), home).map((one) => one.root); },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      mkdirSync(join(root, '.agents'));
      writeFileSync(join(root, '.agents/team.yaml'), LOBBY_TEAM);
      upsertTeam(home, teamIdOf(root), { root, lobby, project: 'acme', session: 'acme', entity: null, lifecycle: 'running' });
      expect(runningRegistryRoots(readTeams(home), home).map((one) => one.root)).toEqual([root]);
      scans = 0;
      const deadline = Date.now() + 2500;
      while (scans < 3 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
      expect(scans).toBeGreaterThanOrEqual(3);
      expect(started.daemon.roots).toHaveLength(1);
      expect(started.daemon.roots[0]).toMatchObject({ root: lobby, send: 'serving', bus: 'serving' });
    } finally { await started.daemon.close(); }
  });

  test('an unavailable stored root still tries the recorded lobby', () => {
    const { home, lobby, id } = lobbyTeam();
    writeStoredTeamConfig(home, { format: 1, id, root: join(home, 'gone'), text: LOBBY_TEAM,
      text_sha256: sha256(LOBBY_TEAM), record_version: 'team-record-c14n-v1', record_sha256: 'synthetic' });
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([{ root: lobby, source: 'registry' }]);
  });

  test('a stored definition recovers the missing root without rewriting the registry', () => {
    const { home, root, lobby, id } = lobbyTeam();
    // The definition is keyed by the original root, whose registry row lost that field.
    const key = teamIdOf(root);
    upsertTeam(home, id, { lifecycle: 'archived' });
    upsertTeam(home, key, { root, lobby, project: 'acme', session: 'acme', entity: null, lifecycle: 'running' });
    upsertTeam(home, key, { root: '' });
    writeStoredTeamConfig(home, { format: 1, id: key, root, text: LOBBY_TEAM,
      text_sha256: sha256(LOBBY_TEAM), record_version: 'team-record-c14n-v1', record_sha256: 'synthetic' });
    const before = readFileSync(teamsFile(home), 'utf8');
    const source = process.env.TEAM_CONFIG_SOURCE;
    process.env.TEAM_CONFIG_SOURCE = 'registry';
    try {
      expect(runningRegistryRoots(readTeams(home), home)).toEqual([{ root, source: 'registry' }]);
      expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    } finally {
      if (source === undefined) delete process.env.TEAM_CONFIG_SOURCE;
      else process.env.TEAM_CONFIG_SOURCE = source;
    }
  });

  test('service startup and its later rescan include the lobby-only team', async () => {
    const { home, root, lobby } = lobbyTeam();
    const seen: StartMachineDaemonInput[] = [];
    const io = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['run', '--started-by', 'service-manager'], io, {
      home, accountHome: home, start: async (input) => { seen.push(input); return { kind: 'already-running', pid: 42 }; },
    })).toBe(0);
    expect(seen[0]?.roots).toEqual([lobby]);
    expect(seen[0]?.runningRoots?.()).toEqual([lobby]);
    const later = join(home, 'later-lobby');
    mkdirSync(join(later, '.agents'), { recursive: true });
    writeFileSync(join(later, '.agents/team.yaml'), LOBBY_TEAM.replaceAll('acme', 'later'));
    upsertTeam(home, teamIdOf(later), { root: later, lobby: later, project: 'later', session: 'later', entity: null, lifecycle: 'running' });
    upsertTeam(home, teamIdOf(later), { root: '' });
    expect(seen[0]?.runningRoots?.()).toEqual([later, lobby].sort());
  });

  test('status names each unresolvable running team and its reason in text and JSON', async () => {
    const { home, root, lobby, id } = lobbyTeam();
    writeFileSync(join(lobby, '.agents/team.yaml'), 'format: [\n');
    upsertTeam(home, '111111111111', { root, lobby: '', project: 'nowhere', session: 'nowhere', lifecycle: 'running' });
    upsertTeam(home, '111111111111', { root: '' });
    const json = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status', '--json'], json, { home, reminders: () => ({ specs: [] }) })).toBe(0);
    expect(JSON.parse(json.out).skippedTeams).toEqual(expect.arrayContaining([
      { id, team: 'acme', session: 'acme', lobby, why: 'the recorded folder has no readable team configuration' },
      { id: '111111111111', team: 'nowhere', session: 'nowhere', lobby: '', why: 'no root or lobby is recorded' },
    ]));
    expect(JSON.parse(json.out).skippedTeams).toHaveLength(2);
    const text = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status'], text, { home })).toBe(0);
    expect(text.out).toContain('skipped team acme (acme): the recorded folder has no readable team configuration');
    expect(text.out).toContain('skipped team nowhere (nowhere): no root or lobby is recorded');
  });

  test('a shared lobby cannot attach a row to another team or session', async () => {
    const { home, root, id } = lobbyTeam();
    upsertTeam(home, id, { project: 'different', session: 'different' });
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([]);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status', '--json'], io, { home, reminders: () => ({ specs: [] }) })).toBe(0);
    expect(JSON.parse(io.out).skippedTeams[0]).toMatchObject({ team: 'different', why: 'the recorded folder belongs to a different team or session' });
  });

  test('two running teams sharing a lobby recover the lobby-only team from its own recorded checkout', () => {
    const { home, root, lobby, id } = lobbyTeam();
    // The shared lobby belongs to the rooted team. The other team has a separate checkout
    // recorded by an older row, while its current running row carries only the common lobby.
    writeFileSync(join(lobby, '.agents/team.yaml'), LOBBY_TEAM.replaceAll('acme', 'shared'));
    upsertTeam(home, teamIdOf(lobby), { root: lobby, lobby, project: 'shared', session: 'shared', entity: null, lifecycle: 'running' });
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, '.agents/team.yaml'), LOBBY_TEAM);
    upsertTeam(home, teamIdOf(root), { root, lobby, project: 'acme', session: 'acme', entity: null, lifecycle: 'defined' });
    const before = readFileSync(teamsFile(home), 'utf8');
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([root, lobby].sort().map((root) => ({ root, source: 'registry' })));
    expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    expect(readTeams(home)[id]?.lifecycle).toBe('running');
  });

  test('two running teams sharing a lobby name the lobby-only row when its own root is unavailable', async () => {
    const { home, root, lobby, id } = lobbyTeam();
    writeFileSync(join(lobby, '.agents/team.yaml'), LOBBY_TEAM.replaceAll('acme', 'shared'));
    upsertTeam(home, teamIdOf(lobby), { root: lobby, lobby, project: 'shared', session: 'shared', entity: null, lifecycle: 'running' });
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([{ root: lobby, source: 'registry' }]);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status', '--json'], io, { home, reminders: () => ({ specs: [] }) })).toBe(0);
    expect(JSON.parse(io.out).skippedTeams).toEqual([{ id, team: 'acme', session: 'acme', lobby,
      why: 'the recorded folder belongs to a different team or session' }]);
    const text = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status'], text, { home })).toBe(0);
    expect(text.out).toContain('skipped team acme (acme): the recorded folder belongs to a different team or session');
  });

  test('an unreadable stored definition is named rather than bypassed through the lobby file', async () => {
    const { home, root, id } = lobbyTeam();
    const record = teamConfigRecordPath(home, id);
    mkdirSync(join(record, '..'), { recursive: true });
    writeFileSync(record, '{');
    expect(runningRegistryRoots(readTeams(home), home)).toEqual([]);
    const io = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status', '--json'], io, { home, reminders: () => ({ specs: [] }) })).toBe(0);
    expect(JSON.parse(io.out).skippedTeams[0]).toMatchObject({ team: 'acme', why: 'the registered team definition cannot be read' });
  });

  test('status reports an unreadable registry instead of claiming no teams were skipped', async () => {
    const { home, root } = lobbyTeam();
    writeFileSync(teamsFile(home), 'teams: [\n');
    const io = testIo(root, { kind: 'owner' });
    expect(await runDaemon(['status', '--json'], io, { home, reminders: () => ({ specs: [] }) })).toBe(0);
    expect(JSON.parse(io.out).registryError).toBe('the team registry cannot be read; skipped teams are unknown');
  });
});

function temp(): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fm-roots-')));
  bases.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  return { home, root };
}

describe('dynamic daemon roots', () => {
  test('existing running, defined and stopped registry roots are hosted; archived roots are not', () => {
    const { home } = temp();
    const roots = ['a', 'b', 'c', 'd', 'e'].map((name) => join(home, name));
    for (const root of roots) mkdirSync(root);
    expect(runningRegistryRoots({
      a: { root: roots[0]!, lifecycle: 'running' },
      b: { root: roots[1]!, lifecycle: 'defined' },
      c: { root: roots[2]!, lifecycle: 'running' },
      d: { root: roots[3]!, lifecycle: 'stopped' },
      e: { root: roots[4]!, lifecycle: 'archived' },
    })).toEqual(roots.slice(0, 4).map((root) => ({ root, source: 'registry' })));
  });

  test('root.added hosts existing registered roots even when they are not marked running', () => {
    const { home } = temp();
    const a = join(home, 'a');
    const b = join(home, 'b');
    mkdirSync(a); mkdirSync(b);
    const teams = {
      a: { root: a, lifecycle: 'running' },
      b: { root: b, lifecycle: 'defined' },
    };
    expect(rootsFromAddedNotice(teams, { op: 'health' })).toBeNull();
    expect(rootsFromAddedNotice(teams, { op: 'root.added', root: b })).toEqual([
      { root: a, source: 'registry' }, { root: b, source: 'registry' },
    ]);
    teams.b = { root: b, lifecycle: 'stopped' };
    expect(rootsFromAddedNotice(teams, { op: 'root.added', root: b })).toEqual([
      { root: a, source: 'registry' }, { root: b, source: 'registry' },
    ]);
  });

  test('a rescan lands a registered team a missed notice never named', () => {
    const { home } = temp();
    const a = join(home, 'a'); const late = join(home, 'late'); const parked = join(home, 'parked');
    for (const root of [a, late, parked]) mkdirSync(root);
    const scanned = runningRegistryRoots({
      a: { root: a, lifecycle: 'running' },
      late: { root: late, lifecycle: 'running' },
      parked: { root: parked, lifecycle: 'defined' },
    });
    expect(scanned.map((one) => one.root)).toEqual([a, late, parked]);
    expect(scanned.every((one) => one.source === 'registry')).toBe(true);
  });

  test('a stopped row with an existing root is hosted without changing its lifecycle', async () => {
    const { home, lobby, id } = lobbyTeam('stopped');
    upsertTeam(home, id, { root: lobby });
    const before = readFileSync(teamsFile(home), 'utf8');
    const started = await startMachineDaemon({ home, roots: runningRegistryRoots(readTeams(home), home).map((one) => one.root),
      rootsFromRegistry: true, version: 'test', restoreSweep: false, heartbeatMs: 10_000, sendHost: lobbyHost(home) });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      expect(started.daemon.routes).toEqual([expect.objectContaining({ root: lobby, team: 'acme', session: 'acme' })]);
      expect(started.daemon.roots).toEqual([expect.objectContaining({ root: lobby, send: 'serving', bus: 'serving' })]);
      expect(readFileSync(teamsFile(home), 'utf8')).toBe(before);
    } finally { await started.daemon.close(); }
  });

  test('missing registry folders never create failed endpoints on repeated heartbeats', async () => {
    const { home, root } = temp();
    const gone = join(home, 'gone');
    const file = join(home, 'file'); writeFileSync(file, 'not a folder');
    const teams = { gone: { root: gone, lifecycle: 'stopped' }, file: { root: file, lifecycle: 'running' } };
    expect(runningRegistryRoots(teams, home)).toEqual([]);
    let scans = 0; let starts = 0;
    const started = await startMachineDaemon({ home, roots: [], rootsFromRegistry: true, version: 'test', restoreSweep: false,
      heartbeatMs: 20, sendHost: lobbyHost(home), sendStart: async () => { starts++; return { kind: 'bind-failed', reason: 'unexpected' }; },
      runningRoots: () => { scans++; return runningRegistryRoots(teams, home).map((one) => one.root); } });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const deadline = Date.now() + 2500;
      while (scans < 3 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
      expect(scans).toBeGreaterThanOrEqual(3);
      expect(starts).toBe(0);
      expect(started.daemon.roots).toEqual([]);
      expect(started.daemon.routes).toEqual([]);
    } finally { await started.daemon.close(); }
  });

  test('the unit argument list carries no --root', () => {
    const { home } = temp();
    const folder = join(home, 'app');
    mkdirSync(folder, { recursive: true });
    const entry = join(folder, 'cli.js');
    writeFileSync(entry, 'synthetic entry\n');
    const manager = darwinServiceManager({
      runner: () => ({ status: 0, stdout: '', stderr: '' }),
      uid: 501,
      accountHome: home,
    });
    const unit = manager.install(home, {
      execPath: '/runtime/bin/node',
      entry,
      roots: ['/repo/a', '/repo/b'],
    });
    expect(unit.ok).toBe(true);
    if (!unit.ok) return;
    const text = readFileSync(unit.unitPath, 'utf8');
    expect(text).not.toContain('--root');
    expect(text).not.toContain('/repo/a');
    expect(text).toContain('service-manager');
  });

  test('a service start with no --root hosts registered teams across active lifecycles', async () => {
    const { home, root } = temp();
    const other = join(root, '..', 'other');
    mkdirSync(other, { recursive: true });
    expect(noteTeam(home, root, { project: 'acme', entity: null, session: 'acme', lobby: null }, 'running', 'owner')).toBeNull();
    expect(noteTeam(home, other, { project: 'other', entity: null, session: 'other', lobby: null }, 'defined', 'owner')).toBeNull();
    const seen: StartMachineDaemonInput[] = [];
    const io = testIo(root, { kind: 'owner' });
    const code = await runDaemon(['run', '--started-by', 'service-manager'], io, {
      home,
      accountHome: home,
      start: async (input) => {
        seen.push(input);
        return { kind: 'already-running', pid: 42 };
      },
    });
    expect(code).toBe(0);
    expect(seen[0]?.roots).toEqual([root, other].sort());
    expect(seen[0]?.rootsFromRegistry).toBe(true);
    expect(seen[0]?.runningRoots?.()).toEqual([root, other].sort());
    expect(io.out).toContain('already running');
  });
});
