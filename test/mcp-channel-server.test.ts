// The seat's inbox server as a Claude Code channel: a launch that carries the development
// channel naming `team-inbox` makes the server declare `experimental["claude/channel"]`, push
// each message that arrives after it starts as one `notifications/claude/channel`. A push is a
// transport reservation, never a consumer read. The `ack` tool writes the same signed receipt as
// `team ack` with `read_by: channel`; inbox reads also settle pushed messages. An ignored push
// survives server restart and remains eligible for the watch's bounded recovery.
// A launch without the flag is the ordinary inbox server: no capability, no instructions, no
// push, no ack. Fixtures only: synthetic folders, a synthetic home, and a launch line this test
// writes; no live session is touched.
import { describe, expect, spyOn, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { CHANNEL_CONFIRM_MS, CHANNEL_UNCONFIRMED, channelCommitLockPath, channelPushPath } from '../src/mcp/channel.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { gitRootReadCount, loadTeamFile } from '../src/file/load.ts';
import { runReply } from '../src/commands/reply.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { markPending, readPending } from '../src/send/pending.ts';
import { signRecord, verifyReceipt, type RecordPayload, type SignedReceipt } from '../src/send/record.ts';
import * as keys from '../src/store/keys.ts';
import { messageKeyState } from '../src/store/keys.ts';
import { currentRunMemo } from '../src/run-memo.ts';
import { markChannelNotified } from '../src/mcp/channel.ts';
import { retryHeldDrops, type RetryScene } from '../src/watch/retry.ts';
import { paneShell, testIo } from './helpers.ts';

const SESSION = 'acme';
const FLAG = '--dangerously-load-development-channels server:team-inbox';
const PUSHED_ID = 'aaaaaaaa-0000-4000-8000-000000000101';
const ACKED_ID = 'bbbbbbbb-0000-4000-8000-000000000102';
const UNKNOWN_ID = 'cccccccc-0000-4000-8000-000000000103';
const IDLE_ID = 'dddddddd-0000-4000-8000-000000000104';

function teamText(launch: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
  - role: worker
    name: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`;
}

type Place = {
  root: string;
  home: string;
  dropDir: string;
  leadId: string;
  workerId: string;
  cleanup(): void;
};

function place(launch = `claude ${FLAG}`): Place {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-')));
  mkdirSync(join(root, '.agents'));
  mkdirSync(join(root, 'home'), { mode: 0o700 });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(launch));
  // The state `team up` leaves: the server proves its caller stands on lead's recorded pane.
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({ format: 1, sessions: { [SESSION]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' }, worker: { stage: 'ready', pane: 'pane-worker' } }, worktrees: {} } } })}\n`,
  );
  const home = join(root, 'home');
  const teamId = teamIdOf(root);
  // Roster membership alone cannot resolve a signed from_id: the sender lookup also requires
  // a live agent file with matching team, seat and session. Register both synthetic agents.
  const agents = (['lead', 'worker'] as const).map((seat) => registerAgent(home, {
    name: seat,
    signing: { model: 'Test', version: '1', role: seat === 'lead' ? 'coordinator' : 'worker' },
    lab: 'test', cli: 'claude-code', launcher: null,
    launch: seat === 'lead' ? launch : 'claude',
    reach: { team: teamId, seat, session: SESSION, pane: `pane-${seat}`, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'owner',
  }));
  // A server started with no --file resolves its team from the registry record holding the seat.
  upsertTeam(home, teamId, {
    project: 'acme',
    session: SESSION,
    root,
    roster: agents.map((agent) => ({ agent: agent.id, seat: agent.reach.seat, role: agent.signing.role })),
  });
  return {
    root,
    home,
    dropDir: join(root, '.agents', 'send-drops', SESSION, 'lead'),
    leadId: agents[0]!.id,
    workerId: agents[1]!.id,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A message record signed by this fixture's home, under `id`, in the lead's inbox. */
function signed(at: Place, id: string, body: string, extra: Partial<RecordPayload> = {}): void {
  const record = signRecord({
    kind: 'message',
    id,
    to: 'lead',
    to_id: at.leadId,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-10-22T09:00:00.000Z',
    body,
    from: 'worker',
    from_id: at.workerId,
    rule: 'the owner',
    thread: id,
    ...extra,
  }, at.home);
  mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(at.dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function queue(): { lines: AsyncIterable<string>; write(line: string): void; push(line: string): void; end(): void; replies: string[] } {
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

function call(id: string, name: string, args?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, ...(args ? { arguments: args } : {}) } });
}

/** A fake client explicitly calls a tool; merely capturing a notification calls nothing. */
async function tool(feed: ReturnType<typeof queue>, request: string, name: string, args?: Record<string, unknown>): Promise<Record<string, any>> {
  feed.push(call(request, name, args));
  await until(() => feed.replies.some((line) => JSON.parse(line).id === request));
  const reply = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === request);
  expect(reply).toBeDefined();
  return reply!.result;
}

/** The actual watch retry path, with only its socket transport replaced by a fake client. */
function recovery(at: Place, now: Date, sockets: string[]): RetryScene {
  const loaded = loadTeamFile(at.root, { home: at.home });
  if (!loaded.ok) throw new Error('fixture team failed to load');
  return {
    dir: join(at.root, '.agents'), root: at.root, home: at.home, session: SESSION,
    team: loaded.team, now, ownPane: null,
    live: {
      running: true,
      agents: [{ name: 'lead', agent: 'claude', pane: 'pane-lead', workspace: 'first', status: 'idle', cwd: null }],
      workspaces: [], screens: {},
    },
    sources: {
      screen: () => { throw new Error('recovery must not read a pane'); },
      status: () => 'idle',
      typeText: () => { throw new Error('recovery must not type into a pane'); },
      pressEnter: () => { throw new Error('recovery must not submit a pane'); },
      sleep: async () => {},
    },
    socketRedeliver: async (_dir, drop) => {
      expect(drop.redelivered).toBe(CHANNEL_UNCONFIRMED);
      sockets.push(drop.id);
      return { ok: true };
    },
    say: () => {},
  };
}

function notice(replies: readonly string[]): Record<string, any>[] {
  return replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 400): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The caller lead's own launch line places: the seat, on its recorded pane, in the session. */
function seatCaller(): { kind: 'seat'; name: string; pane: string; session: string } {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: SESSION };
}

async function preloaded(root: string, home: string, lines: readonly string[]) {
  const io = testIo(root, seatCaller());
  const replies: string[] = [];
  const code = await runMcpServe({ seat: 'lead', session: SESSION }, io, {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    write: (line) => replies.push(line),
  }, { home });
  return { code, io, replies: replies.map((line) => JSON.parse(line) as Record<string, any>) };
}

describe('the channel declaration', () => {
  test('a launch with the development channel declares claude/channel, its one instruction, and ack', async () => {
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
      expect(replies[0]!.result.capabilities).toEqual({ tools: {}, experimental: { 'claude/channel': {} } });
      // The launch's protocol negotiation is pinned to the legacy revision, and the declaration
      // answers in the same one: the channel is loaded on 2024-11-05, never a newer revision.
      expect(replies[0]!.result.protocolVersion).toBe('2024-11-05');
      expect(replies[0]!.result.instructions).toContain('call the ack tool');
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read', 'ack']);
    } finally {
      at.cleanup();
    }
  });

  test('a launch without the flag is the ordinary inbox server: no capability, no instructions, no ack', async () => {
    const at = place('claude');
    try {
      const { replies } = await preloaded(at.root, at.home, [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      ]);
      expect(replies[0]!.result.capabilities).toEqual({ tools: {} });
      expect(replies[0]!.result).not.toHaveProperty('instructions');
      expect(replies[1]!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['inbox_check', 'inbox_read']);
    } finally {
      at.cleanup();
    }
  });
});

