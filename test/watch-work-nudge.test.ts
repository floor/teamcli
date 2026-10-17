// `watch.nudge` is sent to each idle worker on the idle cadence, through the drop file `team send`
// uses. The report line is that body when the file omits the key. A missing approval does not
// stop it. A lead, a dialog and unsent text are not targets.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runWatch, type WatchSources } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { newMemory, NUDGE_TEXT, pass } from '../src/watch/pass.ts';
import { claudeBox, testIo } from './helpers.ts';

const raw = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const PROMPT = 'Take the next unfinished item in your queue and start it.';

function teamOf(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const idle = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const unsent = `${RULE}\n❯ Brief: take the next task from the queue\n${RULE}\n${STATUS}\n`;
const question = `Which branch should this start from?\n\n❯ 1. main\n  2. next\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
const busy = `✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };
const MIN = 60_000;

function agent(name: string, workspace: string, status: string): HerdrAgent {
  return { name, agent: 'claude', pane: `${workspace}:pane`, workspace, status, cwd: null };
}

function scene(over: Partial<Record<string, { status?: string; screen?: string }>> = {}): Live {
  const seats: [string, string, string, string][] = [
    ['claude-coordinator-acme', 'lead', 'idle', idle],
    ['deepseek-acme', 'first', 'working', busy],
    ['deepseek-acme-2', 'second', 'working', busy],
  ];
  const agents: HerdrAgent[] = [];
  const screens: Record<string, string> = {};
  for (const [name, workspace, status, screen] of seats) {
    const change = over[name] ?? {};
    agents.push(agent(name, workspace, change.status ?? status));
    screens[`${workspace}:pane`] = change.screen ?? screen;
  }
  return { running: true, agents, workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })), screens };
}

function at(text: string, memory: ReturnType<typeof newMemory>, now: number, live = scene()) {
  const team = teamOf(text);
  return pass({ team, watch: team.watch, state: emptySession(), live, machine: fine, now, memory });
}

describe('watch.nudge', () => {
  test('a non-text nudge is refused', () => {
    const refused = validateTeamFile(raw.replace('watch:\n', 'watch:\n  nudge: 1\n'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]?.message).toContain('watch.nudge must be text');
  });

  test('each idle worker gets the text after idle_first, and again every idle_repeat', () => {
    const text = raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`);
    const memory = newMemory();
    const both = scene({
      'deepseek-acme': { status: 'idle', screen: idle },
      'deepseek-acme-2': { status: 'idle', screen: idle },
    });
    expect(at(text, memory, 0, both).work).toEqual([]);
    const first = at(text, memory, 10 * MIN, both);
    expect(first.work.map((item) => item.seat).sort()).toEqual(['deepseek-acme', 'deepseek-acme-2']);
    expect(first.work.every((item) => item.body === PROMPT)).toBe(true);
    expect(first.work.some((item) => item.seat === 'claude-coordinator-acme')).toBe(false);
    expect(at(text, memory, 11 * MIN, both).work).toEqual([]);
    const again = at(text, memory, 30 * MIN, both);
    expect(again.work.map((item) => item.seat).sort()).toEqual(['deepseek-acme', 'deepseek-acme-2']);
  });

  test('an omitted nudge sends the report line, once per idle stretch when idle_repeat is off', () => {
    const text = raw.replace(/  idle_repeat: 20m[^\n]*\n/, '');
    const memory = newMemory();
    const live = scene({ 'deepseek-acme': { status: 'idle', screen: idle } });
    at(text, memory, 0, live);
    expect(at(text, memory, 10 * MIN, live).work).toEqual([
      { pane: 'first:pane', seat: 'deepseek-acme', cli: 'claude-code', body: NUDGE_TEXT },
    ]);
    expect(at(text, memory, 40 * MIN, live).work).toEqual([]);
  });

  test('the live file supplies the text when the watch in force has none', () => {
    const team = teamOf(raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`));
    const watch = { ...team.watch };
    delete watch.nudge;
    const memory = newMemory();
    const live = scene({ 'deepseek-acme': { status: 'idle', screen: idle } });
    pass({ team, watch, state: emptySession(), live, machine: fine, now: 0, memory });
    const due = pass({ team, watch, state: emptySession(), live, machine: fine, now: 10 * MIN, memory });
    expect(due.work).toEqual([
      { pane: 'first:pane', seat: 'deepseek-acme', cli: 'claude-code', body: PROMPT },
    ]);
  });

  test('a dialog and unsent text are skipped, and a lead is never the target', () => {
    const memory = newMemory();
    const free = scene({ 'deepseek-acme': { status: 'idle', screen: idle } });
    at(raw, memory, 0, free);
    expect(at(raw, memory, 10 * MIN, scene({ 'deepseek-acme': { status: 'idle', screen: question } })).work).toEqual([]);
    expect(at(raw, memory, 10 * MIN, scene({ 'deepseek-acme': { status: 'idle', screen: unsent } })).work).toEqual([]);
    const leadMemory = newMemory();
    at(raw, leadMemory, 0, scene({ 'claude-coordinator-acme': { status: 'working', screen: busy } }));
    expect(at(raw, leadMemory, 10 * MIN, scene({ 'claude-coordinator-acme': { status: 'idle', screen: idle } })).work).toEqual([]);
  });

  test('a seat that was in a dialog is sent once the prompt is empty, still inside the same stretch', () => {
    const memory = newMemory();
    const free = scene({ 'deepseek-acme': { status: 'idle', screen: idle } });
    const asked = scene({ 'deepseek-acme': { status: 'idle', screen: question } });
    at(raw, memory, 0, free);
    expect(at(raw, memory, 10 * MIN, asked).work).toEqual([]);
    expect(at(raw, memory, 12 * MIN, free).work.map((item) => item.seat)).toEqual(['deepseek-acme']);
  });

  test('a report nudge ties on how long each seat has been free, and the lower seat number wins', () => {
    // Two free workers stamped at the same instant: the tie-break is the seat's number, so
    // builder-9 is nudged before builder-10 — the string order would pick builder-10.
    const numbered = raw.replace(
      /\n  - role: implementer\n    name: codex-acme[\s\S]*$/,
      `
  - role: implementer
    name: builder-9
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
  - role: implementer
    name: builder-10
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "V4.1"
    display: DeepSeek V4.1 Flash
    launch: team-deepseek
`,
    );
    const team = teamOf(numbered);
    const agents: HerdrAgent[] = [
      agent('claude-coordinator-acme', 'lead', 'working'),
      agent('builder-9', 'nine', 'idle'),
      agent('builder-10', 'ten', 'idle'),
    ];
    const live: Live = {
      running: true,
      agents,
      workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
      screens: { 'lead:pane': busy, 'nine:pane': idle, 'ten:pane': idle },
    };
    const memory = newMemory();
    memory.pending = ['a report for the operator'];
    const result = pass({ team, watch: team.watch, state: emptySession(), live, machine: fine, now: 10 * MIN, memory });
    expect(result.nudge?.seat).toBe('builder-9');
    expect(result.nudge?.pane).toBe('nine:pane');
  });
});

