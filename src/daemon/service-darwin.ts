// The local service-manager adapter. Every platform-specific word, file and command lives here;
// the neutral `team daemon install` interface above it prints none of them to the user. The
// adapter writes a user service unit that starts the daemon at login and restarts it when it
// exits non-zero. A clean exit (the daemon stopped) is not restarted.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  // The unit records the same opt-in a foreground run takes: without it the service-managed
  // daemon hosts no presence at all, and with it every hosted route's pipeline starts at login.
  if (program.presence === true) args.push('--presence');
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
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${String(process.pid)}.tmp`;
        writeFileSync(temporary, unitText(home, programOf(program)), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, path);
        chmodSync(path, 0o600);
      } catch (error) {
        return { ok: false, why: 'the service unit could not be written', detail: error instanceof Error ? error.message : null };
      }
      let result = run('launchctl', ['bootstrap', domain, path]);
      if (result.status !== 0) {
        // The unit may already be loaded from an earlier install. Unload it and try once more.
        run('launchctl', ['bootout', service]);
        result = run('launchctl', ['bootstrap', domain, path]);
      }
      if (result.status !== 0) {
        return {
          ok: false,
          why: 'the system service manager refused to start the daemon',
          detail: `bootstrap exited ${String(result.status)}: ${result.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
        };
      }
      return { ok: true, unitPath: path };
    },

    uninstall(home): ServiceUninstallResult {
      const path = unitPath(home);
      run('launchctl', ['bootout', service]);
      let removed = false;
      if (existsSync(path)) {
        try {
          unlinkSync(path);
          removed = true;
        } catch (error) {
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
