// `team mcp serve`: the seat's inbox as a stdio MCP server, driven over its own streams and
// synthetic folders. No herdr, no live team: a temporary folder holds a team file and the drop
// tree the server reads. Every message id here is a literal UUID; the bodies are invented.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMcp } from '../src/commands/mcp.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const LEAD_ID = '0b7c4f4e-3c4a-4f6e-9a2b-5d1c7e8f9a01';
const WORKER_ID = '1c8d5a5f-4d5b-4a7f-8b3c-6e2d8f9a0b12';

function teamText(seats: readonly string[]): string {
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
session: ${SESSION}
workspace:
  mode: shared
seats:
${rows}
`;
}

type Place = { root: string; dropDir(name: string): string; cleanup(): void };

function place(seats: readonly string[] = ['lead', 'worker']): Place {
  const root = mkdtempSync(join(tmpdir(), 'team-inbox-'));
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(seats));
  return {
    root,
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

async function preloaded(root: string, lines: readonly string[], seat = 'lead', session: string | undefined = SESSION) {
  const io = testIo(root);
  const replies: string[] = [];
  const code = await runMcpServe({ seat, session }, io, {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    write: (line) => replies.push(line),
  });
  return { code, io, replies: replies.map((line) => JSON.parse(line) as Record<string, any>) };
}

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

describe('team mcp serve', () => {
  test('the handshake names the tools, and stdin closing removes the marker', async () => {
    const at = place();
    try {
      const { code, io, replies } = await preloaded(at.root, [
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
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed);
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
      const { code, io } = await preloaded(at.root, []);
      expect(code).toBe(2);
      expect(io.err).toContain('not a real folder');
      expect(readdirSync(elsewhere)).toEqual([]);
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
        });
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
      drop(at.dropDir('lead'), LEAD_ID, 'for lead');
      drop(at.dropDir('worker'), WORKER_ID, 'for worker');
      const { replies } = await preloaded(at.root, [call('1', 'inbox_check'), call('2', 'inbox_read', { id: WORKER_ID })]);
      expect(replies).toHaveLength(2);
      const listed = JSON.parse(replies[0]!.result.content[0].text) as { unread: { id: string; bytes: number }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([LEAD_ID]);
      expect(listed.unread[0]!.bytes).toBe(Buffer.byteLength('for lead'));
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
      drop(at.dropDir('lead'), LEAD_ID, 'the body');
      const { replies } = await preloaded(at.root, [call('1', 'inbox_read', { id: LEAD_ID }), call('2', 'inbox_check')]);
      expect(replies[0]!.result).toEqual({ content: [{ type: 'text', text: 'the body' }] });
      const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir('lead'), LEAD_ID), 'utf8')) as Record<string, unknown>;
      expect(receipt).toMatchObject({ v: 1, id: LEAD_ID, seat: 'lead', session: SESSION, tool: 'inbox_read', pid: process.pid });
      const listed = JSON.parse(replies[1]!.result.content[0].text) as { unread: unknown[] };
      expect(listed.unread).toEqual([]);
      // The message itself is untouched: the inbox marks, it never moves the file.
      expect(readFileSync(join(at.dropDir('lead'), LEAD_ID), 'utf8')).toBe('the body');
    } finally {
      at.cleanup();
    }
  });

  test('an id is a UUID and never a path, and a symlinked drop is not served', async () => {
    const at = place();
    try {
      drop(at.dropDir('lead'), LEAD_ID, 'real');
      const outside = join(at.root, 'outside');
      writeFileSync(outside, 'target', { mode: 0o600 });
      symlinkSync(outside, join(at.dropDir('lead'), WORKER_ID));
      const outsideReceipt = join(at.root, 'outside.read');
      symlinkSync(outsideReceipt, receiptPath(at.dropDir('lead'), LEAD_ID + ''));
      const { replies } = await preloaded(at.root, [
        call('1', 'inbox_read', { id: `../../worker/${WORKER_ID}` }),
        call('2', 'inbox_read', { id: LEAD_ID }),
        call('3', 'inbox_check'),
      ]);
      expect(replies[0]!.result.isError).toBe(true);
      expect(replies[1]!.result.isError).toBe(true);
      expect(replies[1]!.result.content[0].text).toContain('not a file');
      const listed = JSON.parse(replies[2]!.result.content[0].text) as { unread: { id: string }[] };
      expect(listed.unread.map((one) => one.id)).toEqual([]);
      expect(existsSync(outsideReceipt)).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('tool faults are results, parse errors and unknown methods are protocol errors', async () => {
    const at = place();
    try {
      const { replies } = await preloaded(at.root, [
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
