// The record open is the folder check. A real chain is read. A folder in the chain that is a
// link is not followed, so the bytes on the far side of the link are not the record.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkedDropRelative,
  checkedMailboxReceiptRelative,
  checkedMailboxRelative,
  verifiedArrival,
} from '../src/bus/arrival.ts';
import { nodeFolderChain, readSealedRelative, readThrough } from '../src/bus/relative-read.ts';
import { signRecord, type ReceiptPayload, type RecordPayload } from '../src/send/record.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain } from '../src/store/keys.ts';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function world(): { base: string; root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-relative-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'iris'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { base, root, home };
}

function payload(root: string, id: string, from: string): RecordPayload {
  return {
    kind: 'message',
    id,
    to: 'iris',
    to_id: null,
    root,
    session: 'acme',
    at: '2026-11-03T00:00:00.000Z',
    body: 'fixture',
    from,
    from_id: null,
    rule: 'fixture',
    thread: id,
  };
}

test('a record is read through the folder chain, and a linked folder is not followed', () => {
  const { base, root, home } = world();
  const id = 'rec-1';
  writeFileSync(
    join(root, '.agents', 'send-drops', 'acme', 'iris', id),
    JSON.stringify(signRecord(payload(root, id, 'lead'), home)),
  );
  const arrival = verifiedArrival(
    { session: 'acme', seat: 'iris', record_id: id },
    { root, session: 'acme' },
    home,
  );
  expect(arrival?.from).toBe('lead');

  const elsewhere = join(base, 'elsewhere', 'iris');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, id), JSON.stringify(signRecord(payload(root, id, 'other'), home)));
  rmSync(join(root, '.agents', 'send-drops', 'acme'), { recursive: true });
  symlinkSync(join(base, 'elsewhere'), join(root, '.agents', 'send-drops', 'acme'));

  const through = readSealedRelative(root, ['.agents', 'send-drops', 'acme', 'iris'], id);
  expect(through.ok).toBe(false);
  if (!through.ok) expect(through.reason).toBe('a symbolic link was found and not followed');
  expect(verifiedArrival({ session: 'acme', seat: 'iris', record_id: id }, { root, session: 'acme' }, home)).toBeNull();
});

test('refuses path traversal segments, symlinked leaf records, non-directory intermediates, and directory leaves across drop and mailbox readers', () => {
  const { base, root, home } = world();
  const key = messageKeyOf(home);
  const scope = { root, session: 'acme' };
  const seatDir = join(root, '.agents', 'send-drops', 'acme', 'iris');
  const mailboxDir = join(root, '.agents', 'messages', 'iris');
  mkdirSync(mailboxDir, { recursive: true });

  // Invalid segment names (empty, dot, dot-dot, slash, NUL) are rejected before openat.
  for (const bad of ['', '.', '..', 'iris/rec', 'rec\0tail']) {
    const res = readSealedRelative(root, ['.agents', 'send-drops', 'acme', 'iris'], bad);
    expect(res).toEqual({ ok: false, reason: 'the record could not be read' });
    const badFolder = readSealedRelative(root, ['.agents', bad, 'acme', 'iris'], 'rec-1');
    expect(badFolder).toEqual({ ok: false, reason: 'the record could not be read' });
  }

  // A missing leaf returns { ok: true, sealed: null } (missing: true in checkedDropRelative).
  const missingDrop = checkedDropRelative(
    root,
    'acme',
    'iris',
    'no-such-id',
    { session: 'acme', seat: 'iris', record_id: 'no-such-id' },
    scope,
    key,
  );
  expect(missingDrop).toEqual({ ok: false, missing: true, reason: 'the record is missing' });

  // A directory at the leaf record path is refused as not a regular file.
  mkdirSync(join(seatDir, 'dir-leaf'));
  const dirLeaf = checkedDropRelative(
    root,
    'acme',
    'iris',
    'dir-leaf',
    { session: 'acme', seat: 'iris', record_id: 'dir-leaf' },
    scope,
    key,
  );
  expect(dirLeaf).toEqual({ ok: false, reason: 'the record is not a regular file' });

  // A symlinked leaf drop record is refused with 'a symbolic link was found and not followed'.
  const targetFile = join(base, 'target-rec.json');
  writeFileSync(targetFile, JSON.stringify(signRecord(payload(root, 'link-leaf', 'lead'), home)));
  symlinkSync(targetFile, join(seatDir, 'link-leaf'));
  const linkLeaf = checkedDropRelative(
    root,
    'acme',
    'iris',
    'link-leaf',
    { session: 'acme', seat: 'iris', record_id: 'link-leaf' },
    scope,
    key,
  );
  expect(linkLeaf).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });

  // Mailbox record and receipt readers enforce the same relative-open chain and refuse symlinks.
  writeFileSync(join(mailboxDir, 'mb-1.json'), JSON.stringify(signRecord(payload(root, 'mb-1', 'lead'), home)));
  const receiptPayload: ReceiptPayload = {
    kind: 'receipt',
    status: 'read',
    id: 'mb-1',
    to: 'iris',
    root,
    session: 'acme',
    at: '2026-11-03T00:02:00.000Z',
  };
  writeFileSync(
    join(mailboxDir, 'mb-1.read.json'),
    JSON.stringify({ payload: receiptPayload, signature: signDomain(RECEIPT_DOMAIN, receiptPayload, key) }),
  );

  const okMailbox = checkedMailboxRelative(
    root,
    'iris',
    'mb-1.json',
    { session: 'acme', seat: 'iris', record_id: 'mb-1' },
    scope,
    key,
  );
  expect(okMailbox).toEqual({ ok: true, from: 'lead', at: '2026-11-03T00:00:00.000Z' });

  const okReceipt = checkedMailboxReceiptRelative(
    root,
    'iris',
    'mb-1.read.json',
    { session: 'acme', seat: 'iris', record_id: 'mb-1' },
    scope,
    key,
  );
  expect(okReceipt).toEqual({ ok: true, at: '2026-11-03T00:02:00.000Z' });

  unlinkSync(join(mailboxDir, 'mb-1.read.json'));
  symlinkSync(targetFile, join(mailboxDir, 'mb-1.read.json'));
  const linkedReceipt = checkedMailboxReceiptRelative(
    root,
    'iris',
    'mb-1.read.json',
    { session: 'acme', seat: 'iris', record_id: 'mb-1' },
    scope,
    key,
  );
  expect(linkedReceipt).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });
});

