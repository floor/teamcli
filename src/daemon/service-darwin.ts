// The local service-manager adapter. Every platform-specific word, file and command lives here;
// the neutral `team daemon install` interface above it prints none of them to the user. The
// adapter writes a user service unit that starts the daemon at login and restarts it when it
// exits non-zero. A clean exit (the daemon stopped) is not restarted.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DAEMON_LABEL, daemonLogPath } from './paths.ts';
import type {
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
  return args;
}

function unitText(home: string, program: string[]): string {
  const args = program.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n');
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
  <key>RunAtLoad</key>
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
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);

  const unitPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
  const domain = `gui/${String(uid)}`;
  const service = `${domain}/${DAEMON_LABEL}`;

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
          };
        }
      }
      let temporary: string | null = null;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        temporary = `${path}.${String(process.pid)}.tmp`;
        writeFileSync(temporary, unitText(home, programOf(program)), { mode: 0o600 });
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
        return { ok: false, why: 'the service unit could not be written', detail: error instanceof Error ? error.message : null };
      }
      let result = run('launchctl', ['bootstrap', domain, path]);
      if (result.status !== 0) {
        // The unit may already be loaded from an earlier install. Unload it and try once more.
        run('launchctl', ['bootout', service]);
        result = run('launchctl', ['bootstrap', domain, path]);
      }
      if (result.status !== 0) {
        const detail = `bootstrap exited ${String(result.status)}: ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`;
        // Nothing was started, so the definition this install wrote is taken back out: the
        // earlier one is put back when there was one, and otherwise no unit is left behind for
        // the next login to load.
        try {
          if (prior === null) {
            if (existsSync(path)) unlinkSync(path);
          } else {
            writeFileSync(path, prior.text, { mode: prior.mode });
            chmodSync(path, prior.mode);
          }
        } catch (error) {
          const cleanup = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            why: 'the system service manager refused to start the daemon and the service definition could not be restored',
            detail: `${detail}; ${cleanup}`,
          };
        }
        return {
          ok: false,
          why: 'the system service manager refused to start the daemon',
          detail,
        };
      }
      return { ok: true, unitPath: path };
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
