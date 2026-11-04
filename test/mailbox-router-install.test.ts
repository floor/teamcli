import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mailboxHeartbeatFresh, SHUTTLE_UNITS, retireShuttles } from '../src/daemon/mailbox/retire.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { writeDaemonState } from '../src/daemon/state.ts';

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

describe('the router heartbeat the install reads', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function record(home: string, heartbeatAt: string | null | undefined): void {
    writeDaemonState(home, {
      format: 1,
      pid: 1,
      uid: 1,
      since: '2026-11-04T02:00:00.000Z',
      startedBy: 'manual',
      version: 'test',
      heartbeatAt: '2026-11-04T02:00:00.000Z',
      socket: daemonSocketPath(home),
      features: { broker: 'absent' },
      stuck: [],
      roots: [],
      ...(heartbeatAt === undefined ? {} : { mailbox: { heartbeatAt } }),
    });
  }

  test('a recorded heartbeat is fresh and a record without one is not', () => {
    const home = mkdtempSync(join(tmpdir(), 'mailbox-retire-'));
    homes.push(home);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, undefined);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, null);
    expect(mailboxHeartbeatFresh(home)).toBe(false);
    record(home, '2026-11-04T02:00:00.000Z');
    expect(mailboxHeartbeatFresh(home)).toBe(true);
  });
});
