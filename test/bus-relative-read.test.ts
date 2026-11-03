// The record open is the folder check. A real chain is read. A folder in the chain that is a
// link is not followed, so the bytes on the far side of the link are not the record.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedArrival } from '../src/bus/arrival.ts';
import { readSealedRelative } from '../src/bus/relative-read.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';

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
