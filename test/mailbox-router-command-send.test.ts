import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandMailboxSend } from '../src/daemon/mailbox/command-send.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf } from '../src/store/keys.ts';

function payload(id: string): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'helper',
    to_id: null,
    root: '/fixture/root',
    session: 'fixture',
    at: '2026-11-04T02:00:00.000Z',
    body: 'hello\n',
    from: 'grok-bot',
    from_id: null,
    rule: 'the asking principal',
    thread: id,
  };
}

test('a record the principal signed is staged unchanged and then woken', async () => {
  const principalHome = mkdtempSync(join(tmpdir(), 'mailbox-principal-'));
  const noteHome = mkdtempSync(join(tmpdir(), 'mailbox-note-'));
  const dropDir = mkdtempSync(join(tmpdir(), 'mailbox-drop-'));
  const signed = signRecord(payload('m-principal'), principalHome);
  const woken: string[] = [];
  const result = await commandMailboxSend({
    signed,
    publicKey: messageKeyOf(principalHome),
    dropDir,
    home: noteHome,
    project: 'fixture',
    now: () => new Date('2026-11-04T02:00:00.000Z'),
    wake: async (messageId) => {
      woken.push(messageId);
      return true;
    },
  });
  expect(result).toEqual({ ok: true, messageId: 'm-principal', woken: true });
  expect(woken).toEqual(['m-principal']);
  const stored = JSON.parse(readFileSync(join(dropDir, 'm-principal'), 'utf8')) as { signature: string };
  expect(stored.signature).toBe(signed.signature);
});

test('a record that is not the principal\'s is refused before it is staged', async () => {
  const principalHome = mkdtempSync(join(tmpdir(), 'mailbox-principal-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'mailbox-other-'));
  const dropDir = mkdtempSync(join(tmpdir(), 'mailbox-drop-'));
  const signed = signRecord(payload('m-other'), principalHome);
  let woke = 0;
  const result = await commandMailboxSend({
    signed,
    publicKey: messageKeyOf(otherHome),
    dropDir,
    home: otherHome,
    project: 'fixture',
    now: () => new Date('2026-11-04T02:00:00.000Z'),
    wake: async () => {
      woke += 1;
      return true;
    },
  });
  expect(result).toEqual({ ok: false, why: 'the ask is not signed by the asking principal' });
  expect(woke).toBe(0);
  expect(readdirSync(dropDir)).toEqual([]);
});
