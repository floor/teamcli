import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Kind = 'teams' | 'projects';
const held = new Map<string, Kind[]>();

/** All cross-registry writes take teams before projects. Nested writers may reuse a lock
 * already held by this synchronous call, but acquiring teams under projects is refused. */
export function withRegistryLock<T>(home: string, kind: Kind, work: () => T, error: (message: string) => Error = message => new Error(message)): T {
  const key = resolve(home);
  const stack = held.get(key) ?? [];
  if (stack.includes(kind)) return work();
  if (kind === 'teams' && stack.includes('projects')) throw error('registry lock order must be teams, then projects');
  const path = join(key, '.config', 'team', `${kind}.yaml.lock`);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      break;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== 'EEXIST') throw caught;
      try { if (Date.now() - statSync(path).mtimeMs > 15000) unlinkSync(path); } catch { /* another writer removed it */ }
      if (Date.now() > deadline) throw error(`${path} is held by another run`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  stack.push(kind);
  held.set(key, stack);
  try { return work(); } finally {
    stack.pop();
    if (stack.length === 0) held.delete(key);
    try { unlinkSync(path); } catch { /* already removed as stale */ }
  }
}

export function withTeamProjectsLocks<T>(home: string, work: () => T): T {
  return withRegistryLock(home, 'teams', () => withRegistryLock(home, 'projects', work));
}
