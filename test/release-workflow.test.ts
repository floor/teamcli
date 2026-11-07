// Reads `.github/workflows/release.yml` as YAML. A pull request does not run
// that workflow, so the condition on each publishing job is checked here.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureBase } from './helpers.ts';

const PINNED = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";

type Context = { eventName: string; ref: string };

type Step = {
  id?: string;
  name?: string;
  if?: unknown;
  'continue-on-error'?: unknown;
  env?: Record<string, unknown>;
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
};

type Job = {
  if?: unknown;
  uses?: unknown;
  permissions?: unknown;
  needs?: unknown;
  outputs?: Record<string, unknown>;
  'runs-on'?: unknown;
  'continue-on-error'?: unknown;
  steps?: Step[];
};

type Workflow = {
  on?: unknown;
  jobs?: Record<string, Job>;
};

function parseYaml(text: string): Workflow {
  const bun = Bun as unknown as { YAML?: { parse(source: string): unknown } };
  if (!bun.YAML) throw new Error('Bun.YAML.parse is required');
  return bun.YAML.parse(text) as Workflow;
}

/** The pinned expression, and nothing wider. `&&` joins the two comparisons. */
function evaluate(expression: string, ctx: Context): boolean {
  const parts = expression.trim().split(' && ');
  if (expression.trim() !== PINNED || parts.length !== 2) throw new Error('not the pinned expression');
  const [eventCheck, refCheck] = parts as [string, string];
  if (eventCheck !== "github.event_name == 'push'") throw new Error('not the pinned expression');
  const prefix = /^startsWith\(github\.ref, '([^']*)'\)$/.exec(refCheck);
  if (!prefix || prefix[1] !== 'refs/tags/v') throw new Error('not the pinned expression');
  return ctx.eventName === 'push' && ctx.ref.startsWith(prefix[1]);
}

function writesToken(permissions: unknown): boolean {
  if (permissions === 'write-all') return true;
  if (!permissions || typeof permissions !== 'object') return false;
  const map = permissions as Record<string, unknown>;
  return map['id-token'] === 'write' || map.contents === 'write';
}

function reusableWorkflow(uses: unknown): boolean {
  return typeof uses === 'string' && (uses.includes('.github/workflows/') || /\.ya?ml(@|$)/.test(uses));
}

function stepPublishes(step: Step): boolean {
  if (typeof step.run === 'string' && (/\bnpm\s+publish\b/.test(step.run) || /\bgh\s+release\b/.test(step.run))) return true;
  return reusableWorkflow(step.uses);
}

function jobPublishes(job: Job): boolean {
  if (writesToken(job.permissions) || reusableWorkflow(job.uses)) return true;
  return (job.steps ?? []).some(stepPublishes);
}

const workflow = parseYaml(readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8'));
const ci = parseYaml(readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'ci.yml'), 'utf8'));

test("each publishing job's condition is the pinned tag-push expression", () => {
  expect(workflow.on).toEqual({
    push: { tags: ['v*.*.*'] },
    workflow_dispatch: null,
  });

  const jobs = workflow.jobs ?? {};
  const publishing = Object.entries(jobs).filter(([, job]) => jobPublishes(job));
  expect(publishing.length).toBeGreaterThan(0);

  for (const [, job] of publishing) {
    expect(typeof job.if).toBe('string');
    const guard = (job.if as string).trim();
    expect(guard).toBe(PINNED);
    expect(evaluate(guard, { eventName: 'workflow_dispatch', ref: 'refs/heads/main' })).toBe(false);
    expect(evaluate(guard, { eventName: 'workflow_dispatch', ref: 'refs/tags/v0.4.0' })).toBe(false);
    expect(evaluate(guard, { eventName: 'push', ref: 'refs/tags/v0.4.0' })).toBe(true);
  }

  for (const [, job] of Object.entries(jobs)) {
    if (jobPublishes(job)) continue;
    expect(reusableWorkflow(job.uses)).toBe(false);
    for (const step of job.steps ?? []) expect(stepPublishes(step)).toBe(false);
  }
});

test('each platform keeps its full suite, stamped pack and separately addressed hash', () => {
  for (const [name, runner] of [['verify-ubuntu', 'ubuntu-latest'], ['verify-macos', 'macos-latest']] as const) {
    const job = workflow.jobs?.[name];
    expect(job?.['runs-on']).toBe(runner);
    expect(job?.outputs?.sha256).toBe('${{ steps.pack.outputs.sha256 }}');
    const steps = job?.steps ?? [];
    expect(steps.some((step) => step.run === 'bun run ci')).toBe(true);
    const pack = steps.find((step) => step.id === 'pack');
    expect(pack?.run as string).toContain('scripts/pack.ts');
    expect(pack?.run as string).not.toContain('npm pack');
    const check = steps.find((step) => typeof step.run === 'string' && step.run.includes('scripts/check-pack.ts'));
    expect(check?.run as string).toContain('GITHUB_SHA');
  }
});

const requiredJobs = ['release-ancestry', 'release-date', 'release-ops', 'verify-ubuntu', 'verify-macos'];
const publish = workflow.jobs?.publish;
const publishStep = publish?.steps?.find((step) => step.name === 'Publish the tarball');

