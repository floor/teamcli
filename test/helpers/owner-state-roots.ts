// Where the owner-state resolver looks, as the test suite sets it. src/client/owner-state-roots.ts
// fixes the process's own roots and offers no way to change them; the suite's preloads replace
// that module (`installOwnerStateRootsForTests`) so its roots are the ones a scene sets here. No
// module of TeamCLI's own can do either.
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';
import * as real from '../../src/client/owner-state-roots.ts';
import type { OwnerStateRoots } from '../../src/client/owner-state-roots.ts';

/** The suite's roots: each scene keeps its owner state in the home it passes, and no scene reads
 *  the real account or the system folder. */
export const SUITE_OWNER_STATE_ROOTS: OwnerStateRoots = {
  system: null,
  account: (given) => (given === undefined ? 'none' : { home: given }),
  systemOwner: process.getuid?.() ?? 0,
};

let current: OwnerStateRoots = SUITE_OWNER_STATE_ROOTS;

/** Where the resolver looks in this scene; `null`: the suite's roots again. */
export function setOwnerStateRootsForTests(next: OwnerStateRoots | null): void {
  current = next ?? SUITE_OWNER_STATE_ROOTS;
}

/** Replaces the roots module for this process: its every export as it is, but the roots. */
export function installOwnerStateRootsForTests(): void {
  mock.module(fileURLToPath(new URL('../../src/client/owner-state-roots.ts', import.meta.url)), () => ({ ...real, ownerStateRoots: () => current }));
}
