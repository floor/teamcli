import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { busSocket, nudgeBusNoWait } from '../src/bus/server.ts';

const RECORD = { session: 's', seat: 'worker', record_id: 'rec-1' };

describe('nudgeBusNoWait', () => {
  test('no bus listening: unavailable, at once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nudge-'));
    mkdirSync(join(root, '.agents'));
    const t0 = performance.now();
    expect(await nudgeBusNoWait(root, RECORD, { deadlineMs: 250 })).toEqual({ kind: 'unavailable' });
    expect(performance.now() - t0).toBeLessThan(200);
  });

  test('a bus that never answers: sent as soon as the line is written, and the bus still reads the whole line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nudge-'));
    mkdirSync(join(root, '.agents'));
    let received = '';
    const got = new Promise<string>((resolve) => {
      const server = createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => { received += chunk; });
        socket.on('close', () => { server.close(); resolve(received); });
      });
      server.listen(busSocket(root));
    });
    await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    expect(await nudgeBusNoWait(root, RECORD, { deadlineMs: 250 })).toEqual({ kind: 'sent' });
    expect(performance.now() - t0).toBeLessThan(150);
    const line = await got;
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ op: 'nudge', session: 's', seat: 'worker', record_id: 'rec-1' });
  });
});
