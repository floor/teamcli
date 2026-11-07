import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parkInRuntimeTrash } from '../../src/file/runtime-trash.ts';
import * as state from '../../src/state.ts';
import * as projects from '../../src/registry/projects.ts';
import { forgetTeam, getTeam, noteTeam, teamsFile, teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import { enterRunMemo, leaveRunMemo } from '../../src/run-memo.ts';
import { runProjects } from '../../src/commands/projects.ts';
import { testIo } from '../helpers.ts';
import { withRegistryLock, withTeamProjectsLocks } from '../../src/registry/locks.ts';

let home: string;
const seed = { project: 'team-x', session: 'team-x', root: '/tmp/root-a' };
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'project-membership-')); });
afterEach(() => { leaveRunMemo(); parkInRuntimeTrash(home, dirname(home), new Date()); });

test('project views and the command derive home and served membership from teams', async () => {
  projects.upsertProject(home, 'home-a', { name: 'Home A', teams: ['stale-id'] });
  projects.upsertProject(home, 'served-a', { name: 'Served A' });
  upsertTeam(home, 'team-x', { ...seed, projectId: 'home-a', projects: ['home-a', 'served-a'] } as never);
  expect(projects.get(home, 'home-a')?.teams).toEqual(['team-x']);
  expect(projects.byName(home, 'Served A')?.teams).toEqual(['team-x']);
  expect(projects.ofTeam(home, 'team-x')?.id).toBe('home-a');
  const io = testIo('/tmp/root-a', { kind: 'owner' });
  expect(await runProjects(['--json'], io, {
    list: () => projects.list(home), byName: key => projects.byName(home, key), ofTeam: id => projects.ofTeam(home, id),
  })).toBe(0);
  expect(JSON.parse(io.out).projects.map((p: projects.ProjectRecord) => p.teams)).toEqual([['team-x'], ['team-x']]);
});

test('leaving a served project and then the home changes only the team record', () => {
  for (const id of ['home-a', 'served-a']) projects.upsertProject(home, id, { name: id });
  upsertTeam(home, 'team-x', { ...seed, projectId: 'home-a', projects: ['home-a', 'served-a'] } as never);
  const before = readFileSync(projects.projectsFile(home), 'utf8');
  enterRunMemo();
  expect(projects.get(home, 'served-a')?.teams).toEqual(['team-x']);
  upsertTeam(home, 'team-x', { projects: ['home-a'] } as never);
  expect(projects.get(home, 'served-a')?.teams).toEqual([]);
  upsertTeam(home, 'team-x', { projectId: null, projects: [] } as never);
  expect(projects.get(home, 'home-a')?.teams).toEqual([]);
  expect(projects.ofTeam(home, 'team-x')).toBeNull();
  expect(readFileSync(projects.projectsFile(home), 'utf8')).toBe(before);
});

test('legacy records without projects read the home as their only membership', () => {
  upsertTeam(home, 'team-x', { ...seed, projectId: 'home-a' });
  const path = teamsFile(home);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^    projects:.*\n/gm, ''));
  expect((getTeam(home, 'team-x') as { projects?: string[] })?.projects).toEqual(['home-a']);
  upsertTeam(home, 'team-y', { ...seed, projectId: null });
  expect((getTeam(home, 'team-y') as { projects?: string[] })?.projects).toEqual([]);
});

test('a throw immediately after the team write leaves project reads consistent', () => {
  const original = state.writeAtomic;
  const root = join(home, 'root-a');
  mkdirSync(root);
  const injected = spyOn(state, 'writeAtomic').mockImplementation((path, text, options) => {
    original(path, text, options);
    if (path === teamsFile(home)) throw new Error('injected after team write');
  });
  try {
    expect(noteTeam(home, root, { ...seed, entity: null, lobby: null, inProject: 'Home A' }, 'defined', 'test')).toContain('injected');
  } finally { injected.mockRestore(); }
  const before = readFileSync(projects.projectsFile(home), 'utf8');
  expect(projects.get(home, 'home-a')?.teams).toEqual([teamIdOf(root)]);
  expect(projects.ofTeam(home, teamIdOf(root))?.id).toBe('home-a');
  expect(readFileSync(projects.projectsFile(home), 'utf8')).toBe(before);
});

