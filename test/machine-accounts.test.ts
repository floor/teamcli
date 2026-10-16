// The machine's own accounts: the file the owner's subscriptions live in, and the account each
// seat draws on by its CLI and launcher. The parsing tests keep to a temp home — the real
// `~/.config/team/accounts.yaml` is the owner's file, and no test reads it.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineAccountsOf, machineAccountsPath, payingAccountOf } from '../src/information/machine-accounts.ts';

/** A seat-shaped input, the four fields the mapping reads. */
function seat(cli: string, launch: string, vendor = cli, account?: string) {
  return { cli, launch, vendor, ...(account === undefined ? {} : { account }) };
}

describe('machine accounts', () => {
  describe('the file', () => {
    let base: string;
    let home: string;
    const write = (text: string | null) => {
      mkdirSync(join(home, '.config', 'team'), { recursive: true });
      if (text !== null) writeFileSync(machineAccountsPath(home), text);
    };

    test('an absent file reads as no machine accounts', () => {
      base = mkdtempSync(join(tmpdir(), 'team-accounts-'));
      home = join(base, 'home');
      expect(machineAccountsOf(home)).toEqual([]);
      expect(machineAccountsPath(home)).toBe(join(home, '.config', 'team', 'accounts.yaml'));
      rmSync(base, { recursive: true, force: true });
    });

    test('an accounts list reads as its names, sorted, once each', () => {
      base = mkdtempSync(join(tmpdir(), 'team-accounts-'));
      home = join(base, 'home');
      write('accounts:\n  - xai\n  - openai\n  - xai\n');
      expect(machineAccountsOf(home)).toEqual(['openai', 'xai']);
      rmSync(base, { recursive: true, force: true });
    });

    test('a file that is not one accounts list reads as none', () => {
      for (const text of ['- xai\n', 'accounts: xai\n', 'other:\n  - xai\n', 'accounts: []\n', 'accounts:\n  - 1\n']) {
        base = mkdtempSync(join(tmpdir(), 'team-accounts-'));
        home = join(base, 'home');
        write(text);
        expect(machineAccountsOf(home), text).toEqual([]);
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('the seat mapping, by CLI and launcher', () => {
    test('each shipped CLI maps to the account that pays for it', () => {
      expect(payingAccountOf(seat('grok', 'grok --always-approve', 'xai'))).toBe('xai');
      expect(payingAccountOf(seat('antigravity', 'agy', 'google'))).toBe('google-antigravity');
      expect(payingAccountOf(seat('gemini', 'gemini', 'google'))).toBe('google-gemini');
      expect(payingAccountOf(seat('codex', 'codex', 'openai'))).toBe('openai');
      expect(payingAccountOf(seat('cursor', 'cursor --model x', 'cursor'))).toBe('cursor');
    });

    test('a claude-code seat maps by its launcher', () => {
      expect(payingAccountOf(seat('claude-code', 'claude --model claude-opus-5-5', 'anthropic'))).toBe('anthropic');
      expect(payingAccountOf(seat('claude-code', 'claude-glm.sh --model glm-5.3', 'anthropic'))).toBe('zai');
      expect(payingAccountOf(seat('claude-code', '~/bin/claude-deepseek.sh', 'anthropic'))).toBe('deepseek');
    });

    test('a seat that names its own account spends that one, whatever it runs', () => {
      expect(payingAccountOf(seat('grok', 'grok', 'xai', 'work-xai'))).toBe('work-xai');
      expect(payingAccountOf(seat('claude-code', 'claude-glm.sh', 'anthropic', 'shared'))).toBe('shared');
    });

    test('a CLI the mapping does not know keeps its vendor', () => {
      expect(payingAccountOf(seat('other-cli', 'other-cli run', 'otherlab'))).toBe('otherlab');
    });
  });
});
