// Every probe has a synthetic home. No client key or credential store is opened.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

const checkout = resolve(import.meta.dir, '..');
const controlRoot = join(homedir(), '.cache', 'teamcli-test-controls');
mkdirSync(controlRoot, { recursive: true });
const controls = realpathSync(mkdtempSync(join(controlRoot, 'fixture-root-')));
const home = join(controls, 'synthetic-home');
mkdirSync(home);
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'fixture-root-')));
const safeRoot = join(controls, 'scratch');
mkdirSync(safeRoot);
const tempLink = join(controls, 'temp-link');
const checkoutLink = join(controls, 'checkout-link');
const safeLink = join(controls, 'safe-link');
symlinkSync(temporary, tempLink);
symlinkSync(checkout, checkoutLink);
symlinkSync(safeRoot, safeLink);

type Probe = { available: boolean; path?: string; error?: string };

function probe(root: string | undefined, cwd = controls): Probe {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TEAMCLI_TEST_SCRATCH;
  if (root !== undefined) env.TEAMCLI_TEST_SCRATCH = root;
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'adapters', 'fixture-root-probe.ts'), 'independent-'], {
    cwd, env, encoding: 'utf8', timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Probe;
}

for (const [label, root, reason] of [
  ['the temp root', realpathSync(tmpdir()), /temp directory/i],
  ['a descendant of temp', temporary, /temp directory/i],
  ['a link into temp', tempLink, /temp directory/i],
  ['the checkout root', checkout, /inside the checkout|temp directory/i],
  ['a descendant of the checkout', join(checkout, 'test'), /inside the checkout|temp directory/i],
  ['a link into the checkout', checkoutLink, /inside the checkout|temp directory/i],
] as const) {
  test(`fixture scratch refuses ${label}`, () => {
    const result = probe(root);
    expect(result.available).toBe(true);
    expect(result.path).toBeUndefined();
    expect(result.error).toMatch(reason);
    expect(result.error).toContain('TEAMCLI_TEST_SCRATCH');
  });
}

test('the scratch override uses its canonical root and allocates distinct prefixed folders', () => {
  const first = probe(safeLink);
  const second = probe(safeLink);
  expect(first.available).toBe(true);
  expect(second.available).toBe(true);
  expect(first.error).toBeUndefined();
  expect(second.error).toBeUndefined();
  expect(first.path?.startsWith(realpathSync(safeRoot) + sep)).toBe(true);
  expect(second.path?.startsWith(realpathSync(safeRoot) + sep)).toBe(true);
  expect(basename(first.path ?? '').startsWith('independent-')).toBe(true);
  expect(first.path).not.toBe(second.path);
});

for (const root of [undefined, '']) {
  test(`a ${root === undefined ? 'missing' : 'blank'} override uses the synthetic home even from a temp working directory`, () => {
    const result = probe(root, temporary);
    expect(result.available).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.path?.startsWith(join(home, '.cache', 'teamcli-tests') + sep)).toBe(true);
    expect(result.path?.startsWith(temporary + sep)).toBe(false);
    expect(result.path?.startsWith(checkout + sep)).toBe(false);
  });
}
