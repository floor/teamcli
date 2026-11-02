// The session leg: a receiving CLI that creates a remote session from its own argv takes the
// send as one task argument, and the session it names is the delivery. No pane is read or
// written, no daemon is dialed and nothing is typed: the CLI is run with the whole body — rules,
// sender header and brief — as ONE argument, never through a shell string, so no word of the
// body is ever split, expanded or interpreted.
//
// The CLI's own profile declares the call it was measured to take (`session_cli`): the argv that
// creates a session, the flag that names the repository when one is given, the line it prints
// once a session exists, and the argv that pulls that session's result. A profile without the
// block gives its seats no session leg, and a level that names `session` for such a seat is
// recorded as unavailable rather than attempted.
//
// Delivered is the CLI's own word and nothing else: it printed the session line with an id. An
// exit 0 without that line is not a delivery, and neither is a session id read from anywhere but
// that line. The id is recorded on the walk and in the history line the send writes.
import { spawn, spawnSync } from 'node:child_process';
import { repoFromUrl } from './compose.ts';

/** What a profile declares for the CLI's own session call, as the CLI's help and captures read. */
export type SessionCliSpec = {
  /** The argv that creates one session from a task: the binary, then its own subcommand words.
   *  The task rides as one argument after them. */
  argv: readonly string[];
  /** The flag that names the repository, placed before the task; null when the CLI takes none
   *  and chooses the repository from its working folder. */
  repoFlag: string | null;
  /** The line the CLI prints once a session exists; the session id follows it. */
  created: string;
  /** The argv that pulls one session's result into the working folder: the binary, then its own
   *  subcommand words. `--session <id> --apply` follows them. */
  pull: readonly string[];
};

/** How long the session call may run before it is killed. A session is created in seconds, and a
 *  CLI that is prompting for a login this seat does not have never answers when stdin is closed;
 *  the walk must not hang on it. */
export const SESSION_CREATE_TIMEOUT_MS = 30_000;

/** The pull's own bound: a pull writes the session's patch into the folder and may take longer. */
export const SESSION_PULL_TIMEOUT_MS = 300_000;

export type SessionCliSpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

/** Runs one CLI call and collects its streams. Tests stand in a fake; the real one spawns the
 *  binary from PATH with stdin closed. */
export type SessionCliSpawn = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<SessionCliSpawnResult> | SessionCliSpawnResult;

/** The default runner: the binary from PATH, stdin closed (a login prompt must fail fast rather
 *  than wait), stdout and stderr collected, and a process that outlives its bound killed. Nothing
 *  from the seat's own environment is read beyond what the child already inherits. */
export const defaultSessionCliSpawn: SessionCliSpawn = (binary, args, options) =>
  new Promise<SessionCliSpawnResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: SessionCliSpawnResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };
    let child;
    try {
      child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => finish({ status: null, stdout, stderr, error }));
    child.on('close', (code: number | null) => finish({ status: code, stdout, stderr }));
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already exited.
      }
      finish({ status: null, stdout, stderr, error: new Error(`timed out after ${String(options.timeoutMs)}ms`) });
    }, options.timeoutMs);
  });

/** `owner/repo` this folder's `origin` names, or null. A folder that is not a checkout, has no
 *  origin, or names one this reader cannot parse gives null: the CLI then chooses the repository
 *  from the working folder, its own default. */
export function originRepoOf(cwd: string): string | null {
  const run = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (run.status !== 0 || typeof run.stdout !== 'string') return null;
  return repoFromUrl(run.stdout);
}

/** The id the CLI's own session line carries, and the line itself. The line opens with the
 *  profile's `created` text; the id is the last path segment after `/session/` when the CLI
 *  prints a URL, and the whole remainder when it prints a bare id. Null when no line carries the
 *  marker with a usable id. */
export function sessionLineOf(text: string, created: string): { session: string; line: string } | null {
  for (const line of text.split('\n')) {
    const at = line.indexOf(created);
    if (at < 0) continue;
    const rest = line.slice(at + created.length).trim();
    if (rest === '') continue;
    const after = rest.lastIndexOf('/session/');
    const candidate = (after < 0 ? rest : rest.slice(after + '/session/'.length)).split(/[\s"'`]/)[0] ?? '';
    const session = candidate.replace(/[.,;:)\]]+$/, '');
    if (!/^[A-Za-z0-9._-]+$/.test(session)) continue;
    return { session, line: line.trim() };
  }
  return null;
}