describe('team watch writes the drop', () => {
  let dir: string;
  let file: string;
  let typed: string[];
  let screenNow: string;
  let clock: number;

  function sources(over: Partial<WatchSources> = {}): WatchSources {
    let left = 2;
    return {
      live: () => scene({
        'deepseek-acme': { status: 'idle', screen: idle },
        'deepseek-acme-2': { status: 'idle', screen: idle },
      }),
      machine: () => fine,
      standing: () => ({ kind: 'none' }),
      readChecks: () => [],
      screen: () => screenNow,
      status: () => 'idle',
      foreground: () => ['claude'],
      typeText: (pane, text) => { typed.push(`${pane} ${text}`); screenNow = claudeBox(text); return true; },
      pressEnter: (pane) => { typed.push(`${pane} <enter>`); return true; },
      sleep: async (ms) => { clock += ms; },
      notify: () => {},
      now: () => new Date(clock),
      wait: async () => { clock += 10 * MIN; return --left > 0; },
      alive: () => false,
      pid: 4242,
      home: dir,
      ...over,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'team-watch-nudge-'));
    execSync('git init -q', { cwd: dir });
    mkdirSync(join(dir, '.agents'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('an unapproved file still drops the prompt, and never into the owner pane', async () => {
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(file, raw.replace('watch:\n', `watch:\n  nudge: ${PROMPT}\n`));
    typed = [];
    screenNow = idle;
    clock = Date.parse('2026-10-03T14:00:00Z');
    const io = testIo(dir, { kind: 'owner' });
    const code = await runWatch(['--file', file], io, sources({
      ownPane: () => ({ pane: 'first:pane', workspace: 'first' }),
    }));
    expect(code).toBe(0);
    const triggers = typed.filter((line) => line.includes(' and do that.'));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatch(/^second:pane Read .+ and do that\.$/);
    expect(typed.some((line) => line.startsWith('first:pane '))).toBe(false);
    expect(typed.some((line) => line.startsWith('lead:pane '))).toBe(false);
    const path = triggers[0]?.match(/^second:pane Read (.+) and do that\.$/)?.[1];
    expect(path).toBeTruthy();
    expect(path).toContain(join('send-drops', 'acme-web', 'deepseek-acme-2'));
    expect(readFileSync(path!, 'utf8')).toBe(PROMPT);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, '.agents', 'send-drops')).mode & 0o777).toBe(0o700);
    expect(io.out).toContain(`nudged deepseek-acme-2: ${PROMPT}`);
    expect(io.out).not.toContain('nudged claude-coordinator-acme');
  });

  test('an edited grant and delegates produces no approved-copy difference line', async () => {
    file = join(dir, '.agents', 'team.yaml');
    writeFileSync(
      file,
      `${raw}\ngrant:\n  session: acme-web\n  seat: claude-coordinator-acme\n  scope: [up, down]\ndelegates:\n  - pane: other/pane-1\n    commands: [up, down]\n`,
    );
    typed = [];
    screenNow = idle;
    clock = Date.parse('2026-10-03T14:00:00Z');
    const io = testIo(dir, { kind: 'owner' });
    let left = 1;
    const code = await runWatch(['--file', file], io, sources({
      standing: (root) => verifiedOf(teamOf(raw), raw, root),
      wait: async () => --left > 0,
    }));
    expect(code).toBe(0);
    expect(io.out).not.toContain('the file differs from the approved one');
    expect(io.out).not.toContain('grant');
    expect(io.out).not.toContain('delegates');
    const log = readFileSync(join(dir, '.agents', 'team.log'), 'utf8');
    expect(log).not.toContain('the file differs from the approved one');
  });
});
