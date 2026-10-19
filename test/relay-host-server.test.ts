// Focused, synthetic tests for the standalone framing host: one newline-terminated JSON line
// per connection, the daemon's frame limit, the optional frame-assembly deadline, one exact
// answer, and connection close.
// Every socket here lives in a fresh temp folder; no live daemon, seat or session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostServer, HOST_DEADLINE_MS, HOST_FRAME_LIMIT } from '../packages/relay/host/server.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-host-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Answer = { text: string; closed: boolean };

/** One client: connect, write `bytes` when given, and collect the answer until close (or a
 *  bounded wait when the server keeps the connection open). */
function ask(socketPath: string, bytes: string | null, waitMs = 2_000): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let text = '';
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ text, closed });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => {
      if (bytes !== null) socket.write(bytes);
    });
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    socket.on('close', () => finish(true));
  });
}

function start(overrides: Partial<Parameters<typeof createHostServer>[0]> = {}) {
  const dir = scratch();
  const socketPath = join(dir, 'host.sock');
  const seen: unknown[] = [];
  const refusals: string[] = [];
  const server = createHostServer({
    socketPath,
    onRequest: (input) => {
      seen.push(input);
      return '{"v":1,"ok":true}\n';
    },
    onRefused: (reason) => {
      refusals.push(reason);
      return `${reason}\n`;
    },
    ...overrides,
  });
  return { server, socketPath, seen, refusals };
}

