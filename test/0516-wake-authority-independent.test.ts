import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as paths from '../src/daemon/paths.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

test('one daemon wake authority cannot be replayed or redirected with a path-shaped nonce', async () => {
  const module = new URL('../src/daemon/wake/token.ts', import.meta.url);
  // The parent predates this authority path: a controlled assertion, not an import failure.
  expect(existsSync(module)).toBe(true);
  const token = await import(module.href);
  const base = mkdtempSync(join(tmpdir(), 'independent-wake-authority-')); made.push(base);
  const home = join(base, 'home'); mkdirSync(home);
  const request = { version: 1, id: 'synthetic-message', seat: 'worker', session: 'morning', cli: 'grok',
    line: 'Read the synthetic task.', dropPath: join(base, 'drop'), dir: join(base, '.agents'), root: base,
    project: 'sample', home, from: 'lead', body: 'synthetic message', stagedAt: 12345 };
  const nonce = token.writeWakeInherit(request);
  expect(/^[0-9a-f]{32}$/.test(nonce)).toBe(true);
  const first = token.readWakeInherit(home, nonce);
  expect(first.kind).toBe('ok');
  expect(first.request).toEqual(request);
  expect(token.readWakeInherit(home, nonce).kind).toBe('refused');
  expect(existsSync(paths.wakeInheritPath(home, nonce))).toBe(false);
  const sentinel = join(base, 'outside.txt'); writeFileSync(sentinel, 'synthetic outside file\n');
  expect(token.readWakeInherit(home, '../outside.txt').kind).toBe('refused');
  expect(readFileSync(sentinel, 'utf8')).toBe('synthetic outside file\n');
  const malformed = 'a'.repeat(32);
  writeFileSync(paths.wakeInheritPath(home, malformed), '{invalid json', { mode: 0o600 });
  expect(token.readWakeInherit(home, malformed).kind).toBe('refused');
  expect(token.readWakeInherit(home, malformed).kind).toBe('refused');
  expect(existsSync(paths.wakeInheritPath(home, malformed))).toBe(false);
});
