// Installs a verified, source-stamped TeamCLI release or hotfix tarball into a
// prefix while enforcing the forward-only version guard.
//
// An install replaces the installed version with a newer one, or reinstalls the
// equal version. Replacing an installed version with an older SemVer candidate
// is refused before any installed file is touched unless an explicit rollback is
// declared with a non-empty reason, the actual installed current version, and
// the actual target version carried by the candidate tarball.
//
// Every forward or equal-version candidate must carry a valid 40-hex `gitHead`
// source stamp in `package/package.json` and a matching `<tarball>.stamp.json`
// sidecar (`sha256`, `bytes`, `version`, `gitHead`). Existing rollback artifacts
// are verified and never overwritten.
//
//   bun scripts/install.ts <tarball> --prefix <dir> [options]
//
// Options:
//   --prefix <dir>                 installation prefix (contains lib/node_modules/team and bin/team)
//   --stamp <path>                 explicit path to <tarball>.stamp.json
//   --no-stamp-sidecar             verify inner package/package.json gitHead without requiring sidecar file
//   --expected-sha <40-hex>        require candidate gitHead to equal this commit SHA
//   --rollback                     declare an explicit rollback to an older version
//   --from <version>               actual currently installed version (required with --rollback)
//   --to <version>                 requested older target version in tarball (required with --rollback)
//   --reason <text>                non-empty rollback reason (required with --rollback)
//   --allow-unstamped-rollback     allow a legacy unstamped rollback tarball when --rollback is declared
//   --rollback-dir <dir>           directory of preserved rollback artifacts that must remain untouched
//   --preserve-to-rollback-dir     preserve candidate/current tarball in --rollback-dir without overwriting
//   --record <path>                write the JSON install record to <path>
//   --installer <tar|npm>          installation backend (default: tar)
//   --dry-run                      run all provenance and version guards without mutating <prefix>
//   --json                         print structured JSON result on both allow and refusal
//
// Exits 0 when the install (or --dry-run check) succeeds, 1 when a provenance,
// source-stamp, version-ordering, or rollback guard refuses the candidate before
// mutation, and 2 when arguments or readable file preconditions fail.
//
// A failure after the backend call has been dispatched reports phase
// "post-dispatch", the attempted mutateCalls, and installedState "changed" or
// "unknown" with the measured postState; it never presents a possibly-changed
// prefix as a refusal that left it untouched.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { compareVersions } from '../src/release/grammar.ts';

export { compareVersions } from '../src/release/grammar.ts';

const GIT_HEAD_PATTERN = /^[0-9a-f]{40}$/;

export interface RollbackDeclaration {
  reason: string;
  from: string;
  to: string;
}

export type InstallVersionDecisionKind =
  | 'allow-initial-install'
  | 'allow-forward'
  | 'allow-equal-reinstall'
  | 'allow-declared-rollback'
  | 'refuse-invalid-version'
  | 'refuse-older-version'
  | 'refuse-rollback-missing-reason'
  | 'refuse-rollback-current-mismatch'
  | 'refuse-rollback-target-mismatch'
  | 'refuse-rollback-not-older';

export type InstallDecisionKind =
  | InstallVersionDecisionKind
  | 'refuse-missing-stamp'
  | 'refuse-stamp-sha256-mismatch'
  | 'refuse-stamp-bytes-mismatch'
  | 'refuse-missing-or-mismatched-githead'
  | 'refuse-stamp-vs-manifest-version-mismatch'
  | 'refuse-rollback-preserve-collision'
  | 'refuse-invalid-package'
  | 'refuse-missing-entrypoint'
  | 'refuse-unstamped-forward-install'
  | 'refuse-missing-tarball'
  | 'refuse-corrupt-tarball'
  | 'refuse-corrupt-installed-manifest'
  | 'refuse-installed-bin-not-file'
  | 'refuse-installer-failed'
  | 'refuse-post-install-mismatch';

export interface InstallVersionGuardInput {
  installed: string | null;
  candidate: string;
  rollback?: RollbackDeclaration | null;
}

export interface InstallVersionGuardResult {
  allowed: boolean;
  mutatesInstalled: boolean;
  order: -1 | 0 | 1 | null;
  decision: InstallVersionDecisionKind;
  decisionCode: InstallVersionDecisionKind;
  installed: string | null;
  candidate: string;
  rollback: RollbackDeclaration | null;
  reason: string;
}

export interface StampSidecar {
  tarball?: string;
  version: string;
  gitHead: string;
  sha256: string;
  bytes: number;
  builtAt?: string;
  branch?: string;
}

export interface RollbackArtifactSnapshot {
  path: string;
  sha256: string;
  bytes: number;
}

export interface InstallTarballOptions {
  tarball: string;
  prefix: string;
  rollback?: RollbackDeclaration | null;
  stampPath?: string;
  requireStampSidecar?: boolean;
  expectedGitHead?: string;
  allowUnstampedRollback?: boolean;
  rollbackDir?: string;
  preserveToRollbackDir?: boolean;
  preserveRollbackArtifacts?: readonly string[];
  expectedRollbackSha256?: Readonly<Record<string, string>>;
  recordPath?: string;
  installer?:
    | 'tar'
    | 'npm'
    | ((context: {
        tarball: string;
        unpackedPackageDir: string;
        prefix: string;
        packageDir: string;
        binPath: string;
        binRelPath: string;
      }) => void);
  dryRun?: boolean;
}

/** Whether a failed install stopped before or after a backend call was attempted. */
export type InstallFailurePhase = 'pre-dispatch' | 'post-dispatch';

/** What the measured post-dispatch state says about the installed prefix. */
export type InstallInstalledState = 'unchanged' | 'changed' | 'unknown';

/**
 * The prefix state measured after a dispatched backend call failed. Present only
 * when the re-inspection itself succeeded; `exists: false` is a measured absent
 * installation, distinct from a failed inspection (postState `null`).
 */
export interface InstallPostState {
  inspection: 'ok';
  exists: boolean;
  version: string | null;
  gitHead: string | null;
  matchesCandidate: boolean | null;
}

