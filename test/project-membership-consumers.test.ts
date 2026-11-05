import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, SeatStanding } from '../src/caller.ts';
import { admissionOf } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { get as getProject, projectsFile, upsertProject } from '../src/registry/projects.ts';
import { getTeam, rekeyTeamRecord, upsertTeam } from '../src/registry/teams.ts';

const NOW = new Date('2026-11-06T00:00:00Z');
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'project-consumers-')); });
afterEach(() => { execFileSync('trash', [home]); });

function agent(team: string, seat: string, session: string, pane: string): Agent {
  return registerAgent(home, {
    name: seat, signing: { model: 'Test', version: '1', role: 'builder' }, lab: 'test', cli: 'codex',
    launcher: null, launch: 'codex', reach: { team, seat, session, pane, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'test',
  });
}

function fixture() {
  const parsed = validateTeamFile(`format: 1
project: team-a
entity: entity-x
session: session-a
operator: seat-a
in_project: project-a
workspace:
  mode: shared
seats:
  - name: seat-a
    role: builder
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
    leads: true
`);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const team = parsed.team;
  const sender = agent('team-a', 'seat-a', 'session-a', 'pane-lead');
  const recipient = agent('team-b', 'seat-b', 'session-b', 'pane-target');
  for (const [id, seat] of [['team-a', sender], ['team-b', recipient]] as const) {
    const root = join(home, id);
    mkdirSync(root);
    // The receiver's legacy record inherits entity membership through the project.
    upsertTeam(home, id, {
      project: id, projectId: 'project-a', projects: ['project-a'], entity: id === 'team-a' ? 'entity-x' : null, session: seat.reach.session, root,
      roster: [{ agent: seat.id, seat: seat.reach.seat, role: 'builder', leads: true }],
    });
  }
  upsertProject(home, 'project-a', { name: 'project-a', entity: 'entity-x', lead: sender.id });
  const caller: Caller = { kind: 'seat', name: 'seat-a', pane: 'pane-lead', session: 'session-a' };
  const standing: SeatStanding = { session: 'session-a', recordedPane: 'pane-lead', stage: 'ready' };
  const judge = (from: Caller = caller, at: SeatStanding = standing, to: Agent = recipient) => admissionOf(
    from, team, { team: getTeam(home, to.reach.team)!, agent: to }, to.reach.seat,
    home, 'team-a', () => NOW, at,
  );
  return { sender, recipient, caller, standing, judge };
}

test('the send command admits a project lead reaching a team lead using team-record membership', () => {
  const fx = fixture();
  expect(readFileSync(projectsFile(home), 'utf8')).not.toContain('    teams:');
  expect(fx.judge()).toMatchObject({ ok: true, rule: 'the project lead and the leads of its teams' });
});

test('project membership never bypasses the existing sender session and pane proof', () => {
  const fx = fixture();
  const read = fs.readFileSync;
  const paths: string[] = [];
  const reads = spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    paths.push(String(args[0]));
    return Reflect.apply(read, fs, args);
  });
  try {
    for (const from of [
      { kind: 'seat', name: 'seat-a', pane: 'pane-lead' },
      { ...fx.caller, pane: 'pane-impostor' },
      { ...fx.caller, session: 'session-c' },
    ] as Caller[]) expect(fx.judge(from).ok).toBe(false);
    expect(fx.judge(fx.caller, { ...fx.standing, recordedPane: 'pane-other' }).ok).toBe(false);
  } finally {
    reads.mockRestore();
  }
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.some(path => path.includes('/.agents/') || path.endsWith('/.agents'))).toBe(false);
});

test('stale project-side lists cannot admit a team that left the project', () => {
  const fx = fixture();
  upsertTeam(home, 'team-b', { projectId: null, projects: [] });
  const path = projectsFile(home);
  const raw = readFileSync(path, 'utf8').replace('    name: project-a\n', '    name: project-a\n    teams: [team-a, team-b]\n');
  writeFileSync(path, raw);
  expect(fx.judge().ok).toBe(false);
});

test('project lead reach still refuses another team\'s ordinary seat', () => {
  const fx = fixture();
  const ordinary = agent('team-b', 'seat-c', 'session-b', 'pane-other');
  const record = getTeam(home, 'team-b')!;
  upsertTeam(home, 'team-b', { roster: [...record.roster, { agent: ordinary.id, seat: 'seat-c', role: 'builder' }] });
  expect(fx.judge(fx.caller, fx.standing, ordinary).ok).toBe(false);
});

test('re-keying membership changes team records without rewriting legacy project lists', () => {
  fixture();
  const path = projectsFile(home);
  const before = readFileSync(path, 'utf8').replace('    name: project-a\n', '    name: project-a\n    teams: [team-a, team-b]\n');
  writeFileSync(path, before);
  rekeyTeamRecord(home, 'team-b', 'team-new', { root: '/tmp/root-new' });
  expect(getProject(home, 'project-a')?.teams).toEqual(['team-a', 'team-new']);
  expect(readFileSync(path, 'utf8')).toBe(before);
});
