// The machine daemon's supervision of the warm send host (`team daemon run --send-server`). The
// host is a child process the daemon starts from its own program copy, and starts again after it
// exits (a recycle, a crash), waiting longer after each quick exit, from one second to thirty. The
// daemon's stop ends it with SIGTERM: it hands back its queued lines and lets the running one end.
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineConfigDir } from '../daemon/paths.ts';
import { dialing, socketRuntime } from '../runtime/bun-socket.ts';

export type SendServerSupervisor = { stop: () => Promise<void> };

const FIRST_WAIT_MS = 1_000;
const LAST_WAIT_MS = 30_000;
/** A child that lived this long resets the wait to the first step. */
const STEADY_MS = 60_000;
/** How often the daemon asks a running host to answer, from its own event loop. */
export const PROBE_EVERY_MS = 10_000;
/** How long one probe may wait for any answer. */
export const PROBE_DEADLINE_MS = 10_000;
/** Probes missed in a row before a live but unanswering host is killed and started again. */
export const PROBE_MISSES = 2;

/** One liveness probe: a frame the host answers at once, before any queue, from its event loop
 *  (it is not a request, so the answer is a hand-back and nothing runs). True when any answer
 *  came back within the deadline. */
export function probeSendHost(socketPath: string, deadlineMs: number): Promise<boolean> {
  return new Promise((settle) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      settle(ok);
    };
    const Bun = socketRuntime();
    const { conn: socket, options, refused } = dialing(socketPath, {
      open: (conn) => conn.write('{"v":1,"probe":true}\n'),
      bytes: () => finish(true),
      close: () => finish(false),
    });
    const timer = setTimeout(() => finish(false), deadlineMs);
    Bun.connect(options).catch(refused);
  });
}

export function superviseSendServer(input: {
  home: string;
  log: (line: string) => void;
  /** Tests: the entry to run instead of this build's host. */
  entry?: string;
  /** The host's socket; the machine's own by default. */
  socketPath?: string;
  /** Tests: the probe rhythm and deadline. */
  probeEveryMs?: number;
  probeDeadlineMs?: number;
  /** Tests: how long after its start a host is first probed (it needs time to load). */
  probeGraceMs?: number;
}): SendServerSupervisor {
  const socketPath = input.socketPath ?? join(machineConfigDir(input.home), 'send-host.sock');
  const every = input.probeEveryMs ?? PROBE_EVERY_MS;
  const deadline = input.probeDeadlineMs ?? PROBE_DEADLINE_MS;
  const grace = input.probeGraceMs ?? 30_000;
  const entry = input.entry ?? fileURLToPath(new URL('./main.js', import.meta.url));
  let child: ChildProcess | null = null;
  let stopped = false;
  let wait = FIRST_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = (): void => {
    if (stopped) return;
    const startedAt = Date.now();
    const one = spawn(process.execPath, [entry, '--home', input.home], { stdio: 'ignore', env: process.env });
    child = one;
    input.log(`send server: started (pid ${String(one.pid ?? '?')})`);
    one.once('exit', (code, signal) => {
      if (child === one) child = null;
      if (stopped) return;
      const lived = Date.now() - startedAt;
      wait = lived >= STEADY_MS ? FIRST_WAIT_MS : Math.min(LAST_WAIT_MS, wait * 2);
      input.log(`send server: exited (${signal ?? String(code)}); started again in ${String(Math.round(wait / 1000))} s`);
      timer = setTimeout(start, wait);
    });
    one.once('error', (error) => input.log(`send server: could not start: ${error.message}`));
    // The watchdog runs in the daemon, not in the host: a host whose event loop is stuck cannot
    // run its own queue timers. A host that misses PROBE_MISSES probes in a row is killed; its
    // submitted clients see the connection close and end ambiguous (never retried), and the exit
    // handler above starts the next host.
    let misses = 0;
    let probing = false;
    const watch = setInterval(() => {
      if (stopped || child !== one || probing || Date.now() - startedAt < grace) return;
      probing = true;
      void probeSendHost(socketPath, deadline).then((ok) => {
        probing = false;
        if (child !== one || stopped) return;
        misses = ok ? 0 : misses + 1;
        if (misses >= PROBE_MISSES) {
          input.log(`send server: did not answer ${String(misses)} probes in a row; killed (pid ${String(one.pid ?? '?')})`);
          one.kill('SIGKILL');
        }
      });
    }, every);
    one.once('exit', () => clearInterval(watch));
  };
  start();

  return {
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      const one = child;
      if (one === null || one.exitCode !== null) return;
      await new Promise<void>((settle) => {
        const force = setTimeout(() => { one.kill('SIGKILL'); settle(); }, 5_000);
        one.once('exit', () => { clearTimeout(force); settle(); });
        one.kill('SIGTERM');
      });
    },
  };
}
