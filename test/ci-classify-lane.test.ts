import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ADMISSION_MODULES,
  CAREFUL_RULES,
  ROUTINE_ALLOWLIST,
  admissionReachers,
  classifyLane,
  trackedTreeFiles,
  verifyLaneRulesAgainstTree,
} from '../scripts/ci-classify-lane.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function sceneRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ci-lane-classifier-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function write(cwd: string, path: string, text: string): void {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
}

function commit(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD').trim();
}

/**
 * Runs the classifier this checkout carries inside a throwaway repository of its own: ROOT is
 * the copy's parent, so it diffs and reads that fixture and nothing else. The environment
 * carries no CI_LANE_* variable unless the scene sets one.
 */
function runClassifier(cwd: string, args: readonly string[], env: Record<string, string> = {}) {
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(
    join(cwd, 'scripts', 'ci-classify-lane.ts'),
    readFileSync(join(import.meta.dir, '..', 'scripts', 'ci-classify-lane.ts')),
  );
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CI_LANE_') && key !== 'GITHUB_EVENT_NAME'),
  );
  return spawnSync('bun', [join(cwd, 'scripts', 'ci-classify-lane.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
}

describe('ci-classify-lane real-tree verification and fail-closed classification', () => {
  test('every careful and routine rule matches real tracked files in git ls-files and none overlap', () => {
    const tracked = trackedTreeFiles();
    expect(tracked.length).toBeGreaterThan(1000);
    expect(verifyLaneRulesAgainstTree(tracked)).toEqual([]);
  });

  test('every tracked file in git ls-files is matched by a rule or reaches an admission module', () => {
    const tracked = trackedTreeFiles();
    const reachers = admissionReachers(tracked);
    const uncovered = tracked.filter(
      (f) =>
        !CAREFUL_RULES.some((r) => r.patterns.some((p) => p.test(f))) &&
        !ROUTINE_ALLOWLIST.some((r) => r.patterns.some((p) => p.test(f))) &&
        !reachers.has(f),
    );
    expect(uncovered).toEqual([]);
  });

  test('an admission module and every source file that imports it are careful, whatever their path', () => {
    const tracked = trackedTreeFiles();
    const reachers = admissionReachers(tracked);
    for (const module of ADMISSION_MODULES) expect(reachers.has(module)).toBe(true);
    // A command on a routine-looking path reaches the caller module, so it is careful.
    expect(reachers.has('src/commands/status.ts')).toBe(true);
    expect(classifyLane(['src/commands/status.ts'], undefined, { admissionReachers: reachers }).lane).toBe('careful');
    // A leaf that reaches nothing takes the routine lane.
    expect(reachers.has('src/ansi.ts')).toBe(false);
    expect(classifyLane(['src/ansi.ts'], undefined, { admissionReachers: reachers }).lane).toBe('routine');
  });

  test('the graph follows runtime imports only: type-only statements and unrelated modules are not edges', () => {
    const files: Record<string, string> = {
      'src/caller.ts': 'export const caller = 1;\n',
      'src/grant.ts': 'export const grant = 1;\n',
      'src/plain.ts': "import { join } from 'node:path';\nexport const plain = join('a', 'b');\n",
      'src/direct.ts': "import { caller } from './caller.ts';\nexport const direct = caller;\n",
      'src/chain.ts': "import { direct } from './direct.ts';\nexport const chain = direct;\n",
      'src/type-only.ts': "import type { caller } from './caller.ts';\nexport type C = typeof caller;\n",
      'src/multi-line-type.ts': "import type {\n  caller,\n} from './caller.ts';\nexport type C = typeof caller;\n",
      'src/inline-type.ts': "import { type caller, other } from './grant.ts';\nexport const x = other;\n",
      'src/type-alias-then-import.ts': "export type Mode = 'a' | 'b';\nimport { grant } from './grant.ts';\nexport const mode: Mode = 'a';\n",
      'src/named-path.ts': "export const modulePath = 'src/caller.ts';\n",
      'src/dynamic.ts': "export const load = () => import('./caller.ts');\n",
      'src/unrelated.ts': "import { plain } from './plain.ts';\nexport const u = plain;\n",
      'src/shared-line.ts': "import type { caller } from './caller.ts'; import { grant } from './grant.ts';\n",
      'src/shared-closing-line.ts': "import type {\n  caller,\n} from './caller.ts'; import { grant } from './grant.ts';\n",
    };
    const names = Object.keys(files).sort();
    const reachers = admissionReachers(names, {
      read: (file) => files[file] ?? '',
      isFile: (file) => file in files,
    });
    expect([...reachers].sort()).toEqual([
      'src/caller.ts',
      'src/chain.ts',
      'src/direct.ts',
      'src/dynamic.ts',
      'src/grant.ts',
      'src/inline-type.ts',
      'src/named-path.ts',
      'src/shared-closing-line.ts',
      'src/shared-line.ts',
      'src/type-alias-then-import.ts',
    ]);
  });

  test('unmatched paths, empty diffs, diff errors, and schedule/workflow_dispatch default to careful, never routine', () => {
    expect(classifyLane([]).lane).toBe('careful');
    expect(classifyLane(['<git diff failed>']).lane).toBe('careful');
    expect(classifyLane(['docs/team-file.md'], 'schedule').lane).toBe('careful');
    expect(classifyLane(['docs/team-file.md'], 'workflow_dispatch').lane).toBe('careful');

    for (const unknown of [
      'src/new-subsystem/index.ts',
      'src/commands/new-command.ts',
      'unknown-root-file.txt',
      '.env',
      'Makefile',
      'tools/custom.sh',
    ]) {
      const res = classifyLane([unknown]);
      expect(res.lane).toBe('careful');
      expect(res.unmatchedFiles).toEqual([unknown]);
    }
  });

  test('high-risk authority, daemon, broker, bus, send, launch, state, and CI paths classify as careful', () => {
    for (const carefulPath of [
      '.github/workflows/ci.yml',
      'package.json',
      'bun.lock',
      'schema/team.schema.json',
      'contract/cli.json',
      'scripts/pack.ts',
      'src/state.ts',
      'src/caller.ts',
      'src/herdr.ts',
      'src/broker/server.ts',
      'src/bus/server.ts',
      'src/daemon/host.ts',
      'src/launch/session.ts',
      'src/send/native.ts',
      'src/signing/ed25519.ts',
      'src/status/native-observation.ts',
      'src/watch/loop.ts',
      'src/commands/up.ts',
      'src/commands/send.ts',
      'test/broker.test.ts',
      'test/exit-codes.test.ts',
      'test/helpers.ts',
    ]) {
      const res = classifyLane([carefulPath]);
      expect(res.lane).toBe('careful');
      expect(res.carefulFiles).toEqual([carefulPath]);
    }
  });

  test('pure docs, non-heavy test files, and leaf modules outside the admission graph classify as routine, while mixed diffs become careful', () => {
    expect(classifyLane(['docs/team-file.md', 'README.md']).lane).toBe('routine');
    expect(classifyLane(['test/daemon-fault-diagnostic.test.ts', 'test/ci-shard-tests.test.ts']).lane).toBe('routine');
    expect(classifyLane(['src/ansi.ts', 'src/yaml.ts', 'src/held.ts']).lane).toBe('routine');

    // Mixed routine + careful -> careful
    const mixedCareful = classifyLane(['docs/team-file.md', 'src/daemon/host.ts']);
    expect(mixedCareful.lane).toBe('careful');
    expect(mixedCareful.carefulFiles).toEqual(['src/daemon/host.ts']);

    // Mixed routine + unmatched -> careful
    const mixedUnmatched = classifyLane(['docs/team-file.md', 'src/unrecognized-module.ts']);
    expect(mixedUnmatched.lane).toBe('careful');
    expect(mixedUnmatched.unmatchedFiles).toEqual(['src/unrecognized-module.ts']);
  });
});

describe('ci-classify-lane reads the diff from the revision CI names, never from a shell expansion', () => {
  test('a rename from a careful path onto a routine path is careful: the old path counts', () => {
    const dir = sceneRepo();
    try {
      write(dir, 'README.md', '# fixture\n');
      write(dir, 'src/caller.ts', 'export const caller = 1;\n');
      const base = commit(dir, 'base');
      git(dir, 'mv', 'src/caller.ts', 'src/yaml.ts');
      commit(dir, 'move the caller module onto a routine path');
      const res = runClassifier(dir, ['--before', base]);
      expect(res.status).toBe(0);
      // The new path alone is a routine leaf; the removal of src/caller.ts must make it careful.
      expect(res.stdout.trim()).toBe('careful');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the base and before revisions arrive through the environment, unexpanded, and need no origin/main', () => {
    const dir = sceneRepo();
    try {
      write(dir, 'README.md', 'one\n');
      write(dir, 'src/ansi.ts', 'export const a = 1;\n');
      const base = commit(dir, 'base');
      git(dir, 'branch', 'base-snapshot', base);
      write(dir, 'README.md', 'two\n');
      commit(dir, 'a docs-only change');
      // Pull request job: the base ref is named, not assembled by the shell.
      const pull = runClassifier(dir, ['--event', 'pull_request'], { CI_LANE_BASE_REF: 'base-snapshot' });
      expect(pull.status).toBe(0);
      expect(pull.stdout.trim()).toBe('routine');
      // Push job: the revision before the push is named the same way.
      const push = runClassifier(dir, [], { CI_LANE_EVENT: 'push', CI_LANE_BEFORE_REF: base });
      expect(push.status).toBe(0);
      expect(push.stdout.trim()).toBe('routine');
      // A ref that does not resolve stays fail-closed.
      const missing = runClassifier(dir, ['--event', 'pull_request'], { CI_LANE_BASE_REF: 'origin/missing' });
      expect(missing.status).toBe(0);
      expect(missing.stdout.trim()).toBe('careful');
      // A value that could be read as a git option is a diff failure, never a fallback.
      const malformed = runClassifier(dir, [], { CI_LANE_BASE_REF: '--output=/tmp/lane' });
      expect(malformed.status).toBe(0);
      expect(malformed.stdout.trim()).toBe('careful');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the classifier imports node builtins only, so a base-revision copy runs in any checkout', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'scripts', 'ci-classify-lane.ts'), 'utf8');
    const imports = [...source.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
      .filter((spec): spec is string => spec !== undefined && !spec.startsWith('node:'));
    expect(imports).toEqual([]);
  });
});
