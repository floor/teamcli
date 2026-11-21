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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDrops } from '../src/commands/drops.ts';
import { activate, type FloorActor } from '../src/queue/floor.ts';
import { copyHistory, EXPOSURES, takeCopyNumber } from '../src/queue/handover.ts';
import { cliHookSettings } from '../src/launch/cli-hook.ts';
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

describe('the hook re-shows a stamped message only when its ladder step is due', () => {
  /** The hook's own read, `--due`, as the seat on its pane. */
  async function dueRead(): Promise<string> {
    const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: SESSION });
    expect(await runDrops(['--read', '--due', '--seat', 'lead', '--session', SESSION], io, { home })).toBe(0);
    return io.out;
  }
  /** Moves every copy of the record `ms` into the past. */
  function age(id: string, ms: number): void {
    const history = join(seatMailDirs(root, SESSION, 'lead').stamped, EXPOSURES, id);
    const then = new Date(Date.now() - ms);
    for (const name of readdirSync(history)) if (/^\d+$/.test(name)) utimesSync(join(history, name), then, then);
  }

  test('a run of prompts inside a minute numbers one copy; the next is shown once 60 s pass, the one after waits 120 s', async () => {
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    record('lead', STAMPED_ID, 'the stamped note');
    const stamped = seatMailDirs(root, SESSION, 'lead').stamped;
    expect(await dueRead()).toContain(`message ${STAMPED_ID} · delivery 1`);
    for (let prompt = 0; prompt < 5; prompt += 1) expect(await dueRead()).not.toContain('the stamped note');
    expect(copyHistory(stamped, STAMPED_ID)).toMatchObject({ copies: 1 });
    age(STAMPED_ID, 61_000);
    expect(await dueRead()).toContain(`message ${STAMPED_ID} · delivery 2`);
    age(STAMPED_ID, 61_000);
    expect(await dueRead()).not.toContain('the stamped note');
    age(STAMPED_ID, 121_000);
    expect(await dueRead()).toContain(`message ${STAMPED_ID} · delivery 3`);
    expect(copyHistory(stamped, STAMPED_ID)).toMatchObject({ copies: 3 });
    // A plain read without --due is unchanged: it hands the message over every time.
    const plain = await hookRead('lead', 'w1:p1');
    expect(plain.out).toContain(`message ${STAMPED_ID} · delivery 4`);
    expect(stampedSettled(stamped, STAMPED_ID, context('lead'), keyOf())).toBe(false);
  });

  test('a pointer does not hold back the first body', async () => {
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    record('lead', STAMPED_ID, 'the stamped note');
    const stamped = seatMailDirs(root, SESSION, 'lead').stamped;
    // A channel copy's number is its push (the send path diet, step 4): the server takes it
    // immediately before the line, so no reserved-but-unsent channel number exists. The watch
    // types an ID-only pointer: copy 1, no body.
    expect(takeCopyNumber(stamped, STAMPED_ID, 'pointer')).toBe(1);
    // The seat's first prompt: the body is handed over.
    expect(await dueRead()).toContain(`message ${STAMPED_ID} · delivery 2`);
    // That read is a recorded handoff: the next prompt inside the step shows nothing again.
    expect(await dueRead()).not.toContain('the stamped note');
  });

  test('a channel push that left is a handoff: the hook waits its step', async () => {
    expect(activate(root, { home, build: 'b', actors: () => [daemon] }).kind).toBe('activated');
    record('lead', STAMPED_ID, 'the stamped note');
    const stamped = seatMailDirs(root, SESSION, 'lead').stamped;
    // The channel copy's entry is the emitted marker: nothing is written beside the record.
    expect(takeCopyNumber(stamped, STAMPED_ID, 'channel', Date.now(), { token: 'a'.repeat(32), listener: '1@then' })).toBe(1);
    expect(await dueRead()).not.toContain('the stamped note');
    age(STAMPED_ID, 61_000);
    expect(await dueRead()).toContain(`message ${STAMPED_ID} · delivery 2`);
  });

  test('the turn-start hook reads with --due', () => {
    const settings = cliHookSettings('/state', { seat: 'lead', session: SESSION }, undefined, undefined, undefined, 'team');
    expect(settings).toContain('drops --read --due --seat');
  });
});
