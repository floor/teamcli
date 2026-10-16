// The machine's own accounts: the file the owner's subscriptions live in, and the account each
// seat draws on by its CLI and launcher. The parsing tests keep to a temp home — the real
// `~/.config/team/accounts.yaml` is the owner's file, and no test reads it.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineAccountsByEntityOf, machineAccountsOf, machineAccountsPath, ownerEntityOf, payingAccountOf } from '../src/information/machine-accounts.ts';

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

  describe('the accounts keyed by entity', () => {
    /** One temp home holding one file's bytes, read inside, wiped after — the file itself is the
     *  owner's own and no test reads it. */
    const withFile = (text: string, read: (home: string) => void) => {
      const base = mkdtempSync(join(tmpdir(), 'team-accounts-'));
      const home = join(base, 'home');
      mkdirSync(join(home, '.config', 'team'), { recursive: true });
      writeFileSync(machineAccountsPath(home), text);
      try {
        read(home);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    };

    test('an entity key with a list reads as that entity’s accounts, in file order', () => {
      withFile('accounts:\n  northwind: [openai, xai]\n  garden:\n    - anthropic-max\n', (home) => {
        expect(machineAccountsByEntityOf(home)).toEqual([
          { entity: 'northwind', accounts: ['openai', 'xai'] },
          { entity: 'garden', accounts: ['anthropic-max'] },
        ]);
        expect(machineAccountsOf(home)).toEqual(['anthropic-max', 'openai', 'xai']);
      });
    });

    test('the flat list stays one unnamed entity, read exactly as before', () => {
      withFile('accounts:\n  - xai\n  - openai\n  - xai\n', (home) => {
        expect(machineAccountsByEntityOf(home)).toEqual([{ entity: null, accounts: ['openai', 'xai'] }]);
        expect(machineAccountsOf(home)).toEqual(['openai', 'xai']);
      });
    });

    test('a map whose entries are no lists keeps the older reading: its keys are account names', () => {
      withFile('accounts:\n  xai:\n  openai: {}\n', (home) => {
        expect(machineAccountsByEntityOf(home)).toEqual([{ entity: null, accounts: ['openai', 'xai'] }]);
        expect(machineAccountsOf(home)).toEqual(['openai', 'xai']);
      });
    });

    test('the two readings mix in one map: a list under a key is that entity’s, anything else is a name', () => {
      withFile('accounts:\n  northwind: [xai]\n  openai:\n', (home) => {
        expect(machineAccountsByEntityOf(home)).toEqual([
          { entity: 'northwind', accounts: ['xai'] },
          { entity: null, accounts: ['openai'] },
        ]);
        expect(machineAccountsOf(home)).toEqual(['openai', 'xai']);
      });
    });

    test('a name two entities list is owned by the first entry in the file', () => {
      withFile('accounts:\n  northwind: [xai, shared]\n  garden: [xai, anthropic]\n', (home) => {
        expect([...ownerEntityOf(machineAccountsByEntityOf(home)).entries()]).toEqual([
          ['shared', 'northwind'],
          ['xai', 'northwind'],
          ['anthropic', 'garden'],
        ]);
      });
    });

    test('an unnamed entry and an empty list own nothing', () => {
      withFile('accounts:\n  garden: []\n  xai:\n', (home) => {
        expect(machineAccountsByEntityOf(home)).toEqual([
          { entity: 'garden', accounts: [] },
          { entity: null, accounts: ['xai'] },
        ]);
        expect([...ownerEntityOf(machineAccountsByEntityOf(home)).entries()]).toEqual([]);
        expect(machineAccountsOf(home)).toEqual(['xai']);
      });
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
