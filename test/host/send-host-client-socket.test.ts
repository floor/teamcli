// The send client's own socket (src/host/client.ts): Bun's unix socket, written in parts by the
// returned byte count. A stand-in host on node:net reads what arrives.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHost } from '../../src/host/client.ts';

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((settle) => server.close(() => settle()));
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { base: string; cliEntry: string; socketPath: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-client-socket-')));
  made.push(base);
  const cliEntry = join(base, 'cli.js');
  writeFileSync(cliEntry, '// a build\n');
  writeFileSync(join(base, 'build-id'), `${'c'.repeat(64)}\n`);
  return { base, cliEntry, socketPath: join(base, 'h.sock') };
}

/** A host that hands each whole request line to `answer`, and writes what it returns. */
async function standIn(socketPath: string, answer: (line: string, socket: Socket) => string | null): Promise<void> {
  const server = createServer((socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end < 0) return;
      const reply = answer(text.slice(0, end), socket);
      if (reply !== null) socket.end(reply);
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((settle) => server.listen(socketPath, () => settle()));
}

const tty = { stdin: false, stdout: false, stderr: false };

test('a ~600 KB multi-byte request arrives whole, byte for byte, and a split multi-byte answer reads back', async () => {
  const { base, cliEntry, socketPath } = fixture();
  // Three-byte and four-byte characters, so the request's byte count is far past its length.
  const body = 'é€\u{1F600}'.repeat(70_000);
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(600_000);
  let seen: { argv?: unknown } | null = null;
  const stdout = `got €\u{1F600}\n`.repeat(2_000);
  await standIn(socketPath, (line) => {
    seen = JSON.parse(line) as { argv?: unknown };
    return `${JSON.stringify({ v: 1, kind: 'ran', code: 0, stdout, stderr: '' })}\n`;
  });
  const outcome = await tryHost({ argv: ['send', 'lead', body], cwd: base, env: {}, tty, cliEntry, socketPath, connectWindowMs: 2_000 });
  expect(outcome).toEqual({ kind: 'ran', code: 0, stdout, stderr: '' });
  expect((seen as { argv?: unknown } | null)?.argv).toEqual(['send', 'lead', body]);
});

test('a host that closes after the request was written leaves the line ambiguous', async () => {
  const { base, cliEntry, socketPath } = fixture();
  let requests = 0;
  await standIn(socketPath, (_line, socket) => {
    requests += 1;
    socket.destroy();
    return null;
  });
  const outcome = await tryHost({ argv: ['send', 'lead', 'hi'], cwd: base, env: {}, tty, cliEntry, socketPath, connectWindowMs: 2_000 });
  expect(outcome.kind).toBe('ambiguous');
  expect(requests).toBe(1);
});

test('an answer this client does not read is ambiguous, never a hand-back', async () => {
  const { base, cliEntry, socketPath } = fixture();
  await standIn(socketPath, () => 'not json\n');
  const outcome = await tryHost({ argv: ['send', 'lead', 'hi'], cwd: base, env: {}, tty, cliEntry, socketPath, connectWindowMs: 2_000 });
  expect(outcome).toEqual({ kind: 'ambiguous', why: 'the answer is not JSON' });
});
