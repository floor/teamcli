// Coverage: what the installer reports when the installed prefix's bin path cannot be
// replaced, and when a dispatched backend throws instead of returning.
//
// The contract this pins, authored independently from exact main ddf96e80:
//
//  1. A prefix whose bin/team is a directory cannot take the symlink. The public
//     installer CLI refuses before dispatch: phase `pre-dispatch`, no backend call, no
//     mutation, no failure record, and the prefix tree is unchanged.
//  2. A backend that was dispatched, changed the prefix and then threw is reported as a
//     measured post-dispatch failure, never as an uncaught exception: `dispatched` and
//     `mutateCalls` carry the attempt, `mutated`/`installedState`/`postState` carry the
//     measurement, a requested record is written, and no message claims a rollback.
//  3. A dispatched backend that throws without changing the prefix reports the same
//     post-dispatch shape with installedState `unknown` and mutated `null` (the effect
//     is not established), not a false unchanged claim.
//
// Controls: a dispatched backend that writes the candidate and returns succeeds, and a
// normal seeded prefix with a bin/team symlink still installs through the public CLI.
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  installTarball,
  runInstallCli,
  type InstallTarballResult,
} from '../../scripts/install.ts';

const OLD = '0.5.3-hotfix.25';
const OLD_SHA = '1111111111111111111111111111111111111111';
const CANDIDATE = '0.5.4-rc.3';
const CANDIDATE_SHA = 'ddf96e80bb1466b0e8ba9022f6ddbd4afccca2fa';

