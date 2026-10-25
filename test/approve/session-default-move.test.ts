// The default session moved to <entity>-<project>: a team approved under the old default (the
// project name alone) is told the old and the new session and that it must approve again.
import { describe as group, expect, test } from 'bun:test';
import { compare, describe, fingerprints, type Approvable } from '../../src/approve/fingerprint.ts';

const team = (fields: Record<string, unknown>): Approvable => ({ project: 'web', seats: [], ...fields });

group('the session default move', () => {
  test('an entity team approved under the project name is told old -> new and to approve again', () => {
    const approved = fingerprints(team({ entity: 'acme', session: 'web' }));
    const current = team({ entity: 'acme', session: 'acme-web' });
    const lines = compare(approved, fingerprints(current), current).map(describe);
    expect(lines).toContain('`session` changed: "web" -> "acme-web", the new default session (<entity>-<project>); approve the file again, or set `session: web` to keep the old one');
  });

  test('any other session change reads as before', () => {
    const approved = fingerprints(team({ entity: 'acme', session: 'old' }));
    const current = team({ entity: 'acme', session: 'acme-web' });
    expect(compare(approved, fingerprints(current), current).map(describe)).toContain('`session` changed');
  });

  test('a team without an entity, or without the team passed in, keeps the plain line', () => {
    const approved = fingerprints(team({ session: 'web' }));
    const current = team({ session: 'other' });
    expect(compare(approved, fingerprints(current), current).map(describe)).toContain('`session` changed');
    const moved = team({ entity: 'acme', session: 'acme-web' });
    expect(compare(fingerprints(team({ entity: 'acme', session: 'web' })), fingerprints(moved)).map(describe)).toContain('`session` changed');
  });
});
