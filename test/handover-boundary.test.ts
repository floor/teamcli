// rfc-event-comms E7b, the Boundary section: the delivery history (`.exposures/`) is written only
// inside the comms boundary (src/queue/handover.ts, and the channel attempt retirement that moves
// a channel attempt's markers into it), and the settlement of a stamped record has one rule
// (`isRead` in src/send/record.ts), which every reader, scheduler and retention path already asks.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

/** A source file with its comments taken out. */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the comms boundary (E7b)', () => {
  test('only the hand-over module and the channel attempt retirement name the delivery history', () => {
    const allowed = new Set([join(SRC, 'queue', 'handover.ts'), join(SRC, 'mcp', 'channel.ts')]);
    const offenders = sources(SRC).filter((path) => !allowed.has(path) && readFileSync(path, 'utf8').includes("'.exposures'"));
    expect(offenders).toEqual([]);
  });

  test('numbers are taken only through the hand-over module', () => {
    const offenders = sources(SRC).filter((path) => path !== join(SRC, 'queue', 'handover.ts')
      && /createExclusive\([^)]*EXPOSURES/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('the stamp is decided in one place, at signing', () => {
    const offenders = sources(SRC).filter((path) => path !== join(SRC, 'send', 'record.ts')
      && /lvl:\s*(3|DELIVERY_LEVEL)/.test(code(path)));
    expect(offenders).toEqual([]);
  });

  test('every read receipt this build writes comes from a known writer (a stamped record\'s read is a copy or a confirmation)', () => {
    // readMessage and publishRecordRead mark a stamped record's writer-side read `copy`; ack, the
    // lead's clearance, reply and answered-by-send confirm; the retention pre-channel mark skips
    // stamped records; the client inbox writes only for client records, which are never stamped.
    const known = new Set([
      join(SRC, 'mcp', 'inbox.ts'), join(SRC, 'send', 'read-receipt.ts'), join(SRC, 'commands', 'ack.ts'),
      join(SRC, 'send', 'inbox-retention.ts'), join(SRC, 'client', 'inbox.ts'), join(SRC, 'commands', 'messages.ts'),
      join(SRC, 'send', 'record.ts'),
    ]);
    const writers = sources(SRC).filter((path) => /kind: 'receipt',\s*status: 'read'/.test(code(path)));
    expect(writers.filter((path) => !known.has(path))).toEqual([]);
  });
});
