import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { execText, wasAborted, wasKilled, type ChildOptions } from './child.ts';
import { resolveForgeShim } from './settings/forge-shim.ts';
import { assertNoLink, tomlString, writePrivate } from './launch/private-file.ts';

// The only module that talks to herdr. Reading is the default. The calls that change a session
// are `startServer`, `workspaceCreate`, `paneRun`, `agentRename`, `workspaceClose`, `sessionStop`,
// `sessionDelete`, `typeText` and `pressEnter`. `team` deletes a session in one case only:
// `down` clears the session it has itself just stopped, in the same run; `up` never deletes one.

export type HerdrAgent = {
  name: string | null;
  agent: string | null;
  pane: string;
  workspace: string;
  status: string;
  cwd: string | null;
  /** Herdr's `agent_session`, when the integration reported one. Absent when it did not: an
   *  older build sent the id string, and 0.7.1 sends `{agent, kind, source, value}` with
   *  `kind: 'id'`, whose `value` is that same id. Either shape is read to the id; any other
   *  shape is left unread. */
  session?: string;
  /**
   * Sidebar line 2 as herdr holds it, when it holds one: the text `reportDisplayAgent` wrote
   * under the `team` source. Absent on a pane whose display was never reported. `agent list`
   * returns it beside the other fields (probed 2026-10-17 against herdr 0.7.1).
   */
  displayAgent?: string;
};

export type HerdrRun = (args: string[], session?: string) => unknown;
let customRun: HerdrRun | null = null;
export function setHerdrRun(exec: HerdrRun | null): void {
  customRun = exec;
}

function run(args: string[], session?: string): unknown {
  if (customRun) return customRun(args, session);
  const full = session ? ['--session', session, ...args] : args;
  const out = execFileSync('herdr', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  return (JSON.parse(out) as { result?: unknown }).result;
}

/** What one async read takes: the child's own kill after `timeoutMs`, and the loop's stop. */
export type HerdrReadOptions = ChildOptions;

async function runAsync(args: string[], session: string | undefined, options: HerdrReadOptions): Promise<unknown> {
  if (customRun) return customRun(args, session);
  const full = session ? ['--session', session, ...args] : args;
  const out = await execText('herdr', full, options);
  return (JSON.parse(out) as { result?: unknown }).result;
}

// The agent session herdr reported, as the id alone. Herdr 0.7.1 sends an object —
// `{agent, kind, source, value}` with `kind: 'id'` — where older builds sent the id string.
// Only a non-empty string, or that object's non-empty string `value` under `kind: 'id'`, is a
// session id: another kind names something else entirely (a pid, a ticket), and an object of
// any other shape is not one either, so neither is coerced into an id. An unreadable shape
// leaves the session unknown, the same reading a herdr that reported none gives.
function agentSessionOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const reported = value as Record<string, unknown>;
  if (reported.kind !== 'id') return undefined;
  return typeof reported.value === 'string' && reported.value !== '' ? reported.value : undefined;
}

// The agents a `agent list` result names, in its order. One parser for the sync and async reads.
function agentsOf(result: unknown): HerdrAgent[] {
  return (((result as { agents?: Record<string, unknown>[] })?.agents) ?? []).map((agent) => {
    const session = agentSessionOf(agent.agent_session);
    const displayAgent = typeof agent.display_agent === 'string' && agent.display_agent ? agent.display_agent : undefined;
    return {
      name: typeof agent.name === 'string' && agent.name ? agent.name : null,
      agent: typeof agent.agent === 'string' ? agent.agent : null,
      pane: String(agent.pane_id),
      workspace: String(agent.workspace_id),
      status: typeof agent.agent_status === 'string' ? agent.agent_status : 'unknown',
      cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
      ...(session ? { session } : {}),
      ...(displayAgent ? { displayAgent } : {}),
    };
  });
}

// The agents herdr lists, or null when herdr can't be reached.
export function agentList(session?: string): HerdrAgent[] | null {
  try {
    return agentsOf(run(['agent', 'list'], session));
  } catch {
    return null;
  }
}

/** The same read, awaited: the child is killed at `timeoutMs` or at the loop's stop. */
export async function agentListAsync(session: string | undefined, options: HerdrReadOptions = {}): Promise<HerdrAgent[] | null> {
  try {
    return agentsOf(await runAsync(['agent', 'list'], session, options));
  } catch {
    return null;
  }
}

// The pid of a pane's root process, or null. Always by `--pane`: herdr 0.7.1's `--current`
// answered for another pane than the caller's.
export function paneRootPid(pane: string, session?: string): number | null {
  try {
    const result = run(['pane', 'process-info', '--pane', pane], session) as { process_info?: { shell_pid?: unknown } };
    const pid = result.process_info?.shell_pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

// argv0 of each foreground process, in herdr's order, or null when the pane can't be
// read. `name` is not the process: a Claude entry's name is its version. After a CLI
// exits, herdr keeps the pane and the foreground process is the shell.
export function foregroundArgv0(result: unknown): string[] | null {
  const list = (result as { process_info?: { foreground_processes?: { argv0?: unknown }[] } } | null)
    ?.process_info?.foreground_processes;
  if (!Array.isArray(list)) return null;
  return list.map((proc) => (typeof proc?.argv0 === 'string' ? proc.argv0 : ''));
}

export function paneForeground(pane: string, session?: string): string[] | null {
  try {
    return foregroundArgv0(run(['pane', 'process-info', '--pane', pane], session));
  } catch {
    return null;
  }
}

// The folder a pane's foreground program works in — `pane get`'s `foreground_cwd` — or null
// when herdr can't be reached or does not report one. Captured from herdr 0.7.1 in a scratch
// session: a pane whose CLI was started in a folder reports that folder byte for byte, a
// trailing space included; the field follows the program's live folder (one that chdir'd to
// /tmp reported /private/tmp) where the pane's `cwd` keeps the folder it was started in.
export function paneForegroundCwd(pane: string, session?: string): string | null {
  try {
    const result = run(['pane', 'get', pane], session) as { pane?: { foreground_cwd?: unknown } };
    const cwd = result.pane?.foreground_cwd;
    return typeof cwd === 'string' ? cwd : null;
  } catch {
    return null;
  }
}

// Whether a pane's foreground program is back to the shell, from a `pane process-info` result:
// true when a foreground process is the pane's own shell process, false when none is, and null
// when herdr can't say — no process info, no `shell_pid` (an older herdr), an empty or
// unreadable list. Never read from argv0 alone: a `zsh script.sh` child shares the pane shell's
// argv0 and is not the shell. Captured from herdr 0.7.1: a pane at its shell reports one
// foreground process whose pid is `shell_pid`; a pane running a program reports the program's
// pid, not the shell's.
export function shellBackOf(result: unknown): boolean | null {
  const info = (result as { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown }[] } } | null)
    ?.process_info;
  if (!info || typeof info.shell_pid !== 'number') return null;
  const list = info.foreground_processes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const pids = list.map((proc) => (typeof proc?.pid === 'number' ? proc.pid : null));
  if (pids.some((pid) => pid === null)) return null;
  return pids.includes(info.shell_pid);
}

