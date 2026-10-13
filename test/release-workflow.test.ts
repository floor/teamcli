// The release workflow's proof lives here. A pull request does not run that
// workflow, so this test reads `.github/workflows/release.yml` and checks the
// trigger and the two jobs that publish.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const text = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');

const TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";

/** From a top-level key through the line before the next top-level key. */
function top(source: string, key: string): string {
  const start = source.search(new RegExp(`^${key}:\\s*$`, 'm'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const next = rest.slice(key.length + 2).search(/^[A-Za-z]/m);
  return next < 0 ? rest : rest.slice(0, key.length + 2 + next);
}

/** One job, from its name through the line before the next job. */
function job(name: string): string {
  const jobs = top(text, 'jobs');
  const marker = `  ${name}:`;
  const start = jobs.indexOf(`${marker}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = jobs.slice(start);
  const next = rest.slice(marker.length).search(/\n  [a-z]/);
  return next < 0 ? rest : rest.slice(0, marker.length + next);
}

/** One named step, from its `- name:` through the line before the next step. */
function step(jobBody: string, name: string): string {
  const marker = `- name: ${name}\n`;
  const start = jobBody.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = jobBody.slice(start);
  const next = rest.slice(marker.length).search(/\n {6}- /);
  return next < 0 ? rest : rest.slice(0, marker.length + next);
}

test('a dispatch is a trigger, and both publishing jobs require a tag push', () => {
  const on = top(text, 'on');
  expect(on).toContain('\n  workflow_dispatch:\n');
  expect(on).not.toContain('inputs:');

  const verify = job('verify');
  expect(verify).toContain('os: [ubuntu-latest, macos-latest]');
  expect(verify.startsWith('  verify:\n    strategy:')).toBe(true);
  const pack = step(verify, 'Pack the tarball');
  expect(pack).not.toContain('\n        if:');

  for (const name of ['publish', 'github-release']) {
    const body = job(name);
    const guard = body.split('\n').find((line) => line.trimStart().startsWith('if:'));
    expect(guard).toContain(TAG_PUSH);
    expect(guard).not.toContain('inputs.');
  }
});
