// The session server's forge shim. Measured: a credential helper for the forge's host is a shell
// command resolved on PATH (`!gh auth git-credential`), and with no seat token in the environment
// the CLI falls back to the account login stored on this machine. That login is the one seats
// push through on purpose today; the gap is that it also carries rights no seat was given, such as
// dispatching workflows. The shim stands first on the session server's PATH and runs the real CLI
// only when GH_TOKEN holds a non-empty value; otherwise it refuses in one line and exits 1. It never reads,
// prints or forwards the value: the real CLI execs with the environment as it is.
//
// Everything here is a fake: a synthetic CLI, a synthetic home and a synthetic credential helper
// chain. No real login is read, no network is reached, nothing is pushed.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_SEAT_TOKEN, forgeShimText, seatServerEnv, sessionBinDir, writeForgeShim } from '../src/herdr.ts';
import { DEFAULT_FORGE_SHIM, FORGE_SHIM_ENV, FORGE_SHIM_SETTING, resolveForgeShim } from '../src/settings/forge-shim.ts';

// git itself is the machine's own; only the credential helper and the forge CLI are fixtures.
const GIT = (() => {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, 'git'))) return join(dir, 'git');
  }
  return '/usr/bin/git';
})();

type World = {
  root: string;
  home: string;
  /** The folder holding the fake forge CLI, as a real PATH would. */
  real: string;
  /** The fake forge CLI: serves the stored login with no seat token, the seat token with one. */
  cli: string;
  /** Every run of the fake CLI, with its arguments and never the token's value. */
  log: string;
  /** A folder outside any repository, so git reads no project config. */
  work: string;
};

const roots: string[] = [];

function world(): World {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'team-forge-shim-')));
  roots.push(root);
  const home = join(root, 'home');
  const real = join(root, 'real');
  const work = join(root, 'work');
  for (const dir of [home, real, work]) mkdirSync(dir, { recursive: true });
  const log = join(root, 'runs.log');
  const cli = join(real, 'gh');
  // The account-like CLI. Without a token it answers the way the measured fallback did: the
  // stored login, here a synthetic value. It logs its arguments only.
  writeFileSync(
    cli,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'if [ "${GH_TOKEN+x}" = x ]; then',
      '  echo username=x-access-token',
      '  echo password=seat-token',
      'else',
      '  echo username=x-access-token',
      '  echo password=stored-account-token',
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(cli, 0o755);
  // The credential helper chain as the launcher writes it: the stored helpers reset, then the
  // forge CLI by name. Git resolves that name on PATH.
  writeFileSync(
    join(home, '.gitconfig'),
    ['[credential "https://github.com"]', '\thelper =', '\thelper = !gh auth git-credential', ''].join('\n'),
  );
  return { root, home, real, cli, log, work };
}

function settings(home: string, text: string): void {
  const dir = join(home, '.config', 'team');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.yaml'), text);
}

/** A session server's environment, as `seatServerEnv` builds it, plus the git words a child needs
 *  to read the synthetic config instead of the machine's. */
