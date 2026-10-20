// The Codex app-server adapter (src/daemon/presence/codex-app-server.ts): the notification shapes
// are the ones `codex app-server generate-ts` wrote for codex-cli 0.161.0 — `thread/status/changed`
// carrying a `ThreadStatus`, `turn/started` and `turn/completed` carrying a `threadId`. Every
// synthetic payload below is built in that shape; no live app-server is started, polled or read.
// A notification for another thread is set aside whole, and a status this build cannot mean
// (notLoaded, systemError, unknown words, malformed flags) stages nothing rather than guessing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  presenceFromCodexNotification,
  stageCodexPresence,
  type CodexPresenceInput,
} from '../src/daemon/presence/codex-app-server.ts';
import { presencePaths } from '../src/daemon/presence/spool.ts';

const SESSION = 'teamcli';
const SEAT = 'worker';
const BINDING = 'prs_0123456789ab';
const THREAD = 'th_01j9-measured-thread';

let base: string;
let dir: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'team-presence-codex-'));
  dir = join(base, '.agents');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const notification = (method: string, params?: unknown): unknown =>
  params === undefined ? { method } : { method, params };
const status = (value: unknown): unknown => notification('thread/status/changed', { threadId: THREAD, status: value });
const input = (over: Partial<CodexPresenceInput> = {}): CodexPresenceInput => ({
  stateDir: dir,
  session: SESSION,
  seat: SEAT,
  binding: BINDING,
  threadId: THREAD,
  ...over,
});
const spool = (): string => presencePaths(dir, SESSION, SEAT)!.spool;
const staged = (): Record<string, unknown>[] => (exists()
  ? readdirSync(spool()).map((file) => JSON.parse(readFileSync(join(spool(), file), 'utf8')) as Record<string, unknown>)
  : []);
function exists(): boolean {
  try {
    return readdirSync(spool()).length > 0;
  } catch {
    return false;
  }
}

describe('the notification mapping, exactly the generated shapes', () => {
  test('turn started is working and turn completed is idle, both under the bound thread', () => {
    expect(presenceFromCodexNotification(notification('turn/started', { threadId: THREAD, turn: { id: 't1' } }), THREAD))
      .toEqual({ kind: 'event', event: 'turn-start', raw: 'turn/started' });
    expect(presenceFromCodexNotification(notification('turn/completed', { threadId: THREAD, turn: { id: 't1' } }), THREAD))
      .toEqual({ kind: 'event', event: 'turn-end', raw: 'turn/completed' });
  });

  test('an active status becomes working unless a measured waiting flag is set', () => {
    expect(presenceFromCodexNotification(status({ type: 'active', activeFlags: [] }), THREAD))
      .toEqual({ kind: 'event', event: 'turn-start', raw: 'active' });
    expect(presenceFromCodexNotification(status({ type: 'active', activeFlags: ['waitingOnApproval'] }), THREAD))
      .toEqual({ kind: 'event', event: 'human-wait', raw: 'waitingOnApproval' });
    expect(presenceFromCodexNotification(status({ type: 'active', activeFlags: ['waitingOnUserInput'] }), THREAD))
      .toEqual({ kind: 'event', event: 'human-wait', raw: 'waitingOnUserInput' });
    // Both flags at once are still one wait; the raw word keeps the measured flag.
    expect(presenceFromCodexNotification(
      status({ type: 'active', activeFlags: ['waitingOnUserInput', 'waitingOnApproval'] }),
      THREAD,
    )).toEqual({ kind: 'event', event: 'human-wait', raw: 'waitingOnApproval' });
  });

  test('idle is a turn end; notLoaded and systemError are not presence words', () => {
    expect(presenceFromCodexNotification(status({ type: 'idle' }), THREAD))
      .toEqual({ kind: 'event', event: 'turn-end', raw: 'idle' });
    expect(presenceFromCodexNotification(status({ type: 'notLoaded' }), THREAD).kind).toBe('ignored');
    expect(presenceFromCodexNotification(status({ type: 'systemError' }), THREAD).kind).toBe('ignored');
  });

  test('a closed, archived or deleted thread stages nothing: no measured session end', () => {
    for (const method of ['thread/closed', 'thread/archived', 'thread/deleted', 'thread/started', 'turn/diff/updated']) {
      expect(presenceFromCodexNotification(notification(method, { threadId: THREAD }), THREAD).kind).toBe('ignored');
    }
  });

  test('another thread is set aside whole, never repaired onto this seat', () => {
    expect(presenceFromCodexNotification(notification('turn/started', { threadId: 'th_other' }), THREAD))
      .toEqual({ kind: 'other-thread' });
    expect(presenceFromCodexNotification(status({ type: 'idle' }), 'th_other')).toEqual({ kind: 'other-thread' });
  });

  test('a shape this build cannot mean is ignored, never guessed as working', () => {
    const cases: unknown[] = [
      null,
      'turn/started',
      [],
      {},
      { method: 42, params: {} },
      { method: 'turn/started' },
      { method: 'turn/started', params: [] },
      { method: 'turn/started', params: {} },
      { method: 'turn/started', params: { threadId: 42 } },
      { method: 'thread/status/changed', params: { threadId: THREAD } },
      { method: 'thread/status/changed', params: { threadId: THREAD, status: {} } },
      { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'paused' } } },
      { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active' } } },
      { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: 'waitingOnApproval' } } },
      { method: 'thread/status/changed', params: { threadId: THREAD, status: { type: 'active', activeFlags: [1] } } },
    ];
    for (const value of cases) expect(presenceFromCodexNotification(value, THREAD).kind).toBe('ignored');
    // No thread id to fence on: nothing this seat may claim.
    expect(presenceFromCodexNotification(notification('turn/started', { threadId: '' }), '').kind).toBe('ignored');
  });
});

