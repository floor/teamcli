// Synthetic fixtures for the reservation race suite: scratch roots, a deterministic preload
// barrier, and one- and two-process driver runners. Nothing here imports the reservation or
// store slice, so the file compiles and stands at the pin before those heads exist; the driver
// scripts that do import them live beside the tests that use them.
//
// A driver is a Bun script run as: bun <driver> <go-file> <ready-file> <command> <json-args>.
// It writes its ready file once its imports are loaded and its command is parsed, then waits
// for the go file, runs the command, and prints exactly one JSON line: { ok: true, result } or
// { ok: false, error }. The barrier is a file both processes poll, so the parent starts a
// scene without relying on timing: it spawns both, waits for both ready files, writes go, and
// reads the two answers. A missing JSON line is reported with the process's own stderr so a
// crash is never read as a refused effect.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type DriverAnswer<T> = { ok: true; result: T } | { ok: false; error: string };

export type DriverRun<T> = {
  answer: DriverAnswer<T> | null;
  code: number | null;
  stdout: string;
  stderr: string;
};

export type Scratch = {
  base: string;
  root: string;
  home: string;
  /** A path under the scratch base for a store root, not created until a test does. */
  store: string;
  cleanup(): void;
};

/** A fresh scratch tree with a HOME, a checkout folder and an uncreated store path. The caller
 *  removes it; `cleanup` is idempotent. */
export function scratch(prefix: string): Scratch {
  const base = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const root = join(base, 'checkout');
  const home = join(base, 'home');
  const store = join(base, 'runs');
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return {
    base,
    root,
    home,
    store,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** The barrier path pair for one process: the parent keeps `go`, the child gets both files. */
export function barrier(scratchBase: string, name: string): { go: string; ready: string } {
  return { go: join(scratchBase, `${name}.go`), ready: join(scratchBase, `${name}.ready`) };
}

export function releaseBarrier(go: string): void {
  writeFileSync(go, 'go\n');
}

/** A driver's side of the barrier: say ready, then wait for the parent's go. */
export function waitAtBarrier(go: string, ready: string): void {
  writeFileSync(ready, 'ready\n');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(go)) Atomics.wait(cell, 0, 0, 5);
}

/** A driver's one answer line, exactly the shape `parseAnswer` reads. */
export function reply<T>(answer: DriverAnswer<T>): void {
  console.log(JSON.stringify(answer));
}

function waitForFile(path: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`the driver never became ready: ${path}`);
    Atomics.wait(cell, 0, 0, 10);
  }
}

/** Spawns one driver against its barrier. The caller releases the barrier once every process of
 *  the scene is ready; `runDriver` is the single-process convenience. */
export function startDriver(
  driverPath: string,
  go: string,
  ready: string,
  command: string,
  args: unknown,
): ChildProcess {
  return spawn('bun', [driverPath, go, ready, command, JSON.stringify(args)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  });
}

function parseAnswer<T>(stdout: string): DriverAnswer<T> | null {
  const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    if (!parsed || typeof parsed !== 'object') return null;
    const answer = parsed as Record<string, unknown>;
    if (answer.ok === true && 'result' in answer) return { ok: true, result: answer.result as T };
    if (answer.ok === false && typeof answer.error === 'string') return { ok: false, error: answer.error };
    return null;
  } catch {
    return null;
  }
}

/** Runs one driver to completion and parses its one answer line. */
export async function runDriver<T>(driverPath: string, command: string, args: unknown, timeoutMs = 30_000): Promise<DriverRun<T>> {
  const base = mkdtempSync(join(tmpdir(), 'reservation-driver-'));
  const { go, ready } = barrier(base, 'solo');
  const child = startDriver(driverPath, go, ready, command, args);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  waitForFile(ready, timeoutMs);
  releaseBarrier(go);
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.on('exit', (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  rmSync(base, { recursive: true, force: true });
  return { answer: parseAnswer<T>(stdout), code, stdout, stderr };
}

/** Runs two drivers as one scene: both ready, then one go, then both answered. The pair is
 *  returned in the order the two argument lists were given. */
export async function runPair<T>(
  driverPath: string,
  first: { command: string; args: unknown },
  second: { command: string; args: unknown },
  timeoutMs = 30_000,
): Promise<[DriverRun<T>, DriverRun<T>]> {
  const base = mkdtempSync(join(tmpdir(), 'reservation-pair-'));
  const a = barrier(base, 'a');
  const b = barrier(base, 'b');
  const childA = startDriver(driverPath, a.go, a.ready, first.command, first.args);
  const childB = startDriver(driverPath, b.go, b.ready, second.command, second.args);
  let outA = '';
  let errA = '';
  let outB = '';
  let errB = '';
  childA.stdout?.on('data', (chunk: Buffer) => (outA += chunk.toString()));
  childA.stderr?.on('data', (chunk: Buffer) => (errA += chunk.toString()));
  childB.stdout?.on('data', (chunk: Buffer) => (outB += chunk.toString()));
  childB.stderr?.on('data', (chunk: Buffer) => (errB += chunk.toString()));
  waitForFile(a.ready, timeoutMs);
  waitForFile(b.ready, timeoutMs);
  releaseBarrier(a.go);
  releaseBarrier(b.go);
  const exit = (child: ChildProcess): Promise<number | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  const [codeA, codeB] = await Promise.all([exit(childA), exit(childB)]);
  rmSync(base, { recursive: true, force: true });
  return [
    { answer: parseAnswer<T>(outA), code: codeA, stdout: outA, stderr: errA },
    { answer: parseAnswer<T>(outB), code: codeB, stdout: outB, stderr: errB },
  ];
}

/** Reads one JSON file a driver wrote, or null. */
export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
