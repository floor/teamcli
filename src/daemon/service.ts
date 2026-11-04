// The neutral system-service interface behind `team daemon install` and `team daemon uninstall`.
// Every user-facing line says "the system's service manager" and nothing about one platform's
// own facility; the platform's names, files and commands live only in an adapter beside this
// file. A test injects a fake manager; the live adapter is chosen by `systemServiceManager()` and
// is the only place that runs the platform's registration command.
//
// An install never finishes with no daemon and no message. A refresh stops the daemon the
// manager already holds, then loads the new one, offering it again with a bounded, growing wait
// while the manager refuses — a refusal while the earlier stop is still finishing is not a
// verdict on the new unit. If the new one still cannot start, the earlier unit is put back
// unchanged and the daemon it names is started again: that unit's entry is the retained program
// folder it was installed with, which this install never writes. The failure and that rollback
// are reported together, and the command exits non-zero. A load the manager accepted is
// registration, not proof that a program runs, so the command confirms the restored daemon
// answers before it calls the rollback done; the same confirmation gates a successful install.
//
// A unit runs a complete program, so an install copies the whole module tree the entry needs
// into a content-addressed folder under the machine config and writes the unit against that
// copy. The package the owner later upgrades is not the program this tool's unit runs, and an
// upgrade therefore never replaces code a running unit names. The copy's folder name is the
// hash of its paths, modes and bytes; a folder already there is run only after it is verified
// to be ours and byte-identical to that hash, and the folder holding the copies must be this
// user's own directory that no group or other write reaches. What that proves is the copy that
// is there when it is read: a writer running as this same user can still replace the copy, or a
// folder inside it, between that check and the service manager's exec — exactly as it can
// rewrite the unit file itself. That residue is the same same-user limit the admission below
// states; this check is not a boundary against that user's deliberate attempt.
//
// The daemon's own start is admitted from the manager's record of the job it started and the
// unit file that job runs — pid, program, label, owner, mode and the unit's own words — never
// from a process walk, which cannot tell a service-managed child from an orphan reparented to
// the top. The record proves the service manager started this process from a unit the user
// owns; a process of that same user can register a job under a label that is not loaded, so this
// is an identity check against mistakes, not a boundary against that user's deliberate attempt.
import { darwinServiceManager } from './service-darwin.ts';
export type ServiceRunResult = { status: number | null; stdout: string; stderr: string };
export type ServiceRunner = (command: string, args: string[]) => ServiceRunResult;

/**
 * The program a unit runs, as the complete set of files a retained copy must reproduce. The
 * entry alone is not the program: a built CLI is a module tree that also reads its package
 * manifest and the sibling packages it lives beside, so a copy of one file is not a program that
 * can run. `root` is the directory whose layout the retained copy reproduces; `include` names
 * every file and directory under it the entry's module tree reads at run time. A path that is
 * named here but missing is a refusal: an install never writes a unit whose program it could not
 * copy whole.
 */
export type ServiceRuntime = {
  /** The directory the retained copy's layout is taken from. */
  root: string;
  /** Paths under `root`, relative, each a file or a directory, copied as it stands. */
  include: string[];
};

