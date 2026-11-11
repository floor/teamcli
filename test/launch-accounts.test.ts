// Provider launch accounts are read from the entity's file, and only from a safe one.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAccountFor, launchAccountsPath } from '../src/launchers/accounts.ts';

let home = '';
afterEach(() => { if (home !== '') rmSync(home, { recursive: true, force: true }); home = ''; });

function write(text: string): string {
  home = mkdtempSync(join(tmpdir(), 'accounts-'));
  const path = launchAccountsPath(home, 'acme');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

const FILE = [
  'accounts:',
  '  deepseek:',
  '    provider: deepseek',
  '    endpoint: https://api.deepseek.com/anthropic',
  '    keychain: deepseek-api-key',
  '    default_model: deepseek-flash',
  '    auto_compact_window: 786432',
  '  kimi:',
  '    provider: kimi',
  '    endpoint: https://api.kimi.ai/coding/',
  '    keychain: kimi-api-key',
  '    default_model: k3-256k',
  '  broken:',
  '    provider: x',
  '    endpoint: "https://x.example/$(id)"',
  '    keychain: k',
  '',
].join('\n');

test('a seat finds its account by name, or by its vendor', () => {
  write(FILE);
  expect(launchAccountFor(home, 'acme', 'deepseek', undefined)?.defaultModel).toBe('deepseek-flash');
  expect(launchAccountFor(home, 'acme', undefined, 'moonshot')?.defaultModel).toBe('k3-256k');
  expect(launchAccountFor(home, 'acme', undefined, 'anthropic')).toBeNull();
  expect(launchAccountFor(home, 'other', 'deepseek', undefined)).toBeNull();
});

test('a value a shell would read twice makes the account unusable', () => {
  write(FILE);
  expect(launchAccountFor(home, 'acme', 'broken', undefined)).toBeNull();
});

test('a file writable by others, or a link, is not read', () => {
  const path = write(FILE);
  chmodSync(path, 0o666);
  expect(launchAccountFor(home, 'acme', 'deepseek', undefined)).toBeNull();
  chmodSync(path, 0o600);
  const linked = join(home, 'elsewhere.yaml');
  writeFileSync(linked, FILE, { mode: 0o600 });
  rmSync(path);
  symlinkSync(linked, path);
  expect(launchAccountFor(home, 'acme', 'deepseek', undefined)).toBeNull();
});
