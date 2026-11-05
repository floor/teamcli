#!/usr/bin/env bun
// Classifies a diff into `routine` or `careful` for CI lane selection.
//
// Fail-closed contract:
//  - Every individual pattern in CAREFUL_RULES and ROUTINE_ALLOWLIST is verified against tracked
//    files in the real git tree (`bun scripts/ci-classify-lane.ts --check`).
//  - `schedule` and `workflow_dispatch` events, empty diffs, and diff failures are always `careful`.
//  - Any file matching CAREFUL_RULES is `careful`.
//  - Any unmatched path (not matched by ROUTINE_ALLOWLIST) defaults to `careful`, never `routine`.
//  - Only a non-empty diff where EVERY changed file matches ROUTINE_ALLOWLIST and NONE matches
//    CAREFUL_RULES classifies as `routine`.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

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
 * broker, bus, launch/herdr, send/mcp, registry, permissions/policy/grants/approvals, watch,
 * workflow, worktree, and their corresponding command entrypoints.
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
      'src/lobby',
      'src/lock',
      'src/mcp',
      'src/permissions',
      'src/policy',
      'src/profiles',
      'src/registry',
      'src/release',
      'src/security',
      'src/send',
      'src/settings',
      'src/signing',
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
 * fail-closed to `careful`.
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
      'src/args.ts',
      'src/clis.ts',
      'src/held.ts',
      'src/idle_work.ts',
      'src/io.ts',
      'src/log.ts',
      'src/queues.ts',
      'src/run-memo.ts',
      'src/seat-names.ts',
      'src/session-names.ts',
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
      'src/checkpoint',
      'src/end',
      'src/handover',
      'src/information',
      'src/labels',
      'src/list',
      'src/output',
      'src/pause',
      'src/reach',
      'src/reminder',
      'src/seat-health',
      'src/sessions',
      'src/status',
      'src/swap',
      'src/tasks',
    ]),
  },
  {
    name: 'routine-leaf-commands',
    patterns: exactFiles([
      'src/commands/add.ts',
      'src/commands/answer.ts',
      'src/commands/archive.ts',
      'src/commands/ask-show.ts',
      'src/commands/batch.ts',
      'src/commands/brief.ts',
      'src/commands/checkpoint.ts',
      'src/commands/commits.ts',
      'src/commands/doctor.ts',
      'src/commands/drops.ts',
      'src/commands/feed.ts',
      'src/commands/forget.ts',
      'src/commands/hold.ts',
      'src/commands/import.ts',
      'src/commands/issues.ts',
      'src/commands/list.ts',
      'src/commands/messages.ts',
      'src/commands/next.ts',
      'src/commands/order.ts',
      'src/commands/pause.ts',
      'src/commands/peek.ts',
      'src/commands/plan.ts',
      'src/commands/pr.ts',
      'src/commands/proc.ts',
      'src/commands/projects.ts',
      'src/commands/queue.ts',
      'src/commands/raise.ts',
      'src/commands/remove.ts',
      'src/commands/rename.ts',
      'src/commands/seat.ts',
      'src/commands/seats.ts',
      'src/commands/sessions.ts',
      'src/commands/show.ts',
      'src/commands/status.ts',
      'src/commands/swap.ts',
      'src/commands/tempo.ts',
      'src/commands/trace.ts',
      'src/commands/usage.ts',
      'src/commands/waits.ts',
    ]),
  },
];

function matchesRuleList(rules: readonly LaneRule[], file: string): LaneRule | undefined {
  return rules.find((rule) => rule.patterns.some((re) => re.test(file)));
}

/**
 * Classifies a list of changed file paths into `routine` or `careful`.
 * Fail-closed: empty input, `<git diff failed>`, any careful rule match, or any unmatched path
 * returns `careful`.
 */
export function classifyLane(changedFiles: readonly string[], eventName?: string): LaneClassification {
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

  for (const file of cleaned) {
    if (matchesRuleList(CAREFUL_RULES, file)) {
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
 * one real tracked file in `trackedFiles`, and that no tracked file matches both CAREFUL_RULES
 * and ROUTINE_ALLOWLIST.
 */
export function verifyLaneRulesAgainstTree(trackedFiles: readonly string[]): string[] {
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
  }
  for (const file of trackedFiles) {
    const carefulMatch = matchesRuleList(CAREFUL_RULES, file);
    const routineMatch = matchesRuleList(ROUTINE_ALLOWLIST, file);
    if (carefulMatch && routineMatch) {
      problems.push(`${file}: matched both careful rule '${carefulMatch.name}' and routine rule '${routineMatch.name}'`);
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
  if (before !== undefined) {
    if (!before || /^0+$/.test(before)) return ['<git diff failed>'];
    const r = spawnSync('git', ['diff', '--name-only', `${before}..HEAD`], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) return ['<git diff failed>'];
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const range = `${base ?? 'origin/main'}...HEAD`;
  const r = spawnSync('git', ['diff', '--name-only', range], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return ['<git diff failed>'];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
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
    const problems = verifyLaneRulesAgainstTree(tracked);
    if (problems.length > 0) {
      for (const p of problems) console.error(`ci:lane: ${p}`);
      process.exit(1);
    }
    const carefulCount = CAREFUL_RULES.reduce((n, r) => n + r.patterns.length, 0);
    const routineCount = ROUTINE_ALLOWLIST.reduce((n, r) => n + r.patterns.length, 0);
    console.error(`ci:lane: ${carefulCount} careful patterns and ${routineCount} routine patterns verified against ${tracked.length} tracked files`);
    process.exit(0);
  }

  const base = get('--base');
  const before = get('--before');
  const event = get('--event') ?? process.env.GITHUB_EVENT_NAME;
  const out = get('--github-output');
  const stdin = has('--stdin');
  const positional = a.filter((x, i) => !x.startsWith('--') && !['--base', '--before', '--event', '--github-output'].includes(a[i - 1] ?? ''));

  const changed = positional.length > 0 ? positional : diffFiles(base, before, stdin);
  const verdict = classifyLane(changed, event);
  console.error(`ci:lane: lane=${verdict.lane} (${verdict.reason})`);
  console.log(verdict.lane);
  if (out) {
    appendFileSync(out, `lane=${verdict.lane}\n`);
  }
}
