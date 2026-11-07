// Independent scenes for hosting a running team that has a lobby and no checkout root.
// Discovery, the added-root notice and a daemon started from that discovery share one
// answer. The home and the registry are synthetic. Send and bus listeners are not started.
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import { startMachineDaemon, type MachineDaemon } from '../src/daemon/host.ts';
import { registryHosting, rootsFromAddedNotice, runningRegistryRoots } from '../src/daemon/registry-roots.ts';
import { canonicalRoot } from '../src/daemon/routes.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readTeams, teamIdOf, upsertTeam, type TeamLifecycle } from '../src/registry/teams.ts';
import { TEAM_CONFIG_RECORD_FORMAT, writeStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-07T18:30:00.000Z');
const SESSION = 'box';
const UNREADABLE = 'the recorded folder has no readable team configuration';
const DIFFERENT = 'the recorded folder belongs to a different team or session';
const roots: string[] = [];

afterEach(() => {
  const owned = roots.splice(0);
  discardFixtures(owned, { roots: owned.map(dirname) });
});

function teamYaml(project: string): string {
  return `format: 1
project: ${project}
session: ${SESSION}
operator: cobble
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: pebble
    cli: muse
    vendor: floor
    model: Pebble
    version: "1.0"
    launch: muse
    leads: true
  - role: operator
    name: cobble
    cli: muse
    vendor: floor
    model: Cobble
    version: "1.0"
    launch: muse
`;
}

function ground(): { base: string; home: string } {
  const base = fixtureBase('lobby-host-');
  roots.push(base);
  const home = join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  const parsed = validateTeamFile(teamYaml('box'));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return { base, home };
}

function hostedRoot(path: string): string {
  const canonical = canonicalRoot(path);
  if (canonical === null) throw new Error(`the folder cannot be resolved: ${path}`);
  return canonical;
}

function folder(base: string, name: string): string {
  const path = join(base, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(join(path, '.agents'), { mode: 0o700 });
  return path;
}

function plant(dir: string, project: string): void {
  writeFileSync(join(dir, '.agents', 'team.yaml'), teamYaml(project));
}

function row(
  home: string,
  id: string,
  project: string,
  lobby: string,
  lifecycle: TeamLifecycle,
  root: string,
): void {
  upsertTeam(home, id, {
    project,
    session: SESSION,
    root: root === '' ? lobby : root,
    lobby,
    entity: null,
    lifecycle,
    roster: [
      { agent: 'muse', seat: 'pebble', role: 'orchestrator', leads: true },
      { agent: 'muse', seat: 'cobble', role: 'operator' },
    ],
  });
  if (root === '') upsertTeam(home, id, { root: '' });
}

function registryBytes(home: string): string {
  const teams = join(home, '.config', 'team', 'teams.yaml');
  const store = join(home, '.config', 'team', 'team-config');
  const files: string[] = [];
  if (existsSync(store)) {
    for (const name of readdirSync(store).sort()) files.push(`${name}\0${readFileSync(join(store, name), 'utf8')}`);
  }
  return `${existsSync(teams) ? readFileSync(teams, 'utf8') : ''}\n${files.join('\n')}`;
}

async function openHost(home: string, hosted: string[], heartbeatMs = 60_000): Promise<MachineDaemon> {
  const before = registryBytes(home);
  const started = await startMachineDaemon({
    home,
    roots: hosted,
    rootsFromRegistry: true,
    runningRoots: () => runningRegistryRoots(readTeams(home), home).map((one) => one.root),
    version: '1.0',
    gitHead: null,
    now: () => NOW,
    heartbeatMs,
    sendStart: async () => ({ kind: 'bind-failed', reason: 'held' }),
    initialBusStart: async () => ({ kind: 'bind-failed' }),
  });
  expect(registryBytes(home)).toBe(before);
  if (started.kind !== 'serving') throw new Error(started.kind === 'bind-failed' ? started.reason : started.kind);
  return started.daemon;
}

test('a running lobby-only row whose lobby resolves is hosted once', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  plant(lobby, 'box');
  const id = 'a11ce0000001';
  expect(id).not.toBe(teamIdOf(lobby));
  row(home, id, 'box', lobby, 'running', '');
  const found = registryHosting(readTeams(home), home);
  const canonical = hostedRoot(lobby);
  expect(found.roots.map((one) => one.root)).toEqual([canonical]);
  expect(found.skipped).toEqual([]);
  expect(runningRegistryRoots(readTeams(home), home)).toEqual(found.roots);
  expect(rootsFromAddedNotice(readTeams(home), { op: 'root.added', root: lobby })).toEqual(found.roots);
  const daemon = await openHost(home, found.roots.map((one) => one.root));
  try {
    expect(daemon.routes.map((route) => route.root)).toEqual([canonical]);
  } finally {
    await daemon.close();
  }
});

test('a lobby-only row and a rooted row for the same team are hosted once', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  const checkout = folder(base, 'checkout');
  plant(lobby, 'box');
  plant(checkout, 'box');
  row(home, 'a11ce0000001', 'box', lobby, 'running', '');
  row(home, teamIdOf(checkout), 'box', lobby, 'running', checkout);
  const found = registryHosting(readTeams(home), home);
  expect(found.roots.map((one) => one.root)).toEqual([hostedRoot(checkout)]);
  expect(found.skipped).toEqual([]);
  const daemon = await openHost(home, found.roots.map((one) => one.root));
  try {
    expect(daemon.routes).toHaveLength(1);
    expect(daemon.routes[0]?.root).toBe(hostedRoot(checkout));
  } finally {
    await daemon.close();
  }
});

