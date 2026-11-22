// The one connection shape every unix socket of the CLI is driven through (src/runtime/bun-socket.ts):
// a write the kernel does not take whole keeps its rest and writes it on drain, `end` sends what is
// queued and then a FIN, the peer's FIN ends this side after its queue, and `close` comes once, last,
// with the errno of a refused connect.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dialing, serving, socketRuntime, type BunListener, type SocketError } from '../src/runtime/bun-socket.ts';

const Bun = socketRuntime();
const made: string[] = [];
const listeners: BunListener[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bun-socket-')));
  made.push(dir);
  return join(dir, 's.sock');
}

test('a request and an answer far past the kernel buffer arrive whole, in order, both ways', async () => {
  const path = place();
  // Multi-byte characters, so a split read must not break one.
  const big = `${'é'.repeat(1 << 20)}\n`;
  listeners.push(Bun.listen(serving(path, (conn) => {
    let got = '';
    return { text: (chunk) => { got += chunk; if (got.endsWith('\n')) conn.end(got); } };
  })));
  const answer = await new Promise<{ text: string; closes: number }>((done) => {
    let text = '';
    let closes = 0;
    const { conn, options, refused } = dialing(path, {
      text: (chunk) => { text += chunk; },
      close: () => { closes += 1; setTimeout(() => done({ text, closes }), 20); },
    });
    conn.write(big); // queued until the connection opens
    Bun.connect(options).catch(refused);
  });
  expect(answer.text).toBe(big);
  expect(answer.closes).toBe(1);
});

test("a client's FIN still gets the answer the server wrote while reading it", async () => {
  const path = place();
  listeners.push(Bun.listen(serving(path, (conn) => ({ text: () => { conn.write('answer\n'); } }))));
  const text = await new Promise<string>((done) => {
    let got = '';
    const { options, refused } = dialing(path, {
      open: (conn) => conn.end('request\n'),
      text: (chunk) => { got += chunk; },
      close: () => done(got),
    });
    Bun.connect(options).catch(refused);
  });
  expect(text).toBe('answer\n');
});

test('a connect to a missing socket closes once, with ENOENT', async () => {
  const path = place();
  const missing = await new Promise<SocketError | undefined>((done) => {
    let calls = 0;
    const { options, refused } = dialing(path, { close: (error) => { calls += 1; setTimeout(() => done(calls === 1 ? error : undefined), 20); } });
    Bun.connect(options).catch(refused);
  });
  expect(missing?.code).toBe('ENOENT');
});

test('destroy closes once, after the call that asked for it, and a write after it is refused', async () => {
  const path = place();
  listeners.push(Bun.listen(serving(path, () => ({}))));
  const order: string[] = [];
  await new Promise<void>((done) => {
    const { conn, options, refused } = dialing(path, {
      open: (opened) => {
        opened.destroy();
        order.push('destroyed');
        order.push(`write ${String(opened.write('late'))}`);
      },
      close: () => { order.push('close'); done(); },
    });
    void conn;
    Bun.connect(options).catch(refused);
  });
  expect(order).toEqual(['destroyed', 'write false', 'close']);
});

test('a second listen on a live path throws EADDRINUSE', () => {
  const path = place();
  listeners.push(Bun.listen(serving(path, () => ({}))));
  let code: string | undefined;
  try {
    listeners.push(Bun.listen(serving(path, () => ({}))));
  } catch (error) {
    code = (error as SocketError).code;
  }
  expect(code).toBe('EADDRINUSE');
});
