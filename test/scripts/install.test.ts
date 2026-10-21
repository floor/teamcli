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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  compareVersions,
  evaluateInstallVersionGuard,
  installTarball,
  runInstallCli,
  sha256File,
  type InstallDecisionKind,
  type InstallVersionDecisionKind,
  type RollbackDeclaration,
} from '../../scripts/install.ts';

const repo = join(import.meta.dir, '..', '..');

const SHA_052 = '5252525252525252525252525252525252525252';
const SHA_HOTFIX_24 = '2424242424242424242424242424242424242424';
const SHA_HOTFIX_25 = '2525252525252525252525252525252525252525';
const SHA_RC_1 = '1111111111111111111111111111111111111111';
const SHA_RC_2 = '2222222222222222222222222222222222222222';
const SHA_STABLE_053 = '3333333333333333333333333333333333333333';
const SHA_RC_054 = '4444444444444444444444444444444444444444';

const areas: string[] = [];

function area(prefix = 'install-guard-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  areas.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of areas.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureTarballOptions {
  name?: string;
  version: string;
  gitHead?: string | null;
  writeStampSidecar?: boolean;
  stampOverrides?: Partial<{
    version: string;
    gitHead: string;
    sha256: string;
    bytes: number;
  }>;
  extraFiles?: Record<string, string>;
  outDir?: string;
}

function makeFixtureTarball(options: FixtureTarballOptions): {
  tarball: string;
  stampPath: string;
  sha256: string;
  bytes: number;
} {
  const staging = area('install-stage-');
  const outDir = options.outDir ?? area('install-out-');
  mkdirSync(outDir, { recursive: true });

  const manifest: Record<string, unknown> = {
    name: options.name ?? 'team',
    version: options.version,
    bin: { team: 'dist/cli.js' },
  };
  if (options.gitHead !== null) {
    manifest.gitHead = options.gitHead ?? SHA_STABLE_053;
  }

  const files: Record<string, string> = {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'dist/cli.js': `#!/usr/bin/env node\nconsole.log(${JSON.stringify(options.version)});\n`,
    ...(options.extraFiles ?? {}),
  };

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(staging, 'package', relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  const safeVersion = options.version.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tarball = join(outDir, `team-${safeVersion}.tgz`);
  const tar = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package']);
  expect(tar.status).toBe(0);

  const bytes = statSync(tarball).size;
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const stampPath = `${tarball}.stamp.json`;

  if (options.writeStampSidecar !== false) {
    const stamp = {
      tarball: basename(tarball),
      version: options.stampOverrides?.version ?? options.version,
      gitHead: options.stampOverrides?.gitHead ?? (typeof manifest.gitHead === 'string' ? manifest.gitHead : ''),
      sha256: options.stampOverrides?.sha256 ?? sha256,
      bytes: options.stampOverrides?.bytes ?? bytes,
      builtAt: '2026-10-21T00:00:00.000Z',
      branch: 'main',
    };
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  }

  return { tarball, stampPath, sha256, bytes };
}

function snapshotTree(dir: string): Record<string, { sha256: string; bytes: number; mtimeMs: number }> {
  const out: Record<string, { sha256: string; bytes: number; mtimeMs: number }> = {};
  if (!existsSync(dir)) return out;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      const rel = relative(dir, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const st = statSync(full);
        out[rel] = {
          sha256: sha256File(full),
          bytes: st.size,
          mtimeMs: st.mtimeMs,
        };
      }
    }
  };
  walk(dir);
  return out;
}

function seedInstalledPrefix(prefix: string, version: string, gitHead: string): void {
  const pkg = makeFixtureTarball({ version, gitHead });
  const seeded = installTarball({ tarball: pkg.tarball, prefix });
  expect(seeded.ok).toBe(true);
  const fixedPast = new Date('2026-10-20T12:00:00.000Z');
  const manifestPath = join(prefix, 'lib', 'node_modules', 'team', 'package.json');
  const cliPath = join(prefix, 'lib', 'node_modules', 'team', 'dist', 'cli.js');
  utimesSync(manifestPath, fixedPast, fixedPast);
  utimesSync(cliPath, fixedPast, fixedPast);
}

