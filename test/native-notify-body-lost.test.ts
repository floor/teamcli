// A late native pointer for mail the seat already read. No live socket, no signal, no real runtime.
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDrops } from '../src/commands/drops.ts';
import type { Io } from '../src/io.ts';
import { deliverCodexNativeRoute } from '../src/send/push-adapters/codex-relay.ts';
import type { CodexSpawn } from '../src/send/push-adapters/codex.ts';
import {
  recordTextOf, signReceiptPayload, signRecord, writeReceipt, writeRecord, type RecordPayload,
} from '../src/send/record.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

const SEAT = 'operator-1';
const SESSION = 'morning';
const PANE = 'pane-operator-1';
const READ_AT = '2026-11-06T17:00:00.000Z';
const ALREADY = 'this body was read before the pointer';
const UNREAD = 'this body is still unread';

const acceptQueue: CodexSpawn = () => ({ status: 0, stdout: '', stderr: '' });

function world(): { root: string; home: string; dropDir: string } {
  const root = fixtureBase('native-notify-body-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = join(root, 'home');
  const agents = join(root, '.agents');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(agents, { mode: 0o700 });
  writeFileSync(join(agents, 'team.yaml'), `format: 1
project: fixture
session: ${SESSION}
operator: ${SEAT}
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: codex
    vendor: openai
    model: Fixture
    version: "1"
    launch: codex
    leads: true
  - name: ${SEAT}
    role: operator
    cli: codex
    vendor: openai
    model: Fixture
    version: "1"
    launch: codex
`, { mode: 0o600 });
  writeFileSync(join(agents, 'team.state.json'), `${JSON.stringify({
    format: 1,
    sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', pane: PANE, cli: 'codex' } } } },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, home, dropDir: join(agents, 'send-drops', SESSION, SEAT) };
}

function writeBody(root: string, home: string, dropDir: string, id: string, body: string): string {
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: SEAT,
    to_id: null,
    root,
    session: SESSION,
    at: '2026-11-06T16:00:00.000Z',
    body,
    from: 'lead',
    from_id: null,
    rule: 'a seat sends to a seat of its own team',
    thread: id,
  };
  const signed = signRecord(payload, home);
  const written = writeRecord(dropDir, signed);
  if (!written.ok) throw new Error(written.reason);
  return recordTextOf(signed);
}

function seatIo(root: string, home: string): { io: Io; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    cwd: root,
    env: { HOME: home },
    stdinIsTTY: false,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    caller: { kind: 'seat', name: SEAT, pane: PANE, session: SESSION },
  };
  return { io, out: () => stdout, err: () => stderr };
}

test('a late pointer for a read id says when it was read, and an unread id still returns its body', async () => {
  const held = world();
  try {
    const readId = '6b1f3c2d-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
    const unreadId = '7c204d3e-5f6b-4c7d-9e8f-a0b1c2d3e4f5';
    const text = writeBody(held.root, held.home, held.dropDir, readId, ALREADY);
    const marked = writeReceipt(held.dropDir, signReceiptPayload({
      kind: 'receipt', status: 'read', id: readId, to: SEAT, root: held.root, session: SESSION, at: READ_AT,
    }, held.home), held.home);
    if (!marked.ok) throw new Error(marked.reason);
    writeBody(held.root, held.home, held.dropDir, unreadId, UNREAD);
    const pointer = await deliverCodexNativeRoute(
      {
        route: 'native',
        runtime: 'codex',
        copy: { dir: held.dropDir, name: readId },
        root: held.root,
        home: held.home,
        session: SESSION,
        seat: SEAT,
        sender: { seat: 'lead', team: 'fixture' },
      },
      { id: readId, record: text },
      {
        now: () => new Date('2026-11-06T20:00:00.000Z'),
        deliveryTimeout: 5_000,
        liveProbe: false,
        skipStage: true,
        socketPath: join(held.root, 'codex.sock'),
        codexDaemon: 'on',
        sessionBinding: {
          kind: 'bound',
          recorded: {
            agentId: 'agt_0123456789ab',
            seatHandle: null,
            sessionId: 'thread-operator-1',
            team: 'fixture',
            seat: SEAT,
            cli: 'codex',
            herdrSession: SESSION,
            pane: PANE,
            address: null,
          },
        },
        spawn: acceptQueue,
      },
    );
    expect(pointer.outcome).toBe('enqueue');
    const read = seatIo(held.root, held.home);
    const code = await runDrops(['--read', '--seat', SEAT], read.io, { home: held.home });
    const said = read.out() + read.err();
    expect(code).toBe(0);
    expect(said).toContain(`already read at ${READ_AT}`);
    expect(read.out()).toContain(UNREAD);
  } finally {
    discardFixtures([held.root], { roots: [dirname(held.root)] });
  }
});
