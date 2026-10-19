// Step-1 extraction tests for @teamcli/relay, run against the committed public entry
// (packages/relay/index.js, extraction 0635fd0d5).
//
// FIXED invariants (Atlas decision, 2026-10-20) that tests must pin: a signed durable copy before
// any attempt; never choose a would-hold/block route; one message ID with receiver dedup; every
// attempt recorded. Exactly-once can only come from real receiver dedup across an ambiguous first
// receipt — never from a kernel write or a queue ack — so this file asserts transport delivery and
// nothing stronger. Per-route timeout, route order and escalation delays are the policies that
// vary; they belong to the fallback/coordinator fixture, not here. Policies: delivery-order,
// delivery-timeout (per route), delivery-escalation (delays).
//
// Focused extraction tests for @teamcli/relay step 1, against B1's literal API:
//   stage(copy, message, options?) 0600 nofollow create-or-match. Byte preservation is proven by
//   reading the file back; receipt.bytes is deliberately not pinned (it is a socket-frame
//   measure, not a stage guarantee). A second record with different bytes under the same name is
//   refused by the contract. Two different records racing for one name end with one stored and
//   one refused, and the winner's bytes standing: the fixtures record the contract, not the
//   implementation.
//   deliver(target, message, options?) socket = kernel-write transport (delivered, never read);
//   durable-copy-only = held; socket supported for claude-code only; a socket delivery with no
//   frame is refused before anything is dialed. No frame content is validated here.
// Nothing here imports TeamCLI: the relay package is the only product module under test.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { capabilities, deliver, stage, type CopyTarget, type RelayMessage } from '../packages/relay/index.js';

const now = () => new Date('2026-10-20T10:00:00.000Z');

let base: string;
let copy: CopyTarget;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'relay-step1-'));
  copy = { dir: join(base, 'drops'), name: 'm-1' };
  mkdirSync(copy.dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function message(record = '{"payload":"one"}\n', id = 'm-1'): RelayMessage {
  return { id, record, frame: '{"message":{"content":"run team next"}}\n' };
}

/** A Unix socket that collects everything one accepted connection sends, resolving on its first
 *  data. No real CLI and no real session: the transport is a plain kernel socket. */
function listener(path: string): { server: Server; ready: Promise<void>; once: Promise<string>; accepted: () => number } {
  let accepts = 0;
  let resolveOnce: (text: string) => void = () => {};
  const once = new Promise<string>((resolve) => {
    resolveOnce = resolve;
  });
  const server = createServer((socket: Socket) => {
    accepts += 1;
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      resolveOnce(Buffer.concat(chunks).toString());
    });
    socket.on('error', () => {});
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  server.on('error', () => {});
  return { server, ready, once, accepted: () => accepts };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Poll a child-made signal; the deadline is real because the children are real processes. */
async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`a race child exited with ${String(code ?? signal)}`));
    });
  });
}

async function withTimeout<T>(work: Promise<T>, what: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('capabilities', () => {
  test('a claude-code runtime has the socket route and the durable copy, with the measured limits', () => {
    const caps = capabilities('claude-code');
    expect(caps.routes).toContain('socket');
    expect(caps.routes).toContain('durable-copy');
    expect(caps.socket.supported).toBe(true);
    expect(caps.socket.frameLimit).toBe(1048576);
    expect(caps.socket.timeoutMs).toBe(5000);
    expect(caps.socket.ack).toBe(false);
    expect(caps.durableCopy.supported).toBe(true);
  });

  test('another runtime has no socket route, and the durable copy is still there', () => {
    const caps = capabilities('codex');
    expect(caps.socket.supported).toBe(false);
    expect(caps.durableCopy.supported).toBe(true);
  });
});

describe('stage', () => {
  test('stores the signed record byte for byte in a 0600 regular file', async () => {
    const record = '{"payload":"one"}\n';
    const result = await stage(copy, message(record), { now });
    expect(result.outcome).toBe('stored');
    if (result.outcome !== 'stored') return;
    const path = join(copy.dir, copy.name);
    expect(result.receipt.copy).toBe(path);
    expect(result.receipt.at).toBe(now().toISOString());
    expect(readFileSync(path, 'utf8')).toBe(record);
    const held = lstatSync(path);
    expect(held.isFile()).toBe(true);
    expect(held.mode & 0o777).toBe(0o600);
  });

  test('staging the same bytes again is a create-or-match, not a second write', async () => {
    const first = await stage(copy, message(), { now });
    expect(first.outcome).toBe('stored');
    const again = await stage(copy, message(), { now });
    expect(again.outcome).toBe('stored');
    if (again.outcome !== 'stored') return;
    expect(again.receipt.existing).toBe(true);
    expect(again.receipt.copy).toBe(join(copy.dir, copy.name));
  });

  test('a different record under the same name is refused and the first copy stands', async () => {
    await stage(copy, message('{"payload":"one"}\n'), { now });
    const second = await stage(copy, message('{"payload":"two"}\n'), { now });
    expect(second.outcome).toBe('refused');
    if (second.outcome !== 'refused') return;
    expect(second.reason.length).toBeGreaterThan(0);
    expect(readFileSync(join(copy.dir, copy.name), 'utf8')).toBe('{"payload":"one"}\n');
  });

  test('a symlink standing where the copy would go is refused, and its target is untouched', async () => {
    const elsewhere = join(base, 'elsewhere');
    writeFileSync(elsewhere, 'keep me');
    symlinkSync(elsewhere, join(copy.dir, copy.name));
    const result = await stage(copy, message(), { now });
    expect(result.outcome).toBe('refused');
    expect(readFileSync(elsewhere, 'utf8')).toBe('keep me');
  });

  test('two different records racing for one name keep the winner and refuse the loser', async () => {
    const raceCopy: CopyTarget = { dir: join(base, 'race'), name: 'm-race' };
    const pad = 'a'.repeat(64 * 1024);
    const records = [`{"payload":"race-one","pad":"${pad}"}\n`, `{"payload":"race-two","pad":"${pad}"}\n`];
    const start = join(base, 'race-start');
    const script = join(base, 'race.mjs');
    const packageUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'relay', 'index.js')).href;
    writeFileSync(
      script,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        'const [pkg, dir, name, recordPath, readyPath, startPath, resultPath] = process.argv.slice(2);',
        'const { stage } = await import(pkg);',
        "writeFileSync(readyPath, '1');",
        'while (!existsSync(startPath)) await new Promise((resolve) => setTimeout(resolve, 2));',
        "const result = await stage({ dir, name }, { id: name, record: readFileSync(recordPath, 'utf8') });",
        'writeFileSync(resultPath, JSON.stringify(result));',
      ].join('\n'),
    );
    const entries = records.map((record, index) => {
      const recordPath = join(base, `race-record-${String(index)}`);
      writeFileSync(recordPath, record);
      return {
        record,
        recordPath,
        readyPath: join(base, `race-ready-${String(index)}`),
        resultPath: join(base, `race-result-${String(index)}`),
      };
    });
    const children = entries.map((entry) =>
      spawn(
        process.execPath,
        [script, packageUrl, raceCopy.dir, raceCopy.name, entry.recordPath, entry.readyPath, start, entry.resultPath],
        { stdio: 'ignore' },
      ),
    );
    try {
      await until(() => {
        const gone = children.find((child) => child.exitCode !== null || child.signalCode !== null);
        if (gone !== undefined) {
          throw new Error(`a race child exited before the barrier (${String(gone.exitCode ?? gone.signalCode)})`);
        }
        return entries.every((entry) => existsSync(entry.readyPath));
      }, 'both race children');
      writeFileSync(start, '1');
      await withTimeout(Promise.all(children.map((child) => exited(child))), 'the race children');
      const results = entries.map((entry) => JSON.parse(readFileSync(entry.resultPath, 'utf8')) as { outcome: string });
      const stored = results.flatMap((result, index) => (result.outcome === 'stored' ? [{ result, index }] : []));
      const refused = results.filter((result) => result.outcome === 'refused');
      expect(stored).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const winner = stored[0];
      if (winner === undefined) return;
      expect(readFileSync(join(raceCopy.dir, raceCopy.name), 'utf8')).toBe(entries[winner.index]!.record);
    } finally {
      for (const child of children) child.kill();
    }
  });
});

