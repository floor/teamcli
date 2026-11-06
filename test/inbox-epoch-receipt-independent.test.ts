// A launch line that names no epoch still serves the seat's inbox. A process bound to
// another launch does not. `team drops --read` writes the receipt after the body is printed.
// Synthetic homes only.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { listUnread, listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe, type ServeOptions } from '../src/mcp/serve.ts';
import { emptySession, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const SESSION = 'morning';
const SEAT = 'reader';
const PANE = 'pane-reader';
const CURRENT = 'run_a11ce0000001';
const NEXT = 'run_a11ce0000002';
const FOREIGN = 'run_f0e196000001';
const CLAIM_ID = '36f8f09e-2eb5-4814-a905-e8a9dfc702e8';
const AT = '2026-11-06T17:20:00.000Z';
const BUILD = { version: '0.0.0-fixture', build: 'fixture', builtAt: 0, head: null };
const caller: Caller = { kind: 'seat', name: SEAT, pane: PANE, session: SESSION };

const bases: string[] = [];
afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function world(claim: 'current' | 'none'): { home: string; root: string; dir: string; file: string; drop: string } {
  const base = fixtureBase('inbox-epoch-receipt-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = join(base, 'oak');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, `format: 1
project: oak
coordinator: reader
operator: reader
session: morning
workspace:
  mode: shared
seats:
  - role: coordinator
    name: reader
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = { stage: 'ready', pane: PANE };
    if (claim === 'current') session.briefs = { [SEAT]: brief(CURRENT) };
  });
  return { home, root, dir, file, drop: recordDir(root, SESSION, SEAT) };
}

function brief(epoch: string) {
  return {
    id: CLAIM_ID,
    at: AT,
    incarnation: 'inc_111111111111',
    epoch,
    sha256: 'a'.repeat(64),
    stage: 'ready' as const,
    attempt: 0,
  };
}

function waiting(home: string, root: string): string[] {
  return listUnread(recordDir(root, SESSION, SEAT), { to: SEAT, root, session: SESSION }, home).map((message) => message.id);
}

function listTools(): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
}

function callTool(name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
}

function toolText(reply: { result?: { content?: { text?: string }[]; isError?: boolean } }): string {
  return reply.result?.content?.[0]?.text ?? '';
}

async function serve(
  home: string,
  root: string,
  options: ServeOptions,
  steps: Array<string | (() => void)>,
): Promise<{ code: number; err: string; replies: Array<{ result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] } }> }> {
  const io = testIo(root, caller);
  const replies: Array<{ result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] } }> = [];
  const code = await runMcpServe(options, io, {
    lines: (async function* () {
      for (const step of steps) {
        if (typeof step === 'function') step();
        else yield step;
      }
    })(),
    write: (line) => {
      replies.push(JSON.parse(line) as (typeof replies)[number]);
    },
  }, { home, build: BUILD });
  return { code, err: io.err, replies };
}

