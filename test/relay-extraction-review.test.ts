// Independent review probe for the relay extraction at 7bd621057. It checks the package as a
// boundary rather than replaying the relay scenes: only Node builtins cross into it, its public shape
// is transport-only, the durable copy is create-or-match on TeamCLI's own unsigned-ready bytes,
// one stage precedes exactly one route attempt, and the framing host opens and owns nothing it
// was not handed.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHostServer, HOST_FRAME_LIMIT } from '../packages/relay/host/server.js';
import {
  capabilities,
  deliver,
  FRAME_LIMIT,
  SEND_TIMEOUT_MS,
  stage,
  type Dial,
  type RelayMessage,
} from '../packages/relay/index.js';
import { ensureRecord, signRecord, verifyRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const PACKAGE = resolve(import.meta.dir, '..', 'packages', 'relay');
const NOW = new Date('2026-10-20T04:00:00.000Z');
const AT = '2026-10-20T04:00:00.000Z';
const ID = 'c0ffee00-1111-4222-8333-444455556666';

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { base: string; home: string; dropDir: string; socketPath: string } {
  const base = mkdtempSync(join(tmpdir(), 'b7relay-'));
  bases.push(base);
  return {
    base,
    home: join(base, 'home'),
    dropDir: join(base, 'root', '.agents', 'send-drops', 'acme', 'lead'),
    socketPath: join(base, 'machine.sock'),
  };
}

function payload(over: Partial<RecordPayload> = {}): RecordPayload {
  return {
    kind: 'message',
    id: ID,
    to: 'lead',
    to_id: 'agent-lead',
    root: '/scratch/root',
    session: 'acme',
    at: AT,
    body: 'from the orchestrator — admitted by: an orchestrator or operator\n\nhello',
    from: 'orchestrator',
    from_id: 'agent-orchestrator',
    rule: 'an orchestrator or operator to a seat of its own team',
    thread: ID,
    ...over,
  };
}

/** The exact bytes send.ts hands the relay: TeamCLI's signed record, pretty-printed, one text. */
function recordText(home: string, over: Partial<RecordPayload> = {}): { text: string; signed: ReturnType<typeof signRecord> } {
  const signed = signRecord(payload(over), home);
  return { text: `${JSON.stringify(signed, null, 2)}\n`, signed };
}

function message(home: string, over: Partial<RecordPayload> = {}): RelayMessage {
  const { text } = recordText(home, over);
  return { id: ID, record: text };
}

function options(extra: { dial?: Dial; timeoutMs?: number } = {}) {
  return { now: () => NOW, ...extra };
}

function holderFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

describe('the package boundary is transport-only', () => {
  test('every module imports a Node builtin and nothing else', () => {
    const modules = ['index.js', 'host/server.js', 'host/queue.js'].map((one) => join(PACKAGE, one));
    const seen: Array<{ file: string; specifier: string }> = [];
    for (const file of modules) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
        seen.push({ file: file.slice(PACKAGE.length + 1), specifier: match[1]! });
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((one) => !one.specifier.startsWith('node:'))).toEqual([]);
  });

  test('the manifest is private, dependency-free, and publishes exactly the files its exports name', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as {
      private?: boolean;
      type?: string;
      dependencies?: unknown;
      devDependencies?: unknown;
      peerDependencies?: unknown;
      exports?: Record<string, { default?: string }>;
      files?: string[];
    };
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    const exported = Object.values(manifest.exports ?? {}).map((one) => one.default ?? '');
    expect(exported.sort()).toEqual(['./host/queue.js', './host/server.js', './index.js']);
    for (const target of exported) {
      expect(existsSync(join(PACKAGE, target))).toBe(true);
      expect(manifest.files).toContain(target.slice(2));
      // The declarations sit beside every runtime file the exports name.
      expect(existsSync(join(PACKAGE, target.replace(/\.js$/, '.d.ts')))).toBe(true);
    }
  });

  test('the public surface names transport verbs, never admission, signing, policy or history', () => {
    const source = readFileSync(join(PACKAGE, 'index.js'), 'utf8');
    const exported = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((one) => one[1]!).sort();
    expect(exported).toEqual(['capabilities', 'deliver', 'dial', 'stage']);
    for (const name of exported) {
      expect(name).not.toMatch(/admit|policy|sign|histor|verif/i);
    }
  });

  test('the record is opaque text: arbitrary bytes are stored exactly, never parsed or signed', async () => {
    const { dropDir } = scratch();
    const text = 'not a signed JSON record at all\n';
    const staged = await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    expect(staged.outcome).toBe('stored');
    if (staged.outcome !== 'stored') return;
    expect(readFileSync(staged.receipt.copy!, 'utf8')).toBe(text);
    // The package created only the record: no history, bus or receipt file appeared beside it.
    expect(holderFiles(dropDir)).toEqual([ID]);
  });
});

