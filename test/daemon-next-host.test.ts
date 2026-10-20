import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMachineDaemon, type NextPrincipalVerdict } from '../src/daemon/host.ts';
import type { NextAnswer, NextClaim, NextHandlerInput } from '../src/daemon/next.ts';
import { answerDaemonRequest, parseDaemonRequest, type DaemonHealthSnapshot } from '../src/daemon/protocol.ts';
import { daemonSocketPath } from '../src/daemon/paths.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const NEXT_REFUSAL =
  'next: mutating daemon requests are not accepted until a verified principal binding is implemented; nothing was done';

const snapshot: DaemonHealthSnapshot = {
  pid: process.pid,
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  since: '2026-10-20T10:00:00.000Z',
  startedBy: 'service-manager',
  version: '0.5.3-daemon-test',
  heartbeatAt: '2026-10-20T11:59:30.000Z',
  stuck: [],
  features: { broker: 'absent' },
};

const bases: string[] = [];

function scratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-next-host-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function request(socketPath: string, body: unknown): Promise<Record<string, unknown>> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on('error', reject);
  });
}

function fullScope(root: string, overrides: Record<string, string> = {}): Record<string, string> {
  return { root, team: 'acme', session: 'acme', seat: 'clerk', pane: 'pane-7', ...overrides };
}

describe('the next boundary wire: v2 keeps the pane, v1 does not', () => {
  test('a v2 scope carries the pane and the dispatch fields; a v1 scope strips them', () => {
    const v2 = parseDaemonRequest(
      JSON.stringify({
        v: 2,
        id: 'n2',
        op: 'next',
        scope: { root: '/tmp/x', team: 'acme', session: 'acme', seat: 'clerk', pane: 'pane-7' },
        action: 'release',
        mine: true,
      }),
    );
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.request).toEqual({
      v: 2,
      id: 'n2',
      op: 'next',
      scope: { root: '/tmp/x', team: 'acme', session: 'acme', seat: 'clerk', pane: 'pane-7' },
      action: 'release',
      mine: true,
    });

    const v1 = parseDaemonRequest(
      JSON.stringify({
        v: 1,
        id: 'n1',
        op: 'next',
        scope: { root: '/tmp/x', seat: 'clerk', pane: 'pane-7' },
        action: 'release',
        mine: true,
      }),
    );
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.request.scope).toEqual({ root: '/tmp/x', seat: 'clerk' });
    expect(v1.request).not.toHaveProperty('action');
    expect(v1.request).not.toHaveProperty('mine');
  });

  test('a malformed v2 dispatch field is a bad frame and an unknown version is refused', () => {
    for (const body of [
      { v: 2, id: 'a', op: 'next', action: 'take' },
      { v: 2, id: 'a', op: 'next', mine: 'yes' },
      { v: 2, id: 'a', op: 'next', scope: { root: '/tmp/x', pane: 7 } },
      { v: 3, id: 'a', op: 'health' },
    ]) {
      expect(parseDaemonRequest(JSON.stringify(body))).toMatchObject({ ok: false, error: { code: 'daemon.bad-frame' } });
    }
    // A v1 frame keeps its old reading even when it carries a v2 field badly.
    expect(parseDaemonRequest(JSON.stringify({ v: 1, id: 'a', op: 'health', action: 'take', mine: 'yes' }))).toMatchObject({
      ok: true,
    });
  });

  test('an answer echoes the version it answers, and the default next refusal is unchanged', () => {
    const v1 = parseDaemonRequest(JSON.stringify({ v: 1, id: 'h1', op: 'health' }));
    const v2 = parseDaemonRequest(JSON.stringify({ v: 2, id: 'h2', op: 'health' }));
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(answerDaemonRequest(v1.request, snapshot)).toMatchObject({ v: 1, id: 'h1', ok: true });
    expect(answerDaemonRequest(v2.request, snapshot)).toMatchObject({ v: 2, id: 'h2', ok: true });

    const next = parseDaemonRequest(JSON.stringify({ v: 2, id: 'n', op: 'next', scope: fullScope('/tmp/x') }));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(answerDaemonRequest(next.request, snapshot)).toEqual({
      v: 2,
      id: 'n',
      ok: false,
      error: { code: 'daemon.auth-unsupported', message: NEXT_REFUSAL },
    });
  });
});

