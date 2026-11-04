// The bus log's two settings as owner-set policies: the segment size (`bus.segment_mb`, the
// catalogue policy `event-segment-mb`) and the retention window (`bus.retain_days`, the existing
// `event-retention-days` policy with the explicit keep-all words). The scenes pin the words each
// parser reads, the tighten-only order with keep-all loosest, and the two places a zero window
// must mean "no age bound" rather than "everything is old".
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, EVENT_LOG_TOTAL_BYTES, eventLogPath, pruneEventLog, readEvents } from '../src/bus/log.ts';
import {
  EVENT_SEGMENT_BYTES,
  EVENT_SEGMENT_MB,
  EVENT_SEGMENT_MB_MAX,
  eventThresholdsOf,
  getPolicySpec,
  resolvePolicy,
  type Policy,
  type PolicyLevel,
  type PolicyValue,
} from '../src/policy/index.ts';

const NOW = new Date('2026-10-19T12:00:00.000Z');

function declaration(name: string, value: PolicyValue, level: PolicyLevel): Policy {
  return { name, value, level, setter: 'owner', date: NOW.toISOString(), kind: 'enforced' };
}

const dirs: string[] = [];

function makeScratch(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-bus-log-settings-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  mkdirSync(home);
  mkdirSync(root);
  return { root, home };
}

function appendOne(root: string, home: string, id: string, retentionSeconds?: number): void {
  const appended = appendEvent(
    'acme',
    root,
    home,
    {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'message.arrived',
      session: 'acme',
      record_id: id,
    },
    {
      retain: false,
      ...(retentionSeconds === undefined ? {} : { retentionSeconds }),
    },
  );
  if (!appended.ok) throw new Error(appended.reason);
}

function ageFile(path: string, at: Date): void {
  utimesSync(path, at.getTime() / 1_000, at.getTime() / 1_000);
}

function idsRead(root: string, home: string): string[] {
  const read = readEvents('acme', root, home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((event) => event.payload.record_id);
}

describe('the bus log settings', () => {
  test('the segment size is a catalogue policy at the event levels, its fallback the shipped 8 MB', () => {
    const spec = getPolicySpec('bus.segment_mb');
    expect(spec?.name).toBe('event-segment-mb');
    expect(spec?.kind).toBe('enforced');
    expect(spec?.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(spec?.defaultValue).toBe(EVENT_SEGMENT_MB);
    expect(EVENT_SEGMENT_MB).toBe(8);
    expect(EVENT_SEGMENT_BYTES).toBe(8_000_000);
    // The upper bound is half the retained-size cap: a full live segment and its predecessor
    // must both fit, or every sealed segment would be dropped as soon as it was written.
    expect(EVENT_SEGMENT_MB_MAX * 2_000_000).toBe(EVENT_LOG_TOTAL_BYTES);
  });

  test('the segment-size parser reads whole megabytes from 1 to half the cap and refuses the rest', () => {
    const spec = getPolicySpec('event-segment-mb');
    for (const [raw, want] of [
      [1, 1],
      [8, 8],
      ['12', 12],
      [EVENT_SEGMENT_MB_MAX, EVENT_SEGMENT_MB_MAX],
      [String(EVENT_SEGMENT_MB_MAX), EVENT_SEGMENT_MB_MAX],
    ] as const) {
      expect(spec?.parseValue(raw)).toBe(want);
    }
    for (const raw of [0, -1, 1.5, EVENT_SEGMENT_MB_MAX + 1, String(EVENT_SEGMENT_MB_MAX + 1), '8MB', '0', true, null]) {
      expect(spec?.parseValue(raw)).toBeNull();
    }
  });

  test('the retention parser reads a whole count, or the explicit keep-all words 0 and all', () => {
    const spec = getPolicySpec('bus.retain_days');
    expect(spec?.name).toBe('event-retention-days');
    expect(spec?.defaultValue).toBe(30);
    expect(spec?.parseValue(30)).toBe(30);
    expect(spec?.parseValue('7')).toBe(7);
    expect(spec?.parseValue(0)).toBe(0);
    expect(spec?.parseValue('0')).toBe(0);
    expect(spec?.parseValue('all')).toBe(0);
    expect(spec?.parseValue(' all ')).toBe(0);
    for (const raw of [-1, 1.5, 'none', '0.5', '', true, null]) {
      expect(spec?.parseValue(raw)).toBeNull();
    }
  });

  test('keep-all is looser than every positive count, and absence still resolves to 30 days', () => {
    const name = 'event-retention-days';
    const keepAll = resolvePolicy(name, [declaration(name, 0, 'entity')]);
    expect(keepAll.ok).toBe(true);
    if (keepAll.ok) expect(keepAll.effective.value).toBe(0);

    const narrowed = resolvePolicy(name, [
      declaration(name, 0, 'entity'),
      declaration(name, 7, 'team'),
    ]);
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.effective.value).toBe(7);

    // Keep-all loosens a finite window; a finite window tightens keep-all.
    const renewed = resolvePolicy(name, [
      declaration(name, 0, 'entity'),
      declaration(name, 30, 'team'),
    ]);
    expect(renewed.ok).toBe(true);
    if (renewed.ok) expect(renewed.effective.value).toBe(30);

    for (const [higher, lower] of [
      [30, 0],
      [7, 30],
    ] as const) {
      const loosened = resolvePolicy(name, [
        declaration(name, higher, 'entity'),
        declaration(name, lower, 'team'),
      ]);
      expect(loosened.ok).toBe(false);
      if (!loosened.ok) expect(loosened.refusals[0]?.kind).toBe('loosening');
    }

    const absent = eventThresholdsOf({});
    expect(absent.retention_days).toBe(30);

    const effective = resolvePolicy(name, [declaration(name, 0, 'entity')]);
    expect(effective.ok).toBe(true);
    if (effective.ok) {
      const thresholds = eventThresholdsOf({ [name]: effective.effective });
      expect(thresholds.retention_days).toBe(0);
    }
  });
});

describe('a keep-all window in the log', () => {
  test('the prune pass neither seals nor drops an idle segment', () => {
    const { root, home } = makeScratch();
    appendOne(root, home, 'old-1');
    const path = eventLogPath('acme', root, home);
    ageFile(path, new Date('2026-01-01T00:00:00.000Z'));

    pruneEventLog('acme', root, home, { retentionSeconds: 0 });

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(idsRead(root, home)).toEqual(['old-1']);
  });

  test('an append with a zero window writes beside an old segment rather than rotating it away', () => {
    const { root, home } = makeScratch();
    appendOne(root, home, 'old-1');
    const path = eventLogPath('acme', root, home);
    ageFile(path, new Date('2026-01-01T00:00:00.000Z'));

    appendOne(root, home, 'new-1', 0);

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(idsRead(root, home)).toEqual(['old-1', 'new-1']);
  });
});
