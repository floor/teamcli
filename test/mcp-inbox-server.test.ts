// `team mcp serve`: the seat's inbox as a stdio MCP server, driven over its own streams and
// synthetic folders. No herdr, no live team: a temporary folder holds a team file and the drop
// tree the server reads. Every message id here is a literal UUID; the bodies are invented.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../src/bus/log.ts';
import { runMcp } from '../src/commands/mcp.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { signRecord, verifyReceipt, type SignedReceipt } from '../src/send/record.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { recordBody, testIo } from './helpers.ts';

const SESSION = 'acme';
const LEAD_ID = '0b7c4f4e-3c4a-4f6e-9a2b-5d1c7e8f9a01';
const WORKER_ID = '1c8d5a5f-4d5b-4a7f-8b3c-6e2d8f9a0b12';
const TAMPERED_ID = '2d9e6b60-5e6c-4b80-9c4d-7f3e9a0b1c23';
const UNSIGNED_ID = '3eaf7c71-6f7d-4c91-8d5e-8a4fab1c2d34';
const LEGACY_ID = '4fb08d82-708e-4da2-9e6f-9b5ca01d3e45';

function teamText(seats: readonly string[], session = SESSION): string {
  const rows = seats.map((name, at) => `  - role: ${at === 0 ? 'coordinator' : 'worker'}
    name: ${name}
    cli: ${at === 0 ? 'claude-code' : 'codex'}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${at === 0 ? 'claude' : 'codex'}`).join('\n');
  return `format: 1
project: acme
coordinator: ${seats[0] ?? 'lead'}
operator: ${seats[0] ?? 'lead'}
session: ${session}
workspace:
  mode: shared
seats:
${rows}
`;
}

type Place = { root: string; home: string; dropDir(name: string): string; cleanup(): void };

function place(seats: readonly string[] = ['lead', 'worker']): Place {
  // The refusal event names the record's real path, and a temporary directory is a symlink
  // under /var on macOS: the fixture's root is resolved once, so both sides name the same file.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-')));
  mkdirSync(join(root, '.agents'));
  // The message key lives under this home, never the one of the machine running the suite.
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(seats));
  return {
    root,
    home: join(root, 'home'),
    dropDir: (name) => join(root, '.agents', 'send-drops', SESSION, name),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function drop(at: string, id: string, body: string): string {
  mkdirSync(at, { recursive: true, mode: 0o700 });
  const path = join(at, id);
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

/** The record a send writes: one signed envelope under the id's own name, in `to`'s folder. */
function signed(at: Place, to: string, id: string, body: string): string {
  const record = signRecord({
    kind: 'message',
    id,
    to,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-17T12:00:00.000Z',
    body,
    from: 'worker',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  return drop(at.dropDir(to), id, `${JSON.stringify(record, null, 2)}\n`);
}

/** The signed read receipt a read wrote, checked with the checkout's own message key: the one
 *  file shape every reader of a status agrees on. */
function readReceipt(at: Place, seat: string, id: string): SignedReceipt {
  const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir(seat), id), 'utf8')) as SignedReceipt;
  const key = messageKeyState(at.home);
  expect(key.kind).toBe('key');
  if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
  expect(verifyReceipt(receipt, key.key)).toBe(true);
  return receipt;
}

/** A stream the test feeds: `push` one line, `end` closes it, `replies` collects what was written. */
function queue(): {
  lines: AsyncIterable<string>;
  write(line: string): void;
  push(line: string): void;
  end(): void;
  replies: string[];
} {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    lines,
    write: (line) => replies.push(line),
    push: (line) => {
      pending.push(line);
      bump();
    },
    end: () => {
      ended = true;
      bump();
    },
    replies,
  };
}

async function preloaded(root: string, home: string, lines: readonly string[], seat = 'lead', session: string | undefined = SESSION) {
  const io = testIo(root);
  const replies: string[] = [];
  const code = await runMcpServe({ seat, session }, io, {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    write: (line) => replies.push(line),
  }, { home });
  return { code, io, replies: replies.map((line) => JSON.parse(line) as Record<string, any>) };
}

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