describe('the durable copy is create-or-match on TeamCLI’s bytes', () => {
  test('a signed record is stored whole, 0600 in a 0700 folder, and reads back under its own key', async () => {
    const { home, dropDir } = scratch();
    const { text, signed } = recordText(home);
    const staged = await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    expect(staged).toEqual({ outcome: 'stored', receipt: { copy: join(dropDir, ID), at: AT } });
    const path = join(dropDir, ID);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dropDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(verifyRecord(JSON.parse(readFileSync(path, 'utf8')) as typeof signed, messageKeyOf(home))).toBe(true);
  });

  test('the same bytes again are existing: the inode, mtime and folder are untouched', async () => {
    const { home, dropDir } = scratch();
    const text = recordText(home).text;
    await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    const before = statSync(join(dropDir, ID));
    const again = await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    const after = statSync(join(dropDir, ID));
    expect(again).toEqual({ outcome: 'stored', receipt: { copy: join(dropDir, ID), existing: true, at: AT } });
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
    expect(holderFiles(dropDir)).toEqual([ID]);
  });

  test('a different record under the same id is refused, and the first copy stands byte for byte', async () => {
    const { home, dropDir } = scratch();
    const first = recordText(home).text;
    const second = recordText(home, { body: 'from the orchestrator — admitted by: an orchestrator or operator\n\nother' }).text;
    await stage({ dir: dropDir, name: ID }, { id: ID, record: first }, options());
    const refused = await stage({ dir: dropDir, name: ID }, { id: ID, record: second }, options());
    expect(refused).toEqual({
      outcome: 'refused',
      reason: 'a different record already holds that id',
      receipt: { copy: join(dropDir, ID), at: AT },
    });
    expect(readFileSync(join(dropDir, ID), 'utf8')).toBe(first);
  });

  test('TeamCLI keeps the identity decision: a held identical record is still its ensureRecord conclusion', async () => {
    const { home, dropDir } = scratch();
    const { text, signed } = recordText(home);
    await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    // The relay only knows bytes; TeamCLI still reads the signed record and decides it is this
    // message's. The relay's `existing` is not an admission.
    const held = ensureRecord(dropDir, signed);
    expect(held).toEqual({ ok: true, path: join(dropDir, ID), existing: true });
    expect(verifyRecord(signed, messageKeyOf(home))).toBe(true);
  });
});

