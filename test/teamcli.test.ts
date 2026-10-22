import { expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCaller } from '../src/caller.ts';

const repo = join(import.meta.dir, '..');

function readJson(path: string): {
  name?: string;
  version: string;
  dependencies?: { team?: string };
  publishConfig?: { access?: string };
  bin?: { teamcli?: string; team?: string };
} {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Every npm call runs offline, in a temporary home, prefix and cache of this test's
// own: no machine npm state is read or written and no network is touched.
function npmRun(home: string, args: string[], cwd: string, timeout?: number) {
  return spawnSync('npm', [...args, '--offline', '--cache', join(home, 'cache')], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      HOME: home,
      npm_config_userconfig: join(home, 'npmrc'),
      npm_config_prefix: join(home, 'prefix'),
    },
  });
}

function teamDependencyVersion(): string {
  const version = readJson(join(repo, 'packages/teamcli/package.json')).dependencies?.team;
  if (!version) throw new Error('packages/teamcli/package.json has no team dependency');
  return version;
}

test('teamcli is the same version as team, and depends on that exact version', () => {
  const root = readJson(join(repo, 'package.json'));
  const teamcli = readJson(join(repo, 'packages/teamcli/package.json'));
  expect(teamcli.name).toBe('@teamcli/cli');
  expect(teamcli.publishConfig?.access).toBe('public');
  expect(teamcli.bin).toEqual({ teamcli: 'cli.js', team: 'cli.js' });
  expect(teamcli.version).toBe(root.version);
  expect(teamcli.version).toBe('0.5.4-rc.5');
  expect(teamcli.dependencies?.team).toBe(root.version);
  expect(teamcli.dependencies?.team).toBe('0.5.4-rc.5');
});

test('the teamcli tarball lists exactly the package manifest, the shim and the readme', () => {
  const teamcli = readJson(join(repo, 'packages/teamcli/package.json'));
  const home = mkdtempSync(join(tmpdir(), 'teamcli-home-'));
  const dest = mkdtempSync(join(tmpdir(), 'teamcli-pack-'));
  const packed = npmRun(home, ['pack', '--json', '--pack-destination', dest], join(repo, 'packages/teamcli'));
  expect(packed.status).toBe(0);
  const report = JSON.parse(packed.stdout)[0];
  expect(report.name).toBe('@teamcli/cli');
  expect(report.version).toBe(teamcli.version);
  expect(report.filename).toBe(`teamcli-cli-${teamcli.version}.tgz`);
  const tarball = join(dest, report.filename);
  const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  expect(listed.status).toBe(0);
  expect(listed.stdout.trim().split('\n').sort()).toEqual([
    'package/README.md',
    'package/cli.js',
    'package/package.json',
  ]);
}, 30_000);

// The published manifest exports only ".". This test builds a package with that map
// rather than packing the tagged tree, then installs this branch's own tarball too.
function publishedTeam(dest: string, home: string): string {
  const dir = join(dest, 'published-team');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'team',
    version: teamDependencyVersion(),
    type: 'module',
    bin: { team: 'dist/cli.js' },
    exports: { '.': { default: './dist/index.js' } },
    files: ['dist'],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'dist/index.js'), 'export {};\n');
  writeFileSync(join(dir, 'dist/cli.js'), '#!/usr/bin/env node\nconsole.log("published-line");\n');
  const packed = npmRun(home, ['pack', '--json', '--pack-destination', dest], dir);
  expect(packed.status).toBe(0);
  return join(dest, JSON.parse(packed.stdout)[0].filename);
}

function installPair(prefix: string, teamTarball: string, teamcliTarball: string, home: string): void {
  const installed = npmRun(
    home,
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', teamTarball, teamcliTarball],
    prefix,
    40_000,
  );
  if (installed.status !== 0) {
    throw new Error(`npm install exited ${installed.status} ${installed.signal ?? ''}: ${installed.stderr || installed.stdout}`);
  }
}

