// The relay package's boundary, run for real: one durable copy written whole, and exactly one
// route attempt per `deliver` call. The records here are stand-in texts — the package never
// parses or checks them — and the socket is a stub dial, so no listener is opened and no live
// session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilities, deliver, FRAME_LIMIT, SEND_TIMEOUT_MS, stage } from '../packages/relay/index.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = new Date('2026-10-20T00:00:00.000Z');
const record = '{\n  "payload": {},\n  "signature": "x"\n}\n';

describe('stage', () => {
  test('writes the record bytes whole, 0600 in a 0700 folder, and stamps the caller clock', async () => {
    const dir = scratch();
    const copy = { dir: join(dir, 'send-drops', 's', 'seat'), name: 'msg-1' };
    const staged = await stage(copy, { id: 'msg-1', record }, { now: () => AT });
    if (staged.outcome !== 'stored') throw new Error(JSON.stringify(staged));
    expect(staged.receipt).toEqual({ copy: join(copy.dir, 'msg-1'), at: AT.toISOString() });
    expect(readFileSync(join(copy.dir, 'msg-1'), 'utf8')).toBe(record);
    expect(statSync(join(copy.dir, 'msg-1')).mode & 0o777).toBe(0o600);
    expect(statSync(copy.dir).mode & 0o777).toBe(0o700);
  });

  test('a different record already at the name is refused and left untouched', async () => {
    const dir = scratch();
    const copy = { dir, name: 'msg-2' };
    writeFileSync(join(dir, 'msg-2'), 'not a record at all');
    const staged = await stage(copy, { id: 'msg-2', record }, { now: () => AT });
    expect(staged).toMatchObject({ outcome: 'refused', reason: 'a different record already holds that id' });
    expect(readFileSync(join(dir, 'msg-2'), 'utf8')).toBe('not a record at all');
  });

  test('a second stage of identical bytes is existing and never rewrites the file', async () => {
    const dir = scratch();
    const copy = { dir, name: 'msg-3' };
    await stage(copy, { id: 'msg-3', record }, { now: () => AT });
    const again = await stage(copy, { id: 'msg-3', record }, { now: () => AT });
    if (again.outcome !== 'stored') throw new Error(JSON.stringify(again));
    expect(again.receipt.existing).toBe(true);
    expect(readFileSync(join(dir, 'msg-3'), 'utf8')).toBe(record);
  });

  test('a second stage of different bytes is refused and keeps the first bytes', async () => {
    const dir = scratch();
    const copy = { dir, name: 'msg-3b' };
    await stage(copy, { id: 'msg-3b', record }, { now: () => AT });
    const again = await stage(copy, { id: 'msg-3b', record: 'different\n' }, { now: () => AT });
    expect(again).toMatchObject({ outcome: 'refused', reason: 'a different record already holds that id' });
    expect(readFileSync(join(dir, 'msg-3b'), 'utf8')).toBe(record);
  });

  test('a holder that cannot be read is refused, never replaced', async () => {
    const dir = scratch();
    const path = join(dir, 'msg-3c');
    writeFileSync(path, 'locked bytes');
    chmodSync(path, 0o000);
    try {
      const staged = await stage({ dir, name: 'msg-3c' }, { id: 'msg-3c', record }, { now: () => AT });
      expect(staged).toMatchObject({
        outcome: 'refused',
        reason: 'the file that already holds that id could not be read',
      });
    } finally {
      chmodSync(path, 0o600);
    }
    expect(readFileSync(path, 'utf8')).toBe('locked bytes');
  });

  test('a FIFO at the name is refused without blocking or replacing it', async () => {
    const dir = scratch();
    const path = join(dir, 'msg-3d');
    execFileSync('mkfifo', [path]);
    const staged = await stage({ dir, name: 'msg-3d' }, { id: 'msg-3d', record }, { now: () => AT });
    expect(staged).toMatchObject({ outcome: 'refused', reason: 'a file that is not a record already holds that id' });
    expect(statSync(path).isFIFO()).toBe(true);
  });

  test('concurrent writers under different bytes: one publish, every other refused, winner untouched', async () => {
    const dir = scratch();
    const name = 'msg-3e';
    const start = Date.now() + 400;
    const entry = new URL('../packages/relay/index.js', import.meta.url).href;
    const children = ['race-a', 'race-b', 'race-c', 'race-d'].map((mark) => {
      const recordText = `{"payload":"${mark}"}\n`;
      const code = `import { stage } from ${JSON.stringify(entry)};
await new Promise((resolve) => setTimeout(resolve, ${String(start)} - Date.now()));
const result = await stage({ dir: ${JSON.stringify(dir)}, name: ${JSON.stringify(name)} }, { id: ${JSON.stringify(name)}, record: ${JSON.stringify(recordText)} });
process.stdout.write(JSON.stringify({ record: ${JSON.stringify(recordText)}, result }));`;
      const proc = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' });
      return { proc, record: recordText };
    });
    const results = await Promise.all(
      children.map(async ({ proc, record: recordText }) => {
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (code !== 0) throw new Error(`race child exited ${String(code)}: ${err}`);
        const parsed = JSON.parse(out) as { record: string; result: { outcome: string } };
        expect(parsed.record).toBe(recordText);
        return parsed;
      }),
    );
    const stored = results.filter((item) => item.result.outcome === 'stored');
    expect(stored).toHaveLength(1);
    expect(results.filter((item) => item.result.outcome === 'refused')).toHaveLength(3);
    expect(readFileSync(join(dir, name), 'utf8')).toBe(stored[0]!.record);
  });

  test('a link at the name is refused, never followed', async () => {
    const dir = scratch();
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'msg-4'));
    const staged = await stage({ dir, name: 'msg-4' }, { id: 'msg-4', record }, { now: () => AT });
    expect(staged).toMatchObject({ outcome: 'refused', reason: 'a file that is not a record already holds that id' });
  });

  test('a name that would leave the folder is refused', async () => {
    const dir = scratch();
    for (const name of ['../msg-5', 'a/b', '.', '..', '']) {
      const staged = await stage({ dir, name }, { id: name, record }, { now: () => AT });
      expect(staged).toMatchObject({ outcome: 'refused', reason: 'the record id cannot be a file name' });
    }
  });

  test('a missing record text is refused before anything is written', async () => {
    const dir = scratch();
    const staged = await stage({ dir, name: 'msg-6' }, { id: 'msg-6' } as never, { now: () => AT });
    expect(staged).toMatchObject({ outcome: 'refused', reason: 'the signed record is missing' });
  });
});

