// A refusal is said once while the path is still there, and dropped when the path is gone.
// The cache does not keep a path the pass no longer meets.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReconcileState, reconcilePass } from '../src/bus/reconcile.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

test('a refusal is kept while the path remains and dropped once the path is gone', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-refused-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const seat = join(root, '.agents', 'send-drops', 'acme', 'helper');
  mkdirSync(seat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);
  const first = join(seat, 'bad-one');
  const second = join(seat, 'bad-two');
  writeFileSync(first, '{}\n');
  writeFileSync(second, '{}\n');
  const state = createReconcileState();
  const said: string[] = [];
  const pass = () => reconcilePass({
    project: 'acme',
    root,
    session: 'acme',
    home,
    state,
    onRefused: (refusal) => said.push(refusal.where),
  });
  pass();
  expect(said).toEqual(['helper/bad-one', 'helper/bad-two']);
  expect(state.refused.has(`record\0${first}`)).toBe(true);
  said.length = 0;
  pass();
  expect(said).toEqual([]);
  expect(state.refused.size).toBe(2);
  rmSync(first);
  pass();
  expect(state.refused.has(`record\0${first}`)).toBe(false);
  expect(state.refused.has(`record\0${second}`)).toBe(true);
  rmSync(second);
  pass();
  expect(state.refused.size).toBe(0);
});

test('evicts refusal cache entries across drop and mailbox trees when repaired or removed, and re-reports if broken again', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-refused-adv-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dropSeat = join(root, '.agents', 'send-drops', 'acme', 'helper');
  const mailboxSeat = join(root, '.agents', 'messages', 'helper');
  mkdirSync(dropSeat, { recursive: true });
  mkdirSync(mailboxSeat, { recursive: true });
  mkdirSync(home, { recursive: true });
  messageKeyOf(home);

  const dropPath = join(dropSeat, 'rec-1');
  const mailboxRecordPath = join(mailboxSeat, 'mb-1.json');
  const mailboxReceiptPath = join(mailboxSeat, 'mb-1.read.json');
  writeFileSync(dropPath, 'not-json\n');
  writeFileSync(mailboxRecordPath, '{"payload":{},"signature":"bad"}\n');
  writeFileSync(mailboxReceiptPath, '{"payload":{},"signature":"bad"}\n');

  const state = createReconcileState();
  const said: string[] = [];
  const pass = () =>
    reconcilePass({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      onRefused: (refusal) => said.push(`${refusal.where}:${refusal.reason}`),
    });

  pass();
  expect(said).toEqual([
    'helper/rec-1:the record is not JSON',
    "helper/mb-1:the record is not signed with this checkout's message key",
    "helper/mb-1:read:the receipt is not signed with this checkout's message key",
  ]);
  expect(state.refused.size).toBe(3);

  // Quiet pass while all three remain unchanged: cached entries keep `refusedNow` populated.
  said.length = 0;
  pass();
  expect(said).toEqual([]);
  expect(state.refused.size).toBe(3);

  // Repair `rec-1` in place with a valid signed record and remove the two broken mailbox files.
  const validPayload: RecordPayload = {
    kind: 'message',
    id: 'rec-1',
    to: 'helper',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-03T00:05:00.000Z',
    body: 'repaired',
    from: 'lead',
    from_id: null,
    rule: 'fixture',
    thread: 'rec-1',
  };
  writeFileSync(dropPath, JSON.stringify(signRecord(validPayload, home)));
  rmSync(mailboxRecordPath);
  rmSync(mailboxReceiptPath);

  const repaired = pass();
  expect(repaired.ok).toBe(true);
  if (repaired.ok) {
    expect(repaired.raised.map((e) => `${e.payload.kind}:${e.payload.record_id}`)).toEqual([
      'message.arrived:rec-1',
    ]);
  }
  expect(said).toEqual([]);
  expect(state.refused.size).toBe(0);

  // If a corrupt file reappears at the previously evicted mailbox path, it is reported afresh.
  writeFileSync(mailboxRecordPath, 'corrupt-again\n');
  pass();
  expect(said).toEqual(['helper/mb-1:the record is not JSON']);
  expect(state.refused.has(`mailbox-record\0${mailboxRecordPath}`)).toBe(true);
});
