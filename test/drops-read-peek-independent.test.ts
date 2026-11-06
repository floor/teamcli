// A read of another seat's waiting messages. Only the seat itself writes a receipt.
// The owner and the lead are shown the body and write nothing, so the drop stays
// unread for the seat. Any other caller is refused before a record is read.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { runDrops } from '../src/commands/drops.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { listUnread, receiptPath } from '../src/mcp/inbox.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const BODY = 'the waiting line for this seat';
const DROP_ID = '11111111-1111-4111-8111-111111111111';
const CLERK_PANE = 'fixture-pane-one';
const KEEPER_PANE = 'fixture-pane-two';
const bases: string[] = [];

afterEach(() => {
  const held = bases.splice(0);
  discardFixtures(held, { roots: held.map((base) => dirname(base)) });
});

function world(): { home: string; root: string } {
  const base = fixtureBase('drops-read-peek-');
  bases.push(base);
  const home = join(base, 'throwaway-home');
  const root = realpathSync(mkdirSync(join(base, 'oak'), { recursive: true }) ?? join(base, 'oak'));
  mkdirSync(join(root, '.agents'), { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: oak
coordinator: keeper
operator: keeper
session: morning
workspace:
  mode: shared
seats:
  - role: coordinator
    name: keeper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: clerk
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  updateState(join(root, '.agents'), (state) => {
    state.sessions.morning = {
      seats: {
        clerk: { stage: 'ready' as const, pane: CLERK_PANE },
        keeper: { stage: 'ready' as const, pane: KEEPER_PANE },
      },
    } as never;
  });
  return { home, root };
}

function plant(home: string, root: string, seat: string): void {
  plantRecord(home, root, 'morning', seat, DROP_ID, BODY, {
    from: 'clerk',
    rule: 'a seat to a seat of its own team',
  });
}

function waiting(home: string, root: string, seat: string): string[] {
  const dropDir = join(root, '.agents', 'send-drops', 'morning', seat);
  return listUnread(dropDir, { to: seat, root, session: 'morning' }, home).map((message) => message.id);
}

async function readSeat(
  home: string,
  root: string,
  seat: string,
  caller: Caller,
): Promise<{ code: number; out: string; err: string; receipt: string }> {
  const io = testIo(root, caller);
  const code = await runDrops(['--read', '--seat', seat, '--session', 'morning'], io, { home });
  const receipt = receiptPath(join(root, '.agents', 'send-drops', 'morning', seat), DROP_ID);
  return { code, out: io.out, err: io.err, receipt };
}

test('a seat that is not the lead is refused before a record is read, and no receipt is written', async () => {
  const { home, root } = world();
  plant(home, root, 'keeper');
  const got = await readSeat(home, root, 'keeper', { kind: 'seat', name: 'clerk', pane: CLERK_PANE, session: 'morning' });
  expect(got.code).toBe(1);
  expect(got.out).toBe('');
  expect(got.err).toContain('this call is clerk');
  expect(got.out).not.toContain(BODY);
  expect(existsSync(got.receipt)).toBe(false);
  expect(waiting(home, root, 'keeper')).toEqual([DROP_ID]);
});

test('the seat itself is served its own drop and a receipt is written', async () => {
  const { home, root } = world();
  plant(home, root, 'keeper');
  const got = await readSeat(home, root, 'keeper', { kind: 'seat', name: 'keeper', pane: KEEPER_PANE, session: 'morning' });
  expect(got.code).toBe(0);
  expect(got.out).toContain(BODY);
  expect(existsSync(got.receipt)).toBe(true);
  expect(waiting(home, root, 'keeper')).toEqual([]);
});

test('the owner is shown another seat\'s drop and writes no receipt, so the seat can still read it', async () => {
  const { home, root } = world();
  plant(home, root, 'keeper');
  const peeked = await readSeat(home, root, 'keeper', { kind: 'owner' });
  expect(peeked.code).toBe(0);
  expect(peeked.out).toContain(BODY);
  expect(existsSync(peeked.receipt)).toBe(false);
  expect(waiting(home, root, 'keeper')).toEqual([DROP_ID]);
  expect(readFileSync(join(root, '.agents', LOG_FILE), 'utf8')).toContain(`peek [owner] keeper: ${DROP_ID}`);

  const own = await readSeat(home, root, 'keeper', { kind: 'seat', name: 'keeper', pane: KEEPER_PANE, session: 'morning' });
  expect(own.code).toBe(0);
  expect(own.out).toContain(BODY);
  expect(existsSync(own.receipt)).toBe(true);
  expect(waiting(home, root, 'keeper')).toEqual([]);
});

test('the lead is shown another seat\'s drop from its own pane and writes no receipt', async () => {
  const { home, root } = world();
  plant(home, root, 'clerk');
  const peeked = await readSeat(home, root, 'clerk', { kind: 'seat', name: 'keeper', pane: KEEPER_PANE, session: 'morning' });
  expect(peeked.code).toBe(0);
  expect(peeked.out).toContain(BODY);
  expect(existsSync(peeked.receipt)).toBe(false);
  expect(waiting(home, root, 'clerk')).toEqual([DROP_ID]);
  expect(readFileSync(join(root, '.agents', LOG_FILE), 'utf8')).toContain(`peek [keeper] clerk: ${DROP_ID}`);

  const own = await readSeat(home, root, 'clerk', { kind: 'seat', name: 'clerk', pane: CLERK_PANE, session: 'morning' });
  expect(own.code).toBe(0);
  expect(own.out).toContain(BODY);
  expect(existsSync(own.receipt)).toBe(true);
});

test('a caller that is not placed is refused before a record is read', async () => {
  const { home, root } = world();
  plant(home, root, 'keeper');
  const got = await readSeat(home, root, 'keeper', { kind: 'unplaced', reason: 'the caller is not placed' });
  expect(got.code).toBe(1);
  expect(got.out).toBe('');
  expect(got.out).not.toContain(BODY);
  expect(existsSync(got.receipt)).toBe(false);
  expect(waiting(home, root, 'keeper')).toEqual([DROP_ID]);
});