export type InstallTarballResult =
  | {
      ok: true;
      code: 0;
      status: 'installed' | 'reinstalled' | 'rolled-back' | 'dry-run';
      decision: InstallVersionDecisionKind;
      decisionCode: InstallVersionDecisionKind;
      order: -1 | 0 | 1 | null;
      mutated: boolean;
      mutateCalls: number;
      previousVersion: string | null;
      previousGitHead: string | null;
      version: string;
      gitHead: string | null;
      tarball: string;
      sha256: string;
      bytes: number;
      prefix: string;
      packageDir: string;
      binPath: string;
      installedAt: string;
      rollback: RollbackDeclaration | null;
      preservedRollbackArtifacts: RollbackArtifactSnapshot[];
      message: string;
    }
  | {
      ok: false;
      code: 1 | 2;
      decision: InstallDecisionKind;
      decisionCode: InstallDecisionKind;
      order: -1 | 0 | 1 | null;
      /** Whether this stopped before any backend call or after one was dispatched. */
      phase: InstallFailurePhase;
      /** True iff a backend call was attempted. */
      dispatched: boolean;
      /**
       * False before dispatch; true only when the measured post-state shows a
       * change; null when a dispatched install's effect cannot be established.
       */
      mutated: boolean | null;
      /** Backend calls attempted: 0 before dispatch, at least 1 after. */
      mutateCalls: number;
      /** What the measured post-state says about `<prefix>`. */
      installedState: InstallInstalledState;
      /** Measured state after a dispatched failure; null before dispatch. */
      postState: InstallPostState | null;
      installed: string | null;
      candidate: string | null;
      /** The prefix to inspect; always named so a failure record supports recovery. */
      prefix: string;
      packageDir: string | null;
      binPath: string | null;
      previousGitHead: string | null;
      /** Failure record written (or attempted), when a record path was given. */
      recordPath: string | null;
      /** Why the failure record could not be written; null when it was not attempted or succeeded. */
      recordError: string | null;
      rollback: RollbackDeclaration | null;
      preservedRollbackArtifacts: RollbackArtifactSnapshot[];
      message: string;
    };

/** sha256 hex digest of a file on disk. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Pure SemVer 2.0.0 forward-only install & declared-rollback guard.
 *
 * Uses `compareVersions(candidate, installed)` from `src/release/grammar.ts` so
 * prerelease and hotfix ordering (`0.5.3-hotfix.24 < 0.5.3-hotfix.25 < 0.5.3-rc.1 < 0.5.3-rc.2 < 0.5.3`)
 * is enforced identically to release checks.
 */
export function evaluateInstallVersionGuard(input: InstallVersionGuardInput): InstallVersionGuardResult {
  const { installed, candidate } = input;
  const rollback = input.rollback ?? null;

  if (compareVersions(candidate, candidate) === null) {
    return {
      allowed: false,
      mutatesInstalled: false,
      order: null,
      decision: 'refuse-invalid-version',
      decisionCode: 'refuse-invalid-version',
      installed,
      candidate,
      rollback,
      reason: `install: candidate version ${JSON.stringify(candidate)} is not valid SemVer`,
    };
  }

  if (installed !== null && compareVersions(installed, installed) === null) {
    return {
      allowed: false,
      mutatesInstalled: false,
      order: null,
      decision: 'refuse-invalid-version',
      decisionCode: 'refuse-invalid-version',
      installed,
      candidate,
      rollback,
      reason: `install: installed version ${JSON.stringify(installed)} is not valid SemVer`,
    };
  }

  const order = installed === null ? null : (compareVersions(candidate, installed) as -1 | 0 | 1);

  if (rollback !== null) {
    if (typeof rollback.reason !== 'string' || rollback.reason.trim() === '') {
      return {
        allowed: false,
        mutatesInstalled: false,
        order,
        decision: 'refuse-rollback-missing-reason',
        decisionCode: 'refuse-rollback-missing-reason',
        installed,
        candidate,
        rollback,
        reason: 'install: declared rollback requires a non-empty --reason',
      };
    }
    if (installed === null || rollback.from !== installed) {
      return {
        allowed: false,
        mutatesInstalled: false,
        order,
        decision: 'refuse-rollback-current-mismatch',
        decisionCode: 'refuse-rollback-current-mismatch',
        installed,
        candidate,
        rollback,
        reason:
          `install: declared rollback --from ${JSON.stringify(rollback.from)} does not match ` +
          `actual installed version ${JSON.stringify(installed)}`,
      };
    }
    if (rollback.to !== candidate) {
      return {
        allowed: false,
        mutatesInstalled: false,
        order,
        decision: 'refuse-rollback-target-mismatch',
        decisionCode: 'refuse-rollback-target-mismatch',
        installed,
        candidate,
        rollback,
        reason:
          `install: declared rollback --to ${JSON.stringify(rollback.to)} does not match ` +
          `candidate tarball version ${JSON.stringify(candidate)}`,
      };
    }
    if (order !== -1) {
      return {
        allowed: false,
        mutatesInstalled: false,
        order,
        decision: 'refuse-rollback-not-older',
        decisionCode: 'refuse-rollback-not-older',
        installed,
        candidate,
        rollback,
        reason:
          `install: declared rollback from ${installed} to ${candidate} is not an older version ` +
          `(compareVersions=${String(order)})`,
      };
    }
    return {
      allowed: true,
      mutatesInstalled: true,
      order: -1,
      decision: 'allow-declared-rollback',
      decisionCode: 'allow-declared-rollback',
      installed,
      candidate,
      rollback: {
        reason: rollback.reason.trim(),
        from: rollback.from,
        to: rollback.to,
      },
      reason: `install: declared rollback from ${installed} to ${candidate} (${rollback.reason.trim()})`,
    };
  }

  if (installed === null) {
    return {
      allowed: true,
      mutatesInstalled: true,
      order: null,
      decision: 'allow-initial-install',
      decisionCode: 'allow-initial-install',
      installed: null,
      candidate,
      rollback: null,
      reason: `install: initial install of ${candidate}`,
    };
  }

  if (order === 1) {
    return {
      allowed: true,
      mutatesInstalled: true,
      order: 1,
      decision: 'allow-forward',
      decisionCode: 'allow-forward',
      installed,
      candidate,
      rollback: null,
      reason: `install: forward upgrade from ${installed} to ${candidate}`,
    };
  }

  if (order === 0) {
    return {
      allowed: true,
      mutatesInstalled: true,
      order: 0,
      decision: 'allow-equal-reinstall',
      decisionCode: 'allow-equal-reinstall',
      installed,
      candidate,
      rollback: null,
      reason: `install: equal-version reinstall of ${candidate}`,
    };
  }

  return {
    allowed: false,
    mutatesInstalled: false,
    order: -1,
    decision: 'refuse-older-version',
    decisionCode: 'refuse-older-version',
    installed,
    candidate,
    rollback: null,
    reason:
      `install: refusing older candidate ${candidate} over installed ${installed}; ` +
      `declare --rollback --from ${installed} --to ${candidate} --reason <reason> to roll back`,
  };
}

