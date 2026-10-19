// The one machine-wide TeamCLI daemon's paths (OD-20261019-47: the machine folder is
// `~/.config/teamcli`, not `~/.config/team`). The daemon serves every team and clone on the
// machine, so nothing here depends on a checkout root or a team file.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The user LaunchAgent's label, and the plist file's name. */
export const DAEMON_LABEL = 'io.floor.teamcli.daemon';

/** The machine folder every path below lives in. */
export function machineConfigDir(home: string = homedir()): string {
  return join(home, '.config', 'teamcli');
}

/** The daemon's Unix domain socket, mode 0600 inside a 0700 folder. */
export function daemonSocketPath(home: string = homedir()): string {
  return join(machineConfigDir(home), 'daemon.sock');
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

/** The user LaunchAgent's plist under the home the daemon was installed for. */
export function launchAgentPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
}