describe('team mcp serve', () => {
  test('the handshake names the tools, and stdin closing removes the marker', async () => {
    const at = place();
    try {
      const { code, io, replies } = await preloaded(at.root, at.home, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      expect(code).toBe(0);
      expect(io.out).toBe('');
      expect(io.err).toBe('');
      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'team-inbox' } },
      });
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read']);
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('the listener names the seat, session, root and pid while the server runs', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      for (let wait = 0; wait < 200 && !existsSync(listenerPath(at.dropDir('lead'))); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const listener = JSON.parse(readFileSync(listenerPath(at.dropDir('lead')), 'utf8')) as Record<string, unknown>;
      expect(listener).toMatchObject({ v: 1, seat: 'lead', session: SESSION, root: realpathSync(at.root), cli: 'claude-code', pid: process.pid });
      expect((listener.ts as string).length).toBeGreaterThan(10);
      feed.end();
      expect(await running).toBe(0);
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a link anywhere in the folder path refuses to start', async () => {
    const at = place();
    try {
      const elsewhere = join(at.root, 'elsewhere');
      mkdirSync(elsewhere);
      symlinkSync(elsewhere, join(at.root, '.agents', 'send-drops'));
      const { code, io } = await preloaded(at.root, at.home, []);
      expect(code).toBe(2);
      expect(io.err).toContain('not a real folder');
      expect(readdirSync(elsewhere)).toEqual([]);
    } finally {
      at.cleanup();
    }
  });

  test('a lobby folder with the launch file serves that team, whatever folder it starts in', async () => {
    const at = place();
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(lobby);
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('a lobby folder with no team file and no launch file refuses', async () => {
    const at = place();
    const lobby = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-lobby-')));
    try {
      const io = testIo(lobby);
      const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
        lines: (async function* () {
          // no lines
        })(),
        write: () => {},
      }, { home: at.home });
      expect(code).toBe(2);
      expect(io.err).toContain('pass --file');
    } finally {
      at.cleanup();
      rmSync(lobby, { recursive: true, force: true });
    }
  });

  test('an explicit team file that cannot be read refuses, even where the folder has one', async () => {
    const at = place();
    try {
      const io = testIo(at.root);
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, 'missing.yaml') }, io, {
        lines: (async function* () {
          // no lines
        })(),
        write: () => {},
      }, { home: at.home });
      expect(code).toBe(2);
      expect(io.err).toContain('missing.yaml');
    } finally {
      at.cleanup();
    }
  });

  test('an explicit launch file wins over a different team file in the folder', async () => {
    const at = place();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'team-inbox-other-')));
    try {
      mkdirSync(join(elsewhere, '.agents'));
      writeFileSync(join(elsewhere, '.agents', 'team.yaml'), teamText(['lead', 'worker'], 'other'));
      signed(at, 'lead', LEAD_ID, 'for lead');
      const io = testIo(elsewhere);
      const replies: string[] = [];
      const code = await runMcpServe({ seat: 'lead', session: SESSION, file: join(at.root, '.agents', 'team.yaml') }, io, {
        lines: (async function* () {
          yield call('1', 'inbox_check');
        })(),
        write: (line) => replies.push(line),
      }, { home: at.home });
      expect(code).toBe(0);
      const reply = JSON.parse(replies[0]!) as Record<string, any>;
      const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
    } finally {
      at.cleanup();
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('an empty or directory explicit file refuses even where the folder has a team file', async () => {
    const at = place();
    try {
      for (const file of ['', at.root]) {
        const io = testIo(at.root);
        const code = await runMcpServe({ seat: 'lead', session: SESSION, file }, io, {
          lines: (async function* () {
            // no lines
          })(),
          write: () => {},
        }, { home: at.home });
        expect(code).toBe(2);
        expect(io.err).toContain('could not be read');
      }
    } finally {
      at.cleanup();
    }
  });

  test('an undeclared seat, a wrong session, or no seat at all refuses to start', async () => {
    const at = place();
    try {
      for (const [seat, session, needle] of [
        ['ghost', SESSION, 'declares no seat'],
        ['lead', 'other', "session is"],
        [undefined, SESSION, '--seat <seat> is required'],
      ] as const) {
        const io = testIo(at.root);
        const code = await runMcpServe({ seat, session }, io, {
          lines: (async function* () {
            // no lines
          })(),
          write: () => {},
        }, { home: at.home });
        expect(code).toBe(2);
        expect(io.err).toContain(needle);
      }
    } finally {
      at.cleanup();
    }
  });

  test('a seat sees its own inbox and never another seat’s', async () => {
    const at = place();
    try {
      const leadPath = signed(at, 'lead', LEAD_ID, 'for lead');
      signed(at, 'worker', WORKER_ID, 'for worker');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_check'), call('2', 'inbox_read', { id: WORKER_ID })]);
      expect(replies).toHaveLength(2);
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string; bytes: number }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(listed.unread[0]!.bytes).toBe(Buffer.byteLength(readFileSync(leadPath, 'utf8')));
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('no message');
      expect(existsSync(receiptPath(at.dropDir('worker'), WORKER_ID))).toBe(false);
      expect(existsSync(receiptPath(at.dropDir('lead'), WORKER_ID))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a read writes its receipt before the body leaves, and the message then leaves the list', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the body');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result).toEqual({ content: [{ type: 'text', text: 'the body' }] });
      const receipt = readReceipt(at, 'lead', LEAD_ID);
      expect(receipt.payload).toMatchObject({
        kind: 'receipt',
        status: 'read',
        id: LEAD_ID,
        to: 'lead',
        root: realpathSync(at.root),
        session: SESSION,
      });
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: unknown[] };
      expect(listed.unread).toEqual([]);
      // The record itself is untouched: the inbox marks, it never moves or rewrites the file.
      expect(recordBody(join(at.dropDir('lead'), LEAD_ID))).toBe('the body');
    } finally {
      at.cleanup();
    }
  });

  test('an id is a UUID and never a path, and a symlinked drop is not served', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'real');
      const outside = join(at.root, 'outside');
      writeFileSync(outside, 'target', { mode: 0o600 });
      symlinkSync(outside, join(at.dropDir('lead'), WORKER_ID));
      const outsideReceipt = join(at.root, 'outside.read');
      symlinkSync(outsideReceipt, receiptPath(at.dropDir('lead'), LEAD_ID + ''));
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_read', { id: `../../worker/${WORKER_ID}` }),
        call('2', 'inbox_read', { id: LEAD_ID }),
        call('3', 'inbox_check'),
      ]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('not a file');
      const listed = JSON.parse(replies[2]!.result.content[0].text) as { unread: { id: string }[] };
      // The link at the receipt's name was never signed by the message key, so it proves nothing:
      // the message is still waiting, and nothing was written through the link.
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(existsSync(outsideReceipt)).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('tool faults are results, parse errors and unknown methods are protocol errors', async () => {
    const at = place();
    try {
      const { replies } = await preloaded(at.root, at.home, [
        'not json',
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }),
        call('3', 'frobnicate'),
        call('4', 'inbox_read'),
      ]);
      expect(replies[0]).toMatchObject({ id: null, error: { code: -32700 } });
      expect(replies[1]).toMatchObject({ id: 2, error: { code: -32601 } });
      expect(replies[2]!.result.isError).toBe(true);
      expect(replies[3]!.result.isError).toBe(true);
    } finally {
      at.cleanup();
    }
  });

  test('the process itself speaks only JSON-RPC on stdout', async () => {
    const at = place();
    try {
      const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
      const proc = Bun.spawn([process.execPath, cliEntry, 'mcp', 'serve', '--seat', 'lead'], {
        cwd: at.root,
        // The child does not see the suite preload's setting unless it is passed on.
        env: { ...process.env, TEAM_CONFIG_SOURCE: 'file' },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      await proc.stdin.end();
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      const lines = stdout.trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(JSON.parse(lines[0]!) as Record<string, any>).toMatchObject({ id: 1, result: { serverInfo: { name: 'team-inbox' } } });
      expect(existsSync(listenerPath(at.dropDir('lead')))).toBe(false);
    } finally {
      at.cleanup();
    }
    // The same spawn exits in about 0.13 s from a plain script on this machine, and takes
    // about 4 s under the test runner: the scene asserts the process's output, not its speed.
  }, 20_000);
});

