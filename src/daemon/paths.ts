// The one machine-wide TeamCLI daemon's paths. The machine folder is `~/.config/team` today;
// the owner's newer `~/.config/teamcli` location moves later with its own migration, and this
// module is the only place that has to change. The daemon serves every team and clone on the
// machine, so nothing here depends on a checkout root or a team file.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The daemon unit's label. The service adapter turns it into a file name; no command prints it. */
export const DAEMON_LABEL = 'io.floor.teamcli.daemon';

/** The machine folder every path below lives in. */
export function machineConfigDir(home: string = homedir()): string {
  return join(home, '.config', 'team');
}

/** The daemon's Unix domain socket, mode 0600 inside a 0700 folder. */
export function daemonSocketPath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon.sock');
}

/** Where a home keeps the retained runtime copies its service unit runs, and the record naming
 *  the installed program they were copied from. */
export function daemonRuntimeRoot(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon-runtime');
}

/** The runtime home: where the daemon's hosted modules keep live state and the kit folders
 *  migrated out of the legacy lobby stand. Owner-only, like every folder under it. */
export function runtimeDir(home: string = homedir()): string {
  return join(machineConfigDir(home), 'runtime');
}

/** The moved kit folders, one per name, under the runtime home. */
export function runtimeKitsDir(home: string = homedir()): string {
  return join(runtimeDir(home), 'kits');
}

/** The runtime-home migration's record: what moved, whence, whither, and what still waits. */
export function runtimeMigrationNotePath(home: string = homedir()): string {
  return join(runtimeDir(home), 'migration.json');
}

/** The daemon's state record: pid, start time, launcher, heartbeat, features and stuck requests. */
export function daemonStatePath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon.state.json');
}

/** The daemon's one log file. */
export function daemonLogPath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon.log');
}

/** The daemon's single-instance lock file. */
export function daemonLockPath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon.lock');
}

/** The one-use token families: a child's token file is `<kind>.inherit.<nonce>.json`. */
export const INHERIT_KINDS = ['chores', 'restore'] as const;
export type InheritKind = (typeof INHERIT_KINDS)[number];

/** The nonce spelling every token writer uses: 16 random bytes as lowercase hex. */
export const INHERIT_NONCE_PATTERN = '[0-9a-f]{32}';

/** The token file's name, the one spelling both the writers and the claim sweep build on. */
export function inheritTokenName(kind: InheritKind, nonce: string): string {
  return `${kind}.inherit.${nonce}.json`;
}

/** The claimed copy's path: a claim renames the token to `<token>.claim.<pid>`. */
export function claimedTokenPath(path: string, pid: number): string {
  return `${path}.claim.${pid}`;
}

/** One chores child's one-use token: the configuration it serves from. The child unlinks it as it
 *  starts, so one token starts one child. */
export function choresInheritPath(home: string, nonce: string): string {
  return join(machineConfigDir(home), inheritTokenName('chores', nonce));
}

/** One restore child's one-use token: the one route its pass may act on. Written 0600 under the
 *  machine folder and unlinked by the child as it starts, so one token starts one pass. */
export function restoreInheritPath(home: string, nonce: string): string {
  return join(machineConfigDir(home), inheritTokenName('restore', nonce));
}
