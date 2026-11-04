import { describe, expect, test } from 'bun:test';
import { askMailbox, type MailboxAskInput, type MailboxAskLedger, type MailboxReplyRead, type MailboxSendResult } from '../src/daemon/mailbox/ask.ts';
import { MAILBOX_ROUTER_DEFAULTS, type MailboxRouterPolicy } from '../src/daemon/mailbox/policy.ts';

type Sent = { principal: string; to: string; body: string };

function scene(over: {
  alias?: string;
  askId?: string;
  caller?: MailboxAskInput['caller'];
  policy?: MailboxRouterPolicy;
  unreadWindowSeconds?: number;
  principal?: string;
  send?: MailboxAskInput['send'];
  replyAt?: (at: number) => MailboxReplyRead;
} = {}) {
  const clock = { at: 0 };
  const sends: Sent[] = [];
  const mailbox: { principal: string; messageId: string; bytes: string }[] = [];
  const syncAt: { at: number; kind: string }[] = [];
  const typed = { n: 0 };
  const replyAt = over.replyAt ?? (() => ({ verified: true as const, bytes: 'the answer' }));
  const send = over.send ?? (async (item: Sent): Promise<MailboxSendResult> => {
    sends.push(item);
    return { ok: true, messageId: `m-${String(sends.length)}`, woken: true };
  });
  const input: MailboxAskInput = {
    askId: over.askId ?? 'ask-1',
    alias: over.alias ?? 'iris',
    body: 'hello',
    principal: over.principal ?? 'grok-bot',
    caller: over.caller ?? 'client',
    policy: over.policy ?? MAILBOX_ROUTER_DEFAULTS,
    unreadWindowSeconds: over.unreadWindowSeconds ?? 30,
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
    },
    send,
    readReply: () => replyAt(clock.at),
    writeMailbox: (item) => {
      mailbox.push(item);
    },
    onSync: (sync) => {
      syncAt.push({ at: clock.at, kind: sync.kind });
    },
    typeText: () => {
      typed.n += 1;
      return true;
    },
  };
  return { clock, sends, mailbox, syncAt, typed, input };
}

describe('an alias ask', () => {
  test('iris writes one drop to iris@floor and types nothing', async () => {
    const ledger: MailboxAskLedger = new Map();
    const world = scene();
    const result = await askMailbox(ledger, world.input);
    expect(world.sends).toEqual([{ principal: 'grok-bot', to: 'iris@floor', body: 'hello' }]);
    expect(result.sync).toEqual({ kind: 'reply', bytes: 'the answer', messageId: 'm-1' });
    expect(result.mailbox).toEqual({ messageId: 'm-1', bytes: 'the answer' });
    expect(world.typed.n).toBe(0);
    expect(result.wakeTaken).toBe(true);
  });

  test('atlas writes one drop to orchestrator@floor', async () => {
    const world = scene({ alias: 'atlas', principal: 'owner' });
    await askMailbox(new Map(), world.input);
    expect(world.sends).toEqual([{ principal: 'owner', to: 'orchestrator@floor', body: 'hello' }]);
  });

  test('a definite miss follows the fallback once, and a taken wake does not', async () => {
    const missed: Sent[] = [];
    const miss = scene({
      alias: 'atlas',
      askId: 'miss',
      send: async (item) => {
        missed.push(item);
        return { ok: true, messageId: `m-${String(missed.length)}`, woken: missed.length > 1 };
      },
    });
    const missedResult = await askMailbox(new Map(), miss.input);
    expect(missed.map((item) => item.to)).toEqual(['orchestrator@floor', 'iris@floor']);
    expect(missedResult.seat).toBe('iris@floor');
    expect(missedResult.sync).toMatchObject({ kind: 'reply', messageId: 'm-2' });

    const taken: Sent[] = [];
    const held = scene({
      alias: 'atlas',
      askId: 'taken',
      send: async (item) => {
        taken.push(item);
        return { ok: true, messageId: 'm-taken', woken: true };
      },
    });
    await askMailbox(new Map(), held.input);
    expect(taken.map((item) => item.to)).toEqual(['orchestrator@floor']);
  });

  test('a verified reply is returned and recorded; a failed one returns nothing and is not retried', async () => {
    const bad = scene({
      askId: 'bad',
      replyAt: () => ({ verified: false }),
    });
    const ledger: MailboxAskLedger = new Map();
    const result = await askMailbox(ledger, bad.input);
    expect(result.sync).toEqual({ kind: 'unanswered', messageId: 'm-1' });
    expect(result.mailbox).toBeNull();
    expect(result.replyVerified).toBe(false);
    await askMailbox(ledger, bad.input);
    expect(bad.sends).toHaveLength(1);
  });

  test('the same ask id does not write a second drop', async () => {
    const ledger: MailboxAskLedger = new Map();
    const world = scene();
    await askMailbox(ledger, world.input);
    await askMailbox(ledger, { ...world.input, body: 'again' });
    expect(world.sends).toHaveLength(1);
  });

  test('a bridge call hears not answered yet at 120s, and the reply still lands in the mailbox', async () => {
    const world = scene({
      caller: 'bridge',
      unreadWindowSeconds: 90,
      replyAt: (at) => (at >= 150_000 ? { verified: true, bytes: 'late' } : null),
    });
    const result = await askMailbox(new Map(), world.input);
    expect(world.syncAt[0]).toEqual({ at: 120_000, kind: 'not-yet' });
    expect(result.sync).toEqual({ kind: 'not-yet', messageId: 'm-1', line: 'not answered yet' });
    expect(result.mailbox).toEqual({ messageId: 'm-1', bytes: 'late' });
    expect(world.sends).toHaveLength(1);
    expect(world.typed.n).toBe(0);
  });

  test('a desk target is refused before a send', async () => {
    const policy: MailboxRouterPolicy = {
      routes: [{ alias: 'iris', address: 'desk@floor', fallback: null }],
      replyBoundSeconds: null,
    };
    const world = scene({ policy });
    const result = await askMailbox(new Map(), world.input);
    expect(result.sync).toEqual({
      kind: 'refused',
      why: 'iris names the desk seat, which is not a route',
    });
    expect(world.sends).toHaveLength(0);
  });
});
