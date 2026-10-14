import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { approvalOf, approvedFingerprints, watchInForceOf } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import { runTempo, setTempo } from '../src/commands/tempo.ts';
import { applyTempo } from '../src/file/sections/tempo.ts';
import type { TeamFile } from '../src/file/types.ts';
import { defaultWatch, validateTeamFile } from '../src/file/validate.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
watch:
  idle_first: 10m
  idle_repeat: 20m
  team_idle: 10m
  nudge_wait: 10m
  unsent_after: 1m
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function verified(file: string, team: TeamFile): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: '2026-10-14T00:00:00.000Z',
    record: { approval: approvalOf(team, '/proj'), file },
  };
}

/** A record from before the key: the stored fingerprints have no `tempo`. */
function predating(file: string, team: TeamFile): Extract<Standing, { kind: 'verified' }> {
  const standing = verified(file, team);
  if (standing.kind !== 'verified') throw new Error('unreachable');
  const { tempo: _omitted, ...sections } = standing.record.approval.fingerprints.sections;
  standing.record.approval.fingerprints = { ...standing.record.approval.fingerprints, sections };
  return standing;
}

describe('tempo', () => {
  test('an omitted key is normal, and a word outside the three is refused', () => {
    expect(parsed(TEAM).tempo).toBe('normal');
    const written = parsed(`${TEAM}tempo: normal\n`);
    expect(written.tempo).toBe('normal');
    expect(fingerprints(written).sections.tempo).toBe(fingerprints(parsed(TEAM)).sections.tempo);
    const refused = validateTeamFile(`${TEAM}tempo: faster\n`);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.map((error) => error.message)).toContain('tempo must be one of: relaxed, normal, urgent');
  });

  test('relaxed doubles the five waits, urgent halves them, and a repeat that is off stays off', () => {
    const watch = parsed(TEAM).watch;
    expect(applyTempo(watch, 'normal')).toBe(watch);
    const relaxed = applyTempo(watch, 'relaxed');
    expect(relaxed.idleFirst).toBe(1200);
    expect(relaxed.idleRepeat).toBe(2400);
    expect(relaxed.teamIdle).toBe(1200);
    expect(relaxed.nudgeWait).toBe(1200);
    expect(relaxed.unsentAfter).toBe(120);
    expect(relaxed.interval).toBe(watch.interval);
    const urgent = applyTempo(watch, 'urgent');
    expect(urgent.idleFirst).toBe(300);
    expect(urgent.idleRepeat).toBe(600);
    expect(urgent.unsentAfter).toBe(30);
    expect(urgent.interval).toBe(watch.interval);
    const off = defaultWatch();
    expect(applyTempo(off, 'relaxed').idleRepeat).toBeUndefined();
    expect(applyTempo(off, 'urgent').idleRepeat).toBeUndefined();
    expect(applyTempo({ ...off, unsentAfter: 1 }, 'urgent').unsentAfter).toBe(1);
    expect(applyTempo({ ...off, unsentAfter: 3 }, 'urgent').unsentAfter).toBe(2);
  });

  test('the line is inserted after format, and a line that already says the word is kept', () => {
    const inserted = setTempo(TEAM, 'urgent');
    expect(inserted.startsWith('format: 1\ntempo: urgent\nproject: acme\n')).toBe(true);
    const quoted = TEAM.replace('format: 1\n', 'format: 1\ntempo: "urgent" # kept\n');
    expect(setTempo(quoted, 'urgent')).toBe(quoted);
    expect(setTempo(quoted, 'relaxed')).toContain('tempo: relaxed # kept\n');
  });

  test('a record from before the key still matches, and urgent is a difference until it is approved', () => {
    const team = parsed(TEAM);
    const old = predating(TEAM, team);
    expect(compare(approvedFingerprints(old.record), fingerprints(team))).toEqual([]);
    const urgentText = setTempo(TEAM, 'urgent');
    const urgent = parsed(urgentText);
    expect(compare(approvedFingerprints(old.record), fingerprints(urgent)).map(describeDifference)).toEqual(['`tempo` changed']);
    const normal = parsed(setTempo(TEAM, 'normal'));
    expect(compare(approvedFingerprints(old.record), fingerprints(normal))).toEqual([]);
    expect(watchInForceOf(old, urgent).idleFirst).toBe(600);
    expect(watchInForceOf(old, urgent).interval).toBe(team.watch.interval);
    expect(watchInForceOf(verified(urgentText, urgent), urgent).idleFirst).toBe(300);
    expect(watchInForceOf(verified(urgentText, urgent), urgent).idleRepeat).toBe(600);
    expect(watchInForceOf(verified(urgentText, urgent), urgent).interval).toBe(team.watch.interval);
    expect(watchInForceOf({ kind: 'none' }, urgent)).toEqual(defaultWatch());
  });
});

describe('team tempo', () => {
  const files: string[] = [];

  afterEach(() => {
    for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function place(): { root: string; home: string; file: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-tempo-')));
    files.push(base);
    const root = join(base, 'acme');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, TEAM);
    return { root, home, file };
  }

  test('the owner writes the word, and the same word again leaves the file', async () => {
    const where = place();
    const io = testIo(where.root, { kind: 'owner' });
    expect(await runTempo(['urgent'], io, { home: where.home })).toBe(0);
    expect(io.out).toBe('tempo: urgent\n');
    expect(io.err).toBe('team tempo: it takes effect when the file is approved\n');
    expect(readFileSync(where.file, 'utf8').startsWith('format: 1\ntempo: urgent\n')).toBe(true);
    const again = testIo(where.root, { kind: 'owner' });
    const before = readFileSync(where.file, 'utf8');
    expect(await runTempo(['urgent'], again, { home: where.home })).toBe(0);
    expect(again.out).toBe('tempo: urgent\n');
    expect(again.err).toBe('');
    expect(readFileSync(where.file, 'utf8')).toBe(before);
  });

  test('normal is written without an approval note, and a seat is refused before the file is read', async () => {
    const where = place();
    const io = testIo(where.root, { kind: 'owner' });
    expect(await runTempo(['normal'], io, { home: where.home })).toBe(0);
    expect(io.out).toBe('tempo: normal\n');
    expect(io.err).toBe('');
    const seat = testIo(where.root, { kind: 'seat', name: 'lead', pane: 'w1:p1' });
    const before = readFileSync(where.file, 'utf8');
    expect(await runTempo(['relaxed'], seat, { home: where.home })).toBe(1);
    expect(seat.err).toContain('only the owner runs tempo');
    expect(readFileSync(where.file, 'utf8')).toBe(before);
    const bad = testIo(where.root, { kind: 'seat', name: 'lead', pane: 'w1:p1' });
    expect(await runTempo(['faster'], bad, { home: where.home })).toBe(2);
    expect(bad.err).toContain('must be relaxed, normal or urgent');
  });
});
