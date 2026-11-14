// A seat whose brief claim already names a launch, or whose claim holds no launch epoch, still
// gets its inbox server. Synthetic team, home and pane only.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { signRecord } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const EPOCH = 'run_0123456789ab';
const OTHER = 'run_ba9876543210';
const MESSAGE = '6b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4e';

function place(): { root: string; home: string; file: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-epoch-serve-')));
  const home = join(root, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: test
    model: Grok
    version: "4.7"
    launch: codex
`);
  writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' } }, worktrees: {} } },
  })}\n`);
  return { root, home, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function claim(root: string, brief: Record<string, unknown> | null): void {
  const path = join(root, '.agents', 'team.state.json');
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, { briefs?: Record<string, unknown> }>;
  };
  const session = state.sessions[SESSION]!;
  if (brief === null) delete session.briefs;
  else session.briefs = { lead: brief };
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

async function listed(root: string, home: string, file: string, epoch?: string): Promise<{ code: number; err: string; tools: string[]; listenerEpoch: string | undefined }> {
  let listenerEpoch: string | undefined;
  const replies: string[] = [];
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const bump = (): void => {
    const resume = wake;
    wake = null;
    if (resume !== null) resume();
  };
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  const push = (line: string): void => {
    pending.push(line);
    bump();
  };
  const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION });
  const running = runMcpServe(
    { seat: 'lead', session: SESSION, file, ...(epoch === undefined ? {} : { epoch }) },
    io,
    { lines, write: (line) => replies.push(line) },
    { home },
  );
  for (let wait = 0; wait < 200 && !existsSync(listenerPath(join(root, '.agents', 'send-drops', SESSION, 'lead'))); wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const marker = listenerPath(join(root, '.agents', 'send-drops', SESSION, 'lead'));
  if (existsSync(marker)) {
    listenerEpoch = (JSON.parse(readFileSync(marker, 'utf8')) as { epoch?: string }).epoch;
  }
  push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  for (let wait = 0; wait < 400 && replies.length < 1; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  ended = true;
  bump();
  const code = await running;
  const tools = replies.length === 0
    ? []
    : ((JSON.parse(replies[0]!) as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((tool) => tool.name);
  return { code, err: io.err, tools, listenerEpoch };
}

test('a current claim with no --epoch still serves inbox_check and inbox_read under that epoch', async () => {
  const at = place();
  try {
    claim(at.root, {
      id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      at: '2026-11-06T16:10:00.000Z',
      incarnation: 'inc_0123456789ab',
      epoch: EPOCH,
      sha256: 'a'.repeat(64),
      stage: 'claimed',
    });
    const served = await listed(at.root, at.home, at.file);
    expect(served.code, served.err).toBe(0);
    expect(served.tools).toEqual(['inbox_check', 'inbox_read']);
    expect(served.listenerEpoch).toBe(EPOCH);
    expect(served.err).toBe('');
  } finally {
    at.cleanup();
  }
});

test('a claim with no launch epoch still serves the inbox, leftover epoch included', async () => {
  const at = place();
  try {
    claim(at.root, { id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', at: '2026-11-06T16:10:00.000Z' });
    const served = await listed(at.root, at.home, at.file, OTHER);
    expect(served.code, served.err).toBe(0);
    expect(served.tools).toEqual(['inbox_check', 'inbox_read']);
    expect(served.err).toBe('');
  } finally {
    at.cleanup();
  }
});

test('the adopted server still reads one message', async () => {
  const at = place();
  try {
    claim(at.root, {
      id: '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      at: '2026-11-06T16:10:00.000Z',
      incarnation: 'inc_0123456789ab',
      epoch: EPOCH,
      sha256: 'a'.repeat(64),
      stage: 'claimed',
    });
    const dropDir = join(at.root, '.agents', 'send-drops', SESSION, 'lead');
    mkdirSync(dropDir, { recursive: true });
    const record = signRecord({
      kind: 'message',
      id: MESSAGE,
      to: 'lead',
      to_id: null,
      root: at.root,
      session: SESSION,
      at: '2026-11-06T16:10:00.000Z',
      body: 'the body the seat has not read',
      from: 'worker',
      from_id: null,
      rule: 'the owner',
      thread: MESSAGE,
    }, at.home);
    writeFileSync(join(dropDir, MESSAGE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const replies: string[] = [];
    const io = testIo(at.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION });
    const code = await runMcpServe({ seat: 'lead', session: SESSION, file: at.file }, io, {
      lines: (async function* () {
        yield JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'inbox_read', arguments: { id: MESSAGE } } });
      })(),
      write: (line) => replies.push(line),
    }, { home: at.home });
    expect(code, io.err).toBe(0);
    const reply = JSON.parse(replies[0] ?? '{}') as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(reply.result?.isError).not.toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain('the body the seat has not read');
  } finally {
    at.cleanup();
  }
});

const BASE = Date.parse('2026-11-14T15:43:03.000Z');
const SEAT = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION } as const;
function claimAt(epoch: string, atMs: number, id = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'): Record<string, unknown> {
  return { id, at: new Date(atMs).toISOString(), incarnation: 'inc_0123456789ab', epoch, sha256: 'a'.repeat(64), stage: 'claimed' };
}
/** A client the scene drives: `push` a line, `end` closes the input. */
function client(): { lines: AsyncIterable<string>; push(line: string): void; end(): void } {
  const waiting: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const bump = (): void => { const resume = wake; wake = null; resume?.(); };
  return {
    lines: (async function* () {
      for (;;) {
        if (waiting.length > 0) { yield waiting.shift()!; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })(),
    push: (line) => { waiting.push(line); bump(); },
    end: () => { ended = true; bump(); },
  };
}
const CHECK = (id: number): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'inbox_check' } });
async function until(ok: () => boolean): Promise<void> {
  for (let wait = 0; wait < 600 && !ok(); wait++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test('a registration that pins an earlier launch epoch still serves the claim written before this server started', async () => {
  const at = place();
  try {
    // The 2026-11-14 case: the project file kept run_97d9..., the restart claimed run_df28...
    claim(at.root, claimAt(EPOCH, BASE - 2_000));
    const peer = client();
    const io = testIo(at.root, SEAT);
    const replies: string[] = [];
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: at.file, epoch: OTHER }, io,
      { lines: peer.lines, write: (line) => replies.push(line) }, { home: at.home }, { startedAtMs: BASE });
    const marker = listenerPath(join(at.root, '.agents', 'send-drops', SESSION, 'lead'));
    await until(() => existsSync(marker));
    expect(existsSync(marker), io.err).toBe(true);
    expect((JSON.parse(readFileSync(marker, 'utf8')) as { epoch?: string }).epoch).toBe(EPOCH);
    peer.push(CHECK(1));
    await until(() => replies.length > 0);
    expect((JSON.parse(replies[0]!) as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    peer.end();
    expect(await running).toBe(0);
  } finally {
    at.cleanup();
  }
});

test('a server started before its launch claim waits, refusing calls, and serves once the claim and its registration agree, without a restart', async () => {
  const at = place();
  try {
    const peer = client();
    const io = testIo(at.root, SEAT);
    io.env = { HERDR_PANE_ID: 'pane-lead' };
    const replies: string[] = [];
    let polls = 0;
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: at.file, epoch: EPOCH }, io,
      { lines: peer.lines, write: (line) => replies.push(line) }, { home: at.home }, {
        startedAtMs: BASE,
        now: () => polls * 250,
        sleep: async () => {
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          // The launch writes its claim well after the server started: the epoch names it.
          if (polls === 40) claim(at.root, claimAt(EPOCH, BASE + 60_000));
        },
      });
    peer.push(CHECK(1));
    await until(() => replies.length > 0);
    const early = JSON.parse(replies[0]!) as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(early.result?.isError).toBe(true);
    expect(early.result?.content?.[0]?.text).toContain('no longer holds');
    const marker = listenerPath(join(at.root, '.agents', 'send-drops', SESSION, 'lead'));
    await until(() => existsSync(marker));
    expect(existsSync(marker), io.err).toBe(true);
    peer.push(CHECK(2));
    await until(() => replies.length > 1);
    expect((JSON.parse(replies[1]!) as { result?: { isError?: boolean } }).result?.isError).not.toBe(true);
    peer.end();
    expect(await running).toBe(0);
  } finally {
    at.cleanup();
  }
});

test('a state being rewritten at the start is waited for, not a reason to exit', async () => {
  const at = place();
  try {
    const statePath = join(at.root, '.agents', 'team.state.json');
    const good = readFileSync(statePath, 'utf8');
    writeFileSync(statePath, '{"format": 1, "sessions": ');
    const peer = client();
    const io = testIo(at.root, SEAT);
    io.env = { HERDR_PANE_ID: 'pane-lead' };
    let polls = 0;
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: at.file }, io,
      { lines: peer.lines, write: () => {} }, { home: at.home }, {
        startedAtMs: BASE,
        now: () => polls * 250,
        sleep: async () => {
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (polls === 10) writeFileSync(statePath, good);
        },
      });
    const marker = listenerPath(join(at.root, '.agents', 'send-drops', SESSION, 'lead'));
    await until(() => existsSync(marker));
    expect(existsSync(marker), io.err).toBe(true);
    peer.end();
    expect(await running).toBe(0);
  } finally {
    at.cleanup();
  }
});

