// Where the owner-state resolver (src/client/owner-pin-path.ts) looks: the process's own roots,
// fixed for the life of the process. Nothing here can change them: no command line, variable,
// file or exported function. The test suite's preloads stand in for this whole module
// (test/helpers/owner-state-roots.ts), so no scene reads the real account or system folder.

import { userInfo } from 'node:os';

/** The account home the resolver reads: a home, no account at all (a test scene that names none),
 *  or an account whose home the user database does not answer — which refuses, never unpins. */
export type AccountHome = { home: string } | 'none' | 'unresolved';

/** A machine whose accounts share one owner: the system folder is the only source, and each
 *  account spends its approvals in its own folder under a ledger the owner helper owns. */
export type SharedOwnerRoots = {
  /** The ledger folder, owned by the helper's user; one folder per account under it. */
  ledger: string;
  /** The account this process runs as, from the user database (null when it does not answer). */
  account: () => string | null;
};

/** Where the resolver looks. `account` maps the home a caller passed (if any) to the account home
 *  it reads; production ignores what was passed. */
export type OwnerStateRoots = {
  system: string | null;
  account: (given: string | undefined) => AccountHome;
  /** The uid that must own the system folder and every entry in it. */
  systemOwner: number;
  /** Set on a machine whose accounts share one owner (Linux); the account's home is then never read. */
  shared?: SharedOwnerRoots | null;
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

/** An account name as the user database gives it: plain, short, never a path. */
export const ACCOUNT_NAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** The name of the account this process runs as, from the user database; null when it does not
 *  answer or the name is not a plain account name. */
export function accountName(): string | null {
  try {
    const name = userInfo().username;
    return typeof name === 'string' && ACCOUNT_NAME_PATTERN.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** The system folder on every platform. */
export const SYSTEM_OWNER_FOLDER = '/etc/teamcli';
/** The ledger on a machine whose accounts share one owner: the helper user's own folder. */
export const SHARED_OWNER_LEDGER = '/var/lib/teamcli-owner/ledger';

/**
 * The process's own roots on `platform`. On macOS (and any platform but Linux) they are exactly
 * the ones before shared machines: the system folder when it is present, else the account's own
 * home. On Linux the system folder alone, shared by every account of the machine.
 */
export function productionOwnerStateRoots(platform: NodeJS.Platform = process.platform): OwnerStateRoots {
  const account = (): AccountHome => {
    const home = accountHome();
    return home === null ? 'unresolved' : { home };
  };
  if (platform === 'linux') return { system: SYSTEM_OWNER_FOLDER, account, systemOwner: 0, shared: { ledger: SHARED_OWNER_LEDGER, account: accountName } };
  return { system: SYSTEM_OWNER_FOLDER, account, systemOwner: 0 };
}

const PRODUCTION_ROOTS: OwnerStateRoots = productionOwnerStateRoots();

/** The process's own roots. */
export function ownerStateRoots(): OwnerStateRoots {
  return PRODUCTION_ROOTS;
}
