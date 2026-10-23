import { describe, expect, test } from 'bun:test';
import {
  PROVISIONAL_GUARDS,
  PROVISIONAL_OPERATIONS,
  provisionalResolvers,
} from '../../src/workflow/registry.ts';

describe('the provisional role resolver', () => {
  test('names owner, the base roles, the daemon and the round roles, then the supplied team roles', () => {
    const resolvers = provisionalResolvers(['operator', 'builder']);
    expect(resolvers.roles.resolve('owner')).toBe('owner');
    expect(resolvers.roles.resolve('builder')).toBe('base-role');
    expect(resolvers.roles.resolve('tester')).toBe('base-role');
    expect(resolvers.roles.resolve('daemon')).toBe('daemon');
    expect(resolvers.roles.resolve('lead')).toBe('round-role');
    expect(resolvers.roles.resolve('integrator')).toBe('round-role');
    expect(resolvers.roles.resolve('operator')).toBe('team-role');
    expect(resolvers.roles.resolve('archivist')).toBeUndefined();
  });

  test('the base roles and the daemon resolve without a team file', () => {
    const resolvers = provisionalResolvers();
    expect(resolvers.roles.resolve('builder')).toBe('base-role');
    expect(resolvers.roles.resolve('tester')).toBe('base-role');
    expect(resolvers.roles.resolve('daemon')).toBe('daemon');
    expect(resolvers.roles.resolve('operator')).toBeUndefined();
  });
});

describe('the provisional operation catalogue', () => {
  test('is the twelve sketch names and the dispatch action, every one provisional', () => {
    expect([...PROVISIONAL_OPERATIONS].sort()).toEqual(
      [
        'changelog-stamp',
        'dispatch',
        'goals-session',
        'merge-verify',
        'release-gate',
        'release-notes',
        'release-publish',
        'release-tag',
        'review-morning',
        'round-close-hold',
        'round-open',
        'site-deploy',
        'size-refresh',
      ].sort(),
    );
    const resolvers = provisionalResolvers();
    for (const name of PROVISIONAL_OPERATIONS) {
      expect(resolvers.operations.descriptor(name)?.provisional).toBe(true);
    }
  });

  test('the outside-machine three carry their confirmation class and act-as shape', () => {
    const resolvers = provisionalResolvers();
    for (const name of ['release-tag', 'release-publish', 'site-deploy']) {
      const descriptor = resolvers.operations.descriptor(name);
      expect(descriptor?.reach).toBe('outside-machine');
      expect(descriptor?.confirmationClass).toBe('owner');
    }
    expect(resolvers.operations.descriptor('release-tag')?.capabilities).toEqual([]);
    expect(resolvers.operations.descriptor('release-publish')?.capabilities).toEqual(['deploy']);
  });

  test('dispatch carries the workflow MVP descriptor', () => {
    expect(provisionalResolvers().operations.descriptor('dispatch')).toEqual({
      kernelOperation: 'dispatch',
      capabilities: ['write'],
      scopes: ['run'],
      confirmationClass: 'none',
      reach: 'local',
      provisional: true,
    });
  });

  test('an unknown operation resolves to nothing', () => {
    expect(provisionalResolvers().operations.descriptor('tag')).toBeUndefined();
  });
});

describe('the provisional guard catalogue', () => {
  test('is the three v1 names and the three workflow MVP evidence guards', () => {
    expect([...PROVISIONAL_GUARDS].sort()).toEqual(
      [
        'ci-green-on-head',
        'install-matches-merge',
        'merge-matches-request',
        'registry-shows-version',
        'round-complete-or-held',
        'tested-head-equals-built',
      ].sort(),
    );
  });

  test('the workflow MVP guards read the seam table selectors', () => {
    const resolvers = provisionalResolvers();
    expect(resolvers.guards.guard('tested-head-equals-built')?.reads).toEqual({ type: 'step' });
    expect(resolvers.guards.guard('merge-matches-request')?.reads).toEqual({
      type: 'outcome',
      operation: 'merge',
      result: 'done',
    });
    expect(resolvers.guards.guard('install-matches-merge')?.reads).toEqual({
      type: 'outcome',
      operation: 'install',
      result: 'done',
    });
  });

  test('outcome guards read their one record and require done', () => {
    const resolvers = provisionalResolvers();
    const guard = resolvers.guards.guard('ci-green-on-head');
    expect(guard?.reads).toEqual({ type: 'outcome', operation: 'ci-suite' });
    const scope = { target: 'head-1', artifact: { kind: 'none' } as const };
    expect(guard?.evaluate({ type: 'outcome', operation: 'ci-suite', result: 'done' }, scope)).toEqual({
      ok: true,
    });
    expect(
      guard?.evaluate({ type: 'outcome', operation: 'ci-suite', result: 'refused' }, scope),
    ).toMatchObject({ ok: false });
  });

  test('the round guard reads the child completion record or its hold', () => {
    const guard = provisionalResolvers().guards.guard('round-complete-or-held');
    expect(guard?.reads).toEqual({ type: 'child-completion' });
    const scope = { target: 'run-1', artifact: { kind: 'tree', value: 't' } as const };
    expect(guard?.evaluate({ type: 'child-completion', status: 'completed' }, scope)).toEqual({ ok: true });
    expect(guard?.evaluate({ type: 'child-completion', status: 'held' }, scope)).toEqual({ ok: true });
    expect(guard?.evaluate({ type: 'child-completion' }, scope)).toMatchObject({ ok: false });
  });

  test('an unknown guard resolves to nothing', () => {
    expect(provisionalResolvers().guards.guard('tests-green')).toBeUndefined();
  });
});

describe('the event-kind seam', () => {
  test('wraps the closed bus table, including the four post-0.5.1 additions', () => {
    const resolvers = provisionalResolvers();
    expect(resolvers.eventKinds.has('release.ready')).toBe(true);
    expect(resolvers.eventKinds.has('presence.changed')).toBe(true);
    // draft 6 §12 proposes this kind as a spec change; it must not be silently present.
    expect(resolvers.eventKinds.has('release.published')).toBe(false);
  });
});