test('packed team and teamcli bins match the team cli, and a signal reaches the child', async () => {
  const built = spawnSync('bun', ['run', 'build'], { cwd: repo, encoding: 'utf8', timeout: 40_000 });
  expect(built.status).toBe(0);

  const teamcliManifest = readJson(join(repo, 'packages/teamcli/package.json'));
  const home = mkdtempSync(join(tmpdir(), 'teamcli-home-'));
  const dest = mkdtempSync(join(tmpdir(), 'teamcli-bins-'));
  const rootPack = npmRun(home, ['pack', '--json', '--pack-destination', dest], repo);
  expect(rootPack.status).toBe(0);
  const rootReport = JSON.parse(rootPack.stdout)[0];
  const rootPaths: string[] = rootReport.files.map((file: { path: string }) => file.path);
  expect(
    rootPaths.some(
      (path) => (path === 'packages' || path.startsWith('packages/')) && !path.startsWith('packages/relay/'),
    ),
  ).toBe(false);
  const teamcliPack = npmRun(home, ['pack', '--json', '--pack-destination', dest], join(repo, 'packages/teamcli'));
  expect(teamcliPack.status).toBe(0);
  const teamcliReport = JSON.parse(teamcliPack.stdout)[0];

  expect(teamcliReport.filename).toBe(`teamcli-cli-${teamcliManifest.version}.tgz`);
  const teamcliTarball = join(dest, teamcliReport.filename);
  const published = mkdtempSync(join(tmpdir(), 'teamcli-published-'));
  installPair(published, publishedTeam(mkdtempSync(join(tmpdir(), 'teamcli-published-pack-')), home), teamcliTarball, home);
  const publishedRun = spawnSync(join(published, 'node_modules/.bin/teamcli'), [], { encoding: 'utf8' });
  expect(publishedRun.status).toBe(0);
  expect(publishedRun.stdout).toBe('published-line\n');

  const prefix = mkdtempSync(join(tmpdir(), 'teamcli-prefix-'));
  installPair(prefix, join(dest, rootReport.filename), teamcliTarball, home);
  const installed = readJson(join(prefix, 'node_modules/@teamcli/cli/package.json'));
  expect(installed.name).toBe('@teamcli/cli');
  // A scoped package still installs the unscoped teamcli command from its bin map.
  expect(readlinkSync(join(prefix, 'node_modules/.bin/teamcli'))).toContain('@teamcli/cli');

  const own = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), '--version'], { encoding: 'utf8' });
  const team = spawnSync(join(prefix, 'node_modules/.bin/team'), ['--version'], { encoding: 'utf8' });
  const teamcli = spawnSync(join(prefix, 'node_modules/.bin/teamcli'), ['--version'], { encoding: 'utf8' });
  expect(own.status).toBe(0);
  expect(team.stdout).toBe(own.stdout);
  expect(teamcli.stdout).toBe(own.stdout);

  const unknownOwn = spawnSync(process.execPath, [join(repo, 'dist/cli.js'), 'nosuch'], { encoding: 'utf8' });
  const unknownCli = spawnSync(join(prefix, 'node_modules/.bin/teamcli'), ['nosuch'], { encoding: 'utf8' });
  expect(unknownCli.status).toBe(unknownOwn.status);
  expect(unknownCli.stderr).toBe(unknownOwn.stderr);

  const child = spawn(join(prefix, 'node_modules/.bin/teamcli'), ['conformance-adapter'], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGTERM');
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    }),
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      setTimeout(() => resolve({ code: null, signal: null }), 3000);
    }),
  ]);
  expect(exit.signal).toBe('SIGTERM');
}, 90_000);

test('a node parent is still the owner', () => {
  const judge = (names: string[], stdinIsTTY: boolean) => walkCaller({
    env: {},
    stdinIsTTY,
    callerSources: () => ({
      ancestors: () => names.map((name, index) => ({ pid: index + 2, name })),
      agents: () => [],
      paneRootPid: () => null,
      env: {},
      stdinIsTTY,
    }),
  });
  expect(judge(['zsh'], true)).toEqual({ kind: 'owner' });
  expect(judge(['node', 'zsh'], true)).toEqual({ kind: 'owner' });
  expect(judge(['claude', 'zsh'], true)).toEqual({
    kind: 'unplaced',
    reason: 'it is run by an agent (claude) outside herdr',
  });
  // An owner with no terminal is this branch's owner-no-tty, not unplaced.
  expect(judge(['node', 'zsh'], false)).toEqual({ kind: 'owner-no-tty' });
});

