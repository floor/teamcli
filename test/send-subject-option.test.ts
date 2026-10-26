// `team send --subject` is a declared option: the parser takes its value, the signed record
// carries it beside the body, and a blank word is no subject at all. It is display only — the
// body is untouched, and the wake line's summary still comes from the body's first content line.
// Fixtures only: a drop-leg team, a fake host, and a temporary home.
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { messageSummaryOf } from '../src/settings/message-display.ts';
import { signedRecordOf, type SignedRecord } from '../src/send/record.ts';
import { dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

/** The one record a drop-leg send left: the leg types nothing and writes this file alone. */
function onlyRecord(w: World): SignedRecord {
  const at = dropDir(w.dir, 'native');
  const names = readdirSync(at).filter((name) => !name.includes('.'));
  expect(names).toHaveLength(1);
  const record = signedRecordOf(JSON.parse(readFileSync(join(at, names[0] as string), 'utf8')));
  if (record === null) throw new Error('the send left no readable signed record');
  return record;
}

describe('team send --subject', () => {
  test('is parsed as a valued option and carried in the signed record', async () => {
    made = world(['drop']);
    const io = owner(made.root);
    expect(await runSend(['native', 'the gate is green', '--subject', 'gate status'], io, fake(made))).toBe(0);
    const record = onlyRecord(made);
    expect(record.payload.subject).toBe('gate status');
    // The subject is display beside the body, never a replacement for its first line.
    expect(record.payload.body).toContain('the gate is green');
    expect(messageSummaryOf(record.payload.body)).toBe('the gate is green');
  });

  test('a blank word is no subject at all', async () => {
    made = world(['drop']);
    const io = owner(made.root);
    expect(await runSend(['native', 'the gate is green', '--subject', '   '], io, fake(made))).toBe(0);
    expect(onlyRecord(made).payload.subject).toBeUndefined();
  });

  test('a missing value is refused as a usage error', async () => {
    made = world(['drop']);
    const io = owner(made.root);
    expect(await runSend(['native', 'the gate is green', '--subject'], io, fake(made))).toBe(2);
    expect(io.err).toContain('--subject');
    expect(io.err).toContain('Usage: team send');
  });
});
