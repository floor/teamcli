import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { ofTeam, upsertProject } from '../src/registry/projects.ts';
import { getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { gitEnv } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a launch keeps a registry membership when the team file names no in_project', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'launch-keeps-membership-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const yaml = `format: 1
project: acme
coordinator: lead
operator: worker
trust:
  - ~/.config/team/lobby
  - ${root}
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
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  const parsed = validateTeamFile(yaml, { home, root });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  expect(parsed.team.inProject).toBeNull();

  const teamId = teamIdOf(root);
  upsertProject(home, 'home', { name: 'Home', by: 'test' });
  upsertTeam(home, teamId, {
    project: 'acme',
    session: 'acme',
    root,
    projectId: 'home',
    lifecycle: 'defined',
    by: 'test',
  });
  expect(getTeam(home, teamId)?.projectId).toBe('home');

  const worker = parsed.team.seats.find((seat) => seat.name === 'worker');
  if (worker === undefined) throw new Error('fixture has no worker seat');
  const launched = registerLaunch({ home, team: parsed.team, root, by: 'test' }, worker, 'pane-1');
  expect(launched).toEqual({ id: expect.stringMatching(/^agt_[0-9a-f]{12}$/) });
  expect(getTeam(home, teamId)?.projectId).toBe('home');
  expect(ofTeam(home, teamId)?.id).toBe('home');
});