export type ServiceProgram = {
  /** The runtime that runs the CLI entry (the installed `team` launcher's interpreter). */
  execPath: string;
  /** The CLI entry file itself. The adapter writes the unit against a retained copy of the
   *  whole program, never against this path: the package a later upgrade replaces is not the
   *  program a unit of this tool runs. */
  entry: string;
  /** The files that make up the program. Absent means the entry's own directory is the whole
   *  program, which is what a synthetic scene's single-file entry is. */
  runtime?: ServiceRuntime;
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
 * The manager's own record of the running job under the daemon's label: the process it started
 * and the program it runs. Null or a null field refuses a start closed — the record is the
 * identity, so a record that cannot be read is never replaced by a guess.
 */
export type ServiceJobRecord = {
  /** The pid the manager records for the job, or null when it records none (not running). */
  pid: number | null;
  /** The executable the manager records for the job, or null when it records none. */
  program: string | null;
};

/**
 * What the unit file the job was started from says. The daemon reads the file it was started
 * from, never a label from its surroundings: a copied unit under another label is not this
 * daemon's own, and a unit another user can write is not the owner's.
 */
export type ServiceUnitRecord = {
  /** The unit file the job was started from. */
  path: string;
  /** The unit's Label, or null when the file carries none. */
  label: string | null;
  /** The uid that owns the unit file, or null when it cannot be read. */
  ownerUid: number | null;
  /** The unit's permission bits (0o777), or null when they cannot be read. */
  mode: number | null;
  /** The unit's run words (ProgramArguments), or null when the file carries none. */
  programArguments: string[] | null;
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
  /** The words the unit was written with, including the retained entry the unit runs. The
   *  command reports these rather than a plan it computed before the copy was made. */
  program?: string[];
  /** True when the definition this install replaced named a client key or a general grant in
   *  its run command: the new definition is written without either, and the command says so in
   *  plain words. An install never writes a key or a grant into a definition. */
  droppedAuthorization?: boolean;
  /**
   * Runtime copies this install kept because a hook file of a hosted root names them. A seat's
   * hook command runs this tool's entry, and a settings file written from a runtime copy names
   * that copy: the copy is a program a seat still needs after this install returns, even when no
   * unit names it. Absent when no hook file names a copy.
   */
  hookedRuntime?: string[];
  /**
   * Set when the hook files of a hosted root could not be read whole: this install pruned no
   * copy at all, and this says what could not be read or parsed.
   */
  runtimeKeepFault?: string;
  /**
   * Puts the machine back after a load the manager accepted but whose daemon does not answer:
   * the earlier unit is restored, unchanged, and started again — its entry names the retained
   * program that unit was installed with, which this install did not touch — or, for a fresh
   * install, the unit this install wrote is stopped and removed. The runtime copy this install
   * added is removed with it, so the undo restores exactly what the install changed. The command
   * calls it only after the new daemon fails its health probe, and confirms the restored daemon
   * answers before reporting the rollback. An undo only ever answers a failure: it is called
   * after the new daemon did not answer, never instead of a successful install.
   */
  undo?: () => ServiceInstallFailure;
};

export type ServiceInstallResult = ServiceInstallSuccess | ServiceInstallFailure;

export type ServiceUninstallResult =
  | { ok: true; unitPath: string; removed: boolean }
  | { ok: false; why: string; detail: string | null };

/**
 * What a restart of the installed unit left behind:
 *
 * - `not-installed`: no unit file is installed, so there was nothing to stop or start; nothing
 *   was touched and the command says which command installs one.
 * - `refused`: the manager stopped the job it held and then refused to start the installed unit
 *   again, after the same bounded, growing retries an install gives a load; no daemon is running.
 *
 * A load the manager accepted is registration, not proof that a program runs, so the success
 * carries the same kind of undo an install does: the command calls it only after the restarted
 * daemon fails its health probe, and it stops that job and offers the installed unit again.
 */
export type ServiceRestartFailure = {
  ok: false;
  reason: 'not-installed' | 'refused';
  why: string;
  detail: string | null;
};

export type ServiceRestartSuccess = {
  ok: true;
  unitPath: string;
  /** Stops the daemon this restart started and loads the installed unit again: an undo only
   *  ever answers a health probe that did not, never a successful restart. */
  undo: () => ServiceRestartResult;
};

export type ServiceRestartResult = ServiceRestartSuccess | ServiceRestartFailure;

/** One loaded unit's own program words, from the manager's records. */
export type LoadedServiceProgram = { label: string; program: readonly string[] };

export type ServiceManager = {
  readonly kind: 'system-service-manager';
  unitPath(home: string): string;
  /**
   * Every loaded unit's label and program words, when the adapter can read them. Used only
   * to hold a runtime-home folder a loaded unit still names — never to stop anything.
   * Absent: no folder is held on a unit's word.
   */
  loadedPrograms?(home: string): LoadedServiceProgram[];
  plan(home: string, program: ServiceProgram): ServicePlan;
  /**
   * The manager's own record of the job under the daemon's label: the pid it started and the
   * program it runs. Null when no job is loaded or the record cannot be read — a start refuses
   * closed rather than falling back to a process walk.
   */
  job(home: string): ServiceJobRecord | null;
  /**
   * What the unit file the job was started from says: its label, owner, permission bits and run
   * words. Null when the file is not a regular readable file.
   */
  unit(home: string): ServiceUnitRecord | null;
  /**
   * Copies the whole program into a retained, content-addressed runtime folder, writes the unit
   * against that copy, and registers it. A refresh replaces a daemon the manager already holds:
   * the old job is stopped, and the new one is loaded, offered again with a bounded, growing
   * wait while the manager refuses. When the new one still cannot start, the earlier unit is put
   * back unchanged and its daemon started again — the earlier unit names the retained copy it
   * was installed with, which this install never touches — so a failed refresh leaves a daemon
   * running and a failure, never a silent empty machine: `outcome` says which of the answers the
   * failure carries.
   */
  install(home: string, program: ServiceProgram): ServiceInstallResult;
  uninstall(home: string): ServiceUninstallResult;
  /**
   * Stops the daemon the manager holds under the installed unit and loads that same unit again.
   * Nothing is written: the definition, its roots and its opt-ins are the last install's, so a
   * restart never changes which checkouts are hosted. A machine with no unit answers
   * `not-installed` and is not touched; a load the manager still refuses after the bounded,
   * growing retries answers `refused` with no daemon running.
   */
  restart(home: string): ServiceRestartResult;
  /**
   * Stops and removes one shuttle unit. Optional: a manager that does not carry shuttle units
   * omits it, and a test double that never retires omits it too. A unit that is not loaded is
   * still retired when its definition is gone. Nothing starts the unit again.
   */
  retireUnit?(home: string, label: string): { ok: true } | { ok: false; why: string };
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