describe('the push', () => {

  test('the notification carries the content and meta only: no key object rides in a frame shown to an agent', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'from a worker — admitted by: the owner\n\nhello there');
      await until(() => notice(feed.replies).length >= 1);
      // The raw line the client receives contains content and meta alone.
      const raw = feed.replies.find((one) => (JSON.parse(one) as Record<string, any>).method === 'notifications/claude/channel')!;
      expect(raw).not.toContain('"key"');
      const params = (JSON.parse(raw) as Record<string, any>).params;
      expect(Object.keys(params)).toEqual(['content', 'meta']);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('a serving seat holds git\'s root answer: later pushes start no git', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      signed(at, PUSHED_ID, 'from a worker — admitted by: the owner\n\nfirst');
      await until(() => notice(feed.replies).length >= 1);
      const reads = gitRootReadCount();
      signed(at, ACKED_ID, 'from a worker — admitted by: the owner\n\nsecond');
      signed(at, IDLE_ID, 'from a worker — admitted by: the owner\n\nthird');
      await until(() => notice(feed.replies).length >= 3);
      expect(notice(feed.replies)).toHaveLength(3);
      expect(gitRootReadCount()).toBe(reads);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('a push reads its inputs under one run memo, and its commit re-proves the seat on fresh reads', async () => {
    const at = place();
    let memoInCommit: boolean | null = null;
    const original = keys.messageKeyState;
    const memoAtKey: boolean[] = [];
    let armed = false;
    const keySpy = spyOn(keys, 'messageKeyState').mockImplementation((home?: string) => {
      if (armed) memoAtKey.push(currentRunMemo() !== null);
      return original(home);
    });
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, {
        home: at.home,
        channelMark: (dir, id) => {
          memoInCommit = currentRunMemo() !== null;
          return markChannelNotified(dir, id);
        },
      });
      await until(() => existsSync(listenerPath(at.dropDir)));
      expect(currentRunMemo()).toBeNull();
      signed(at, PUSHED_ID, 'from a worker — admitted by: the owner\n\nmemo');
      armed = true;
      await until(() => notice(feed.replies).length >= 1);
      expect(notice(feed.replies)).toHaveLength(1);
      // The record's checks read the key under the memo; the commit (the seat re-proof, the
      // marker, the frame) runs outside it.
      expect(memoAtKey[0]).toBe(true);
      expect(memoInCommit).toBe(false);
      expect(currentRunMemo()).toBeNull();
      feed.end();
      expect(await running).toBe(0);
    } finally {
      keySpy.mockRestore();
      at.cleanup();
    }
  });

  test('ack writes the signed read receipt with read_by channel for a message no push carried', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      // Mail already waiting at startup is left to inbox_check, so this record is never pushed:
      // the ack is the only writer on this path.
      signed(at, ACKED_ID, 'from a worker — admitted by: the owner\n\nack me');
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      feed.push(call('7', 'ack', { id: ACKED_ID }));
      await until(() => feed.replies.some((line) => JSON.parse(line).id === '7'));
      const answer = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === '7')!;
      expect(answer.result.isError).toBeUndefined();
      const receipt = JSON.parse(readFileSync(receiptPath(at.dropDir, ACKED_ID), 'utf8')) as SignedReceipt;
      expect(receipt.payload).toMatchObject({ kind: 'receipt', status: 'read', id: ACKED_ID, to: 'lead', session: SESSION, read_by: 'channel' });
      const key = messageKeyState(at.home);
      expect(key.kind).toBe('key');
      if (key.kind !== 'key') throw new Error('the fixture home holds no message key');
      expect(verifyReceipt(receipt, key.key)).toBe(true);
      const before = notice(feed.replies).length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(notice(feed.replies)).toHaveLength(before);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  test('an ack for an id this inbox does not hold is refused, and writes nothing', async () => {
    const at = place();
    try {
      const io = testIo(at.root, seatCaller());
      const feed = queue();
      const running = runMcpServe({ seat: 'lead', session: SESSION }, io, feed, { home: at.home });
      await until(() => existsSync(listenerPath(at.dropDir)));
      feed.push(call('8', 'ack', { id: UNKNOWN_ID }));
      await until(() => feed.replies.some((line) => JSON.parse(line).id === '8'));
      const answer = feed.replies.map((line) => JSON.parse(line) as Record<string, any>).find((one) => one.id === '8')!;
      expect(answer.result.isError).toBe(true);
      expect(existsSync(receiptPath(at.dropDir, UNKNOWN_ID))).toBe(false);
      feed.end();
      expect(await running).toBe(0);
    } finally {
      at.cleanup();
    }
  });

  for (const wrong of ['recipient', 'session', 'root', 'signature'] as const) {
    test(`ack still refuses a record with the wrong ${wrong} and writes no receipt`, async () => {
      const at = place();
      try {
        const extra: Partial<RecordPayload> = wrong === 'recipient' ? { to: 'elsewhere' }
          : wrong === 'session' ? { session: 'elsewhere' }
          : wrong === 'root' ? { root: join(at.root, 'elsewhere') } : {};
        signed(at, ACKED_ID, 'never acknowledged', extra);
        if (wrong === 'signature') {
          const path = join(at.dropDir, ACKED_ID);
          const record = JSON.parse(readFileSync(path, 'utf8'));
          record.payload.body = 'changed after signing';
          writeFileSync(path, JSON.stringify(record));
        }
        const { replies, code } = await preloaded(at.root, at.home, [call('bad', 'ack', { id: ACKED_ID })]);
        expect(code).toBe(0);
        expect(replies[0]!.result.isError).toBe(true);
        expect(existsSync(receiptPath(at.dropDir, ACKED_ID))).toBe(false);
      } finally {
        at.cleanup();
      }
    });
  }
});

