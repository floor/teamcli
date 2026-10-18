// `team check` and the registries (`src/registry/projects.ts`, `src/registry/teams.ts`): a team
// is named in one project at most, and a team two projects both name is a difference — the
// registry's own refusal, repeated in the check's line, with the registry file named as the
// repair. A team no project names is its own project, a machine with no registry has no projects,
// and a check with no home answers for no registry at all: none of those is a difference. A
// project is led by one team: when this team declares `project_lead: true`, the project's other
// teams are read through the team registry, and one more declaring team is a difference. The team
// registry is read for every team, not only a lead's: an unreadable registry is a difference
// wherever the check runs.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { projectsFile, upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T00:30:00Z');

/** The team's own file: speaks for no project, and claims no lead. */
const TEXT = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;

/** The same file as the project's lead team: `TeamCLI`, led by this team. */
const LEAD = TEXT.replace('project: acme\n', 'project: teamcli\nin_project: TeamCLI\nproject_lead: true\n');

/** The sibling team's file: the same seat, another name, claiming the same project's lead. */
const SIBLING = TEXT.replace('project: acme\n', 'project: site\nin_project: TeamCLI\nproject_lead: true\n');

/** The same sibling, sitting in the project and claiming no lead. */
const SIBLING_QUIET = SIBLING.replace('project_lead: true\n', '');

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const TITLE = workspaceLabel(loaded.team.seats[0]!);

/** A session where nothing else is wrong: the seat's own pane, idle, the file's own label, a
 *  watch recorded, and a screen that says the pane is idle. */
const QUIET: Live = {
  running: true,
  agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
  workspaces: [{ id: 'w1', label: TITLE }],
  screens: { 'w1:p1': CLAUDE_IDLE },
};

/** One machine: a home, this team's checkout `acme`, and nothing else. */
function place(text: string = TEXT): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-projects-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const root = checkout(base, 'acme', text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  // The launch delivered the general brief before it typed: each seat's record and state entry.
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return { base, root, home };
}

/** One checkout: a git repository with its team file, and the state recording the seat running
 *  in the file's own session. */
function checkout(base: string, folder: string, text: string): string {
  const root = join(base, folder);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
  });
  return root;
}

/** The sibling checkout and its team record, so the check can find its file by its root. */
function sibling(base: string, text: string = SIBLING): { root: string; id: string } {
  const root = checkout(base, 'site', text);
  return { root, id: teamIdOf(root) };
}

