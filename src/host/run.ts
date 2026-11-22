// One line the warm send host runs for a client (rfc-bus-send-server §2.4, §2.5).
//
// The line runs through the CLI's own `main`, with the client's argv, cwd and environment, in a
// process that already holds the modules. Before dispatch the host checks the line's shape, the
// environment it can honour, and the client's placement; anything that is not a placed seat's own
// plain send, reply or ack is handed back (`fallback`) before anything runs. During the run the
// hosted guard (request-scope.ts) hands the line back at a fallback point only while no effect has
// happened, and stops it after one. The process's environment, directory, argv, output writers
// and placement caches are the request's for its duration and the host's again after it.
import { inspect } from 'node:util';
import { callerOf, resetCallerCaches } from '../caller.ts';
import { activeHerdrSnapshotId, beginHerdrSnapshot, endHerdrSnapshot } from '../herdr.ts';
import type { Io } from '../io.ts';
import { currentRunMemo } from '../run-memo.ts';
import {
  armHostedGuard,
  DEFERRED_WAIT_MS,
  disarmHostedGuard,
  HostedFallback,
  HostedStoppedAfterEffect,
  runAsHostedRequest,
  settleHostedDeferred,
} from './request-scope.ts';

export const HOST_PROTOCOL_VERSION = 1;

export type HostRequest = {
  v: 1;
  build: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
};

export type HostAnswer =
  | { v: 1; kind: 'ran'; code: number; stdout: string; stderr: string }
  | { v: 1; kind: 'fallback'; why: string };

/** The client the kernel named, as the server read it before queueing the request. */
export type HostPeer = {
  pid: number;
  /** Its kernel parent when the request came in: where the ancestor walk starts. */
  ppid: number;
  /** Re-reads the client and names what changed since the request came in, or null. */
  check: () => string | null;
  /** The client's parent now, or null when it is gone. */
  currentParent: () => number | null;
};

/** Variables the warm host cannot take from the request (the audit in
 *  test/send-host-import-captures.test.ts keeps this list whole). A request whose value differs
 *  from the host's own is handed back.
 *  - HOME: modules of the send path read `homedir()` at import time, and Bun's `homedir()` is
 *    fixed when the process starts (it does not follow `process.env.HOME`), so even a call-time
 *    read answers the host's.
 *  TMPDIR is not listed: the send path reads `tmpdir()` only when it runs, which follows the
 *  request's environment the host puts in place for the line. */
export const IMPORT_TIME_ENV = ['HOME'] as const;

const SEND_FLAGS_WITH_VALUE = new Set(['--subject', '--file', '--brief']);
const SEND_FLAGS = new Set(['--json', '--dry-run']);
const REPLY_FLAGS = new Set(['--close', '--json']);
const ACK_FLAGS = new Set(['--json']);

/** Why a line is not one the host runs, or null when it is: a plain `send <seat> <message |
 *  --file p | --brief p> [--subject t] [--json] [--dry-run]`, `reply <id> [<text>] [--close]
 *  [--json]` or `ack <id> [--json]`. Every other shape stays in-process. */
export function lineFallback(argv: readonly string[]): string | null {
  const [command, ...rest] = argv;
  if (command !== 'send' && command !== 'reply' && command !== 'ack') return 'not a send, reply or ack line';
  if (rest.some((word) => word === '-')) return 'a body from standard input';
  if (rest.some((word) => word === '-h' || word === '--help')) return 'a help line';
  const positional: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]!;
    if (!word.startsWith('-')) {
      positional.push(word);
      continue;
    }
    if (command === 'send') {
      if (SEND_FLAGS.has(word)) continue;
      if (SEND_FLAGS_WITH_VALUE.has(word)) {
        const value = rest[at + 1];
        if (value === undefined || value.startsWith('-')) return `${word} without its value`;
        at += 1;
        continue;
      }
    } else if ((command === 'reply' ? REPLY_FLAGS : ACK_FLAGS).has(word)) {
      continue;
    }
    return `the option ${word.split('=')[0]} is not served by the send host`;
  }
  if (command === 'send') {
    const bodyByFlag = rest.includes('--file') || rest.includes('--brief');
    if (positional.length !== (bodyByFlag ? 1 : 2)) return 'not a plain send line';
  } else if (command === 'reply') {
    if (positional.length < 1 || positional.length > 2) return 'not a plain reply line';
  } else if (positional.length !== 1) {
    return 'not a plain ack line';
  }
  return null;
}

/** Why the host cannot honour this environment, or null: a variable read at import time differs. */
export function envFallback(requested: Record<string, string | undefined>, own: Record<string, string | undefined>): string | null {
  for (const name of IMPORT_TIME_ENV) {
    if (requested[name] !== own[name]) return `${name} differs from the send host's`;
  }
  return null;
}

/** Whether a request is well formed. */
export function isHostRequest(value: unknown): value is HostRequest {
  const v = value as HostRequest | null;
  if (v === null || typeof v !== 'object' || v.v !== 1 || typeof v.build !== 'string' || typeof v.cwd !== 'string') return false;
  if (!Array.isArray(v.argv) || !v.argv.every((word) => typeof word === 'string')) return false;
  if (v.env === null || typeof v.env !== 'object' || !Object.values(v.env).every((item) => typeof item === 'string')) return false;
  const tty = v.tty as HostRequest['tty'] | null;
  return tty !== null && typeof tty === 'object' && typeof tty.stdin === 'boolean' && typeof tty.stdout === 'boolean' && typeof tty.stderr === 'boolean';
}

