// Membership is the team record. A teams list on a project does not create it,
// and a team in two projects keeps one home.
import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { mayReadTeam } from '../src/read-gate.ts';
import { get, list, ofTeam, projectsFile, readProjects, upsertProject } from '../src/registry/projects.ts';
import { getTeam, noteTeam, teamIdOf, upsertTeam, type TeamSeed } from '../src/registry/teams.ts';
import { admitSend } from '../src/send/admit.ts';
import { updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const OTHER = 'otherteam0001';
const WHEN = '2026-11-05T00:00:00.000Z';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function scratch(): string {
  const base = fixtureBase('also-in-');
  scratchParent ??= dirname(base);
  made.push(base);
  return base;
}

function teamText(extra: string): string {
  return `format: 1
project: alpha
entity: floor
operator: lead
session: home-session
trust: []
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;
}

function seedOf(team: TeamFile): TeamSeed {
  return {
    project: team.project,
    entity: team.entity,
    session: team.session,
    lobby: team.lobby,
    inProject: team.inProject,
  };
}

function accept(home: string, root: string, extra: string): { team: TeamFile; line: string | null; id: string } {
  mkdirSync(root, { recursive: true });
  const parsed = validateTeamFile(teamText(extra));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const line = noteTeam(home, root, seedOf(parsed.team), 'running', 'fixture');
  return { team: parsed.team, line, id: teamIdOf(root) };
}

const NOTE = `
import { noteTeam } from './src/registry/teams.ts';
const seed = JSON.parse(process.env.FIXTURE_SEED ?? '');
const line = noteTeam(process.env.FIXTURE_HOME ?? '', process.env.FIXTURE_ROOT ?? '', seed, 'running', 'fixture');
process.stdout.write(line ?? '');
`;

function noteChild(home: string, root: string, seed: TeamSeed): Promise<string> {
  mkdirSync(root, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', NOTE], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, HOME: home, FIXTURE_HOME: home, FIXTURE_ROOT: root, FIXTURE_SEED: JSON.stringify(seed) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err || out || `note exited ${code}`));
      else resolve(out.trim());
    });
  });
}

function teamsOf(home: string, project: string): string[] {
  return get(home, project)?.teams ?? [];
}

function derivedProjects(home: string): Record<string, { entity: string | null; lead: string | null; teams: string[] }> {
  return Object.fromEntries(list(home).map((project) => [project.id, { entity: project.entity, lead: project.lead, teams: [...project.teams] }]));
}

describe('served projects', () => {
  test('a teams patch does not join a project of another entity', () => {
    const base = scratch();
    const home = join(base, 'h');
    const root = join(base, 'alpha');
    mkdirSync(root, { recursive: true });
    const id = teamIdOf(root);
    upsertProject(home, 'side', {
      name: 'Side', entity: 'other-entity', teams: [id, OTHER], by: 'fixture', at: WHEN,
    });
    expect(teamsOf(home, 'side')).toEqual([]);
    const noted = accept(home, root, 'in_project: Home\n');
    expect(noted.line).toBeNull();
    expect(teamsOf(home, 'side')).toEqual([]);
    expect(get(home, 'side')?.entity).toBe('other-entity');
    expect(teamsOf(home, 'home')).toEqual([id]);
    expect(get(home, 'home')?.entity).toBe('floor');
    expect(ofTeam(home, id)?.id).toBe('home');
  });

  test('a teams patch is not a served membership', () => {
    const base = scratch();
    const home = join(base, 'h');
    const root = join(base, 'alpha');
    upsertProject(home, 'side', {
      name: 'Side', entity: 'floor', teams: [OTHER], by: 'fixture', at: WHEN,
    });
    expect(teamsOf(home, 'side')).toEqual([]);
    const noted = accept(home, root, 'in_project: Home\n');
    expect(noted.line).toBeNull();
    expect(teamsOf(home, 'side')).toEqual([]);
    expect(getTeam(home, noted.id)?.projects ?? []).not.toContain('side');
    expect(ofTeam(home, noted.id)?.id).toBe('home');
  });

  test('two writers leaving one project each keep only their home', async () => {
    const base = scratch();
    const home = join(base, 'h');
    const rootA = join(base, 'alpha');
    const rootB = join(base, 'beta');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const idA = teamIdOf(rootA);
    const idB = teamIdOf(rootB);
    const seed = (project: string, session: string, inProject: string): TeamSeed => ({
      project, entity: 'floor', session, lobby: null, inProject,
    });
    for (let n = 0; n < 8; n += 1) {
      upsertProject(home, 'shared', {
        name: 'shared', entity: 'floor', teams: [idA, idB], by: 'fixture', at: WHEN,
      });
      const [lineA, lineB] = await Promise.all([
        noteChild(home, rootA, seed('alpha', 'alpha-session', 'Homa')),
        noteChild(home, rootB, seed('beta', 'beta-session', 'Homb')),
      ]);
      expect(lineA).toBe('');
      expect(lineB).toBe('');
      expect(teamsOf(home, 'shared')).toEqual([]);
      expect(teamsOf(home, 'homa')).toEqual([idA]);
      expect(teamsOf(home, 'homb')).toEqual([idB]);
      expect(ofTeam(home, idA)?.id).toBe('homa');
      expect(ofTeam(home, idB)?.id).toBe('homb');
    }
  }, 60_000);

  test('a team record is not published onto a project the lock still hides', async () => {
    const base = scratch();
    const home = join(base, 'h');
    const root = join(base, 'alpha');
    const id = teamIdOf(root);
    const lock = `${projectsFile(home)}.lock`;
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    const pending = noteChild(home, root, {
      project: 'alpha', entity: 'floor', session: 'home-session', lobby: null, inProject: 'Home',
    });
    const deadline = Date.now() + 3_000;
    let published = getTeam(home, id);
    while (published === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      published = getTeam(home, id);
    }
    const listed = teamsOf(home, 'home').includes(id);
    let line = '';
    try {
      expect(
        published === null || published.projectId == null || listed,
        'the team record named a project that does not list it while the projects lock was held',
      ).toBe(true);
    } finally {
      try { unlinkSync(lock); } catch { /* the waiter may have retired a stale lock */ }
      line = await pending;
    }
    expect(line).toBe('');
    expect(teamsOf(home, 'home')).toContain(id);
    expect(ofTeam(home, id)?.id).toBe('home');
  }, 20_000);

  test('two memberships keep the home, and a shared served project admits the seats', () => {
    const base = scratch();
    const home = join(base, 'h');
    const root = join(base, 'alpha');
    const other = join(base, 'beta');
    mkdirSync(other, { recursive: true });
    const otherId = teamIdOf(other);
    upsertProject(home, 'side', { name: 'Side', entity: 'floor', teams: [otherId], by: 'fixture', at: WHEN });
    const noted = accept(home, root, 'in_project: Home\n');
    expect(noted.line).toBeNull();
    expect(teamsOf(home, 'side')).toEqual([]);
    const dir = join(root, '.agents');
    mkdirSync(dir, { recursive: true });
    updateState(dir, (state) => {
      state.sessions['home-session'] = {
        seats: { lead: { stage: 'ready', pane: 'fixture-pane-one' } },
        worktrees: {},
      };
    });
    const current = { ok: true as const, team: noted.team, root, dir, warnings: [] };
    const io = {
      env: {},
      stdinIsTTY: false,
      caller: { kind: 'seat' as const, name: 'lead', pane: 'fixture-pane-one', session: 'home-session' },
    };
    expect(mayReadTeam(current, io, { home })).toBe(true);
    expect(mayReadTeam(current, {
      ...io,
      caller: { kind: 'seat', name: 'worker', pane: 'fixture-pane-two', session: 'home-session' },
    }, { home })).toBe(false);

    upsertTeam(home, otherId, {
      project: 'beta', entity: 'floor', session: 'beta-session', root: other,
      projectId: 'side', projects: ['side'], by: 'fixture', at: WHEN,
    });
    upsertTeam(home, noted.id, { projectId: 'home', projects: ['home', 'side'], by: 'fixture', at: WHEN });
    expect(ofTeam(home, noted.id)?.id).toBe('home');
    expect(teamsOf(home, 'home')).toContain(noted.id);
    expect(teamsOf(home, 'side').sort()).toEqual([noted.id, otherId].sort());

    const roster = (leadAgent: string, workerAgent: string) => ({
      project: 'alpha',
      entity: 'floor',
      orchestrator: 'lead',
      roster: [
        { agent: leadAgent, seat: 'lead', role: 'coordinator', leads: true },
        { agent: workerAgent, seat: 'worker', role: 'implementer' },
      ],
    });
    const ask = (projects: ReturnType<typeof derivedProjects>) => admitSend(
      { seat: 'worker', team: noted.id },
      { seat: 'worker', team: otherId },
      { [noted.id]: roster('agt_home_lead', 'agt_home_worker'), [otherId]: roster('agt_side_lead', 'agt_side_worker') },
      undefined,
      { projects, crossTeams: { project: true } },
    );
    const verdict = (projects: ReturnType<typeof derivedProjects>): string => {
      const result = ask(projects);
      return result.ok ? 'admitted' : result.why;
    };
    expect({
      derived: verdict(derivedProjects(home)),
      stored: verdict(readProjects(home)),
    }).toEqual({ derived: 'admitted', stored: 'admitted' });
  });
});