const roots: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every regular file under dir, by relative path, with its sha256. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[relative(dir, full)] = digest(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** The prefix as this coverage can observe it: files plus the kind of bin/team. */
function prefixState(prefix: string): { files: Record<string, string>; bin: string; binTarget: string | null } {
  const binPath = join(prefix, 'bin', 'team');
  let bin = 'absent';
  let binTarget: string | null = null;
  if (existsSync(binPath)) {
    const stats = lstatSync(binPath);
    if (stats.isSymbolicLink()) {
      bin = 'symlink';
      binTarget = readlinkSync(binPath);
    } else if (stats.isDirectory()) {
      bin = 'directory';
    } else if (stats.isFile()) {
      bin = 'file';
    }
  }
  return { files: filesOf(prefix), bin, binTarget };
}

/** A synthetic package tarball plus the stamp sidecar the installer expects. */
function makeTarball(dir: string, version: string, gitHead: string): string {
  const staging = temp('rc4-t2-stage-');
  const pkg = join(staging, 'package');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: 'team', version, gitHead, bin: { team: 'dist/cli.js' } }, null, 2)}\n`,
  );
  writeFileSync(join(pkg, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("rc4-t2");\n');
  const tarball = join(dir, `team-${version}.tgz`);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  expect(tar.status).toBe(0);
  const bytes = statSync(tarball).size;
  writeFileSync(
    `${tarball}.stamp.json`,
    `${JSON.stringify(
      {
        tarball: `team-${version}.tgz`,
        version,
        gitHead,
        sha256: digest(readFileSync(tarball)),
        bytes,
        builtAt: '2026-10-22T00:00:00.000Z',
        branch: 'main',
      },
      null,
      2,
    )}\n`,
  );
  return tarball;
}

/** Seeds an older working installation through the normal tar backend. */
function seed(prefix: string, version: string, gitHead: string): void {
  const seeded = installTarball({ tarball: makeTarball(temp('rc4-t2-seed-'), version, gitHead), prefix });
  expect(seeded.ok).toBe(true);
}

interface Capture<T> {
  threw: unknown;
  value: T | null;
}

/** Runs a thunk and captures a throw instead of letting it fail the scene as an error. */
function capture<T>(run: () => T): Capture<T> {
  try {
    return { threw: null, value: run() };
  } catch (error) {
    return { threw: error, value: null };
  }
}

type Failure = Extract<InstallTarballResult, { ok: false }>;

describe('installer reporting when the prefix bin path cannot be replaced or a backend throws', () => {
  test('a prefix whose bin/team is a directory is refused before dispatch and not mutated', () => {
    const prefix = temp('rc4-t2-prefix-');
    seed(prefix, OLD, OLD_SHA);
    const binPath = join(prefix, 'bin', 'team');
    unlinkSync(binPath);
    mkdirSync(binPath);
    const candidate = makeTarball(temp('rc4-t2-candidate-'), CANDIDATE, CANDIDATE_SHA);
    const recordPath = join(temp('rc4-t2-records-'), 'failure.json');
    const before = prefixState(prefix);

    const call = capture(() =>
      runInstallCli([candidate, '--prefix', prefix, '--json', '--record', recordPath]),
    );

    // The refusal is a reported failure, never an uncaught exception (the EEXIST throw).
    expect(call.threw).toBeNull();
    const out = call.value as { code: number; stdout: string; stderr: string };
    expect(out.code).not.toBe(0);
    const doc = JSON.parse(out.stdout) as Failure;
    expect(doc.ok).toBe(false);
    expect(doc.code as number).toBe(out.code);
    expect(doc.code).toBe(2);
    expect(doc.decision as string).toBe('refuse-installed-bin-not-file');
    expect(doc.installed).toBe(OLD);
    expect(doc.phase).toBe('pre-dispatch');
    expect(doc.dispatched).toBe(false);
    expect(doc.mutateCalls).toBe(0);
    expect(doc.mutated).toBe(false);
    expect(doc.installedState).toBe('unchanged');
    expect(doc.postState).toBeNull();
    expect(doc.recordPath).toBeNull();
    expect(doc.recordError).toBeNull();
    expect(String(doc.message)).toContain(
      `install: refusing to install over ${join(resolve(prefix), 'bin', 'team')}: it is a directory, not a file or symlink`,
    );
    expect(existsSync(recordPath)).toBe(false);
    expect(out.stderr).not.toContain('EEXIST');
    // Nothing in the prefix moved: same files, and bin/team is still the directory.
    expect(prefixState(prefix)).toEqual(before);
  });

  test('a backend that changes the prefix and then throws reports the measured post-dispatch failure', () => {
    const prefix = temp('rc4-t2-prefix-');
    seed(prefix, OLD, OLD_SHA);
    const candidate = makeTarball(temp('rc4-t2-candidate-'), CANDIDATE, CANDIDATE_SHA);
    const recordPath = join(temp('rc4-t2-records-'), 'failure.json');

    const call = capture(() =>
      installTarball({
        tarball: candidate,
        prefix,
        recordPath,
        installer: ({ packageDir, unpackedPackageDir }) => {
          writeFileSync(join(packageDir, 'package.json'), readFileSync(join(unpackedPackageDir, 'package.json')));
          throw new Error('synthetic backend failure after the prefix changed');
        },
      }),
    );

    // A thrown backend is a measured failure result, not an uncaught exception.
    expect(call.threw).toBeNull();
    const result = call.value as Failure;
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.decision).toBe('refuse-installer-failed');
    expect(result.phase).toBe('post-dispatch');
    expect(result.dispatched).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBe(true);
    expect(result.installedState).toBe('changed');
    expect(result.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: CANDIDATE,
      gitHead: CANDIDATE_SHA,
      matchesCandidate: true,
    });
    expect(result.installed).toBe(OLD);
    expect(result.candidate).toBe(CANDIDATE);
    expect(result.previousGitHead).toBe(OLD_SHA);
    expect(result.prefix).toBe(resolve(prefix));
    expect(result.packageDir).toBe(join(resolve(prefix), 'lib', 'node_modules', 'team'));
    expect(result.binPath).toBe(join(resolve(prefix), 'bin', 'team'));
    expect(result.recordPath).toBe(resolve(recordPath));
    expect(result.recordError).toBeNull();
    expect(existsSync(recordPath)).toBe(true);
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(result);
    expect(String(result.message)).toContain(
      'install: installer failed: synthetic backend failure after the prefix changed',
    );
    expect(String(result.message)).toContain(`installed state changed; inspect ${resolve(prefix)}`);
    // The outcome is measured, not claimed: no rollback happened and none is reported.
    expect(result.rollback).toBeNull();
    expect(String(result.message)).not.toMatch(/rolled[ -]?back/i);
  });

  test('a backend that throws without changing the prefix reports an unestablished effect', () => {
    const prefix = temp('rc4-t2-prefix-');
    seed(prefix, OLD, OLD_SHA);
    const candidate = makeTarball(temp('rc4-t2-candidate-'), CANDIDATE, CANDIDATE_SHA);
    const before = prefixState(prefix);

    const call = capture(() =>
      installTarball({
        tarball: candidate,
        prefix,
        installer: () => {
          throw new Error('synthetic backend failure before the prefix changed');
        },
      }),
    );

    expect(call.threw).toBeNull();
    const result = call.value as Failure;
    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.decision).toBe('refuse-installer-failed');
    expect(result.phase).toBe('post-dispatch');
    expect(result.dispatched).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBeNull();
    expect(result.installedState).toBe('unknown');
    expect(result.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: OLD,
      gitHead: OLD_SHA,
      matchesCandidate: false,
    });
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(String(result.message)).toContain(
      'install: installer failed: synthetic backend failure before the prefix changed',
    );
    expect(prefixState(prefix)).toEqual(before);
  });

  test('control: a backend that writes the candidate and returns is a successful install', () => {
    const prefix = temp('rc4-t2-prefix-');
    seed(prefix, OLD, OLD_SHA);
    const candidate = makeTarball(temp('rc4-t2-candidate-'), CANDIDATE, CANDIDATE_SHA);

    const call = capture(() =>
      installTarball({
        tarball: candidate,
        prefix,
        installer: ({ packageDir, unpackedPackageDir }) => {
          writeFileSync(join(packageDir, 'package.json'), readFileSync(join(unpackedPackageDir, 'package.json')));
        },
      }),
    );

    expect(call.threw).toBeNull();
    const result = call.value as Extract<InstallTarballResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.status).toBe('installed');
    expect(result.mutated).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.version).toBe(CANDIDATE);
    expect(result.gitHead).toBe(CANDIDATE_SHA);
  });

  test('control: a seeded prefix with a bin/team symlink still installs through the public CLI', () => {
    const prefix = temp('rc4-t2-prefix-');
    seed(prefix, OLD, OLD_SHA);
    expect(prefixState(prefix).bin).toBe('symlink');
    const candidate = makeTarball(temp('rc4-t2-candidate-'), CANDIDATE, CANDIDATE_SHA);

    const out = runInstallCli([candidate, '--prefix', prefix, '--json']);

    expect(out.code).toBe(0);
    const doc = JSON.parse(out.stdout) as Extract<InstallTarballResult, { ok: true }>;
    expect(doc.ok).toBe(true);
    expect(doc.status).toBe('installed');
    expect(doc.version).toBe(CANDIDATE);
    expect(doc.gitHead).toBe(CANDIDATE_SHA);
    expect(prefixState(prefix).bin).toBe('symlink');
  });
});