function check(root: string, home: string | undefined): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => QUIET,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, home ?? root),
    now: () => NOW,
    home,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('a team and its projects', () => {
  test('a machine with no registry has no projects to answer with', () => {
    const { base, root, home } = place();
    const { code, out } = check(root, home);
    expect(out).not.toContain('the project registry');
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test('a team no project names is its own project, not a difference', () => {
    const { base, root, home } = place();
    upsertProject(home, 'site', { name: 'Site', teams: ['some-other-team'], at: NOW.toISOString() });
    const { out } = check(root, home);
    expect(out).not.toContain('the project registry');
    rmSync(base, { recursive: true, force: true });
  });

  test('a team one project names is not a difference', () => {
    const { base, root, home } = place();
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root)], at: NOW.toISOString() });
    const { code, out } = check(root, home);
    expect(out).not.toContain('the project registry');
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test('a team two projects name is a difference, naming both and the file to fix', () => {
    const { base, root, home } = place();
    const id = teamIdOf(root);
    // The registry's own writer takes both: a file can be edited into this state, and the
    // refusal is the reader's — `ofTeam` here, and `team check` repeats it.
    upsertProject(home, 'site', { name: 'Site', teams: [id], at: NOW.toISOString() });
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [id], at: NOW.toISOString() });
    const { code, out } = check(root, home);
    expect(out).toContain(`difference: the project registry: team ${id} is named in 2 projects: site, teamcli`);
    expect(out).toContain('  repair: fix the project registry (~/.config/team/projects.yaml)');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test('a registry that does not read is a difference too, not a silence', () => {
    const { base, root, home } = place();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(projectsFile(home), 'not a map\n');
    const { code, out } = check(root, home);
    expect(out).toContain('difference: the project registry: ~/.config/team/projects.yaml');
    expect(out).toContain('  repair: fix the project registry (~/.config/team/projects.yaml)');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test('a check with no home answers for no registry', () => {
    const { base, root } = place();
    // No home set is a test that stands in for no store at all, exactly as the approval store
    // and the overrides are already read.
    const { out } = check(root, undefined);
    expect(out).not.toContain('the project registry');
    expect(out).not.toContain('the team registry');
    rmSync(base, { recursive: true, force: true });
  });

  test('a team registry that does not read is a difference for a team that declares no lead', () => {
    const { base, root, home } = place();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'not a map\n');
    const { code, out } = check(root, home);
    // The roster bridge reads this file for every seat, a lead team's or not: an unreadable one
    // leaves every team unserved, and the check names it wherever it runs.
    expect(out).toContain('difference: the team registry cannot be read: ~/.config/team/teams.yaml');
    expect(out).toContain('  repair: fix the team registry (~/.config/team/teams.yaml)');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('a project and its lead teams', () => {
  test('a lead team whose project is not registered has nothing to compare', () => {
    const { base, root, home } = place(LEAD);
    const { code, out } = check(root, home);
    expect(out).not.toContain('lead teams');
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test('one team declaring the lead is not a difference', () => {
    const { base, root, home } = place(LEAD);
    const other = sibling(base, SIBLING_QUIET);
    upsertTeam(home, other.id, { project: 'site', session: 'site', root: other.root, at: NOW.toISOString() });
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root), other.id], at: NOW.toISOString() });
    const { code, out } = check(root, home);
    expect(out).not.toContain('lead teams');
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test('two teams declaring the lead are a difference, naming both', () => {
    const { base, root, home } = place(LEAD);
    const other = sibling(base);
    upsertTeam(home, other.id, { project: 'site', session: 'site', root: other.root, at: NOW.toISOString() });
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root), other.id], at: NOW.toISOString() });
    const { code, out } = check(root, home);
    expect(out).toContain('difference: the project TeamCLI has 2 lead teams: teamcli, site');
    expect(out).toContain('  repair: take "project_lead: true" off all but one of them');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test('a team the registry does not know is not counted', () => {
    const { base, root, home } = place(LEAD);
    // The project names a team ID with no record: the check cannot find its file, and says
    // nothing rather than guessing.
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root), 'unheard-of'], at: NOW.toISOString() });
    const { out } = check(root, home);
    expect(out).not.toContain('lead teams');
    rmSync(base, { recursive: true, force: true });
  });

  test('a sibling whose file names another project is not counted', () => {
    const { base, root, home } = place(LEAD);
    const other = sibling(base, SIBLING.replace('in_project: TeamCLI', 'in_project: Other'));
    upsertTeam(home, other.id, { project: 'site', session: 'site', root: other.root, at: NOW.toISOString() });
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root), other.id], at: NOW.toISOString() });
    const { out } = check(root, home);
    expect(out).not.toContain('lead teams');
    rmSync(base, { recursive: true, force: true });
  });

  test('a team registry that does not read is a difference, not a silence', () => {
    const { base, root, home } = place(LEAD);
    upsertProject(home, 'teamcli', { name: 'TeamCLI', teams: [teamIdOf(root), 'unheard-of'], at: NOW.toISOString() });
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(teamsFile(home), 'not a map\n');
    const { code, out } = check(root, home);
    expect(out).toContain('difference: the team registry cannot be read: ~/.config/team/teams.yaml');
    expect(out).toContain('  repair: fix the team registry (~/.config/team/teams.yaml)');
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });
});