describe('one stage, then exactly one route attempt', () => {
  test('a socket attempt is made only after the copy is on disk, and it is never retried or rerouted', async () => {
    const { home, dropDir, socketPath } = scratch();
    const text = recordText(home).text;
    const frame = `${JSON.stringify({ kind: 'relay', id: ID, record: JSON.parse(text) })}\n`;
    await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());

    const calls: Array<{ socket: string; frame: string; timeout: number | undefined; held: boolean }> = [];
    const dialSeam: Dial = async (socket, sent, timeout) => {
      calls.push({ socket, frame: sent, timeout, held: readFileSync(join(dropDir, ID), 'utf8') === text });
      return { ok: true };
    };
    const attempt = await deliver(
      { route: 'socket', socket: socketPath, runtime: 'claude-code', copy: { dir: dropDir, name: ID } },
      { id: ID, record: text, frame },
      options({ dial: dialSeam }),
    );
    expect(calls).toEqual([{ socket: socketPath, frame, timeout: SEND_TIMEOUT_MS, held: true }]);
    expect(attempt).toEqual({
      route: 'socket',
      outcome: 'delivered',
      receipt: { copy: join(dropDir, ID), bytes: frame.length, at: AT },
    });
  });

  test('a refused dial ends the attempt: the reason is kept, nothing is staged by deliver, nothing else is tried', async () => {
    const { home, dropDir, socketPath } = scratch();
    const text = recordText(home).text;
    let calls = 0;
    const attempt = await deliver(
      { route: 'socket', socket: socketPath, runtime: 'claude-code', copy: { dir: dropDir, name: ID } },
      { id: ID, record: text, frame: '{"a":1}\n' },
      options({ dial: async () => { calls += 1; return { ok: false, reason: 'nothing is listening there (the socket is gone)' }; } }),
    );
    expect(calls).toBe(1);
    expect(attempt).toEqual({
      route: 'socket',
      outcome: 'refused',
      reason: 'nothing is listening there (the socket is gone)',
      receipt: { copy: join(dropDir, ID), at: AT },
    });
    expect(holderFiles(dropDir)).toEqual([]);
  });

  test('the durable-copy route stages and answers held; a second identical delivery is existing', async () => {
    const { home, dropDir } = scratch();
    const text = recordText(home).text;
    const held = await deliver({ route: 'durable-copy', copy: { dir: dropDir, name: ID } }, { id: ID, record: text }, options());
    expect(held).toEqual({
      route: 'durable-copy',
      outcome: 'held',
      reason: 'the durable copy is stored; no live route delivered it',
      receipt: { copy: join(dropDir, ID), at: AT },
    });
    const again = await deliver({ route: 'durable-copy', copy: { dir: dropDir, name: ID } }, { id: ID, record: text }, options());
    expect(again).toEqual({
      route: 'durable-copy',
      outcome: 'held',
      reason: 'the durable copy is stored; no live route delivered it',
      receipt: { copy: join(dropDir, ID), existing: true, at: AT },
    });
  });

  test('the socket frame limit is the measured boundary: exactly the limit dials, one past never does', async () => {
    const { home, dropDir, socketPath } = scratch();
    const text = recordText(home).text;
    const atLimit = 'x'.repeat(FRAME_LIMIT - 1) + '\n';
    const overLimit = 'x'.repeat(FRAME_LIMIT) + '\n';
    expect(atLimit.length).toBe(FRAME_LIMIT);
    expect(overLimit.length).toBe(FRAME_LIMIT + 1);
    let dialed = 0;
    const seam: Dial = async () => { dialed += 1; return { ok: true }; };
    const accepted = await deliver(
      { route: 'socket', socket: socketPath, runtime: 'claude-code', copy: { dir: dropDir, name: ID } },
      { id: ID, record: text, frame: atLimit },
      options({ dial: seam }),
    );
    const refused = await deliver(
      { route: 'socket', socket: socketPath, runtime: 'claude-code', copy: { dir: dropDir, name: ID } },
      { id: ID, record: text, frame: overLimit },
      options({ dial: seam }),
    );
    expect(accepted.outcome).toBe('delivered');
    expect(refused).toEqual({
      route: 'socket',
      outcome: 'refused',
      reason: `the frame is ${String(FRAME_LIMIT + 1)} characters, past the socket's measured limit of ${String(FRAME_LIMIT)}`,
      receipt: { copy: join(dropDir, ID), at: AT },
    });
    expect(dialed).toBe(1);
  });

  test('capabilities keeps the one socket runtime, both routes, and no acknowledgement', () => {
    expect(capabilities('claude-code')).toEqual({
      routes: ['socket', 'durable-copy'],
      socket: { runtime: 'claude-code', supported: true, frameLimit: FRAME_LIMIT, timeoutMs: SEND_TIMEOUT_MS, ack: false },
      durableCopy: { supported: true },
    });
    expect(capabilities('codex').socket.supported).toBe(false);
    expect(capabilities('codex').routes).toEqual(['socket', 'durable-copy']);
  });
});

