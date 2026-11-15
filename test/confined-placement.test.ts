// A seat confined in a sandbox that hides every process outside it cannot be placed by its parent
// walk. It is placed by what its confinement lets it create: its own seat-state folder, and not
// the session's seat-state folder or `.agents`. The pane variable only names the record tested.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { placeCaller, type CallerSources } from '../src/caller.ts';
import { confinedSeatAt, realConfinedSources, type ConfinedSources, type Probe } from '../src/placement/confined.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase } from './helpers.ts';

let scratchParent: string | undefined;
const made: string[] = [];

afterEach(() => {
  discardFixtures(made.splice(0), { roots: scratchParent === undefined ? [] : [scratchParent] });
});

/** A team folder whose state records `keeper` at pane-k and `other` at pane-o in session `s`. */
function team(): { root: string; dir: string } {
  const root = fixtureBase('confined-');
  scratchParent ??= dirname(root);
  made.push(root);
  const dir = join(root, '.agents');
  mkdirSync(join(dir, 'seat-state', 's', 'keeper'), { recursive: true });
  mkdirSync(join(dir, 'seat-state', 's', 'other'), { recursive: true });
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
    format: 1,
    sessions: { s: { seats: { keeper: { pane: 'pane-k' }, other: { pane: 'pane-o' } } } },
  }));
  return { root, dir };
}

/** Sources whose sandbox grants exactly `grants` and refuses every other folder with EPERM; the
 *  real folder walk, state read and link check. `otherwise` is what a folder outside the grants
 *  answers (a read-only folder answers 'unproved', not the sandbox's refusal). */
function confinedTo(grants: string[], otherwise: Probe = 'sandbox-refused'): ConfinedSources {
  return { ...realConfinedSources, probe: (folder) => (grants.includes(folder) ? 'created' : otherwise) };
}

describe('confinedSeatAt', () => {
  test('a caller that can create only in its own seat folder is that seat', () => {
    const { root, dir } = team();
    const own = join(dir, 'seat-state', 's', 'keeper');
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([own]))).toEqual({ name: 'keeper', session: 's', dir });
  });

  test('an unconfined caller is refused: it can create in the session folder and .agents', () => {
    const { root } = team();
    // The real probe on an ordinary process: every folder is writable.
    expect(confinedSeatAt(root, 'pane-k', 's')).toBeNull();
  });

  test('a seat confined to another seat\'s grant is refused when it names this pane', () => {
    const { root, dir } = team();
    const others = join(dir, 'seat-state', 's', 'other');
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([others]))).toBeNull();
  });

  test('a grant that reaches the session folder proves nothing', () => {
    const { root, dir } = team();
    const own = join(dir, 'seat-state', 's', 'keeper');
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([own, join(dir, 'seat-state', 's')]))).toBeNull();
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([own, dir]))).toBeNull();
  });

  test('a pane no record holds, another session, and an ambiguous pane place nobody', () => {
    const { root, dir } = team();
    const own = join(dir, 'seat-state', 's', 'keeper');
    expect(confinedSeatAt(root, 'pane-x', 's', confinedTo([own]))).toBeNull();
    expect(confinedSeatAt(root, 'pane-k', 't', confinedTo([own]))).toBeNull();
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { s: { seats: { keeper: { pane: 'pane-k' }, other: { pane: 'pane-k' } } } },
    }));
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([own]))).toBeNull();
  });

  test('a seat folder that does not exist proves nothing', () => {
    const { root, dir } = team();
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { s: { seats: { ghost: { pane: 'pane-g' } } } },
    }));
    expect(confinedSeatAt(root, 'pane-g', 's', confinedTo([join(dir, 'seat-state', 's', 'ghost')]))).toBeNull();
  });

  test('a folder refused for its mode, not by a sandbox, proves nothing', () => {
    const { root, dir } = team();
    const own = join(dir, 'seat-state', 's', 'keeper');
    expect(confinedSeatAt(root, 'pane-k', 's', confinedTo([own], 'unproved'))).toBeNull();
  });

  test('a folder replaced while it is probed proves nothing', () => {
    const { root, dir } = team();
    const own = join(dir, 'seat-state', 's', 'keeper');
    let probed = false;
    const sources: ConfinedSources = {
      ...confinedTo([own]),
      probe: (folder) => { probed = true; return folder === own ? 'created' : 'sandbox-refused'; },
      identity: (folder) => `${folder}:${probed ? 'after' : 'before'}`,
    };
    expect(confinedSeatAt(root, 'pane-k', 's', sources)).toBeNull();
  });

  test('a seat folder reached through a link proves nothing', () => {
    const { root, dir } = team();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { s: { seats: { linked: { pane: 'pane-l' } } } },
    }));
    symlinkSync(elsewhere, join(dir, 'seat-state', 's', 'linked'));
    expect(confinedSeatAt(root, 'pane-l', 's', confinedTo([join(dir, 'seat-state', 's', 'linked'), elsewhere]))).toBeNull();
  });

  test('the session folder name is the launch\'s encoded one: a raw name names no grant', () => {
    const { root, dir } = team();
    writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
      format: 1,
      sessions: { 'a.b': { seats: { keeper: { pane: 'pane-k' } } } },
    }));
    // The launch grants seat-state/a%2Eb/keeper; a raw seat-state/a.b/keeper is not the grant.
    mkdirSync(join(dir, 'seat-state', 'a.b', 'keeper'), { recursive: true });
    mkdirSync(join(dir, 'seat-state', 'a%2Eb', 'keeper'), { recursive: true });
    expect(confinedSeatAt(root, 'pane-k', 'a.b', confinedTo([join(dir, 'seat-state', 'a.b', 'keeper')]))).toBeNull();
    expect(confinedSeatAt(root, 'pane-k', 'a.b', confinedTo([join(dir, 'seat-state', 'a%2Eb', 'keeper')]))?.name).toBe('keeper');
  });

  test('a caller started in a folder below the team root finds the team by walking up', () => {
    const { root, dir } = team();
    const deep = join(root, 'worktrees', 'keeper');
    mkdirSync(deep, { recursive: true });
    const own = join(dir, 'seat-state', 's', 'keeper');
    expect(confinedSeatAt(deep, 'pane-k', undefined, confinedTo([own]))?.name).toBe('keeper');
  });
});

