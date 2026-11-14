// Where a machine keeps the owner seat it pinned from another machine, its own machine record, and
// the ledger that spends each carried approval once: one resolver for all three. It imports nothing
// of TeamCLI's own, so the caller placement (src/caller.ts) can ask whether the machine's owner
// signs elsewhere without loading the signing or policy code.
//
// The resolver never reads the environment's home. It reads, in order:
//   1. a system folder (`/etc/teamcli`), when it is present: it must be a folder owned by the
//      system's administrator and writable by no one else, and so must every entry it holds. A
//      system folder that holds any of the three is the machine's owner state; a later step keeps
//      them there, out of the account's reach.
//   2. the account's own home, from the user database: `~/.config/team`. An account whose home
//      the user database does not answer is refused, since its pin could be there.
// A machine that has ever been pinned keeps at least one of the three entries. Anything at one of
// those paths counts — a file that does not verify, a link, a folder — and any state the resolver
// cannot read (a parent that is not a folder, an entry it may not read, an unprotected system
// folder) is `refused`: the machine is treated as pinned, its terminal is not the owner, and no
// answer is accepted. Only paths that name nothing at all read as never pinned.
//
// A machine whose owner seat is pinned holds no owner signer: the owner signs on the machine that
// holds one, and this machine only verifies.

import { lstatSync, type Stats } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/** The account home the resolver reads: a home, no account at all (a test scene that names none),
 *  or an account whose home the user database does not answer — which refuses, never unpins. */
export type AccountHome = { home: string } | 'none' | 'unresolved';

/** Where the resolver looks. `account` maps the home a caller passed (if any) to the account home
 *  it reads; production ignores what was passed. */
export type OwnerStateRoots = {
  system: string | null;
  account: (given: string | undefined) => AccountHome;
  /** The uid that must own the system folder and every entry in it. */
  systemOwner: number;
};

/** The account's home from the user database, which no variable moves; null when it does not answer. */
export function accountHome(): string | null {
  try {
    const home = userInfo().homedir;
    return typeof home === 'string' && home !== '' ? home : null;
  } catch {
    return null;
  }
}

const PRODUCTION_ROOTS: OwnerStateRoots = {
  system: '/etc/teamcli',
  account: () => {
    const home = accountHome();
    return home === null ? 'unresolved' : { home };
  },
  systemOwner: 0,
};
let roots: OwnerStateRoots = PRODUCTION_ROOTS;

/**
 * Replaces where the resolver looks, for the test suite only: its preload points the account at
 * the home each scene passes and reads no system folder, so no scene ever reads the real account.
 * `null` restores the process's own roots. No command line, variable or file reaches this.
 */
export function ownerStateRootsForTests(next: OwnerStateRoots | null): void {
  roots = next ?? PRODUCTION_ROOTS;
}

const PIN = 'owner-seat-pin.json';
const MACHINE = 'machine.json';
const LEDGER = 'owner-ledger';

/** One place the owner state lives: the system folder or the account's config folder. */
export type OwnerStatePlace = { kind: 'system' | 'account'; dir: string; pin: string; machine: string; ledger: string };

export type OwnerStateRead =
  /** Never pinned: nothing at any of the paths. `write` is where a first pin goes (null: a test
   *  scene that names no account). */
  | { kind: 'none'; write: OwnerStatePlace | null }
  /** Pinned, or pinned once: at least one entry stands here. */
  | { kind: 'present'; place: OwnerStatePlace }
  /** A state the resolver cannot read or trust: treated as pinned, and nothing is accepted. */
  | { kind: 'refused'; why: string };

function placeAt(kind: OwnerStatePlace['kind'], dir: string): OwnerStatePlace {
  return { kind, dir, pin: join(dir, PIN), machine: join(dir, MACHINE), ledger: join(dir, LEDGER) };
}

/** The account place for an account home: `~/.config/team`. */
export function accountPlace(home: string): OwnerStatePlace {
  return placeAt('account', join(home, '.config', 'team'));
}

type Probe = { kind: 'absent' } | { kind: 'present'; stat: Stats } | { kind: 'refused' };

function probe(path: string): Probe {
  try {
    return { kind: 'present', stat: lstatSync(path) };
  } catch (error) {
    // Only a path that names nothing reads as absent. A parent that is not a folder (ENOTDIR), an
    // entry this process may not read, a loop: all refuse.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'refused' };
  }
}

function protectedBy(stat: Stats, owner: number): boolean {
  return stat.uid === owner && (stat.mode & 0o022) === 0;
}

function systemState(dir: string, owner: number): OwnerStateRead | null {
  const folder = probe(dir);
  if (folder.kind === 'absent') return null;
  if (folder.kind === 'refused') return { kind: 'refused', why: 'the system owner folder cannot be read' };
  if (!folder.stat.isDirectory() || !protectedBy(folder.stat, owner)) return { kind: 'refused', why: 'the system owner folder is not a folder only its administrator can write' };
  const place = placeAt('system', dir);
  let any = false;
  for (const [path, folderEntry] of [[place.pin, false], [place.machine, false], [place.ledger, true]] as const) {
    const entry = probe(path);
    if (entry.kind === 'absent') continue;
    if (entry.kind === 'refused') return { kind: 'refused', why: 'an entry of the system owner folder cannot be read' };
    const shaped = folderEntry ? entry.stat.isDirectory() : entry.stat.isFile();
    if (!shaped || !protectedBy(entry.stat, owner)) return { kind: 'refused', why: 'an entry of the system owner folder is not one only its administrator can write' };
    any = true;
  }
  return any ? { kind: 'present', place } : null;
}

/**
 * The machine's owner state, from the one resolver. `given` is the home the caller works in; the
 * process's own roots ignore it, so pointing a command at another home never changes the answer.
 */
export function ownerStateOf(given?: string): OwnerStateRead {
  if (roots.system !== null) {
    const system = systemState(roots.system, roots.systemOwner);
    if (system !== null) return system;
  }
  const account = roots.account(given);
  if (account === 'none') return { kind: 'none', write: null };
  // An account whose home cannot be found may hold a pin the resolver cannot see: refused.
  if (account === 'unresolved') return { kind: 'refused', why: "this account's home cannot be read from the user database" };
  const place = accountPlace(account.home);
  let any = false;
  for (const path of [place.pin, place.machine, place.ledger]) {
    const entry = probe(path);
    if (entry.kind === 'refused') return { kind: 'refused', why: "this machine's owner state cannot be read" };
    if (entry.kind === 'present') any = true;
  }
  return any ? { kind: 'present', place } : { kind: 'none', write: place };
}

/** Whether this machine's owner signs on another machine: pinned, pinned once, or in a state that cannot be read. */
export function ownerMachinePinned(given?: string): boolean {
  return ownerStateOf(given).kind !== 'none';
}

/** The pin's path in an account home (`~/.config/team/owner-seat-pin.json`), for readers that name it. */
export function ownerSeatPinFile(home: string = homedir()): string {
  return accountPlace(home).pin;
}

/** The machine record's path in an account home (`~/.config/team/machine.json`). */
export function machineFile(home: string = homedir()): string {
  return accountPlace(home).machine;
}

/**
 * Whether this account's owner seat is pinned from another machine, for the caller placement:
 * the same resolver, with no home passed.
 */
export function ownerSignsElsewhereOnThisAccount(): boolean {
  return ownerMachinePinned(undefined);
}
