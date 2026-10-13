// Reads `.github/workflows/release.yml` as YAML. A pull request does not run
// that workflow, so the condition on each publishing job is checked here.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PINNED = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";

type Context = { eventName: string; ref: string };

type Step = { run?: unknown; uses?: unknown };

type Job = {
  if?: unknown;
  uses?: unknown;
  permissions?: unknown;
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
