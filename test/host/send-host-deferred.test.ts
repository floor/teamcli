// Deferred callbacks in the warm send host (rfc-bus-send-server §2.4): work a hosted line leaves
// running after its command returns is waited for (bounded at 200 ms) while the request's
// environment still holds, and work still pending past the bound makes the host recycle. The
// audit: the send path's only fire-and-forget continuation (the late webhook) is registered.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFERRED_WAIT_MS, deferHosted, settleHostedDeferred } from '../../src/host/request-scope.ts';
import { runHostedLine, type HostRequest } from '../../src/host/run.ts';
import type { Io } from '../../src/io.ts';

const sources: Io['callerSources'] = () => ({
  ancestors: () => [{ pid: 101, name: 'claude' }, { pid: 100, name: 'herdr' }],
  agents: () => [{ name: 'builder', pane: 'w1:p1', agent: 'claude', workspace: 'w1', status: 'idle' as const, cwd: null }],
  paneRootPid: () => 101,
  env: { HERDR_PANE_ID: 'w1:p1' },
  stdinIsTTY: false,
});

const vars = process.env;

function ownEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;
  return env;
}

function request(env: Record<string, string>): HostRequest {
  return { v: 1, build: 'test', argv: ['send', 'lead', 'hi'], cwd: process.cwd(), env, tty: { stdin: false, stdout: false, stderr: false } };
}

const peer = { pid: process.pid, ppid: process.ppid, check: () => null, currentParent: () => process.ppid };

test('outside the host a deferred registration is a no-op', async () => {
  deferHosted(new Promise(() => {}));
  expect(await settleHostedDeferred(5)).toBe(0);
});

test('work that settles within the bound still sees the request environment, and the host does not recycle', async () => {
  const env = { ...ownEnv(), TEAM_DEFERRED_PROBE: 'request' };
  let seen: string | undefined;
  const result = await runHostedLine(request(env), peer, {
    cliEntry: 'cli.js',
    ownEnv: ownEnv(),
    callerSources: sources,
    main: async () => {
      deferHosted(new Promise<void>((settle) => setTimeout(() => { seen = vars.TEAM_DEFERRED_PROBE; settle(); }, 20)));
      return 0;
    },
  });
  expect(result.answer.kind).toBe('ran');
  expect(seen).toBe('request');
  expect(result.recycle).toBeNull();
  expect(vars.TEAM_DEFERRED_PROBE).toBeUndefined();
});

test('work still pending past the bound makes the host recycle after answering', async () => {
  const started = Date.now();
  // Pending past the bound, and released once the recycle is seen: the real host exits here, but
  // this suite shares one process with later hosted-request files, which must not inherit it.
  let release: () => void = () => {};
  const pending = new Promise<void>((settle) => { release = settle; });
  try {
    const result = await runHostedLine(request(ownEnv()), peer, {
      cliEntry: 'cli.js',
      ownEnv: ownEnv(),
      callerSources: sources,
      main: async () => { deferHosted(pending); return 0; },
    });
    expect(result.answer).toMatchObject({ kind: 'ran', code: 0 });
    expect(result.recycle).toContain('deferred callback');
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(DEFERRED_WAIT_MS - 5);
    expect(took).toBeLessThan(DEFERRED_WAIT_MS + 500);
  } finally {
    release();
    await pending;
  }
  expect(await settleHostedDeferred(50)).toBe(0);
});

test('the audit: the send path\'s one fire-and-forget continuation is registered with the host', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'src', 'commands', 'send.ts'), 'utf8');
  expect(source).toContain('deferHosted(posted.late.then(');
  expect(source).not.toMatch(/void posted\.late\.then/);
});

test('deferred work drains inside the request: the hosted scope and the guard still hold, and a write after a fallback is blocked', async () => {
  const { hostedCommit, hostedFallbackPoint, hostedRequest } = await import('../../src/host/request-scope.ts');
  let scoped: unknown = 'unset';
  let wrote = false;
  const result = await runHostedLine(request(ownEnv()), peer, {
    cliEntry: 'cli.js',
    ownEnv: ownEnv(),
    callerSources: sources,
    main: async () => {
      try { hostedFallbackPoint('owner rule'); } catch { /* the command swallowed it */ }
      deferHosted(new Promise<void>((settle) => setTimeout(() => {
        scoped = hostedRequest();
        try { hostedCommit('late write'); wrote = true; } catch { /* blocked */ }
        settle();
      }, 10)));
      return 0;
    },
  });
  expect(scoped).not.toBeNull();
  expect(wrote).toBe(false);
  expect(result.answer).toEqual({ v: 1, kind: 'fallback', why: 'owner rule' });
});

test('a stop a command caught is still reported as a stopped line with exit 1', async () => {
  const { hostedCommit, hostedFallbackPoint } = await import('../../src/host/request-scope.ts');
  const result = await runHostedLine(request(ownEnv()), peer, {
    cliEntry: 'cli.js',
    ownEnv: ownEnv(),
    callerSources: sources,
    main: async () => {
      hostedCommit('record write');
      try { hostedFallbackPoint('owner rule'); } catch { /* swallowed */ }
      return 0;
    },
  });
  expect(result.answer).toMatchObject({ kind: 'ran', code: 1 });
  if (result.answer.kind === 'ran') expect(result.answer.stderr).toContain('after it began (record write)');
});