export function paneShellBack(pane: string, session?: string): boolean | null {
  try {
    return shellBackOf(run(['pane', 'process-info', '--pane', pane], session));
  } catch {
    return null;
  }
}

// A pane's process identity as `pane process-info` reports it: the pane's own shell process and
// the foreground processes herdr lists, as pids. Pids only: never an argv, an argument or an
// environment, which can hold secrets.
export type PaneProcesses = { shell: number; foreground: number[] };

/** A `pane process-info` result as process pids, or null when herdr can't say: no `shell_pid`
 *  (an older herdr), no foreground list, an entry without a pid, an empty list. */
export function paneProcessesOf(result: unknown): PaneProcesses | null {
  const info = (result as { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown }[] } } | null)
    ?.process_info;
  if (!info || typeof info.shell_pid !== 'number') return null;
  const list = info.foreground_processes;
  if (!Array.isArray(list) || list.length === 0) return null;
  const pids = list.map((proc) => (typeof proc?.pid === 'number' ? proc.pid : null));
  if (pids.some((pid) => pid === null)) return null;
  return { shell: info.shell_pid, foreground: pids as number[] };
}

export function paneProcesses(pane: string, session?: string): PaneProcesses | null {
  try {
    return paneProcessesOf(run(['pane', 'process-info', '--pane', pane], session));
  } catch {
    return null;
  }
}

/**
 * One `pane process-info` result, untouched: the page both the pane's process identity and its
 * foreground names are read from, so a pass asks the terminal host once for the pane.
 */
export function paneProcessInfo(pane: string, session?: string): unknown | null {
  try {
    return run(['pane', 'process-info', '--pane', pane], session);
  } catch {
    return null;
  }
}

/** The same read, awaited: the child is killed at `timeoutMs` or at the loop's stop. */
export async function paneProcessInfoAsync(pane: string, session: string | undefined, options: HerdrReadOptions = {}): Promise<unknown | null> {
  try {
    return await runAsync(['pane', 'process-info', '--pane', pane], session, options);
  } catch {
    return null;
  }
}

/** The pane's process identity, awaited: the same parser `paneProcesses` applies to the same
 *  call. Null when herdr can't tell. */
export async function paneProcessesAsync(pane: string, session: string | undefined, options: HerdrReadOptions = {}): Promise<PaneProcesses | null> {
  return paneProcessesOf(await paneProcessInfoAsync(pane, session, options));
}

export type HerdrWorkspace = { id: string; label: string };

function workspacesOf(result: unknown): HerdrWorkspace[] {
  return (((result as { workspaces?: Record<string, unknown>[] })?.workspaces) ?? []).map((workspace) => ({
    id: String(workspace.workspace_id),
    label: typeof workspace.label === 'string' ? workspace.label : '',
  }));
}

export function workspaceList(session?: string): HerdrWorkspace[] | null {
  try {
    return workspacesOf(run(['workspace', 'list'], session));
  } catch {
    return null;
  }
}

/** The same read, awaited: the child is killed at `timeoutMs` or at the loop's stop. */
export async function workspaceListAsync(session: string | undefined, options: HerdrReadOptions = {}): Promise<HerdrWorkspace[] | null> {
  try {
    return workspacesOf(await runAsync(['workspace', 'list'], session, options));
  } catch {
    return null;
  }
}

export type WorkspacePaneDisplay = {
  pane: string;
  workspace: string;
  /** Sidebar line 2 as herdr holds it on the pane row; absent when never reported or expired. */
  displayAgent?: string;
};

// The panes in a workspace and the display_agent herdr holds for each, or null when herdr can't
// be reached or the workspace does not exist. Every entry must be an object with a string pane_id
// and a workspace_id equal to the workspace asked for; anything else makes the whole reading
// unreadable (null). Probed 2026-11-04 against herdr 0.9.5: `pane list --workspace <id>` carries
// `display_agent` while the TTL holds and omits the field once it lapses.
export function workspacePaneDisplays(workspace: string, session?: string): WorkspacePaneDisplay[] | null {
  try {
    const result = run(['pane', 'list', '--workspace', workspace], session) as { panes?: unknown } | undefined;
    if (!result || typeof result !== 'object' || !Array.isArray(result.panes)) return null;
    const panes: WorkspacePaneDisplay[] = [];
    for (const entry of result.panes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const p = entry as Record<string, unknown>;
      if (typeof p.pane_id !== 'string' || !p.pane_id) return null;
      if (typeof p.workspace_id !== 'string' || p.workspace_id !== workspace) return null;
      const displayAgent = typeof p.display_agent === 'string' && p.display_agent !== '' ? p.display_agent : undefined;
      panes.push({
        pane: p.pane_id,
        workspace: p.workspace_id,
        ...(displayAgent !== undefined ? { displayAgent } : {}),
      });
    }
    return panes;
  } catch {
    return null;
  }
}

// The pane ids in a workspace, or null when herdr can't be reached or the workspace does not exist.
// Every entry must be an object with a string pane_id and a workspace_id equal to the workspace asked for;
// anything else makes the whole reading unreadable (null).
export function workspacePanes(workspace: string, session?: string): string[] | null {
  return workspacePaneDisplays(workspace, session)?.map((entry) => entry.pane) ?? null;
}

export type SessionState = 'running' | 'stopped' | 'absent';

export type HerdrSession = {
  name: string;
  running: boolean;
  /** `<session_dir>` from the list, or null when herdr did not name one. */
  sessionDir: string | null;
  /** `<socket_path>` from the list, or null when herdr did not name one. */
  socketPath?: string | null;
};

// Every session herdr lists, or null when herdr can't be asked. Herdr 0.7.1, captured on a scratch
// session `list-probe-b1`: `herdr session list --json` prints one JSON object, not the `{id, result}`
// wrapper the socket commands use —
// `{"sessions":[{"default":false,"name":"list-probe-b1","running":true,"session_dir":"…/sessions/list-probe-b1","socket_path":"…/herdr.sock"}]}`.
// `herdr session stop list-probe-b1` leaves that object listed with `"running":false`.
// `herdr session delete list-probe-b1` prints `deleted session list-probe-b1\n` and the name is then
// absent. While the session exists, `<session_dir>/session.json` holds `workspaces[].identity_cwd`,
// the workspace folder's real path (`/tmp` was `/private/tmp` for a workspace created `--cwd /tmp`).
// `herdr --session list-probe-b1 agent list` prints
// `{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}` before any seat is named;
// after `agent rename` the one agent carried `name`, `agent_status` (`unknown` for that new seat),
// `cwd`, `pane_id` and `workspace_id`.
// A `session list --json` body as sessions, or null when the document is not that list. One
// parser for the sync and async reads.
function sessionsOf(out: string): HerdrSession[] | null {
  const body = JSON.parse(out) as { sessions?: unknown };
  // A missing list is no sessions. Anything else that is not an array is not this document.
  if (body.sessions === undefined || body.sessions === null) return [];
  if (!Array.isArray(body.sessions)) return null;
  const listed: HerdrSession[] = [];
  for (const entry of body.sessions) {
    if (!entry || typeof entry !== 'object') continue;
    const session = entry as { name?: unknown; running?: unknown; session_dir?: unknown; socket_path?: unknown };
    if (typeof session.name !== 'string' || session.name === '') continue;
    listed.push({
      name: session.name,
      running: session.running === true,
      sessionDir: typeof session.session_dir === 'string' ? session.session_dir : null,
      socketPath: typeof session.socket_path === 'string' ? session.socket_path : null,
    });
  }
  return listed;
}

