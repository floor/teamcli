// A reply that finds the receiving seat's lock held by another command is queued, not refused:
// the signed record and its unread hint are written without that lock — the id names the file,
// the seal is idempotent, and the hint's own write is atomic and already lock-optional — and the
// seat's watcher delivers the reply when the seat is free. Every scene holds the lock with this
// very process's pid, which is a live holder by the same rule a watch child is, or plants an
// unreadable token; no real signal, pane or key is touched.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { acquireSeatLock, seatLockPath } from '../src/launch/seat-lock.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-busy-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function host(patch: Partial<ReplyHost> = {}): ReplyHost {
  return { home, now: () => NOW, ...patch };
}

async function run(
  argv: string[],
  caller: Caller = { kind: 'owner' },
  patch: Partial<ReplyHost> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runReply(argv, io, host(patch));
  return { code, out: io.out, err: io.err };
}

/** A record `team send` would have written: signed, in the addressee's folder, on its thread. */
function sentTo(seat: string, id: string, fields: Parameters<typeof plantRecord>[6] = {}): string {
  const from = fields.from ?? 'worker';
  const header = from === 'owner'
    ? 'from the owner — admitted by: the owner\n'
    : `from the file's seat ${from} (no registry record yet) — admitted by: a seat to its own team's orchestrator\n`;
  return plantRecord(home, root, 'acme', seat, id, `${header}\nquestion`, { at: NOW_ISO, ...fields });
}

/** The answer's signed record where the receiving seat's reader reads it. */
function answerRecord(): ReturnType<typeof recordAt> {
  return recordAt(join(recordDir(root, 'acme', 'worker'), REPLY));
}

test('a reply whose receiving seat is held by a live command is queued, not refused', async () => {
  sentTo('owner', SENT, { from: 'worker' });
  // The holder is this test's own process, alive by the same rule a watching daemon child is:
  // the token names a pid that is running and the start this process knows of itself.
  const held = acquireSeatLock(join(root, '.agents'), 'acme', 'worker');
  if (!('release' in held)) throw new Error('the fixture seat lock was already held');
  try {
    const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(`team acme, session "acme"\nworker: delivered (drop)\n`);
    const record = answerRecord();
    expect(record.payload.id).toBe(REPLY);
    expect(record.payload.to).toBe('worker');
    expect(record.payload.thread).toBe(SENT);
    expect(record.payload.in_reply_to).toBe(SENT);
  } finally {
    held.release();
  }
});

test('a reply whose receiving seat carries an unreadable lock is queued, not refused', async () => {
  sentTo('owner', SENT, { from: 'worker' });
  const path = seatLockPath(join(root, '.agents'), 'acme', 'worker');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'not a token\n');
  const result = await run([SENT, 'the answer'], { kind: 'owner' }, { newId: () => REPLY });
  expect(result.code).toBe(0);
  expect(answerRecord().payload.id).toBe(REPLY);
});