describe('deliver', () => {
  test('the durable-copy route stores and answers held, never delivered', async () => {
    const dir = scratch();
    const copy = { dir, name: 'msg-7' };
    const attempt = await deliver({ route: 'durable-copy', copy }, { id: 'msg-7', record }, { now: () => AT });
    expect(attempt).toMatchObject({
      route: 'durable-copy',
      outcome: 'held',
      receipt: { copy: join(dir, 'msg-7'), at: AT.toISOString() },
    });
    expect(readFileSync(join(dir, 'msg-7'), 'utf8')).toBe(record);
    const again = await deliver({ route: 'durable-copy', copy }, { id: 'msg-7', record }, { now: () => AT });
    if (again.outcome !== 'held') throw new Error(JSON.stringify(again));
    expect(again.receipt?.existing).toBe(true);
  });

  test('the socket route dials once with the frame as given and reports the bytes taken', async () => {
    const dir = scratch();
    const seen: [string, string, number | undefined][] = [];
    const frame = '{"type":"user"}\n';
    const attempt = await deliver(
      { route: 'socket', socket: '/tmp/relay-test.sock', runtime: 'claude-code', copy: { dir, name: 'msg-8' } },
      { id: 'msg-8', record, frame },
      {
        now: () => AT,
        dial: async (socketPath, sent, timeoutMs) => {
          seen.push([socketPath, sent, timeoutMs]);
          return { ok: true };
        },
      },
    );
    expect(seen).toEqual([['/tmp/relay-test.sock', frame, SEND_TIMEOUT_MS]]);
    expect(attempt).toMatchObject({
      route: 'socket',
      outcome: 'delivered',
      receipt: { copy: join(dir, 'msg-8'), bytes: frame.length, at: AT.toISOString() },
    });
  });

  test("a dial refusal is the attempt's refusal, with the dial reason kept", async () => {
    const attempt = await deliver(
      { route: 'socket', socket: '/tmp/relay-test.sock', runtime: 'claude-code', copy: { dir: '/tmp', name: 'msg-9' } },
      { id: 'msg-9', record, frame: 'x\n' },
      { now: () => AT, dial: async () => ({ ok: false, reason: 'nothing is listening there (the socket is gone)' }) },
    );
    expect(attempt).toMatchObject({ route: 'socket', outcome: 'refused', reason: 'nothing is listening there (the socket is gone)' });
  });

  test('a missing frame is refused and nothing is dialed', async () => {
    let dialed = false;
    const attempt = await deliver(
      { route: 'socket', socket: '/tmp/relay-test.sock', runtime: 'claude-code', copy: { dir: '/tmp', name: 'msg-10' } },
      { id: 'msg-10', record },
      { now: () => AT, dial: async () => ((dialed = true), { ok: true }) },
    );
    expect(dialed).toBe(false);
    expect(attempt).toMatchObject({ route: 'socket', outcome: 'refused', reason: 'the socket frame is missing' });
  });

  test('a runtime with no cross-session socket is refused before any connection', async () => {
    let dialed = false;
    const attempt = await deliver(
      { route: 'socket', socket: '/tmp/relay-test.sock', runtime: 'codex', copy: { dir: '/tmp', name: 'msg-11' } },
      { id: 'msg-11', record, frame: 'x\n' },
      { now: () => AT, dial: async () => ((dialed = true), { ok: true }) },
    );
    expect(dialed).toBe(false);
    expect(attempt).toMatchObject({ route: 'socket', outcome: 'refused', reason: 'codex sessions have no cross-session socket' });
  });

  test('a frame past the measured limit is refused before any connection', async () => {
    let dialed = false;
    const frame = 'x'.repeat(FRAME_LIMIT + 1);
    const attempt = await deliver(
      { route: 'socket', socket: '/tmp/relay-test.sock', runtime: 'claude-code', copy: { dir: '/tmp', name: 'msg-12' } },
      { id: 'msg-12', record, frame },
      { now: () => AT, dial: async () => ((dialed = true), { ok: true }) },
    );
    expect(dialed).toBe(false);
    expect(attempt.outcome).toBe('refused');
    if (attempt.outcome === 'refused') expect(attempt.reason).toContain("past the socket's measured limit");
  });

  test('a route the package does not carry is a caller error', async () => {
    await expect(
      deliver({ route: 'pigeon', copy: { dir: '/tmp', name: 'msg-13' } } as never, { id: 'msg-13', record }),
    ).rejects.toThrow('pigeon');
  });
});

describe('capabilities', () => {
  test('names the routes, the one supported runtime, the measured limits and no acknowledgement', () => {
    expect(capabilities('claude-code')).toEqual({
      routes: ['socket', 'durable-copy'],
      socket: { runtime: 'claude-code', supported: true, frameLimit: FRAME_LIMIT, timeoutMs: SEND_TIMEOUT_MS, ack: false },
      durableCopy: { supported: true },
    });
    expect(capabilities('codex').socket.supported).toBe(false);
  });
});