export function sessionList(): HerdrSession[] | null {
  try {
    const out = execFileSync('herdr', ['session', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return sessionsOf(out);
  } catch {
    return null;
  }
}

/** The same read, awaited: the child is killed at `timeoutMs` or at the loop's stop. */
export async function sessionListAsync(options: HerdrReadOptions = {}): Promise<HerdrSession[] | null> {
  try {
    return sessionsOf(await execText('herdr', ['session', 'list', '--json'], options));
  } catch {
    return null;
  }
}

/** Whether the named session runs, awaited. Null when herdr can't be reached. */
export async function sessionRunningAsync(name: string, options: HerdrReadOptions = {}): Promise<boolean | null> {
  const sessions = await sessionListAsync(options);
  if (sessions === null) return null;
  const found = sessions.find((session) => session.name === name);
  return found === undefined ? false : found.running;
}

// Whether a session exists and runs. A stopped session stays listed with running false; a deleted
// one is absent. Null when herdr can't be reached. "default" is herdr's own.
export function sessionState(name: string): SessionState | null {
  const sessions = sessionList();
  if (sessions === null) return null;
  const found = sessions.find((session) => session.name === name);
  if (!found) return 'absent';
  return found.running ? 'running' : 'stopped';
}

// Whether a session exists and runs: null when herdr can't be reached.
export function sessionRunning(name: string): boolean | null {
  const state = sessionState(name);
  return state === null ? null : state === 'running';
}

// The process call behind the metadata calls, injectable for tests (the paneExec shape): it
// returns the call's stdout and throws when herdr exits non-zero or the call times out.
export type CaptureExec = (args: string[]) => string;
const shellCaptureExec: CaptureExec = (args) =>
  execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
let captureExec: CaptureExec = shellCaptureExec;

/** Swaps the process call the metadata calls make; null restores the real one. */
export function setCaptureExec(exec: CaptureExec | null): void {
  captureExec = exec ?? shellCaptureExec;
}

// What a herdr command printed, or null when it did not run. Exit status is not the answer: a
// command aimed at a session that does not exist can print an error and exit 0.
function capture(args: string[], session?: string): string | null {
  const full = [...(session ? ['--session', session] : []), ...args];
  try {
    return captureExec(full);
  } catch {
    return null;
  }
}

export type HerdrEnvelope = { id?: string; type?: string; error?: unknown; result?: unknown };

function parsed(out: string): HerdrEnvelope | null {
  try {
    return JSON.parse(out) as HerdrEnvelope;
  } catch {
    return null;
  }
}

export function isHerdrError(body: HerdrEnvelope | null): boolean {
  if (!body) return false;
  return body.type === 'error' || (body.error !== undefined && body.error !== null);
}

function resultOf(args: string[], session?: string): unknown | null {
  const out = capture(args, session);
  if (out === null) return null;
  const body = parsed(out);
  if (!body || isHerdrError(body)) return null;
  return body.result ?? null;
}

const SERVER_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG'] as const;

/** The forge CLI a credential helper calls by name. The session's shim has to carry that name:
 *  it is the CLI's, not ours. */
const FORGE_CLI = 'gh';

/** The shim's one refusal line, on stderr. It names no value and reads none: the check below
 *  tests whether the variable holds a value, never what it holds. */
export const NO_SEAT_TOKEN = 'team: no seat token in this environment; the account login stored on this machine is not used from a seat';

/** `<home>/.config/team/bin`, the session server's own programs, ahead of every other folder. */
export function sessionBinDir(home: string): string {
  return join(home, '.config', 'team', 'bin');
}

/** The first executable of that name on a PATH value, skipping `skip` — the shim's own folder,
 *  so a server started from inside another session never chooses the shim as the real CLI. A
 *  folder of that name is not it: the helper runs a program. */
function forgeOnPath(pathValue: string | undefined, skip: string): string | null {
  if (pathValue === undefined) return null;
  for (const dir of pathValue.split(':')) {
    // Only an absolute folder names a program this process can point at by path: an empty entry
    // is the working folder, and a relative one resolves against a folder the shim never bound.
    if (!isAbsolute(dir) || dir === skip) continue;
    const candidate = join(dir, FORGE_CLI);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here; the next folder
    }
  }
  return null;
}

function shimQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** The shim's text. It runs the real CLI only when the seat-token variable holds a non-empty
 *  value, and it never
 *  expands, prints or forwards the value: the real CLI execs with the environment as it is. Without
 *  a token the helper reaches no stored login, so a seat cannot inherit the shared account's
 *  broader access by pushing without one. */
export function forgeShimText(real: string): string {
  return [
    '#!/bin/sh',
    "# Written by team for this session's server.",
    '# The forge CLI runs only with a seat token in the environment; without one this refuses,',
    '# so no credential helper and no command reaches the account login stored on this machine.',
    '# The value is never read, printed or forwarded: the real CLI execs with the environment as',
    '# it is.',
    'case ${GH_TOKEN:+x} in',
    `  '') echo "${NO_SEAT_TOKEN}" >&2; exit 1 ;;`,
    'esac',
    `exec ${shimQuote(real)} "$@"`,
    '',
  ].join('\n');
}

/** Writes the shim when it is absent or names another real CLI: a fresh file created executable
 *  and renamed into place, so no reader ever sees half of it. Only a real folder and a real file
 *  are the shim's own: a linked folder would put the program outside it, and a linked file — even
 *  one holding matching text — is not the file this folder holds. The temporary name is fresh and
 *  created exclusively, so a pre-created link cannot be followed. False when it could not be
 *  written; the caller then closes the fallback rather than leaving the environment as it was. */
export function writeForgeShim(dir: string, real: string): boolean {
  const file = join(dir, FORGE_CLI);
  const text = forgeShimText(real);
  try {
    const state = lstatSync(dir);
    if (state.isSymbolicLink() || !state.isDirectory()) return false;
  } catch (error) {
    // Only a folder that is not there yet is made below; any other answer is not ours to write to.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    if (lstatSync(file).isFile() && readFileSync(file, 'utf8') === text) return true;
  } catch {
    // absent or unreadable: write it
  }
  let temp: string | null = null;
  let handle: number | null = null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const state = lstatSync(dir);
    if (state.isSymbolicLink() || !state.isDirectory()) return false;
    temp = join(dir, `${FORGE_CLI}.${randomUUID()}.tmp`);
    handle = openSync(temp, 'wx', 0o755);
    writeFileSync(handle, text);
    fchmodSync(handle, 0o755);
    closeSync(handle);
    handle = null;
    renameSync(temp, file);
    temp = null;
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // the descriptor is already gone
      }
    }
    if (temp !== null) {
      try {
        unlinkSync(temp);
      } catch {
        // nothing was created, or the rename took it
      }
    }
  }
}