test('a lobby that resolves to a different team is not hosted and status names the reason', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  plant(lobby, 'crate');
  row(home, 'b22ce0000002', 'box', lobby, 'running', '');
  const found = registryHosting(readTeams(home), home);
  expect(found.roots).toEqual([]);
  expect(found.skipped).toEqual([{ id: 'b22ce0000002', team: 'box', session: SESSION, lobby, why: DIFFERENT }]);
  const io = testIo(home, { kind: 'owner' });
  expect(await runDaemon(['status'], io, { home, now: () => NOW })).toBe(0);
  expect(io.out).toContain(`skipped team box (${SESSION}): ${DIFFERENT}`);
  const json = testIo(home, { kind: 'owner' });
  expect(await runDaemon(['status', '--json'], json, { home, now: () => NOW })).toBe(0);
  expect(JSON.parse(json.out).skippedTeams).toEqual(found.skipped);
});

test('a stopped or archived lobby-only row is not hosted', () => {
  const { base, home } = ground();
  const stopped = folder(base, 'stopped');
  const archived = folder(base, 'archived');
  plant(stopped, 'box');
  plant(archived, 'box');
  row(home, 'c33ce0000003', 'box', stopped, 'stopped', '');
  row(home, 'd44ce0000004', 'box', archived, 'archived', '');
  const found = registryHosting(readTeams(home), home);
  expect(found.roots).toEqual([]);
  expect(found.skipped).toEqual([]);
});

test('a missing lobby, a linked team file and a lobby that is a file are named and not hosted', async () => {
  const { base, home } = ground();
  const missing = join(base, 'missing');
  const linked = folder(base, 'linked');
  const target = join(base, 'elsewhere.yaml');
  writeFileSync(target, teamYaml('box'));
  symlinkSync(target, join(linked, '.agents', 'team.yaml'));
  const file = join(base, 'not-a-folder');
  writeFileSync(file, 'not a folder\n');
  row(home, 'e55ce0000005', 'missing', missing, 'running', '');
  row(home, 'e55ce0000006', 'linked', linked, 'running', '');
  row(home, 'e55ce0000007', 'filed', file, 'running', '');
  const found = registryHosting(readTeams(home), home);
  expect(found.roots).toEqual([]);
  expect(found.skipped.map((one) => one.why)).toEqual([UNREADABLE, UNREADABLE, UNREADABLE]);
  const io = testIo(home, { kind: 'owner' });
  expect(await runDaemon(['status'], io, { home, now: () => NOW })).toBe(0);
  for (const name of ['missing', 'linked', 'filed']) {
    expect(io.out).toContain(`skipped team ${name} (${SESSION}): ${UNREADABLE}`);
  }
  const json = testIo(home, { kind: 'owner' });
  expect(await runDaemon(['status', '--json'], json, { home, now: () => NOW })).toBe(0);
  expect(JSON.parse(json.out).skippedTeams).toEqual(found.skipped);
});