export type HostRunDeps = {
  /** The CLI's dispatcher. */
  main: (argv: string[], io: Io) => Promise<number>;
  /** The path `process.argv[1]` names during a run: the package's own CLI entry, so the build
   *  identity a record carries is the one an in-process run would carry. */
  cliEntry: string;
  /** The host's own environment, as it was when the host started. */
  ownEnv: Record<string, string | undefined>;
  /** Tests only: placement sources standing in for the processes, merged into the run's io. */
  callerSources?: Io['callerSources'];
};

export type HostRunResult = { answer: HostAnswer; recycle: string | null };

type Captured = { stdout: string[]; stderr: string[] };

/** Runs one request. Never throws: every outcome is an answer. `recycle` names why the host should
 *  exit after answering (a scope the run left open), or null. */
export async function runHostedLine(request: HostRequest, peer: HostPeer, deps: HostRunDeps): Promise<HostRunResult> {
  const shape = lineFallback(request.argv);
  if (shape !== null) return { answer: { v: 1, kind: 'fallback', why: shape }, recycle: null };
  const env = envFallback(request.env, deps.ownEnv);
  if (env !== null) return { answer: { v: 1, kind: 'fallback', why: env }, recycle: null };

  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedArgv = process.argv;
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const captured: Captured = { stdout: [], stderr: [] };
  let code = 1;
  let thrown: unknown = null;
  let fellBack: string | null = null;
  let first: string | null = null;
  let lateCallbacks = 0;
  let stopped: HostedStoppedAfterEffect | null = null;
  // One terminal-host snapshot for the whole request: the admission's placement and the line's
  // own read the caller's pane once (the command's own snapshot joins this one).
  let snapshot: number | null = null;
  try {
    replaceEnv(request.env);
    process.chdir(request.cwd);
    process.argv = [savedArgv[0] ?? 'bun', deps.cliEntry, ...request.argv];
    captureOutput(captured);
    resetCallerCaches();
    snapshot = beginHerdrSnapshot();
    const io: Io = {
      stdout: (text) => void captured.stdout.push(text),
      stderr: (text) => void captured.stderr.push(text),
      cwd: request.cwd,
      env: { ...request.env },
      stdinIsTTY: request.tty.stdin,
      stdoutIsTTY: request.tty.stdout,
      stderrIsTTY: request.tty.stderr,
      ...(deps.callerSources !== undefined ? { callerSources: deps.callerSources } : {}),
    };
    armHostedGuard(peer.check);
    code = await runAsHostedRequest(
      { peerPid: peer.pid, startPid: peer.ppid, currentParent: peer.currentParent },
      async () => {
        // The admission step before dispatch (§2.5 item 3): only a placed, unconfined seat runs here.
        const caller = callerOf(io);
        if (caller.kind !== 'seat') throw new HostedFallback(`the caller is placed as ${caller.kind}, not a seat`);
        if (caller.confined === true) throw new HostedFallback('the caller is a confined seat');
        try {
          return await deps.main([...request.argv], io);
        } finally {
          // Work the line left running is drained inside the request: the hosted scope, the armed
          // guard and the request's environment all still hold, so a deferred effect is checked
          // and blocked exactly as the line's own (rfc-bus-send-server §2.4).
          lateCallbacks = await settleHostedDeferred(DEFERRED_WAIT_MS);
        }
      },
    );
  } catch (error) {
    thrown = error;
  } finally {
    endHerdrSnapshot(snapshot);
    const guard = disarmHostedGuard();
    stopped = guard.stopped ?? null;
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
    Object.assign(console, savedConsole);
    process.argv = savedArgv;
    try { process.chdir(savedCwd); } catch { /* the host's own folder went away: the next chdir says so */ }
    replaceEnv(savedEnv);
    resetCallerCaches();
    fellBack = guard.fellBack;
    first = guard.first;
  }
  const recycle = currentRunMemo() !== null
    ? 'a run-memo scope was left open'
    : activeHerdrSnapshotId() !== null ? 'a herdr snapshot was left open'
      : lateCallbacks > 0 ? `${String(lateCallbacks)} deferred callback(s) outlived the request` : null;
  if ((thrown instanceof HostedFallback || fellBack !== null) && first === null) {
    return { answer: { v: 1, kind: 'fallback', why: thrown instanceof HostedFallback ? thrown.why : fellBack ?? 'handed back' }, recycle };
  }
  // A stop is latched in the guard: a command that caught it and returned normally is still a
  // stopped line, reported with exit 1.
  const stop = thrown instanceof HostedStoppedAfterEffect ? thrown : stopped;
  if (stop !== null) {
    captured.stderr.push(`team: ${stop.message}\n`);
    return { answer: { v: 1, kind: 'ran', code: 1, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') }, recycle };
  }
  if (thrown !== null) {
    captured.stderr.push(`team: ${thrown instanceof Error ? thrown.message : String(thrown)}\n`);
    code = 1;
  }
  return { answer: { v: 1, kind: 'ran', code, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') }, recycle };
}

function replaceEnv(next: Record<string, string | undefined>): void {
  for (const name of Object.keys(process.env)) {
    if (!(name in next)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(next)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function captureOutput(captured: Captured): void {
  const sink = (into: string[]) => ((chunk: unknown, ...rest: unknown[]) => {
    into.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    const done = rest.find((item) => typeof item === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink(captured.stdout);
  process.stderr.write = sink(captured.stderr);
  const line = (into: string[]) => (...items: unknown[]) => {
    into.push(`${items.map((item) => (typeof item === 'string' ? item : inspect(item))).join(' ')}\n`);
  };
  console.log = line(captured.stdout);
  console.info = line(captured.stdout);
  console.debug = line(captured.stdout);
  console.warn = line(captured.stderr);
  console.error = line(captured.stderr);
}