describe('deliver', () => {
  test('a durable-copy-only target is held: never delivered, never read', async () => {
    const messageOne = message();
    await stage(copy, messageOne, { now });
    const result = await deliver({ route: 'durable-copy', copy }, messageOne, { now });
    expect(result.route).toBe('durable-copy');
    expect(result.outcome).toBe('held');
    if (result.outcome === 'delivered') return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test('a socket delivery is the kernel write: the frame arrives whole, and the outcome is never read', async () => {
    const socketPath = join(base, 'cli.sock');
    const made = listener(socketPath);
    await made.ready;
    try {
      const frame = '{"message":{"content":"run team next"}}\n';
      const messageOne: RelayMessage = { ...message(), frame };
      await stage(copy, messageOne, { now });
      const result = await deliver(
        { route: 'socket', socket: socketPath, runtime: 'claude-code', copy },
        messageOne,
        { now, timeoutMs: 2000 },
      );
      expect(result.route).toBe('socket');
      expect(result.outcome).toBe('delivered');
      if (result.outcome === 'delivered') {
        expect(result.receipt.at).toBe(now().toISOString());
        expect(result.receipt.bytes).toBe(frame.length);
      }
      expect(await made.once).toBe(frame);
      expect(made.accepted()).toBe(1);
    } finally {
      await close(made.server);
    }
  });

  test('a socket target for a runtime with no socket is refused, and nothing is dialed', async () => {
    const socketPath = join(base, 'cli.sock');
    const made = listener(socketPath);
    await made.ready;
    try {
      const result = await deliver(
        { route: 'socket', socket: socketPath, runtime: 'codex', copy },
        message(),
        { now, timeoutMs: 2000 },
      );
      expect(result.route).toBe('socket');
      expect(result.outcome).not.toBe('delivered');
      if (result.outcome !== 'delivered') expect(result.reason.length).toBeGreaterThan(0);
      expect(made.accepted()).toBe(0);
    } finally {
      await close(made.server);
    }
  });

  test('a socket delivery with no frame is refused, and nothing is dialed', async () => {
    const socketPath = join(base, 'cli.sock');
    const made = listener(socketPath);
    await made.ready;
    try {
      const noFrame: RelayMessage = { id: 'm-1', record: '{"payload":"one"}\n' };
      await stage(copy, noFrame, { now });
      const result = await deliver(
        { route: 'socket', socket: socketPath, runtime: 'claude-code', copy },
        noFrame,
        { now, timeoutMs: 2000 },
      );
      expect(result.route).toBe('socket');
      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'delivered') expect(result.reason.length).toBeGreaterThan(0);
      expect(made.accepted()).toBe(0);
    } finally {
      await close(made.server);
    }
  });

  test('a socket nobody holds is refused, with a reason', async () => {
    const result = await deliver(
      { route: 'socket', socket: join(base, 'nobody.sock'), runtime: 'claude-code', copy },
      message(),
      { now, timeoutMs: 500 },
    );
    expect(result.route).toBe('socket');
    expect(result.outcome).not.toBe('delivered');
    if (result.outcome !== 'delivered') expect(result.reason.length).toBeGreaterThan(0);
  });
});