describe('staging a mapped notification', () => {
  test('a mapped event is staged as runtime-event under the launch binding and the thread word', () => {
    const outcome = stageCodexPresence(input(), status({ type: 'active', activeFlags: ['waitingOnApproval'] }));
    expect(outcome).toMatchObject({ kind: 'staged', event: 'human-wait', raw: 'waitingOnApproval' });
    expect(staged()).toHaveLength(1);
    expect(staged()[0]).toMatchObject({
      source: 'runtime-event',
      event: 'human-wait',
      raw: 'waitingOnApproval',
      session: SESSION,
      seat: SEAT,
      binding: BINDING,
    });
  });

  test('an ignored notification or another thread stages nothing: the last word stands', () => {
    expect(stageCodexPresence(input(), status({ type: 'notLoaded' })).kind).toBe('ignored');
    expect(stageCodexPresence(input(), notification('turn/started', { threadId: 'th_other' })).kind).toBe('other-thread');
    expect(staged()).toEqual([]);
  });

  test('two measured events stage two records under the same binding', () => {
    expect(stageCodexPresence(input(), notification('turn/started', { threadId: THREAD })).kind).toBe('staged');
    expect(stageCodexPresence(input(), notification('turn/completed', { threadId: THREAD })).kind).toBe('staged');
    expect(staged().map((record) => record.event).sort()).toEqual(['turn-end', 'turn-start']);
    expect(new Set(staged().map((record) => record.binding))).toEqual(new Set([BINDING]));
  });

  test('a seat with no binding or a folder that cannot be written is refused, not staged under a guess', () => {
    expect(stageCodexPresence(input({ binding: 'not-a-binding' }), status({ type: 'idle' })))
      .toEqual({ kind: 'refused', why: 'the seat records no launch binding' });
    const file = join(base, 'state-file');
    writeFileSync(file, 'x');
    expect(stageCodexPresence(input({ stateDir: file }), status({ type: 'idle' })).kind).toBe('refused');
    expect(staged()).toEqual([]);
  });
});