describe('relay host framing', () => {
  test('derives its frame limit from the daemon protocol and leaves the deadline off', () => {
    expect(HOST_FRAME_LIMIT).toBe(65_536);
    // The existing daemon socket has no server-side deadline; its 500 ms figure is the health
    // client's probe, not a server budget, so the default here is off.
    expect(HOST_DEADLINE_MS).toBe(0);
  });

  test('reads one complete line, decodes it as untrusted data, and writes the exact answer', async () => {
    const answers: string[] = [];
    const { server, socketPath, seen } = start({
      onRequest: (input) => {
        // The whole decoded value is passed through; no field is treated as a principal.
        answers.push(JSON.stringify(input));
        return '  {"v":1, "ok":true}  \n';
      },
    });
    expect(await server.listen()).toEqual({ ok: true });
    const input = '{"v":1,"op":"health","caller":{"seat":"claimed-owner"}}';
    // The second line in the same write must not produce a second answer.
    const answer = await ask(socketPath, `${input}\n{"v":1,"op":"second"}\n`);
    expect(answer).toEqual({ text: '  {"v":1, "ok":true}  \n', closed: true });
    expect(answers).toEqual([input]);
    expect(seen).toEqual([]);
    await server.close();
  });

  test('a malformed line is refused before the handler sees it', async () => {
    const { server, socketPath, seen, refusals } = start();
    await server.listen();
    const answer = await ask(socketPath, 'this is not json\n');
    expect(answer).toEqual({ text: 'malformed\n', closed: true });
    expect(seen).toEqual([]);
    expect(refusals).toEqual(['malformed']);
    await server.close();
  });

  test('the frame limit is the daemon buffer check, newline included', async () => {
    const { server, socketPath, seen, refusals } = start({ frameLimit: 8 });
    await server.listen();
    // 7 characters plus the newline is 8 buffered characters: accepted.
    expect(await ask(socketPath, '1234567\n')).toEqual({ text: '{"v":1,"ok":true}\n', closed: true });
    // 8 characters plus the newline is 9: refused before the newline search, never truncated.
    expect(await ask(socketPath, '12345678\n')).toEqual({ text: 'frame-limit\n', closed: true });
    expect(seen).toHaveLength(1);
    expect(refusals).toEqual(['frame-limit']);
    await server.close();
  });

  test('a connection that sends nothing is answered on an explicit deadline', async () => {
    const { server, socketPath, seen, refusals } = start({ deadlineMs: 40 });
    await server.listen();
    const answer = await ask(socketPath, null);
    expect(answer).toEqual({ text: 'deadline\n', closed: true });
    expect(seen).toEqual([]);
    expect(refusals).toEqual(['deadline']);
    await server.close();
  });

  test('with the default deadline off, a silent connection is left open', async () => {
    const { server, socketPath, seen, refusals } = start({ deadlineMs: 0 });
    await server.listen();
    // No refusal bytes and no handler call inside the wait: the server waits for the line.
    const answer = await ask(socketPath, null, 120);
    expect(answer).toEqual({ text: '', closed: false });
    expect(seen).toEqual([]);
    expect(refusals).toEqual([]);
    await server.close();
  });

  test('the deadline covers frame assembly, never an admitted handler', async () => {
    const { server, socketPath, refusals } = start({
      deadlineMs: 40,
      onRequest: async () => {
        // Longer than the deadline: the line arrived, so the handler is not cut off.
        await new Promise((done) => setTimeout(done, 90));
        return '{"v":1,"ok":true}\n';
      },
    });
    await server.listen();
    expect(await ask(socketPath, '{"op":"health"}\n')).toEqual({ text: '{"v":1,"ok":true}\n', closed: true });
    expect(refusals).toEqual([]);
    await server.close();
  });

  test('a multi-byte character split across writes is decoded before the line is parsed', async () => {
    const inputs: unknown[] = [];
    const { server, socketPath } = start({
      onRequest: (input) => {
        inputs.push(input);
        return '{"ok":true}\n';
      },
    });
    await server.listen();
    const answer = await new Promise<Answer>((resolve, reject) => {
      const socket = connect({ path: socketPath });
      let text = '';
      socket.on('error', reject);
      socket.on('connect', async () => {
        socket.write('{"note":"');
        await new Promise((done) => setTimeout(done, 20));
        // U+00E9 is two UTF-8 bytes; each arrives in its own chunk.
        socket.write(Buffer.from([0xc3]));
        await new Promise((done) => setTimeout(done, 20));
        socket.write(Buffer.from([0xa9]));
        await new Promise((done) => setTimeout(done, 20));
        socket.write('"}\n');
      });
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
      });
      socket.on('close', () => resolve({ text, closed: true }));
    });
    expect(answer).toEqual({ text: '{"ok":true}\n', closed: true });
    expect(inputs).toEqual([{ note: 'é' }]);
    await server.close();
  });

  test('a thrown or rejected handler is a caller-shaped handler error', async () => {
    const thrown = start({
      onRequest: () => {
        throw new Error('handler exploded');
      },
    });
    await thrown.server.listen();
    expect(await ask(thrown.socketPath, '{"op":"health"}\n')).toEqual({ text: 'handler-error\n', closed: true });
    await thrown.server.close();

    const rejected = start({ onRequest: () => Promise.reject(new Error('handler rejected')) });
    await rejected.server.listen();
    expect(await ask(rejected.socketPath, '{"op":"health"}\n')).toEqual({ text: 'handler-error\n', closed: true });
    expect(rejected.refusals).toEqual(['handler-error']);
    await rejected.server.close();
  });

  test('an asynchronous handler answers, and concurrent connections keep their own inputs', async () => {
    const { server, socketPath } = start({
      onRequest: async (input) => {
        const id = (input as { id: string }).id;
        await new Promise((done) => setTimeout(done, id === 'slow' ? 30 : 1));
        return `{"id":"${id}"}\n`;
      },
    });
    await server.listen();
    const [slow, fast] = await Promise.all([
      ask(socketPath, '{"id":"slow"}\n'),
      ask(socketPath, '{"id":"fast"}\n'),
    ]);
    expect(slow).toEqual({ text: '{"id":"slow"}\n', closed: true });
    expect(fast).toEqual({ text: '{"id":"fast"}\n', closed: true });
    await server.close();
  });

  test('close destroys open connections and stops accepting', async () => {
    const { server, socketPath } = start({ deadlineMs: 0 });
    await server.listen();
    const socket = connect({ path: socketPath });
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('connect', () => resolve());
    });
    // Let the accept callback register the connection before close.
    await new Promise((done) => setTimeout(done, 20));
    const closed = new Promise<boolean>((resolve) => {
      socket.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    await server.close();
    expect(await closed).toBe(true);
    const after = await new Promise<string>((resolve) => {
      const next = connect({ path: socketPath });
      next.on('error', (error) => resolve((error as NodeJS.ErrnoException).code ?? 'error'));
      next.on('connect', () => {
        next.destroy();
        resolve('connected');
      });
    });
    expect(after).not.toBe('connected');
    expect(await server.listen()).toEqual({ ok: false, reason: 'the host server is closed', code: null });
  });

  test('an unknown file at the path is reported, never unlinked or repaired', async () => {
    const dir = scratch();
    const socketPath = join(dir, 'host.sock');
    writeFileSync(socketPath, 'a caller-owned file\n');
    const server = createHostServer({
      socketPath,
      onRequest: () => '{"ok":true}\n',
      onRefused: (reason) => `${reason}\n`,
    });
    const result = await server.listen();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('EADDRINUSE');
      expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(readFileSync(socketPath, 'utf8')).toBe('a caller-owned file\n');
    await server.close();
  });
});
