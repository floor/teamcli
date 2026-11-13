// Where the machine daemon and the seats keep their temporary files, compared for `team doctor`.
//
// A Claude Code seat listens on `<its temp folder>/cc-socks/<pid>.sock`, and the send endpoint the
// daemon hosts looks for that socket under the daemon's own temp folder alone (src/send/daemon.ts,
// `socketsDir`). The two folders come from two different starts: the daemon from the system's
// service manager, the seats from the terminal host's server, which `team up` starts with a clean
// environment that names no temp folder (`SERVER_ENVIRONMENT` in src/launch/plan.ts). When they
// differ, a send the daemon carries never finds a seat's socket and reaches it by a later leg.
//
// The daemon writes its folder into its state record at its start. A seat's folder is measured
// when doctor itself runs in one of the terminal host's panes, whose environment the seats share;
// otherwise it is the folder a process answers when its environment names none.
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The folder the session sockets sit in, under a temp folder. */
export const SOCKETS_FOLDER = 'cc-socks';

/** The variables a runtime reads its temp folder from, in the order it reads them. */
export const TEMP_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** The temp folder a process with this environment answers: the first of `TEMP_VARIABLES` that is
 *  set and not empty, its trailing separator dropped, else `/tmp` — the rule the runtimes the CLIs
 *  run on follow outside Windows. */
export function tempDirOf(env: Readonly<Record<string, string | undefined>>): string {
  for (const name of TEMP_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '') return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  }
  return '/tmp';
}

/** The folder a pane `team up` starts gets: its server's environment names no temp folder. */
export function paneTempDir(): string {
  return tempDirOf({});
}

/** Whether two paths name one folder once links are resolved; a folder that cannot be resolved
 *  is compared as written. */
export function sameTempFolder(a: string, b: string): boolean {
  const settled = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return settled(a) === settled(b);
}

/** The daemon's side of the row: no live daemon, a live one whose record names no folder (a
 *  build older than the row), or the folder it recorded at its start. */
export type DaemonTempDir = { kind: 'none' } | { kind: 'unrecorded' } | { kind: 'recorded'; dir: string };

/** One doctor row. */
export type TempFolderRow = { level: 'ok' | 'warn' | 'note'; text: string };

/**
 * The row for the daemon's recorded folder against the seats'. `measured` is this process's own
 * folder when it runs in a seat's pane; absent, the seats' folder is `paneTempDir()`. Null when
 * no daemon runs: there is nothing to compare.
 */
export function tempFolderRow(input: {
  daemon: DaemonTempDir;
  measured?: string;
  same?: (a: string, b: string) => boolean;
}): TempFolderRow | null {
  if (input.daemon.kind === 'none') return null;
  if (input.daemon.kind === 'unrecorded') {
    return {
      level: 'note',
      text: 'the running daemon records no temp folder (a build older than this check), so it is not compared with the seats\'; `team daemon restart` records it',
    };
  }
  const daemon = input.daemon.dir;
  const seats = input.measured ?? paneTempDir();
  const where = input.measured === undefined ? 'the folder a pane started by `team up` gets' : 'read in this pane';
  if ((input.same ?? sameTempFolder)(daemon, seats)) {
    return { level: 'ok', text: `the daemon and the seats keep their temporary files in one folder (${seats})` };
  }
  return {
    level: 'warn',
    text:
      `the daemon's temp folder (${daemon}) is not the seats' (${seats}, ${where}): the daemon looks for a Claude Code ` +
      `seat's session socket in ${join(daemon, SOCKETS_FOLDER)} only, so a send it carries reaches such a seat by a later ` +
      'leg; give the daemon and the terminal host\'s server the same temp folder',
  };
}
