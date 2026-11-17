// The machine daemon's supervision of the warm send host (`team daemon run --send-server`). The
// host is a child process the daemon starts from its own program copy, and starts again after it
// exits (a recycle, a crash), waiting longer after each quick exit, from one second to thirty. The
// daemon's stop ends it with SIGTERM: it hands back its queued lines and lets the running one end.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type SendServerSupervisor = { stop: () => Promise<void> };

const FIRST_WAIT_MS = 1_000;
const LAST_WAIT_MS = 30_000;
/** A child that lived this long resets the wait to the first step. */
const STEADY_MS = 60_000;

export function superviseSendServer(input: {
  home: string;
  log: (line: string) => void;
  /** Tests: the entry to run instead of this build's host. */
  entry?: string;
}): SendServerSupervisor {
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
