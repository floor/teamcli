import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { installTarball, runInstallCli } from '../../scripts/install.ts';

const SHA_OLD = '1111111111111111111111111111111111111111';
const SHA_NEW = '2222222222222222222222222222222222222222';
const SHA_SEED_HIGH = '3333333333333333333333333333333333333333';

const OLD = '0.5.3-hotfix.25';
const CANDIDATE = '0.5.4-rc.2';

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

function treeOf(dir: string): Record<string, string> {
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

/** A synthetic package tarball plus the stamp sidecar the CLI expects. */
function makeTarball(dir: string, version: string, gitHead: string): string {
  const staging = temp('rc3-t2-stage-');
  const pkg = join(staging, 'package');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    `${JSON.stringify({ name: 'team', version, gitHead, bin: { team: 'dist/cli.js' } }, null, 2)}\n`,
  );
  writeFileSync(join(pkg, 'dist', 'cli.js'), '#!/usr/bin/env node\nconsole.log("rc3-t2");\n');
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

/** Installs a small package into the prefix through the normal tar backend. */
function seed(prefix: string, version: string, gitHead: string): void {
  const seeded = installTarball({ tarball: makeTarball(temp('rc3-t2-seed-'), version, gitHead), prefix });
  expect(seeded.ok).toBe(true);
}

interface FailureView {
  ok: boolean;
  code: number;
  decision: string;
  message: string;
  phase?: unknown;
  dispatched?: unknown;
  mutateCalls?: unknown;
  mutated?: unknown;
  installedState?: unknown;
  postState?: unknown;
  prefix?: unknown;
  packageDir?: unknown;
  binPath?: unknown;
  installed?: unknown;
  candidate?: unknown;
  previousGitHead?: unknown;
  preservedRollbackArtifacts?: unknown;
  recordPath?: unknown;
  recordError?: unknown;
}

function view(result: unknown): FailureView {
  return result as FailureView;
}

/**
 * Writes a fake `npm` shell stub. With a manifest it writes that manifest into the prefix's
 * installed package (a partial backend change) and then exits with the given code; without one
 * it leaves the prefix untouched. The stub records the call in a marker file.
 */
function fakeNpm(
  binDir: string,
  options: { exitCode: number; manifest?: { version: string; gitHead: string } },
): { marker: string } {
  mkdirSync(binDir, { recursive: true });
  const marker = join(binDir, 'npm-invoked.txt');
  const lines = [
    '#!/bin/sh',
    'set -eu',
    'prefix=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--prefix" ]; then prefix="$arg"; fi',
    '  prev="$arg"',
    'done',
  ];
  if (options.manifest !== undefined) {
    const manifest = JSON.stringify({
      name: 'team',
      version: options.manifest.version,
      gitHead: options.manifest.gitHead,
      bin: { team: 'dist/cli.js' },
    });
    lines.push('mkdir -p "$prefix/lib/node_modules/team"');
    lines.push(`printf '%s\\n' '${manifest}' > "$prefix/lib/node_modules/team/package.json"`);
  }
  lines.push(`printf '%s\\n' "$@" > '${marker}'`);
  lines.push(`exit ${String(options.exitCode)}`);
  writeFileSync(join(binDir, 'npm'), `${lines.join('\n')}\n`, { mode: 0o755 });
  return { marker };
}

function withFakeNpm<T>(binDir: string, run: () => T): T {
  const prior = process.env.PATH;
  process.env.PATH = `${binDir}:${prior ?? ''}`;
  try {
    return run();
  } finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
}

function expectPreDispatchRefusal(result: FailureView): void {
  expect(result.ok).toBe(false);
  expect(result.phase).toBe('pre-dispatch');
  expect(result.dispatched).toBe(false);
  expect(result.mutateCalls).toBe(0);
  expect(result.mutated).toBe(false);
  expect(result.installedState).toBe('unchanged');
  expect(result.postState).toBeNull();
  expect(result.recordPath).toBeNull();
  expect(result.recordError).toBeNull();
}

describe('installer post-dispatch failure reporting (RC3 independent regression)', () => {
  test('a pre-dispatch version refusal reports no attempt and leaves the prefix untouched', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, '0.5.5', SHA_SEED_HIGH);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const recordPath = join(temp('rc3-t2-records-'), 'failure.json');
    const before = treeOf(prefix);

    const result = view(installTarball({ tarball: candidate, prefix, recordPath }));

    expect(result.decision).toBe('refuse-older-version');
    expect(result.code).toBe(1);
    expectPreDispatchRefusal(result);
    expect(treeOf(prefix)).toEqual(before);
    expect(existsSync(recordPath)).toBe(false);
  });

  test('a pre-dispatch missing-tarball refusal reports no attempt', () => {
    const prefix = temp('rc3-t2-prefix-');
    const recordPath = join(temp('rc3-t2-records-'), 'failure.json');
    const absent = join(temp('rc3-t2-absent-'), 'team-absent.tgz');

    const result = view(installTarball({ tarball: absent, prefix, recordPath }));

    expect(result.decision).toBe('refuse-missing-tarball');
    expect(result.code).toBe(2);
    expectPreDispatchRefusal(result);
    expect(existsSync(recordPath)).toBe(false);
  });

  test('the JSON CLI keeps a pre-dispatch refusal at false/zero and writes no record', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, '0.5.5', SHA_SEED_HIGH);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const recordPath = join(temp('rc3-t2-records-'), 'failure.json');

    const out = runInstallCli([candidate, '--prefix', prefix, '--json', '--record', recordPath]);
    expect(out.code).toBe(1);
    const doc = JSON.parse(out.stdout) as FailureView;
    expect(doc.decision).toBe('refuse-older-version');
    expectPreDispatchRefusal(doc);
    expect(existsSync(recordPath)).toBe(false);
  });

  test('an npm backend that fails after changing the prefix reports the attempt and a changed state', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const binDir = temp('rc3-t2-bin-');
    const { marker } = fakeNpm(binDir, {
      exitCode: 7,
      manifest: { version: CANDIDATE, gitHead: SHA_NEW },
    });
    const before = treeOf(prefix);

    const result = view(
      withFakeNpm(binDir, () => installTarball({ tarball: candidate, prefix, installer: 'npm' })),
    );

    expect(existsSync(marker)).toBe(true);
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
      gitHead: SHA_NEW,
      matchesCandidate: true,
    });
    expect(result.installed).toBe(OLD);
    expect(result.candidate).toBe(CANDIDATE);
    expect(result.previousGitHead).toBe(SHA_OLD);
    expect(result.prefix).toBe(resolve(prefix));
    expect(result.packageDir).toBe(join(resolve(prefix), 'lib', 'node_modules', 'team'));
    expect(result.binPath).toBe(join(resolve(prefix), 'bin', 'team'));
    expect(String(result.message)).toContain('npm install failed');
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(treeOf(prefix)).not.toEqual(before);
  });

  test('a failing failure-record write keeps the attempt and names the record error', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const binDir = temp('rc3-t2-bin-');
    fakeNpm(binDir, { exitCode: 7, manifest: { version: CANDIDATE, gitHead: SHA_NEW } });
    const recordPath = temp('rc3-t2-records-');

    const result = view(
      withFakeNpm(binDir, () =>
        installTarball({ tarball: candidate, prefix, installer: 'npm', recordPath }),
      ),
    );

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
      gitHead: SHA_NEW,
      matchesCandidate: true,
    });
    expect(result.recordPath).toBe(resolve(recordPath));
    expect(typeof result.recordError).toBe('string');
    expect(String(result.recordError).length).toBeGreaterThan(0);
    expect(String(result.message)).toContain('failure record not written:');
    expect(statSync(recordPath).isDirectory()).toBe(true);
  });

  test('a backend that leaves the old manifest reports an unknown mutation, not a no-attempt claim', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const before = treeOf(prefix);

    const result = view(installTarball({ tarball: candidate, prefix, installer: () => {} }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.decision).toBe('refuse-post-install-mismatch');
    expect(result.phase).toBe('post-dispatch');
    expect(result.dispatched).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBeNull();
    expect(result.installedState).toBe('unknown');
    expect(result.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: OLD,
      gitHead: SHA_OLD,
      matchesCandidate: false,
    });
    expect(result.installed).toBe(OLD);
    expect(result.candidate).toBe(CANDIDATE);
    expect(result.previousGitHead).toBe(SHA_OLD);
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(treeOf(prefix)).toEqual(before);
  });

  test('a post-dispatch inspection failure reports unknown with no measured post-state', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);

    const result = view(
      installTarball({
        tarball: candidate,
        prefix,
        installer: ({ packageDir }) => {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, 'package.json'), '{ not json\n');
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(2);
    expect(result.decision).toBe('refuse-post-install-mismatch');
    expect(result.phase).toBe('post-dispatch');
    expect(result.dispatched).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBeNull();
    expect(result.installedState).toBe('unknown');
    expect(result.postState).toBeNull();
    expect(result.installed).toBe(OLD);
    expect(result.candidate).toBe(CANDIDATE);
    expect(result.prefix).toBe(resolve(prefix));
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(String(result.message)).toContain('post-install verification failed');
  });

  test('a modified rollback artifact after dispatch reports the completed attempt and the snapshot', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const rollbackDir = join(temp('rc3-t2-artifacts-'), 'rollback');
    mkdirSync(rollbackDir, { recursive: true });
    const artifact = join(rollbackDir, 'team-0.5.3-hotfix.24.tgz');
    const artifactBytes = 'seeded rollback artifact bytes';
    writeFileSync(artifact, artifactBytes);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);

    const result = view(
      installTarball({
        tarball: candidate,
        prefix,
        rollbackDir,
        installer: ({ packageDir }) => {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(
            join(packageDir, 'package.json'),
            `${JSON.stringify({ name: 'team', version: CANDIDATE, gitHead: SHA_NEW, bin: { team: 'dist/cli.js' } })}\n`,
          );
          writeFileSync(artifact, 'tampered after dispatch');
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.decision).toBe('refuse-rollback-preserve-collision');
    expect(result.phase).toBe('post-dispatch');
    expect(result.dispatched).toBe(true);
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBe(true);
    expect(result.installedState).toBe('changed');
    expect(result.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: CANDIDATE,
      gitHead: SHA_NEW,
      matchesCandidate: true,
    });
    expect(result.preservedRollbackArtifacts).toEqual([
      { path: resolve(artifact), sha256: digest(artifactBytes), bytes: artifactBytes.length },
    ]);
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(String(result.message)).toContain('was modified');
    expect(String(result.message)).toContain(resolve(artifact));
  });

  test('a removed rollback artifact after dispatch names the removal and keeps the attempt', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const rollbackDir = join(temp('rc3-t2-artifacts-'), 'rollback');
    mkdirSync(rollbackDir, { recursive: true });
    const artifact = join(rollbackDir, 'team-0.5.3-hotfix.24.tgz');
    writeFileSync(artifact, 'seeded rollback artifact bytes');
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);

    const result = view(
      installTarball({
        tarball: candidate,
        prefix,
        rollbackDir,
        installer: ({ packageDir }) => {
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(
            join(packageDir, 'package.json'),
            `${JSON.stringify({ name: 'team', version: CANDIDATE, gitHead: SHA_NEW, bin: { team: 'dist/cli.js' } })}\n`,
          );
          unlinkSync(artifact);
        },
      }),
    );

    expect(result.decision).toBe('refuse-rollback-preserve-collision');
    expect(result.code).toBe(1);
    expect(result.phase).toBe('post-dispatch');
    expect(result.mutateCalls).toBe(1);
    expect(result.mutated).toBe(true);
    expect(result.installedState).toBe('changed');
    expect(result.recordPath).toBeNull();
    expect(result.recordError).toBeNull();
    expect(String(result.message)).toContain('was removed');
    expect(String(result.message)).toContain(resolve(artifact));
  });

  test('the JSON CLI failure carries the post-dispatch fields and writes the same record', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const binDir = temp('rc3-t2-bin-');
    fakeNpm(binDir, { exitCode: 7, manifest: { version: CANDIDATE, gitHead: SHA_NEW } });
    const recordPath = join(temp('rc3-t2-records-'), 'install-failure.json');

    const out = withFakeNpm(binDir, () =>
      runInstallCli([candidate, '--prefix', prefix, '--installer', 'npm', '--json', '--record', recordPath]),
    );

    expect(out.code).toBe(2);
    const doc = JSON.parse(out.stdout) as FailureView;
    expect(doc.ok).toBe(false);
    expect(doc.decision).toBe('refuse-installer-failed');
    expect(doc.phase).toBe('post-dispatch');
    expect(doc.dispatched).toBe(true);
    expect(doc.mutateCalls).toBe(1);
    expect(doc.mutated).toBe(true);
    expect(doc.installedState).toBe('changed');
    expect(doc.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: CANDIDATE,
      gitHead: SHA_NEW,
      matchesCandidate: true,
    });
    expect(doc.prefix).toBe(resolve(prefix));
    expect(doc.recordPath).toBe(resolve(recordPath));
    expect(doc.recordError).toBeNull();
    expect(out.stderr).toContain('install: npm install failed');
    expect(out.stderr).toContain(`installed state changed; inspect ${resolve(prefix)}`);
    expect(existsSync(recordPath)).toBe(true);
    expect(JSON.parse(readFileSync(recordPath, 'utf8'))).toEqual(doc);
  });

  test('the text CLI failure names the npm failure and the installed-state suffix', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const binDir = temp('rc3-t2-bin-');
    fakeNpm(binDir, { exitCode: 7, manifest: { version: CANDIDATE, gitHead: SHA_NEW } });
    const recordPath = join(temp('rc3-t2-records-'), 'install-failure.json');

    const out = withFakeNpm(binDir, () =>
      runInstallCli([candidate, '--prefix', prefix, '--installer', 'npm', '--record', recordPath]),
    );

    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('install: npm install failed');
    expect(out.stderr).toContain(`installed state changed; inspect ${resolve(prefix)}`);
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as FailureView;
    expect(record.installedState).toBe('changed');
    expect(record.mutateCalls).toBe(1);
    expect(record.recordPath).toBe(resolve(recordPath));
    expect(record.recordError).toBeNull();
  });

  test('the JSON CLI carries an explicit null for an unestablished mutation, not false', () => {
    const prefix = temp('rc3-t2-prefix-');
    seed(prefix, OLD, SHA_OLD);
    const candidate = makeTarball(temp('rc3-t2-candidate-'), CANDIDATE, SHA_NEW);
    const binDir = temp('rc3-t2-bin-');
    fakeNpm(binDir, { exitCode: 0 });

    const out = withFakeNpm(binDir, () =>
      runInstallCli([candidate, '--prefix', prefix, '--installer', 'npm', '--json']),
    );

    expect(out.code).toBe(2);
    const doc = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(doc.decision).toBe('refuse-post-install-mismatch');
    expect(doc.phase).toBe('post-dispatch');
    expect(doc.dispatched).toBe(true);
    expect(doc.mutateCalls).toBe(1);
    expect(Object.hasOwn(doc, 'mutated')).toBe(true);
    expect(doc.mutated).toBeNull();
    expect(doc.installedState).toBe('unknown');
    expect(doc.postState).toEqual({
      inspection: 'ok',
      exists: true,
      version: OLD,
      gitHead: SHA_OLD,
      matchesCandidate: false,
    });
    expect(doc.recordPath).toBeNull();
    expect(doc.recordError).toBeNull();
  });
});