describe('placeCaller with a confined seat', () => {
  const base = (over: Partial<CallerSources>): CallerSources => ({
    ancestors: () => null,
    agents: () => null,
    paneRootPid: () => null,
    env: { HERDR_PANE_ID: 'pane-k' },
    stdinIsTTY: false,
    ...over,
  });
  const listed = (name: string | null): HerdrAgent[] => [
    { name, agent: 'grok', pane: 'pane-k', workspace: 'w', status: 'idle', cwd: null },
  ];

  test('an unreadable walk with a proved confinement places the seat', () => {
    const caller = placeCaller(base({ confinedSeat: () => ({ name: 'keeper', session: 's', dir: '/x' }) }), 's');
    expect(caller).toEqual({ kind: 'seat', name: 'keeper', pane: 'pane-k', session: 's' });
  });

  test('no proof keeps the refusal it had', () => {
    const caller = placeCaller(base({ confinedSeat: () => null }), 's');
    expect(caller).toEqual({ kind: 'unplaced', reason: 'its parent processes can\'t be read to the top' });
  });

  test('no pane variable never asks for a proof', () => {
    let asked = false;
    const caller = placeCaller(base({ env: {}, confinedSeat: () => { asked = true; return { name: 'keeper', session: 's', dir: '/x' }; } }), 's');
    expect(asked).toBe(false);
    expect(caller.kind).toBe('unplaced');
  });

  test('a pane the host names for another seat refuses; an unnamed or same-named pane stands', () => {
    const proved = () => ({ name: 'keeper', session: 's', dir: '/x' });
    expect(placeCaller(base({ confinedSeat: proved, agents: () => listed('other') }), 's').kind).toBe('unplaced');
    expect(placeCaller(base({ confinedSeat: proved, agents: () => listed(null) }), 's').kind).toBe('seat');
    expect(placeCaller(base({ confinedSeat: proved, agents: () => listed('keeper') }), 's').kind).toBe('seat');
  });

  test('the host listing this seat on another pane refuses the reading', () => {
    const proved = () => ({ name: 'keeper', session: 's', dir: '/x' });
    const elsewhere: HerdrAgent[] = [{ name: 'keeper', agent: 'grok', pane: 'pane-z', workspace: 'w', status: 'idle', cwd: null }];
    expect(placeCaller(base({ confinedSeat: proved, agents: () => elsewhere }), 's').kind).toBe('unplaced');
  });

  test('a readable walk never consults the confinement', () => {
    let asked = false;
    placeCaller(base({
      ancestors: () => [{ pid: 10, name: 'zsh' }],
      confinedSeat: () => { asked = true; return null; },
    }), 's');
    expect(asked).toBe(false);
  });
});