/** Every regular file under `dir`, sorted as relative paths. */
function regularFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return found.sort();
}

/** Captures sha256 and byte size for preserved rollback artifacts. */
export function snapshotRollbackArtifacts(
  rollbackDir?: string,
  explicitFiles?: readonly string[],
): RollbackArtifactSnapshot[] {
  const paths = new Set<string>();
  if (rollbackDir !== undefined && rollbackDir !== '' && existsSync(rollbackDir)) {
    for (const rel of regularFilesUnder(rollbackDir)) {
      paths.add(resolve(rollbackDir, rel));
    }
  }
  if (explicitFiles !== undefined) {
    for (const file of explicitFiles) {
      if (existsSync(file) && statSync(file).isFile()) {
        paths.add(resolve(file));
      }
    }
  }
  return [...paths].sort().map((path) => ({
    path,
    sha256: sha256File(path),
    bytes: statSync(path).size,
  }));
}

function verifyRollbackSnapshotsUnchanged(snapshots: readonly RollbackArtifactSnapshot[]): string | null {
  for (const item of snapshots) {
    if (!existsSync(item.path)) {
      return `install: preserved rollback artifact ${item.path} was removed`;
    }
    const stat = statSync(item.path);
    if (!stat.isFile() || stat.size !== item.bytes || sha256File(item.path) !== item.sha256) {
      return `install: preserved rollback artifact ${item.path} was modified`;
    }
  }
  return null;
}

interface CandidateData {
  tarball: string;
  sha256: string;
  bytes: number;
  name: string;
  version: string;
  gitHead: string | null;
  binTeam: string;
  unpackedPackageDir: string;
}

interface RefusalDetails {
  phase?: InstallFailurePhase;
  mutateCalls?: number;
  mutated?: boolean | null;
  installedState?: InstallInstalledState;
  postState?: InstallPostState | null;
  prefix?: string;
  packageDir?: string | null;
  binPath?: string | null;
  previousGitHead?: string | null;
  recordPath?: string | null;
  recordError?: string | null;
}

function refuse(
  code: 1 | 2,
  decision: InstallDecisionKind,
  order: -1 | 0 | 1 | null,
  installed: string | null,
  candidate: string | null,
  rollback: RollbackDeclaration | null,
  preservedRollbackArtifacts: RollbackArtifactSnapshot[],
  message: string,
  details: RefusalDetails = {},
): InstallTarballResult {
  const phase = details.phase ?? 'pre-dispatch';
  return {
    ok: false,
    code,
    decision,
    decisionCode: decision,
    order,
    phase,
    dispatched: phase === 'post-dispatch',
    // null is a measured answer ("unknown"), not an absent detail.
    mutated: details.mutated === undefined ? false : details.mutated,
    mutateCalls: details.mutateCalls ?? 0,
    installedState: details.installedState ?? 'unchanged',
    postState: details.postState ?? null,
    installed,
    candidate,
    prefix: details.prefix ?? '',
    packageDir: details.packageDir ?? null,
    binPath: details.binPath ?? null,
    previousGitHead: details.previousGitHead ?? null,
    recordPath: details.recordPath ?? null,
    recordError: details.recordError ?? null,
    rollback,
    preservedRollbackArtifacts,
    message,
  };
}

/**
 * Inspects `<prefix>` to find any currently installed `team` package without mutating `<prefix>`.
 */
export function inspectInstalledPrefix(prefix: string):
  | {
      ok: true;
      exists: boolean;
      prefix: string;
      packageDir: string;
      manifestPath: string;
      binPath: string;
      version: string | null;
      gitHead: string | null;
    }
  | {
      ok: false;
      code: 1 | 2;
      decision: InstallDecisionKind;
      message: string;
    } {
  const resolvedPrefix = resolve(prefix);
  const libPackageDir = join(resolvedPrefix, 'lib', 'node_modules', 'team');
  const flatPackageDir = join(resolvedPrefix, 'node_modules', 'team');
  const libManifest = join(libPackageDir, 'package.json');
  const flatManifest = join(flatPackageDir, 'package.json');

  const packageDir =
    !existsSync(libManifest) && existsSync(flatManifest) ? flatPackageDir : libPackageDir;
  const manifestPath = join(packageDir, 'package.json');
  const binPath = join(resolvedPrefix, 'bin', 'team');

  if (!existsSync(manifestPath)) {
    return {
      ok: true,
      exists: false,
      prefix: resolvedPrefix,
      packageDir: libPackageDir,
      manifestPath: libManifest,
      binPath,
      version: null,
      gitHead: null,
    };
  }

  let parsed: { name?: unknown; version?: unknown; gitHead?: unknown };
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      gitHead?: unknown;
    };
  } catch (error) {
    return {
      ok: false,
      code: 2,
      decision: 'refuse-corrupt-installed-manifest',
      message: `install: cannot read installed manifest ${manifestPath}: ${(error as Error).message}`,
    };
  }

  if (typeof parsed.version !== 'string' || parsed.version === '') {
    return {
      ok: false,
      code: 1,
      decision: 'refuse-invalid-version',
      message: `install: installed manifest ${manifestPath} has no version string`,
    };
  }

  if (compareVersions(parsed.version, parsed.version) === null) {
    return {
      ok: false,
      code: 1,
      decision: 'refuse-invalid-version',
      message: `install: installed version ${JSON.stringify(parsed.version)} in ${manifestPath} is not valid SemVer`,
    };
  }

  const gitHead = typeof parsed.gitHead === 'string' && parsed.gitHead !== '' ? parsed.gitHead : null;

  return {
    ok: true,
    exists: true,
    prefix: resolvedPrefix,
    packageDir,
    manifestPath,
    binPath,
    version: parsed.version,
    gitHead,
  };
}

