// The neutral system-service interface behind `team daemon install` and `team daemon uninstall`.
// Every user-facing line says "system service manager" and nothing about one platform's own
// facility; the platform's names, files and commands live only in an adapter beside this file.
// A test injects a fake manager; the live adapter is chosen by `systemServiceManager()` and is
// the only place that runs the platform's registration command.
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
};

export type ServicePlan = {
  /** Where the adapter writes its unit file. OS-specific, never printed as prose. */
  unitPath: string;
  /** The program the service manager runs, as argv. */
  program: string[];
};

export type ServiceInstallResult =
  | { ok: true; unitPath: string }
  | { ok: false; why: string; detail: string | null };

export type ServiceUninstallResult =
  | { ok: true; unitPath: string; removed: boolean }
  | { ok: false; why: string; detail: string | null };

export type ServiceManager = {
  readonly kind: 'system-service-manager';
  unitPath(home: string): string;
  plan(home: string, program: ServiceProgram): ServicePlan;
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
};

/** The local system's manager, or null when this platform has no adapter yet. */
export function systemServiceManager(options: ServiceManagerOptions = {}): ServiceManager | null {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return darwinServiceManager(options);
  return null;
}
