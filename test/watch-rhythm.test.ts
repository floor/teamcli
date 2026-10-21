import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  parseWatchRhythmValue,
  resolvePolicy,
  watchRhythmValueOf,
  WATCH_RHYTHM_FACTOR,
  WATCH_RHYTHM_SWEEP,
  type Policy,
} from '../src/policy/index.ts';
import type { Standing } from '../src/store/store.ts';
import { applyWatchPace, watchInForceWithPace, watchPaceNotes, watchPaceOf } from '../src/watch/rhythm.ts';

const NOW = Date.parse('2026-10-20T03:00:00Z');
const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function declaration(value: string, level: 'entity' | 'project' | 'team' = 'team'): Policy {
  return {
    name: 'watch-rhythm',
    value,
    level,
    setter: 'owner',
    date: '2026-10-20T00:00:00.000Z',
    kind: 'enforced',
  };
}

function verified(team: TeamFile, root: string): Standing {
  return verifiedOf(team, join(root, '.agents', 'team.yaml'), root, new Date(NOW));
}

let root = '';
let home = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watch-rhythm-'));
  home = join(root, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the watch-rhythm policy value', () => {
  test('a preset, a canonical value and a mapping all normalize to one scalar', () => {
    expect(parseWatchRhythmValue('night')).toBe('night');
    expect(parseWatchRhythmValue('night@600')).toBe('night@600');
    expect(parseWatchRhythmValue({ preset: 'night', sweepSeconds: 600 })).toBe('night@600');
    expect(parseWatchRhythmValue({ preset: 'night' })).toBe('night');
    expect(parseWatchRhythmValue(' relaxed ')).toBe('relaxed');
    expect(watchRhythmValueOf('night')).toEqual({ preset: 'night', sweepSeconds: WATCH_RHYTHM_SWEEP.night });
    expect(watchRhythmValueOf('relaxed@30')).toEqual({ preset: 'relaxed', sweepSeconds: 30 });
  });

  test('an unknown preset, an out-of-range sweep and an unknown field are refused', () => {
    expect(parseWatchRhythmValue('late')).toBeNull();
    expect(parseWatchRhythmValue('night@5')).toBeNull();
    expect(parseWatchRhythmValue('night@90000')).toBeNull();
    expect(parseWatchRhythmValue('night@1.5')).toBeNull();
    expect(parseWatchRhythmValue({ preset: 'night', sweepSeconds: 5 })).toBeNull();
    expect(parseWatchRhythmValue({ preset: 'night', extra: true })).toBeNull();
    expect(parseWatchRhythmValue({})).toBeNull();
    expect(parseWatchRhythmValue(42)).toBeNull();
  });

  test('the comparison is tighter on both axes: sweep and wait factor', () => {
    const checks = (lower: string, higher: string): boolean | undefined => {
      const resolved = resolvePolicy('watch-rhythm', [
        declaration(higher, 'entity'),
        declaration(lower, 'team'),
      ]);
      return resolved.ok ? true : resolved.refusals.every((refusal) => refusal.kind === 'loosening') ? false : undefined;
    };
    // Tighter on both axes, equal axes and equal values are within.
    expect(checks('urgent', 'normal')).toBe(true);
    expect(checks('night@60', 'dormant@3600')).toBe(true);
    expect(checks('dormant@60', 'dormant@3600')).toBe(true);
    // A quiet preset with a short sweep cannot slip past an ancestor's wait ceiling.
    expect(checks('dormant@60', 'normal@120')).toBe(false);
    expect(checks('relaxed@60', 'normal@120')).toBe(false);
    // A fast preset with a long sweep cannot slip past an ancestor's sweep ceiling.
    expect(checks('urgent@3600', 'normal@120')).toBe(false);
    expect(checks('normal@500', 'normal@120')).toBe(false);
    expect(checks('night@600', 'night@600')).toBe(true);
  });

  test('only an explicit ancestor bounds a team; the default does not', () => {
    // No ancestor declaration at all: a team may choose the quietest preset.
    const alone = resolvePolicy('watch-rhythm', [declaration('dormant')]);
    expect(alone.ok).toBe(true);
    if (alone.ok) expect(alone.effective.value).toBe('dormant');
    // An explicit ancestor does bound it.
    const bounded = resolvePolicy('watch-rhythm', [
      declaration('normal', 'entity'),
      declaration('dormant', 'team'),
    ]);
    expect(bounded.ok).toBe(false);
    if (!bounded.ok) expect(bounded.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'watch-rhythm' });
  });
});