/**
 * Verifies the candidate tarball, its source stamp, the installed prefix, and the
 * forward-only / declared-rollback version guard before any installed-file mutation.
 * A directory at `<prefix>/bin/team` is refused before dispatch, and a backend that
 * throws after dispatch is reported through the same measured post-dispatch record
 * as an npm failure: no rollback is claimed, and the prefix is inspected again.
 */
export function installTarball(options: InstallTarballOptions): InstallTarballResult {
  const rollback = options.rollback ?? null;
  const preservedRollbackArtifacts = snapshotRollbackArtifacts(
    options.rollbackDir,
    options.preserveRollbackArtifacts,
  );

  const installedState = inspectInstalledPrefix(options.prefix);

  // Every refusal names the prefix and the pre-attempt identity so the record
  // supports inspection even for a failure that dispatched a backend call.
  const refuseHere = (
    code: 1 | 2,
    decision: InstallDecisionKind,
    order: -1 | 0 | 1 | null,
    installed: string | null,
    candidate: string | null,
    rollbackDeclaration: RollbackDeclaration | null,
    preserved: RollbackArtifactSnapshot[],
    message: string,
    details: RefusalDetails = {},
  ): InstallTarballResult =>
    refuse(code, decision, order, installed, candidate, rollbackDeclaration, preserved, message, {
      prefix: installedState.ok ? installedState.prefix : resolve(options.prefix),
      packageDir: installedState.ok ? installedState.packageDir : null,
      binPath: installedState.ok ? installedState.binPath : null,
      previousGitHead: installedState.ok ? installedState.gitHead : null,
      ...details,
    });

  if (!installedState.ok) {
    return refuseHere(
      installedState.code,
      installedState.decision,
      null,
      null,
      null,
      rollback,
      preservedRollbackArtifacts,
      installedState.message,
    );
  }

  const installedVersion = installedState.version;

  // A directory at the bin path cannot become the bin link. Refuse before any
  // backend is dispatched, so no attempt is claimed and nothing is mutated.
  let installedBinStat;
  try {
    installedBinStat = lstatSync(installedState.binPath);
  } catch {
    installedBinStat = null;
  }
  if (installedBinStat !== null && installedBinStat.isDirectory()) {
    return refuseHere(
      2,
      'refuse-installed-bin-not-file',
      null,
      installedVersion,
      null,
      rollback,
      preservedRollbackArtifacts,
      `install: refusing to install over ${installedState.binPath}: it is a directory, not a file or symlink`,
    );
  }

  const resolvedTarball = resolve(options.tarball);
  if (!existsSync(resolvedTarball)) {
    return refuseHere(
      2,
      'refuse-missing-tarball',
      null,
      installedVersion,
      null,
      rollback,
      preservedRollbackArtifacts,
      `install: cannot read tarball ${options.tarball}: file does not exist`,
    );
  }

  let tarballStat;
  try {
    tarballStat = statSync(resolvedTarball);
  } catch (error) {
    return refuseHere(
      2,
      'refuse-missing-tarball',
      null,
      installedVersion,
      null,
      rollback,
      preservedRollbackArtifacts,
      `install: cannot stat ${options.tarball}: ${(error as Error).message}`,
    );
  }
  if (!tarballStat.isFile()) {
    return refuseHere(
      2,
      'refuse-missing-tarball',
      null,
      installedVersion,
      null,
      rollback,
      preservedRollbackArtifacts,
      `install: ${options.tarball} is not a regular file`,
    );
  }

  const tarballBytes = tarballStat.size;
  const tarballSha256 = sha256File(resolvedTarball);

  const scratch = mkdtempSync(join(tmpdir(), 'team-install-'));
  try {
    const extracted = spawnSync('tar', ['-xzf', resolvedTarball, '-C', scratch], { encoding: 'utf8' });
    if (extracted.error !== undefined || extracted.status !== 0) {
      const detail = extracted.error?.message ?? extracted.stderr.trim();
      return refuseHere(
        2,
        'refuse-corrupt-tarball',
        null,
        installedVersion,
        null,
        rollback,
        preservedRollbackArtifacts,
        `install: cannot extract ${options.tarball}: ${detail === '' ? `tar exited ${String(extracted.status)}` : detail}`,
      );
    }

    const unpackedPackageDir = join(scratch, 'package');
    const candidateManifestPath = join(unpackedPackageDir, 'package.json');
    if (!existsSync(candidateManifestPath)) {
      return refuseHere(
        2,
        'refuse-corrupt-tarball',
        null,
        installedVersion,
        null,
        rollback,
        preservedRollbackArtifacts,
        `install: ${options.tarball} does not contain package/package.json`,
      );
    }

    let manifest: {
      name?: unknown;
      version?: unknown;
      gitHead?: unknown;
      bin?: { team?: unknown };
    };
    try {
      manifest = JSON.parse(readFileSync(candidateManifestPath, 'utf8')) as {
        name?: unknown;
        version?: unknown;
        gitHead?: unknown;
        bin?: { team?: unknown };
      };
    } catch (error) {
      return refuseHere(
        2,
        'refuse-corrupt-tarball',
        null,
        installedVersion,
        null,
        rollback,
        preservedRollbackArtifacts,
        `install: cannot parse package/package.json in ${options.tarball}: ${(error as Error).message}`,
      );
    }

    if (manifest.name !== 'team') {
      return refuseHere(
        1,
        'refuse-invalid-package',
        null,
        installedVersion,
        typeof manifest.version === 'string' ? manifest.version : null,
        rollback,
        preservedRollbackArtifacts,
        `install: expected package name "team", got ${JSON.stringify(manifest.name ?? null)}`,
      );
    }

    const candidateVersion = typeof manifest.version === 'string' ? manifest.version : '';

    // 1. Evaluate the SemVer forward-only / declared-rollback version guard before
    // any installed-file mutation.
    const guard = evaluateInstallVersionGuard({
      installed: installedVersion,
      candidate: candidateVersion,
      rollback,
    });

    if (!guard.allowed) {
      return refuseHere(
        1,
        guard.decision,
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        guard.reason,
      );
    }

    if (options.allowUnstampedRollback === true && guard.decision !== 'allow-declared-rollback') {
      return refuseHere(
        1,
        'refuse-unstamped-forward-install',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        'install: --allow-unstamped-rollback is only permitted on a declared rollback',
      );
    }

    const allowUnstamped =
      options.allowUnstampedRollback === true && guard.decision === 'allow-declared-rollback';

    // 2. Sidecar `<tarball>.stamp.json` and inner `package/package.json` `gitHead`
    // provenance verification before any installed-file mutation.
    const stampPath =
      options.stampPath !== undefined && options.stampPath !== ''
        ? resolve(options.stampPath)
        : `${resolvedTarball}.stamp.json`;
    const requireSidecar = options.requireStampSidecar ?? !allowUnstamped;

    let sidecar: Partial<StampSidecar> | null = null;
    if (existsSync(stampPath)) {
      try {
        sidecar = JSON.parse(readFileSync(stampPath, 'utf8')) as Partial<StampSidecar>;
      } catch (error) {
        return refuseHere(
          1,
          'refuse-missing-stamp',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: cannot parse stamp sidecar ${stampPath}: ${(error as Error).message}`,
        );
      }
      if (sidecar.sha256 !== tarballSha256) {
        return refuseHere(
          1,
          'refuse-stamp-sha256-mismatch',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: stamp sidecar sha256 ${JSON.stringify(sidecar.sha256 ?? null)} does not match tarball sha256 ${tarballSha256}`,
        );
      }
      if (sidecar.bytes !== tarballBytes) {
        return refuseHere(
          1,
          'refuse-stamp-bytes-mismatch',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: stamp sidecar bytes ${String(sidecar.bytes ?? null)} does not match tarball bytes ${String(tarballBytes)}`,
        );
      }
      if (sidecar.version !== candidateVersion) {
        return refuseHere(
          1,
          'refuse-stamp-vs-manifest-version-mismatch',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: stamp sidecar version ${JSON.stringify(sidecar.version ?? null)} does not match tarball version ${JSON.stringify(candidateVersion)}`,
        );
      }
    } else if (requireSidecar) {
      return refuseHere(
        1,
        'refuse-missing-stamp',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        `install: missing required source-stamp sidecar ${stampPath}`,
      );
    }

    const rawGitHead = manifest.gitHead;
    let candidateGitHead: string | null = null;
    if (rawGitHead !== undefined && rawGitHead !== null && rawGitHead !== '') {
      if (typeof rawGitHead !== 'string' || !GIT_HEAD_PATTERN.test(rawGitHead)) {
        return refuseHere(
          1,
          'refuse-missing-or-mismatched-githead',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: package/package.json gitHead ${JSON.stringify(rawGitHead)} is not a 40-hex commit SHA`,
        );
      }
      candidateGitHead = rawGitHead;
    } else if (!allowUnstamped) {
      return refuseHere(
        1,
        'refuse-missing-or-mismatched-githead',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        'install: the candidate tarball carries no source stamp (package/package.json gitHead)',
      );
    }

    if (
      sidecar !== null &&
      (typeof sidecar.gitHead !== 'string' ||
        !GIT_HEAD_PATTERN.test(sidecar.gitHead) ||
        (candidateGitHead !== null && sidecar.gitHead !== candidateGitHead))
    ) {
      return refuseHere(
        1,
        'refuse-missing-or-mismatched-githead',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        `install: stamp sidecar gitHead ${JSON.stringify(sidecar.gitHead ?? null)} does not match tarball gitHead ${JSON.stringify(candidateGitHead)}`,
      );
    }

    if (
      options.expectedGitHead !== undefined &&
      options.expectedGitHead !== '' &&
      candidateGitHead !== options.expectedGitHead
    ) {
      return refuseHere(
        1,
        'refuse-missing-or-mismatched-githead',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        `install: candidate source stamp ${JSON.stringify(candidateGitHead)} is not the expected commit ${options.expectedGitHead}`,
      );
    }

    // 3. Rollback artifact non-overwrite & collision guard before any mutation.
    if (options.expectedRollbackSha256 !== undefined) {
      for (const [artifactPathOrName, expectedSha] of Object.entries(options.expectedRollbackSha256)) {
        const candidatePath =
          options.rollbackDir !== undefined && !artifactPathOrName.startsWith('/')
            ? resolve(options.rollbackDir, artifactPathOrName)
            : resolve(artifactPathOrName);
        if (!existsSync(candidatePath) || sha256File(candidatePath) !== expectedSha) {
          return refuseHere(
            1,
            'refuse-rollback-preserve-collision',
            guard.order,
            installedVersion,
            candidateVersion,
            rollback,
            preservedRollbackArtifacts,
            `install: preserved rollback artifact ${candidatePath} sha256 does not match expected ${expectedSha}`,
          );
        }
      }
    }

    if (options.rollbackDir !== undefined && options.rollbackDir !== '' && existsSync(options.rollbackDir)) {
      const sameNameInRollbackDir = resolve(options.rollbackDir, basename(resolvedTarball));
      if (sameNameInRollbackDir !== resolvedTarball && existsSync(sameNameInRollbackDir)) {
        const existingSha = sha256File(sameNameInRollbackDir);
        if (existingSha !== tarballSha256) {
          return refuseHere(
            1,
            'refuse-rollback-preserve-collision',
            guard.order,
            installedVersion,
            candidateVersion,
            rollback,
            preservedRollbackArtifacts,
            `install: rollback preservation collision at ${sameNameInRollbackDir} (existing sha256 ${existingSha} !== candidate ${tarballSha256})`,
          );
        }
      }
    }

    for (const preserved of preservedRollbackArtifacts) {
      if (
        preserved.path === installedState.binPath ||
        preserved.path.startsWith(`${installedState.packageDir}/`)
      ) {
        return refuseHere(
          1,
          'refuse-rollback-preserve-collision',
          guard.order,
          installedVersion,
          candidateVersion,
          rollback,
          preservedRollbackArtifacts,
          `install: target prefix overlaps preserved rollback artifact ${preserved.path}`,
        );
      }
    }

    const binRelPath =
      typeof manifest.bin?.team === 'string' && manifest.bin.team !== ''
        ? manifest.bin.team
        : 'dist/cli.js';
    const candidateBinFile = join(unpackedPackageDir, binRelPath);
    if (!existsSync(candidateBinFile)) {
      return refuseHere(
        1,
        'refuse-missing-entrypoint',
        guard.order,
        installedVersion,
        candidateVersion,
        rollback,
        preservedRollbackArtifacts,
        `install: candidate tarball does not carry entrypoint ${JSON.stringify(binRelPath)}`,
      );
    }

    const candidateData: CandidateData = {
      tarball: resolvedTarball,
      sha256: tarballSha256,
      bytes: tarballBytes,
      name: 'team',
      version: candidateVersion,
      gitHead: candidateGitHead,
      binTeam: binRelPath,
      unpackedPackageDir,
    };

    if (options.dryRun === true) {
      const rollbackProblem = verifyRollbackSnapshotsUnchanged(preservedRollbackArtifacts);
      if (rollbackProblem !== null) {
        return refuseHere(
          1,
          'refuse-rollback-preserve-collision',
          guard.order,
          installedVersion,
          candidateVersion,
          guard.rollback,
          preservedRollbackArtifacts,
          rollbackProblem,
        );
      }
      return {
        ok: true,
        code: 0,
        status: 'dry-run',
        decision: guard.decision,
        decisionCode: guard.decisionCode,
        order: guard.order,
        mutated: false,
        mutateCalls: 0,
        previousVersion: installedVersion,
        previousGitHead: installedState.gitHead,
        version: candidateData.version,
        gitHead: candidateData.gitHead,
        tarball: candidateData.tarball,
        sha256: candidateData.sha256,
        bytes: candidateData.bytes,
        prefix: installedState.prefix,
        packageDir: installedState.packageDir,
        binPath: installedState.binPath,
        installedAt: new Date().toISOString(),
        rollback: guard.rollback,
        preservedRollbackArtifacts,
        message: guard.reason,
      };
    }

    if (
      options.preserveToRollbackDir === true &&
      options.rollbackDir !== undefined &&
      options.rollbackDir !== ''
    ) {
      mkdirSync(options.rollbackDir, { recursive: true });
      const destTarball = resolve(options.rollbackDir, basename(resolvedTarball));
      if (destTarball !== resolvedTarball) {
        if (existsSync(destTarball)) {
          if (sha256File(destTarball) !== tarballSha256) {
            return refuseHere(
              1,
              'refuse-rollback-preserve-collision',
              guard.order,
              installedVersion,
              candidateVersion,
              guard.rollback,
              preservedRollbackArtifacts,
              `install: refusing to overwrite existing rollback tarball ${destTarball}`,
            );
          }
        } else {
          cpSync(resolvedTarball, destTarball);
          if (existsSync(stampPath)) {
            cpSync(stampPath, `${destTarball}.stamp.json`);
          }
        }
      }
    }

    // 4. Perform the installation into `<prefix>`.
    let mutateCalls = 0;

    // A failure after the backend was dispatched measures the prefix again and
    // reports the attempt and its observed effect instead of claiming no mutation.
    const failAfterDispatch = (
      code: 1 | 2,
      decision: InstallDecisionKind,
      order: -1 | 0 | 1 | null,
      installed: string | null,
      candidate: string | null,
      rollbackDeclaration: RollbackDeclaration | null,
      preserved: RollbackArtifactSnapshot[],
      message: string,
    ): InstallTarballResult => {
      const after = inspectInstalledPrefix(installedState.prefix);
      let postState: InstallPostState | null;
      let stateKind: InstallInstalledState;
      if (!after.ok) {
        // The re-inspection itself failed: the effect cannot be measured.
        postState = null;
        stateKind = 'unknown';
      } else {
        postState = {
          inspection: 'ok',
          exists: after.exists,
          version: after.version,
          gitHead: after.gitHead,
          matchesCandidate: after.exists
            ? after.version === candidateData.version && after.gitHead === candidateData.gitHead
            : null,
        };
        const changed =
          after.exists !== installedState.exists ||
          after.version !== installedState.version ||
          after.gitHead !== installedState.gitHead;
        stateKind = changed ? 'changed' : 'unknown';
      }
      let recordPath: string | null = null;
      let recordError: string | null = null;
      if (options.recordPath !== undefined && options.recordPath !== '') {
        recordPath = resolve(options.recordPath);
        try {
          mkdirSync(dirname(recordPath), { recursive: true });
          // Persist the measured failure before returning, so the attempt and
          // its observed effect survive even when the caller loses the result.
          const record = refuseHere(
            code,
            decision,
            order,
            installed,
            candidate,
            rollbackDeclaration,
            preserved,
            `${message}; installed state ${stateKind === 'changed' ? 'changed' : 'unknown'}; inspect ${installedState.prefix}`,
            {
              phase: 'post-dispatch',
              mutateCalls,
              mutated: stateKind === 'changed' ? true : null,
              installedState: stateKind,
              postState,
              recordPath,
              recordError: null,
            },
          );
          writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
        } catch (error) {
          recordError = (error as Error).message;
        }
      }
      const suffix =
        recordError === null ? '' : `; failure record not written: ${recordError}`;
      return refuseHere(
        code,
        decision,
        order,
        installed,
        candidate,
        rollbackDeclaration,
        preserved,
        `${message}; installed state ${stateKind === 'changed' ? 'changed' : 'unknown'}; inspect ${installedState.prefix}${suffix}`,
        {
          phase: 'post-dispatch',
          mutateCalls,
          mutated: stateKind === 'changed' ? true : null,
          installedState: stateKind,
          postState,
          recordPath,
          recordError,
        },
      );
    };

    // A backend may change `<prefix>` and then throw. The throw is reported through
    // failAfterDispatch, which measures the prefix again; nothing claims rollback.
    try {
      const installer = options.installer ?? 'tar';
      if (typeof installer === 'function') {
        mutateCalls += 1;
        installer({
          tarball: candidateData.tarball,
          unpackedPackageDir: candidateData.unpackedPackageDir,
          prefix: installedState.prefix,
          packageDir: installedState.packageDir,
          binPath: installedState.binPath,
          binRelPath: candidateData.binTeam,
        });
      } else if (installer === 'npm') {
        mutateCalls += 1;
        mkdirSync(installedState.prefix, { recursive: true });
        const npmRun = spawnSync(
          'npm',
          [
            'install',
            '--global',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--prefix',
            installedState.prefix,
            candidateData.tarball,
          ],
          { encoding: 'utf8' },
        );
        if (npmRun.error !== undefined || npmRun.status !== 0) {
          const detail = npmRun.error?.message ?? npmRun.stderr.trim();
          return failAfterDispatch(
            2,
            'refuse-installer-failed',
            guard.order,
            installedVersion,
            candidateVersion,
            guard.rollback,
            preservedRollbackArtifacts,
            `install: npm install failed: ${detail}`,
          );
        }
      } else {
        mutateCalls += 1;
        atomicExtractToPrefix(
          candidateData.unpackedPackageDir,
          installedState.packageDir,
          installedState.binPath,
          candidateData.binTeam,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failAfterDispatch(
        2,
        'refuse-installer-failed',
        guard.order,
        installedVersion,
        candidateVersion,
        guard.rollback,
        preservedRollbackArtifacts,
        `install: installer failed: ${detail}`,
      );
    }

    // 5. Post-install verification: installed manifest and files must match candidate,
    // and preserved rollback artifacts must remain byte-for-byte untouched.
    const afterInstalled = inspectInstalledPrefix(installedState.prefix);
    if (
      !afterInstalled.ok ||
      !afterInstalled.exists ||
      afterInstalled.version !== candidateData.version ||
      afterInstalled.gitHead !== candidateData.gitHead
    ) {
      return failAfterDispatch(
        2,
        'refuse-post-install-mismatch',
        guard.order,
        installedVersion,
        candidateVersion,
        guard.rollback,
        preservedRollbackArtifacts,
        'install: post-install verification failed to match candidate version and gitHead',
      );
    }

    const rollbackProblem = verifyRollbackSnapshotsUnchanged(preservedRollbackArtifacts);
    if (rollbackProblem !== null) {
      return failAfterDispatch(
        1,
        'refuse-rollback-preserve-collision',
        guard.order,
        installedVersion,
        candidateVersion,
        guard.rollback,
        preservedRollbackArtifacts,
        rollbackProblem,
      );
    }

    const status: 'installed' | 'reinstalled' | 'rolled-back' =
      guard.decision === 'allow-declared-rollback'
        ? 'rolled-back'
        : guard.decision === 'allow-equal-reinstall'
          ? 'reinstalled'
          : 'installed';

    const result: InstallTarballResult = {
      ok: true,
      code: 0,
      status,
      decision: guard.decision,
      decisionCode: guard.decisionCode,
      order: guard.order,
      mutated: true,
      mutateCalls,
      previousVersion: installedVersion,
      previousGitHead: installedState.gitHead,
      version: candidateData.version,
      gitHead: candidateData.gitHead,
      tarball: candidateData.tarball,
      sha256: candidateData.sha256,
      bytes: candidateData.bytes,
      prefix: afterInstalled.prefix,
      packageDir: afterInstalled.packageDir,
      binPath: afterInstalled.binPath,
      installedAt: new Date().toISOString(),
      rollback: guard.rollback,
      preservedRollbackArtifacts,
      message: guard.reason,
    };

    if (options.recordPath !== undefined && options.recordPath !== '') {
      const resolvedRecord = resolve(options.recordPath);
      mkdirSync(dirname(resolvedRecord), { recursive: true });
      writeFileSync(resolvedRecord, `${JSON.stringify(result, null, 2)}\n`);
    }

    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function atomicExtractToPrefix(
  unpackedPackageDir: string,
  packageDir: string,
  binPath: string,
  binRelPath: string,
): void {
  const parentDir = dirname(packageDir);
  mkdirSync(parentDir, { recursive: true });
  mkdirSync(dirname(binPath), { recursive: true });

  const stageDir = mkdtempSync(join(parentDir, '.team-stage-'));
  const backupDir = join(parentDir, `.team-backup-${String(process.pid)}-${String(Date.now())}`);
  const stagedPkg = join(stageDir, 'team');

  try {
    cpSync(unpackedPackageDir, stagedPkg, { recursive: true });
    const entryFile = join(stagedPkg, binRelPath);
    if (existsSync(entryFile)) {
      chmodSync(entryFile, 0o755);
    }

    const hadExisting = existsSync(packageDir);
    if (hadExisting) {
      renameSync(packageDir, backupDir);
    }
    try {
      renameSync(stagedPkg, packageDir);
    } catch (error) {
      if (hadExisting && existsSync(backupDir) && !existsSync(packageDir)) {
        renameSync(backupDir, packageDir);
      }
      throw error;
    }
    if (hadExisting && existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    }

    const targetFile = join(packageDir, binRelPath);
    const relativeTarget = relative(dirname(binPath), targetFile);
    try {
      lstatSync(binPath);
      unlinkSync(binPath);
    } catch {
      // binPath did not exist
    }
    symlinkSync(relativeTarget, binPath);
    readlinkSync(binPath);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

export function runInstallCli(argv: readonly string[]): {
  code: number;
  stdout: string;
  stderr: string;
} {
  let tarball: string | undefined;
  let prefix: string | undefined;
  let stampPath: string | undefined;
  let requireStampSidecar = true;
  let expectedGitHead: string | undefined;
  let rollbackFlag = false;
  let fromVersion: string | undefined;
  let toVersion: string | undefined;
  let reason: string | undefined;
  let allowUnstampedRollback = false;
  let rollbackDir: string | undefined;
  let preserveToRollbackDir = false;
  let recordPath: string | undefined;
  let installer: 'tar' | 'npm' = 'tar';
  let dryRun = false;
  let jsonOutput = false;

  const takeValue = (flag: string, index: number): [string, number] | null => {
    const arg = argv[index] as string;
    if (arg === flag) {
      const next = argv[index + 1];
      if (next === undefined || next === '') return null;
      return [next, index + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return [arg.slice(flag.length + 1), index];
    }
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') {
      return {
        code: 0,
        stdout:
          'usage: bun scripts/install.ts <tarball> --prefix <dir> [--stamp <path>] [--expected-sha <sha>] ' +
          '[--rollback --from <current> --to <target> --reason <text>] [--rollback-dir <dir>] [--dry-run] [--json]\n',
        stderr: '',
      };
    }
    if (arg === '--rollback') {
      rollbackFlag = true;
      continue;
    }
    if (arg === '--no-stamp-sidecar') {
      requireStampSidecar = false;
      continue;
    }
    if (arg === '--allow-unstamped-rollback') {
      allowUnstampedRollback = true;
      continue;
    }
    if (arg === '--preserve-to-rollback-dir') {
      preserveToRollbackDir = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--json') {
      jsonOutput = true;
      continue;
    }

    const prefixMatch = takeValue('--prefix', i);
    if (prefixMatch !== null) {
      [prefix, i] = prefixMatch;
      continue;
    }
    const tarballMatch = takeValue('--tarball', i) ?? takeValue('--candidate', i);
    if (tarballMatch !== null) {
      [tarball, i] = tarballMatch;
      continue;
    }
    const stampMatch = takeValue('--stamp', i);
    if (stampMatch !== null) {
      [stampPath, i] = stampMatch;
      continue;
    }
    const expectedMatch = takeValue('--expected-sha', i);
    if (expectedMatch !== null) {
      [expectedGitHead, i] = expectedMatch;
      continue;
    }
    const fromMatch = takeValue('--from', i) ?? takeValue('--current', i);
    if (fromMatch !== null) {
      [fromVersion, i] = fromMatch;
      continue;
    }
    const toMatch = takeValue('--to', i) ?? takeValue('--target', i);
    if (toMatch !== null) {
      [toVersion, i] = toMatch;
      continue;
    }
    const reasonMatch = takeValue('--reason', i) ?? takeValue('--rollback-reason', i);
    if (reasonMatch !== null) {
      [reason, i] = reasonMatch;
      continue;
    }
    const rollbackDirMatch = takeValue('--rollback-dir', i);
    if (rollbackDirMatch !== null) {
      [rollbackDir, i] = rollbackDirMatch;
      continue;
    }
    const recordMatch = takeValue('--record', i);
    if (recordMatch !== null) {
      [recordPath, i] = recordMatch;
      continue;
    }
    const installerMatch = takeValue('--installer', i);
    if (installerMatch !== null) {
      const [val, nextIdx] = installerMatch;
      if (val !== 'tar' && val !== 'npm') {
        return {
          code: 2,
          stdout: '',
          stderr: `install: --installer must be "tar" or "npm", got ${JSON.stringify(val)}\n`,
        };
      }
      installer = val;
      i = nextIdx;
      continue;
    }

    if (arg.startsWith('-')) {
      return {
        code: 2,
        stdout: '',
        stderr: `install: unknown option ${JSON.stringify(arg)}\n`,
      };
    }

    if (tarball === undefined) {
      tarball = arg;
    } else {
      return {
        code: 2,
        stdout: '',
        stderr: `install: unexpected positional argument ${JSON.stringify(arg)} (${basename(tarball)} already given)\n`,
      };
    }
  }

  if (tarball === undefined || tarball === '' || prefix === undefined || prefix === '') {
    return {
      code: 2,
      stdout: '',
      stderr:
        'usage: bun scripts/install.ts <tarball> --prefix <dir> [--rollback --from <current> --to <target> --reason <text>]\n',
    };
  }

  if (!rollbackFlag && (fromVersion !== undefined || toVersion !== undefined || reason !== undefined)) {
    return {
      code: 1,
      stdout: '',
      stderr: 'install: --from, --to, and --reason require explicit --rollback\n',
    };
  }

  const rollback: RollbackDeclaration | null = rollbackFlag
    ? {
        reason: reason ?? '',
        from: fromVersion ?? '',
        to: toVersion ?? '',
      }
    : null;

  const result = installTarball({
    tarball,
    prefix,
    rollback,
    stampPath,
    requireStampSidecar,
    expectedGitHead,
    allowUnstampedRollback,
    rollbackDir,
    preserveToRollbackDir,
    recordPath,
    installer,
    dryRun,
  });

  if (result.ok) {
    return {
      code: 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: '',
    };
  }

  if (jsonOutput) {
    return {
      code: result.code,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: `${result.message}\n`,
    };
  }

  return {
    code: result.code,
    stdout: '',
    stderr: `${result.message}\n`,
  };
}

if (import.meta.main) {
  const { code, stdout, stderr } = runInstallCli(process.argv.slice(2));
  if (stdout !== '') process.stdout.write(stdout);
  if (stderr !== '') process.stderr.write(stderr);
  process.exit(code);
}
