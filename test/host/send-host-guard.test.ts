// The hosted guard (src/host/request-scope.ts): a fallback point hands a line back only while it
// has done nothing; after its first effect the line stops and is never handed back; once a
// fallback point fired, no effect may follow even when the command caught the throw; the first
// effect checks the client again; and outside the host every call is a no-op.
import { describe, expect, test } from 'bun:test';
import {
  armHostedGuard,
  disarmHostedGuard,
  HostedFallback,
  hostedCommit,
  hostedFallbackPoint,
  HostedStoppedAfterEffect,
  hostedRequest,
  runAsHostedRequest,
} from '../../src/host/request-scope.ts';

const scope = { peerPid: 4242, startPid: 4241, currentParent: () => 4241 };

async function hosted<T>(fn: () => T, check: () => string | null = () => null): Promise<{ value?: T; error?: unknown; guard: ReturnType<typeof disarmHostedGuard> }> {
  armHostedGuard(check);
  try {
    const value = await runAsHostedRequest(scope, async () => fn());
    return { value, guard: disarmHostedGuard() };
  } catch (error) {
    return { error, guard: disarmHostedGuard() };
  }
}

describe('the hosted guard', () => {
  test('outside the host every call is a no-op', () => {
    expect(hostedRequest()).toBeNull();
    expect(() => hostedFallbackPoint('x')).not.toThrow();
    expect(() => hostedCommit('write')).not.toThrow();
  });

  test('a fallback point before any effect hands the line back', async () => {
    const run = await hosted(() => hostedFallbackPoint('charter'));
    expect(run.error).toBeInstanceOf(HostedFallback);
    expect(run.guard).toEqual({ first: null, fellBack: 'charter' });
  });

  test('a fallback point after an effect stops the line and is never a hand-back', async () => {
    const run = await hosted(() => {
      hostedCommit('record write');
      hostedFallbackPoint('owner rule');
    });
    expect(run.error).toBeInstanceOf(HostedStoppedAfterEffect);
    expect(run.guard.first).toBe('record write');
  });

  test('a caught fallback point still blocks every later effect', async () => {
    const run = await hosted(() => {
      try { hostedFallbackPoint('caught'); } catch { /* a command that swallows errors */ }
      hostedCommit('delivery');
    });
    expect(run.error).toBeInstanceOf(HostedFallback);
    expect(run.guard).toEqual({ first: null, fellBack: 'caught' });
  });

  test('a caught stop after the first effect is latched: no later effect, and the line still reads stopped', async () => {
    let second = false;
    const run = await hosted(() => {
      hostedCommit('record write');
      try { hostedFallbackPoint('owner rule'); } catch { /* a command that swallows errors */ }
      try { hostedCommit('delivery'); second = true; } catch { /* blocked */ }
      try { hostedFallbackPoint('another'); } catch { /* still the same stop */ }
      return 'returned normally';
    });
    expect(second).toBe(false);
    expect(run.value).toBe('returned normally');
    expect(run.guard.stopped).toBeInstanceOf(HostedStoppedAfterEffect);
    expect(run.guard.stopped?.why).toBe('owner rule');
  });

  test('the first effect checks the client again and fails closed when it changed', async () => {
    let checks = 0;
    const run = await hosted(() => {
      hostedCommit('first');
      hostedCommit('second');
    }, () => { checks += 1; return 'the client is gone'; });
    expect(run.error).toBeInstanceOf(HostedFallback);
    expect(checks).toBe(1);
    expect(run.guard.first).toBeNull();
  });

  test('a client that still holds is checked once, at the first effect only', async () => {
    let checks = 0;
    const run = await hosted(() => {
      hostedCommit('first');
      hostedCommit('second');
      return 'done';
    }, () => { checks += 1; return null; });
    expect(run.value).toBe('done');
    expect(checks).toBe(1);
    expect(run.guard.first).toBe('first');
  });

  test('requests never nest', async () => {
    await runAsHostedRequest(scope, async () => {
      await expect(runAsHostedRequest(scope, async () => 1)).rejects.toThrow('already running');
    });
    expect(hostedRequest()).toBeNull();
  });
});
