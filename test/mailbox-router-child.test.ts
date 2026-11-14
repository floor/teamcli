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
        result: { seat: 'lead@acme', wakeTaken: true, replyVerified: true },
      },
    });
    expect(router.state().lastAsk).toEqual({
      seat: 'lead@acme',
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

  test('a late daemon beat is not a missed heartbeat: a child that answers every tick is kept', () => {
    // The 2026-11-14 field trace: on a loaded machine the daemon's beat came 10–48 s apart on a
    // 5 s cadence, and every such gap ended a child that had answered every tick it was sent.
    const clock = { at: new Date('2026-11-14T15:00:00Z') };
    const children: Fake[] = [];
    const router = createMailboxRouter({
      beatMs: 5_000,
      now: () => clock.at,
      log: () => {},
      factory: () => {
        const fake = fakeChild(80 + children.length);
        children.push(fake);
        return fake.child;
      },
    });
    router.tick(clock.at);
    for (const gap of [5_000, 26_453, 47_929, 5_000, 19_886, 12_232]) {
      clock.at = new Date(clock.at.getTime() + gap);
      router.tick(clock.at);
      // The child answers the tick it was just sent, as the real child does at once.
      children[0]?.emit({ kind: 'message', message: { type: 'heartbeat', at: clock.at.toISOString() } });
      expect(router.state().state).toBe('ok');
    }
    expect(children).toHaveLength(1);
    expect(children[0]?.kills).toEqual([]);
    expect(children[0]?.sends).toHaveLength(6);
  });

  test('a child that answers nothing is ended after two unanswered ticks, however late the beats', () => {
    const clock = { at: new Date('2026-11-14T15:00:00Z') };
    const children: Fake[] = [];
    const router = createMailboxRouter({
      beatMs: 5_000,
      now: () => clock.at,
      log: () => {},
      factory: () => {
        const fake = fakeChild(90);
        children.push(fake);
        return fake.child;
      },
    });
    router.tick(clock.at);
    clock.at = new Date(clock.at.getTime() + 30_000);
    router.tick(clock.at);
    clock.at = new Date(clock.at.getTime() + 30_000);
    router.tick(clock.at);
    expect(children[0]?.kills).toEqual([]);
    expect(router.state().state).toBe('starting');
    clock.at = new Date(clock.at.getTime() + 30_000);
    router.tick(clock.at);
    expect(children[0]?.kills).toEqual(['the child missed 2 heartbeats']);
    expect(children[0]?.sends).toHaveLength(2);
  });

  test('a burst of beats does not end a child before two beat intervals have passed', () => {
    const clock = { at: new Date('2026-11-14T15:00:00Z') };
    const children: Fake[] = [];
    const router = createMailboxRouter({
      beatMs: 5_000,
      now: () => clock.at,
      log: () => {},
      factory: () => {
        const fake = fakeChild(95);
        children.push(fake);
        return fake.child;
      },
    });
    router.tick(clock.at);
    children[0]?.emit({ kind: 'message', message: { type: 'heartbeat', at: clock.at.toISOString() } });
    // Three beats inside one second: three ticks, none answered yet, and not enough time to.
    for (let step = 0; step < 4; step += 1) {
      clock.at = new Date(clock.at.getTime() + 300);
      router.tick(clock.at);
    }
    expect(children[0]?.kills).toEqual([]);
    expect(router.state().state).toBe('late');
    children[0]?.emit({ kind: 'message', message: { type: 'heartbeat', at: clock.at.toISOString() } });
    expect(router.state().state).toBe('ok');
  });
});
