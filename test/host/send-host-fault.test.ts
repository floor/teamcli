// The fault after the durable record and before the answer (rfc-bus-send-server §2.2): a real host
// process writes the line's record and is killed before it answers. The client's outcome is
// ambiguous, the line is never run again (locally or by the host), and exactly one record exists.
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHost } from '../../src/host/client.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('a host killed after the record write and before its answer leaves the client ambiguous and one record', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-fault-')));
  made.push(base);
  const cliEntry = join(base, 'cli.js');
  writeFileSync(cliEntry, '// a build\n');
  const child = spawn(process.execPath, [join(import.meta.dir, '..', 'helpers', 'send-host-fault-child.ts'), base, cliEntry, String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (chunk) => { errText += String(chunk); });
  await new Promise<void>((settle, fail) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) settle(); });
    child.on('exit', () => fail(new Error(`host child exited early: ${errText}`)));
  });
  const exited = new Promise<number | null>((settle) => child.on('exit', (_code, signal) => settle(signal === 'SIGKILL' ? -9 : 0)));
  const env: Record<string, string> = {};
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
  const outcome = await tryHost({
    argv: ['send', 'lead', 'hi'],
    cwd: base,
    env,
    tty: { stdin: false, stdout: false, stderr: false },
    cliEntry,
    socketPath: join(base, 'h.sock'),
    connectWindowMs: 1_000,
  });
  expect(outcome.kind).toBe('ambiguous');
  expect(await exited).toBe(-9);
  expect(readFileSync(join(base, 'records.log'), 'utf8')).toBe('one record\n');
  // The dead host left its socket file; a second try finds no one listening and is not submitted,
  // so nothing can run the line again behind the client's back.
  if (existsSync(join(base, 'h.sock'))) {
    const again = await tryHost({ argv: ['send', 'lead', 'hi'], cwd: base, env, tty: { stdin: false, stdout: false, stderr: false }, cliEntry, socketPath: join(base, 'h.sock'), connectWindowMs: 200 });
    expect(again.kind).toBe('not-submitted');
  }
  expect(readFileSync(join(base, 'records.log'), 'utf8')).toBe('one record\n');
});
