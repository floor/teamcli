// The warm send host's socket server and thin client, end to end over a real Unix socket, with the
// kernel reader and the CLI's dispatcher stood in for: the retry boundary (rfc-bus-send-server
// §2.2). A line runs locally only when it was never submitted or the host answered `fallback`
// from a state where it can never run; everything else after submission is ambiguous. Every
// assertion counts the dispatcher's runs, so "never ran" is an effect, not a message.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryHost } from '../../src/host/client.ts';
import type { PeerReader } from '../../src/host/peer.ts';
import { buildStampOf, startSendHost, type SendHost } from '../../src/host/server.ts';
import type { Io } from '../../src/io.ts';

let base: string;
let cliEntry: string;
let host: SendHost | null = null;

const seatSources: Io['callerSources'] = () => ({
  ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
  agents: () => [{ name: 'builder', pane: 'w1:p1', agent: 'claude', workspace: 'w1', status: 'idle' as const, cwd: null }],
  paneRootPid: () => 101,
  env: { HERDR_PANE_ID: 'w1:p1' },
  stdinIsTTY: false,
});

function reader(over: Partial<{ uid: number; confined: boolean; cwd: string | null }> = {}): PeerReader {
  const uid = over.uid ?? process.getuid!();
  return {
    credentials: () => ({ uid, pid: process.pid }),
    process: () => ({ ppid: process.ppid, uid: process.getuid!(), startSec: 1n, startUsec: 2n }),
    cwd: () => (over.cwd === undefined ? base : over.cwd),
    confined: () => over.confined ?? false,
  };
}

type Gate = { open: () => void; wait: Promise<void> };
function gate(): Gate {
  let open = (): void => {};
  const wait = new Promise<void>((settle) => { open = settle; });
  return { open, wait };
}

async function start(main: (argv: string[], io: Io) => Promise<number>, extra: Partial<Parameters<typeof startSendHost>[0]> = {}): Promise<SendHost> {
  host = await startSendHost({
    home: base,
    cliEntry,
    main,
    ownEnv: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    reader: reader(),
    socketPath: join(base, 'h.sock'),
    callerSources: seatSources,
    ...extra,
  });
  return host;
}

function line(argv: string[], over: Partial<{ cwd: string; env: Record<string, string> }> = {}) {
  const env: Record<string, string> = {};
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
  return tryHost({
    argv,
    cwd: over.cwd ?? base,
    env: over.env ?? env,
    tty: { stdin: false, stdout: false, stderr: false },
    cliEntry,
    socketPath: join(base, 'h.sock'),
    connectWindowMs: 1_000,
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'send-host-')));
  cliEntry = join(base, 'cli.js');
  writeFileSync(cliEntry, '// a build\n');
  writeFileSync(join(base, 'build-id'), `${'a'.repeat(64)}\n`);
});

afterEach(async () => {
  await host?.close('test end');
  host = null;
  rmSync(base, { recursive: true, force: true });
});

