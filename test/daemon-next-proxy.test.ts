// The daemon next proxy at both ends of the wire: the client's request/answer framing against a
// fake socket and against a real v1 machine daemon, and the command's injected seam, whose
// proxied answers must print through the same printers and exits the direct path uses.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runNext, type NextSources } from '../src/commands/next.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { askDaemonNext, daemonNextRequest, type DaemonNextRequest } from '../src/daemon/next-client.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
tasks:
  source: file
  path: .agents/tasks.yaml
  cadence: 10m
`;

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const CTX = 'team acme, session "acme"\n';

const bases: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function scratch(): { base: string; root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), 'team-next-proxy-'));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, '.agents', 'tasks.yaml'), '- id: m1\n  title: the task title\n');
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
  bases.push(base);
  return { base, root, home };
}

function request(root: string): DaemonNextRequest {
  return daemonNextRequest({
    root,
    team: 'acme',
    session: 'acme',
    caller: { seat: 'lead', pane: 'w1:p1' },
    action: 'claim',
    mine: false,
  });
}

/** A one-connection socket that reads the request line and answers with `reply`; a null reply
 *  keeps the connection open and silent, the deadline scene. */
async function oneShot(socketPath: string, reply: (request: DaemonNextRequest) => string | null): Promise<void> {
  const server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      const parsed = JSON.parse(buffer.slice(0, at)) as DaemonNextRequest;
      const answer = reply(parsed);
      if (answer !== null) socket.end(`${answer}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(socketPath, () => done()));
}

describe('askDaemonNext over the machine socket', () => {
  test('a next-shaped success is the handler answer', async () => {
    const { base, root } = scratch();
    const socketPath = join(base, 'next.sock');
    await oneShot(socketPath, (asked) => JSON.stringify({
      v: DAEMON_PROTOCOL_VERSION,
      id: asked.id,
      ok: true,
      next: { ok: true, kind: 'claimed', record: { id: 'm1', title: 'the task title' } },
    }));
    const outcome = await askDaemonNext(socketPath, request(root));
    expect(outcome).toEqual({ kind: 'answer', answer: { ok: true, kind: 'claimed', record: { id: 'm1', title: 'the task title' } } });
  });

  test('an error line is a refusal carrying the daemon code and message', async () => {
    const { base, root } = scratch();
    const socketPath = join(base, 'next.sock');
    await oneShot(socketPath, (asked) => JSON.stringify({
      v: DAEMON_PROTOCOL_VERSION,
      id: asked.id,
      ok: false,
      error: { code: 'daemon.auth-unsupported', message: 'next: not accepted' },
    }));
    expect(await askDaemonNext(socketPath, request(root))).toEqual({
      kind: 'refused',
      code: 'daemon.auth-unsupported',
      message: 'next: not accepted',
    });
  });

  test.each([
    ['a line that is not JSON', (asked: DaemonNextRequest) => 'not json'],
    ['an answer under another id', (asked: DaemonNextRequest) => JSON.stringify({ v: 1, id: `${asked.id}-other`, ok: true, next: { ok: true, kind: 'none', why: 'nothing-takeable' } })],
    ['a success with no answer body', (asked: DaemonNextRequest) => JSON.stringify({ v: 1, id: asked.id, ok: true })],
    ['a claimed answer with no record', (asked: DaemonNextRequest) => JSON.stringify({ v: 1, id: asked.id, ok: true, next: { ok: true, kind: 'claimed' } })],
    ['a none answer with an unknown why', (asked: DaemonNextRequest) => JSON.stringify({ v: 1, id: asked.id, ok: true, next: { ok: true, kind: 'none', why: 'later' } })],
  ])('%s is the wrong-answer fail-safe', async (_name, reply) => {
    const { base, root } = scratch();
    const socketPath = join(base, 'next.sock');
    await oneShot(socketPath, reply);
    expect(await askDaemonNext(socketPath, request(root))).toEqual({ kind: 'wrong' });
  });

  test('no listener is unavailable', async () => {
    const { base, root } = scratch();
    expect(await askDaemonNext(join(base, 'absent.sock'), request(root), { deadlineMs: 200 })).toEqual({ kind: 'unavailable' });
  });

  test('a silent listener is the deadline', async () => {
    const { base, root } = scratch();
    const socketPath = join(base, 'next.sock');
    await oneShot(socketPath, () => null);
    expect(await askDaemonNext(socketPath, request(root), { deadlineMs: 100 })).toEqual({ kind: 'deadline' });
  });

  test('a real v1 daemon refuses next and the checkout is left untouched', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({ home, roots: [root], startedBy: 'service-manager', version: '0.5.3-test' });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const outcome = await askDaemonNext(daemonSocketPath(home), request(root));
      expect(outcome).toMatchObject({ kind: 'refused', code: 'daemon.auth-unsupported' });
      if (outcome.kind !== 'refused') throw new Error('expected a refusal');
      expect(outcome.message).toContain('nothing was done');
      expect(existsSync(join(root, '.agents', 'leases'))).toBe(false);
    } finally {
      await started.daemon.close();
    }
  });
});