/** Whether the folder holds an executable forge CLI. A folder that cannot be inspected proves
 *  nothing, and is not kept. */
function holdsForge(dir: string): boolean {
  try {
    if (!statSync(join(dir, FORGE_CLI)).isFile()) return false;
    accessSync(join(dir, FORGE_CLI), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute system folders a shell finds its own tools in. A server that cannot keep the
 *  shim keeps only the ones proven free of the forge CLI. */
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

/** The PATH a server may keep when the shim cannot stand first: absolute folders only — never
 *  the working folder (an empty entry) and never a relative one, which a shell resolves against
 *  a folder the shim does not control — and no folder that holds an executable forge CLI. When
 *  no folder is kept, the system folders are tried instead. `null` is the refusal: an empty
 *  PATH is not a denial, because a shell reads it as the working folder, so the caller must not
 *  start the server at all. `holds` is injected so a test can prove the refusal without making
 *  every system folder hold a CLI. */
export function failClosedPath(pathValue: string, holds: (dir: string) => boolean = holdsForge): string | null {
  const kept = pathValue.split(':').filter((dir) => isAbsolute(dir) && !holds(dir));
  if (kept.length > 0) return kept.join(':');
  const safe = SYSTEM_PATH.filter((dir) => !holds(dir));
  return safe.length > 0 ? safe.join(':') : null;
}

/** The session server's environment: the clean allowlist, the SSH agent when the owner has one,
 *  and the session's own folder first on PATH. When that PATH also holds the real forge CLI and
 *  the machine's `forge-shim` setting is on (its default), the shim is written into the folder
 *  first on it; a PATH without the CLI is left unchanged, because the helper's own call fails
 *  there anyway. The setting is a mechanism, not a wall: `off` leaves the environment as it was. */
export function seatServerEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const name of SERVER_ENV) {
    const value = env[name];
    if (value !== undefined) clean[name] = value;
  }
  if (env.SSH_AUTH_SOCK) clean.SSH_AUTH_SOCK = env.SSH_AUTH_SOCK;
  if (!resolveForgeShim({ home, env }).on) return clean;
  const dir = sessionBinDir(home);
  const real = forgeOnPath(env.PATH, dir);
  if (real === null) return clean;
  if (writeForgeShim(dir, real)) {
    clean.PATH = clean.PATH === undefined ? dir : `${dir}:${clean.PATH}`;
    return clean;
  }
  // Fail closed: the shim cannot stand first, so no folder that holds the real CLI stays on the
  // server's PATH — and never an empty or relative one, which a shell reads as the working
  // folder. When no folder is proven free of the CLI, no environment is safe to start in, and
  // the throw is the refusal `startServer` turns into a plain "it did not start".
  const safe = failClosedPath(clean.PATH ?? '');
  if (safe === null) {
    throw new Error('the forge shim could not be installed and no PATH folder is free of the forge CLI; the session server was not started');
  }
  clean.PATH = safe;
  return clean;
}

// Starts a session's server in a clean environment, with the session's own folder first on PATH
// so the forge shim stands ahead of the machine's CLI (see `seatServerEnv`). Refuses unless the
// session is absent: a second server for a session that already runs has been seen to drop it.
export function startServer(session: string): boolean {
  if (sessionState(session) !== 'absent') return false;
  let env: NodeJS.ProcessEnv;
  try {
    env = seatServerEnv(process.env, homedir());
  } catch {
    // No safe environment can be built: a server started with an empty or forge-bearing PATH
    // would hand the seat the fallback the shim exists to close. The caller says it did not start.
    return false;
  }
  const args = session === 'default' ? ['server'] : ['--session', session, 'server'];
  try {
    const child = spawn('herdr', args, { env, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Sets a workspace's label, which herdr draws as sidebar line 1. `herdr workspace rename --help`
// names the two arguments and no flags. False when herdr doesn't answer or reports an error.
export function workspaceRename(workspace: string, label: string, session?: string): boolean {
  const out = capture(['workspace', 'rename', workspace, label], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || !isHerdrError(body);
}

export function workspaceCreate(
  cwd: string,
  label: string,
  session?: string,
): { pane: string; workspace: string } | null {
  const result = resultOf(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus'], session) as {
    root_pane?: { pane_id?: unknown };
    workspace?: { workspace_id?: unknown };
  } | null;
  const pane = result?.root_pane?.pane_id;
  const workspace = result?.workspace?.workspace_id;
  if (typeof pane !== 'string' || typeof workspace !== 'string') return null;
  return { pane, workspace };
}

// Types a command into a pane and sends it. For a seat's launch, at a shell. An exit into an
// agent is `typeText` and then `pressEnter`, and only after the screen was read as idle again.
export function paneRun(pane: string, command: string, session?: string): boolean {
  const out = capture(['pane', 'run', pane, command], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || !isHerdrError(body);
}

// The id team reports a pane's display_agent under. Herdr 0.7.1 requires `--source`; nothing
// else in this tree is a source id (`pane read --source visible` is the screen, not this).
export const DISPLAY_AGENT_SOURCE = 'team';

// Sets the pane's display_agent (sidebar line 2). Herdr 0.7.1, scratch session title-help-b1:
// `pane report-metadata --help` exits 2 with `missing required --source`. The flags used here
// are the ones `herdr pane --help` names for this call: `--source` and `--display-agent`.
// Herdr 0.9.5 added `--ttl-ms`: a display line reported once lapses when its TTL does, so
// callers pass one (capped below) and the chores pass re-reports before it runs out.
export const SIDEBAR_TTL_CAP_MS = 86_400_000;

// A TTL above the cap is not sent: herdr answers `invalid_metadata_ttl` one above it (probed
// 2026-11-04, scratch session). The policy layer clamps before this, and the adapter still
// refuses what the host would refuse.
export function reportDisplayAgent(pane: string, text: string, session?: string, ttlMs?: number): boolean {
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > SIDEBAR_TTL_CAP_MS)) {
    return false;
  }
  const args = ['pane', 'report-metadata', pane, '--source', DISPLAY_AGENT_SOURCE, '--display-agent', text];
  if (ttlMs !== undefined) args.push('--ttl-ms', String(ttlMs));
  const out = capture(args, session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || !isHerdrError(body);
}

// ── The sidebar layout keys team owns in the host's config ──────────────────────────────────
//
// Two keys, one edit: the sidebar table `ui.sidebar.agents.rows` — a block team owns whole once
// marked — and the `[ui]` key `status_indicators`, owned at the assignment line because `[ui]`
// is a table the owner fills with other keys. Ownership is marked by the same trailing comment
// in both places. Everything else in the owner's file is preserved byte-for-byte, and the write
// is validated through the host and rolled back from bytes held in memory before the rename.

/** The closed token vocabulary the sidebar layout accepts (probed 2026-11-04, herdr 0.9.5). */
export const SIDEBAR_TOKENS = ['state_icon', 'machine', 'workspace', 'tab', 'state_text', 'agent'] as const;

/** Today's layout: the release default for `workspace.sidebar.rows`. */
export const DEFAULT_SIDEBAR_ROWS: readonly (readonly string[])[] = [
  ['state_icon', 'machine', 'workspace', 'tab'],
  ['state_text', 'agent'],
];

/** The status-indicator vocabulary the host enforces: `config check` on any other word answers
 *  `unknown variant ... expected 'dots' or 'symbols'` (probed 2026-11-04, scratch HOME). */
export const STATUS_INDICATOR_VALUES = ['dots', 'symbols'] as const;

/** The trailing comment that marks what team owns: the sidebar table's header, and the
 *  `status_indicators` assignment line inside `[ui]`. */
export const SIDEBAR_BLOCK_MARKER = '# managed by team';

const SIDEBAR_TABLE = 'ui.sidebar.agents';
const UI_TABLE = 'ui';

/** The config file (poison-file-probed 2026-11-04): XDG — `$XDG_CONFIG_HOME/herdr/config.toml`,
 *  else `~/.config/herdr/config.toml`. */
export function hostConfigPath(home: string = homedir()): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(base, 'herdr', 'config.toml');
}

// A table header line: `[name]` with, at most, a trailing comment. A value line can also start
// with `[` — a multiline array's continuation — but carries quotes, commas or spaces inside the
// brackets, which a plain table name never does. A commented line never matches: it starts with
// `#`, not `[`. (A table name with quoted segments would read as content, not a header; the
// host's own check then refuses the result and the write rolls back.)
type HeaderLine = { name: string; comment: string | null };

function headerOf(line: string): HeaderLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return null;
  const close = trimmed.indexOf(']');
  if (close < 0) return null;
  const name = trimmed.slice(1, close);
  if (name.length === 0 || /[\[\]"',\s]/.test(name)) return null;
  const rest = trimmed.slice(close + 1).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;
  return { name, comment: rest === '' ? null : rest };
}

// An uncommented `key =` line between from (inclusive) and until (exclusive), by the anchored
// pattern the pretrust splice already uses: `# key = ...` trims to a `#` and cannot match.
function assignmentAt(lines: string[], from: number, until: number, key: string): number {
  const pattern = new RegExp(`^${key}\\s*=`);
  for (let index = from; index < until; index++) {
    if (pattern.test((lines[index] ?? '').trim())) return index;
  }
  return -1;
}

// An uncommented dotted `a.b = ` line anywhere in the file: the same key written without its
// table. Splicing a table in beside it would define the key twice, so it is refused.
function dottedKeyAt(lines: string[], key: string): number {
  const pattern = new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=`);
  for (let index = 0; index < lines.length; index++) {
    if (pattern.test((lines[index] ?? '').trim())) return index;
  }
  return -1;
}

// The table's span: from its header to the next header line, ending at the last non-blank line
// before it — trailing blank lines belong to the file, not the table.
function tableSpan(lines: string[], headerAt: number): { start: number; end: number } {
  let next = lines.length;
  for (let index = headerAt + 1; index < lines.length; index++) {
    if (headerOf(lines[index] ?? '') !== null) {
      next = index;
      break;
    }
  }
  let end = headerAt;
  while (end + 1 < next && (lines[end + 1] ?? '').trim() !== '') end++;
  return { start: headerAt, end };
}

// Where an assignment's value ends: balanced brackets from the `=`, within the table's span.
// Null when the brackets never close or the value opens an inline table: that value is not ours
// to bound, and the write refuses it for the owner to edit by hand. (Bracket characters inside
// quoted strings would miscount; the host's own check refuses a misdelimited result and the
// write rolls back, so the worst case is a refused edit, never a silent corruption.)
function valueSpan(lines: string[], at: number, until: number): { start: number; end: number } | null {
  const first = (lines[at] ?? '').trim();
  const remainder = first.slice(first.indexOf('=') + 1).trim();
  if (remainder.startsWith('{')) return null;
  if (!remainder.startsWith('[')) return { start: at, end: at };
  let depth = 0;
  for (let index = at; index < until; index++) {
    const line = index === at ? remainder : (lines[index] ?? '').trim();
    for (const ch of line) {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }
    if (depth <= 0) return { start: at, end: index };
  }
  return null;
}

// Appends a table at end-of-file. A file that ends mid-line gets one blank line before the
// table; a file that already ends with a newline reuses that trailing element as the
// separation; and a file with blank lines of its own at the end keeps them as they stand.
// (A text ending `x\n` splits with one trailing `''` that already reads as the blank line —
// pushing another would double it.)
function appendLines(lines: string[], added: readonly string[]): void {
  if (lines.length === 0) {
    lines.push(...added, '');
    return;
  }
  let blanks = 0;
  while (blanks < lines.length && lines[lines.length - 1 - blanks] === '') blanks++;
  if (blanks === lines.length) {
    lines.length = 0;
    lines.push(...added, '');
    return;
  }
  if (blanks === 0) lines.push('', ...added, '');
  else lines.push(...added, '');
}

/** The pure splice: the marked sidebar table and the marked `[ui]` key, one pass. A table or
 *  key whose marker is present is replaced whole; one without it is adopted — the value is
 *  spliced in place and the marker is added — never clobbered. Anchors match uncommented lines
 *  only, and everything outside the spliced span is preserved byte-for-byte; a splice that
 *  changes nothing reads back equal (`changed: false`). */
export type SidebarSplice =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: string };

export function spliceSidebarRows(
  text: string,
  rows: readonly (readonly string[])[],
  indicators: string,
): SidebarSplice {
  const rowsValue = `[${rows.map((row) => `[${row.map(tomlString).join(', ')}]`).join(', ')}]`;
  const markedTable = [`[${SIDEBAR_TABLE}] ${SIDEBAR_BLOCK_MARKER}`, `rows = ${rowsValue}`];
  const uiLine = `status_indicators = ${tomlString(indicators)} ${SIDEBAR_BLOCK_MARKER}`;
  const lines = text === '' ? [] : text.split('\n');

  // The anchors are located before anything moves, and both dotted refusals are settled before
  // a single line is appended: a splice that refuses never rewrote the text it was handed.
  const tableAt = lines.findIndex((line) => headerOf(line)?.name === SIDEBAR_TABLE);
  const uiAt = lines.findIndex((line) => headerOf(line)?.name === UI_TABLE);
  if (tableAt < 0) {
    const dotted = dottedKeyAt(lines, 'ui.sidebar.agents.rows');
    if (dotted >= 0) {
      return { ok: false, reason: `the sidebar rows key is set as a dotted key at line ${String(dotted + 1)}; edit it by hand` };
    }
  }
  if (uiAt < 0) {
    const dotted = dottedKeyAt(lines, 'ui.status_indicators');
    if (dotted >= 0) {
      return { ok: false, reason: `the status indicators key is set as a dotted key at line ${String(dotted + 1)}; edit it by hand` };
    }
  }

  if (tableAt < 0 && uiAt < 0) {
    // Both keys are appended in one pass, one blank line between the two tables.
    appendLines(lines, [...markedTable, '', `[${UI_TABLE}]`, uiLine]);
  } else {
    // The sidebar table.
    if (tableAt < 0) {
      appendLines(lines, markedTable);
    } else {
      const header = headerOf(lines[tableAt] ?? '') as HeaderLine;
      const span = tableSpan(lines, tableAt);
      if (header.comment !== null && header.comment.includes(SIDEBAR_BLOCK_MARKER)) {
        lines.splice(span.start, span.end - span.start + 1, ...markedTable);
      } else {
        lines[tableAt] = `[${SIDEBAR_TABLE}] ${SIDEBAR_BLOCK_MARKER}`;
        const at = assignmentAt(lines, span.start + 1, span.end + 1, 'rows');
        if (at >= 0) {
          const spanned = valueSpan(lines, at, span.end + 1);
          if (spanned === null) {
            return { ok: false, reason: 'the rows value cannot be bounded; edit it by hand' };
          }
          lines.splice(spanned.start, spanned.end - spanned.start + 1, `rows = ${rowsValue}`);
        } else {
          lines.splice(tableAt + 1, 0, `rows = ${rowsValue}`);
        }
      }
    }

    // The status indicators, in the shared [ui] table — its anchor is found again here,
    // because the sidebar work above may have shifted every line below it.
    const uiNow = lines.findIndex((line) => headerOf(line)?.name === UI_TABLE);
    if (uiNow < 0) {
      appendLines(lines, [`[${UI_TABLE}]`, uiLine]);
    } else {
      const span = tableSpan(lines, uiNow);
      const at = assignmentAt(lines, span.start + 1, span.end + 1, 'status_indicators');
      if (at >= 0) {
        lines[at] = uiLine;
      } else {
        lines.splice(uiNow + 1, 0, uiLine);
      }
    }
  }

  const next = lines.join('\n');
  return { ok: true, text: next, changed: next !== text };
}

/** `herdr config check` (probed 2026-11-04): exit 0 with `config: ok` on a file the host
 *  accepts, exit 1 with `config: issues found` and the diagnostics in the text otherwise. A
 *  timeout, or an answer with no text at all, is a failure too. */
export function hostConfigCheck(): { ok: boolean; text: string } {
  let out = '';
  try {
    out = captureExec(['config', 'check']);
  } catch (error) {
    const thrown = error as { stdout?: unknown; message?: unknown };
    const printed = [thrown.stdout, thrown.message]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n');
    return { ok: false, text: printed.trim() || 'config check did not answer' };
  }
  return { ok: true, text: out.trim() };
}

/** `server reload-config` is session-scoped: each session runs its own server behind its own
 *  socket, so the reload reaches only the session it names (measured live 2026-11-04).
 *  `status: applied` with no diagnostics is the only applied answer; diagnostics, a non-zero
 *  exit, invalid JSON or a timeout are a refusal whose text the caller names. */
export type ConfigReload = { applied: boolean; text: string };

export function reloadConfig(session: string): ConfigReload {
  let result: unknown;
  try {
    result = run(['server', 'reload-config'], session);
  } catch (error) {
    return { applied: false, text: error instanceof Error ? error.message : String(error) };
  }
  if (result === null || typeof result !== 'object') return { applied: false, text: 'reload-config did not answer' };
  const diagnostics = (result as { diagnostics?: unknown }).diagnostics;
  const applied =
    (result as { status?: unknown }).status === 'applied' &&
    (!Array.isArray(diagnostics) || diagnostics.length === 0);
  return { applied, text: applied ? 'applied' : JSON.stringify(result) };
}

// The atomic replace the config edit lands through: an exclusive private temporary in the
// config's own folder, every byte written and synced, then renamed over the original — the
// writeForgeShim shape at the mode the owner's file already had (0600 on create). The rename
// unlinks the original's inode, so the caller holds the prior bytes in memory before this runs.
function replaceConfigAtomic(file: string, text: string, mode: number): void {
  const folder = dirname(file);
  mkdirSync(folder, { recursive: true });
  const temp = join(folder, `.${basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  let handle: number | null = null;
  try {
    handle = openSync(temp, 'wx', 0o600);
    writeFileSync(handle, text);
    fchmodSync(handle, mode);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    renameSync(temp, file);
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        // the descriptor is already gone
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // renamed away, or never made
    }
  }
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

/** What one apply of the sidebar layout did. `unchanged` still reloads the sessions it was
 *  given: the file already reads equal, but a session that never reloaded since an older file
 *  holds the older layout in memory. `failed` names the sessions whose reload refused — the
 *  edit stands (a restore cannot un-reload the sessions that applied); check names them and
 *  `--repair` retries. A `refused` edit either wrote nothing (`restored: 'untouched'`), restored
 *  the prior bytes (`restored: true`), or replaced the file and could not restore the prior bytes
 *  (`restored: false`). */
export type SidebarApply =
  | { kind: 'unchanged'; reloaded: string[]; failed: { session: string; text: string }[] }
  | { kind: 'applied'; reloaded: string[]; failed: { session: string; text: string }[] }
  | { kind: 'refused'; reason: string; restored: boolean | 'untouched' };

/** The host calls the apply makes, injectable for tests. */
export type SidebarApplyDeps = {
  checkConfig: () => { ok: boolean; text: string };
  reload: (session: string) => ConfigReload;
};

/** Applies the sidebar layout to the terminal host's config: back up, splice both keys in one
 *  pass, validate through the host, roll back from the bytes held in memory, then reload each
 *  given session (the caller passes running sessions only — a session that is not running
 *  reads the config when it starts). The rolling backup beside the config
 *  (`config.toml.team-backup`, one deep, 0600, never through a link) holds the exact pre-edit
 *  bytes for the owner to diff or restore by hand. */
export function applySidebarLayout(
  home: string,
  rows: readonly (readonly string[])[],
  indicators: string,
  sessions: readonly string[],
  deps: SidebarApplyDeps,
): SidebarApply {
  const file = hostConfigPath(home);
  const reloads = (): { reloaded: string[]; failed: { session: string; text: string }[] } => {
    const reloaded: string[] = [];
    const failed: { session: string; text: string }[] = [];
    for (const session of sessions) {
      const outcome = deps.reload(session);
      if (outcome.applied) reloaded.push(session);
      else failed.push({ session, text: outcome.text });
    }
    return { reloaded, failed };
  };

  let priorText: string | null;
  let mode = 0o600;
  try {
    assertNoLink(file, home);
    try {
      priorText = readFileSync(file, 'utf8');
      mode = statSync(file).mode & 0o777;
    } catch (error) {
      if (!isAbsent(error)) throw error;
      priorText = null;
    }
  } catch (error) {
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error), restored: 'untouched' };
  }

  const spliced = spliceSidebarRows(priorText ?? '', rows, indicators);
  if (!spliced.ok) return { kind: 'refused', reason: spliced.reason, restored: 'untouched' };
  if (!spliced.changed) {
    const { reloaded, failed } = reloads();
    return { kind: 'unchanged', reloaded, failed };
  }

  try {
    if (priorText !== null) writePrivate(`${file}.team-backup`, priorText, home);
    replaceConfigAtomic(file, spliced.text, mode);
  } catch (error) {
    // The replace is atomic: a throw here is before the rename, so the config still holds the
    // prior bytes (or is still absent) and nothing needs restoring.
    return { kind: 'refused', reason: error instanceof Error ? error.message : String(error), restored: 'untouched' };
  }

  const check = deps.checkConfig();
  if (!check.ok) {
    let restored = true;
    try {
      if (priorText === null) unlinkSync(file);
      else replaceConfigAtomic(file, priorText, mode);
    } catch {
      restored = false;
    }
    return { kind: 'refused', reason: check.text, restored };
  }
  const { reloaded, failed } = reloads();
  return { kind: 'applied', reloaded, failed };
}

// Not proof an agent is there: herdr answers with agent_info for a pane that has none.
export function agentRename(pane: string, name: string, session?: string): boolean {
  const out = capture(['agent', 'rename', pane, name], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || !isHerdrError(body);
}

// Brings an agent's pane to the owner's attention and changes nothing in it: no key, no text.
// Captured on herdr 0.7.1 in a scratch session: `agent focus` on a pane holding typed, unsent
// text left the pane's text exactly as it was and only moved the focus (see the result of the
// slice that added this call). False when herdr doesn't list the target or the call failed.
export function focusAgent(target: string, session?: string): boolean {
  const out = capture(['agent', 'focus', target], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || !isHerdrError(body);
}

export function workspaceClose(workspace: string, session?: string): boolean {
  const out = capture(['workspace', 'close', workspace], session);
  if (out === null) return false;
  const body = parsed(out);
  return body !== null && !isHerdrError(body);
}

// Stops a session, which herdr keeps listed as stopped.
export function sessionStop(name: string): boolean {
  const out = capture(['session', 'stop', name]);
  if (out === null) return false;
  return sessionStopped(out, name);
}

// Herdr 0.7.1's answer when `session stop` worked, captured on a scratch session: stdout is
// `stopped session <name>` and one newline, exit 0, and `session list` keeps it with running false.
export function sessionStopped(stdout: string, name: string): boolean {
  return stdout === `stopped session ${name}\n`;
}

// Clears a stopped session. `down` deletes the session it has itself just stopped, once herdr
// lists it stopped. `up` deletes a stopped session this team's state records, then starts it.
// A delete while the session is still running is refused by herdr and returns false.
export function sessionDelete(name: string): boolean {
  const out = capture(['session', 'delete', name]);
  if (out === null) return false;
  return sessionCleared(out, name);
}

// Herdr 0.7.1's answer when `session delete` worked, captured on a scratch session: stdout is
// exactly `deleted session <name>` and one newline, exit 0, and `session list` no longer has it.
// A clear is that whole string for the name that was asked. Anything else, including any JSON
// body, is not a clear. A session that is still running exits 1 with a JSON error on stderr and
// empty stdout, so `capture` returns null and this is not asked.
export function sessionCleared(stdout: string, name: string): boolean {
  return stdout === `deleted session ${name}\n`;
}

// The process call behind paneRead, injectable for tests: it returns the call's stdout and
// throws when herdr refuses an option or the call times out. The real one shells out.
export type PaneExec = (args: string[]) => string;
const shellPaneExec: PaneExec = (args) =>
  execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
let paneExec: PaneExec = shellPaneExec;

/** Swaps the process call paneRead makes; null restores the real one. */
export function setPaneExec(exec: PaneExec | null): void {
  paneExec = exec ?? shellPaneExec;
}

// The visible-line window `status` and the watch both read: one value, so a report and the watch
// can't classify different windows of the same pane.
export const PANE_WINDOW = 14;

// The visible lines of a pane, or null. `session` undefined reaches the caller's own server.
// The lines keep their ANSI styling, CRLF folded to LF: a greyed suggestion and typed text
// read the same as plain text, and only their styling tells them apart, so the readers that
// want plain text strip it (`stripSgr`). An herdr without the `--format` option refuses the
// styled call and is read by the exact call main makes today — no flag at all — where
// unstyled text can never read as dim and the placeholder list alone decides. A herdr that
// hangs is not asked twice: one timeout reads null.
function paneReadArgs(pane: string, lines: number, session?: string): string[] {
  return [...(session ? ['--session', session] : []), 'pane', 'read', pane, '--source', 'visible', '--lines', String(lines)];
}

export function paneRead(pane: string, lines: number, session?: string): string | null {
  const full = paneReadArgs(pane, lines, session);
  let styled: string;
  try {
    styled = paneExec([...full, '--format', 'ansi']);
  } catch (error) {
    if (!(error instanceof Error)) return null;
    // execFileSync reports its own timeout as an Error with code ETIMEDOUT — signal SIGTERM,
    // status null, and no killed field. Observed under Bun, from a run, not from memory.
    if ((error as { code?: unknown }).code === 'ETIMEDOUT') return null;
    try {
      return paneExec(full);
    } catch {
      return null;
    }
  }
  return styled.replace(/\r\n/g, '\n').replace(/\r$/, '');
}

/**
 * The same read, awaited. The fallback to an herdr without `--format` is made only on a refusal:
 * a child the timeout killed or the loop's stop aborted is not asked twice, the same rule the
 * synchronous read makes for its own timeout.
 */
export async function paneReadAsync(
  pane: string,
  lines: number,
  session: string | undefined,
  options: HerdrReadOptions = {},
): Promise<string | null> {
  const full = paneReadArgs(pane, lines, session);
  try {
    return foldPaneLines(await execText('herdr', [...full, '--format', 'ansi'], options));
  } catch (error) {
    if (wasKilled(error) || wasAborted(error)) return null;
    try {
      return foldPaneLines(await execText('herdr', full, options));
    } catch {
      return null;
    }
  }
}

function foldPaneLines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r$/, '');
}

// The words to type for a herdr command, for a repair line.
export function herdrCommand(session: string | undefined, ...args: string[]): string {
  return ['herdr', ...(session && session !== 'default' ? ['--session', session] : []), ...args].join(' ');
}

// The two functions that type. Their callers have just seen the pane at an empty idle prompt,
// look at it again between the text and the Enter, and type nothing anywhere else.
export function typeText(pane: string, text: string, session?: string): boolean {
  try {
    execFileSync('herdr', [...(session ? ['--session', session] : []), 'pane', 'send-text', pane, text], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The `send-keys` name of the Enter that submits. Text goes out with `send-text` and no
 *  Return of its own. herdr 0.9.5 (`herdr --version`, `herdr --skill` on 2026-11-04) names
 *  this logical Enter; `pane run` queues the text and Enter together, which presses while
 *  the line is still drawing. */
export const SUBMIT_ENTER = 'enter';

export function pressEnter(pane: string, session?: string): boolean {
  return sendKey(pane, SUBMIT_ENTER, session);
}

/** One key, by the name `herdr pane send-keys` takes. The same call `pressEnter` uses. */
export function sendKey(pane: string, key: string, session?: string): boolean {
  try {
    execFileSync('herdr', [...(session ? ['--session', session] : []), 'pane', 'send-keys', pane, key], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// The status herdr reports for one pane's agent, or null.
export function agentStatus(pane: string, session?: string): string | null {
  return agentList(session)?.find((agent) => agent.pane === pane)?.status ?? null;
}

/** The same read, awaited: the child is killed at `timeoutMs` or at the loop's stop. */
export async function agentStatusAsync(
  pane: string,
  session: string | undefined,
  options: HerdrReadOptions = {},
): Promise<string | null> {
  return (await agentListAsync(session, options))?.find((agent) => agent.pane === pane)?.status ?? null;
}

export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const HERDR_AGENT_STATUSES: readonly HerdrAgentStatus[] = [
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
];

export function isHerdrAgentStatus(value: unknown): value is HerdrAgentStatus {
  return (
    value === 'idle'
    || value === 'working'
    || value === 'blocked'
    || value === 'done'
    || value === 'unknown'
  );
}

export type HerdrWaitOutcome =
  | {
      outcome: 'changed';
      status: HerdrAgentStatus;
      pane: string;
      workspace?: string;
      agent?: string;
    }
  | { outcome: 'timeout' }
  | { outcome: 'error'; message: string };

export type HerdrWaitExec = (
  args: string[],
  signal?: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const shellWaitExec: HerdrWaitExec = (args, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: 'timed out waiting for agent status change' });
      return;
    }
    let child;
    try {
      child = spawn('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    } catch (error) {
      resolve({ code: 1, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error & { name?: string }) => {
      if (signal?.aborted || error.name === 'AbortError') {
        resolve({ code: null, stdout, stderr: 'timed out waiting for agent status change' });
        return;
      }
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      if (signal?.aborted && code !== 0) {
        resolve({ code, stdout, stderr: 'timed out waiting for agent status change' });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });

let waitExec: HerdrWaitExec = shellWaitExec;

/** Swaps the async process runner `waitAgentStatus` uses; null restores the real `herdr` spawn. */
export function setHerdrWaitExec(exec: HerdrWaitExec | null): void {
  waitExec = exec ?? shellWaitExec;
}

/** Parses one `herdr wait agent-status` exit and output into a structured wait outcome.
 *  Probed against herdr 0.7.1:
 *  - match exits 0 and prints `{"event":"pane.agent_status_changed","data":{"pane_id":"...","workspace_id":"...","agent_status":"done",...}}`
 *  - timeout exits 1 and prints `timed out waiting for agent status change`
 *  - invalid pane / unreachable daemon exits non-zero with a JSON error envelope or message. */
export function parseWaitAgentStatusOutput(
  code: number | null,
  stdout: string,
  stderr: string,
  fallbackPane: string,
  requestedStatus: HerdrAgentStatus,
): HerdrWaitOutcome {
  const trimmedOut = stdout.trim();
  const trimmedErr = stderr.trim();
  const combined = `${trimmedOut}\n${trimmedErr}`.toLowerCase();
  if (code !== 0 && combined.includes('timed out waiting for agent status change')) {
    return { outcome: 'timeout' };
  }
  if (code === 0) {
    if (trimmedOut !== '') {
      try {
        const body = JSON.parse(trimmedOut) as HerdrEnvelope & {
          event?: unknown;
          data?: {
            pane_id?: unknown;
            workspace_id?: unknown;
            agent_status?: unknown;
            agent?: unknown;
          };
        };
        if (isHerdrError(body)) {
          return { outcome: 'error', message: trimmedOut };
        }
        const rawStatus = body.data?.agent_status;
        const status = isHerdrAgentStatus(rawStatus) ? rawStatus : requestedStatus;
        const pane = typeof body.data?.pane_id === 'string' && body.data.pane_id !== ''
          ? body.data.pane_id
          : fallbackPane;
        const workspace = typeof body.data?.workspace_id === 'string' && body.data.workspace_id !== ''
          ? body.data.workspace_id
          : undefined;
        const agent = typeof body.data?.agent === 'string' && body.data.agent !== ''
          ? body.data.agent
          : undefined;
        return {
          outcome: 'changed',
          status,
          pane,
          ...(workspace !== undefined ? { workspace } : {}),
          ...(agent !== undefined ? { agent } : {}),
        };
      } catch {
        return { outcome: 'error', message: `invalid json from herdr wait agent-status: ${trimmedOut}` };
      }
    }
    return { outcome: 'changed', status: requestedStatus, pane: fallbackPane };
  }
  return {
    outcome: 'error',
    message: trimmedErr || trimmedOut || 'herdr wait agent-status failed',
  };
}

/** Waits for `pane`'s agent status in `herdr` to reach `status` within `timeoutMs`.
 *  Read-only: never types or sends a key into any pane. */
export async function waitAgentStatus(
  pane: string,
  status: HerdrAgentStatus,
  timeoutMs = 30_000,
  session?: string,
  signal?: AbortSignal,
): Promise<HerdrWaitOutcome> {
  const args = [
    ...(session && session !== 'default' ? ['--session', session] : []),
    'wait',
    'agent-status',
    pane,
    '--status',
    status,
    '--timeout',
    String(Math.max(1, Math.round(timeoutMs))),
  ];
  try {
    const { code, stdout, stderr } = await waitExec(args, signal);
    return parseWaitAgentStatusOutput(code, stdout, stderr, pane, status);
  } catch (error) {
    return {
      outcome: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The herdr versions this version of `team` was run with.
export const HERDR_TESTED = { from: '0.7.1', to: '0.7.1' };

// What `herdr --version` prints, without the name, or null when herdr can't be run.
export function herdrVersion(): string | null {
  try {
    const out = execFileSync('herdr', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return out.trim().replace(/^herdr\s+/, '') || null;
  } catch {
    return null;
  }
}
