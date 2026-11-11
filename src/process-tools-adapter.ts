import { traceBeatWork } from './diagnostics/beat-work.ts';
// The platform adapter for process evidence. Identity must never select an executable through
// the caller's PATH or inherit settings that change its output or load code into the child.
import {
  execFile,
  execFileSync,
  spawnSync,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';

export type ProcessTool = 'ps' | 'lsof' | 'pgrep';

// Only system-managed locations. No package directory, current directory, environment override,
// or PATH fallback. An unsupported platform supplies no process evidence through these tools.
const SYSTEM_TOOLS: Readonly<Record<string, Readonly<Record<ProcessTool, readonly string[]>>>> = {
  darwin: { ps: ['/bin/ps'], lsof: ['/usr/sbin/lsof'], pgrep: ['/usr/bin/pgrep'] },
  linux: {
    ps: ['/usr/bin/ps', '/bin/ps'],
    lsof: ['/usr/bin/lsof', '/usr/sbin/lsof', '/sbin/lsof'],
    pgrep: ['/usr/bin/pgrep', '/bin/pgrep'],
  },
};

function systemExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves only the platform's fixed candidates. The last two parameters let a scene model a
 *  platform with a missing system tool without changing the machine's files or environment. */
export function trustedProcessToolPath(
  tool: ProcessTool,
  platform: string = process.platform,
  usable: (path: string) => boolean = systemExecutable,
): string | null {
  return SYSTEM_TOOLS[platform]?.[tool]?.find(usable) ?? null;
}

// A fresh allowlist, never a filtered copy of process.env. Fixed UTC makes start-time evidence
// independent of a caller's TZ; readers interpret those columns as UTC too. No inherited PATH,
// loader variables, HOME, personal configuration, or command-specific environment reaches it.
function processToolEnv(): NodeJS.ProcessEnv {
  return { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
}

type SyncOptions = Omit<ExecFileSyncOptionsWithStringEncoding, 'env' | 'cwd' | 'shell'>;
type SpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'env' | 'cwd' | 'shell'>;
type AsyncOptions = Omit<ExecFileOptionsWithStringEncoding, 'env' | 'cwd' | 'shell'>;
export type TrustedProcessToolPaths = Readonly<Partial<Record<ProcessTool, readonly string[]>>>;

/** The adapter seam for synthetic missing-tool scenes. Production uses only SYSTEM_TOOLS;
 *  neither its candidate set nor its usability check comes from a caller or environment. */
export function createProcessToolsAdapter(
  candidates: TrustedProcessToolPaths = SYSTEM_TOOLS[process.platform] ?? {},
  usable: (path: string) => boolean = systemExecutable,
) {
  function requireTool(tool: ProcessTool): string {
    const path = candidates[tool]?.find(usable);
    if (path !== undefined) return path;
    throw Object.assign(new Error(`the trusted process tool ${tool} is unavailable`), { code: 'ENOENT' });
  }
  return {
    /** Missing trusted tools throw; evidence readers catch that as unreadable, never a match. */
    execSync(tool: ProcessTool, args: string[], options: SyncOptions): string {
      return traceBeatWork(`process read (sync):${tool}`, () => execFileSync(requireTool(tool), args, {
        ...options, encoding: 'utf8', env: processToolEnv(), cwd: '/', shell: false,
      }));
    },
    /** The status-reading variant, with the same executable and environment boundary. */
    spawnSync(tool: ProcessTool, args: string[], options: SpawnOptions): SpawnSyncReturns<string> {
      return traceBeatWork(`process read (sync):${tool}`, () => spawnSync(requireTool(tool), args, {
        ...options, encoding: 'utf8', env: processToolEnv(), cwd: '/', shell: false,
      }));
    },
    /** The asynchronous variant keeps the caller's deadline and stop signal. */
    exec(
      tool: ProcessTool,
      args: string[],
      options: AsyncOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ): void {
      execFile(requireTool(tool), args, {
        ...options, encoding: 'utf8', env: processToolEnv(), cwd: '/', shell: false,
      }, callback);
    },
  };
}

const systemProcessTools = createProcessToolsAdapter();
export const execProcessToolSync = systemProcessTools.execSync;
export const spawnProcessToolSync = systemProcessTools.spawnSync;
export const execProcessTool = systemProcessTools.exec;