describe('an inbox read serves only a record it verified', () => {
  test('a signed record returns its body, and the receipt is written', async () => {
    const at = place();
    try {
      signed(at, 'lead', LEAD_ID, 'the draft is ready');
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID })]);
      expect(replies[0]!.result.isError).toBeUndefined();
      expect(replies[0]!.result.content[0].text).toBe('the draft is ready');
      const receipt = readReceipt(at, 'lead', LEAD_ID);
      expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: LEAD_ID, to: 'lead' });
    } finally {
      at.cleanup();
    }
  });

  test('a tampered record is refused with the reason, and no receipt is written', async () => {
    const at = place();
    try {
      const path = signed(at, 'lead', LEAD_ID, 'the body the sender wrote');
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { payload: { body: string }; signature: string };
      parsed.payload.body = 'the body a tamperer wants';
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: LEAD_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[0]!.result.content[0].text).toContain('does not verify');
      expect(replies[0]!.result.content[0].text).not.toContain('the body a tamperer wants');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      // Nothing was shown, so the message is still unread and the check still names it.
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);

      // The owner hears the refusal as its rule and object — the id, the seat and the path —
      // and never either body: neither the sender's nor the tamperer's.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'signature',
        seat: 'lead',
        subject: LEAD_ID,
        reason: join(at.dropDir('lead'), LEAD_ID),
      });
      const shown = JSON.stringify(refused[0]!.payload);
      expect(shown).not.toContain('the body the sender wrote');
      expect(shown).not.toContain('the body a tamperer wants');
    } finally {
      at.cleanup();
    }
  });

  test('an unsigned record is refused with the reason, and no receipt is written', async () => {
    const at = place();
    try {
      const path = signed(at, 'lead', UNSIGNED_ID, 'the body nobody signed');
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { payload: unknown; signature?: string };
      delete parsed.signature;
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [call('1', 'inbox_read', { id: UNSIGNED_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[0]!.result.content[0].text).toContain('not a signed record');
      expect(replies[0]!.result.content[0].text).not.toContain('the body nobody signed');
      expect(existsSync(receiptPath(at.dropDir('lead'), UNSIGNED_ID))).toBe(false);
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([UNSIGNED_ID]);

      // A file that is not a signed record is a shape refusal, and its body stays out.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'shape',
        seat: 'lead',
        subject: UNSIGNED_ID,
        reason: join(at.dropDir('lead'), UNSIGNED_ID),
      });
      expect(JSON.stringify(refused[0]!.payload)).not.toContain('the body nobody signed');
    } finally {
      at.cleanup();
    }
  });

  test('a plain-text drop an earlier build wrote is not listed, served or raised', async () => {
    const at = place();
    try {
      // A signed record beside it proves the check still lists real mail; the old drop is the
      // plain text an earlier build wrote, under a name this build's sends would use.
      signed(at, 'lead', LEAD_ID, 'for lead');
      const legacyBody = 'from harness (harness@acme) — old mail, not a record\n';
      const path = drop(at.dropDir('lead'), LEGACY_ID, legacyBody);
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_check'),
        call('2', 'inbox_read', { id: LEGACY_ID }),
      ]);
      // The check omits it: listing it every turn would only invite a refused read.
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      // A read of it still answers the tool error, and leaves no receipt and no body.
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('is not a signed record');
      expect(replies[1]!.result.content[0].text).not.toContain('old mail');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEGACY_ID))).toBe(false);
      // The file is left exactly where it is, byte for byte.
      expect(readFileSync(path, 'utf8')).toBe(legacyBody);
      // The owner hears no refusal: this is not a record anything could have admitted.
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.events.filter((event) => event.payload.kind === 'record.invalid')).toHaveLength(0);
    } finally {
      at.cleanup();
    }
  });

  test('a signed record broken into invalid JSON keeps its refusal and its owner event', async () => {
    const at = place();
    try {
      // A truncated record is not plain text an earlier build wrote: it starts as the record's
      // JSON object, so it keeps the strict shape refusal and the event that follows.
      const path = signed(at, 'lead', LEAD_ID, 'the body that was signed');
      writeFileSync(path, readFileSync(path, 'utf8').slice(0, 10), { mode: 0o600 });
      const { replies } = await preloaded(at.root, at.home, [
        call('1', 'inbox_check'),
        call('2', 'inbox_read', { id: LEAD_ID }),
      ]);
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('is not a signed record');
      expect(existsSync(receiptPath(at.dropDir('lead'), LEAD_ID))).toBe(false);
      const events = readEvents('acme', at.root, at.home);
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const refused = events.events.filter((event) => event.payload.kind === 'record.invalid');
      expect(refused).toHaveLength(1);
      expect(refused[0]!.payload).toMatchObject({
        session: SESSION,
        rule: 'shape',
        seat: 'lead',
        subject: LEAD_ID,
        reason: join(at.dropDir('lead'), LEAD_ID),
      });
    } finally {
      at.cleanup();
    }
  });
});

describe('team mcp invocation around serve', () => {
  test('serve needs --seat, takes no --json, and the two reports take no seat options', async () => {
    const at = place();
    try {
      const cases: [string[], string][] = [
        [['serve'], '--seat <seat> is required'],
        [['serve', '--seat', 'lead', '--json'], 'unknown option --json'],
        [['serve', '--seat', 'lead', 'extra'], 'unexpected "extra"'],
        [['status', '--seat', 'lead'], 'unknown option --seat'],
        [['doctor', '--session', SESSION], 'unknown option --session'],
      ];
      for (const [argv, needle] of cases) {
        const io = testIo(at.root);
        expect(await runMcp(argv, io)).toBe(2);
        // `--json` anywhere gives the structured error document, as it does for every mcp run.
        if (needle === 'unknown option --json') {
          expect(io.err).toBe('');
          expect(io.out).toContain('"id": "mcp.invocation"');
          expect(io.out).toContain('unknown option --json');
        } else {
          expect(io.err).toContain(needle);
        }
      }
      const usage = testIo(at.root);
      expect(await runMcp([], usage)).toBe(2);
      expect(usage.err).toContain('status, doctor or serve');
    } finally {
      at.cleanup();
    }
  });
});
