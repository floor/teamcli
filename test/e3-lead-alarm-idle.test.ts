// RFC event-comms E3: the lead-unread alarm never fires while the lead is working. A pass that sees
// the lead working re-arms the clock, so the climb needs five minutes with no turn observed; a
// status the pass cannot read keeps the legacy clock. The episode marker beside the drop is the
// observable: `climbed: true` once the alarm went out.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, renameSync as trashRename, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteLeadEpisode, rearmLeadEpisodes } from '../src/watch/unread.ts';
import type { RetryScene } from '../src/watch/retry.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

const MIN = 60 * 1000;

function scene(): { scene: RetryScene; dropDir: string; climbs: string[] } {
  const base = mkdtempSync(join(tmpdir(), 'e3-lead-'));
  made.push(base);
  const climbs: string[] = [];
  const s = {
    home: join(base, 'home'),
    root: join(base, 'root'),
    team: { project: 'fixture' },
    deliverClimb: (climb: { id: string }) => {
      climbs.push(climb.id);
      return true;
    },
  } as unknown as RetryScene;
  return { scene: s, dropDir: base, climbs };
}

const episode = (dropDir: string): { at: number; climbed: boolean } =>
  JSON.parse(readFileSync(join(dropDir, 'm1.lead-episode'), 'utf8')) as { at: number; climbed: boolean };

describe('E3: the lead alarm waits while the lead is working', () => {
  test('idle lead: the alarm climbs five minutes after the first wake (legacy behaviour kept)', () => {
    const { scene: s, dropDir } = scene();
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 0, true);
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 4 * MIN, false);
    expect(episode(dropDir).climbed).toBe(false);
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 5 * MIN, false);
    expect(episode(dropDir).climbed).toBe(true);
  });

  test('mid-turn: no alarm past the window, and the clock restarts at the turn it saw', () => {
    const { scene: s, dropDir } = scene();
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 0, true);
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 6 * MIN, false, true);
    expect(episode(dropDir)).toEqual({ at: 6 * MIN, climbed: false });
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 9 * MIN, false);
    expect(episode(dropDir).climbed).toBe(false);
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 11 * MIN, false);
    expect(episode(dropDir).climbed).toBe(true);
  });

  test('a working lead with no clock yet starts none', () => {
    const { scene: s, dropDir } = scene();
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 0, false, true);
    expect(() => episode(dropDir)).toThrow();
  });

  test('an episode that already climbed is left as it is, working or not', () => {
    const { scene: s, dropDir } = scene();
    writeFileSync(join(dropDir, 'm1.lead-episode'), `${JSON.stringify({ at: 0, climbed: true })}\n`);
    noteLeadEpisode(s, 'lead', dropDir, 'm1', 20 * MIN, false, true);
    expect(episode(dropDir)).toEqual({ at: 0, climbed: true });
  });
});

describe('E3: lead episode files are this seat\'s own plain files only', () => {
  test('a link to another seat\'s episode is never re-armed or written through', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-link-'));
    made.push(base);
    const mine = join(base, 'lead');
    const other = join(base, 'other');
    mkdirSync(mine);
    mkdirSync(other);
    const target = join(other, 'm9.lead-episode');
    writeFileSync(target, `${JSON.stringify({ at: 1, climbed: false })}\n`);
    symlinkSync(target, join(mine, 'm9.lead-episode'));
    rearmLeadEpisodes(mine, 99 * MIN);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ at: 1, climbed: false });
    const { scene: s } = scene();
    noteLeadEpisode(s, 'lead', mine, 'm9', 99 * MIN, true, true);
    noteLeadEpisode(s, 'lead', mine, 'm9', 99 * MIN, true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ at: 1, climbed: false });
  });

  test('a link to any JSON outside the folder is left untouched', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-out-'));
    made.push(base);
    const mine = join(base, 'lead');
    mkdirSync(mine);
    const outside = join(base, 'settings.json');
    writeFileSync(outside, `${JSON.stringify({ at: 5, climbed: false, keep: 'me' })}\n`);
    symlinkSync(outside, join(mine, 'm1.lead-episode'));
    rearmLeadEpisodes(mine, 50 * MIN);
    expect(JSON.parse(readFileSync(outside, 'utf8'))).toEqual({ at: 5, climbed: false, keep: 'me' });
  });

  test('a plain episode file of the seat\'s own folder is re-armed', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-own-'));
    made.push(base);
    writeFileSync(join(base, 'm1.lead-episode'), `${JSON.stringify({ at: 1, climbed: false })}\n`);
    writeFileSync(join(base, 'm2.lead-episode'), `${JSON.stringify({ at: 1, climbed: true })}\n`);
    rearmLeadEpisodes(base, 7 * MIN);
    expect(JSON.parse(readFileSync(join(base, 'm1.lead-episode'), 'utf8'))).toEqual({ at: 7 * MIN, climbed: false });
    expect(JSON.parse(readFileSync(join(base, 'm2.lead-episode'), 'utf8'))).toEqual({ at: 1, climbed: true });
  });
});

