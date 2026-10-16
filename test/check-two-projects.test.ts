// `team check` and the project registry (`src/registry/projects.ts`): a team is named in one
// project at most, and a team two projects both name is a difference — the registry's own
// refusal, repeated in the check's line, with the registry file named as the repair. A team no
// project names is its own project, a machine with no registry has no projects, and a check with
// no home answers for no registry at all: none of those is a difference.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { projectsFile, upsertProject } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T00:30:00Z');

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

function place(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-projects-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
  });
  return { base, root, home };
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
    expect(out).toContain(`difference: the project registry: ${projectsFile(home)}`);
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
    rmSync(base, { recursive: true, force: true });
  });
});
