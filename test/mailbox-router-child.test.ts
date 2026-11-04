import { describe, expect, test } from 'bun:test';
import {
  createMailboxRouter,
  type MailboxChild,
  type MailboxChildEvent,
  type MailboxHostMessage,
} from '../src/daemon/mailbox/supervisor.ts';

type Fake = {
  child: MailboxChild;
  sends: MailboxHostMessage[];
  kills: string[];
  emit(event: MailboxChildEvent): void;
  leave(code?: number | null, signal?: NodeJS.Signals | null): void;
};

function fakeChild(pid: number): Fake {
  const listeners = new Set<(event: MailboxChildEvent) => void>();
  let settle: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const sends: MailboxHostMessage[] = [];
  const kills: string[] = [];
  let alive = true;
  const child: MailboxChild = {
    pid,
    get alive() {
      return alive;
    },
    send(message) {
      if (!alive) throw new Error('a beat was written to a child that left');
      sends.push(message);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    kill(why) {
      kills.push(why);
    },
    exited,
  };
  return {
    child,
    sends,
    kills,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    leave(code = null, signal = 'SIGTERM') {
      alive = false;
      for (const listener of [...listeners]) listener({ kind: 'exit', code, signal });
      settle();
    },
  };
}

describe('the mailbox router child', () => {
  test('a beat starts it, a heartbeat marks it ok, and the beat does not wait', () => {
    const clock = { at: new Date('2026-11-04T00:00:00Z') };
    const children: Fake[] = [];
    const router = createMailboxRouter({
      beatMs: 5_000,
      now: () => clock.at,
      log: () => {},
      factory: () => {
        const fake = fakeChild(40 + children.length);
        children.push(fake);
        return fake.child;
      },
    });
    expect(router.tick(clock.at)).toBeUndefined();
    expect(router.state()).toMatchObject({ state: 'starting', pid: 40, restarts: 0 });
    expect(router.health()).toEqual({ ok: true });
    children[0]?.emit({ kind: 'message', message: { type: 'heartbeat', at: clock.at.toISOString() } });
    expect(router.state().state).toBe('ok');
    children[0]?.emit({
      kind: 'message',
      message: {
        type: 'ask-result',
        result: { seat: 'iris@floor', wakeTaken: true, replyVerified: true },
      },
    });
    expect(router.state().lastAsk).toEqual({
      seat: 'iris@floor',
      wakeTaken: true,
      replyVerified: true,
    });
  });

  test('the child exiting is late, the probe still answers, and a later beat starts it again', () => {
    const clock = { at: new Date('2026-11-04T00:00:00Z') };
    const children: Fake[] = [];
    const notes: string[] = [];
    const router = createMailboxRouter({
      beatMs: 5_000,
      now: () => clock.at,
      log: (text) => {
        notes.push(text);
      },
      backoffCapMs: 30_000,
      factory: () => {
        const fake = fakeChild(50 + children.length);
        children.push(fake);
        return fake.child;
      },
    });
    router.tick(clock.at);
    children[0]?.emit({ kind: 'message', message: { type: 'heartbeat', at: clock.at.toISOString() } });
    children[0]?.leave(1, null);
    expect(router.state()).toMatchObject({ state: 'late', pid: null, restarts: 1 });
    expect(router.state().why).toContain('exited with code 1');
    expect(router.health()).toEqual({ ok: true });
    clock.at = new Date(clock.at.getTime() + 999);
    router.tick(clock.at);
    expect(children).toHaveLength(1);
    clock.at = new Date(clock.at.getTime() + 1);
    router.tick(clock.at);
    expect(children).toHaveLength(2);
    expect(router.state()).toMatchObject({ state: 'starting', pid: 51 });
    expect(notes.some((line) => line.includes('starting a replacement'))).toBe(true);
  });

  test('a child that stops beating is ended, and the beat still returns', () => {
    const clock = { at: new Date('2026-11-04T00:00:00Z') };
    const children: Fake[] = [];
    const router = createMailboxRouter({
      beatMs: 1_000,
      missedBeats: 2,
      now: () => clock.at,
      log: () => {},
      factory: () => {
        const fake = fakeChild(70);
        children.push(fake);
        return fake.child;
      },
    });
    router.tick(clock.at);
    for (let step = 0; step < 2; step += 1) {
      clock.at = new Date(clock.at.getTime() + 1_000);
      expect(router.tick(clock.at)).toBeUndefined();
    }
    expect(children[0]?.kills).toEqual([]);
    clock.at = new Date(clock.at.getTime() + 1_000);
    router.tick(clock.at);
    expect(children[0]?.kills).toEqual(['the child missed 2 heartbeats']);
    expect(router.state().state).toBe('late');
    expect(router.health()).toEqual({ ok: true });
  });
});
