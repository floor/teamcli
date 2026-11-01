// The neutral system-service interface behind `team daemon install` and `team daemon uninstall`.
// Every user-facing line says "system service manager" and nothing about one platform's own
// facility; the platform's names, files and commands live only in an adapter beside this file.
// A test injects a fake manager; the live adapter is chosen by `systemServiceManager()` and is
// the only place that runs the platform's registration command.
//
// An install never finishes with no daemon and no message. A refresh stops the daemon the
// manager already holds, then loads the new one, offering it again with a bounded, growing wait
// while the manager refuses — a refusal while the earlier stop is still finishing is not a
// verdict on the new unit. If the new one still cannot start, the earlier unit is put back —
// with the earlier program when this install replaced that same entry in place — and the daemon
// it names is started again; the failure and that rollback are reported together, and the
// command exits non-zero. A load the manager accepted is registration, not proof that a program
// runs, so the command confirms the restored daemon answers before it calls the rollback done.
import { darwinServiceManager } from './service-darwin.ts';
export type ServiceRunResult = { status: number | null; stdout: string; stderr: string };
export type ServiceRunner = (command: string, args: string[]) => ServiceRunResult;

export type ServiceProgram = {
  /** The runtime that runs the CLI entry (the installed `team` launcher's interpreter). */
  execPath: string;
  /** The CLI entry file itself. The adapter keeps a copy of the program a loaded unit was
   *  accepted with, so a later refresh that replaces this same path in place can put the bytes
   *  the earlier unit runs back before restoring that unit. */
  entry: string;
  /** The checkouts this one daemon process hosts. */
  roots: string[];
  /** Whether the unit's run command carries the presence opt-in. Absent means the unit starts
   *  the daemon without presence hosting, exactly as a plain `run` does. */
  presence?: boolean;
  /** Whether the unit's run command carries the watch opt-in. Absent means the unit starts the
   *  daemon without a hosted watch, exactly as a plain `run` does. Independent of `presence`. */
  watch?: boolean;
  /** The PATH the installing shell had (0.5.9). The service manager starts a unit with only
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
 * - `refused`: nothing was started and no earlier definition was put back — the attempt failed
 *   before it offered a load, or the manager refused the only definition there was; the refusal
 *   line says so and the command exits non-zero.
 * - `restored`: the earlier unit — and, when this install replaced that same entry in place, the
 *   earlier program it names — was put back and its daemon offered to the service manager again;
 *   the manager accepted the load. Acceptance is registration, not proof that a program runs:
 *   the command confirms the daemon answers before reporting the rollback, and reports no daemon
 *   when nothing answers.
 * - `lost`: nothing was started and the earlier unit could not be put back and started again;
 *   the refusal names that plainly and the command exits non-zero, so the failure is never quiet.
 *
 * `kept` tells the command where the earlier definition stands, so a failure that leaves no
 * daemon running can say where the unit that was kept is: true when that definition is in place
 * after the failure (put back, or never overwritten), false when it is not there.
 */
export type ServiceInstallFailure = {
  ok: false;
  why: string;
  detail: string | null;
  outcome: 'refused' | 'restored' | 'lost';
  kept: boolean;
};

export type ServiceInstallSuccess = {
  ok: true;
  unitPath: string;
  /** True when the definition this install replaced named a client key or a general grant in
   *  its run command: the new definition is written without either, and the command says so in
   *  plain words. An install never writes a key or a grant into a definition. */
  droppedAuthorization?: boolean;
};

export type ServiceInstallResult = ServiceInstallSuccess | ServiceInstallFailure;

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
   * back — with the earlier program when this install replaced that same entry in place — and
   * its daemon started again, so a failed refresh leaves a daemon running and a failure, never
   * a silent empty machine: `outcome` says which of the answers the failure carries.
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