test('a claim written after this server started is a later launch: never adopted, and a gone client ends the wait', async () => {
  const at = place();
  try {
    claim(at.root, claimAt(EPOCH, BASE - 2_000));
    const peer = client();
    // Unplaced in its own pane while the seat is relaunched under a newer claim.
    const io = testIo(at.root, { kind: 'unplaced', reason: 'it runs in pane pane-lead, whose agent has no herdr name' });
    io.env = { HERDR_PANE_ID: 'pane-lead' };
    const replies: string[] = [];
    let polls = 0;
    const running = runMcpServe({ seat: 'lead', session: SESSION, file: at.file }, io,
      { lines: peer.lines, write: (line) => replies.push(line) }, { home: at.home }, {
        startedAtMs: BASE,
        now: () => polls * 250,
        sleep: async () => {
          polls += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (polls === 30) {
            claim(at.root, claimAt(OTHER, BASE + 7_500, '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4f'));
            io.caller = SEAT;
          }
          if (polls === 60) peer.end();
        },
      });
    peer.push(CHECK(1));
    expect(await running).toBe(2);
    expect(io.err).toContain('written after this server started');
    const reply = JSON.parse(replies[0] ?? '{}') as { result?: { isError?: boolean } };
    expect(reply.result?.isError).toBe(true);
    expect(existsSync(listenerPath(join(at.root, '.agents', 'send-drops', SESSION, 'lead')))).toBe(false);
  } finally {
    at.cleanup();
  }
});

test('a foreign seat is refused at once, and the refusal closes the input so the process ends', async () => {
  const at = place();
  try {
    let closed = false;
    const io = testIo(at.root, SEAT);
    const code = await runMcpServe({ seat: 'nobody', session: SESSION, file: at.file }, io, {
      lines: (async function* () { /* nothing */ })(),
      write: () => {},
      close: () => { closed = true; },
    }, { home: at.home });
    expect(code).toBe(2);
    expect(io.err).toContain('declares no seat');
    expect(closed).toBe(true);
  } finally {
    at.cleanup();
  }
});