describe('team next through an injected daemon proxy', () => {
  async function run(
    argv: string[],
    sources: NextSources = {},
    caller: Caller = lead,
  ): Promise<{ code: number; out: string; err: string }> {
    const { root, home } = scratch();
    const io = testIo(root, caller);
    const code = await runNext(argv, io, { home, ...sources });
    return { code, out: io.out, err: io.err };
  }

  test('the proxy is asked with the locally placed claim, and its claim prints like a local take', async () => {
    const calls: unknown[] = [];
    const result = await run([], {
      daemonNext: async (input) => {
        calls.push(input);
        return { kind: 'answer', answer: { ok: true, kind: 'claimed', record: { id: 'm9', title: 'from the daemon' } } };
      },
    });
    expect(result).toEqual({ code: 0, out: `${CTX}m9  from the daemon\nteam next: claimed m9\n`, err: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ team: 'acme', session: 'acme', caller: { seat: 'lead', pane: 'w1:p1' }, action: 'claim', mine: false });
    // The command delegates the claim: it writes no lease of its own.
    expect(existsSync(join((calls[0] as { root: string }).root, '.agents', 'leases'))).toBe(false);
  });

  test('a proxied empty answer uses the direct path sentence, and --json its envelope', async () => {
    const none = async (): Promise<Awaited<ReturnType<NonNullable<NextSources['daemonNext']>>>> => ({
      kind: 'answer',
      answer: { ok: true, kind: 'none', why: 'nothing-assigned' },
    });
    expect(await run(['--mine'], { daemonNext: none })).toEqual({
      code: 0,
      out: `${CTX}team next: nothing is assigned to you\n`,
      err: '',
    });
    const json = await run(['--mine', '--json'], { daemonNext: none });
    const parsed = JSON.parse(json.out) as { status: string; action: string; task: unknown };
    expect(parsed).toMatchObject({ status: 'none', action: 'none', task: null });
  });

  test('a proxied refusal prints through the same exit its code names', async () => {
    const paused = await run([], {
      daemonNext: async () => ({
        kind: 'answer',
        answer: { ok: false, code: 'next.paused', message: 'the team is paused (paused since now by owner); nothing new is claimed until `team resume`', hint: 'team resume' },
      }),
    });
    expect(paused.code).toBe(1);
    expect(paused.err).toBe('team next: the team is paused (paused since now by owner); nothing new is claimed until `team resume`\n');
    const json = await run(['--json'], {
      daemonNext: async () => ({
        kind: 'answer',
        answer: { ok: false, code: 'next.paused', message: 'paused for the test', hint: 'team resume' },
      }),
    });
    const parsed = JSON.parse(json.out) as { error: { id: string; repair: string } };
    expect(parsed.error).toMatchObject({ id: 'next.paused', repair: 'team resume' });
    expect(json.code).toBe(1);
  });

  test('a transport failure is the source being unavailable, and claims nothing', async () => {
    const result = await run([], { daemonNext: async () => ({ kind: 'unavailable' }) });
    expect(result).toEqual({ code: 1, out: '', err: 'team next: the team daemon is not running; nothing is claimed\n' });
  });

  test('a broker read notice rides the answer to stderr', async () => {
    const result = await run([], {
      daemonNext: async () => ({
        kind: 'answer',
        answer: { ok: true, kind: 'claimed', record: { id: 'L1', title: 'tracker one' }, notice: 'only page 1 was read' },
      }),
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe('team next: only page 1 was read\n');
    expect(result.out).toContain('team next: claimed L1\n');
  });

  test('--wait re-asks the proxy until it claims', async () => {
    let calls = 0;
    let clock = 0;
    const result = await run(['--wait'], {
      now: () => clock,
      wait: async (seconds) => {
        clock += seconds * 1000;
        return true;
      },
      daemonNext: async () => {
        calls += 1;
        if (calls === 1) return { kind: 'answer', answer: { ok: true, kind: 'none', why: 'nothing-takeable' } };
        return { kind: 'answer', answer: { ok: true, kind: 'claimed', record: { id: 'm9', title: 'later' } } };
      },
    });
    expect(calls).toBe(2);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${CTX}team next: nothing is takeable\nteam next: waiting every 600s\nm9  later\nteam next: claimed m9\n`);
  });

  test('the direct path is untouched when no proxy is injected', async () => {
    const result = await run([]);
    expect(result).toEqual({ code: 0, out: `${CTX}m1  the task title\nteam next: claimed m1\n`, err: '' });
  });
});
