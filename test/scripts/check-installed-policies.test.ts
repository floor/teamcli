import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInstalledPolicies } from '../../scripts/check-installed-policies.mjs';

test('setup checks the installed catalogue through its bin symlink, before policy writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-policy-'));
  try {
    mkdirSync(join(root, 'dist/policy'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'dist/cli.js'), '');
    symlinkSync(join(root, 'dist/cli.js'), join(root, 'team'));
    writeFileSync(join(root, 'dist/policy/types.js'), 'export const getPolicySpec = () => null;');
    await expect(checkInstalledPolicies(join(root, 'team'), 'mac')).rejects.toThrow('installed team does not support owner-signers');
    await expect(checkInstalledPolicies(join(root, 'missing'), 'mac')).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('matching catalogue accepts the exact owner setup values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'supported-policy-'));
  try {
    mkdirSync(join(root, 'policy'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'cli.js'), '');
    writeFileSync(join(root, 'policy/types.js'), `export { getPolicySpec } from ${JSON.stringify(join(process.cwd(), 'src/policy/types.ts'))};`);
    await expect(checkInstalledPolicies(join(root, 'cli.js'), 'mac')).resolves.toBeUndefined();
    await expect(checkInstalledPolicies(join(root, 'cli.js'), 'Invalid signer')).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
