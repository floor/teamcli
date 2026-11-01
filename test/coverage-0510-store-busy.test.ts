// The run store's busy contract: a second transaction — re-entered in this process, or meeting a
// foreign holder of the store lock — is the store's own `workflow.store.busy` reading, never the
// raw lock error, and the store is usable again once the refusal is over.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockBusyError, withLock } from '../src/state.ts';
import { LiveStoreError, openRunStore } from '../src/workflow/live/store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-store-busy-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function busyOf(work: () => unknown): LiveStoreError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(LiveStoreError);
    expect(error).not.toBeInstanceOf(LockBusyError);
    return error as LiveStoreError;
  }
  throw new Error('expected the store to refuse');
}

describe('a run store that is already busy', () => {
  test('a transaction opened inside another is refused, and the store recovers', () => {
    const store = openRunStore({ root, waitMs: 0 });
    const busy = busyOf(() => store.transact(() => store.transact(() => 'inner')));
    expect(busy.code).toBe('workflow.store.busy');
    expect(busy.why).toBe('a transaction is already open in this process');
    expect(store.transact(() => 'after')).toBe('after');
  });

  test('a lock another transaction holds is the same busy reading after its wait is spent', () => {
    const store = openRunStore({ root, waitMs: 0 });
    const seen = withLock(root, () => busyOf(() => store.transact(() => 'never')));
    expect(seen.code).toBe('workflow.store.busy');
    expect(seen.why).toContain('holds');
    expect(seen.why).toContain('team.lock');
    expect(store.transact(() => 'after')).toBe('after');
  });
});
