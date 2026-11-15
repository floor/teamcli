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
  const again = await retryDaemonHandoff(path, request as never, { handoffRetryMs: 0 });
  expect(again).toMatchObject({ outcome: 'handed', id: 'msg-1' });
  expect(sends).toEqual(['msg-1', 'msg-1']);
});

test('an endpoint that never answers again leaves the handoff unanswered after the window', async () => {
  const gone = join(mkdtempSync(join(tmpdir(), 'hr-')), 'none.sock');
  expect(await retryDaemonHandoff(gone, request as never, { handoffRetryMs: 0 })).toBeNull();
});