test('forgetting a team removes it from every project view', () => {
  projects.upsertProject(home, 'home-a', { name: 'Home A' });
  upsertTeam(home, 'team-x', { ...seed, projectId: 'home-a' });
  forgetTeam(home, 'team-x');
  expect(projects.get(home, 'home-a')?.teams).toEqual([]);
});

test('both locks follow one order, nested writes reuse them, and throws release them', () => {
  expect(() => withRegistryLock(home, 'projects', () => upsertTeam(home, 'team-x', seed))).toThrow('teams, then projects');
  expect(() => withTeamProjectsLocks(home, () => {
    upsertTeam(home, 'team-x', seed);
    projects.upsertProject(home, 'home-a', { name: 'Home A' });
    throw new Error('injected');
  })).toThrow('injected');
  expect(() => withTeamProjectsLocks(home, () => upsertTeam(home, 'team-x', { projectId: 'home-a' }))).not.toThrow();
});

test('explicit memberships round trip, reject malformed lists, and cannot mutate the memo', () => {
  upsertTeam(home, 'team-x', { ...seed, projectId: 'home-a', projects: ['home-a', 'served-a'] });
  enterRunMemo();
  getTeam(home, 'team-x')?.projects?.push('unwritten');
  expect(getTeam(home, 'team-x')?.projects).toEqual(['home-a', 'served-a']);
  for (const projects of [null, 'home-a', [1], ['']]) {
    expect(() => upsertTeam(home, 'team-x', { projects } as never)).toThrow('"projects"');
  }
});

test('leaving a home clears its lead and preserves served membership', () => {
  const root = join(home, 'root-a');
  const fileSeed = { ...seed, entity: null, lobby: null, inProject: 'Home A' };
  expect(noteTeam(home, root, fileSeed, 'defined', 'test')).toBeNull();
  const id = teamIdOf(root);
  upsertTeam(home, id, { projects: ['home-a', 'served-a'], roster: [{ agent: 'agt_0123456789ab', seat: 'seat-a', role: 'builder' }] });
  projects.upsertProject(home, 'home-a', { lead: 'agt_0123456789ab' });
  expect(noteTeam(home, root, { ...fileSeed, inProject: null }, 'defined', 'test')).toBeNull();
  expect(getTeam(home, id)?.projects).toEqual(['served-a']);
  expect(projects.get(home, 'home-a')?.lead).toBeNull();
});


test('served publication checks fresh project entities under both locks and creates nothing', () => {
  const root = join(home, 'root-a');
  projects.upsertProject(home, 'served-a', { name: 'Served A', entity: 'org-alpha' });
  enterRunMemo();
  expect(projects.get(home, 'served-a')?.entity).toBe('org-alpha');
  const path = projects.projectsFile(home);
  const before = readFileSync(path, 'utf8');
  const changed = before.replace('entity: org-alpha', 'entity: org-beta');
  expect(changed).not.toBe(before);
  writeFileSync(path, changed); // Another writer changed the record after this run cached it.
  let publications = 0;
  const original = state.writeAtomic;
  const watched = spyOn(state, 'writeAtomic').mockImplementation((path, text, options) => {
    if (path === teamsFile(home)) {
      expect(existsSync(`${teamsFile(home)}.lock`)).toBe(true);
      expect(existsSync(`${projects.projectsFile(home)}.lock`)).toBe(true);
      publications++;
    }
    return original(path, text, options);
  });
  try {
    expect(noteTeam(home, root, { ...seed, entity: 'org-alpha', lobby: null, inProject: 'Home A', alsoIn: ['Served A', 'Ghost'] }, 'running', 'fixture', { owner: true })).toBeNull();
  } finally { watched.mockRestore(); }
  expect(publications).toBe(1);
  expect(getTeam(home, teamIdOf(root))?.projects).toEqual(['home-a']);
  expect(projects.get(home, 'served-a')?.teams).toEqual([]);
  expect(projects.get(home, 'ghost')).toBeNull();
});
