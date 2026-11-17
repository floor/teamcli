// 17 Nov: a relaunched Codex seat opened on "This conversation is open in another app" because an
// app-server (Codex's shared daemon, or the seat's previous endpoint) still had the conversation
// loaded; an app-server keeps it about sixty seconds after its last client leaves. The relaunch
// now waits, read-only, until no such app-server lists it, and exits the lock screen by its key.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codexThreadLockedScreen, waitCodexThreadFree, type RpcCall } from '../src/launch/codex-thread-release.ts';

const ID = '01a1e8c7-3dd8-7cb3-adf9-424a59f8059d';
const LOCKED = readFileSync(new URL('./fixtures/codex/0.167.0/thread-locked.txt', import.meta.url), 'utf8');
const IDLE = readFileSync(new URL('./fixtures/codex/0.167.0/idle.txt', import.meta.url), 'utf8');

/** A fake app-server per socket: each call to thread/loaded/list answers from its script. */
function world(scripts: Record<string, string[][]>) {
  const asked: { socket: string; methods: string[] }[] = [];
  const turn: Record<string, number> = {};
  const rpc = async (socket: string, calls: RpcCall[]) => {
    asked.push({ socket, methods: calls.map((call) => call.method) });
    const script = scripts[socket];
    if (script === undefined) return { ok: false as const, why: 'no socket', replies: [] };
    const at = Math.min(turn[socket] ?? 0, script.length - 1);
    turn[socket] = (turn[socket] ?? 0) + 1;
    return { ok: true as const, replies: [{ ok: true as const, result: { data: script[at], nextCursor: null } }] };
  };
  return { rpc, asked };
}

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

