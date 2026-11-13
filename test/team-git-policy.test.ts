// The checks team git and team gh make before anything runs, and the token read from the
// system's secret store on every platform that has one.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ghRefusal, gitRefusal, runGitHub } from '../src/commands/git.ts';
import type { Io } from '../src/io.ts';
import { systemSecretStore, type SecretRunOptions, type SecretStore } from '../src/secrets/store.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { testIo } from './helpers.ts';

test('a push of the seat\'s own branch passes; force, delete, mirror and trunk pushes are refused', () => {
  expect(gitRefusal('push', ['origin', 'feat/x'], 'feat/x')).toBeNull();
  expect(gitRefusal('push', ['-u', 'origin', 'feat/x'], 'feat/x')).toBeNull();
  for (const args of [['--force'], ['-f', 'origin', 'x'], ['--force-with-lease'], ['origin', '+x'], ['--delete', 'origin', 'x'], ['--mirror'], ['--all']]) {
    expect(gitRefusal('push', args, 'x'), args.join(' ')).not.toBeNull();
  }
  expect(gitRefusal('push', ['origin', 'main'], 'feat/x')).toContain('main');
  expect(gitRefusal('push', ['origin', 'HEAD:refs/heads/master'], 'feat/x')).toContain('master');
  expect(gitRefusal('push', [], 'main')).toContain('main');
});

test('fetch and pull pass; any other git verb goes to plain git', () => {
  expect(gitRefusal('fetch', ['origin'], 'main')).toBeNull();
  expect(gitRefusal('pull', [], 'main')).toBeNull();
  expect(gitRefusal('commit', ['-m', 'x'], 'x')).not.toBeNull();
});

test('gh reads and ordinary writes pass; merge, release, credentials and api writes are refused', () => {
  expect(ghRefusal(['pr', 'view', '12'])).toBeNull();
  expect(ghRefusal(['issue', 'comment', '3', '--body', 'x'])).toBeNull();
  expect(ghRefusal(['api', 'repos/o/r/pulls'])).toBeNull();
  expect(ghRefusal(['pr', 'merge', '12'])).not.toBeNull();
  expect(ghRefusal(['release', 'create', 'v1'])).not.toBeNull();
  expect(ghRefusal(['auth', 'token'])).not.toBeNull();
  expect(ghRefusal(['secret', 'set', 'X'])).not.toBeNull();
  expect(ghRefusal(['repo', 'delete', 'o/r'])).not.toBeNull();
  expect(ghRefusal(['api', '-X', 'POST', 'repos/o/r/issues'])).not.toBeNull();
  expect(ghRefusal(['api', 'repos/o/r/issues', '-f', 'title=x'])).not.toBeNull();
  expect(ghRefusal([])).not.toBeNull();
});

describe('gh api refusals read every spelling gh takes (review finding 1)', () => {
  test('attached and = forms of a method or a field are refused', () => {
    for (const args of [
      ['api', 'repos/o/r/issues', '--method=POST'],
      ['api', 'repos/o/r/issues', '-XPOST'],
      ['api', 'repos/o/r/issues', '-X', 'PATCH'],
      ['api', 'repos/o/r/issues', '--field=title=x'],
      ['api', 'repos/o/r/issues', '--raw-field=body=x'],
      ['api', 'repos/o/r/issues', '--input=body.json'],
      ['api', 'repos/o/r/issues', '-ftitle=x'],
      ['api', 'repos/o/r/issues', '-Fbody=@x'],
      ['api', 'graphql', '-q', '.data'],
    ]) expect(ghRefusal(args), args.join(' ')).not.toBeNull();
  });

  test('a plain read is still allowed', () => {
    expect(ghRefusal(['api', 'repos/o/r/pulls'])).toBeNull();
    expect(ghRefusal(['api', 'repos/o/r/pulls', '--method', 'GET'])).toBeNull();
    expect(ghRefusal(['api', 'repos/o/r/pulls', '--jq', '.[].number'])).toBeNull();
  });
});