// A team dependency whose cli records every signal it receives, so a test can count
// what the shim passed on.
const FAKE_CLI = [
  '#!/usr/bin/env node',
  "process.stdout.write('ready\\n');",
  "for (const name of ['SIGINT', 'SIGQUIT', 'SIGHUP']) {",
  "  process.on(name, () => process.stdout.write('signal:' + name + '\\n'));",
  '}',
  "process.on('SIGTERM', () => {",
  "  process.stdout.write('signal:SIGTERM\\n');",
  '  process.exit(0);',
  '});',
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

function instrumentedTeam(dest: string, home: string): string {
  const dir = join(dest, 'instrumented-team');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'team',
    version: teamDependencyVersion(),
    type: 'module',
    bin: { team: 'dist/cli.js' },
    exports: { '.': { default: './dist/index.js' } },
    files: ['dist'],
  }, null, 2)}\n`);
  writeFileSync(join(dir, 'dist/index.js'), 'export {};\n');
  writeFileSync(join(dir, 'dist/cli.js'), FAKE_CLI);
  const packed = npmRun(home, ['pack', '--json', '--pack-destination', dest], dir);
  expect(packed.status).toBe(0);
  return join(dest, JSON.parse(packed.stdout)[0].filename);
}

function installedShim(): string {
  const home = mkdtempSync(join(tmpdir(), 'teamcli-signals-'));
  const dest = mkdtempSync(join(tmpdir(), 'teamcli-signals-pack-'));
  const prefix = join(home, 'install');
  mkdirSync(prefix);
  installPair(prefix, instrumentedTeam(dest, home), packTeamcli(dest, home), home);
  return join(prefix, 'node_modules/.bin/teamcli');
}

function packTeamcli(dest: string, home: string): string {
  const packed = npmRun(home, ['pack', '--json', '--pack-destination', dest], join(repo, 'packages/teamcli'));
  expect(packed.status).toBe(0);
  return join(dest, JSON.parse(packed.stdout)[0].filename);
}

function startShim(bin: string) {
  const child = spawn(bin, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    text += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, text: () => text, exited };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function stopGroup(child: ChildProcess): void {
  try {
    process.kill(-child.pid!, 'SIGKILL');
  } catch {
    // The group is already gone.
  }
}

// A terminal sends Ctrl-C to the whole foreground process group, so this is how the
// cli really receives it: SIGINT to the group. Exactly one may reach it.
test('one Ctrl-C, to the group as a terminal sends it, reaches the cli once', async () => {
  const { child, text, exited } = startShim(installedShim());
  try {
    await until(() => text().includes('ready\n'), 'the cli to start');
    process.kill(-child.pid!, 'SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 700));
    process.kill(child.pid!, 'SIGTERM');
    const exit = await exited;
    expect(exit.code).toBe(0);
    expect(text().match(/signal:SIGINT/g)).toHaveLength(1);
    expect(text().match(/signal:SIGTERM/g)).toHaveLength(1);
  } finally {
    stopGroup(child);
  }
}, 30_000);

// A signal sent to the shim's own pid alone is not a terminal's Ctrl-C. SIGINT and
// SIGQUIT reach nothing at all; SIGTERM is forwarded to the cli once.
test("a signal to the shim's pid alone: SIGINT and SIGQUIT reach nothing, SIGTERM once", async () => {
  const { child, text, exited } = startShim(installedShim());
  try {
    await until(() => text().includes('ready\n'), 'the cli to start');
    process.kill(child.pid!, 'SIGINT');
    process.kill(child.pid!, 'SIGQUIT');
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(text()).not.toContain('signal:');
    expect(child.exitCode).toBeNull();
    process.kill(child.pid!, 'SIGTERM');
    const exit = await exited;
    expect(exit.code).toBe(0);
    expect(text().match(/signal:SIGTERM/g)).toHaveLength(1);
  } finally {
    stopGroup(child);
  }
}, 30_000);
