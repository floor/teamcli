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

// Latency bounds. A send's answer path ends with `end(answer)` (flush, then a half-close the
// client's own close finishes) and its bus nudge writes a line and destroys at once. A close that
// waits on a FIN nobody sends, a write parked on a drain that never fires, or a timer on either
// path costs whole seconds, not milliseconds; each bound here is far above a healthy round trip
// even on a loaded machine and far below such a wait.
const ROUND_TRIP_BOUND_MS = 250;

test('an answer ended by the server closes both sides promptly, every time', async () => {
  const path = place();
  let serverCloses = 0;
  listeners.push(Bun.listen(serving(path, (conn) => ({
    text: (chunk) => { if (chunk.endsWith('\n')) conn.end(`answer ${chunk}`); },
    close: () => { serverCloses += 1; },
  }))));
  const slowest = { ms: 0 };
  for (let i = 0; i < 40; i++) {
    const started = performance.now();
    const text = await new Promise<string>((done) => {
      let got = '';
      const { conn, options, refused } = dialing(path, { text: (chunk) => { got += chunk; }, close: () => done(got) });
      conn.write(`request ${String(i)}\n`);
      Bun.connect(options).catch(refused);
    });
    slowest.ms = Math.max(slowest.ms, performance.now() - started);
    expect(text).toBe(`answer request ${String(i)}\n`);
  }
  await new Promise((settle) => setTimeout(settle, 20));
  expect(serverCloses).toBe(40);
  expect(slowest.ms).toBeLessThan(ROUND_TRIP_BOUND_MS);
});

test("a request sent with the client's FIN: the answer and both closes come promptly", async () => {
  const path = place();
  let serverCloses = 0;
  listeners.push(Bun.listen(serving(path, (conn) => ({
    // Answered while the request is read, as node's own default would need too: after the FIN
    // is taken this side ends behind its queue.
    text: () => { conn.end('answer\n'); },
    close: () => { serverCloses += 1; },
  }))));
  const slowest = { ms: 0 };
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const text = await new Promise<string>((done) => {
      let got = '';
      const { options, refused } = dialing(path, { open: (conn) => conn.end('request\n'), text: (chunk) => { got += chunk; }, close: () => done(got) });
      Bun.connect(options).catch(refused);
    });
    slowest.ms = Math.max(slowest.ms, performance.now() - started);
    expect(text).toBe('answer\n');
  }
  await new Promise((settle) => setTimeout(settle, 20));
  expect(serverCloses).toBe(20);
  expect(slowest.ms).toBeLessThan(ROUND_TRIP_BOUND_MS);
});

test('a line written and destroyed at once (the nudge) reaches the server promptly, every time', async () => {
  const path = place();
  const arrived: number[] = [];
  listeners.push(Bun.listen(serving(path, () => ({ text: (chunk) => { if (chunk.endsWith('\n')) arrived.push(performance.now()); } }))));
  const sent: number[] = [];
  for (let i = 0; i < 40; i++) {
    await new Promise<void>((done) => {
      const { conn, options, refused } = dialing(path, {
        open: (opened) => {
          sent.push(performance.now());
          if (opened.write(`{"op":"nudge","n":${String(i)}}\n`)) { opened.destroy(); done(); } else opened.onDrain(() => { opened.destroy(); done(); });
        },
        close: () => done(),
      });
      void conn;
      Bun.connect(options).catch(refused);
    });
  }
  await new Promise((settle) => setTimeout(settle, 50));
  expect(arrived.length).toBe(40);
  const slowest = Math.max(...arrived.map((at, i) => at - sent[i]!));
  expect(slowest).toBeLessThan(ROUND_TRIP_BOUND_MS);
});