describe('the token comes from the system\'s secret store, on Linux as on macOS', () => {
  const made: string[] = [];
  afterEach(() => discardFixtures(made.splice(0)));

  const TOKEN = 'ghp-fixture-0123456789';

  /** A synthetic home holding one entity identity, and a folder outside every repository. */
  function scene(): { home: string; cwd: string } {
    const base = mkdtempSync(join(tmpdir(), 'team-gh-store-'));
    made.push(base);
    const home = join(base, 'home');
    const dir = join(home, '.config', 'team', 'entities', 'acme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'identity.yaml'), [
      'github:',
      '  account: acme-bot',
      '  author_name: Acme Bot',
      '  author_email: bot@example.com',
      '  keychain: acme-github-token',
      '',
    ].join('\n'), { mode: 0o600 });
    const cwd = join(base, 'work');
    mkdirSync(cwd);
    return { home, cwd };
  }

  /** The encrypted-dotenv store on a synthetic machine, its decrypt answered by `stdout`. */
  function linuxStore(home: string, stdout: string | null, calls: { args: string[]; options: SecretRunOptions }[]): SecretStore {
    return systemSecretStore({
      platform: 'linux',
      home,
      env: { HOME: home, PATH: '/usr/bin' },
      isFile: () => true,
      isExecutable: (path) => path === '/usr/bin/sops',
      runner: async (_command, args, options) => {
        calls.push({ args, options });
        return stdout === null ? { ok: false } : { ok: true, stdout };
      },
    })!;
  }

  function ioFor(cwd: string, home: string): Io & { out: string; err: string } {
    const io = testIo(cwd);
    io.env = { HOME: home, PATH: '/usr/bin' };
    return io;
  }

  test('team gh on Linux reads the entry under its env form and hands the token to gh alone', async () => {
    const { home, cwd } = scene();
    const calls: { args: string[]; options: SecretRunOptions }[] = [];
    const ran: { binary: string; args: string[]; env: Record<string, string> }[] = [];
    const io = ioFor(cwd, home);
    const code = await runGitHub('gh', ['pr', 'view', '12'], io, {
      store: linuxStore(home, `OTHER=x\nACME_GITHUB_TOKEN=${TOKEN}\n`, calls),
      run: async (binary, args, _io, env) => { ran.push({ binary, args, env }); return 0; },
    });
    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.join(' ')).not.toContain(TOKEN);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.binary).toBe('gh');
    expect(ran[0]!.args).toEqual(['pr', 'view', '12']);
    expect(ran[0]!.env.GH_TOKEN).toBe(TOKEN);
    expect(ran[0]!.env.GIT_AUTHOR_NAME).toBe('Acme Bot');
  });

  test('a store that cannot answer says why, never the value, and gh never runs', async () => {
    const { home, cwd } = scene();
    let ran = 0;
    const run = async () => { ran += 1; return 0; };
    const missing = ioFor(cwd, home);
    expect(await runGitHub('gh', ['pr', 'view', '12'], missing, { store: linuxStore(home, `OTHER=${TOKEN}\n`, []), run })).toBe(1);
    expect(missing.err).toBe('team gh: the GitHub token could not be read (the system\'s secret store holds no entry for it)\n');
    const failed = ioFor(cwd, home);
    expect(await runGitHub('gh', ['pr', 'view', '12'], failed, { store: linuxStore(home, null, []), run })).toBe(1);
    expect(failed.err).toBe('team gh: the GitHub token could not be read (the system\'s secret store could not be opened)\n');
    expect(missing.err + failed.err).not.toContain(TOKEN);
    expect(ran).toBe(0);
  });

  test('a platform with no store refuses after the identity, before anything is read', async () => {
    const { home, cwd } = scene();
    const io = ioFor(cwd, home);
    expect(await runGitHub('gh', ['pr', 'view', '12'], io, { store: null, run: async () => 0 })).toBe(1);
    expect(io.err).toBe('team gh: the token\'s store is not available on this platform\n');
  });

  test('a refused command reads no store at all', async () => {
    const { home, cwd } = scene();
    const calls: { args: string[]; options: SecretRunOptions }[] = [];
    const io = ioFor(cwd, home);
    expect(await runGitHub('gh', ['pr', 'merge', '12'], io, { store: linuxStore(home, `ACME_GITHUB_TOKEN=${TOKEN}\n`, calls), run: async () => 0 })).toBe(1);
    expect(io.err).toBe('team gh: refused: gh pr merge is refused: a merge goes through its gate\n');
    expect(calls).toHaveLength(0);
  });
});