describe('waiting for a Codex conversation to be free', () => {
  test('free at once when no app-server lists it', async () => {
    const w = world({ shared: [['other']], own: [[]] });
    const c = clock();
    expect(await waitCodexThreadFree({ sockets: ['shared', 'own'], threadId: ID, timeoutMs: 120_000, pollMs: 3000, rpc: w.rpc, ...c })).toEqual({ free: true, waitedMs: 0 });
  });

  test('waits while the shared daemon still lists it, then goes', async () => {
    const w = world({ shared: [[ID], [ID], []], own: [[]] });
    const c = clock();
    expect(await waitCodexThreadFree({ sockets: ['shared', 'own'], threadId: ID, timeoutMs: 120_000, pollMs: 3000, rpc: w.rpc, ...c })).toEqual({ free: true, waitedMs: 6000 });
  });

  test('gives up past the bound and names the holder', async () => {
    const w = world({ shared: [[]], own: [[ID]] });
    const c = clock();
    expect(await waitCodexThreadFree({ sockets: ['shared', 'own'], threadId: ID, timeoutMs: 9000, pollMs: 3000, rpc: w.rpc, ...c })).toEqual({ free: false, heldBy: 'own', waitedMs: 9000 });
  });

  test('an app-server with nothing listening holds nothing; an unreadable one counts as holding', async () => {
    const c = clock();
    // `absent`: the socket is not there, or refuses the connection.
    const absent = async () => ({ ok: false as const, why: 'no socket', replies: [], absent: true as const });
    expect((await waitCodexThreadFree({ sockets: ['gone'], threadId: ID, timeoutMs: 9000, pollMs: 3000, rpc: absent, ...c })).free).toBe(true);
    // A timeout, a refusal, or a malformed list is not proof of free (review round 6).
    const failures = [
      async () => ({ ok: false as const, why: 'no answer within 3000 ms', replies: [] }),
      async () => ({ ok: true as const, replies: [{ ok: true as const, result: { data: 'nope' } }] }),
      async () => ({ ok: true as const, replies: [{ ok: true as const, result: { data: [ID.length, 'x'], nextCursor: null } }] }),
    ];
    for (const rpc of failures) {
      const d = clock();
      const got = await waitCodexThreadFree({ sockets: ['own'], threadId: ID, timeoutMs: 9000, pollMs: 3000, rpc, ...d });
      expect(got.free).toBe(false);
      if (!got.free) expect(got.heldBy).toContain('unreadable');
    }
  });

  test('every page is read: the conversation on a later page is held', async () => {
    const pages: Record<string, { data: string[]; nextCursor: string | null }> = {
      '': { data: ['a'], nextCursor: 'p2' },
      p2: { data: ['b', ID], nextCursor: null },
    };
    const rpc = async (_socket: string, calls: RpcCall[]) => {
      const cursor = (calls[0]?.params as { cursor?: string }).cursor ?? '';
      return { ok: true as const, replies: [{ ok: true as const, result: pages[cursor] }] };
    };
    const c = clock();
    const got = await waitCodexThreadFree({ sockets: ['shared'], threadId: ID, timeoutMs: 6000, pollMs: 3000, rpc, ...c });
    expect(got).toEqual({ free: false, heldBy: 'shared', waitedMs: 6000 });
  });

  // Review round 7: paging is charged to the whole bound. Each page here takes two seconds; the
  // app-server answers a page only inside the time it is given, as a real one is cut off.
  test('slow pages never run past the bound, and a late last page does not make it free', async () => {
    let at = 0;
    const given: number[] = [];
    const pages: Record<string, { data: string[]; nextCursor: string | null }> = {
      '': { data: ['a'], nextCursor: 'p2' },
      p2: { data: ['b'], nextCursor: null },
    };
    const rpc = async (_socket: string, calls: RpcCall[], timeoutMs = 3000) => {
      given.push(timeoutMs);
      if (timeoutMs < 2000) { at += timeoutMs; return { ok: false as const, why: `no answer within ${String(timeoutMs)} ms`, replies: [] }; }
      at += 2000;
      const cursor = (calls[0]?.params as { cursor?: string }).cursor ?? '';
      return { ok: true as const, replies: [{ ok: true as const, result: pages[cursor] }] };
    };
    const got = await waitCodexThreadFree({
      sockets: ['shared'], threadId: ID, timeoutMs: 3000, pollMs: 1000, rpc,
      now: () => at, sleep: async (ms) => { at += ms; },
    });
    expect(got.free).toBe(false);
    expect(got.waitedMs).toBeLessThanOrEqual(3000);
    // The second page was given only what was left of the bound.
    expect(given).toEqual([3000, 1000]);
  });

  test('only ever asks which conversations are loaded: nothing is resumed, unsubscribed or unloaded', async () => {
    const w = world({ shared: [[ID], []] });
    const c = clock();
    await waitCodexThreadFree({ sockets: ['shared'], threadId: ID, timeoutMs: 120_000, pollMs: 3000, rpc: w.rpc, ...c });
    expect(new Set(w.asked.flatMap((ask) => ask.methods))).toEqual(new Set(['thread/loaded/list']));
  });
});

describe('the lock screen', () => {
  test('the captured 0.167.0 lock screen is recognised, plain and as the styled read the launch takes', () => {
    expect(codexThreadLockedScreen(LOCKED)).toBe(true);
    const styled = readFileSync(new URL('./fixtures/codex/0.167.0/thread-locked-ansi.txt', import.meta.url), 'utf8');
    expect(styled.includes('\x1b[')).toBe(true);
    expect(codexThreadLockedScreen(styled)).toBe(true);
  });

  test('an idle Codex prompt, or the lock rows quoted in a dialog or above a composer, is not', () => {
    expect(codexThreadLockedScreen(IDLE)).toBe(false);
    const rows = LOCKED.split('\n').filter((row) => row.trim() !== '').slice(-4).join('\n');
    const question = readFileSync(new URL('./fixtures/codex/0.167.0/question.txt', import.meta.url), 'utf8');
    expect(codexThreadLockedScreen(`${rows}\n${question}`)).toBe(false);
    expect(codexThreadLockedScreen(`${rows}\n${IDLE}`)).toBe(false);
    // A composer between the transcript and the lock rows is a live input box: not the lock screen.
    expect(codexThreadLockedScreen(`› a draft\n${rows}`)).toBe(false);
    // Both phrases in one line of a reply are not the four rows.
    expect(codexThreadLockedScreen(`• This conversation is open in another app; press ⌃c/q exit\n${IDLE}`)).toBe(false);
  });
});
