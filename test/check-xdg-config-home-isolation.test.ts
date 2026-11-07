// The test preload clears `XDG_CONFIG_HOME` before any scene runs, so an ambient XDG config base
// in the caller's environment never redirects `hostConfigPath(home)` away from a scene's scratch
// home to a shared or live config file. A scene that tests XDG resolution sets `XDG_CONFIG_HOME`
// itself inside the test.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { hostConfigPath } from '../src/herdr.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('test preload XDG_CONFIG_HOME isolation', () => {
  test("with XDG_CONFIG_HOME pointing at a scratch folder holding the terminal host's config.toml, check-repair passes and leaves the file byte-identical", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-xdg-preload-guard-')));
    tempDirs.push(base);

    process.env.XDG_CONFIG_HOME = base;
    const cfgFile = hostConfigPath('/unused/home');
    delete process.env.XDG_CONFIG_HOME;

    mkdirSync(dirname(cfgFile), { recursive: true });
    const originalBytes = Buffer.from('# ambient config outside the scene home\n[ui]\nfont_size = 14\n', 'utf8');
    writeFileSync(cfgFile, originalBytes, { mode: 0o600 });

    const run = spawnSync(process.execPath, ['test', 'test/check-repair.test.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: base },
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(readFileSync(cfgFile).equals(originalBytes)).toBe(true);
    expect(existsSync(`${cfgFile}.team-backup`)).toBe(false);
  });

  test('a test that sets XDG_CONFIG_HOME itself still reaches hostConfigPath under that base', () => {
    expect(process.env.XDG_CONFIG_HOME).toBeUndefined();
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-xdg-explicit-')));
    tempDirs.push(base);
    process.env.XDG_CONFIG_HOME = base;
    expect(hostConfigPath('/scratch/home')).toBe(join(base, 'herdr', 'config.toml'));
  });
});