/** The last non-empty line of a CLI's error stream, bounded so a history line stays one line. */
function lastLineOf(text: string): string | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return last.length > 200 ? `${last.slice(0, 197)}...` : last;
}

export type SessionCreateInput = {
  spec: SessionCliSpec;
  /** The receiving seat's own folder: the CLI runs there. */
  cwd: string;
  /** `owner/repo` to name on the call, or null to let the CLI choose from `cwd`. */
  repo: string | null;
  /** The whole message — rules, sender header and brief — as one argument. */
  body: string;
  spawn?: SessionCliSpawn;
  timeoutMs?: number;
};

export type SessionCreateAttempt =
  | { outcome: 'created'; session: string; line: string }
  | { outcome: 'refused'; reason: string };

/** Creates one session with the whole body as a single argument. The call is delivered only
 *  when the CLI printed its session line with an id; every other ending is a route that did not
 *  take the send, with the reason the walk records. */
export async function createSession(input: SessionCreateInput): Promise<SessionCreateAttempt> {
  const [binary, ...words] = input.spec.argv;
  if (binary === undefined || binary === '') return { outcome: 'refused', reason: 'the session call names no binary' };
  const args = [
    ...words,
    ...(input.repo !== null && input.spec.repoFlag !== null ? [input.spec.repoFlag, input.repo] : []),
    input.body,
  ];
  const run = input.spawn ?? defaultSessionCliSpawn;
  const result = await run(binary, args, { cwd: input.cwd, timeoutMs: input.timeoutMs ?? SESSION_CREATE_TIMEOUT_MS });
  const found = sessionLineOf(`${result.stdout}\n${result.stderr}`, input.spec.created);
  if (result.error !== undefined) {
    if (found !== null) return { outcome: 'created', session: found.session, line: found.line };
    return { outcome: 'refused', reason: `the ${binary} CLI could not be run (${result.error.message})` };
  }
  if (found !== null) return { outcome: 'created', session: found.session, line: found.line };
  if (result.status !== 0) {
    const last = lastLineOf(result.stderr);
    return {
      outcome: 'refused',
      reason: `the ${binary} CLI exited ${result.status === null ? 'without a status' : String(result.status)}${last === null ? '' : ` (${last})`}`,
    };
  }
  return { outcome: 'refused', reason: `the ${binary} CLI exited 0 without printing its session line` };
}

export type SessionPullInput = {
  spec: SessionCliSpec;
  /** The session id the delivery recorded. */
  session: string;
  /** The folder the patch lands in, named by the caller's own worktree record. */
  cwd: string;
  spawn?: SessionCliSpawn;
  timeoutMs?: number;
};

export type SessionPullResult =
  | { outcome: 'pulled'; stdout: string; stderr: string }
  | { outcome: 'refused'; reason: string; stdout: string; stderr: string };

/** Pulls one session's result into `cwd` with the profile's own pull call — its argv, then
 *  `--session <id> --apply` — and nothing else. The CLI writes the patch; this function stages
 *  no commit, branch or push, and only the operator runs it. */
export async function pullSession(input: SessionPullInput): Promise<SessionPullResult> {
  const [binary, ...words] = input.spec.pull;
  if (binary === undefined || binary === '') {
    return { outcome: 'refused', reason: 'the profile declares no session pull command', stdout: '', stderr: '' };
  }
  const args = [...words, '--session', input.session, '--apply'];
  const run = input.spawn ?? defaultSessionCliSpawn;
  const result = await run(binary, args, { cwd: input.cwd, timeoutMs: input.timeoutMs ?? SESSION_PULL_TIMEOUT_MS });
  if (result.error !== undefined) {
    return {
      outcome: 'refused',
      reason: `the ${binary} CLI could not be run (${result.error.message})`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  if (result.status !== 0) {
    const last = lastLineOf(result.stderr) ?? lastLineOf(result.stdout);
    return {
      outcome: 'refused',
      reason: `the ${binary} CLI exited ${result.status === null ? 'without a status' : String(result.status)}${last === null ? '' : ` (${last})`}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return { outcome: 'pulled', stdout: result.stdout, stderr: result.stderr };
}
