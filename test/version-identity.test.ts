import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Load the production readers beside a synthetic manifest, without changing this checkout. */
async function readers(fields: Record<string, unknown>): Promise<typeof import('../src/version.ts')> {
  const root = mkdtempSync(join(tmpdir(), 'version-identity-'));
  fixtures.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3', ...fields }));
  const source = join(root, 'src', 'version.ts');
  copyFileSync(new URL('../src/version.ts', import.meta.url), source);
  return import(pathToFileURL(source).href);
}

test('daemon and inbox identity readers both report null for a non-40-hex manifest value', async () => {
  const identity = await readers({ gitHead: 'not-a-commit' });
  expect(identity.gitHead()).toBeNull();
  expect(identity.packagedHead()).toBeNull();
  expect(identity.installIdentity().head).toBeNull();
  expect(identity.buildIdentity([]).head).toBeNull();
});

test('daemon and inbox identity readers retain the same valid packaged commit', async () => {
  const head = 'a'.repeat(40);
  const identity = await readers({ gitHead: head });
  expect(identity.gitHead()).toBe(head);
  expect(identity.packagedHead()).toBe(head);
  expect(identity.installIdentity().head).toBe(head);
  expect(identity.buildIdentity([]).head).toBe(head);
});

test('daemon and inbox identity readers both report null without a packaged commit', async () => {
  const identity = await readers({});
  expect(identity.gitHead()).toBeNull();
  expect(identity.packagedHead()).toBeNull();
  expect(identity.installIdentity().head).toBeNull();
  expect(identity.buildIdentity([]).head).toBeNull();
});
