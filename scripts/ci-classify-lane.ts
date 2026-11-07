#!/usr/bin/env bun
// Classifies a diff into `routine` or `careful` for CI lane selection.
//
// Fail-closed contract:
//  - Every individual pattern in CAREFUL_RULES and ROUTINE_ALLOWLIST is verified against tracked
//    files in the real git tree (`bun scripts/ci-classify-lane.ts --check`).
//  - `schedule` and `workflow_dispatch` events, empty diffs, and diff failures are always `careful`.
//  - Any file matching CAREFUL_RULES is `careful`.
//  - Any source file that can reach an admission module (ADMISSION_MODULES) at runtime is
//    `careful`, even when a routine rule matches its path: the routine list is a path list, and
//    a module that can call the caller, signature, delegation, grant or credential code can
//    change an admission answer from a path the list calls routine.
//  - A rename is classified by both paths: the diff is taken with rename detection off, so a
//    move from a careful path onto a routine path still lists the careful old path.
//  - Revisions are named by the environment (CI_LANE_BASE_REF, CI_LANE_BEFORE_REF), never
//    expanded by a shell into argv; a malformed revision is a diff failure, not a fallback.
//  - Any unmatched path (not matched by ROUTINE_ALLOWLIST) defaults to `careful`, never `routine`.
//  - Only a non-empty diff where EVERY changed file matches ROUTINE_ALLOWLIST and NONE matches
//    CAREFUL_RULES or the admission graph classifies as `routine`.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export type Lane = 'routine' | 'careful';

export type LaneRule = {
  readonly name: string;
  readonly patterns: readonly RegExp[];
};

export type LaneClassification = {
  readonly lane: Lane;
  readonly reason: string;
  readonly carefulFiles: readonly string[];
  readonly unmatchedFiles: readonly string[];
};

