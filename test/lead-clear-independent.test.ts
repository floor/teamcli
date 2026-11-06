// A lead's clearance is not the seat's read. A non-lead cannot clear, a running
// seat cannot be cleared, a planted receipt without the message key settles
// nothing, and a seat that comes back does not receive the cleared body.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Caller } from '../src/caller.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { runAck, type AckHost } from '../src/commands/ack.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { listUnackedMessages, plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { listUnread, readMessage } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import {
  isRead,
  isReadOrCleared,
  leadAckReceiptAt,
  receiptFile,
  signReceiptPayload,
  statusOf,
  writeReceipt,
} from '../src/send/record.ts';
import { markTaken } from '../src/send/taken.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { confirmTakenDrops } from '../src/watch/taken.ts';
import type { RetryScene } from '../src/watch/retry.ts';
import { seatHasAssignedWorkOnDisk } from '../src/watch/status-events.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const STALE = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
const SESSION = 'home-session';
const PROJECT = 'home-team';
const STALE_ID = '11111111-2222-4333-8444-555555555555';
const FORGED_ID = '33333333-4444-4555-8666-777777777777';
const SIGNED_ID = '44444444-5555-4666-8777-888888888888';
const BODY = 'fixture note for the seat\n\nthe second line';
const OWNER: Caller = { kind: 'owner' };
const CLERK: Caller = { kind: 'seat', name: 'clerk', pane: 'fixture-pane-two', session: SESSION };

const SEAT = (role: string, name: string, stopped: boolean): string => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${stopped ? '    stopped: true\n' : ''}`;

function teamText(workerStopped: boolean): string {
  return `format: 1
project: ${PROJECT}
coordinator: keeper
operator: keeper
session: ${SESSION}
workspace:
  mode: shared
