// A follower that skips its backlog comes up on a bus whose log holds more of its events than one
// answer carries: the bus answers `gap` at cursor 0, and the follower dials once more from the
// bus's newest record instead of staying down (a seat's channel server then waited for its folder
// watch on every push).
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { followBus } from '../src/bus/follow.ts';
import { busSocket } from '../src/bus/server.ts';

function fakeBus(root: string, answer: (cursor: number) => object): { cursors: number[]; close: () => Promise<void> } {
  const cursors: number[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      const request = JSON.parse(buffer.slice(0, at)) as { cursor: number };
      cursors.push(request.cursor);
      const reply = answer(request.cursor);
      if ((reply as { kind: string }).kind === 'gap') socket.end(`${JSON.stringify(reply)}\n`);
      else socket.write(`${JSON.stringify(reply)}\n`);
    });
  });
  server.listen(busSocket(root));
  return {
    cursors,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  };
}

function rootDir(): { root: string; drop: () => void } {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'follow-'));
  mkdirSync(join(base, '.agents'), { recursive: true });
  return { root: base, drop: () => rmSync(base, { recursive: true, force: true }) };
}

test('a skipped backlog too long for one answer dials again from the newest record and comes up', async () => {
  const { root, drop } = rootDir();
  const bus = fakeBus(root, (cursor) => cursor === 0
    ? { ok: true, kind: 'gap', oldest_seq: 65911, newest_seq: 86153 }
    : { ok: true, kind: 'events', events: [], cursor });
  await new Promise((r) => setTimeout(r, 20));
  const seen: string[] = [];
  const up = await new Promise<boolean>((done) => {
    const follow = followBus(root, { seat: 'worker', kinds: ['message.arrived'], skipBacklog: true }, {
      onUp: () => { follow.close(); done(true); },
      onEvent: () => {},
      onDown: (why) => { seen.push(why); done(false); },
    });
  });
  expect(up).toBe(true);
  expect(seen).toEqual([]);
  expect(bus.cursors).toEqual([0, 86153]);
  await bus.close();
  drop();
});

test('a follower that reads its backlog still treats a gap as down, and a second gap is never chased', async () => {
  const { root, drop } = rootDir();
  const bus = fakeBus(root, () => ({ ok: true, kind: 'gap', oldest_seq: 10, newest_seq: 20 }));
  await new Promise((r) => setTimeout(r, 20));
  const reading = await new Promise<string>((done) => {
    followBus(root, { seat: 'worker', cursor: 3 }, { onEvent: () => {}, onDown: done });
  });
  expect(reading).toBe('the bus no longer holds this cursor');
  const skipping = await new Promise<string>((done) => {
    followBus(root, { seat: 'worker', skipBacklog: true }, { onEvent: () => {}, onDown: done });
  });
  expect(skipping).toBe('the bus no longer holds this cursor');
  expect(bus.cursors).toEqual([3, 0, 20]);
  await bus.close();
  drop();
});