test('fresh release checks are unconditional required jobs, with no tolerated failure', () => {
  expect(publish?.needs).toEqual(requiredJobs);
  for (const name of requiredJobs) {
    const job = workflow.jobs?.[name];
    expect(job).toBeDefined();
    expect(job?.if).toBeUndefined();
    expect(job?.['continue-on-error']).toBeUndefined();
    for (const step of job?.steps ?? []) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
    }
  }
  const ancestry = workflow.jobs?.['release-ancestry']?.steps?.map((step) => step.run).join('\n') ?? '';
  expect(ancestry).toContain("git fetch --force --tags origin '+refs/heads/main:refs/remotes/origin/main'");
  expect(ancestry).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
  const date = workflow.jobs?.['release-date']?.steps?.map((step) => step.run).join('\n') ?? '';
  expect(date).toContain('bun scripts/check-release-date.ts "${GITHUB_REF_NAME#v}"');
  const ops = workflow.jobs?.['release-ops']?.steps?.map((step) => step.run).join('\n') ?? '';
  expect(ops.indexOf('git fetch --force --tags origin')).toBeGreaterThanOrEqual(0);
  expect(ops.indexOf('bun test ./test/general-grant-widened.test.ts')).toBeGreaterThan(ops.indexOf('git fetch'));
  expect(publishStep?.env).toEqual({
    REQUIRED_RESULTS: '${{ toJSON(needs) }}',
    PACK_SHA256_UBUNTU: '${{ needs.verify-ubuntu.outputs.sha256 }}',
    PACK_SHA256_MACOS: '${{ needs.verify-macos.outputs.sha256 }}',
  });
});

const fixtures: string[] = [];
afterAll(() => { for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true }); });

/** Execute the actual publication step with a fixture archive and an npm stand-in. */
function publication(overrides: Record<string, string>, tamper = false) {
  const dir = fixtureBase('release-publication-');
  fixtures.push(dir);
  mkdirSync(join(dir, 'package'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const archive = join(dir, 'team-9.8.7.tgz');
  execFileSync('tar', ['-czf', archive, 'package'], { cwd: dir });
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (tamper) writeFileSync(archive, 'swapped artifact');
  const marker = join(dir, 'npm-called');
  writeFileSync(join(dir, 'bin', 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$NPM_MARKER"\n', { mode: 0o755 });
  if (typeof publishStep?.run !== 'string') throw new Error('publication script is missing');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publishStep.run], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      HOME: join(dir, 'home'),
      XDG_CONFIG_HOME: join(dir, 'home', 'config'),
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_MARKER: marker,
      GITHUB_REF_NAME: 'v9.8.7',
      REQUIRED_RESULTS: JSON.stringify(Object.fromEntries(requiredJobs.map((name) => [name, { result: 'success' }]))),
      PACK_SHA256_UBUNTU: sha256,
      PACK_SHA256_MACOS: sha256,
      ...overrides,
    },
  });
  if (result.error) throw result.error;
  return { ...result, called: existsSync(marker) ? readFileSync(marker, 'utf8') : null };
}

test('the matching downloaded archive reaches npm publish only after every required check succeeds', () => {
  const result = publication({});
  expect(result.status).toBe(0);
  expect(result.called).toBe('publish team-9.8.7.tgz --provenance --access public --tag latest\n');
});

test('a divergent platform pack hash, missing hash or swapped download never reaches npm publish', () => {
  for (const key of ['PACK_SHA256_UBUNTU', 'PACK_SHA256_MACOS']) {
    for (const value of ['a'.repeat(64), '', 'not-a-hash']) {
      const result = publication({ [key]: value });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`downloaded tarball does not match ${key}`);
      expect(result.called).toBeNull();
    }
  }
  const swapped = publication({}, true);
  expect(swapped.status).not.toBe(0);
  expect(swapped.stderr).toContain('downloaded tarball does not match');
  expect(swapped.called).toBeNull();
});

test('a skipped, failed, cancelled or absent required check cannot reach npm publish even with matching hashes', () => {
  for (const job of requiredJobs) {
    for (const state of ['skipped', 'failure', 'cancelled', undefined]) {
      const results = Object.fromEntries(requiredJobs.map((name) => [name, { result: 'success' }]));
      if (state === undefined) delete results[job];
      else results[job] = { result: state };
      const result = publication({ REQUIRED_RESULTS: JSON.stringify(results) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`required release job ${job} did not succeed`);
      expect(result.called).toBeNull();
    }
  }
});

test('both pack workflows run the pinned Node and print the reproducible tarball SHA256', () => {
  for (const parsed of [workflow, ci]) {
    const steps = Object.values(parsed.jobs ?? {}).flatMap((job) => job.steps ?? []);
    const setups = steps.filter((step) => typeof step.uses === 'string' && step.uses.includes('actions/setup-node'));
    expect(setups.length).toBeGreaterThan(0);
    for (const setup of setups) expect(setup.with?.['node-version']).toBe('22.23.3');

    const pack = steps.find((step) => typeof step.run === 'string' && step.run.includes('scripts/pack.ts'));
    expect(pack).toBeDefined();
    expect(pack?.run as string).toContain('sha256');
    expect(pack?.run as string).toContain('GITHUB_STEP_SUMMARY');
  }
});
