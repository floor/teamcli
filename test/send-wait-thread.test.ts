import { NO_EVENT_ADAPTER_TOOK_IT, queuedLine } from '../src/send/no-pane-messaging.ts';
// `team send --wait` on the thread: whatever word the seat's order declares (the mailbox, the
// unavailable inbox word, or the typed leg), and for `human: true` seats. A waited send writes
// the signed message record via the receiving seat's delivery walk, then awaits the first
// verified reply record on the thread within the timeout window. When the window closes with no
// reply on the thread, it exits 1 (`send.timeout`) and leaves the thread open so a late
// `team reply` still arrives on the thread and moves status once.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plantRecord } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { readHistory } from '../src/send/history.ts';
import { readPending } from '../src/send/pending.ts';
import { readRecord, statusOf, verifyRecord } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { claudeBox, CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema, withoutSendId } from './helpers/output.ts';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const SENT_ID = '11111111-1111-4111-8111-111111111111';
const REPLY_ID = '22222222-2222-4222-8222-222222222222';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

type World = {
  root: string;
  dir: string;
  home: string;
  sockets: string;
};

function makeWorld(extraLead = '', teamDelivery = ''): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-wait-thread-')));
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const sockets = join(base, 'cc-socks');
  const lobby = lobbyDir(home);
  mkdirSync(root, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'team.yaml'),
    `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
${extraLead}  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex
${teamDelivery}`,
  );
  updateState(dir, (state) => {
    const s = (state.sessions.acme ??= emptySession());
    s.seats.lead = { stage: 'ready', pane: 'w1:p1' };
    s.seats.worker = { stage: 'ready', pane: 'w2:p1' };
  });
  return { root, dir, home, sockets };
}

function makeHost(
  w: World,
  over: Partial<SendHost> = {},
): SendHost & { typed: string[]; enters: string[]; frames: string[]; dials: () => number } {
  const typed: string[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let dialed = 0;
  let lastTrigger = '';
  let entered = false;
  return {
    typed,
    enters,
    frames,
    dials: () => dialed,
    agents: () => [
      { name: 'lead', pane: 'w1:p1', cli: 'claude' },
      { name: 'worker', pane: 'w2:p1', cli: 'codex' },
    ],
    processInfo: () => ({ shell: 222, foreground: [223] }),
    socketsDir: w.sockets,
    deliver: async (_sock, frame) => {
      dialed += 1;
      frames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: (_pane, text) => {
        lastTrigger = text;
        typed.push(text);
        return true;
      },
      pressEnter: (pane) => {
        entered = true;
        enters.push(pane);
        return true;
      },
      status: () => (entered ? 'working' : 'idle'),
      paneText: () => (entered ? CLAUDE_IDLE : lastTrigger ? claudeBox(lastTrigger) : CLAUDE_IDLE),
      wait: async () => {},
    },
    now: () => NOW,
    home: w.home,
    sendId: () => SENT_ID,
    waitMs: 0,
    ...over,
  };
}

function dropDir(root: string, seat: string): string {
  return join(root, '.agents', 'send-drops', 'acme', seat);
}

describe('team send --wait on the thread across delivery legs', () => {
});

describe('team send --wait to a human: true seat (P3)', () => {
  test('ignores signed thread records at reserved sidecar names while keeping the actual reply', async () => {
    const w = makeWorld('    human: true\n');
    const markers = new Map<string, string>();
    for (const suffix of ['wake', 'woken', 'reported', 'new']) {
      const id = `reserved.${suffix}`;
      plantRecord(w.home, w.root, 'acme', 'owner', id, `sidecar ${suffix} is not an answer`, {
        from: 'lead',
        at: new Date(NOW.getTime() - 1000).toISOString(),
        thread: SENT_ID,
        in_reply_to: SENT_ID,
      });
      const path = join(dropDir(w.root, 'owner'), id);
      markers.set(path, readFileSync(path, 'utf8'));
    }
    plantRecord(w.home, w.root, 'acme', 'owner', REPLY_ID, 'the actual answer', {
      from: 'lead',
      at: NOW.toISOString(),
      thread: SENT_ID,
      in_reply_to: SENT_ID,
    });
    const host = makeHost(w);
    const io = testIo(w.root, { kind: 'owner' });

    expect(await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host)).toBe(0);
    expect(io.err).toBe('');
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nlead: answered\nthe actual answer\n');
    for (const [path, bytes] of markers) expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
  });

  test('is allowed, writes on the drop leg, types nothing, and returns answered when a reply record arrives on the thread', async () => {
    const w = makeWorld('    human: true\n    delivery_order: [native, mcp-inbox, typed]\n');
    plantRecord(w.home, w.root, 'acme', 'owner', REPLY_ID, 'human says go ahead', {
      from: 'lead',
      at: NOW.toISOString(),
      thread: SENT_ID,
      in_reply_to: SENT_ID,
    });
    const host = makeHost(w, { waitMs: 0 });
    const io = testIo(w.root, { kind: 'owner' });

    const code = await runSend(['lead', 'approve release?', '--wait', '--timeout', '5'], io, host);

    expect(code).toBe(0);
    expect(io.err).toBe('');
    expect(withoutSendId(io.out)).toBe('team acme, session "acme"\nlead: answered\nhuman says go ahead\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(readPending(dropDir(w.root, 'lead'))).toEqual([]);

    const history = readHistory('acme', w.root, w.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({
        from: 'owner',
        to: 'lead',
        id: SENT_ID,
        thread: SENT_ID,
        outcome: 'answered',
        via: 'drop',
      });
    }
  });

  test('returns timeout (exit 1) when the window closes with no reply on the thread, types nothing, and leaves the thread open', async () => {
    const w = makeWorld('    human: true\n');
    const host = makeHost(w, { waitMs: 0 });
    const workerCaller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' } as const;
    const leadCaller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
    const io = testIo(w.root, workerCaller);

    const code = await runSend(['lead', 'need sign-off', '--wait', '--timeout', '2'], io, host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(withoutSendId(io.err)).toBe('team send: lead: timeout: sent, no reply on the thread within 2s; the thread stays open\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(readPending(dropDir(w.root, 'lead'))).toEqual([]);

    // The thread stays open on timeout, and the human seat can reply after the window closes.
    const key = messageKeyOf(w.home);
    expect(existsSync(join(dropDir(w.root, 'lead'), `${SENT_ID}.closed.json`))).toBe(false);
    const replyIo = testIo(w.root, leadCaller);
    expect(await runReply([SENT_ID, 'signed off'], replyIo, { home: w.home, now: () => NOW })).toBe(0);
    expect(statusOf(dropDir(w.root, 'lead'), SENT_ID, { to: 'lead', root: w.root, session: 'acme' }, key)).toBe('replied');
  });
});
