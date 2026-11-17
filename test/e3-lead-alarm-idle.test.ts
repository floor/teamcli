// RFC event-comms E3: the lead-unread alarm never fires while the lead is working. A pass that sees
// the lead working re-arms the clock, so the climb needs five minutes with no turn observed; a
// status the pass cannot read keeps the legacy clock. The episode marker beside the drop is the
// observable: `climbed: true` once the alarm went out.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteLeadEpisode } from '../src/watch/unread.ts';
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