seats:
${SEAT('lead', 'keeper', false)}${SEAT('implementer', 'clerk', false)}${SEAT('implementer', 'worker', workerStopped)}`;
}

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

function world(workerStopped: boolean) {
  const base = fixtureBase('lead-clear-');
  scratchParent ??= dirname(base);
  made.push(base);
  const root = join(base, PROJECT);
  const home = join(base, 'h');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamText(workerStopped));
  updateState(dir, (state) => {
    state.sessions[SESSION] = {
      seats: {
        keeper: { stage: 'ready', pane: 'fixture-pane-one' },
        clerk: { stage: 'ready', pane: 'fixture-pane-two' },
      },
      worktrees: {},
    };
  });
  return { base, root, home, dir };
}

function send(home: string, root: string, id: string): string {
  return plantRecord(home, root, SESSION, 'worker', id, BODY, { at: NOW.toISOString(), from: 'keeper' });
}

function age(root: string, id: string, at: Date): void {
  const folder = recordDir(root, SESSION, 'worker');
  for (const name of readdirSync(folder)) {
    if (name === id || name.startsWith(`${id}.`)) utimesSync(join(folder, name), at, at);
  }
}

async function ack(root: string, home: string, argv: string[], caller: Caller = OWNER) {
  const io = testIo(root, caller);
  const code = await runAck(argv, io, { home, now: () => NOW } satisfies AckHost);
  return { code, out: io.out, err: io.err };
}

function context(root: string) {
  return { to: 'worker', root, session: SESSION };
}

describe('a lead clearance', () => {
  test('a cleared message is never delivered as read, including soak and the wake', async () => {
    const { root, home, dir } = world(true);
    send(home, root, STALE_ID);
    age(root, STALE_ID, STALE);
    const agents = dir;
    expect(seatHasAssignedWorkOnDisk(root, SESSION, 'worker', NOW.getTime(), { project: PROJECT, home })).toBe(true);

    const cleared = await ack(root, home, ['--seat', 'worker', '--older-than', '7d']);
    expect(cleared.code, cleared.err).toBe(0);
    expect(`${cleared.out}${cleared.err}`).not.toContain('delivered (read)');

    const folder = recordDir(root, SESSION, 'worker');
    const key = messageKeyOf(home);
    const where = context(root);
    expect(isRead(folder, STALE_ID, where, key)).toBe(false);
    expect(statusOf(folder, STALE_ID, where, key)).toBe('sent');
    expect(leadAckReceiptAt(folder, STALE_ID, where, key)?.by).toBe('owner');
    expect(listUnread(folder, where, home).map((message) => message.id)).not.toContain(STALE_ID);
    expect(listUnackedMessages(root, SESSION, home).map((message) => message.id)).not.toContain(STALE_ID);
    expect(seatHasAssignedWorkOnDisk(root, SESSION, 'worker', NOW.getTime(), { project: PROJECT, home })).toBe(false);

    const history = readHistory(PROJECT, root, home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      const mine = history.entries.filter((entry) => entry.id === STALE_ID);
      expect(mine.some((entry) => entry.outcome === 'cleared by owner')).toBe(true);
      expect(mine.every((entry) => entry.outcome !== 'delivered (read)')).toBe(true);
    }

    const messages = testIo(root, OWNER);
    expect(await runMessages([], messages, { home, now: () => NOW })).toBe(0);
    expect(messages.out).not.toContain('delivered (read)');
    expect(messages.out).not.toContain('fixture note for the seat');

    const pass = reconcilePass({ project: PROJECT, root, session: SESSION, home, now: NOW });
    expect(pass.ok, pass.ok ? '' : pass.reason).toBe(true);
    if (pass.ok) {
      const text = JSON.stringify(pass.raised);
      expect(text).not.toContain('delivered (read)');
      expect(text).toContain('cleared by owner');
    }

    markTaken(folder, {
      id: STALE_ID, from: 'keeper', to: 'worker', body: BODY, ts: STALE.toISOString(), before: 'idle',
    });
    const said: string[] = [];
    const typed: string[] = [];
    const team = validateTeamFile(teamText(true), { home, root });
    if (!team.ok) throw new Error(JSON.stringify(team.errors));
    const live: Live = { running: true, agents: [], workspaces: [], screens: {} };
    const scene: RetryScene = {
      dir: agents,
      session: SESSION,
      root,
      home,
      team: team.team,
      live,
      ownPane: null,
      sources: {
        screen: () => null,
        status: () => null,
        typeText: (_pane, text) => { typed.push(text); return true; },
        pressEnter: () => true,
        sleep: async () => {},
      },
      now: NOW,
      say: (text) => { said.push(text); },
    };
    confirmTakenDrops(scene);
    expect(typed).toEqual([]);
    expect(said.join('\n')).toContain('cleared by owner');
    expect(said.join('\n')).not.toContain('delivered (read)');
  });

  test('a seat that is not the lead cannot clear, and a running seat is refused', async () => {
    const stopped = world(true);
    send(stopped.home, stopped.root, STALE_ID);
    age(stopped.root, STALE_ID, STALE);
    const clerk = await ack(stopped.root, stopped.home, ['--seat', 'worker', '--older-than', '7d'], CLERK);
    expect(clerk.code).not.toBe(0);
    expect(clerk.err).not.toContain('is running');
    const folder = recordDir(stopped.root, SESSION, 'worker');
    expect(leadAckReceiptAt(folder, STALE_ID, context(stopped.root), messageKeyOf(stopped.home))).toBeNull();

    const running = world(false);
    updateState(running.dir, (state) => {
      const session = state.sessions[SESSION];
      if (session === undefined) throw new Error('the fixture session is missing');
      session.seats.worker = { stage: 'ready', pane: 'fixture-pane-one' };
    });
    send(running.home, running.root, STALE_ID);
    age(running.root, STALE_ID, STALE);
    const refused = await ack(running.root, running.home, ['--seat', 'worker', '--older-than', '7d']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('seat worker is running');
    expect(leadAckReceiptAt(recordDir(running.root, SESSION, 'worker'), STALE_ID, context(running.root), messageKeyOf(running.home))).toBeNull();
  });

  test('a seat that comes back does not receive the cleared body', async () => {
    const { root, home, dir } = world(true);
    send(home, root, STALE_ID);
    age(root, STALE_ID, STALE);
    const cleared = await ack(root, home, ['--seat', 'worker', '--older-than', '7d']);
    expect(cleared.code, cleared.err).toBe(0);
    writeFileSync(join(dir, 'team.yaml'), teamText(false));
    updateState(dir, (state) => {
      const session = state.sessions[SESSION];
      if (session === undefined) throw new Error('the fixture session is missing');
      session.seats.worker = { stage: 'ready', pane: 'fixture-pane-one' };
    });
    const folder = recordDir(root, SESSION, 'worker');
    const where = context(root);
    expect(listUnread(folder, where, home)).toEqual([]);
    const read = readMessage({ dropDir: folder, root, seat: 'worker', session: SESSION }, STALE_ID, home);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.served).toBe('already-served');
    const history = readHistory(PROJECT, root, home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      const mine = history.entries.filter((entry) => entry.id === STALE_ID);
      expect(mine.some((entry) => entry.outcome === 'cleared by owner')).toBe(true);
      expect(mine.every((entry) => entry.outcome !== 'delivered (read)')).toBe(true);
    }
  });

  test('a receipt a seat plants without the message key does not clear', async () => {
    const { root, home } = world(true);
    send(home, root, FORGED_ID);
    age(root, FORGED_ID, STALE);
    const folder = recordDir(root, SESSION, 'worker');
    const path = receiptFile(folder, FORGED_ID, 'read');
    writeFileSync(path, `${JSON.stringify({
      payload: {
        kind: 'receipt', status: 'read', id: FORGED_ID, to: 'worker', root, session: SESSION,
        at: NOW.toISOString(), read_by: 'lead-ack:clerk',
      },
      signature: 'forged',
    })}\n`);
    const key = messageKeyOf(home);
    const where = context(root);
    expect(leadAckReceiptAt(folder, FORGED_ID, where, key)).toBeNull();
    expect(isReadOrCleared(folder, FORGED_ID, where, key)).toBe(false);
    expect(statusOf(folder, FORGED_ID, where, key)).toBe('sent');
    const clerk = await ack(root, home, ['--seat', 'worker', '--older-than', '7d'], CLERK);
    expect(clerk.code).not.toBe(0);
    expect(leadAckReceiptAt(folder, FORGED_ID, where, messageKeyOf(home))).toBeNull();
    expect(listUnread(folder, where, home).map((message) => message.id)).toContain(FORGED_ID);
  });

  test('a signed receipt naming a seat that is not the lead does not clear', () => {
    const { root, home } = world(true);
    send(home, root, SIGNED_ID);
    const folder = recordDir(root, SESSION, 'worker');
    const receipt = signReceiptPayload({
      kind: 'receipt', status: 'read', id: SIGNED_ID, to: 'worker', root, session: SESSION,
      at: NOW.toISOString(), read_by: 'lead-ack:clerk',
    }, home);
    const wrote = writeReceipt(folder, receipt, home);
    expect(wrote.ok, wrote.ok ? '' : wrote.reason).toBe(true);
    const where = context(root);
    const key = messageKeyOf(home);
    expect(leadAckReceiptAt(folder, SIGNED_ID, where, key)).toBeNull();
    expect(isReadOrCleared(folder, SIGNED_ID, where, key)).toBe(false);
    expect(listUnread(folder, where, home).map((message) => message.id)).toContain(SIGNED_ID);
  });
});