describe('the client', () => {
  test('no socket: not submitted, so the line runs locally', async () => {
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('not-submitted');
  });

  test('a line the host runs comes back with its output and exit code', async () => {
    let runs = 0;
    await start(async (argv, io) => { runs += 1; io.stdout(`sent ${argv[1]}\n`); io.stderr('note\n'); return 0; });
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome).toEqual({ kind: 'ran', code: 0, stdout: 'sent lead\n', stderr: 'note\n' });
    expect(runs).toBe(1);
  });

  test('the build stamp is the same on both sides for the same build identity, and absent without one', () => {
    expect(buildStampOf(cliEntry)).toMatch(/\+a{64}$/);
    rmSync(join(base, 'build-id'));
    expect(buildStampOf(cliEntry)).toBeNull();
  });

  test('a client without a readable build identity never submits', async () => {
    let runs = 0;
    await start(async () => { runs += 1; return 0; });
    rmSync(join(base, 'build-id'));
    expect((await line(['send', 'lead', 'hi'])).kind).toBe('not-submitted');
    expect(runs).toBe(0);
  });

  test('a rebuild that changes only a non-entry module is another build', async () => {
    const { writeBuildId } = await import('../../scripts/build.ts');
    const dist = join(base, 'dist');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dist, 'commands'), { recursive: true });
    writeFileSync(join(dist, 'cli.js'), '// entry\n');
    writeFileSync(join(dist, 'commands', 'send.js'), '// admission v1\n');
    writeBuildId(dist);
    const first = buildStampOf(join(dist, 'cli.js'));
    writeFileSync(join(dist, 'commands', 'send.js'), '// admission v2\n');
    writeBuildId(dist);
    const second = buildStampOf(join(dist, 'cli.js'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe('handed back before anything runs', () => {
  const cases: [string, string[], Partial<Parameters<typeof reader>[0]>, Partial<{ env: Record<string, string> }>][] = [
    ['a line the host does not serve', ['status'], {}, {}],
    ['a send with --wait', ['send', 'lead', 'hi', '--wait'], {}, {}],
    ['a body from stdin', ['send', 'lead', '-'], {}, {}],
    ['a general grant', ['send', 'lead', 'hi', '--general', 'g.json', '--key', 'k'], {}, {}],
    ['a confined client', ['send', 'lead', 'hi'], { confined: true }, {}],
    ["a client whose folder is not the one it names", ['send', 'lead', 'hi'], { cwd: '/' }, {}],
    ['a different HOME', ['send', 'lead', 'hi'], {}, { env: { HOME: '/nowhere', ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}) } }],
  ];
  for (const [name, argv, peer, req] of cases) {
    test(name, async () => {
      let runs = 0;
      await start(async () => { runs += 1; return 0; }, { reader: reader(peer) });
      const outcome = await line(argv, req);
      expect(outcome.kind).toBe('fallback');
      expect(runs).toBe(0);
    });
  }

  test('another build', async () => {
    let runs = 0;
    await start(async () => { runs += 1; return 0; });
    // The installed build changed after the host started: the client reads the new identity.
    writeFileSync(join(base, 'build-id'), `${'c'.repeat(64)}\n`);
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('fallback');
    expect(runs).toBe(0);
  });

  test('a caller that is not placed as a seat', async () => {
    let runs = 0;
    await start(async () => { runs += 1; return 0; }, {
      callerSources: () => ({ ancestors: () => [{ pid: 9, name: 'zsh' }], agents: () => [], paneRootPid: () => null, env: {}, stdinIsTTY: true }),
    });
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('fallback');
    expect(runs).toBe(0);
  });

  test('a uid that is not the host\'s is closed, and nothing runs', async () => {
    let runs = 0;
    await start(async () => { runs += 1; return 0; }, { reader: reader({ uid: 4_000_000 }) });
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('ambiguous');
    expect(runs).toBe(0);
  });
});

describe('the queue', () => {
  test('a request past the queue window is removed before its answer and never runs', async () => {
    const hold = gate();
    const ran: string[] = [];
    await start(async (argv) => { ran.push(argv[2]!); if (argv[2] === 'first') await hold.wait; return 0; }, { queueWindowMs: 150 });
    const first = line(['send', 'lead', 'first']);
    await Bun.sleep(30);
    const second = await line(['send', 'lead', 'second']);
    expect(second.kind).toBe('fallback');
    hold.open();
    expect((await first).kind).toBe('ran');
    await Bun.sleep(50);
    expect(ran).toEqual(['first']);
  });

  test('a frame from a process other than the one that connected is handed back and never runs (pid reuse)', async () => {
    let runs = 0;
    let start2 = 2n;
    const swapping: PeerReader = { ...reader(), process: () => ({ ppid: process.ppid, uid: process.getuid!(), startSec: 1n, startUsec: start2 }) };
    await start(async () => { runs += 1; return 0; }, { reader: swapping });
    const { connect } = await import('node:net');
    const client = connect(join(base, 'h.sock'));
    await new Promise<void>((settle) => client.once('connect', () => settle()));
    await Bun.sleep(30);
    // The pid now names a process that started later: the connecting one is gone.
    start2 = 3n;
    const env: Record<string, string> = {};
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
    let reply = '';
    client.setEncoding('utf8');
    client.on('data', (chunk: string) => { reply += chunk; });
    client.write(`${JSON.stringify({ v: 1, build: buildStampOf(cliEntry), argv: ['send', 'lead', 'x'], cwd: base, env, tty: { stdin: false, stdout: false, stderr: false } })}\n`);
    await new Promise<void>((settle) => client.once('close', () => settle()));
    expect(JSON.parse(reply.trim())).toEqual({ v: 1, kind: 'fallback', why: 'the client is not the process that connected' });
    expect(runs).toBe(0);
  });

  test('a client that leaves while queued is removed and never runs', async () => {
    const hold = gate();
    const ran: string[] = [];
    await start(async (argv) => { ran.push(argv[2]!); if (argv[2] === 'first') await hold.wait; return 0; });
    const first = line(['send', 'lead', 'first']);
    await Bun.sleep(30);
    const { connect } = await import('node:net');
    const gone = connect(join(base, 'h.sock'));
    await new Promise<void>((settle) => gone.once('connect', () => settle()));
    const env: Record<string, string> = {};
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
    gone.write(`${JSON.stringify({ v: 1, build: buildStampOf(cliEntry), argv: ['send', 'lead', 'left'], cwd: base, env, tty: { stdin: false, stdout: false, stderr: false } })}\n`);
    await Bun.sleep(30);
    gone.destroy();
    await Bun.sleep(30);
    hold.open();
    expect((await first).kind).toBe('ran');
    await Bun.sleep(50);
    expect(ran).toEqual(['first']);
  });

  test('a client that leaves while running does not cancel it', async () => {
    const hold = gate();
    let finished = 0;
    await start(async () => { await hold.wait; finished += 1; return 0; });
    const { connect } = await import('node:net');
    const gone = connect(join(base, 'h.sock'));
    await new Promise<void>((settle) => gone.once('connect', () => settle()));
    const env: Record<string, string> = {};
    if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
    if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
    gone.write(`${JSON.stringify({ v: 1, build: buildStampOf(cliEntry), argv: ['send', 'lead', 'x'], cwd: base, env, tty: { stdin: false, stdout: false, stderr: false } })}\n`);
    await Bun.sleep(50);
    gone.destroy();
    hold.open();
    await Bun.sleep(80);
    expect(finished).toBe(1);
  });

  test('a recycle hands every queued request back, and lets the running one finish', async () => {
    const hold = gate();
    const ran: string[] = [];
    let stoppedWhy = null as string | null;
    const h = await start(async (argv) => { ran.push(argv[2]!); await hold.wait; return 0; }, { onStop: (why) => { stoppedWhy = why; } });
    const first = line(['send', 'lead', 'first']);
    await Bun.sleep(30);
    const queued = line(['send', 'lead', 'queued']);
    await Bun.sleep(30);
    const closing = h.close('recycle');
    expect((await queued).kind).toBe('fallback');
    hold.open();
    expect((await first).kind).toBe('ran');
    await closing;
    await Bun.sleep(30);
    expect(ran).toEqual(['first']);
    expect(stoppedWhy).toBe('recycle');
    host = null;
  });
});

describe('after submission, never a retry', () => {
  test('a host that closes without an answer is ambiguous', async () => {
    const { createServer } = await import('node:net');
    const path = join(base, 'h.sock');
    const silent = createServer((socket) => { socket.on('data', () => socket.destroy()); });
    await new Promise<void>((settle) => silent.listen(path, () => settle()));
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('ambiguous');
    silent.close();
  });

  test('an answer the client cannot read is ambiguous', async () => {
    const { createServer } = await import('node:net');
    const path = join(base, 'h.sock');
    const odd = createServer((socket) => { socket.on('data', () => socket.end('{"v":1,"kind":"later"}\n')); });
    await new Promise<void>((settle) => odd.listen(path, () => settle()));
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('ambiguous');
    odd.close();
  });

  test('a line that stops after its first effect is an answer with exit 1, not a hand-back', async () => {
    const { hostedCommit, hostedFallbackPoint } = await import('../../src/host/request-scope.ts');
    await start(async () => { hostedCommit('record write'); hostedFallbackPoint('owner rule'); return 0; });
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome.kind).toBe('ran');
    if (outcome.kind === 'ran') {
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain('after it began (record write)');
    }
  });

  test('a fallback point before any effect is a hand-back', async () => {
    const { hostedFallbackPoint } = await import('../../src/host/request-scope.ts');
    await start(async () => { hostedFallbackPoint('charter'); return 0; });
    const outcome = await line(['send', 'lead', 'hi']);
    expect(outcome).toEqual({ kind: 'fallback', why: 'charter' });
  });
});
