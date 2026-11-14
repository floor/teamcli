// Where a machine keeps the owner seat it pinned from another machine, its own machine record, and
// the ledger that spends each carried approval once: one resolver for all three. It imports nothing
// of TeamCLI's own, so the caller placement (src/caller.ts) can ask whether the machine's owner
// signs elsewhere without loading the signing or policy code.
//
// The resolver never reads the environment's home. On macOS (and every platform but Linux) it reads, in order:
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
//
// A machine whose accounts share one owner (Linux: the owner's administrator account and one
// unprivileged account per entity) reads only the system folder, never an account's home:
//   - the pin and the machine record are in the system folder, written by the administrator alone;
//   - the ledger is a folder owned by the owner helper's own user (named, with its uid, in the
//     system folder's `owner-helper.json`), one folder per account under it, and only the helper
//     spends there (src/client/owner-spend.ts);
//   - a system folder that is missing, unprotected, without the helper's record or ledger, or
//     with no pin yet, is `refused`: an entity account is never read as unpinned there, so no
//     terminal of it is the owner and no answer is accepted.

import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  ACCOUNT_NAME_PATTERN,
  accountHome,
  accountName,
  ownerStateRoots,
  productionOwnerStateRoots,
  SHARED_OWNER_LEDGER,
  SYSTEM_OWNER_FOLDER,
  type AccountHome,
  type OwnerStateRoots,
  type SharedOwnerRoots,
} from './owner-state-roots.ts';

export { ACCOUNT_NAME_PATTERN, accountHome, accountName, productionOwnerStateRoots, SHARED_OWNER_LEDGER, SYSTEM_OWNER_FOLDER };
export type { AccountHome, OwnerStateRoots, SharedOwnerRoots };

const PIN = 'owner-seat-pin.json';
const MACHINE = 'machine.json';
const LEDGER = 'owner-ledger';
const HELPER = 'owner-helper.json';
export const OWNER_HELPER_FORMAT = 'team-owner-helper-v1';

/** The owner helper of a machine whose accounts share one owner, as the system folder names it. */
export type OwnerHelperRecord = { format: typeof OWNER_HELPER_FORMAT; user: string; uid: number };

/** One place the owner state lives: the system folder or the account's config folder. `shared`
 *  is set on a machine whose accounts share one owner: `ledger` is then this account's own folder
 *  under the helper's ledger, which only the helper writes. */
export type OwnerStatePlace = {
  kind: 'system' | 'account';
  dir: string;
  pin: string;
  machine: string;
  ledger: string;
  shared?: { account: string; helper: OwnerHelperRecord; ledgerRoot: string };
};

export type OwnerStateRead =
  /** Never pinned: nothing at any of the paths. `write` is where a first pin goes (null: a test
   *  scene that names no account). Never on a machine whose accounts share one owner. */
  | { kind: 'none'; write: OwnerStatePlace | null }
  /** Pinned, or pinned once: at least one entry stands here. */
  | { kind: 'present'; place: OwnerStatePlace }
  /** A state the resolver cannot read or trust: treated as pinned, and nothing is accepted.
   *  `setup` is set when a shared machine's system folder is set up and holds no pin yet: the
   *  place the administrator's first pin goes. */
  | { kind: 'refused'; why: string; setup?: OwnerStatePlace };

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
 * The command the owner runs as the administrator, with this process's own Bun and TeamCLI named
 * in full: the administrator's search path under sudo seldom reaches an account's own install.
 */
function adminCommand(words: string): string {
  // Only TeamCLI's own command line is named in full; any other program (the owner helper among
  // them) names the command by its plain name.
  const cli = process.argv[1];
  const ours = typeof cli === 'string' && cli.startsWith('/') && /(^|\/)(cli\.[jt]s|team)$/.test(cli);
  const team = ours ? `${process.execPath} ${cli}` : 'team';
  return `sudo ${team} ${words}`;
}

/** The install, as the owner runs it from the administrator's own account. */
export function ownerInstallCommand(account: string | null = accountName()): string {
  return adminCommand(`owner-seat install --account ${account ?? '<entity accounts>'}`);
}

/** The first pin, as the owner runs it from the administrator's own account. */
export function ownerPinCommand(): string {
  return adminCommand('owner-seat pin --from <export file>');
}

function notSetUp(account: string | null): string {
  return `this machine's owner state is not set up, so no owner answer is accepted here and no terminal is the owner. The owner sets it up once, from the administrator's own account: ${ownerInstallCommand(account)}, then ${ownerPinCommand()}`;
}