test('the node prefix walk, what the built CLI runs, holds the same contract as the dirfd chain', () => {
  const { base, root, home } = world();
  const folders = ['.agents', 'send-drops', 'acme', 'iris'] as const;
  const chain = nodeFolderChain(root);

  // A record is read through the prefix chain.
  const id = 'node-1';
  writeFileSync(
    join(root, '.agents', 'send-drops', 'acme', 'iris', id),
    JSON.stringify(signRecord(payload(root, id, 'lead'), home)),
  );
  const good = readThrough(chain, root, folders, id);
  expect(good.ok).toBe(true);
  if (good.ok) expect(good.sealed?.payload.body).toBe('fixture');

  // A missing leaf, and a missing folder anywhere in the chain, are a missing record.
  expect(readThrough(chain, root, folders, 'no-such-id')).toEqual({ ok: true, sealed: null });
  expect(readThrough(chain, root, ['.agents', 'send-drops', 'gone', 'iris'], id)).toEqual({ ok: true, sealed: null });

  // A linked folder in the chain is not followed.
  const elsewhere = join(base, 'node-elsewhere');
  mkdirSync(elsewhere);
  rmSync(join(root, '.agents', 'send-drops', 'acme'), { recursive: true });
  symlinkSync(elsewhere, join(root, '.agents', 'send-drops', 'acme'));
  const linkedFolder = readThrough(chain, root, folders, id);
  expect(linkedFolder.ok).toBe(false);
  if (!linkedFolder.ok) expect(linkedFolder.reason).toBe('a symbolic link was found and not followed');
  rmSync(join(root, '.agents', 'send-drops', 'acme'));
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'iris'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'send-drops', 'acme', 'iris', id),
    JSON.stringify(signRecord(payload(root, id, 'lead'), home)),
  );

  // A symlinked leaf is refused.
  const targetFile = join(base, 'node-target.json');
  writeFileSync(targetFile, JSON.stringify(signRecord(payload(root, 'node-link', 'other'), home)));
  symlinkSync(targetFile, join(root, '.agents', 'send-drops', 'acme', 'iris', 'node-link'));
  const linkedLeaf = readThrough(chain, root, folders, 'node-link');
  expect(linkedLeaf.ok).toBe(false);
  if (!linkedLeaf.ok) expect(linkedLeaf.reason).toBe('a symbolic link was found and not followed');

  // A directory at the leaf is not a regular file; a bad segment is refused before any open.
  mkdirSync(join(root, '.agents', 'send-drops', 'acme', 'iris', 'node-dir'));
  const dirLeaf = readThrough(chain, root, folders, 'node-dir');
  expect(dirLeaf).toEqual({ ok: false, reason: 'the record is not a regular file' });
  expect(readThrough(chain, root, folders, '..')).toEqual({ ok: false, reason: 'the record could not be read' });
  expect(readThrough(chain, root, folders, 'a/b')).toEqual({ ok: false, reason: 'the record could not be read' });
});
