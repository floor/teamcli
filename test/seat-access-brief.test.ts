// A seat's own `access` overrides its role's default on a shipped launcher, and its own `brief`
// file rides with its rules at every launch.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readsOnly, shippedLauncher } from '../src/launchers/shipped.ts';
import { withSeatBrief } from '../src/launch/rules.ts';

describe('a seat\'s access', () => {
  test('the role decides when the seat names none', () => {
    expect(readsOnly('assistant')).toBe(true);
    expect(readsOnly('builder')).toBe(false);
  });

  test('an assistant that relays writes when it says so, and a builder can be held to reads', () => {
    expect(readsOnly('assistant', 'write')).toBe(false);
    expect(readsOnly('builder', 'read')).toBe(true);
    expect(shippedLauncher('grok-build', { role: 'assistant', access: 'write' })!.argv).toContain('--always-approve');
    expect(shippedLauncher('grok-build', { role: 'assistant' })!.argv).toContain('dontAsk');
  });
});

describe('a seat\'s brief', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-brief-'));
  writeFileSync(join(root, 'brief.md'), 'Relay every ask whole.\n');

  test('the brief follows the team\'s rules, read from the seat\'s file', () => {
    const rules = withSeatBrief('team rules', { brief: 'brief.md' }, root);
    expect(rules.startsWith('team rules')).toBe(true);
    expect(rules).toContain('Relay every ask whole.');
  });

  test('a brief named from the home folder with ~ is read there', () => {
    const rules = withSeatBrief('team rules', { brief: '~/.no-such-brief-file' }, root);
    expect(rules).toContain(`${homedir()}/.no-such-brief-file`);
  });

  test('a seat with no brief keeps the team\'s rules as they are', () => {
    expect(withSeatBrief('team rules', {}, root)).toBe('team rules');
  });

  test('a brief that cannot be read is named, never dropped in silence', () => {
    expect(withSeatBrief('team rules', { brief: 'missing.md' }, root)).toContain('could not be read');
  });
});
