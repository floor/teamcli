// `team send --wait` on the thread: across `drop`, `mcp-inbox` and `typed` legs, and for
// `human: true` seats. A waited send writes the signed message record via the receiving seat's
// delivery walk, then awaits the first verified reply record on the thread within the timeout
// window. When the window closes with no reply on the thread, it exits 1 (`send.timeout`) and
// leaves the thread open so a late `team reply` still arrives on the thread and moves status once.
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
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

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
  test('returns answered (exit 0) across drop, mcp-inbox and typed legs when a verified reply record arrives on the thread', async () => {
    for (const leg of ['drop', 'mcp-inbox', 'typed'] as const) {
      const w = makeWorld('', `delivery_order: [${leg}]\n`);
      if (leg === 'mcp-inbox') {
        const inbox = dropDir(w.root, 'worker');
        mkdirSync(inbox, { recursive: true });
        writeFileSync(
          join(inbox, '.inbox-listener'),
          `${JSON.stringify({
            v: 1,
            seat: 'worker',
            session: 'acme',
            root: w.root,
            cli: 'codex',
            pid: process.pid,
            ts: NOW.toISOString(),
          })}\n`,
        );
      }
      const host = makeHost(w, { waitMs: 250 });
      const leadCaller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
      const workerCaller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' } as const;
      const sendIo = testIo(w.root, leadCaller);

      // While `--wait` is polling the thread, the recipient answers via `team reply <id> <text>`.
      const replyTimer = setTimeout(() => {
        const replyIo = testIo(w.root, workerCaller);
        void runReply([SENT_ID, `ack via ${leg}`], replyIo, { home: w.home, now: () => NOW });
      }, 40);

      const code = await runSend(['worker', `ping on ${leg}`, '--wait', '--timeout', '2', '--json'], sendIo, host);
      clearTimeout(replyTimer);

      expect(code).toBe(0);
      expect(sendIo.err).toBe('');
      assertMatchesOutputSchema(sendIo.out, SEND_OUTPUT_SCHEMA);
      const doc = JSON.parse(sendIo.out) as Record<string, unknown>;
      expect(doc).toMatchObject({
        schema: { name: 'team.send', version: 1 },
        format: 1,
        dry_run: false,
        status: 'answered',
        action_summary: 'worker: answered',
        project: 'acme',
        session: 'acme',
        seat: 'worker',
        channel: leg,
        thread: SENT_ID,
        reply: expect.stringContaining(`ack via ${leg}`),
      });
      const ids = doc.ids as { sent: string; reply: string };
      expect(ids.sent).toBe(SENT_ID);
      expect(typeof ids.reply).toBe('string');
      expect(ids.reply).not.toBe(SENT_ID);
      const key = messageKeyOf(w.home);
      expect(statusOf(dropDir(w.root, 'worker'), SENT_ID, { to: 'worker', root: w.root, session: 'acme' }, key)).toBe('replied');
      if (leg === 'drop' || leg === 'mcp-inbox') {
        expect(host.typed).toEqual([]);
        expect(host.enters).toEqual([]);
        expect(readPending(dropDir(w.root, 'worker'))).toEqual([]);
      } else {
        expect(host.typed).toHaveLength(1);
      }
      rmSync(base, { recursive: true, force: true });
      base = '';
    }
  });

  test('times out (exit 1) when the window closes with no reply, leaving the thread open so a late reply lands on the thread and moves status once', async () => {
    const w = makeWorld('', 'delivery_order: [drop]\n');
    const host = makeHost(w, { waitMs: 0 });
    const leadCaller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' } as const;
    const workerCaller = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' } as const;
    const sendIo = testIo(w.root, leadCaller);

    const code = await runSend(['worker', 'status check', '--wait', '--timeout', '3', '--json'], sendIo, host);

    expect(code).toBe(1);
    const errDoc = assertJsonErrorShape(sendIo.out, { id: 'send.timeout', repair: null });
    expect(errDoc.error.message).toBe('worker: timeout: sent, no reply on the thread within 3s; the thread stays open');

    // The sent record is on disk, its status is still `sent`, and the thread is open.
    const workerDrops = dropDir(w.root, 'worker');
    const key = messageKeyOf(w.home);
    const sentRead = readRecord(join(workerDrops, SENT_ID), SENT_ID);
    expect(sentRead.ok).toBe(true);
    if (sentRead.ok && sentRead.record !== null) {
      expect(verifyRecord(sentRead.record, key)).toBe(true);
    }
    expect(statusOf(workerDrops, SENT_ID, { to: 'worker', root: w.root, session: 'acme' }, key)).toBe('sent');
    expect(existsSync(join(workerDrops, `${SENT_ID}.closed.json`))).toBe(false);

    // A late reply after the timeout window still arrives on the same open thread and moves status once to `replied`.
    const replyIo = testIo(w.root, workerCaller);
    const replyCode = await runReply([SENT_ID, 'late answer'], replyIo, { home: w.home, now: () => NOW });
    expect(replyCode).toBe(0);
    expect(replyIo.out).toContain('lead: replied');
    expect(statusOf(workerDrops, SENT_ID, { to: 'worker', root: w.root, session: 'acme' }, key)).toBe('replied');

    const leadDrops = dropDir(w.root, 'lead');
    const leadRecordFiles = readdirSync(leadDrops).filter((f) => !f.endsWith('.json') && !f.endsWith('.pending'));
    expect(leadRecordFiles).toHaveLength(1);
    const replyRead = readRecord(join(leadDrops, leadRecordFiles[0] as string));
    expect(replyRead.ok).toBe(true);
    if (replyRead.ok && replyRead.record !== null) {
      expect(verifyRecord(replyRead.record, key)).toBe(true);
      expect(replyRead.record.payload.thread).toBe(SENT_ID);
      expect(replyRead.record.payload.in_reply_to).toBe(SENT_ID);
      expect(replyRead.record.payload.body).toContain('late answer');
    }
  });

  test('ignores unverified files and records on other threads while waiting', async () => {
    const w = makeWorld('', 'delivery_order: [drop]\n');
    const host = makeHost(w, { waitMs: 0 });
    const io = testIo(w.root, { kind: 'owner' });

    // Plant a verified record on a different thread and an unverified file claiming our thread.
    plantRecord(w.home, w.root, 'acme', 'owner', 'other-reply', 'wrong thread', {
      from: 'lead',
      at: NOW.toISOString(),
      thread: '99999999-9999-4999-8999-999999999999',
      in_reply_to: '99999999-9999-4999-8999-999999999999',
    });
    const ownerDrops = dropDir(w.root, 'owner');
    writeFileSync(
      join(ownerDrops, 'forged-reply'),
      JSON.stringify({
        payload: {
          kind: 'message',
          id: 'forged-reply',
          to: 'owner',
          to_id: null,
          root: w.root,
          session: 'acme',
          at: NOW.toISOString(),
          body: 'forged',
          from: 'lead',
          from_id: null,
          rule: 'reply-on-open-thread',
          thread: SENT_ID,
          in_reply_to: SENT_ID,
        },
        signature: 'deadbeef',
      }),
    );

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);
    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
  });
});

describe('team send --wait to a human: true seat (P3)', () => {
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
    expect(io.out).toBe('team acme, session "acme"\nlead: answered\nhuman says go ahead\n');
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
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 2s; the thread stays open\n');
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