describe('evaluateInstallVersionGuard SemVer 2.0.0 ordering & rollback contract', () => {
  const cases: {
    id: string;
    installed: string | null;
    candidate: string;
    rollback: RollbackDeclaration | null;
    expectedOrder: -1 | 0 | 1 | null;
    expectedDecision: InstallVersionDecisionKind;
    mutatesInstalled: boolean;
  }[] = [
    {
      id: 'C01 hotfix downgrade 0.5.3-hotfix.25 -> 0.5.3-hotfix.24 refused',
      installed: '0.5.3-hotfix.25',
      candidate: '0.5.3-hotfix.24',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      mutatesInstalled: false,
    },
    {
      id: 'C02 hotfix to rc.1 0.5.3-hotfix.25 -> 0.5.3-rc.1 allowed forward',
      installed: '0.5.3-hotfix.25',
      candidate: '0.5.3-rc.1',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      mutatesInstalled: true,
    },
    {
      id: 'C03 rc.1 to rc.2 0.5.3-rc.1 -> 0.5.3-rc.2 allowed forward',
      installed: '0.5.3-rc.1',
      candidate: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      mutatesInstalled: true,
    },
    {
      id: 'C04 rc.2 to rc.1 downgrade without rollback refused',
      installed: '0.5.3-rc.2',
      candidate: '0.5.3-rc.1',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      mutatesInstalled: false,
    },
    {
      id: 'C05 rc.2 to stable 0.5.3-rc.2 -> 0.5.3 allowed forward',
      installed: '0.5.3-rc.2',
      candidate: '0.5.3',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      mutatesInstalled: true,
    },
    {
      id: 'C06 stable to rc.2 downgrade without rollback refused',
      installed: '0.5.3',
      candidate: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      mutatesInstalled: false,
    },
    {
      id: 'C07 stable to hotfix.25 downgrade without rollback refused',
      installed: '0.5.3',
      candidate: '0.5.3-hotfix.25',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      mutatesInstalled: false,
    },
    {
      id: 'C08 equal stable version 0.5.3 -> 0.5.3 reinstall allowed',
      installed: '0.5.3',
      candidate: '0.5.3',
      rollback: null,
      expectedOrder: 0,
      expectedDecision: 'allow-equal-reinstall',
      mutatesInstalled: true,
    },
    {
      id: 'C09 equal prerelease version 0.5.3-rc.2 -> 0.5.3-rc.2 reinstall allowed',
      installed: '0.5.3-rc.2',
      candidate: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: 0,
      expectedDecision: 'allow-equal-reinstall',
      mutatesInstalled: true,
    },
    {
      id: 'C10 stable 0.5.3 to next patch prerelease 0.5.4-rc.1 allowed forward',
      installed: '0.5.3',
      candidate: '0.5.4-rc.1',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      mutatesInstalled: true,
    },
    {
      id: 'C11 stable 0.5.3 to older patch 0.5.2 refused',
      installed: '0.5.3',
      candidate: '0.5.2',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      mutatesInstalled: false,
    },
    {
      id: 'C12 declared rollback with valid reason, current, and target allowed',
      installed: '0.5.3',
      candidate: '0.5.3-rc.2',
      rollback: {
        reason: 'post-install regression in smoke check',
        from: '0.5.3',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'allow-declared-rollback',
      mutatesInstalled: true,
    },
    {
      id: 'C13 declared rollback with blank reason refused',
      installed: '0.5.3',
      candidate: '0.5.3-rc.2',
      rollback: {
        reason: '   ',
        from: '0.5.3',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-missing-reason',
      mutatesInstalled: false,
    },
    {
      id: 'C14 declared rollback with wrong current version refused',
      installed: '0.5.3',
      candidate: '0.5.3-rc.2',
      rollback: {
        reason: 'rollback test',
        from: '0.5.3-rc.1',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-current-mismatch',
      mutatesInstalled: false,
    },
    {
      id: 'C15 declared rollback with wrong target version refused',
      installed: '0.5.3',
      candidate: '0.5.3-rc.2',
      rollback: {
        reason: 'rollback test',
        from: '0.5.3',
        to: '0.5.3-hotfix.25',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-target-mismatch',
      mutatesInstalled: false,
    },
    {
      id: 'declared rollback on forward upgrade refused',
      installed: '0.5.3-rc.2',
      candidate: '0.5.3',
      rollback: {
        reason: 'mistaken rollback flag on upgrade',
        from: '0.5.3-rc.2',
        to: '0.5.3',
      },
      expectedOrder: 1,
      expectedDecision: 'refuse-rollback-not-older',
      mutatesInstalled: false,
    },
    {
      id: 'C16 invalid SemVer candidate refused',
      installed: '0.5.3',
      candidate: 'v0.5.3',
      rollback: null,
      expectedOrder: null,
      expectedDecision: 'refuse-invalid-version',
      mutatesInstalled: false,
    },
  ];

  for (const item of cases) {
    test(item.id, () => {
      const result = evaluateInstallVersionGuard({
        installed: item.installed,
        candidate: item.candidate,
        rollback: item.rollback,
      });
      expect(result.order).toBe(item.expectedOrder);
      expect(result.decision).toBe(item.expectedDecision);
      expect(result.decisionCode).toBe(item.expectedDecision);
      expect(result.allowed).toBe(item.mutatesInstalled);
      expect(result.mutatesInstalled).toBe(item.mutatesInstalled);
    });
  }

  test('strictly ordered chain 0.5.2 < 0.5.3-hotfix.24 < 0.5.3-hotfix.25 < 0.5.3-rc.1 < 0.5.3-rc.2 < 0.5.3 < 0.5.4-rc.1', () => {
    const chain = [
      '0.5.2',
      '0.5.3-hotfix.24',
      '0.5.3-hotfix.25',
      '0.5.3-rc.1',
      '0.5.3-rc.2',
      '0.5.3',
      '0.5.4-rc.1',
    ];
    for (let i = 0; i < chain.length; i++) {
      const a = chain[i] as string;
      expect(compareVersions(a, a)).toBe(0);
      for (let j = i + 1; j < chain.length; j++) {
        const b = chain[j] as string;
        expect(compareVersions(a, b)).toBe(-1);
        expect(compareVersions(b, a)).toBe(1);
      }
    }
  });
});

describe('installTarball end-to-end synthetic acceptance across C01-C22', () => {
  const versionToSha: Record<string, string> = {
    '0.5.2': SHA_052,
    '0.5.3-hotfix.24': SHA_HOTFIX_24,
    '0.5.3-hotfix.25': SHA_HOTFIX_25,
    '0.5.3-rc.1': SHA_RC_1,
    '0.5.3-rc.2': SHA_RC_2,
    '0.5.3': SHA_STABLE_053,
    '0.5.4-rc.1': SHA_RC_054,
  };

  const endToEndCases: {
    id: string;
    installedVersion: string;
    candidateVersion: string;
    rollback: RollbackDeclaration | null;
    fault?:
      | 'missing-stamp'
      | 'stamp-sha256-mismatch'
      | 'stamp-bytes-mismatch'
      | 'missing-inner-githead'
      | 'stamp-vs-manifest-version-mismatch'
      | 'rollback-preserve-collision';
    expectedOrder: -1 | 0 | 1 | null;
    expectedDecision: InstallDecisionKind;
    expectedMutateCalls: 0 | 1;
  }[] = [
    {
      id: 'C01_hotfix_downgrade',
      installedVersion: '0.5.3-hotfix.25',
      candidateVersion: '0.5.3-hotfix.24',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C02_hotfix_to_rc1_forward',
      installedVersion: '0.5.3-hotfix.25',
      candidateVersion: '0.5.3-rc.1',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      expectedMutateCalls: 1,
    },
    {
      id: 'C03_rc1_to_rc2_forward',
      installedVersion: '0.5.3-rc.1',
      candidateVersion: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      expectedMutateCalls: 1,
    },
    {
      id: 'C04_rc2_to_rc1_downgrade_unflagged',
      installedVersion: '0.5.3-rc.2',
      candidateVersion: '0.5.3-rc.1',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C05_rc2_to_stable_forward',
      installedVersion: '0.5.3-rc.2',
      candidateVersion: '0.5.3',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      expectedMutateCalls: 1,
    },
    {
      id: 'C06_stable_to_rc2_downgrade_unflagged',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C07_stable_to_hotfix25_downgrade_unflagged',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-hotfix.25',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C08_equal_version_reinstall',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3',
      rollback: null,
      expectedOrder: 0,
      expectedDecision: 'allow-equal-reinstall',
      expectedMutateCalls: 1,
    },
    {
      id: 'C09_equal_rc_reinstall',
      installedVersion: '0.5.3-rc.2',
      candidateVersion: '0.5.3-rc.2',
      rollback: null,
      expectedOrder: 0,
      expectedDecision: 'allow-equal-reinstall',
      expectedMutateCalls: 1,
    },
    {
      id: 'C10_stable_to_next_patch_rc_forward',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      expectedOrder: 1,
      expectedDecision: 'allow-forward',
      expectedMutateCalls: 1,
    },
    {
      id: 'C11_stable_to_older_patch_downgrade',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.2',
      rollback: null,
      expectedOrder: -1,
      expectedDecision: 'refuse-older-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C12_declared_rollback_valid',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-rc.2',
      rollback: {
        reason: 'post-install regression in smoke check',
        from: '0.5.3',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'allow-declared-rollback',
      expectedMutateCalls: 1,
    },
    {
      id: 'C13_declared_rollback_missing_reason',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-rc.2',
      rollback: {
        reason: '   ',
        from: '0.5.3',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-missing-reason',
      expectedMutateCalls: 0,
    },
    {
      id: 'C14_declared_rollback_wrong_current',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-rc.2',
      rollback: {
        reason: 'rollback test',
        from: '0.5.3-rc.1',
        to: '0.5.3-rc.2',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-current-mismatch',
      expectedMutateCalls: 0,
    },
    {
      id: 'C15_declared_rollback_wrong_target',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.3-rc.2',
      rollback: {
        reason: 'rollback test',
        from: '0.5.3',
        to: '0.5.3-hotfix.25',
      },
      expectedOrder: -1,
      expectedDecision: 'refuse-rollback-target-mismatch',
      expectedMutateCalls: 0,
    },
    {
      id: 'C16_invalid_semver_candidate',
      installedVersion: '0.5.3',
      candidateVersion: 'v0.5.3',
      rollback: null,
      expectedOrder: null,
      expectedDecision: 'refuse-invalid-version',
      expectedMutateCalls: 0,
    },
    {
      id: 'C17_missing_stamp_sidecar',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'missing-stamp',
      expectedOrder: 1,
      expectedDecision: 'refuse-missing-stamp',
      expectedMutateCalls: 0,
    },
    {
      id: 'C18_stamp_sha256_mismatch',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'stamp-sha256-mismatch',
      expectedOrder: 1,
      expectedDecision: 'refuse-stamp-sha256-mismatch',
      expectedMutateCalls: 0,
    },
    {
      id: 'C19_stamp_bytes_mismatch',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'stamp-bytes-mismatch',
      expectedOrder: 1,
      expectedDecision: 'refuse-stamp-bytes-mismatch',
      expectedMutateCalls: 0,
    },
    {
      id: 'C20_missing_inner_githead',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'missing-inner-githead',
      expectedOrder: 1,
      expectedDecision: 'refuse-missing-or-mismatched-githead',
      expectedMutateCalls: 0,
    },
    {
      id: 'C21_stamp_vs_manifest_version_mismatch',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'stamp-vs-manifest-version-mismatch',
      expectedOrder: 1,
      expectedDecision: 'refuse-stamp-vs-manifest-version-mismatch',
      expectedMutateCalls: 0,
    },
    {
      id: 'C22_rollback_preserve_collision_guard',
      installedVersion: '0.5.3',
      candidateVersion: '0.5.4-rc.1',
      rollback: null,
      fault: 'rollback-preserve-collision',
      expectedOrder: 1,
      expectedDecision: 'refuse-rollback-preserve-collision',
      expectedMutateCalls: 0,
    },
  ];

  for (const tc of endToEndCases) {
    test(`${tc.id}: ${tc.installedVersion} -> ${tc.candidateVersion} (${tc.expectedDecision})`, () => {
      const prefix = area(`prefix-${tc.id}-`);
      const rollbackDir = area(`rollback-${tc.id}-`);

      seedInstalledPrefix(
        prefix,
        tc.installedVersion,
        versionToSha[tc.installedVersion] ?? SHA_STABLE_053,
      );

      // Seed a preserved rollback artifact in rollbackDir
      const preserved = makeFixtureTarball({
        version: '0.5.3-hotfix.25',
        gitHead: SHA_HOTFIX_25,
        outDir: rollbackDir,
      });
      expect(existsSync(preserved.tarball)).toBe(true);

      const candidatePkg = makeFixtureTarball({
        version: tc.candidateVersion,
        gitHead:
          tc.fault === 'missing-inner-githead'
            ? null
            : (versionToSha[tc.candidateVersion] ?? SHA_RC_054),
        writeStampSidecar: tc.fault !== 'missing-stamp',
        stampOverrides:
          tc.fault === 'stamp-sha256-mismatch'
            ? { sha256: '0000000000000000000000000000000000000000000000000000000000000000' }
            : tc.fault === 'stamp-bytes-mismatch'
              ? { bytes: 999999 }
              : tc.fault === 'stamp-vs-manifest-version-mismatch'
                ? { version: '0.5.3' }
                : tc.fault === 'missing-inner-githead'
                  ? { gitHead: SHA_RC_054 }
                  : undefined,
      });

      if (tc.fault === 'rollback-preserve-collision') {
        writeFileSync(join(rollbackDir, basename(candidatePkg.tarball)), 'conflicting-rollback-bytes');
      }

      const beforePrefixTree = snapshotTree(prefix);
      const beforeRollbackTree = snapshotTree(rollbackDir);

      const res = installTarball({
        tarball: candidatePkg.tarball,
        prefix,
        rollbackDir,
        preserveToRollbackDir: tc.fault === 'rollback-preserve-collision',
        rollback: tc.rollback,
      });

      expect(res.order).toBe(tc.expectedOrder);
      expect(res.decision).toBe(tc.expectedDecision);
      expect(res.decisionCode).toBe(tc.expectedDecision);
      expect(res.mutateCalls).toBe(tc.expectedMutateCalls);
      expect(res.mutated).toBe(tc.expectedMutateCalls === 1);
      expect(res.ok).toBe(tc.expectedMutateCalls === 1);

      if (tc.expectedMutateCalls === 0) {
        expect(snapshotTree(prefix)).toEqual(beforePrefixTree);
      } else if (res.ok) {
        expect(res.version).toBe(tc.candidateVersion);
        expect(res.previousVersion).toBe(tc.installedVersion);
      }
      expect(snapshotTree(rollbackDir)).toEqual(beforeRollbackTree);
    });
  }

  test('CLI entrypoint enforces forward-only guard, rollback flags, and exit codes', () => {
    const prefix = area('install-cli-prefix-');
    const pkgRc2 = makeFixtureTarball({
      version: '0.5.3-rc.2',
      gitHead: SHA_RC_2,
    });
    const pkg053 = makeFixtureTarball({
      version: '0.5.3',
      gitHead: SHA_STABLE_053,
    });

    const first = runInstallCli([pkg053.tarball, '--prefix', prefix]);
    expect(first.code).toBe(0);
    const parsedFirst = JSON.parse(first.stdout) as { version: string; decision: string };
    expect(parsedFirst.version).toBe('0.5.3');
    expect(parsedFirst.decision).toBe('allow-initial-install');

    const subRefused = spawnSync(
      'bun',
      ['scripts/install.ts', pkgRc2.tarball, '--prefix', prefix, '--json'],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(subRefused.status).toBe(1);
    const parsedRefused = JSON.parse(subRefused.stdout) as {
      ok: boolean;
      decision: string;
      decisionCode: string;
      order: number;
      mutated: boolean;
      mutateCalls: number;
    };
    expect(parsedRefused.ok).toBe(false);
    expect(parsedRefused.decision).toBe('refuse-older-version');
    expect(parsedRefused.decisionCode).toBe('refuse-older-version');
    expect(parsedRefused.order).toBe(-1);
    expect(parsedRefused.mutated).toBe(false);
    expect(parsedRefused.mutateCalls).toBe(0);

    const subRollback = spawnSync(
      'bun',
      [
        'scripts/install.ts',
        pkgRc2.tarball,
        '--prefix',
        prefix,
        '--rollback',
        '--from',
        '0.5.3',
        '--to',
        '0.5.3-rc.2',
        '--reason',
        'verified rollback via CLI',
      ],
      { cwd: repo, encoding: 'utf8' },
    );
    expect(subRollback.status).toBe(0);
    const parsedRollback = JSON.parse(subRollback.stdout) as {
      ok: boolean;
      status: string;
      decision: string;
      decisionCode: string;
      version: string;
      mutateCalls: number;
    };
    expect(parsedRollback.ok).toBe(true);
    expect(parsedRollback.status).toBe('rolled-back');
    expect(parsedRollback.decision).toBe('allow-declared-rollback');
    expect(parsedRollback.decisionCode).toBe('allow-declared-rollback');
    expect(parsedRollback.version).toBe('0.5.3-rc.2');
    expect(parsedRollback.mutateCalls).toBe(1);
  });
});
