// The Claude adapter §3 and Scope (F7): the turn-start hook's `team drops --read` on an active root.
//
// A stamped message the hook serves is a numbered copy: it never settles, so when the hook dies
// before its envelope reaches the turn, the stamped message stays pending and is served again,
// numbered as a re-send. Unstamped mail from before activation keeps today's read semantics
// (served and receipted after the body, as a dark root reads it): that is the stated boundary of
// the promise. The epoch-bound general brief is never stamped. Fixtures only: a synthetic root,
// home and caller.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDrops } from '../src/commands/drops.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { copyHistory } from '../src/queue/handover.ts';
import { seatMailDirs } from '../src/queue/mail-tree.ts';
import { isRead, signRecord, stampedPayload, stampedSettled, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf, messageKeyState } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';

const SESSION = 'acme';
const daemon: FloorActor = { kind: 'daemon', name: 'daemon', pid: 1, build: 'b', level: 3 };
const LEGACY_ID = '6a0b1c2d-0000-4000-8000-0000000f7001';
const STAMPED_ID = '6a0b1c2d-0000-4000-8000-0000000f7002';
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-hook-active-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { mode: 0o700 });
  messageKeyOf(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready' as const, pane: 'w1:p1' }, worker: { stage: 'ready' as const, pane: 'w1:p2' } } } as never;
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function keyOf() {
  const state = messageKeyState(home);
  if (state.kind !== 'key') throw new Error('no message key');
  return state.key;
}

function record(seat: string, id: string, body: string): void {
  const payload: RecordPayload = { kind: 'message', id, to: seat, to_id: null, root, session: SESSION, at: new Date().toISOString(), body, from: 'owner', from_id: null, rule: 'the owner', thread: id };
  const dirs = seatMailDirs(root, SESSION, seat);
  mkdirSync(dirs.legacy, { recursive: true, mode: 0o700 });
  expect(writeRecord(dirs.legacy, signRecord(stampedPayload(payload, home), home)).ok).toBe(true);
}

/** The hook's read as the seat, on its own pane. `dies` is a hook killed before its envelope
 *  reaches the turn: the command's stdout goes nowhere. */
async function hookRead(seat: string, pane: string): Promise<{ code: number; out: string }> {
  const caller: Caller = { kind: 'seat', name: seat, pane, session: SESSION };
  const io = testIo(root, caller);
  const code = await runDrops(['--read', '--seat', seat, '--session', SESSION], io, { home });
  return { code, out: io.out };
}

const context = (seat: string) => ({ to: seat, root, session: SESSION, lead: 'lead' });

describe('F7: mixed-era mail at an active root, and a hook that dies before its envelope', () => {
  test('the stamped message stays pending and is served again as a re-send; the unstamped one keeps today\'s rule', async () => {
    // Before activation: an unstamped message, in the legacy folder.
    record('lead', LEGACY_ID, 'the pre-activation note');
    const dirs = seatMailDirs(root, SESSION, 'lead');
    expect(existsSync(join(dirs.legacy, LEGACY_ID))).toBe(true);
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    // After: a stamped one, in the stamped folder.
    record('lead', STAMPED_ID, 'the stamped note');
    expect(existsSync(join(dirs.stamped, STAMPED_ID))).toBe(true);

    // The hook reads, and dies before its envelope reaches the turn (its output is discarded).
    const first = await hookRead('lead', 'w1:p1');
    expect(first.code).toBe(0);
    expect(first.out).toContain('the pre-activation note');
    expect(first.out).toContain('the stamped note');
    expect(first.out).toContain(`message ${STAMPED_ID} · delivery 1`);
    // The stamped read is a copy: not settled, still due for the scheduler, and served again.
    expect(stampedSettled(dirs.stamped, STAMPED_ID, context('lead'), keyOf())).toBe(false);
    expect(copyHistory(dirs.stamped, STAMPED_ID)).toMatchObject({ copies: 1 });
    // The unstamped one follows today's rule: its receipt was written after the body.
    expect(isRead(dirs.legacy, LEGACY_ID, context('lead'), keyOf())).toBe(true);

    const second = await hookRead('lead', 'w1:p1');
    expect(second.code).toBe(0);
    expect(second.out).toContain(`message ${STAMPED_ID} · delivery 2 — a re-send`);
    expect(second.out).toContain('the stamped note');
    expect(second.out).not.toContain('the pre-activation note');
    expect(stampedSettled(dirs.stamped, STAMPED_ID, context('lead'), keyOf())).toBe(false);
  });

  test('the epoch-bound general brief is never stamped on an active root', () => {
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    const brief: RecordPayload = {
      kind: 'message', id: '6a0b1c2d-0000-4000-8000-0000000f7003', to: 'lead', to_id: null, root, session: SESSION, at: new Date().toISOString(),
      body: 'the brief', from: 'the launch', from_id: null, rule: 'the launch delivers it to every seat of its team', thread: '6a0b1c2d-0000-4000-8000-0000000f7003',
      brief_sha256: 'a'.repeat(64), incarnation: 'inc-1',
    };
    expect(stampedPayload(brief, home).lvl).toBeUndefined();
  });
});
