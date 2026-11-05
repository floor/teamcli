// Starting one restore child and reading its one result.
//
// A child is a second process running the entry beside this module, so a restore pass's
// synchronous terminal-host reads hold that process alone: the daemon's heartbeat, its socket
// and every other route never wait on them. The child proves it was started from here with a
// one-use token under the machine folder (`./token.ts`); a command line without one is refused
// before any route is read, and the token is its whole authority to run the pass.
//
// The child speaks one newline-framed JSON line on stdout: `{ok:true,result}` when the pass ran,
// `{ok:false,reason}` when it threw. Anything else on stdout is not the protocol and is ignored.
// Its stderr is not a channel either; the last complete line there is carried into the error the
// daemon logs when the child reports nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RestoreSweepResult } from '../../launch/restore-sweep.ts';
import { discardRestoreInherit, restoreDoorText, writeRestoreDoor } from './token.ts';

/** The result kinds a child may report. A line naming anything else is not a result. */
const RESULT_KINDS = new Set(['no-recorded-session', 'lock-held', 'not-running', 'unreadable', 'refused', 'ran']);

/** The most one stdout or stderr frame may hold before it is dropped as unreadable. */
const FRAME_LIMIT = 64 * 1024;

/** How much of the child's last error line the daemon's log carries. */
const ERROR_LIMIT = 400;

/** How long one pass may run before the child is ended and the route reports nothing. */
const DEFAULT_TIMEOUT_MS = 600_000;

/** How long a terminated child gets before it is forced. A pass stops between seat steps, and
 *  the longest single terminal-host read it can be inside is fifteen seconds. */
const KILL_GRACE_MS = 15_000;

/** How long a child that has already reported is given before it is forced. Its own stop
 *  handlers are removed once the pass returns, so the first signal ends it. */
const REPORTED_GRACE_MS = 2_000;

export type SpawnRestoreInput = {
  home: string;
  /** The canonical route root: the one route this child's pass may act on. */
  root: string;
  /** The team file the route was loaded from when it is a `team-file` route. */
  teamFile?: string;
  /** The daemon's closing signal: the pass is ended between seat steps and reported as ended. */
  signal?: AbortSignal;
  /** The program entry the child runs. The default is the child entry beside this module; a test
   *  names a fixture entry. */
  entry?: string;
  /** The whole-pass bound. Past it the child is ended and the route reports nothing. */
  timeoutMs?: number;
};

/** The child's program entry: the `entry.ts` (source) or `entry.js` (installed build) beside this
 *  module. It loads the restore pass and the token reader only. */