const exactFiles = (paths: readonly string[]): readonly RegExp[] =>
  paths.map((p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

const dirPrefixes = (dirs: readonly string[]): readonly RegExp[] =>
  dirs.map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

/**
 * Paths whose changes always require the `careful` lane: CI/workflows, build & toolchain,
 * contracts & schemas, native helpers & packages, core state/locks/signing/security, daemon,
 * broker, bus, launch/herdr, send/mcp, registry, the reach roster, permissions/policy/grants/
 * approvals, status, watch, workflow, worktree, and their corresponding command entrypoints.
 *
 * Every individual pattern here is verified against `git ls-files` by `verifyLaneRulesAgainstTree()`.
 */
export const CAREFUL_RULES: readonly LaneRule[] = [
  {
    name: 'github-config-and-workflows',
    patterns: dirPrefixes(['.github']),
  },
  {
    name: 'toolchain-and-tsconfig',
    patterns: exactFiles([
      'package.json',
      'bun.lock',
      'bunfig.toml',
      'tsconfig.json',
      'tsconfig.build.json',
      '.gitignore',
    ]),
  },
  {
    name: 'contracts-and-schemas',
    patterns: dirPrefixes(['contract', 'schema']),
  },
  {
    name: 'native-helpers-packages-and-scripts',
    patterns: dirPrefixes(['helpers', 'packages', 'scripts']),
  },
  {
    name: 'heavy-and-shared-test-infra',
    patterns: [
      ...exactFiles([
        'test/broker.test.ts',
        'test/broker-run.ts',
        'test/exit-codes.test.ts',
        'test/exit-filter.ts',
        'test/exit-filter.test.ts',
        'test/helpers.ts',
      ]),
      ...dirPrefixes(['test/fixtures']),
    ],
  },
  {
    name: 'core-entrypoints-and-state',
    patterns: exactFiles([
      'src/cli.ts',
      'src/client-cli.ts',
      'src/index.ts',
      'src/state.ts',
      'src/caller.ts',
      'src/herdr.ts',
      'src/child.ts',
      'src/entities.ts',
      'src/grant.ts',
      'src/lead.ts',
      'src/lead-chain.ts',
      'src/read-gate.ts',
      'src/authority-edit.ts',
      'src/dev_mode.ts',
      'src/development_mode.ts',
      'src/delegate.ts',
      'src/delegate-types.ts',
    ]),
  },
  {
    name: 'authority-and-security-dirs',
    patterns: dirPrefixes([
      'src/approve',
      'src/broker',
      'src/bus',
      'src/check',
      'src/client',
      'src/config',
      'src/conformance',
      'src/daemon',
      'src/file',
      'src/launch',
      'src/launchers',
      'src/lobby',
      'src/lock',
      'src/mcp',
      'src/permissions',
      'src/policy',
      'src/profiles',
      'src/reach',
      'src/registry',
      'src/release',
      'src/security',
      'src/send',
      'src/settings',
      'src/signing',
      'src/start',
      'src/status',
      'src/store',
      'src/watch',
      'src/workflow',
      'src/worktree',
    ]),
  },
  {
    name: 'careful-commands',
    patterns: exactFiles([
      'src/commands/ack.ts',
      'src/commands/agents.ts',
      'src/commands/approvals.ts',
      'src/commands/broker.ts',
      'src/commands/bus.ts',
      'src/commands/check.ts',
      'src/commands/client.ts',
      'src/commands/config.ts',
      'src/commands/daemon.ts',
      'src/commands/delegate.ts',
      'src/commands/development-mode.ts',
      'src/commands/down.ts',
      'src/commands/fallback.ts',
      'src/commands/grant.ts',
      'src/commands/init.ts',
      'src/commands/lock.ts',
      'src/commands/mcp.ts',
      'src/commands/migrate.ts',
      'src/commands/owner-seat.ts',
      'src/commands/policy.ts',
      'src/commands/register.ts',
      'src/commands/release.ts',
      'src/commands/reload.ts',
      'src/commands/reply.ts',
      'src/commands/restart.ts',
      'src/commands/resume.ts',
      'src/commands/revoke.ts',
      'src/commands/route.ts',
      'src/commands/send.ts',
      'src/commands/settings.ts',
      'src/commands/setup.ts',
      'src/commands/unlock.ts',
      'src/commands/up.ts',
      'src/commands/watch.ts',
      'src/commands/workflow.ts',
      'src/commands/worktree.ts',
    ]),
  },
];

/**
 * Paths eligible for the `routine` lane when no file in the diff triggers `CAREFUL_RULES`.
 * Any path that does not match one of these patterns is treated as unmatched and defaults
 * fail-closed to `careful`. A file these patterns match is still `careful` when it can reach an
 * admission module (see `admissionReachers`), so a directory entry covers only its modules
 * outside the admission graph; `verifyLaneRulesAgainstTree()` refuses an entry whose every file
 * is in that graph.
 *
 * Every individual pattern here is verified against `git ls-files` by `verifyLaneRulesAgainstTree()`.
 */
export const ROUTINE_ALLOWLIST: readonly LaneRule[] = [
  {
    name: 'docs-and-examples-trees',
    patterns: dirPrefixes(['docs', 'examples']),
  },
  {
    name: 'top-level-docs',
    patterns: exactFiles([
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'REVIEW.md',
      'SECURITY.md',
      'npm-readme.md',
      'UPGRADE-0.3.md',
      'UPGRADE-0.5.md',
      'UPGRADE-0.5.5.md',
      'LICENSE',
    ]),
  },
  {
    name: 'non-heavy-test-files',
    patterns: [
      /^test\/(?!broker\.test\.ts$|broker-run\.ts$|exit-codes\.test\.ts$|exit-filter(\.test)?\.ts$|helpers\.ts$|fixtures\/).+\.(ts|py|md|txt|yaml|json)$/,
    ],
  },
  {
    name: 'routine-leaf-src-files',
    patterns: exactFiles([
      'src/ansi.ts',
      'src/clis.ts',
      'src/held.ts',
      'src/idle_work.ts',
      'src/io.ts',
      'src/queues.ts',
      'src/run-memo.ts',
      'src/version.ts',
      'src/wait.ts',
      'src/yaml.ts',
    ]),
  },
  {
    name: 'routine-leaf-src-dirs',
    patterns: dirPrefixes([
      'src/budgets',
      'src/charter',
      'src/end',
      'src/handover',
      'src/information',
      'src/output',
      'src/reminder',
      'src/seat-health',
      'src/tasks',
    ]),
  },
];

/**
 * The modules that make an admission decision: who the caller is, whether a signature holds,
 * whether a delegation or grant applies, and what credentials this machine can reach. A source
 * file that imports one of these at runtime — directly or through other source modules — can
 * change an admission answer, so it takes the careful lane whatever its path looks like.
 *
 * The graph is read from the checkout being classified (the files are the change under test),
 * but the reading is done by this script, which CI takes from the base revision; a pull request
 * cannot widen its own lane by editing a helper this script imports.
 */
export const ADMISSION_MODULES: readonly string[] = [
  'src/caller.ts',
  'src/check/signature.ts',
  'src/file/signature.ts',
  'src/signing/owner-request.ts',
  'src/signing/owner-statement.ts',
  'src/delegate.ts',
  'src/grant.ts',
  'src/permissions/grants.ts',
  'src/profiles/credentials.ts',
];

/** A module specifier: static or dynamic import, `require`, and `export ... from`. */
const IMPORT_SPEC = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
/**
 * A string literal naming a repo source file. It catches a module spawned by path
 * (`src/cli.ts`) and a file read by name, the same way the test selector's graph does.
 */
const PATH_LITERAL = /['"`]((?:\.{1,2}\/)*(?:src|test|scripts|packages)\/[\w./-]+\.(?:ts|mts|js|mjs))['"`]/g;

const SOURCE_FILE = /\.(?:ts|mts|js|mjs)$/;

/**
 * Whether a line opens an import/export that exists only for the type checker. A type alias
 * (`export type Name = ...`) is not a statement about another module and stays scanned.
 */
function opensTypeOnlyStatement(line: string): boolean {
  return /^\s*import\s+type\b/.test(line) || /^\s*export\s+type\s*\{/.test(line);
}

/** Collects the module specifiers one line names into `specs`. */
function scanSpecs(line: string, specs: string[]): void {
  for (const re of [IMPORT_SPEC, PATH_LITERAL]) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(line)); ) if (m[1]) specs.push(m[1]);
  }
}

/** The text after the first quoted string: what a type-only statement shares its line with. */
function afterFirstQuoted(line: string): string {
  return line.replace(/^[^'"]*?['"][^'"]*['"]/, '');
}

/**
 * The module specifiers one source file names, with type-only import/export statements left
 * out: they are erased at build time and give the importer no way to run the module. A
 * statement that selects types inline (`import { type A, b }`) is a runtime import and counts,
 * and so does a runtime import sharing a line with a type-only statement.
 *
 * The scan is line by line; once a braced type-only statement is open, its continuation lines
 * are skipped until the line carrying its specifier. Only an import/export line can open a
 * statement, so a missing semicolon can never swallow a following import.
 */
function dependencySpecs(text: string): string[] {
  const specs: string[] = [];
  let inTypeOnly = false;
  for (const line of text.split('\n')) {
    if (inTypeOnly) {
      // Only the statement's own specifier line closes it here; a continuation holds member
      // names and braces, never an import.
      if (/['"]/.test(line) || /;\s*(?:\/\/.*)?$/.test(line)) {
        inTypeOnly = false;
        scanSpecs(afterFirstQuoted(line), specs);
      }
      continue;
    }
    if (opensTypeOnlyStatement(line)) {
      // `import type { A } from './a.ts'` on one line, semicolon or not.
      if (!/['"]/.test(line)) inTypeOnly = true;
      else scanSpecs(afterFirstQuoted(line), specs);
      continue;
    }
    scanSpecs(line, specs);
  }
  return specs;
}

/** Resolves a specifier the way Bun does for this repository: relative, extensionless, index. */
function resolveSpec(
  from: string,
  spec: string,
  isFile: (path: string) => boolean,
): string | undefined {
  let candidate: string;
  if (spec.startsWith('.')) candidate = normalize(join(dirname(from), spec));
  else if (/^(?:src|test|scripts|packages)\//.test(spec)) candidate = spec;
  else return undefined;
  for (const c of [candidate, `${candidate}.ts`, candidate.replace(/\.js$/, '.ts'), join(candidate, 'index.ts')]) {
    if (isFile(c)) return c;
  }
  // A root-relative literal written from inside test/ like '../src/x.ts'
  const alt = spec.replace(/^(?:\.\.\/)+/, '');
  if (alt !== spec && isFile(alt)) return alt;
  return undefined;
}

export type AdmissionGraphIo = {
  /** Reads one repository-relative source file. Defaults to the checkout at ROOT. */
  readonly read?: (file: string) => string;
  /** Whether a repository-relative path is a file. Defaults to the checkout at ROOT. */
  readonly isFile?: (file: string) => boolean;
};

/**
 * Every source file in `files` that can reach an admission module at runtime, the modules
 * themselves included. `files` are repository-relative paths (a `git ls-files` reading); only
 * `src/` modules are graphed, because only they ship.
 */
export function admissionReachers(
  files: readonly string[],
  io: AdmissionGraphIo = {},
): ReadonlySet<string> {
  const read = io.read ?? ((file: string) => readFileSync(join(ROOT, file), 'utf8'));
  const isFile =
    io.isFile ??
    ((file: string) => {
      try {
        return statSync(join(ROOT, file)).isFile();
      } catch {
        return false;
      }
    });
  const sources = new Set(files.filter((f) => f.startsWith('src/') && SOURCE_FILE.test(f)));
  const importers = new Map<string, Set<string>>();
  for (const file of sources) {
    let text: string;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const dependencies = new Set<string>();
    for (const spec of dependencySpecs(text)) {
      const dependency = resolveSpec(file, spec, isFile);
      if (dependency !== undefined && dependency !== file && sources.has(dependency)) {
        dependencies.add(dependency);
      }
    }
    for (const dependency of dependencies) {
      const up = importers.get(dependency) ?? new Set<string>();
      up.add(file);
      importers.set(dependency, up);
    }
  }

  const reached = new Set(ADMISSION_MODULES.filter((module) => sources.has(module)));
  const queue = [...reached];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const up of importers.get(current) ?? []) {
      if (reached.has(up)) continue;
      reached.add(up);
      queue.push(up);
    }
  }
  return reached;
}

let treeReachers: ReadonlySet<string> | undefined;

/** The admission graph of the checkout at ROOT, read once per run. */
function admissionReachersOfTree(): ReadonlySet<string> {
  treeReachers ??= admissionReachers(trackedTreeFiles());
  return treeReachers;
}

function matchesRuleList(rules: readonly LaneRule[], file: string): LaneRule | undefined {
  return rules.find((rule) => rule.patterns.some((re) => re.test(file)));
}

export type LaneClassifyOptions = {
  /** The source files that reach an admission module. Defaults to this checkout's graph. */
  readonly admissionReachers?: ReadonlySet<string>;
};

/**
 * Classifies a list of changed file paths into `routine` or `careful`.
 * Fail-closed: empty input, `<git diff failed>`, any careful rule match, any file that can
 * reach an admission module, or any unmatched path returns `careful`.
 */
export function classifyLane(
  changedFiles: readonly string[],
  eventName?: string,
  options: LaneClassifyOptions = {},
): LaneClassification {
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    return {
      lane: 'careful',
      reason: `event ${eventName} always runs the careful lane`,
      carefulFiles: [],
      unmatchedFiles: [],
    };
  }
  const cleaned = changedFiles.map((f) => f.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return {
      lane: 'careful',
      reason: 'empty diff defaults to careful',
      carefulFiles: [],
      unmatchedFiles: [],
    };
  }
  if (cleaned.includes('<git diff failed>')) {
    return {
      lane: 'careful',
      reason: 'git diff failed; defaulting to careful',
      carefulFiles: ['<git diff failed>'],
      unmatchedFiles: [],
    };
  }

  const carefulFiles: string[] = [];
  const unmatchedFiles: string[] = [];
  const admission = options.admissionReachers ?? admissionReachersOfTree();

  for (const file of cleaned) {
    if (matchesRuleList(CAREFUL_RULES, file) || admission.has(file)) {
      carefulFiles.push(file);
      continue;
    }
    if (!matchesRuleList(ROUTINE_ALLOWLIST, file)) {
      unmatchedFiles.push(file);
    }
  }

  if (carefulFiles.length > 0) {
    return {
      lane: 'careful',
      reason: `careful path(s) changed: ${carefulFiles.slice(0, 5).join(', ')}`,
      carefulFiles,
      unmatchedFiles,
    };
  }

  if (unmatchedFiles.length > 0) {
    return {
      lane: 'careful',
      reason: `unmatched path defaults to careful: ${unmatchedFiles.slice(0, 5).join(', ')}`,
      carefulFiles: [],
      unmatchedFiles,
    };
  }

  return {
    lane: 'routine',
    reason: `all ${cleaned.length} changed file(s) matched routine allowlist`,
    carefulFiles: [],
    unmatchedFiles: [],
  };
}

/**
 * Verifies that every individual pattern in CAREFUL_RULES and ROUTINE_ALLOWLIST matches at least
 * one real tracked file in `trackedFiles`, that no tracked file matches both CAREFUL_RULES and
 * ROUTINE_ALLOWLIST, that every routine rule still covers a file outside the admission graph,
 * and that every admission module is a tracked file.
 */
export function verifyLaneRulesAgainstTree(
  trackedFiles: readonly string[],
  reachers: ReadonlySet<string> = admissionReachers(trackedFiles),
): string[] {
  const problems: string[] = [];
  for (const rule of CAREFUL_RULES) {
    for (const pattern of rule.patterns) {
      if (!trackedFiles.some((f) => pattern.test(f))) {
        problems.push(`careful rule '${rule.name}' pattern ${pattern} matched 0 tracked files in git ls-files`);
      }
    }
  }
  for (const rule of ROUTINE_ALLOWLIST) {
    for (const pattern of rule.patterns) {
      if (!trackedFiles.some((f) => pattern.test(f))) {
        problems.push(`routine rule '${rule.name}' pattern ${pattern} matched 0 tracked files in git ls-files`);
      }
    }
    if (!trackedFiles.some((f) => rule.patterns.some((p) => p.test(f)) && !reachers.has(f))) {
      problems.push(`routine rule '${rule.name}' matches only files that reach an admission module and can never be routine`);
    }
  }
  for (const file of trackedFiles) {
    const carefulMatch = matchesRuleList(CAREFUL_RULES, file);
    const routineMatch = matchesRuleList(ROUTINE_ALLOWLIST, file);
    if (carefulMatch && routineMatch) {
      problems.push(`${file}: matched both careful rule '${carefulMatch.name}' and routine rule '${routineMatch.name}'`);
    }
  }
  for (const module of ADMISSION_MODULES) {
    if (!trackedFiles.includes(module)) {
      problems.push(`admission module '${module}' is not a tracked file in git ls-files`);
    }
  }
  return problems;
}

export function trackedTreeFiles(): string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function diffFiles(base?: string, before?: string, stdin?: boolean): string[] {
  if (stdin) {
    return readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  // `--no-renames` keeps both sides of a move in the list. With rename detection on, a move
  // from a careful path onto a routine path appears only under the routine new path.
  if (before !== undefined) {
    if (!before || /^0+$/.test(before)) return ['<git diff failed>'];
    const r = spawnSync('git', ['diff', '--name-only', '--no-renames', `${before}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return ['<git diff failed>'];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const range = `${base ?? 'origin/main'}...HEAD`;
  const r = spawnSync('git', ['diff', '--name-only', '--no-renames', range], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return ['<git diff failed>'];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * A revision CI names. It must look like a ref or a commit id and never like a git option
 * (a leading `-`) or a range (`..`), so an environment value cannot change what the diff
 * command means. Returns `undefined` when nothing was named and `null` when the value is
 * malformed; a malformed revision is a diff failure, never a fallback to another ref.
 */
function namedRef(value: string | undefined): string | undefined | null {
  if (value === undefined || value === '') return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('..') ? value : null;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const has = (k: string) => a.includes(k);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };

  if (has('--check')) {
    const tracked = trackedTreeFiles();
    const reachers = admissionReachers(tracked);
    const problems = verifyLaneRulesAgainstTree(tracked, reachers);
    if (problems.length > 0) {
      for (const p of problems) console.error(`ci:lane: ${p}`);
      process.exit(1);
    }
    const carefulCount = CAREFUL_RULES.reduce((n, r) => n + r.patterns.length, 0);
    const routineCount = ROUTINE_ALLOWLIST.reduce((n, r) => n + r.patterns.length, 0);
    const routineOverridden = tracked.filter(
      (f) => ROUTINE_ALLOWLIST.some((r) => r.patterns.some((p) => p.test(f))) && reachers.has(f),
    ).length;
    console.error(
      `ci:lane: ${carefulCount} careful patterns and ${routineCount} routine patterns verified against ${tracked.length} tracked files; ` +
        `${reachers.size} source file(s) reach an admission module and take the careful lane (${routineOverridden} of them also match a routine path)`,
    );
    process.exit(0);
  }

  // CI names the revisions in the environment. The shell never expands a ref into this argv,
  // and a value that does not look like a revision is a diff failure rather than a fallback.
  const base = namedRef(get('--base') ?? process.env.CI_LANE_BASE_REF);
  const before = namedRef(get('--before') ?? process.env.CI_LANE_BEFORE_REF);
  const event = get('--event') ?? process.env.CI_LANE_EVENT ?? process.env.GITHUB_EVENT_NAME;
  const out = get('--github-output');
  const stdin = has('--stdin');
  const positional = a.filter((x, i) => !x.startsWith('--') && !['--base', '--before', '--event', '--github-output'].includes(a[i - 1] ?? ''));

  const changed =
    positional.length > 0
      ? positional
      : base === null || before === null
        ? ['<git diff failed>']
        : diffFiles(base ?? undefined, before ?? undefined, stdin);
  const verdict = classifyLane(changed, event);
  console.error(`ci:lane: lane=${verdict.lane} (${verdict.reason})`);
  console.log(verdict.lane);
  if (out) {
    appendFileSync(out, `lane=${verdict.lane}\n`);
  }
}
