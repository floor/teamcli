// The name rule for a `team lock` lock — and every other name that becomes a path segment or a
// printed key, a `team proc` record's name included: lowercase letters, digits and hyphens,
// grouped by single hyphens, at most 64 characters. A leaf module, so `state.ts` can clean a
// key by it without reaching through the lock machinery, which reads callers and so the state.

export const LOCK_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LOCK_NAME_MAX = 64;

export function validLockName(name: string): boolean {
  return name.length <= LOCK_NAME_MAX && LOCK_NAME.test(name);
}
