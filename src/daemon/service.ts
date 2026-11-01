// The neutral system-service interface behind `team daemon install` and `team daemon uninstall`.
// Every user-facing line says "system service manager" and nothing about one platform's own
// facility; the platform's names, files and commands live only in an adapter beside this file.
// A test injects a fake manager; the live adapter is chosen by `systemServiceManager()` and is
// the only place that runs the platform's registration command.
//
// An install never finishes with no daemon and no message. A refresh stops the daemon the
// manager already holds, then loads the new one, offering it again with a bounded, growing wait
// while the manager refuses — a refusal while the earlier stop is still finishing is not a
// verdict on the new unit. If the new one still cannot start, the earlier unit is put back and
// the daemon its program names is started again; the failure and that rollback are reported
// together, and the command exits non-zero.
import { darwinServiceManager } from './service-darwin.ts';
export type ServiceRunResult = { status: number | null; stdout: string; stderr: string };
export type ServiceRunner = (command: string, args: string[]) => ServiceRunResult;

export type ServiceProgram = {
  /** The runtime that runs the CLI entry (the installed `team` launcher's interpreter). */
  execPath: string;
  /** The CLI entry file itself. */
  entry: string;
  /** The checkouts this one daemon process hosts. */
  roots: string[];
  /** Whether the unit's run command carries the presence opt-in. Absent means the unit starts
   *  the daemon without presence hosting, exactly as a plain `run` does. */
  presence?: boolean;
  /** Whether the unit's run command carries the watch opt-in. Absent means the unit starts the
   *  daemon without a hosted watch, exactly as a plain `run` does. Independent of `presence`. */
  watch?: boolean;
  /** The general grant and key an admitted `install --general` ran under (0.5.8.1). The unit's run
   *  command carries them, so the service-started run passes the dispatcher's general door, which
   *  verifies the grant again at every start and refuses (exit 1) once it is expired or invalid.
   *  Absent: the unit carries no grant, as before. */
  general?: { grant: string; key: string };
  /** The PATH the installing shell had (0.5.9). launchd starts a unit with only
   *  /usr/bin:/bin:/usr/sbin:/sbin, where herdr (often ~/.local/bin or /opt/homebrew/bin) is not
   *  found: every session read then failed and every hosted send answered "the session could not
   *  be read". The unit carries the installer's PATH so the service finds the same herdr. */
  path?: string;
};

export type ServicePlan = {
  /** Where the adapter writes its unit file. OS-specific, never printed as prose. */
  unitPath: string;
  /** The program the service manager runs, as argv. */
  program: string[];
};

/**
 * What a failed install left behind, named for the daemon it leaves running:
 *
 * - `refused`: there was no earlier unit to go back to, so the failed install leaves none; the
 *   refusal line says so and the command exits non-zero.
 * - `restored`: the earlier unit was put back and the daemon its program names was started
 *   again, so the machine still has a daemon under the service manager.
 * - `lost`: the earlier unit was put back, but its daemon could not be started again; the
 *   refusal names that plainly and the command exits non-zero, so the failure is never quiet.
 */
export type ServiceInstallFailure = {
  ok: false;
  why: string;
  detail: string | null;
  outcome: 'refused' | 'restored' | 'lost';
};

export type ServiceInstallResult = { ok: true; unitPath: string } | ServiceInstallFailure;

export type ServiceUninstallResult =
  | { ok: true; unitPath: string; removed: boolean }
  | { ok: false; why: string; detail: string | null };

export type ServiceManager = {
  readonly kind: 'system-service-manager';
  unitPath(home: string): string;
  plan(home: string, program: ServiceProgram): ServicePlan;
  /**
   * Writes and registers the unit. A refresh replaces a daemon the manager already holds: the
   * old job is stopped, and the new one is loaded, offered again with a bounded, growing wait
   * while the manager refuses. When the new one still cannot start, the earlier unit is put
   * back and its daemon started again, so a failed refresh leaves a daemon running and a
   * failure, never a silent empty machine: `outcome` says which of the answers the failure
   * carries.
   */
  install(home: string, program: ServiceProgram): ServiceInstallResult;
  uninstall(home: string): ServiceUninstallResult;
};

export type ServiceManagerOptions = {
  /** Injected for a test that must not run the platform's registration command. */
  runner?: ServiceRunner;
  /** The user the unit starts for; defaults to this process's uid. */
  uid?: number;
  platform?: NodeJS.Platform;
  /** Injected clock for the adapter's own log lines, when it writes any. */
  now?: () => Date;
  /**
   * The wait between the bounded load retries. Injected by a test so a scene that exercises the
   * retries finishes at once; the install itself is synchronous and blocks for the real waits,
   * which are bounded.
   */
  sleep?: (ms: number) => void;
};

/** The local system's manager, or null when this platform has no adapter yet. */
export function systemServiceManager(options: ServiceManagerOptions = {}): ServiceManager | null {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return darwinServiceManager(options);
  return null;
}