function readHelperRecord(path: string, owner: number): OwnerHelperRecord | 'absent' | 'refused' {
  const entry = probe(path);
  if (entry.kind === 'absent') return 'absent';
  if (entry.kind === 'refused' || !entry.stat.isFile() || !protectedBy(entry.stat, owner) || entry.stat.size > 4096) return 'refused';
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || raw.format !== OWNER_HELPER_FORMAT) return 'refused';
    if (typeof raw.user !== 'string' || !ACCOUNT_NAME_PATTERN.test(raw.user)) return 'refused';
    if (typeof raw.uid !== 'number' || !Number.isInteger(raw.uid) || raw.uid < 0) return 'refused';
    return { format: OWNER_HELPER_FORMAT, user: raw.user, uid: raw.uid };
  } catch {
    return 'refused';
  }
}

/**
 * A machine whose accounts share one owner: the system folder for `account`, or refused. Every
 * entry must be of its kind and writable only by its owner — the administrator for the folder,
 * the pin, the machine record and the helper's record; the helper's user for the ledger and the
 * account's folder in it. Exported for the owner helper, which reads the state of the account
 * that called it, not its own.
 */
export function sharedOwnerStateFor(account: string | null, shared: SharedOwnerRoots | null | undefined = ownerStateRoots().shared, dir: string | null = ownerStateRoots().system, owner: number = ownerStateRoots().systemOwner): OwnerStateRead {
  if (shared === null || shared === undefined || dir === null) return { kind: 'refused', why: notSetUp(account) };
  const folder = probe(dir);
  if (folder.kind === 'absent') return { kind: 'refused', why: notSetUp(account) };
  if (folder.kind === 'refused') return { kind: 'refused', why: 'the system owner folder cannot be read' };
  if (!folder.stat.isDirectory() || !protectedBy(folder.stat, owner)) return { kind: 'refused', why: 'the system owner folder is not a folder only its administrator can write' };
  const helper = readHelperRecord(join(dir, HELPER), owner);
  if (helper === 'absent') return { kind: 'refused', why: notSetUp(account) };
  if (helper === 'refused') return { kind: 'refused', why: "the owner helper's record in the system owner folder cannot be read or is not one only its administrator can write" };
  const ledger = probe(shared.ledger);
  if (ledger.kind === 'absent') return { kind: 'refused', why: notSetUp(account) };
  if (ledger.kind === 'refused' || !ledger.stat.isDirectory() || !protectedBy(ledger.stat, helper.uid)) return { kind: 'refused', why: "the approval ledger is not a folder only the owner helper can write" };
  if (account === null || !ACCOUNT_NAME_PATTERN.test(account)) return { kind: 'refused', why: "this account's name cannot be read from the user database" };
  const place: OwnerStatePlace = { ...placeAt('system', dir), ledger: join(shared.ledger, account), shared: { account, helper, ledgerRoot: shared.ledger } };
  let any = false;
  for (const path of [place.pin, place.machine]) {
    const entry = probe(path);
    if (entry.kind === 'absent') continue;
    if (entry.kind === 'refused') return { kind: 'refused', why: 'an entry of the system owner folder cannot be read' };
    if (!entry.stat.isFile() || !protectedBy(entry.stat, owner)) return { kind: 'refused', why: 'an entry of the system owner folder is not one only its administrator can write' };
    any = true;
  }
  const own = probe(place.ledger);
  if (own.kind === 'refused' || (own.kind === 'present' && (!own.stat.isDirectory() || !protectedBy(own.stat, helper.uid)))) {
    return { kind: 'refused', why: "this account's approval ledger is not a folder only the owner helper can write" };
  }
  if (!any) return { kind: 'refused', why: `no owner seat is pinned on this machine yet, so no owner answer is accepted here; the owner pins it from the administrator's own account: ${ownerPinCommand()}`, setup: place };
  return { kind: 'present', place };
}

/** Whether this process's roots are a machine whose accounts share one owner. */
export function ownerStateShared(): boolean {
  const roots = ownerStateRoots();
  return roots.shared !== null && roots.shared !== undefined;
}

/** The uid that writes the system folder: the administrator (root in real use). */
export function systemOwnerUid(): number {
  return ownerStateRoots().systemOwner;
}

/**
 * The machine's owner state, from the one resolver. `given` is the home the caller works in; the
 * process's own roots ignore it, so pointing a command at another home never changes the answer.
 */
export function ownerStateOf(given?: string): OwnerStateRead {
  const roots = ownerStateRoots();
  if (roots.shared !== null && roots.shared !== undefined) return sharedOwnerStateFor(roots.shared.account());
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
 * On a machine whose accounts share one owner, why its owner state refuses when it is not set up
 * or not pinned yet — naming the step the owner takes — for the caller placement; null anywhere
 * else, and when the state stands.
 */
export function ownerSetupNoteOnThisAccount(): string | null {
  if (!ownerStateShared()) return null;
  const state = ownerStateOf(undefined);
  return state.kind === 'refused' ? state.why : null;
}

/**
 * Whether this account's owner seat is pinned from another machine, for the caller placement:
 * the same resolver, with no home passed.
 */
export function ownerSignsElsewhereOnThisAccount(): boolean {
  return ownerMachinePinned(undefined);
}