describe('an idle channel server', () => {
  /** 7,500 drop names and 7,500 receipt names. A pass that parses every drop on each tick
   *  spends seconds of CPU here; a pass that only lists names does not. */
  function fillInbox(dropDir: string): void {
    mkdirSync(dropDir, { recursive: true, mode: 0o700 });
    for (let n = 0; n < 7_500; n += 1) {
      const name = `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
      writeFileSync(join(dropDir, name), '{}\n');
      writeFileSync(join(dropDir, `${name}.read.json`), '{}\n');
    }
  }

  function runner(at: Place, fallbackMs?: number): { child: ChildProcess; out: () => string; err: () => string; cpuPath: string; ready: string } {
    const shell = paneShell({
      bin: join(at.home, 'bin'),
      dir: join(at.root, '.agents'),
      session: SESSION,
      seat: 'lead',
      pane: 'pane-lead',
      home: at.home,
    });
    const file = join(at.root, 'idle-serve.ts');
    const cpuPath = join(at.root, 'idle-cpu.json');
    const ready = join(at.root, 'idle-ready');
    const serve = fileURLToPath(new URL('../src/mcp/serve.ts', import.meta.url));
    writeFileSync(file, `import { existsSync, writeFileSync } from 'node:fs';
import { runMcpServe } from ${JSON.stringify(serve)};
const listener = process.env.LISTENER_PATH ?? '';
const cpuPath = process.env.CPU_PATH ?? '';
const ready = process.env.READY_PATH ?? '';
let base: NodeJS.CpuUsage | null = null;
let from = 0;
const arm = setInterval(() => {
  if (from !== 0 || !existsSync(listener)) return;
  from = Date.now();
  base = process.cpuUsage();
  writeFileSync(ready, 'ready\\n');
}, 50);
process.on('SIGTERM', () => {
  clearInterval(arm);
  const used = base === null ? process.cpuUsage() : process.cpuUsage(base);
  writeFileSync(cpuPath, JSON.stringify({ user: used.user, system: used.system, wall: from === 0 ? 0 : Date.now() - from }));
  process.exit(0);
});
const fallback = process.env.FALLBACK_MS;
await runMcpServe({
  seat: 'lead',
  session: process.env.TEAM_SESSION,
  file: process.env.TEAM_FILE,
  ...(fallback === undefined || fallback === '' ? {} : { fallbackMs: Number(fallback) }),
}, {
  stdout() {},
  stderr(text) { process.stderr.write(text); },
  cwd: process.cwd(),
  env: process.env,
  stdinIsTTY: false,
});
`);
    let out = '';
    let err = '';
    const child = spawn(process.execPath, [file], {
      cwd: at.root,
      env: {
        ...shell.env,
        TEAM_SESSION: SESSION,
        TEAM_FILE: join(at.root, '.agents', 'team.yaml'),
        LISTENER_PATH: listenerPath(at.dropDir),
        CPU_PATH: cpuPath,
        READY_PATH: ready,
        ...(fallbackMs === undefined ? {} : { FALLBACK_MS: String(fallbackMs) }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    return { child, out: () => out, err: () => err, cpuPath, ready };
  }

  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server did not exit after kill')), 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.kill();
    await exited;
  }

  // A CPU benchmark that idles 10 s: runs when asked (TEAM_SCALE_TESTS=1), not by default.
  test.skipIf(process.env.TEAM_SCALE_TESTS !== '1')('a large inbox stays under the CPU bound for 10s, and a new drop arrives through the folder watch', async () => {
    const at = place();
    let running: ChildProcess | undefined;
    try {
      fillInbox(at.dropDir);
      const cpu = runner(at);
      running = cpu.child;
      await until(() => existsSync(cpu.ready) || cpu.child.exitCode !== null, 2_000);
      expect(cpu.child.exitCode).toBeNull();
      const idleFrom = Date.now();
      const remain = async (): Promise<void> => {
        const left = 10_000 - (Date.now() - idleFrom);
        if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      };
      await remain();
      await stop(cpu.child);
      running = undefined;
      const sample = JSON.parse(readFileSync(cpu.cpuPath, 'utf8')) as { user: number; system: number; wall: number };
      expect(sample.wall).toBeGreaterThanOrEqual(9_000);
      // Re-reading every file on the short tick of this folder stays above two seconds.
      // Listing names and parsing only a new one stays under it.
      expect(sample.user + sample.system).toBeLessThan(2_000_000);

      const late = runner(at, 30_000);
      running = late.child;
      await until(() => late.err().includes('channel primed') || late.child.exitCode !== null, 2_000);
      expect(late.child.exitCode).toBeNull();
      const sentAt = Date.now();
      signed(at, IDLE_ID, 'from a worker — admitted by: the owner\n\nwhile idle');
      await until(() => late.out().includes(IDLE_ID) || late.child.exitCode !== null, 400);
      expect(Date.now() - sentAt).toBeLessThan(1_500);
      expect(late.out()).toContain(IDLE_ID);
      await stop(late.child);
      running = undefined;
    } finally {
      if (running !== undefined && running.exitCode === null && running.signalCode === null) running.kill();
      at.cleanup();
    }
  }, 60_000);

  test('a foreign lock is left unseen at the give-up and delivered on the next pass once it is gone', async () => {
    const at = place();
    const id = 'eeeeeeee-0000-4000-8000-000000000105';
    const holder = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    if (holder.pid === undefined) throw new Error('the foreign holder has no pid');
    let running: ChildProcess | undefined;
    try {
      mkdirSync(at.dropDir, { recursive: true, mode: 0o700 });
      writeFileSync(channelCommitLockPath(at.dropDir, id), `${String(holder.pid)}\n`, { mode: 0o600 });
      const child = runner(at, 30_000);
      running = child.child;
      await until(() => child.err().includes('channel primed') || child.child.exitCode !== null, 2_000);
      expect(child.child.exitCode).toBeNull();
      signed(at, id, 'from a worker — admitted by: the owner\n\nforeign lock');
      await until(() => child.err().includes('stayed busy') || child.child.exitCode !== null, 1_000);
      expect(child.err()).toContain('stayed busy');
      expect(child.out().includes(id)).toBe(false);
      unlinkSync(channelCommitLockPath(at.dropDir, id));
      await until(() => child.out().includes(id) || child.child.exitCode !== null, 400);
      expect(child.out()).toContain(id);
      await stop(child.child);
      running = undefined;
    } finally {
      holder.kill();
      if (running !== undefined && running.exitCode === null && running.signalCode === null) running.kill();
      at.cleanup();
    }
  }, 20_000);
});
