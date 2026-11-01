// The local service-manager adapter. Every platform-specific word, file and command lives here;
// the neutral `team daemon install` interface above it prints none of them to the user. The
// adapter writes a user service unit that starts the daemon at login and restarts it when it
// exits non-zero. A clean exit (the daemon stopped) is not restarted.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAEMON_LABEL, daemonLogPath } from './paths.ts';
import type {
  ServiceInstallFailure,
  ServiceInstallResult,
  ServiceManager,
  ServiceManagerOptions,
  ServicePlan,
  ServiceProgram,
  ServiceRunResult,
  ServiceRunner,
  ServiceUninstallResult,
} from './service.ts';

const realRunner: ServiceRunner = (command, args): ServiceRunResult => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? `${result.error.message}\n${result.stderr ?? ''}` : (result.stderr ?? ''),
  };
};

// The waits between load offers, all bounded so `team daemon install` cannot hang. A load
// handed to the manager while the daemon it replaces is still leaving is refused — the race
// that emptied the machine before this fix — so a refused offer is repeated while the waits
// grow, giving that stop time to finish before the install calls the new unit failed. The
// whole retry is over in about five seconds.
const LOAD_RETRY_MS: readonly number[] = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000];

/** A synchronous wait: install is synchronous and the bounded retries pause it. */
function realSleep(ms: number): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function programOf(program: ServiceProgram): string[] {
  const args = [program.execPath, program.entry, 'daemon', 'run', '--started-by', 'service-manager'];
  for (const root of program.roots) args.push('--root', root);
  // The unit records the same opt-ins a foreground run takes: each flag is written only when the
  // install program asked for it, so a plain unit hosts neither presence nor a watch.
  if (program.presence === true) args.push('--presence');
  // The watch opt-in is separate: a unit may record either, both or neither.
  if (program.watch === true) args.push('--watch');
  // An install admitted by a general grant: the run is admitted by the same grant, verified anew.
  if (program.general !== undefined) args.push('--general', program.general.grant, '--key', program.general.key);
  return args;
}

function unitText(home: string, program: string[], path?: string): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
  // The installer's PATH, so the service finds herdr and the CLIs where the owner's shell does.
  const env = path === undefined || path === ''
    ? ''
    : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${escapeXml(path)}</string>\n  </dict>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(daemonLogPath(home))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(daemonLogPath(home))}</string>