export function restoreEntryOf(here: string = fileURLToPath(import.meta.url)): string | null {
  const name = here.endsWith('.ts') ? 'entry.ts' : 'entry.js';
  const candidate = join(dirname(here), name);
  return existsSync(candidate) ? candidate : null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One protocol line as a settlement, or null when the line is not the protocol. */
function reportOf(line: string): { ok: true; result: RestoreSweepResult } | { ok: false; reason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const report = parsed as Record<string, unknown>;
  if (report.ok === false) {
    return typeof report.reason === 'string' && report.reason !== ''
      ? { ok: false, reason: report.reason }
      : { ok: false, reason: 'the restore child reported a failure without a reason' };
  }
  if (report.ok !== true) return null;
  const result = report.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (typeof (result as { kind?: unknown }).kind !== 'string' || !RESULT_KINDS.has((result as { kind: string }).kind)) return null;
  return { ok: true, result: result as RestoreSweepResult };
}

/**
 * Runs one route's restore pass in a child of its own and resolves with what the pass reported.
 *
 * Throws — never resolves with a fabricated result — when the child cannot start, leaves without
 * reporting, is ended by the deadline or the daemon's closing signal, or reports a result this
 * daemon does not understand. The caller logs that message against the route; no fact about the
 * team is invented for a pass that did not report.
 */
export async function runRestoreSweepInChild(input: SpawnRestoreInput): Promise<RestoreSweepResult> {
  // The closing signal is read through a closure: it may fire at any point the loop turns, and
  // the check after the listener is registered must see the abort a closure-free comparison
  // would have narrowed away.
  const aborted = (): boolean => input.signal?.aborted === true;
  const entry = input.entry ?? restoreEntryOf();
  if (entry === null) throw new Error('the program entry for a restore child was not found');
  if (aborted()) throw new Error('the restore pass was not started because the daemon is closing');

  let minted: { nonce: string; secret: string };
  try {
    minted = writeRestoreDoor({
      version: 1,
      home: input.home,
      root: input.root,
      ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
      daemonPid: process.pid,
    });
  } catch (error) {
    throw new Error(`the restore token could not be written: ${reasonOf(error)}`);
  }
  const { nonce, secret } = minted;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry, '--inherited', nonce], {
      cwd: input.root,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: input.home },
    });
  } catch (error) {
    discardRestoreInherit(input.home, nonce);
    throw new Error(`the restore child could not be started: ${reasonOf(error)}`);
  }

  let settled = false;
  let lastError = '';
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let grace: ReturnType<typeof setTimeout> | null = null;
  let resolveResult!: (value: RestoreSweepResult) => void;
  let rejectResult!: (reason: Error) => void;
  const done = new Promise<RestoreSweepResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  /** Ends the child after a settled result: its pass returned, so the first signal ends it. The
   *  signal is forced after a short grace, never left to a pass that has nothing left to stop. */
  const endReported = (): void => {
    if (grace !== null || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone; the exit settles nothing that is not already settled.
    }
    grace = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, REPORTED_GRACE_MS);
    grace.unref();
  };

  /** Ends a pass that still has work: the child's own flag stops it between seat steps, and the
   *  grace bounds a step that is inside one terminal-host call. */
  const endRunning = (): void => {
    if (grace !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone; there is nothing left to stop.
    }
    grace = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    grace.unref();
  };

  const settleResult = (result: RestoreSweepResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onAbort);
    resolveResult(result);
    endReported();
  };

  const settleFailure = (reason: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    input.signal?.removeEventListener('abort', onAbort);
    rejectResult(new Error(reason));
  };

  const onAbort = (): void => {
    if (settled) return;
    endRunning();
    // A child ended before it read its token leaves one behind; the pass is over either way,
    // and a token no child will read must not outlive it.
    discardRestoreInherit(input.home, nonce);
    settleFailure('the restore pass was ended because the daemon is closing');
  };

  const deadline = setTimeout(() => {
    if (settled) return;
    endRunning();
    discardRestoreInherit(input.home, nonce);
    settleFailure(`the restore child did not answer within ${String(Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))} s and was ended`);
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  deadline.unref();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  // A signal that fired between the pre-check and the listener still ends the pass: the child
  // was started for a daemon that is closing, and it is ended before it can do any work.
  if (aborted()) onAbort();

  // Every stream carries an error listener from the moment it exists: a child that left raises
  // EPIPE on a write, and an unhandled stream error takes the daemon down with the child.
  child.stdout?.on('error', (error: Error) => {
    settleFailure(`the restore child's output failed: ${error.message}`);
    endRunning();
    discardRestoreInherit(input.home, nonce);
  });
  child.stderr?.on('error', () => {
    // The child's own errors are diagnostics, never the protocol: their loss changes nothing.
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let nl = stdoutBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      nl = stdoutBuffer.indexOf('\n');
      if (line.trim() === '') continue;
      const report = reportOf(line);
      if (report === null) continue;
      if (report.ok) {
        settleResult(report.result);
        return;
      }
      settleFailure(`the restore child reported: ${report.reason}`);
      endReported();
      return;
    }
    if (stdoutBuffer.length > FRAME_LIMIT) {
      stdoutBuffer = '';
      settleFailure('the restore child wrote a line over the frame limit and was not understood');
      endRunning();
    }
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl).trim();
      stderrBuffer = stderrBuffer.slice(nl + 1);
      nl = stderrBuffer.indexOf('\n');
      if (line !== '') lastError = line.length > ERROR_LIMIT ? `${line.slice(0, ERROR_LIMIT - 3)}...` : line;
    }
    if (stderrBuffer.length > FRAME_LIMIT) stderrBuffer = '';
  });

  child.on('error', (error: Error) => {
    settleFailure(`the restore child failed: ${error.message}`);
    // A child that never started never read its token.
    discardRestoreInherit(input.home, nonce);
  });
  const gone = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    discardRestoreInherit(input.home, nonce);
    const how = code === null ? `signal ${signal ?? 'unknown'}` : `code ${String(code)}`;
    settleFailure(`the restore child left before it reported (${how})${lastError === '' ? '' : `: ${lastError}`}`);
  };
  child.on('exit', gone);
  child.on('close', gone);

  const door = child.stdio[3];
  if (door !== null && door !== undefined && 'end' in door) {
    door.on('error', () => {
      // A child that exits before reading its door raises EPIPE here; its exit handler settles the run.
    });
    try {
      door.end(restoreDoorText(nonce, secret));
    } catch (error) {
      endRunning();
      discardRestoreInherit(input.home, nonce);
      settleFailure(`the restore door could not be written: ${reasonOf(error)}`);
    }
  }

  return done;
}