function serverEnv(w: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = seatServerEnv(
    {
      HOME: w.home,
      USER: 'fixture-user',
      LOGNAME: 'fixture-user',
      PATH: `${w.real}:/usr/bin:/bin`,
      SHELL: '/bin/sh',
      TERM: 'dumb',
      LANG: 'en_US.UTF-8',
      ...extra,
    },
    w.home,
  );
  return { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(w.home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0' };
}

function credentialFill(w: World, env: NodeJS.ProcessEnv) {
  const out = spawnSync(GIT, ['credential', 'fill'], {
    cwd: w.work,
    env,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

function shimOf(w: World): string {
  return join(sessionBinDir(w.home), 'gh');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the shim text', () => {
  test('it tests whether the token variable holds a value, and never expands the value itself', () => {
    const text = forgeShimText('/opt/fixture/gh');
    // `:+` yields a literal only when the variable is set and non-empty: an empty token is no token.
    expect(text).toContain('${GH_TOKEN:+x}');
    expect(text).not.toContain('$GH_TOKEN');
    expect(text).not.toContain('${GH_TOKEN}');
    expect(text).toContain(NO_SEAT_TOKEN);
    expect(text.trimEnd().endsWith(`exec '/opt/fixture/gh' "$@"`)).toBe(true);
  });

  test('the real CLI is quoted, a quote in its path included', () => {
    expect(forgeShimText("/opt/it's/gh").trimEnd().endsWith(`exec '/opt/it'\\''s/gh' "$@"`)).toBe(true);
  });
});

describe('the shim at run time', () => {
  test('no seat token: it refuses in one line, and the real CLI never runs', () => {
    const w = world();
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    const out = spawnSync('/bin/sh', [shimOf(w), 'auth', 'git-credential', 'get'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(NO_SEAT_TOKEN);
    expect(out.stdout).toBe('');
    expect(existsSync(w.log)).toBe(false);
  });

  test('a seat token: it execs the real CLI with the arguments, and the value never reaches the log', () => {
    const w = world();
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    const out = spawnSync('/bin/sh', [shimOf(w), 'auth', 'git-credential', 'get'], {
      env: { PATH: '/usr/bin:/bin', GH_TOKEN: 'seat-token' },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('username=x-access-token');
    expect(out.stdout).toContain('password=seat-token');
    const runs = readFileSync(w.log, 'utf8');
    expect(runs.trim()).toBe('auth git-credential get');
    expect(runs).not.toContain('seat-token');
  });

  test('the file is executable by its owner and renamed into place', () => {
    const w = world();
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    expect(statSync(shimOf(w)).mode & 0o777).toBe(0o755);
    // A second write of the same text keeps the file as it is.
    const first = readFileSync(shimOf(w), 'utf8');
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    expect(readFileSync(shimOf(w), 'utf8')).toBe(first);
  });

  test('an empty seat token is no token: it refuses, and the real CLI never runs', () => {
    const w = world();
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    const out = spawnSync('/bin/sh', [shimOf(w), 'auth', 'git-credential', 'get'], {
      env: { PATH: '/usr/bin:/bin', GH_TOKEN: '' },
      encoding: 'utf8',
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain(NO_SEAT_TOKEN);
    expect(out.stdout).toBe('');
    expect(existsSync(w.log)).toBe(false);
  });
});

describe('the shim install refuses an unsafe path', () => {
  test('a bin path that is a file is refused, not written through', () => {
    const w = world();
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    writeFileSync(sessionBinDir(w.home), 'not a directory');
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(false);
  });

  test('a linked bin folder receives nothing', () => {
    const w = world();
    const foreign = join(w.root, 'foreign');
    mkdirSync(foreign);
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    symlinkSync(foreign, sessionBinDir(w.home));
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(false);
    expect(readdirSync(foreign)).toEqual([]);
  });

  test('a matching shim behind a link is replaced by a real file', () => {
    const w = world();
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    const file = shimOf(w);
    const target = join(w.root, 'matching-shim');
    renameSync(file, target);
    symlinkSync(target, file);
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
  });

  test('a pre-created temporary name cannot be followed', () => {
    const w = world();
    const target = join(w.root, 'temp-target');
    writeFileSync(target, 'retained fixture bytes');
    mkdirSync(sessionBinDir(w.home), { recursive: true });
    symlinkSync(target, join(sessionBinDir(w.home), `gh.${process.pid}.tmp`));
    expect(writeForgeShim(sessionBinDir(w.home), w.cli)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('retained fixture bytes');
  });
});

describe('the session server environment', () => {
  test('it puts the shim first on PATH and names the real CLI it found', () => {
    const w = world();
    const env = serverEnv(w);
    expect(env.PATH?.split(':')[0]).toBe(sessionBinDir(w.home));
    const shim = readFileSync(shimOf(w), 'utf8');
    expect(shim).toContain(`exec '${w.cli}' "$@"`);
    expect(statSync(shimOf(w)).mode & 0o777).toBe(0o755);
  });

  test('the clean allowlist carries no token, and the agent socket passes through', () => {
    const w = world();
    const env = seatServerEnv(
      { HOME: w.home, PATH: `${w.real}:/usr/bin:/bin`, GH_TOKEN: 'never-forwarded', [FORGE_SHIM_ENV]: 'on', SSH_AUTH_SOCK: '/fixture/agent.sock' },
      w.home,
    );
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env[FORGE_SHIM_ENV]).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBe('/fixture/agent.sock');
  });

  test('a PATH without the forge CLI is left as it was, and no shim is written', () => {
    const w = world();
    const env = seatServerEnv({ HOME: w.home, PATH: '/usr/bin:/bin' }, w.home);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(existsSync(shimOf(w))).toBe(false);
  });

  test('a file called like the CLI but not executable is not it', () => {
    const w = world();
    chmodSync(w.cli, 0o644);
    const env = seatServerEnv({ HOME: w.home, PATH: `${w.real}:/usr/bin:/bin` }, w.home);
    expect(env.PATH).toBe(`${w.real}:/usr/bin:/bin`);
    expect(existsSync(shimOf(w))).toBe(false);
  });

  test('a server started from inside a seat skips the shim folder and names the real CLI', () => {
    const w = world();
    const dir = sessionBinDir(w.home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(shimOf(w), '#!/bin/sh\nexit 7\n');
    chmodSync(shimOf(w), 0o755);
    const env = seatServerEnv({ HOME: w.home, PATH: `${dir}:${w.real}:/usr/bin:/bin` }, w.home);
    expect(env.PATH?.startsWith(`${dir}:`)).toBe(true);
    expect(readFileSync(shimOf(w), 'utf8')).toContain(`exec '${w.cli}' "$@"`);
  });

  test('the machine setting off leaves the environment as it was', () => {
    const w = world();
    settings(w.home, `${FORGE_SHIM_SETTING}: off\n`);
    const env = seatServerEnv({ HOME: w.home, PATH: `${w.real}:/usr/bin:/bin` }, w.home);
    expect(env.PATH).toBe(`${w.real}:/usr/bin:/bin`);
    expect(existsSync(shimOf(w))).toBe(false);
  });

  test('the one-run override off leaves the environment as it was', () => {
    const w = world();
    const env = seatServerEnv({ HOME: w.home, PATH: `${w.real}:/usr/bin:/bin`, [FORGE_SHIM_ENV]: 'off' }, w.home);
    expect(env.PATH).toBe(`${w.real}:/usr/bin:/bin`);
  });

  test('a shim that cannot be installed leaves no reachable forge CLI', () => {
    const w = world();
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    writeFileSync(sessionBinDir(w.home), 'not a directory');
    const env = serverEnv(w);
    expect(env.PATH?.split(':')).not.toContain(w.real);
    const out = credentialFill(w, env);
    expect(out.status).not.toBe(0);
    expect(out.stdout).not.toContain('password=');
    expect(existsSync(w.log)).toBe(false);
  });

  test('a linked bin folder leaves no reachable forge CLI', () => {
    const w = world();
    const foreign = join(w.root, 'foreign');
    mkdirSync(foreign);
    mkdirSync(join(w.home, '.config', 'team'), { recursive: true });
    symlinkSync(foreign, sessionBinDir(w.home));
    const env = serverEnv(w);
    expect(readdirSync(foreign)).toEqual([]);
    expect(env.PATH?.split(':')).not.toContain(w.real);
    const out = credentialFill(w, env);
    expect(out.status).not.toBe(0);
    expect(existsSync(w.log)).toBe(false);
  });
});

describe('the shim switch', () => {
  test('on by default', () => {
    const w = world();
    expect(DEFAULT_FORGE_SHIM).toBe('on');
    expect(resolveForgeShim({ home: w.home, env: {} })).toEqual({ on: true, from: 'default' });
  });

  test('the machine file turns it off, and back on', () => {
    const w = world();
    settings(w.home, `${FORGE_SHIM_SETTING}: off\n`);
    expect(resolveForgeShim({ home: w.home, env: {} })).toEqual({ on: false, from: 'machine' });
    settings(w.home, `${FORGE_SHIM_SETTING}: on\n`);
    expect(resolveForgeShim({ home: w.home, env: {} })).toEqual({ on: true, from: 'machine' });
  });

  test('the one-run override outranks the file', () => {
    const w = world();
    settings(w.home, `${FORGE_SHIM_SETTING}: off\n`);
    expect(resolveForgeShim({ home: w.home, env: { [FORGE_SHIM_ENV]: 'on' } })).toEqual({ on: true, from: 'environment' });
    settings(w.home, `${FORGE_SHIM_SETTING}: on\n`);
    expect(resolveForgeShim({ home: w.home, env: { [FORGE_SHIM_ENV]: 'off' } })).toEqual({ on: false, from: 'environment' });
  });

  test('a word that is not on or off leaves it on, and is named', () => {
    const w = world();
    settings(w.home, `${FORGE_SHIM_SETTING}: banana\n`);
    const fromFile = resolveForgeShim({ home: w.home, env: {} });
    expect(fromFile.on).toBe(true);
    expect(fromFile.problem).toContain('banana');
    const fromEnv = resolveForgeShim({ home: w.home, env: { [FORGE_SHIM_ENV]: 'maybe' } });
    expect(fromEnv.on).toBe(true);
    expect(fromEnv.problem).toContain('maybe');
  });

  test('only the word off turns it off: false in any spelling leaves it on and is named', () => {
    const w = world();
    for (const written of ['false', '"false"', 'no', '0', 'disabled', 'true']) {
      settings(w.home, `${FORGE_SHIM_SETTING}: ${written}\n`);
      const fromFile = resolveForgeShim({ home: w.home, env: {} });
      expect(fromFile.on).toBe(true);
      expect(fromFile.problem).toBeDefined();
      const fromEnv = resolveForgeShim({ home: w.home, env: { [FORGE_SHIM_ENV]: written.replaceAll('"', '') } });
      expect(fromEnv.on).toBe(true);
      expect(fromEnv.problem).toBeDefined();
    }
  });
});

describe('the credential helper chain, end to end', () => {
  test('without the shim the helper reaches the stored account login: the fallback being closed', () => {
    const w = world();
    const out = credentialFill(w, serverEnv(w, { [FORGE_SHIM_ENV]: 'off' }));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('password=stored-account-token');
  });

  test('with the shim and no seat token, git gets no credential at all', () => {
    const w = world();
    const out = credentialFill(w, serverEnv(w));
    expect(out.status).not.toBe(0);
    expect(out.stdout).not.toContain('password=');
    expect(existsSync(w.log)).toBe(false);
  });

  test('with the shim and a seat token, git gets the seat token', () => {
    const w = world();
    const out = credentialFill(w, { ...serverEnv(w), GH_TOKEN: 'seat-token' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('username=x-access-token');
    expect(out.stdout).toContain('password=seat-token');
    expect(out.stdout).not.toContain('stored-account-token');
    expect(readFileSync(w.log, 'utf8')).not.toContain('seat-token');
  });

  test('a call by absolute path meets the real CLI: the shim only names its own folder', () => {
    const w = world();
    const out = spawnSync(w.cli, ['auth', 'git-credential', 'get'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('password=stored-account-token');
  });
});
