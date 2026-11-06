// `pretrust` is an owner-signed catalogue word. `project` writes a captured trust record for a
// real folder inside the project root. `off` writes nothing. A CLI whose record was never
// captured is refused, and nothing is typed into a pane.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import type { Io } from '../src/io.ts';
import { grantedFolderPretrust, projectRootPretrust, type PretrustSeat } from '../src/launch/pretrust.ts';
import { pathInsideRoot, pretrustDecision } from '../src/policy/first-minute.ts';
import { POLICY_CATALOGUE, resolvePolicy, type Policy } from '../src/policy/index.ts';

const NOW = new Date('2026-11-06T16:00:00Z');
const STAMP = '2026-11-06T16:00:00Z';

function word(level: Policy['level'], value: 'off' | 'project'): Policy {
  return { name: 'pretrust', value, level, setter: 'owner', date: STAMP, kind: 'enforced' };
}

function seat(cli: string, cwd: string): PretrustSeat {
  return { cli, cwd };
}

function world() {
  const base = realpathSync(mkdtempSync('/tmp/pretrust-'));
  const home = join(base, 'home');
  const root = join(base, 'project');
  const inside = join(root, 'src');
  mkdirSync(home, { recursive: true });
  mkdirSync(inside, { recursive: true });
  return { base, home, root: realpathSync(root), inside: realpathSync(inside) };
}

const covered = { covers: () => true, listed: () => false };

describe('pretrust catalogue', () => {
  test('the word is off or project, and the release default is project', () => {
    const spec = POLICY_CATALOGUE.pretrust;
    expect(spec.kind).toBe('enforced');
    expect(spec.defaultValue).toBe('project');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.parseValue('off')).toBe('off');
    expect(spec.parseValue('project')).toBe('project');
    expect(spec.parseValue('guessed')).toBeNull();
    const unset = resolvePolicy('pretrust', []);
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.effective.value).toBe('project');
  });

  test('a lower level may turn pretrust off and may not turn it back on', () => {
    const tightened = resolvePolicy('pretrust', [word('entity', 'project'), word('team', 'off')]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) expect(tightened.effective.value).toBe('off');
    const loosened = resolvePolicy('pretrust', [word('entity', 'off'), word('team', 'project')]);
    expect(loosened.ok).toBe(false);
  });

  test('team policy keys lists pretrust', async () => {
    let out = '';
    const io: Io = {
      stdout: (text) => void (out += text),
      stderr: () => {},
      cwd: '/',
      env: {},
      stdinIsTTY: false,
    };
    expect(await runPolicy(['keys'], io)).toBe(0);
    expect(out.split('\n')).toContain('pretrust');
  });
});

describe('pretrust refusals', () => {
  test('off writes no trust record', () => {
    const dir = world();
    try {
      expect(pretrustDecision('grok', 'off')).toBe('off');
      expect(projectRootPretrust(seat('grok', dir.root), dir.home, { now: NOW, root: dir.root, mode: 'off' })).toBe(false);
      expect(
        grantedFolderPretrust(seat('grok', dir.inside), dir.home, {
          now: NOW,
          grant: covered,
          root: dir.root,
          mode: 'off',
        }),
      ).toBe(false);
      expect(existsSync(join(dir.home, '.grok', 'trusted_folders.toml'))).toBe(false);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });

  test('a guessed record is refused and an inside-root folder of a captured CLI is written', () => {
    const dir = world();
    try {
      expect(pretrustDecision('gemini', 'project')).toBe('guessed');
      expect(pretrustDecision('antigravity', 'project')).toBe('guessed');
      expect(
        grantedFolderPretrust(seat('gemini', dir.inside), dir.home, {
          now: NOW,
          grant: covered,
          root: dir.root,
          mode: 'project',
        }),
      ).toBe(false);
      expect(
        grantedFolderPretrust(seat('grok', dir.inside), dir.home, {
          now: NOW,
          grant: covered,
          root: dir.root,
          mode: 'project',
        }),
      ).toBe(true);
      expect(existsSync(join(dir.home, '.grok', 'trusted_folders.toml'))).toBe(true);
      expect(projectRootPretrust(seat('codex', dir.root), dir.home, { now: NOW, root: dir.root, mode: 'project' })).toBe(true);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });

  test('a path through a link, a parent, or the home directory is outside the root', () => {
    const dir = world();
    try {
      const outside = join(dir.base, 'outside');
      mkdirSync(outside);
      const link = join(dir.root, 'via-link');
      symlinkSync(outside, link);
      expect(pathInsideRoot(link, dir.root, dir.home)).toBe(false);
      expect(pathInsideRoot(dir.base, dir.root, dir.home)).toBe(false);
      expect(pathInsideRoot(dir.home, dir.home, dir.home)).toBe(false);
      expect(pathInsideRoot(dir.inside, dir.root, dir.home)).toBe(true);
    } finally {
      rmSync(dir.base, { recursive: true, force: true });
    }
  });
});