/** One request line, and whatever the host answers before the connection ends. */
function roundTrip(socketPath: string, line: string): Promise<string> {
  return new Promise((done, fail) => {
    const socket = createConnection({ path: socketPath });
    let answer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error('the host did not answer'));
    }, 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk) => { answer += chunk; });
    socket.on('end', () => { clearTimeout(timer); done(answer); });
    socket.on('error', (error) => { clearTimeout(timer); fail(error); });
  });
}

describe('the framing host owns no path and adds no protocol of its own', () => {
  test('nothing exists before listen, and the answer is the caller’s exact text', async () => {
    const { socketPath } = scratch();
    const seen: Array<{ input: unknown; line: string }> = [];
    const server = createHostServer({
      socketPath,
      onRequest: (input, line) => { seen.push({ input, line }); return '{"answer":"yes"}\n'; },
      onRefused: (reason) => JSON.stringify({ refused: reason }) + '\n',
    });
    expect(existsSync(socketPath)).toBe(false);
    expect(await server.listen()).toEqual({ ok: true });
    expect(await roundTrip(socketPath, '{"ask":"who"}\n')).toBe('{"answer":"yes"}\n');
    expect(seen).toEqual([{ input: { ask: 'who' }, line: '{"ask":"who"}' }]);
    await server.close();
  });

  test('a path already held by another file is reported, and its holder is left exactly as it was', async () => {
    const { socketPath } = scratch();
    writeFileSync(socketPath, 'not a socket');
    const server = createHostServer({
      socketPath,
      onRequest: () => '{"answer":"yes"}\n',
      onRefused: (reason) => JSON.stringify({ refused: reason }) + '\n',
    });
    const listened = await server.listen();
    expect(listened.ok).toBe(false);
    expect(listened.ok ? null : listened.code).toBe('EADDRINUSE');
    // The host never unlinks or repairs a path it did not create.
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket');
    await server.close();
    expect(readFileSync(socketPath, 'utf8')).toBe('not a socket');
  });

  test('a line past the measured frame limit is refused by the framing, before any handler', async () => {
    const { socketPath } = scratch();
    let handled = 0;
    const server = createHostServer({
      socketPath,
      onRequest: () => { handled += 1; return '{"answer":"yes"}\n'; },
      onRefused: (reason) => JSON.stringify({ refused: reason }) + '\n',
    });
    expect(await server.listen()).toEqual({ ok: true });
    // One character past the host limit, newline included: refused as a frame, never parsed.
    const over = `${'x'.repeat(HOST_FRAME_LIMIT)}\n`;
    expect(await roundTrip(socketPath, over)).toBe('{"refused":"frame-limit"}\n');
    expect(handled).toBe(0);
    await server.close();
  });
});

describe('the durable copy is one file with no side channel', () => {
  test('the copy digest TeamCLI reads is the digest of the bytes it signed', async () => {
    const { home, dropDir } = scratch();
    const text = recordText(home).text;
    await stage({ dir: dropDir, name: ID }, { id: ID, record: text }, options());
    const stored = readFileSync(join(dropDir, ID));
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
    expect(readFileSync(join(dropDir, ID), 'utf8')).toBe(text);
    // A staged record is exactly the file a receiver lists: one name, nothing hidden beside it.
    expect(holderFiles(dropDir)).toEqual([ID]);
  });
});