describe('E3: the watch does not churn lead episodes', () => {
  test('a clock already at the pass time is not rewritten', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-same-'));
    made.push(base);
    const path = join(base, 'm1.lead-episode');
    writeFileSync(path, `${JSON.stringify({ at: 7 * MIN, climbed: false })}\n`);
    const before = statSync(path).ino;
    rearmLeadEpisodes(base, 7 * MIN, new Set(['m1']));
    expect(statSync(path).ino).toBe(before);
    rearmLeadEpisodes(base, 8 * MIN, new Set(['m1']));
    expect(statSync(path).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ at: 8 * MIN, climbed: false });
  });

  test('an episode whose message is settled is removed; a waiting one stays', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-settled-'));
    made.push(base);
    writeFileSync(join(base, 'm1.lead-episode'), `${JSON.stringify({ at: 1, climbed: false })}\n`);
    writeFileSync(join(base, 'm2.lead-episode'), `${JSON.stringify({ at: 1, climbed: true })}\n`);
    writeFileSync(join(base, 'm3.lead-episode'), `${JSON.stringify({ at: 1, climbed: false })}\n`);
    rearmLeadEpisodes(base, null, new Set(['m3']));
    expect(existsSync(join(base, 'm1.lead-episode'))).toBe(false);
    expect(existsSync(join(base, 'm2.lead-episode'))).toBe(false);
    expect(JSON.parse(readFileSync(join(base, 'm3.lead-episode'), 'utf8'))).toEqual({ at: 1, climbed: false });
  });

  test('a link at a settled name is never removed through', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-settled-link-'));
    made.push(base);
    const mine = join(base, 'lead');
    mkdirSync(mine);
    const outside = join(base, 'keep.json');
    writeFileSync(outside, '{}\n');
    symlinkSync(outside, join(mine, 'm1.lead-episode'));
    rearmLeadEpisodes(mine, null, new Set());
    expect(existsSync(join(mine, 'm1.lead-episode'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('E3: an episode name swapped for a link is never written through', () => {
  test('a link put at the name after the check is replaced, not followed (rename over the entry)', () => {
    const base = mkdtempSync(join(tmpdir(), 'e3-swap-'));
    made.push(base);
    const mine = join(base, 'lead');
    mkdirSync(mine);
    const outside = join(base, 'outside.json');
    writeFileSync(outside, `${JSON.stringify({ keep: 'me' })}\n`);
    // A plain clock, then the name swapped for a link between passes: the next write must
    // replace the entry and leave the target untouched.
    writeFileSync(join(mine, 'm1.lead-episode'), `${JSON.stringify({ at: 0, climbed: false })}\n`);
    const { scene: s } = scene();
    noteLeadEpisode(s, 'lead', mine, 'm1', 2 * MIN, false, true);
    expect(JSON.parse(readFileSync(join(mine, 'm1.lead-episode'), 'utf8'))).toEqual({ at: 2 * MIN, climbed: false });
    trashRename(join(mine, 'm1.lead-episode'), join(base, 'moved-aside'));
    symlinkSync(outside, join(mine, 'm1.lead-episode'));
    noteLeadEpisode(s, 'lead', mine, 'm1', 9 * MIN, false);
    rearmLeadEpisodes(mine, 10 * MIN);
    expect(JSON.parse(readFileSync(outside, 'utf8'))).toEqual({ keep: 'me' });
  });
});
