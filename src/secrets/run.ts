// The one child process a secret-store read runs: the store's own command, bounded by a deadline
// and by how much it may print. Its standard input is closed, so no command it runs can wait on a
// prompt; its standard error is discarded, so nothing the store says reaches a terminal, a record
// or a log; and its standard output is the only thing kept, in memory, by the adapter that asked.
// The secret is never an argument of this process or of any other. A test stands in for the whole
// function and never runs it.
import { spawn } from 'node:child_process';
import { hostedCommit } from '../host/request-scope.ts';

/** The entry names every store takes: a plain word that no shell reads twice, so it may stand as
 *  an argument and on a launch line as it is. The team's own files already hold names in this
 *  form (an identity's and an account's `keychain`). */
export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SecretRunResult = { ok: true; stdout: string } | { ok: false };

/** How one run is bounded, and the environment it runs in (absent: this process's own). */
export type SecretRunOptions = { env?: Record<string, string>; cap: number; timeoutMs: number };

/** The system call itself, so a test can stand in for it without ever running it. */
export type SecretRunner = (command: string, args: string[], options: SecretRunOptions) => Promise<SecretRunResult>;

/** The production runner. At the deadline, or once the output passes the cap, the child is
 *  terminated and the run reads as failed; a non-zero exit is a failure too. */
export const realSecretRun: SecretRunner = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = '';
    let done = false;
    const finish = (result: SecretRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(result);
    };
    hostedCommit('node:child_process.spawn');
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const deadline = setTimeout(() => {
      child.kill();
      finish({ ok: false });
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk;
      if (stdout.length > options.cap) {
        child.kill();
        finish({ ok: false });
      }
    });
    child.on('error', () => finish({ ok: false }));
    child.on('close', (code) => finish(code === 0 ? { ok: true, stdout } : { ok: false }));
  });
