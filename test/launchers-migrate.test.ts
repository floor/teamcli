// `team launchers migrate` finds launch lines that run a script from a repository, a docs
// repository, or a temp folder. A dry run lists every change and every stale record and
// writes nothing. Apply writes declarations into the launcher home, rewrites the lines, and
// leaves a forwarding stub in the docs copy. Records are never deleted. Homes, scripts and
// pane names are synthetic. No real launcher, credential, env value or CLI is read. The
// repo and docs scripts are the owner's own wrappers: the fixture maps them through an
// owner-written launcher-migrations.json to existing declarations, while the temp script
// rides a built-in provider entry.
//
// The command is runLaunchers in src/commands/launchers.ts. The third argument is the
// synthetic home. Declarations are read back through src/launch/launcher-home.ts.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLaunchers } from '../src/commands/launchers.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readLauncherHome } from '../src/launch/launcher-home.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
const MARKER = '# synthetic\n';
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

type Scene = {
  home: string;
  root: string;
  teamFile: string;
  repoScript: string;
  tempScript: string;
  docsScript: string;
  agentFile: string;
  agentId: string;
};

function seat(name: string, launch: string): string {
  return `  - role: implementer
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: ${JSON.stringify(launch)}
    mode: shared
`;
}

function open(): Scene {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'launchers-migrate-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const docs = join(base, 'docs');
  const scratch = join(base, 'scratch');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  mkdirSync(join(docs, 'guides'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { mode: 0o700 });
  mkdirSync(scratch);
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  const declHome = join(home, '.config', 'team', 'launchers');
  mkdirSync(declHome, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(docs, 'init', '-q', '-b', 'main');
  const repoScript = join(root, 'tools', 'wrapper-repo');
  const tempScript = join(scratch, 'claude-kimi.sh');
  const docsScript = join(docs, 'guides', 'wrapper-docs.sh');
  writeFileSync(repoScript, MARKER);
  writeFileSync(tempScript, MARKER);
  writeFileSync(docsScript, MARKER);
  for (const name of ['wrapper-repo', 'wrapper-docs']) {
    writeFileSync(join(declHome, `${name}.json`), `${JSON.stringify({ name, harness: 'claude-code', argv: ['claude', '--model', 'claude-opus-5-5'] }, null, 2)}\n`);
  }
  writeFileSync(
    join(home, '.config', 'team', 'launcher-migrations.json'),
    `${JSON.stringify({ format: 1, scripts: { [repoScript]: 'wrapper-repo', [docsScript]: 'wrapper-docs' } }, null, 2)}\n`,
  );
  const teamFile = join(root, '.agents', 'team.yaml');
  const yaml = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
trust:
  - ${root}
  - ${lobbyDir(home)}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: "Claude Opus 5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
${seat('repo-seat', repoScript)}${seat('temp-seat', tempScript)}${seat('docs-seat', docsScript)}`;
  writeFileSync(teamFile, yaml);
  const parsed = validateTeamFile(yaml, { root, home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  upsertTeam(home, teamIdOf(root), { project: 'acme', session: 'acme', root, at: NOW.toISOString() });
  const agent = registerAgent(home, {
    name: 'stale-seat',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: '/private/tmp/gone-launcher.sh',
    reach: { team: teamIdOf(root), seat: 'stale-seat', session: 'acme', pane: 'pane-stale', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'the test',
  });
  return {
    home,
    root,
    teamFile,
    repoScript,
    tempScript,
    docsScript,
    agentFile: join(agentsDir(home), `${agent.id}.yaml`),
    agentId: agent.id,
  };
}

function snapshot(scene: Scene): Record<string, string> {
  return {
    team: readFileSync(scene.teamFile, 'utf8'),
    repo: readFileSync(scene.repoScript, 'utf8'),
    temp: readFileSync(scene.tempScript, 'utf8'),
    docs: readFileSync(scene.docsScript, 'utf8'),
    agent: readFileSync(scene.agentFile, 'utf8'),
  };
}

async function migrate(scene: Scene, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(scene.root, { kind: 'owner' });
  const code = await runLaunchers(argv, io, scene.home);
  return { code, out: io.out, err: io.err };
}

test('a dry run lists each launch line and the stale record, and writes nothing', async () => {
  const scene = open();
  const before = snapshot(scene);
  const result = await migrate(scene, ['migrate', '--dry-run', '--json']);
  expect(result.code).toBe(0);
  const said = `${result.out}${result.err}`;
  expect(said).toContain('wrapper-repo');
  expect(said).toContain('claude-kimi.sh');
  expect(said).toContain('wrapper-docs.sh');
  expect(said).toContain(scene.agentId);
  expect(snapshot(scene)).toEqual(before);
  // A dry run writes no declaration: the launcher home still holds exactly the two the
  // owner wrote, and nothing the dry run listed appears in it.
  const dryHome = readLauncherHome(scene.home);
  expect(dryHome.ok).toBe(true);
  if (dryHome.ok) expect(dryHome.launchers.map((decl) => decl.name).sort()).toEqual(['wrapper-docs', 'wrapper-repo']);
  expect(existsSync(scene.agentFile)).toBe(true);
});

test('apply writes declarations, rewrites the lines, leaves a docs stub, and keeps the stale record', async () => {
  const scene = open();
  const result = await migrate(scene, ['migrate']);
  expect(result.code).toBe(0);
  const read = readLauncherHome(scene.home);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(read.launchers.map((decl) => decl.name).sort()).toEqual(['claude-kimi', 'wrapper-docs', 'wrapper-repo']);
  for (const decl of read.launchers) {
    expect(decl.argv.join(' ').includes('.sh')).toBe(false);
    expect(JSON.stringify(decl).includes('placed-secret')).toBe(false);
  }
  const team = readFileSync(scene.teamFile, 'utf8');
  expect(team.includes(scene.repoScript)).toBe(false);
  expect(team.includes(scene.tempScript)).toBe(false);
  expect(team.includes(scene.docsScript)).toBe(false);
  const stub = readFileSync(scene.docsScript, 'utf8');
  expect(stub).not.toBe(MARKER);
  expect(stub).toContain('exec');
  expect(stub).toContain('wrapper-docs');
  expect(existsSync(scene.agentFile)).toBe(true);
  expect(readFileSync(scene.agentFile, 'utf8')).toContain(scene.agentId);
});