describe('the pace in force', () => {
  test('a verified file converts tempo and interval, keeping them independent', () => {
    const text = example
      .replace('format: 1\n', 'format: 1\ntempo: relaxed\n')
      .replace('interval: 120s', 'interval: 30s');
    const team = teamOf(text);
    const standing = verified(team, root);
    const pace = watchPaceOf({ team, root, home, standing, now: new Date(NOW) });
    expect(pace).toMatchObject({ preset: 'relaxed', sweepSeconds: 30, source: 'file', normalized: null, setAside: [] });
    expect(pace.unknown).toBeUndefined();

    const inForce = watchInForceWithPace(standing, team, pace);
    expect(inForce.interval).toBe(30);
    // Tempo is the wait factor only; the sweep is the file's interval, unchanged by relaxed.
    expect(inForce.idleFirst).toBe(600);
    expect(inForce.teamIdle).toBe(1200);
    expect(inForce.nudgeWait).toBe(1200);
    expect(inForce.unsentAfter).toBe(120);
    expect(inForce.unreadAfter).toBe(1200);
    expect(inForce.idleRepeat).toBe(2400);
  });

  test('the sweep floor normalizes a legacy 5s interval and says so', () => {
    const team = teamOf(example.replace('interval: 120s', 'interval: 5s'));
    const standing = verified(team, root);
    const pace = watchPaceOf({ team, root, home, standing, now: new Date(NOW) });
    expect(pace).toMatchObject({
      preset: 'normal',
      sweepSeconds: 10,
      source: 'file',
      normalized: { field: 'watch.interval', declared: 5, used: 10 },
    });
    expect(watchPaceNotes(pace)).toEqual([
      'watch.interval 5s is below the 10s sweep floor; sweeping every 10s',
    ]);
  });

  test('the sweep ceiling normalizes a longer interval', () => {
    const team = teamOf(example.replace('interval: 120s', 'interval: 100000s'));
    const standing = verified(team, root);
    const pace = watchPaceOf({ team, root, home, standing, now: new Date(NOW) });
    expect(pace).toMatchObject({ sweepSeconds: 86_400, normalized: { declared: 100_000, used: 86_400 } });
    expect(watchPaceNotes(pace)[0]).toContain('above the 24h sweep ceiling');
  });

  test('a verified file with no watch section runs the defaults and no tempo scaling', () => {
    const team = teamOf(example.replace('interval: 120s', 'interval: 120s'));
    const pace = watchPaceOf({ team, root, home, standing: { kind: 'none' }, now: new Date(NOW) });
    expect(pace).toMatchObject({ preset: 'normal', sweepSeconds: 120, source: 'default', normalized: null, setAside: [] });
    const inForce = watchInForceWithPace({ kind: 'none' }, team, pace);
    expect(inForce.idleFirst).toBe(300);
    expect(inForce.interval).toBe(120);
  });

  test('a preset-only signed rhythm uses its nominal sweep', () => {
    for (const preset of ['urgent', 'normal', 'relaxed', 'night', 'dormant'] as const) {
      const value = watchRhythmValueOf(preset);
      expect(value).not.toBeNull();
      expect(value?.sweepSeconds).toBe(WATCH_RHYTHM_SWEEP[preset]);
      expect(value?.preset).toBe(preset);
    }
  });

  test('the six waits scale by the preset factor, clamp at one and a day, and an absent idleRepeat stays absent', () => {
    const noRepeat = example.replace('  idle_repeat: 20m             # between reports while it stays idle\n', '');
    const team = teamOf(noRepeat);
    for (const preset of ['urgent', 'normal', 'relaxed', 'night', 'dormant'] as const) {
      const base = {
        interval: 120,
        idleFirst: 300,
        idleOwner: 900,
        blindAfter: 300,
        teamIdle: 600,
        nudgeWait: 600,
        unsentAfter: 1,
        unreadAfter: 86_400,
        quotaMarks: [50, 75, 90],
        checks: [],
      };
      const paced = applyWatchPace(base, { preset, sweepSeconds: 500 });
      expect(paced.interval).toBe(500);
      expect(paced.idleFirst).toBe(Math.min(86_400, Math.max(1, Math.round(300 * WATCH_RHYTHM_FACTOR[preset]))));
      expect(paced.idleOwner).toBe(900);
      expect(paced.blindAfter).toBe(300);
      expect(paced.unsentAfter).toBe(Math.min(86_400, Math.max(1, Math.round(1 * WATCH_RHYTHM_FACTOR[preset]))));
      expect(paced.unreadAfter).toBe(Math.min(86_400, Math.max(1, Math.round(86_400 * WATCH_RHYTHM_FACTOR[preset]))));
      expect(paced.idleRepeat).toBeUndefined();
    }
    // An omitted idleRepeat in the file stays omitted through the pass values too.
    const inForce = watchInForceWithPace(verified(team, root), team, {
      preset: 'night',
      sweepSeconds: 600,
      source: 'file',
      normalized: null,
      setAside: [],
    });
    expect(inForce.idleRepeat).toBeUndefined();
    expect(inForce.interval).toBe(600);
    expect(inForce.idleFirst).toBe(3600);
  });

  test('an unsigned or missing policy chain is unknown, reported, and falls back only for reading', () => {
    const team = teamOf(`${example}\npolicies:\n  watch-rhythm: dormant\n`);
    const standing = verified(team, root);
    const pace = watchPaceOf({ team, root, home, standing, now: new Date(NOW) });
    expect(pace.source).toBe('file');
    expect(pace.sweepSeconds).toBe(120);
    expect(pace.unknown).toBeDefined();
    expect(watchPaceNotes(pace)[0]).toContain('automated work, nudges and escalations are held');

    const withoutHome = watchPaceOf({ team, root, home: undefined, standing, now: new Date(NOW) });
    expect(withoutHome.unknown).toBe('there is no home to read the watch-rhythm policy chain from');
  });
});
