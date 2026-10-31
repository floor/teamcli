// The accepted frame's name fallback: nickname, then the written label's name, then the seat.
//
// Contract pinned by builder-5 for #682: the opening line is `Message from <name> (<seat>@<team>)`.
// <name> is the seat's signed nickname setting, else the roster nickname, else the written
// `label:` of the sender's seat stanza in the sending run's own team file — the text before the
// first middle dot, trimmed, the whole label when it holds none — and the seat name only when
// none of those stands. A seat with no written label, or a label whose name is empty after
// trimming, falls through. The line is display only: the signed record keeps its own
// `from … — admitted by: …` line, the typed wake is untouched, and owner frames read `owner`.
// The scenes are synthetic: a temporary world, a fake socket and a string pane.
import { afterEach, expect, test } from 'bun:test';
import { runSend } from '../../src/commands/send.ts';
import { testIo } from '../helpers.ts';
import {
  acceptSocket,
  book,
  declareEntity,
  dropsOf,
  frameOf,
  helperIo,
  hostOf,
  recordOf,
  registerHelper,
  world,
  type World,
} from './fixtures.ts';
import { labelSeat } from './label-fixtures.ts';

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function ownerIo(root: string) {
  return testIo(root, { kind: 'owner' });
}

test('an accepted frame reads the written label name when no nickname stands', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  labelSeat(one, 'helper', 'Bea · implementer');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  expect(host.frames.length).toBe(1);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  const lines = frame.content.split('\n');
  // The label's name precedes the middle dot; the address stays the record's own seat.
  expect(lines[0]).toBe('Message from Bea (helper@acme)');
  expect(lines[1]).toBe('');
  // Display only: the body keeps its own attribution (no nickname stands there either), and the
  // signed bytes never carry the display header.
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from');
  expect(record.raw).not.toContain('Bea');
  expect(frame.content).toContain(`Message from Bea (helper@acme)\n\n${record.body}`);
});

test('a nickname stands over the written label name', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  labelSeat(one, 'helper', 'Ada · implementer');
  registerHelper(one, 'Bea');
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  // The roster nickname wins; the label's name is never printed.
  expect(frame.content.split('\n')[0]).toBe('Message from Bea (helper@acme)');
  expect(record.body.startsWith('from Bea — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Ada');
});

test('a written label with no middle dot is the whole name', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  labelSeat(one, 'helper', 'Bea');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  expect(frame.content.split('\n')[0]).toBe('Message from Bea (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Message from');
});

test('no written label falls through to the seat name, and another seat label names nothing', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  // Only the lead carries a written label: the sender's own stanza has none.
  labelSeat(one, 'lead', 'Dora · coordinator');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  // The default title (model and version) is no name, and the lead's label is not the sender's.
  expect(frame.content.split('\n')[0]).toBe('Message from helper (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
  expect(record.raw).not.toContain('Dora');
});

test('a written label whose name is empty before the middle dot falls through to the seat', async () => {
  const one = world(['socket']);
  made = one;
  acceptSocket(one);
  labelSeat(one, 'helper', ' · implementer');
  registerHelper(one, null);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], helperIo(one), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  // No blank name and no stray dot: the seat name stands.
  expect(frame.content.split('\n')[0]).toBe('Message from helper (helper@acme)');
  expect(record.body.startsWith('from helper — admitted by: ')).toBe(true);
});

test('an owner frame reads owner, not a seat label', async () => {
  const one = world(['socket']);
  made = one;
  declareEntity(one);
  labelSeat(one, 'lead', 'Dora · coordinator');
  acceptSocket(one);
  const host = hostOf(one, book());
  const drops = dropsOf(one);

  expect(await runSend(['lead', 'a note'], ownerIo(one.root), host)).toBe(0);
  const frame = frameOf(host.frames);
  const record = recordOf(drops);
  // The caller is not a seat: no label is read, and the owner's line is unchanged.
  expect(frame.content.split('\n')[0]).toBe('Message from owner (owner@acme)');
  expect(record.body.startsWith('from the owner — admitted by: ')).toBe(true);
});