test('discovery writes nothing to the registry', () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  plant(lobby, 'box');
  row(home, 'a11ce0000001', 'box', lobby, 'running', '');
  const before = registryBytes(home);
  const teams = readTeams(home);
  registryHosting(teams, home);
  runningRegistryRoots(teams, home);
  rootsFromAddedNotice(teams, { op: 'root.added', root: lobby });
  expect(registryBytes(home)).toBe(before);
});

test('a stored root that is missing still hosts the valid lobby', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  plant(lobby, 'box');
  const id = 'a11ce0000001';
  row(home, id, 'box', lobby, 'running', '');
  const text = teamYaml('box');
  writeStoredTeamConfig(home, {
    format: TEAM_CONFIG_RECORD_FORMAT,
    id,
    root: join(base, 'gone'),
    text,
    text_sha256: createHash('sha256').update(text).digest('hex'),
    record_version: 'team-record-c14n-v1',
    record_sha256: createHash('sha256').update(text).digest('hex'),
  });
  const found = registryHosting(readTeams(home), home);
  expect(found.roots.map((one) => one.root)).toEqual([hostedRoot(lobby)]);
  expect(found.skipped).toEqual([]);
  const daemon = await openHost(home, found.roots.map((one) => one.root));
  try {
    expect(daemon.routes.map((route) => route.root)).toEqual([hostedRoot(lobby)]);
  } finally {
    await daemon.close();
  }
});

test('a checkout row that arrives after the lobby is hosted does not add a route', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  plant(lobby, 'box');
  const id = 'a11ce0000001';
  expect(id).not.toBe(teamIdOf(lobby));
  row(home, id, 'box', lobby, 'running', '');
  const first = registryHosting(readTeams(home), home);
  const daemon = await openHost(home, first.roots.map((one) => one.root), 40);
  try {
    expect(daemon.routes.map((route) => route.root)).toEqual([hostedRoot(lobby)]);
    const checkout = folder(base, 'checkout');
    plant(checkout, 'box');
    row(home, teamIdOf(checkout), 'box', lobby, 'running', checkout);
    const later = registryHosting(readTeams(home), home);
    expect(later.roots.map((one) => one.root)).toEqual([hostedRoot(checkout)]);
    expect(rootsFromAddedNotice(readTeams(home), { op: 'root.added', root: checkout })).toEqual(later.roots);
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(daemon.routes).toHaveLength(1);
    expect(daemon.routes[0]?.root).toBe(hostedRoot(lobby));
    const live = daemon.roots.map((one) => one.root);
    expect(live).toContain(hostedRoot(lobby));
    expect(live).not.toContain(hostedRoot(checkout));
  } finally {
    await daemon.close();
  }
});

test('two adoptions of the same team in one pass produce one route', async () => {
  const { base, home } = ground();
  const lobby = folder(base, 'lobby');
  const checkout = folder(base, 'checkout');
  plant(lobby, 'box');
  plant(checkout, 'box');
  const id = 'a11ce0000001';
  expect(id).not.toBe(teamIdOf(lobby));
  row(home, id, 'box', lobby, 'running', '');
  row(home, teamIdOf(checkout), 'box', lobby, 'running', checkout);
  const daemon = await openHost(home, [lobby, checkout]);
  try {
    expect(daemon.routes).toHaveLength(1);
    expect(daemon.routes[0]?.team).toBe('box');
    expect(daemon.routes[0]?.session).toBe(SESSION);
  } finally {
    await daemon.close();
  }
});
