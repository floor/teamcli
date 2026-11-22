// Execute the workflow's shell against synthetic PR histories, including a PR that changes
// its own accepted signers. The checker is the real source CLI; a small runner shim avoids
// building a release artifact just to exercise which policy the workflow supplies to it.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRepository, type Repository } from './check/repository.ts';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'src/cli.ts');
const PUBLIC_NAMES = join(ROOT, 'scripts/check-public-names.ts');
type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const yaml = Bun as unknown as { YAML: { parse(text: string): unknown } };
const workflow = yaml.YAML.parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
function shell(job: string): string {
  const step = workflow.jobs[job]!.steps.find((step) => step.name === 'Every commit and the pull request body are signed');
  if (!step?.run) throw new Error('signature step is missing');
  return step.run;
}
const TRACKER = ['\\bFL', 'O-[0-9]+\\b'].join('');
const POLICY = `kind: check-policy
project: acme
visibility: public
identity:
  humans: []
  forbidden_public: [${JSON.stringify(TRACKER)}]
signers:
  - {display: "Model 1", model: "Model", version: "1", role: "writer"}
`;
const LEGACY = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: writer
    cli: claude-code
    vendor: anthropic
    model: Model
    version: "1"
    launch: claude
`;
const BAD_SIGNER = 'Agent: Other 2 · writer';
const ADMIT_BAD = POLICY + '  - {display: "Other 2", model: "Other", version: "2", role: "writer"}\n';
const BODY = '**Agent:** Model 1 · writer';
const repos: Repository[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.remove();
});

function scene(baseFiles: Record<string, string>, own = { policy: ADMIT_BAD, signature: BAD_SIGNER }) {
  const repo = createRepository();
  repos.push(repo);
  mkdirSync(join(repo.path, '.github'), { recursive: true });
  writeFileSync(join(repo.path, 'README.md'), 'Synthetic repository.\n');
  for (const [name, text] of Object.entries(baseFiles)) writeFileSync(join(repo.path, '.github', name), text);
  repo.git('add', '-A');
  const base = repo.commit('chore: base\n\nAgent: Model 1 · writer');
  repo.git('update-ref', 'refs/remotes/origin/main', base);
  // The PR admits the bad signer in its own tree. The workflow must never use this file.
  writeFileSync(join(repo.path, '.github/policy.yaml'), own.policy);
  repo.git('add', '-A');
  repo.commit(`fix: modify policy\n\n${own.signature}`);
  const home = join(repo.path, 'synthetic-home');
  const bin = join(repo.path, 'runner-bin');
  const temp = join(repo.path, 'runner-temp');
  for (const path of [home, bin, temp]) mkdirSync(path);
  const argsFile = join(temp, 'checker-args.json');
  const envFile = join(temp, 'step-env');
  writeFileSync(envFile, '');
  // Preserve the workflow's node argv and stdin; execute this checkout's real source CLI.
  writeFileSync(join(bin, 'node'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.shift() !== 'dist/cli.js') process.exit(2);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const child = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], {
  cwd: process.cwd(), env: process.env, input: readFileSync(0), encoding: 'utf8',
});
process.stdout.write(child.stdout ?? '');
process.stderr.write(child.stderr ?? '');
process.exit(child.status ?? 2);
`, { mode: 0o700 });
  writeFileSync(join(bin, 'bun'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.shift() !== 'run' || args.shift() !== 'public-names:check') process.exit(2);
writeFileSync(${JSON.stringify(join(temp, 'scanner-args.json'))}, JSON.stringify(args));
const child = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(PUBLIC_NAMES)}, ...args], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8',
});
process.stdout.write(child.stdout ?? '');
process.stderr.write(child.stderr ?? '');
process.exit(child.status ?? 2);
`, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    RUNNER_TEMP: temp,
    GITHUB_ENV: envFile,
    EVENT: 'pull_request', BASE: 'main', BEFORE: base, BODY,
  };
  const run = (job = 'checks', overrides: Partial<typeof env> = {}) => spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell(job)], {
    cwd: repo.path, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20_000,
  });
  const ownPolicy = () => spawnSync(process.execPath, [CLI, 'check', `${base}..HEAD`, '--pr', '-', '--file', '.github/policy.yaml'], {
    cwd: repo.path, env, input: BODY, encoding: 'utf8', timeout: 20_000,
  });
  const names = () => {
    const selected = readFileSync(envFile, 'utf8').trim().replace(/^CHECK_POLICY=/, '');
    const step = workflow.jobs.checks!.steps.find((step) => step.run?.startsWith('bun run public-names:check'));
    if (!step?.run) throw new Error('public-name step is missing');
    return spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: repo.path, env: { ...env, CHECK_POLICY: selected }, encoding: 'utf8', timeout: 20_000,
    });
  };
  const ownNames = () => spawnSync(process.execPath, [PUBLIC_NAMES, '--file', '.github/policy.yaml'], {
    cwd: repo.path, env, encoding: 'utf8', timeout: 20_000,
  });
  return { repo, base, run, ownPolicy, names, ownNames, temp, argsFile };
}

test('a PR that admits a bad signer still fails against the base policy', () => {
  const fixture = scene({ 'policy.yaml': POLICY });
  expect(fixture.ownPolicy().status).toBe(0); // A head-policy check would incorrectly admit it.
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain('a signature no seat of this team has had');
  expect(readFileSync(join(fixture.temp, 'policy.yaml'), 'utf8')).toBe(POLICY);
  expect(JSON.parse(readFileSync(fixture.argsFile, 'utf8')).at(-1)).toBe(join(fixture.temp, 'policy.yaml'));
}, 30_000);

test('a base with only a legacy team file has no checking policy', () => {
  const fixture = scene({ 'team.yaml': LEGACY });
  expect(fixture.ownPolicy().status).toBe(0);
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('the base branch has no checking policy');
  expect(existsSync(fixture.argsFile)).toBe(false);
}, 30_000);

test('a base with neither policy format fails closed despite the valid policy in the PR tree', () => {
  const fixture = scene({});
  expect(fixture.ownPolicy().status).toBe(0);
  const result = fixture.run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('the base branch has no checking policy');
  expect(existsSync(fixture.argsFile)).toBe(false);
}, 30_000);

test('an invalid new base policy never falls back to a usable legacy or PR policy', () => {
  const invalid = POLICY.replace('kind: check-policy', 'kind: invalid');
  const fixture = scene({ 'policy.yaml': invalid, 'team.yaml': LEGACY });
  const result = fixture.run();
  expect(result.status).toBe(2);
  expect(readFileSync(join(fixture.temp, 'policy.yaml'), 'utf8')).toBe(invalid);
  expect(existsSync(join(fixture.temp, 'team.yaml'))).toBe(false);
}, 30_000);

test('pushes still check the policy in their own tree', () => {
  const fixture = scene({ 'policy.yaml': POLICY });
  const result = fixture.run('static', { EVENT: 'push' });
  expect(result.status).toBe(0);
  expect(JSON.parse(readFileSync(fixture.argsFile, 'utf8')).at(-1)).toBe('.github/policy.yaml');
  expect(existsSync(join(fixture.temp, 'policy.yaml'))).toBe(false);
}, 30_000);

test('a PR removing a forbidden path rule is still refused by the public-name step using the base policy', () => {
  const rule = '^blocked-name[.]txt$';
  const basePolicy = POLICY.replace('  humans: []', `  humans: []\n  forbidden: [${JSON.stringify(rule)}]`);
  const fixture = scene({ 'policy.yaml': basePolicy }, { policy: POLICY, signature: 'Agent: Model 1 · writer' });
  writeFileSync(join(fixture.repo.path, 'blocked-name.txt'), 'Synthetic content.\n');
  fixture.repo.git('add', '--', 'blocked-name.txt');
  fixture.repo.commit('fix: add example\n\nAgent: Model 1 · writer');
  expect(fixture.ownNames().status).toBe(0); // The PR's weakened rule set would admit its file.
  expect(fixture.run().status).toBe(0); // Correct signatures cannot mask a forbidden path.
  const result = fixture.names();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('blocked-name.txt: its name matches');
  expect(JSON.parse(readFileSync(join(fixture.temp, 'scanner-args.json'), 'utf8')).at(-1)).toBe(join(fixture.temp, 'policy.yaml'));
}, 30_000);