test('a launch line with no epoch still serves the seat its inbox tools', async () => {
  const { home, root, file, drop } = world('current');
  const id = '11111111-1111-4111-8111-111111111111';
  const body = 'the seat reads this from the epoch-less line';
  plantRecord(home, root, SESSION, SEAT, id, body, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const got = await serve(home, root, { seat: SEAT, session: SESSION, file }, [
    listTools(),
    () => {
      const listener = JSON.parse(readFileSync(listenerPath(drop), 'utf8')) as { epoch?: string; seat?: string };
      expect(listener.seat).toBe(SEAT);
      expect(listener.epoch).toBe(CURRENT);
    },
    callTool('inbox_check'),
    callTool('inbox_read', { id }),
  ]);
  expect(got.code).toBe(0);
  expect(got.err).toBe('');
  const names = got.replies[0]?.result?.tools?.map((tool) => tool.name) ?? [];
  expect(names).toContain('inbox_check');
  expect(names).toContain('inbox_read');
  expect(got.replies[1]?.result?.isError).not.toBe(true);
  expect(toolText(got.replies[1] ?? {})).toContain(id);
  expect(got.replies[2]?.result?.isError).not.toBe(true);
  expect(toolText(got.replies[2] ?? {})).toContain(body);
});

test('an old or foreign launch cannot serve or read that inbox', async () => {
  const foreign = world('current');
  const foreignId = '22222222-2222-4222-8222-222222222222';
  const foreignBody = 'a foreign launch must not read this';
  plantRecord(foreign.home, foreign.root, SESSION, SEAT, foreignId, foreignBody, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const refused = await serve(foreign.home, foreign.root, { seat: SEAT, session: SESSION, file: foreign.file, epoch: FOREIGN }, [
    callTool('inbox_read', { id: foreignId }),
  ]);
  expect(refused.code).toBe(2);
  expect(refused.replies).toEqual([]);
  expect(refused.err).toContain('is not the seat\'s current launch epoch');
  expect(refused.err).not.toContain(foreignBody);
  expect(existsSync(listenerPath(foreign.drop))).toBe(false);
  expect(existsSync(receiptPath(foreign.drop, foreignId))).toBe(false);
  expect(waiting(foreign.home, foreign.root)).toContain(foreignId);

  const moved = world('current');
  const movedId = '33333333-3333-4333-8333-333333333333';
  const movedBody = 'an old launch must not read this';
  plantRecord(moved.home, moved.root, SESSION, SEAT, movedId, movedBody, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const stale = await serve(moved.home, moved.root, { seat: SEAT, session: SESSION, file: moved.file, epoch: CURRENT }, [
    () => {
      updateState(moved.dir, (state) => {
        const held = state.sessions[SESSION]?.briefs?.[SEAT];
        if (held !== undefined) held.epoch = NEXT;
      });
    },
    callTool('inbox_check'),
    callTool('inbox_read', { id: movedId }),
  ]);
  expect(stale.code).toBe(0);
  expect(stale.replies).toHaveLength(2);
  for (const reply of stale.replies) {
    expect(reply.result?.isError).toBe(true);
    expect(toolText(reply)).toContain('is not the seat\'s current launch epoch');
    expect(toolText(reply)).not.toContain(movedBody);
  }
  expect(existsSync(receiptPath(moved.drop, movedId))).toBe(false);
  expect(waiting(moved.home, moved.root)).toContain(movedId);

  const early = world('none');
  const earlyId = '44444444-4444-4444-8444-444444444444';
  const earlyBody = 'a launch from before the claim must not read this';
  plantRecord(early.home, early.root, SESSION, SEAT, earlyId, earlyBody, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const later = await serve(early.home, early.root, { seat: SEAT, session: SESSION, file: early.file }, [
    () => {
      updateState(early.dir, (state) => {
        const session = state.sessions[SESSION] ?? emptySession();
        state.sessions[SESSION] = session;
        session.briefs = { [SEAT]: brief(CURRENT) };
      });
    },
    callTool('inbox_check'),
    callTool('inbox_read', { id: earlyId }),
  ]);
  expect(later.code).toBe(0);
  expect(later.replies).toHaveLength(2);
  for (const reply of later.replies) {
    expect(reply.result?.isError).toBe(true);
    expect(toolText(reply)).toContain('started without its epoch');
    expect(toolText(reply)).not.toContain(earlyBody);
  }
  expect(existsSync(receiptPath(early.drop, earlyId))).toBe(false);
  expect(waiting(early.home, early.root)).toContain(earlyId);
});

test('team drops --read writes the receipt after the body, and a failed hand-over leaves it unread', async () => {
  const { home, root, drop } = world('none');
  const okId = '55555555-5555-4555-8555-555555555555';
  const failId = '66666666-6666-4666-8666-666666666666';
  const okBody = 'printed before any receipt';
  const failBody = 'a failed hand-over never receipts this';
  plantRecord(home, root, SESSION, SEAT, okId, okBody, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const ok = testIo(root, caller);
  let printed = false;
  const keep = ok.stdout.bind(ok);
  ok.stdout = (text) => {
    expect(existsSync(receiptPath(drop, okId))).toBe(false);
    expect(text).toContain(okBody);
    printed = true;
    keep(text);
  };
  const code = await runDrops(['--read', '--seat', SEAT, '--session', SESSION], ok, { home });
  expect(code).toBe(0);
  expect(printed).toBe(true);
  expect(ok.err).toBe('');
  expect(existsSync(receiptPath(drop, okId))).toBe(true);
  expect(waiting(home, root)).not.toContain(okId);

  plantRecord(home, root, SESSION, SEAT, failId, failBody, { from: 'reader', rule: 'a seat to a seat of its own team' });
  const fail = testIo(root, caller);
  fail.stdout = () => {
    throw new Error('hand-over failed');
  };
  await expect(runDrops(['--read', '--seat', SEAT, '--session', SESSION], fail, { home })).rejects.toThrow('hand-over failed');
  expect(existsSync(receiptPath(drop, failId))).toBe(false);
  expect(waiting(home, root)).toContain(failId);
  expect(waiting(home, root)).not.toContain(okId);
});
