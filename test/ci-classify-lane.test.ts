import { describe, expect, test } from 'bun:test';
import {
  CAREFUL_RULES,
  ROUTINE_ALLOWLIST,
  classifyLane,
  trackedTreeFiles,
  verifyLaneRulesAgainstTree,
} from '../scripts/ci-classify-lane.ts';

describe('ci-classify-lane real-tree verification and fail-closed classification', () => {
  test('every careful and routine rule matches real tracked files in git ls-files and none overlap', () => {
    const tracked = trackedTreeFiles();
    expect(tracked.length).toBeGreaterThan(1000);
    expect(verifyLaneRulesAgainstTree(tracked)).toEqual([]);
  });

  test('every tracked file in git ls-files is covered by either CAREFUL_RULES or ROUTINE_ALLOWLIST', () => {
    const tracked = trackedTreeFiles();
    const uncovered = tracked.filter(
      (f) =>
        !CAREFUL_RULES.some((r) => r.patterns.some((p) => p.test(f))) &&
        !ROUTINE_ALLOWLIST.some((r) => r.patterns.some((p) => p.test(f))),
    );
    expect(uncovered).toEqual([]);
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

  test('pure docs, non-heavy test files, and leaf display/status/list modules classify as routine, while mixed diffs become careful', () => {
    expect(classifyLane(['docs/team-file.md', 'README.md']).lane).toBe('routine');
    expect(classifyLane(['test/daemon-fault-diagnostic.test.ts', 'test/ci-shard-tests.test.ts']).lane).toBe('routine');
    expect(classifyLane(['src/ansi.ts', 'src/commands/status.ts', 'src/status/compare.ts']).lane).toBe('routine');

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
