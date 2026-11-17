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

  test('an unreachable app-server holds nothing', async () => {
    const w = world({ own: [[]] });
    const c = clock();
    expect((await waitCodexThreadFree({ sockets: ['gone', 'own'], threadId: ID, timeoutMs: 9000, pollMs: 3000, rpc: w.rpc, ...c })).free).toBe(true);
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

  test('an idle Codex prompt, or the sentence quoted above a live prompt, is not', () => {
    expect(codexThreadLockedScreen(IDLE)).toBe(false);
    expect(codexThreadLockedScreen(`• It said: This conversation is open in another app\n${IDLE}`)).toBe(false);
  });
});