describe('one machine daemon: the next boundary refuses until a verified principal is wired', () => {
  test('a v2 next with no verifier and no handler is refused exactly like a v1 one', async () => {
    const { root, home } = scratch();
    const started = await startMachineDaemon({ home, roots: [root], version: 'test', heartbeatMs: 10_000 });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const machine = daemonSocketPath(home);
      for (const version of [1, 2]) {
        const answer = await request(machine, { v: version, id: `n${version}`, op: 'next', scope: fullScope(root) });
        expect(answer).toEqual({
          v: version,
          id: `n${version}`,
          ok: false,
          error: { code: 'daemon.auth-unsupported', message: NEXT_REFUSAL },
        });
      }
    } finally {
      await started.daemon.close();
    }
  });

  test('a handler without a verifier still refuses and is never called', async () => {
    const { root, home } = scratch();
    const calls: NextHandlerInput[] = [];
    const started = await startMachineDaemon({
      home,
      roots: [root],
      version: 'test',
      heartbeatMs: 10_000,
      nextHandler: async (input) => {
        calls.push(input);
        return { ok: true, kind: 'none', why: 'nothing-takeable' };
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const answer = await request(daemonSocketPath(home), { v: 2, id: 'n', op: 'next', scope: fullScope(root) });
      expect(answer).toMatchObject({ ok: false, error: { code: 'daemon.auth-unsupported', message: NEXT_REFUSAL } });
      expect(calls).toEqual([]);
    } finally {
      await started.daemon.close();
    }
  });
});

describe('one machine daemon: a proved next request reaches the handler on its route', () => {
  test('the handler gets the loaded team, the claimed pane and the host clock; only a proved match dispatches', async () => {
    const { root, home } = scratch();
    const calls: NextHandlerInput[] = [];
    const proved: NextClaim[] = [];
    const answers: NextAnswer[] = [];
    const nextPrincipal = ({ claim }: { claim: NextClaim }): NextPrincipalVerdict => {
      proved.push(claim);
      if (claim.pane === 'pane-2') return { kind: 'verified', seat: claim.seat, pane: 'pane-1' };
      if (claim.pane === 'pane-3') return { kind: 'refused', why: 'the pane is not attached to a registered seat' };
      return { kind: 'verified', seat: claim.seat, pane: claim.pane };
    };
    const started = await startMachineDaemon({
      home,
      roots: [root],
      version: 'test',
      heartbeatMs: 10_000,
      nextPrincipal,
      nextHandler: async (input) => {
        calls.push(input);
        if (input.caller.pane === 'pane-4') throw new Error('the lease could not be written');
        const answer: NextAnswer = { ok: true, kind: 'none', why: 'nothing-takeable' };
        answers.push(answer);
        return answer;
      },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const machine = daemonSocketPath(home);

      const served = await request(machine, {
        v: 2,
        id: 'served',
        op: 'next',
        scope: fullScope(root),
        action: 'release',
        mine: true,
      });
      expect(served).toEqual({ v: 2, id: 'served', ok: true, next: answers[0] as NextAnswer });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        route: { root, team: 'acme', session: 'acme' },
        team: { project: 'acme', session: 'acme' },
        caller: { seat: 'clerk', pane: 'pane-7' },
        action: 'release',
        mine: true,
      });
      expect(typeof calls[0]?.now).toBe('number');

      // A v1 frame never reaches the boundary, even with both seams wired.
      const v1 = await request(machine, { v: 1, id: 'v1', op: 'next', scope: fullScope(root) });
      expect(v1).toEqual({
        v: 1,
        id: 'v1',
        ok: false,
        error: { code: 'daemon.auth-unsupported', message: NEXT_REFUSAL },
      });

      // A scope that names another folder never reaches the verifier.
      const provedBefore = proved.length;
      const elsewhere = await request(machine, {
        v: 2,
        id: 'elsewhere',
        op: 'next',
        scope: fullScope(home),
      });
      expect(elsewhere).toMatchObject({ v: 2, ok: false, error: { code: 'daemon.scope-mismatch' } });
      expect(proved).toHaveLength(provedBefore);

      // A seat the route does not declare is a scope mismatch, not a proof question.
      const outsider = await request(machine, {
        v: 2,
        id: 'outsider',
        op: 'next',
        scope: fullScope(root, { seat: 'outsider' }),
      });
      expect(outsider).toMatchObject({ v: 2, ok: false, error: { code: 'daemon.scope-mismatch' } });
      expect(proved).toHaveLength(provedBefore);

      // A proof of a different pane is refused and dispatches nothing.
      const mismatched = await request(machine, {
        v: 2,
        id: 'mismatched',
        op: 'next',
        scope: fullScope(root, { pane: 'pane-2' }),
      });
      expect(mismatched).toEqual({
        v: 2,
        id: 'mismatched',
        ok: false,
        error: {
          code: 'daemon.auth-unsupported',
          message: 'next: the verified principal does not match the seat and pane the request claimed; nothing was done',
        },
      });

      // A refused proof names its own why and dispatches nothing.
      const refused = await request(machine, {
        v: 2,
        id: 'refused',
        op: 'next',
        scope: fullScope(root, { pane: 'pane-3' }),
      });
      expect(refused).toEqual({
        v: 2,
        id: 'refused',
        ok: false,
        error: {
          code: 'daemon.auth-unsupported',
          message: 'next: the pane is not attached to a registered seat; nothing was done',
        },
      });
      expect(calls).toHaveLength(1);

      // A handler failure is internal and says the state it reached is unknown.
      const failed = await request(machine, {
        v: 2,
        id: 'failed',
        op: 'next',
        scope: fullScope(root, { pane: 'pane-4' }),
      });
      expect(failed).toMatchObject({
        v: 2,
        id: 'failed',
        ok: false,
        error: { code: 'daemon.internal', message: expect.stringContaining('the lease could not be written') },
      });
      expect(calls).toHaveLength(2);
    } finally {
      await started.daemon.close();
    }
  });
});
