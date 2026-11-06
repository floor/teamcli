// Send admission reads membership from team records. A teams list left on a
// project does not admit anyone, each shared project is judged on its own,
// and a re-key leaves the old team id off the derived list.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, SeatStanding } from '../src/caller.ts';
import { admissionOf } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { projectsFile, readProjects, upsertProject } from '../src/registry/projects.ts';
import { getTeam, rekeyTeamRecord, upsertTeam, type TeamRecord } from '../src/registry/teams.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-06T00:00:00Z');
const PROJECT_LEAD = 'the project lead and the leads of its teams';
let home = '';

afterEach(() => {
  if (home !== '') discardFixtures([home]);
});

function callerFile(): TeamFile {
  const parsed = validateTeamFile(`format: 1
project: team-a
entity: entity-x
session: session-a
operator: seat-a
in_project: project-alpha
workspace:
  mode: shared
seats:
  - name: seat-lead
    role: builder
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    leads: true
  - name: seat-a
    role: builder
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function agent(team: string, seat: string, session: string, pane: string): Agent {
  return registerAgent(home, {
    name: seat, signing: { model: 'Test', version: '1', role: 'builder' }, lab: 'test', cli: 'codex',
    launcher: null, launch: 'codex', reach: { team, seat, session, pane, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
}

function plantTeams(projectName: string, teams: string): void {
  const path = projectsFile(home);
  const raw = readFileSync(path, 'utf8').replace(
    `    name: ${projectName}\n`,
    `    name: ${projectName}\n    teams: [${teams}]\n`,
  );
  writeFileSync(path, raw);
}

function scene(options: { memberships: string[]; alphaLead: string | null; betaLead?: string | null }): {
  sender: Agent;
  recipient: Agent;
  judge: (to?: Agent, team?: TeamRecord) => ReturnType<typeof admissionOf>;
} {
  home = mkdtempSync(join(tmpdir(), 'send-admission-membership-'));
  const sender = agent('team-a', 'seat-a', 'session-a', 'pane-lead');
  const recipient = agent('team-b', 'seat-b', 'session-b', 'pane-target');
  for (const [id, seat, entity] of [
    ['team-a', sender, 'entity-x'],
    ['team-b', recipient, null],
  ] as const) {
    mkdirSync(join(home, id));
    upsertTeam(home, id, {
      project: id,
      projectId: 'project-alpha',
      projects: options.memberships,
      entity,
      session: seat.reach.session,
      root: join(home, id),
      roster: [{ agent: seat.id, seat: seat.reach.seat, role: 'builder', leads: id === 'team-b' }],
    });
  }
  upsertProject(home, 'project-alpha', { name: 'project-alpha', entity: 'entity-x', lead: options.alphaLead });
  if (options.betaLead !== undefined) {
    upsertProject(home, 'project-beta', { name: 'project-beta', entity: 'entity-x', lead: options.betaLead });
  }
  const caller: Caller = { kind: 'seat', name: 'seat-a', pane: 'pane-lead', session: 'session-a' };
  const standing: SeatStanding = { session: 'session-a', recordedPane: 'pane-lead', stage: 'ready' };
  const team = callerFile();
  const judge = (to: Agent = recipient, record?: TeamRecord) => admissionOf(
    caller,
    team,
    { team: record ?? getTeam(home, to.reach.team)!, agent: to },
    to.reach.seat,
    home,
    'team-a',
    () => NOW,
    standing,
  );
  return { sender, recipient, judge };
}

test('send admission derives membership from team records', () => {
  const fx = scene({ memberships: ['project-alpha'], alphaLead: null });
  upsertProject(home, 'project-alpha', { lead: fx.sender.id });
  plantTeams('project-alpha', 'team-ghost');
  expect(readFileSync(projectsFile(home), 'utf8')).toContain('teams: [team-ghost]');
  expect(readProjects(home)['project-alpha']?.teams).toEqual(['team-a', 'team-b']);
  expect(fx.judge()).toMatchObject({ ok: true, rule: PROJECT_LEAD });
});

test('admission over several memberships checks each shared project\'s rules', () => {
  const fx = scene({
    memberships: ['project-alpha', 'project-beta'],
    alphaLead: 'other-lead',
    betaLead: null,
  });
  upsertProject(home, 'project-beta', { lead: fx.sender.id });
  expect(readProjects(home)['project-alpha']?.lead).toBe('other-lead');
  expect(readProjects(home)['project-beta']?.lead).toBe(fx.sender.id);
  expect(readProjects(home)['project-alpha']?.teams).toEqual(['team-a', 'team-b']);
  expect(readProjects(home)['project-beta']?.teams).toEqual(['team-a', 'team-b']);
  expect(fx.judge()).toMatchObject({ ok: true, rule: PROJECT_LEAD });

  upsertTeam(home, 'team-b', { projects: ['project-alpha'] });
  expect(readProjects(home)['project-alpha']?.teams).toEqual(['team-a', 'team-b']);
  expect(readProjects(home)['project-beta']?.teams).toEqual(['team-a']);
  expect(fx.judge().ok).toBe(false);
});

test('re-key leaves no stale membership list', () => {
  const fx = scene({ memberships: ['project-alpha'], alphaLead: null });
  upsertProject(home, 'project-alpha', { lead: fx.sender.id });
  plantTeams('project-alpha', 'team-a, team-b');
  const path = projectsFile(home);
  const before = readFileSync(path, 'utf8');
  const prior = getTeam(home, 'team-b');
  if (prior === null) throw new Error('team-b missing before re-key');
  mkdirSync(join(home, 'team-new-root'));
  rekeyTeamRecord(home, 'team-b', 'team-new', { root: join(home, 'team-new-root') });

  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(before).not.toContain('team-new');
  expect(readProjects(home)['project-alpha']?.teams).toEqual(['team-a', 'team-new']);
  expect(getTeam(home, 'team-b')).toBeNull();

  const moved = getTeam(home, 'team-new');
  if (moved === null) throw new Error('team-new missing after re-key');
  const redirected: Agent = { ...fx.recipient, reach: { ...fx.recipient.reach, team: 'team-new' } };
  expect(fx.judge(redirected, moved)).toMatchObject({ ok: true, rule: PROJECT_LEAD });
  expect(fx.judge(fx.recipient, prior).ok).toBe(false);
});