</dict>
</plist>
`;
}

export function darwinServiceManager(options: ServiceManagerOptions = {}): ServiceManager {
  const run = options.runner ?? realRunner;
  const sleep = options.sleep ?? realSleep;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

  const unitPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  const domain = `gui/${String(uid)}`;
  const service = `${domain}/${DAEMON_LABEL}`;

  /** Loads the unit at `path`, retrying a refusal with a bounded, growing wait. A refusal while
   *  the job this unit replaces is still leaving is the same answer as a unit the manager will
   *  not take, so both are given the same bounded patience: the manager accepts the load as soon
   *  as the earlier job has left. */
  const loadWithRetry = (path: string): ServiceRunResult => {
    let result = run('launchctl', ['bootstrap', domain, path]);
    for (const wait of LOAD_RETRY_MS) {
      if (result.status === 0) break;
      sleep(wait);
      result = run('launchctl', ['bootstrap', domain, path]);
    }
    return result;
  };

  /** One failed load, in the words the daemon log carries. */
  const loadDetail = (result: ServiceRunResult): string =>
    `the load exited ${String(result.status)}: ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`;

  const refused = (what: string, detail: string, outcome: ServiceInstallFailure['outcome']): ServiceInstallResult => ({
    ok: false,
    why: what,
    detail,
    outcome,
  });

  /**
   * The earlier definition goes back and its daemon is started again, so a refresh the service
   * manager refuses leaves a running daemon and a reported failure, never a machine with no
   * daemon and no message. The failed load may have left the label claimed, so it is cleared
   * before the earlier unit is offered; that offer gets the same bounded retries, which also
   * wait out a stop that is still finishing.
   */
  const restore = (
    path: string,
    prior: { text: string; mode: number } | null,
    failDetail: string,
  ): ServiceInstallResult => {
    // Nothing was installed before this install: the definition it wrote is taken back out, so
    // the manager cannot load an unregistered unit at the next login, and there is no earlier
    // definition to put back.
    if (prior === null) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch (error) {
        return refused(
          'the system service manager refused to start the daemon and the service definition could not be removed',
          `${failDetail}; ${error instanceof Error ? error.message : String(error)}`,
          'refused',
        );
      }
      return refused(
        'the system service manager refused to start the daemon',
        `${failDetail}; no earlier unit was installed, so no daemon is running`,
        'refused',
      );
    }
    // The earlier unit goes back before the manager is asked to load it: the file is the
    // definition a load reads, and it names the daemon this install was replacing.
    try {
      writeFileSync(path, prior.text, { mode: prior.mode });
      chmodSync(path, prior.mode);
    } catch (error) {
      return refused(
        'the system service manager refused to start the new daemon, and the earlier service definition could not be put back; no daemon was started',
        `${failDetail}; ${error instanceof Error ? error.message : String(error)}`,
        'lost',
      );
    }
    run('launchctl', ['bootout', service]);
    const back = loadWithRetry(path);
    if (back.status === 0) {
      return refused(
        'the system service manager refused to start the new daemon; the previous one was put back and started again',
        `${failDetail}; the earlier unit was put back and its daemon started`,
        'restored',
      );
    }
    return refused(
      'the system service manager refused to start the new daemon, and the previous one could not be started again; no daemon was started',
      `${failDetail}; the earlier unit was put back, and ${loadDetail(back)}`,
      'lost',
    );
  };

  return {
    kind: 'system-service-manager',
    unitPath,
    plan: (home, program): ServicePlan => ({ unitPath: unitPath(home), program: programOf(program) }),

    install(home, program): ServiceInstallResult {
      const path = unitPath(home);
      // A failed install must not leave a definition launchd could load at the next login. The
      // unit this install may overwrite is kept first, so a refusal restores the earlier,
      // already-installed definition rather than leaving the unregistered one in its place.
      let prior: { text: string; mode: number } | null = null;
      if (existsSync(path)) {
        try {
          prior = { text: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 };
        } catch (error) {
          return {
            ok: false,
            why: 'the existing service unit could not be read',
            detail: error instanceof Error ? error.message : null,
            outcome: 'refused',
          };
        }
      }
      let temporary: string | null = null;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        temporary = `${path}.${String(process.pid)}.tmp`;
        writeFileSync(temporary, unitText(home, programOf(program), program.path), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
        temporary = null;
        chmodSync(path, 0o600);
      } catch (error) {
        if (temporary !== null) {
          try {
            unlinkSync(temporary);
          } catch {
            // Nothing of ours is there to take.
          }
        }
        return {
          ok: false,
          why: 'the service unit could not be written',
          detail: error instanceof Error ? error.message : null,
          outcome: 'refused',
        };
      }
      // A job the manager already holds under our label is the daemon a refresh replaces: the
      // load for the new unit is refused while it is loaded. It is stopped, and the load is
      // offered again with a bounded, growing wait while the manager refuses — the earlier stop
      // may still be finishing, and a refusal the install never retries past is the empty
      // machine this install must never leave.
      const first = run('launchctl', ['bootstrap', domain, path]);
      if (first.status === 0) return { ok: true, unitPath: path };
      run('launchctl', ['bootout', service]);
      const loaded = loadWithRetry(path);
      if (loaded.status === 0) return { ok: true, unitPath: path };
      // The new unit did not start after every bounded retry: the earlier definition is put
      // back and its daemon started, so a failure is reported and a daemon still runs.
      return restore(path, prior, loadDetail(loaded));
    },

    uninstall(home): ServiceUninstallResult {
      const path = unitPath(home);
      const booted = run('launchctl', ['bootout', service]);
      // Removing the unit file does not unload a job the service manager still holds, and a
      // loaded KeepAlive job would start the daemon again. Only a stop the manager accepted
      // permits the file to go; a unit with no accepted stop stays as the recovery state a retry
      // needs. With no unit written at all there is nothing to remove and nothing to hide, so the
      // absent-unit answer is the same whether or not a service manager call failed.
      const present = existsSync(path);
      if (present && booted.status !== 0) {
        return {
          ok: false,
          why: 'the system service manager did not confirm the daemon stopped',
          detail: `bootout exited ${String(booted.status)}: ${booted.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
        };
      }
      let removed = false;
      if (present) {
        try {
          unlinkSync(path);
          removed = true;
        } catch (error) {
          // A unit taken away between the decision and the removal was never ours to remove:
          // nothing is left installed, which is the answer this uninstall was giving.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, unitPath: path, removed: false };
          return {
            ok: false,
            why: 'the service unit could not be removed',
            detail: error instanceof Error ? error.message : null,
          };
        }
      }
      return { ok: true, unitPath: path, removed };
    },
  };
}
