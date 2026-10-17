// herdr 0.7.1 reports a jules pane as no agent, and `unknown` after the rename, while the TUI
// runs (the profile's comment has the capture). A seat whose profile says its herdr status is
// unreliable is read from its screen alone: the idle table is free, so `down`, `restart` and
// `remove` stop it as they stop any free seat, and the one exit key is pressed at that table.
// The screens are the captured 0.1.42 fixtures, and the reading goes through the shipped
// profile, not a stand-in.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyExit, stateOf, stateOfPane, type ExitIo } from '../src/commands/down.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readScreen } from '../src/watch/screen.ts';

const ROOT = join(import.meta.dir, '..');
const capture = (name: string) => readFileSync(join(ROOT, 'test', 'fixtures', 'jules', '0.1.42', `${name}.txt`), 'utf8');
const idle = readScreen('jules', capture('idle'));
const working = readScreen('jules', capture('working'));

const julesNames = profileFor('jules')?.processNames ?? [];

/** The pane readings a jules seat gives: its own process in front, the shell not back. */
function julesPane(over: Partial<{ foreground: string[] | null; shellBack: boolean | null; processNames: string[] }> = {}) {
  return {
    foreground: ['jules'],
    shellBack: false,
    processNames: [...julesNames],
    cli: 'jules',
    ...over,
  };
}

function ioOf(screen: () => string, keys: string[], over: Partial<ExitIo> = {}): ExitIo {
  return {
    typeText: () => false,
    sendKey: (key) => {
      keys.push(key);
      return true;
    },
    pressEnter: () => false,
    screen,
    status: () => 'unknown',
    foreground: () => ['jules'],
    sleep: async () => {},
    now: () => 0,
    ...over,
  };
}

describe('a profile herdr cannot report is read from its screen', () => {
  test('jules says so, and every other shipped profile keeps herdr as the word', () => {
    expect(profileFor('jules')?.herdrStatus).toBe('unreliable');
    for (const name of ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse']) {
      expect(profileFor(name)?.herdrStatus).toBe('reliable');
    }
  });

  test('an idle table with herdr\'s unknown is free, on the plan and on the pane reading', () => {
    expect(stateOf('unknown', idle, 'jules')).toBe('free');
    expect(stateOfPane('unknown', idle, julesPane())).toBe('free');
  });

  test('a data CLI with herdr\'s unknown is not freed by this reading', () => {
    expect(stateOf('unknown', { kind: 'idle' }, 'claude-code')).toBe('unknown');
    expect(stateOf('unknown', { kind: 'idle' })).toBe('unknown');
  });

  test('a working card and a dialog keep their own word, whatever herdr says', () => {
    expect(stateOf('unknown', working, 'jules')).toBe('working');
    expect(stateOf('idle', { kind: 'permission' }, 'jules')).toBe('blocked');
    // An unreadable screen is not freed either: the profile's reading is the one that frees.
    expect(stateOf('unknown', { kind: 'unknown' }, 'jules')).toBe('unknown');
  });

  test('the pane reading still decides a seat whose CLI left', () => {
    expect(stateOfPane('unknown', idle, julesPane({ shellBack: true, foreground: ['zsh'] }))).toBe('exited');
    // An unreadable foreground list keeps the seat running: it is not a departure.
    expect(stateOfPane('unknown', idle, julesPane({ shellBack: true, foreground: null }))).toBe('free');
  });
});

describe('the jules exit key at a pane herdr reports unknown', () => {
  test('one ctrl+c at the idle table is the stop', async () => {
    const keys: string[] = [];
    expect(await keyExit(ioOf(() => capture('idle'), keys), 'jules', ['ctrl+c'])).toBe(true);
    expect(keys).toEqual(['ctrl+c']);
  });

  test('the working card takes no key', async () => {
    const keys: string[] = [];
    expect(await keyExit(ioOf(() => capture('working'), keys), 'jules', ['ctrl+c'])).toBe(false);
    expect(keys).toEqual([]);
  });

  test('a pane whose foreground is not the CLI takes no key', async () => {
    const keys: string[] = [];
    const io = ioOf(() => capture('idle'), keys, { foreground: () => ['zsh'] });
    expect(await keyExit(io, 'jules', ['ctrl+c'])).toBe('no-agent');
    expect(keys).toEqual([]);
  });

  test('nothing but ctrl+c is ever sent, even at a table that reads idle', async () => {
    const keys: string[] = [];
    const profile = profileFor('jules');
    if (profile === null) throw new Error('the jules profile did not load');
    expect(profile.exitKeys).toEqual(['ctrl+c']);
    await keyExit(ioOf(() => capture('idle'), keys), 'jules', profile.exitKeys);
    expect(keys.some((key) => /ctrl[+-]d/i.test(key))).toBe(false);
  });
});
