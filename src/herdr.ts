import { execFileSync, spawn } from 'node:child_process';

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
  /** Herdr's `agent_session`, when the integration reported one. Absent when it did not. */
  session?: string;
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

// The agents herdr lists, or null when herdr can't be reached.
export function agentList(session?: string): HerdrAgent[] | null {
  try {
    const result = run(['agent', 'list'], session) as { agents?: Record<string, unknown>[] };
    return (result.agents ?? []).map((agent) => {
      const session = typeof agent.agent_session === 'string' && agent.agent_session ? agent.agent_session : undefined;
      return {
        name: typeof agent.name === 'string' && agent.name ? agent.name : null,
        agent: typeof agent.agent === 'string' ? agent.agent : null,
        pane: String(agent.pane_id),
        workspace: String(agent.workspace_id),
        status: typeof agent.agent_status === 'string' ? agent.agent_status : 'unknown',
        cwd: typeof agent.cwd === 'string' ? agent.cwd : null,
        ...(session ? { session } : {}),
      };
    });
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

export type HerdrWorkspace = { id: string; label: string };

export function workspaceList(session?: string): HerdrWorkspace[] | null {
  try {
    const result = run(['workspace', 'list'], session) as { workspaces?: Record<string, unknown>[] };
    return (result.workspaces ?? []).map((workspace) => ({
      id: String(workspace.workspace_id),
      label: typeof workspace.label === 'string' ? workspace.label : '',
    }));
  } catch {
    return null;
  }
}

// The pane ids in a workspace, or null when herdr can't be reached or the workspace does not exist.
// Every entry must be an object with a string pane_id and a workspace_id equal to the workspace asked for;
// anything else makes the whole reading unreadable (null).
export function workspacePanes(workspace: string, session?: string): string[] | null {
  try {
    const result = run(['pane', 'list', '--workspace', workspace], session) as { panes?: unknown } | undefined;
    if (!result || typeof result !== 'object' || !Array.isArray(result.panes)) return null;
    const panes: string[] = [];
    for (const entry of result.panes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const p = entry as Record<string, unknown>;
      if (typeof p.pane_id !== 'string' || !p.pane_id) return null;
      if (typeof p.workspace_id !== 'string' || p.workspace_id !== workspace) return null;
      panes.push(p.pane_id);
    }
    return panes;
  } catch {
    return null;
  }
}

export type SessionState = 'running' | 'stopped' | 'absent';

export type HerdrSession = {
  name: string;
  running: boolean;
  /** `<session_dir>` from the list, or null when herdr did not name one. */
  sessionDir: string | null;
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
export function sessionList(): HerdrSession[] | null {
  try {
    const out = execFileSync('herdr', ['session', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const body = JSON.parse(out) as { sessions?: unknown };
    // A missing list is no sessions. Anything else that is not an array is not this document.
    if (body.sessions === undefined || body.sessions === null) return [];
    if (!Array.isArray(body.sessions)) return null;
    const listed: HerdrSession[] = [];
    for (const entry of body.sessions) {
      if (!entry || typeof entry !== 'object') continue;
      const session = entry as { name?: unknown; running?: unknown; session_dir?: unknown };
      if (typeof session.name !== 'string' || session.name === '') continue;
      listed.push({
        name: session.name,
        running: session.running === true,
        sessionDir: typeof session.session_dir === 'string' ? session.session_dir : null,
      });
    }
    return listed;
  } catch {
    return null;
  }
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

// What a herdr command printed, or null when it did not run. Exit status is not the answer: a
// command aimed at a session that does not exist can print an error and exit 0.
function capture(args: string[], session?: string): string | null {
  const full = [...(session ? ['--session', session] : []), ...args];
  try {
    return execFileSync('herdr', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch {
    return null;
  }
}

function parsed(out: string): { type?: string; result?: unknown } | null {
  try {
    return JSON.parse(out) as { type?: string; result?: unknown };
  } catch {
    return null;
  }
}

function resultOf(args: string[], session?: string): unknown | null {
  const out = capture(args, session);
  if (out === null) return null;
  const body = parsed(out);
  if (!body || body.type === 'error') return null;
  return body.result ?? null;
}

const SERVER_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'LANG'] as const;

// Starts a session's server in a clean environment. Refuses unless the session is absent: a
// second server for a session that already runs has been seen to drop it.
export function startServer(session: string): boolean {
  if (sessionState(session) !== 'absent') return false;
  const env: NodeJS.ProcessEnv = {};
  for (const name of SERVER_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const args = session === 'default' ? ['server'] : ['--session', session, 'server'];
  try {
    const child = spawn('herdr', args, { env, detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
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
  return body === null || body.type !== 'error';
}

// Not proof an agent is there: herdr answers with agent_info for a pane that has none.
export function agentRename(pane: string, name: string, session?: string): boolean {
  const out = capture(['agent', 'rename', pane, name], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
}

// Brings an agent's pane to the owner's attention and changes nothing in it: no key, no text.
// Captured on herdr 0.7.1 in a scratch session: `agent focus` on a pane holding typed, unsent
// text left the pane's text exactly as it was and only moved the focus (see the result of the
// slice that added this call). False when herdr doesn't list the target or the call failed.
export function focusAgent(target: string, session?: string): boolean {
  const out = capture(['agent', 'focus', target], session);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
}

export function workspaceClose(workspace: string, session?: string): boolean {
  const out = capture(['workspace', 'close', workspace], session);
  if (out === null) return false;
  const body = parsed(out);
  return body !== null && body.type !== 'error';
}

// Stops a session, which herdr keeps listed as stopped.
export function sessionStop(name: string): boolean {
  const out = capture(['session', 'stop', name]);
  if (out === null) return false;
  const body = parsed(out);
  return body === null || body.type !== 'error';
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
export function paneRead(pane: string, lines: number, session?: string): string | null {
  const full = [...(session ? ['--session', session] : []), 'pane', 'read', pane, '--source', 'visible', '--lines', String(lines)];
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

export function pressEnter(pane: string, session?: string): boolean {
  return sendKey(pane, 'enter', session);
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
