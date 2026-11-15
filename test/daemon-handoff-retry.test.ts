// A typed handoff the daemon's endpoint dropped without answering is asked again, under the same
// id, once the endpoint answers a ping. 2026-11-15, vlist: an endpoint restarted after missed
// probes closed two senders' connections, and two messages to an idle Antigravity seat were kept
// with nobody woken.
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { retryDaemonHandoff } from '../src/commands/send.ts';
import { requestDaemon } from '../src/send/daemon.ts';
import { sendProbeReading } from '../src/daemon/host.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** An endpoint that drops the first `drops` send requests unanswered, then answers. */
function endpoint(drops: number): Promise<{ path: string; sends: string[] }> {
  const path = join(mkdtempSync(join(tmpdir(), 'hr-')), 's.sock');
  const sends: string[] = [];
  let dropped = 0;
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const request = JSON.parse(buffer.slice(0, nl)) as { op: string; id?: string };
      if (request.op === 'ping') {
        socket.end(`${JSON.stringify({ v: 1, ok: true, pong: true, pid: 1 })}\n`);
        return;
      }
      sends.push(request.id ?? '');
      if (dropped < drops) {
        dropped += 1;
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify({ v: 1, ok: true, id: request.id, seat: 'reviewer', outcome: 'handed', status: 'typed wake', drop_path: '/x' })}\n`);
    });
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve({ path, sends })));
}

const request = { v: 1 as const, op: 'send' as const, id: 'msg-1', from: 'lead', to: 'reviewer', body: 'hi', rule: 'r', name: 'reviewer', template: 't', typedWake: { trigger: 'read your inbox' } };

test('a dropped handoff is asked again under the same id once the endpoint answers', async () => {
  const { path, sends } = await endpoint(1);
  expect(await requestDaemon(path, request as never)).toBeNull();
  const again = await retryDaemonHandoff(path, request as never, { handoffRetryMs: 2_000 });
  expect(again).toMatchObject({ outcome: 'handed', id: 'msg-1' });
  expect(sends).toEqual(['msg-1', 'msg-1']);
});

test('an endpoint that never answers again leaves the handoff unanswered after the window', async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'hr-')), 'none.sock');
  expect(await retryDaemonHandoff(gone, request as never, { handoffRetryMs: 0 })).toBeNull();
});

test('a send-endpoint probe held by the shared event loop is not counted as the endpoint\'s miss', () => {
  expect(sendProbeReading(true, 9_000)).toBe('answered');
  // Refused or timed out on time: the endpoint's own miss.
  expect(sendProbeReading(false, 5)).toBe('miss');
  expect(sendProbeReading(false, 2_050)).toBe('miss');
  // The two-second timer fired seconds late: the loop was held, and nothing is counted.
  expect(sendProbeReading(false, 6_000)).toBe('held');
  // However the loop is held, an endpoint with no answer for over a minute is missing.
  expect(sendProbeReading(false, 6_000, 61_000)).toBe('miss');
  expect(sendProbeReading(false, 6_000, 30_000)).toBe('held');
});

test('the retry window is one deadline: an endpoint that holds connections silently gives up within it', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hr-')), 'silent.sock');
  const held: import('node:net').Socket[] = [];
  const silent = createServer((socket) => { held.push(socket); });
  servers.push(silent);
  await new Promise<void>((resolve) => silent.listen(path, () => resolve()));
  const began = performance.now();
  expect(await retryDaemonHandoff(path, request as never, { handoffRetryMs: 1_200 })).toBeNull();
  expect(performance.now() - began).toBeLessThanOrEqual(1_300);
  for (const socket of held) socket.destroy();
});

test('a pong near the deadline gets a replay bounded by the time left', async () => {
  // An endpoint that answers pings but holds every send unanswered: the replay ends at the deadline.
  const path = join(mkdtempSync(join(tmpdir(), 'hr-')), 'slow.sock');
  const held: import('node:net').Socket[] = [];
  const slow = createServer((socket) => {
    socket.on('data', (chunk) => {
      const line = chunk.toString('utf8');
      if (line.includes('"ping"')) socket.end(`${JSON.stringify({ v: 1, ok: true, pong: true, pid: 1 })}\n`);
      else held.push(socket);
    });
  });
  servers.push(slow);
  await new Promise<void>((resolve) => slow.listen(path, () => resolve()));
  const began = performance.now();
  expect(await retryDaemonHandoff(path, request as never, { handoffRetryMs: 1_200 })).toBeNull();
  expect(performance.now() - began).toBeLessThanOrEqual(1_300);
  for (const socket of held) socket.destroy();
});
