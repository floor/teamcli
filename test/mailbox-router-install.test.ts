import { describe, expect, test } from 'bun:test';
import { SHUTTLE_UNITS, retireShuttles } from '../src/daemon/mailbox/retire.ts';

describe('retiring the shuttle units', () => {
  test('a fresh heartbeat removes the three units and leaves the child up', () => {
    const asked: string[] = [];
    const result = retireShuttles({
      heartbeatFresh: true,
      retire(label) {
        asked.push(label);
        return { ok: true };
      },
    });
    expect(asked).toEqual([...SHUTTLE_UNITS]);
    expect(result).toEqual({ child: 'up', retired: [...SHUTTLE_UNITS], failed: [] });
  });

  test('without a fresh heartbeat nothing is removed', () => {
    let called = 0;
    const result = retireShuttles({
      heartbeatFresh: false,
      retire() {
        called += 1;
        return { ok: true };
      },
    });
    expect(called).toBe(0);
    expect(result).toEqual({ child: 'up', retired: [], failed: [] });
  });

  test('a failed removal is named and the child stays up', () => {
    const result = retireShuttles({
      heartbeatFresh: true,
      retire(label) {
        if (label === 'io.teamcli.atlas-shuttle') return { ok: false, why: 'the unit is still held' };
        return { ok: true };
      },
    });
    expect(result.child).toBe('up');
    expect(result.retired).toEqual(['io.teamcli.iris-shuttle', 'io.teamcli.desk-shuttle']);
    expect(result.failed).toEqual([{ label: 'io.teamcli.atlas-shuttle', why: 'the unit is still held' }]);
  });
});
