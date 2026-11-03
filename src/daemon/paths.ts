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

/** One chores child's one-use token: the configuration it serves from. The child unlinks it as it
 *  starts, so one token starts one child. */
export function choresInheritPath(home: string, nonce: string): string {
  return join(machineConfigDir(home), `chores.inherit.${nonce}.json`);
}

/** One restore child's one-use token: the one route its pass may act on. Written 0600 under the
 *  machine folder and unlinked by the child as it starts, so one token starts one pass. */
export function restoreInheritPath(home: string, nonce: string): string {
  return join(machineConfigDir(home), `restore.inherit.${nonce}.json`);
}
