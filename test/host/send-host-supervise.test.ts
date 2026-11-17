// The daemon's supervision of the warm send host (`team daemon run --send-server`,
// src/host/supervise.ts) with a stand-in entry: the child is started with `--home`, a child that
// exits is started again after the first wait, and the daemon's stop ends the running child with
// SIGTERM and starts no other.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseSendServer } from '../../src/host/supervise.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line !== '') : [];
}

test('the supervisor starts the host with --home, starts it again after an exit, and stop ends it with SIGTERM', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-supervise-')));
  made.push(base);
  const marks = join(base, 'marks.log');
  const entry = join(base, 'host.ts');
  // The first child exits at once (a recycle); the second stays until it is told to stop.
  writeFileSync(entry, [
    "import { appendFileSync, existsSync } from 'node:fs';",
    `const marks = ${JSON.stringify(marks)};`,
    "const first = !existsSync(marks);",
    "appendFileSync(marks, `start ${process.argv.slice(2).join(' ')}\\n`);",
    "process.on('SIGTERM', () => { appendFileSync(marks, 'sigterm\\n'); process.exit(0); });",
    'if (first) process.exit(0);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const log: string[] = [];
  const supervisor = superviseSendServer({ home: base, log: (line) => log.push(line), entry });
  await until(() => lines(marks).filter((line) => line.startsWith('start')).length >= 2);
  expect(lines(marks)[0]).toBe(`start --home ${base}`);
  expect(log.some((line) => line.includes('send server: exited') && line.includes('started again in 2 s'))).toBe(true);
  await supervisor.stop();
  expect(lines(marks).at(-1)).toBe('sigterm');
  const starts = lines(marks).filter((line) => line.startsWith('start')).length;
  await new Promise((settle) => setTimeout(settle, 300));
  expect(lines(marks).filter((line) => line.startsWith('start')).length).toBe(starts);
}, 15_000);

test('a live host that stops answering probes is killed and started again; an answering one is left alone', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-watchdog-')));
  made.push(base);
  const marks = join(base, 'marks.log');
  const sock = join(base, 'h.sock');
  const entry = join(base, 'host.ts');
  // Each child answers probes; the first stops answering (a stuck event loop) after 300 ms.
  writeFileSync(entry, [
    "import { appendFileSync, existsSync, unlinkSync } from 'node:fs';",
    "import { createServer } from 'node:net';",
    `const marks = ${JSON.stringify(marks)};`,
    `const sock = ${JSON.stringify(sock)};`,
    "const first = !existsSync(marks);",
    "appendFileSync(marks, `start ${process.pid}\\n`);",
    "try { unlinkSync(sock); } catch {}",
    "createServer((s) => s.on('data', () => s.end('{\"v\":1,\"kind\":\"fallback\",\"why\":\"probe\"}\\n'))).listen(sock);",
    "if (first) setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 300);",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const log: string[] = [];
  const supervisor = superviseSendServer({ home: base, log: (line) => log.push(line), entry, socketPath: sock, probeEveryMs: 100, probeDeadlineMs: 150, probeGraceMs: 0 });
  await until(() => lines(marks).filter((line) => line.startsWith('start')).length >= 2, 10_000);
  expect(log.some((line) => line.includes('did not answer 2 probes in a row; killed'))).toBe(true);
  const kills = log.filter((line) => line.includes('killed')).length;
  // The second host answers: over several probe rounds it is never killed.
  await new Promise((settle) => setTimeout(settle, 800));
  expect(log.filter((line) => line.includes('killed')).length).toBe(kills);
  await supervisor.stop();
}, 20_000);
