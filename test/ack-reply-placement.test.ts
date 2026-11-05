// A seat behind a launcher wrapper runs `team send`, `team ack` and `team reply` from its own
// shell. The wrapper is one more process between the seat's shell and the terminal host, and
// the host answers its agent list and pane root only when it is asked about the team's session;
// asked without one it answers nothing. All three commands must place that caller as the seat
// its pane and session name — the same placement `team send` has always made — and a caller no
// placement can name is refused by all three.
//
// Fixtures only: a synthetic checkout and home, and the ancestry and terminal-host answers
// handed in as caller sources. No live session, pane or CLI.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { runAck, type AckHost } from '../src/commands/ack.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { runSend } from '../src/commands/send.ts';
import { receiptFile } from '../src/send/record.ts';
import { updateState } from '../src/state.ts';
import { recordAt, recordBody, testIo, type TestIo } from './helpers.ts';
import { fake, world, type World } from './send-native-fixtures.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const ACKED = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d';
const ANSWERED = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const ANSWER = '6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f';

const PANE = 'pane-helper';
/** The pane root process herdr names; the wrapper and the shell sit under it. */
const PANE_ROOT = 9;

let made: World;

afterEach(() => {
  made.cleanup();
});

/** The state `up` leaves: the seat launched, on the pane its caller stands on. */
function placeHelper(): void {
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: { helper: { stage: 'ready', pane: PANE } },
      worktrees: {},
    };
  });
}

/** The launcher-wrapped seat's ancestry and the terminal host's answers: `sh` runs the wrapper,
 *  the wrapper runs the seat's agent, and the host lists the seat and its pane root only when
 *  the session is named. */
function wrappedSeat(session: string | undefined) {
  return {
    ancestors: () => [
      { pid: 33, name: 'sh' },
      { pid: 17, name: 'seat-launcher' },
      { pid: PANE_ROOT, name: 'herdr' },
    ],
    agents: () => session === undefined
      ? null
      : [{ name: 'helper', agent: 'deepseek', pane: PANE, workspace: 'w1', status: 'idle', cwd: made.root }],
    paneRootPid: () => session === undefined ? null : PANE_ROOT,
    env: { HERDR_PANE_ID: PANE },
    stdinIsTTY: true,
  };
}

/** The same ancestry with a host that answers nothing, in any session: no placement names it. */
function unplaceable() {
  return {
    ancestors: () => [{ pid: 33, name: 'sh' }, { pid: PANE_ROOT, name: 'herdr' }],
    agents: () => null,
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: false,
  };
}

function withSources(sources: (session: string | undefined) => CallerSources): TestIo {
  const io = testIo(made.root);
  io.callerSources = sources;
  return io;
}

function ackHost(): AckHost {
  return { home: made.home, now: () => NOW };
}

function replyHost(): ReplyHost {
  return { home: made.home, now: () => NOW, newId: () => ANSWER };
}

describe('a launcher-wrapped seat runs all three commands from its own shell', () => {
  test('send, ack and reply place the caller as the seat its pane and session name', async () => {
    made = world(null);
    placeHelper();

    // send: the seat writes its message to its lead. The walk notes on stderr where the message
    // waits; the drop is the delivery this scene reads.
    const sendIo = withSources(wrappedSeat);
    const sendCode = await runSend(['lead', 'hello'], sendIo, fake(made));
    expect(sendCode).toBe(0);
    const drops = readdirSync(join(made.dir, 'send-drops', 'acme', 'lead')).filter((name) => !name.includes('.'));
    expect(drops).toHaveLength(1);
    const sent = recordBody(join(made.dir, 'send-drops', 'acme', 'lead', drops[0] as string));
    expect(sent).toContain('helper');
    expect(sent).toContain('hello');

    // ack: the seat marks a message addressed to it read, in its own folder.
    plantRecord(made.home, made.root, 'acme', 'helper', ACKED, 'a question', { from: 'lead', at: NOW.toISOString() });
    const ackIo = withSources(wrappedSeat);
    const ackCode = await runAck([ACKED], ackIo, ackHost());
    expect({ code: ackCode, err: ackIo.err }).toEqual({ code: 0, err: '' });
    expect(existsSync(receiptFile(recordDir(made.root, 'acme', 'helper'), ACKED, 'read'))).toBe(true);

    // reply: the seat answers its lead, and the answer names the seat that wrote it.
    plantRecord(made.home, made.root, 'acme', 'helper', ANSWERED, 'a question', { from: 'lead', at: NOW.toISOString() });
    const replyIo = withSources(wrappedSeat);
    const replyCode = await runReply([ANSWERED, 'the answer'], replyIo, replyHost());
    expect({ code: replyCode, err: replyIo.err }).toEqual({ code: 0, err: '' });
    const answer = recordAt(join(recordDir(made.root, 'acme', 'lead'), ANSWER));
    expect(answer.payload.from).toBe('helper');
    expect(answer.payload.to).toBe('lead');
  });
});

describe('a caller no placement names', () => {
  test('send, ack and reply all refuse it', async () => {
    made = world(null);
    placeHelper();
    plantRecord(made.home, made.root, 'acme', 'helper', ACKED, 'a question', { from: 'lead', at: NOW.toISOString() });
    plantRecord(made.home, made.root, 'acme', 'helper', ANSWERED, 'a question', { from: 'lead', at: NOW.toISOString() });

    const sendIo = withSources(unplaceable);
    expect(await runSend(['lead', 'hello'], sendIo, fake(made))).toBe(1);
    expect(sendIo.err).toContain('herdr');

    const ackIo = withSources(unplaceable);
    expect(await runAck([ACKED], ackIo, ackHost())).toBe(1);
    expect(ackIo.err).toContain('unplaced');

    const replyIo = withSources(unplaceable);
    expect(await runReply([ANSWERED, 'the answer'], replyIo, replyHost())).toBe(1);
    expect(replyIo.err).toContain('unplaced');
  });
});
