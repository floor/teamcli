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
