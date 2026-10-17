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
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { profileFor } from '../src/profiles/index.ts';
import { emptySession } from '../src/state.ts';
import { compare, type Live } from '../src/status/compare.ts';
import { attentionOf, newMemory, pass } from '../src/watch/pass.ts';
import type { Machine } from '../src/watch/machine.ts';
import { readScreen, screenWord } from '../src/watch/screen.ts';

const ROOT = join(import.meta.dir, '..');
const capture = (name: string) => readFileSync(join(ROOT, 'test', 'fixtures', 'jules', '0.1.42', `${name}.txt`), 'utf8');
const idle = readScreen('jules', capture('idle'));
const working = readScreen('jules', capture('working'));
const done = readScreen('jules', capture('done'));

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

// The other three readers — status, check and the watch — take a seat's state from herdr's word,
// and a jules pane carries none: its status stays `unknown` while the TUI runs. Each reads the
// profile's own screen there instead, so an idle table is idle, a running card is working, and
// only a screen the profile cannot read is unknown.
const TEAM_TEXT = `format: 1
project: acme
session: jules-web
operator: jules-lead
workspace:
  mode: shared
seats:
  - role: operator
    name: jules-lead
    label: operator
    cli: jules
    vendor: google
    model: Jules
    version: "0.1.42"
    launch: jules
    leads: true
  - role: implementer
    name: jules-acme
    label: implementer
    cli: jules
    vendor: google
    model: Jules
    version: "0.1.42"
    launch: jules
`;

function julesTeam() {
  const parsed = validateTeamFile(TEAM_TEXT);
  if (!parsed.ok) throw new Error(`the jules team did not validate: ${JSON.stringify(parsed.errors)}`);
  return parsed.team;
}

/** The team as herdr shows it: two jules panes, no word for what they run. The lead sits at its
 *  table; the implementer shows the screen a scene gives it. */
function julesLive(screen: string, status = 'unknown'): Live {
  const seats: [string, string, string][] = [
    ['jules-lead', 'w0', capture('idle')],
    ['jules-acme', 'w1', screen],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, text] of seats) {
    agents.push({ name, agent: null, pane: `${workspace}:p1`, workspace, status, cwd: null });
    screens[`${workspace}:p1`] = text;
  }
  return {
    running: true,
    agents,
    workspaces: seats.map(([, workspace]) => ({ id: workspace, label: workspace })),
    screens,
  };
}

const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

describe('a profile herdr cannot report reads its state from the screen', () => {
  test('the screen word is the one the readers use, for every captured screen', () => {
    expect(screenWord(idle)).toBe('idle');
    expect(screenWord(done)).toBe('idle');
    expect(screenWord(working)).toBe('working');
    expect(screenWord({ kind: 'permission' })).toBe('blocked');
    expect(screenWord({ kind: 'rate limit', reset: null })).toBe('blocked');
    expect(screenWord(readScreen('jules', ''))).toBe('unknown');
  });

  test('status shows the screen\'s state and leaves herdr\'s unknown without a note', () => {
    const stateOfSeat = (at: Live, name: string) =>
      compare(julesTeam(), 'jules-web', emptySession(), at).rows.find((row) => row.name === name)?.state;
    const atIdle = compare(julesTeam(), 'jules-web', emptySession(), julesLive(capture('idle')));
    expect(atIdle.rows.map((row) => row.state)).toEqual(['idle', 'idle']);
    // The only notes left are the version ones: the TUI's screens name no model. Herdr's
    // `unknown` adds none.
    expect(atIdle.notes.filter((note) => note.includes('herdr reports'))).toEqual([]);
    // Nothing about the seats is a difference: the only one is the session's missing watch.
    expect(atIdle.differences.some((difference) => difference.what.startsWith('jules-'))).toBe(false);
    expect(stateOfSeat(julesLive(capture('working')), 'jules-acme')).toBe('working');
    // A completed card is the profile's idle: the next send walks back to the table.
    expect(stateOfSeat(julesLive(capture('done')), 'jules-acme')).toBe('idle');
  });

  test('a screen no profile reads keeps herdr\'s unknown and its note', () => {
    const report = compare(julesTeam(), 'jules-web', emptySession(), julesLive('Welcome back!\n'));
    expect(report.rows.find((row) => row.name === 'jules-acme')?.state).toBe('unknown');
    expect(report.notes.filter((note) => note.includes('herdr reports')))
      .toEqual(['jules-acme: herdr reports the status "unknown"']);
  });

  test('the watch\'s attention is the screen\'s, not herdr\'s word', () => {
    expect(attentionOf(idle, 'unknown', false, true)).toBeNull();
    expect(attentionOf(working, 'unknown', false, true)).toBeNull();
    expect(attentionOf(readScreen('jules', ''), 'unknown', false, true)).toBe('unknown');
    // A profile herdr can report keeps the old reading, herdr's word included.
    expect(attentionOf(idle, 'unknown', false)).toBe('unknown');
  });

  test('the watch reports neither attention nor a nudge failure at an idle table, and does nudge it', () => {
    const memory = newMemory();
    const quiet = julesLive(capture('idle'));
    const first = pass({ team: julesTeam(), watch: julesTeam().watch, state: emptySession(), live: quiet, machine: fine, now: 0, memory });
    expect(first.reports).toEqual([]);
    expect(first.nudge).toBeNull();
    // The same seat on a running card is working: no idle report, no attention.
    const busy = pass({ team: julesTeam(), watch: julesTeam().watch, state: emptySession(), live: julesLive(capture('working')), machine: fine, now: 10 * MIN, memory: newMemory() });
    expect(busy.reports).toEqual([]);
    // Ten minutes at the table: the idle check counts it, as it counts any quiet seat.
    const later = pass({ team: julesTeam(), watch: julesTeam().watch, state: emptySession(), live: quiet, machine: fine, now: 10 * MIN, memory });
    expect(later.reports.map((report) => report.text)).toContain('jules-acme has been idle since the watch started');
    expect(later.reports.some((report) => report.text.includes('herdr reports'))).toBe(false);
    // A report waiting for an operator picks the idle table as the seat to nudge.
    const waiting = newMemory();
    waiting.pending = ['a report waits'];
    const nudged = pass({ team: julesTeam(), watch: julesTeam().watch, state: emptySession(), live: quiet, machine: fine, now: 0, memory: waiting });
    expect(nudged.nudge?.pane).toBe('w1:p1');
    expect(nudged.nudge?.seat).toBe('jules-acme');
  });
});
