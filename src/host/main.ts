// The warm send host's process entry: `bun <package>/dist/host/main.js --home <folder>`, started
// and restarted by the machine daemon when its unit carries `--send-host`. It loads the CLI once,
// holds git roots for its life (partitioned by each run's git environment), and serves until it
// recycles; the daemon then starts the next one.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineConfigDir } from '../daemon/paths.ts';
import { holdGitRoots } from '../file/load.ts';
import { startSendHost } from './server.ts';

const at = process.argv.indexOf('--home');
const home = at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : homedir();
const logPath = join(machineConfigDir(home), 'send-host.log');
const log = (line: string): void => {
  try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the log is best effort */ }
};
const ownEnv: Record<string, string | undefined> = { ...process.env };
const cliEntry = fileURLToPath(new URL('../cli.js', import.meta.url));

const cli = await import('../cli.ts');
// The send graph, loaded now so the first line is warm.
await import('../commands/send.ts');
await import('../commands/reply.ts');
await import('../commands/ack.ts');
const release = holdGitRoots();
try {
  const host = await startSendHost({
    home,
    cliEntry,
    main: cli.main,
    ownEnv,
    log,
    onStop: (why) => {
      log(`send host: exiting (${why})`);
      release();
      setTimeout(() => process.exit(0), 50);
    },
  });
  const quit = (signal: string) => { void host.close(signal); };
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('SIGINT', () => quit('SIGINT'));
} catch (error) {
  log(`send host: not started: ${error instanceof Error ? error.message : String(error)}`);
  release();
  process.exit(1);
}
