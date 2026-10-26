// At launch, a seat that starts in the team's project root has its CLI's folder question
// pre-accepted in the record that CLI already reads — never by typing into its pane — and only
// for the project root (the lobby has its own writer). Missing or project-relative trust derives
// exactly the lobby and the project root. Hermetic: temp HOME and roots only.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRootPretrust } from '../../src/launch/pretrust.ts';
import { derivedTrust } from '../../src/file/migrate.ts';

const made: string[] = [];
afterAll(() => { for (const b of made) rmSync(b, { recursive: true, force: true }); });
const NOW = new Date('2026-10-26T11:00:00.000Z');

function place() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'root-pretrust-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(home, { recursive: true });
  mkdirSync(root);
  mkdirSync(elsewhere);
  return { home, root, elsewhere };
}

describe('the project root is pre-accepted in each CLI record', () => {
  test('claude-code, codex, grok and cursor: written for the project root, and again is a no-op', () => {
    const p = place();
    for (const cli of ['claude-code', 'codex', 'grok', 'cursor']) {
      expect(projectRootPretrust({ cli, cwd: p.root }, p.home, { now: NOW, root: p.root }), cli).toBe(true);
    }
    const claude = JSON.parse(readFileSync(join(p.home, '.claude.json'), 'utf8'));
    expect(claude.projects[p.root].hasTrustDialogAccepted).toBe(true);
    expect(readFileSync(join(p.home, '.codex', 'config.toml'), 'utf8')).toContain(`[projects."${p.root}"]\ntrust_level = "trusted"`);
    expect(readFileSync(join(p.home, '.grok', 'trusted_folders.toml'), 'utf8')).toContain(`[folders."${p.root}"]\ntrusted = true`);
    const slug = p.root.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    expect(existsSync(join(p.home, '.cursor', 'projects', slug, '.workspace-trusted'))).toBe(true);
    const before = readFileSync(join(p.home, '.claude.json'), 'utf8');
    expect(projectRootPretrust({ cli: 'claude-code', cwd: p.root }, p.home, { now: NOW, root: p.root })).toBe(true);
    expect(readFileSync(join(p.home, '.claude.json'), 'utf8')).toBe(before);
  });

  test('nothing for a folder that is not the project root, a lobby seat, a seat that does not start, or a CLI with no captured record', () => {
    const p = place();
    expect(projectRootPretrust({ cli: 'claude-code', cwd: p.elsewhere }, p.home, { now: NOW, root: p.root })).toBe(false);
    expect(projectRootPretrust({ cli: 'claude-code', cwd: p.root, lobby: true }, p.home, { now: NOW, root: p.root })).toBe(false);
    expect(projectRootPretrust({ cli: 'claude-code', cwd: p.root, stopped: true }, p.home, { now: NOW, root: p.root })).toBe(false);
    expect(projectRootPretrust({ cli: 'antigravity', cwd: p.root }, p.home, { now: NOW, root: p.root })).toBe(false);
    expect(projectRootPretrust({ cli: 'claude-code', cwd: 'acme' }, p.home, { now: NOW, root: p.root })).toBe(false);
    expect(existsSync(join(p.home, '.claude.json'))).toBe(false);
  });
});

describe('derived trust', () => {
  const team = (trust?: string[]) => ({ project: 'acme', workspace: { mode: 'shared' as const }, seats: [], entity: null, lobby: null, session: 'acme', ...(trust ? { trust } : {}) }) as never;
  test('missing, empty or project-relative trust derives the lobby and the project root, absolute, with the block to keep it', () => {
    const p = place();
    for (const trust of [undefined, [], ['.', '../worktrees/acme/*']]) {
      const derived = derivedTrust(team(trust), p.root, p.home);
      expect(derived?.trust).toEqual(['~/.config/team/lobby', p.root]);
      expect(derived?.warning).toContain(`this run trusts only the lobby ${join(p.home, '.config', 'team', 'lobby')} and the project root ${p.root}`);
      expect(derived?.warning).toContain('trust:\n  - ~/.config/team/lobby\n');
    }
  });
  test('absolute trust is left as written', () => {
    const p = place();
    expect(derivedTrust(team(['~/.config/team/lobby', p.root]), p.root, p.home)).toBeNull();
  });
});
