// Starts the one mailbox router child. A failed start is a child that has already
// left, so the supervisor's restart path decides it and the beat does not throw.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MailboxChild, MailboxChildEvent, MailboxChildMessage } from './supervisor.ts';

const KILL_GRACE_MS = 2_000;

export function mailboxEntryOf(here: string = fileURLToPath(import.meta.url)): string | null {
  const name = here.endsWith('.ts') ? 'entry.ts' : 'entry.js';
  const candidate = join(dirname(here), name);
  return existsSync(candidate) ? candidate : null;
}

function leftChild(emitExit: boolean): MailboxChild {
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const listeners = new Set<(event: MailboxChildEvent) => void>();
  if (emitExit) {
    queueMicrotask(() => {
      for (const listener of listeners) listener({ kind: 'exit', code: null, signal: null });
      resolveExited();
    });
  } else {
    queueMicrotask(resolveExited);
  }
  return {
    pid: null,
    alive: false,
    send: () => false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kill() {
      resolveExited();
    },
    exited,
  };
}

/** Starts the router child. The child proves the token, then speaks newline JSON. */
export function spawnMailboxChild(): MailboxChild {
  const entry = mailboxEntryOf();
  if (entry === null) return leftChild(true);

  const dir = join(tmpdir(), `mailbox-router-${randomBytes(8).toString('hex')}`);
  const token = join(dir, 'token');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(token, 'mailbox-router\n', { mode: 0o600 });
  } catch {
    return leftChild(true);
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry, token], {
      cwd: dirname(entry),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpdir(),
      },
    });
  } catch {
    return leftChild(true);
  }

  const listeners = new Set<(event: MailboxChildEvent) => void>();
  let gone = false;
  let resolveExited: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  const emit = (event: MailboxChildEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener's failure is not the child's.
      }
    }
  };
  const finish = (): void => {
    if (gone) return;
    gone = true;
    resolveExited();
  };

  child.stdin?.on('error', () => undefined);
  child.stdout?.on('error', () => undefined);
  child.stderr?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8');
  let buffer = '';
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const frame = parsed as { type?: unknown; at?: unknown; result?: unknown };
      if (frame.type === 'heartbeat' && typeof frame.at === 'string') {
        const message: MailboxChildMessage = { type: 'heartbeat', at: frame.at };
        emit({ kind: 'message', message });
      }
    }
  });
  child.on('exit', (code, signal) => {
    emit({ kind: 'exit', code, signal });
    finish();
  });
  child.on('error', () => {
    emit({ kind: 'exit', code: null, signal: null });
    finish();
  });

  let killed = false;
  return {
    pid: child.pid ?? null,
    get alive() {
      return !gone;
    },
    send(message) {
      if (gone || child.stdin === null || child.stdin.destroyed) return false;
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    kill() {
      if (killed || gone) return;
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
      }
      const forced = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, KILL_GRACE_MS);
      forced.unref();
      void exited.then(() => clearTimeout(forced));
    },
    exited,
  };
}
