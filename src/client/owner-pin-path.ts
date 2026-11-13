// Where a machine keeps the owner seat it pinned from another machine, and its own machine record.
// This module imports nothing of TeamCLI's own, so the caller placement (src/caller.ts) can ask
// whether the machine's owner signs elsewhere without loading the signing or policy code.
//
// A machine whose owner seat is pinned holds no owner signer of its own: the owner signs on the
// machine that holds one, and this machine only verifies. On such a machine a terminal is not
// the owner (src/caller.ts, `walkOutside`).

import { lstatSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** The pinned owner seat: the signed export from the machine that holds the signers. */
export function ownerSeatPinFile(home: string = homedir()): string {
  return join(home, '.config', 'team', 'owner-seat-pin.json');
}

/** This machine's record: a random id made when the owner seat is pinned, and a display name. */
export function machineFile(home: string = homedir()): string {
  return join(home, '.config', 'team', 'machine.json');
}

/**
 * Whether anything stands at the pin's path in `home`. Anything does: a file that does not verify,
 * a link, a folder, or an entry this process may not read all count as pinned, so damaging the
 * pin never turns a terminal back into the owner. Only a path that names nothing is unpinned.
 */
export function ownerPinPresent(home: string): boolean {
  try {
    lstatSync(ownerSeatPinFile(home));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/**
 * Whether this account's owner seat is pinned from another machine. Both homes are asked: the one
 * the environment names and the account's own home from the user database, which no variable
 * moves, so a process cannot step outside the pin by pointing its home elsewhere.
 */
export function ownerSignsElsewhereOnThisAccount(): boolean {
  const homes = new Set<string>([homedir()]);
  try {
    homes.add(userInfo().homedir);
  } catch {
    // An account the user database does not answer for keeps the environment's home only.
  }
  for (const home of homes) {
    if (ownerPinPresent(home)) return true;
  }
  return false;
}
