// The owner's `team check --repair`: one write over the findings the check can settle from what
// it already holds — the state's leftovers dropped, the seats an agent registered under dev mode
// re-recorded with the caller gate in force, and each drifted herdr sidebar line set back from the
// file. Everything else keeps its advice: a model drift's relaunch is not a write the file
// settles, and the repair never starts, stops or relaunches a seat. Fake herdr throughout, with
// the two sidebar writes injected so the scene can see the exact call `team register` would make.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');

const TEXT = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true

  - role: implementer
    name: dev-one
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: dev-two
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: dev-three
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const SEATS = loaded.team.seats;
/** Each seat's own workspace and pane: line 1 is per workspace, so seats never share one here. */
const workspaceOf = (index: number) => `w${index + 1}`;
const paneOf = (index: number) => `w${index + 1}:p1`;
const TITLES = Object.fromEntries(SEATS.map((seat) => [seat.name, workspaceLabel(seat)])) as Record<string, string>;
const DISPLAYS = Object.fromEntries(SEATS.map((seat) => [seat.name, displayAgent(seat)])) as Record<string, string>;
/** The caller a dev-mode run of `team register` kept: an unplaced call herdr did not name. */
const DEV_CALLER = 'unplaced (it runs under herdr)';
/** A screen that names a model, as the signing drift reads it. */
const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function place(options: { stale?: boolean } = {}): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-repair-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), TEXT);
  // The state a launch leaves: every seat on its own pane, the watch recent enough that it is no
  // difference, and — where the scene wants one — a record for a seat the file no longer declares.
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    SEATS.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: paneOf(index), workspace: workspaceOf(index) };
    });
    if (options.stale !== false) session.seats.gone = { stage: 'ready', pane: 'w9:p1', workspace: 'w9' };
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
  });
  return { root, home };
}

/** The live session as herdr answers it, from the sidebar lines the arguments hold: every seat on
 *  its own workspace and pane, every line the file's own unless the scene says otherwise. */
function live(lines: {
  titles: Record<string, string>;
  displays: Record<string, string>;
  screens: Record<string, string>;
}): Live {
  return {
    running: true,
    agents: SEATS.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: paneOf(index),
      workspace: workspaceOf(index),
      status: 'idle',
      cwd: null,
      displayAgent: lines.displays[seat.name] as string,
    })),
    workspaces: SEATS.map((seat, index) => ({ id: workspaceOf(index), label: lines.titles[seat.name] as string })),
    screens: lines.screens,
  };
}

/** One agent record, as the run named by `by` wrote it, dev mark per `dev`. */
function record(home: string, root: string, name: string, options: { by: string; dev?: boolean }): string {
  const index = SEATS.findIndex((seat) => seat.name === name);
  const seat = SEATS[index];
  if (seat === undefined) throw new Error(`no seat ${name}`);
  const agent = registerAgent(home, {
    name,
    signing: { model: 'Claude Opus', version: '5.5', role: seat.role },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamIdOf(root), seat: name, session: 'acme', pane: paneOf(index), address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: options.by,
    devMode: options.dev === true,
  });
  return agent.id;
}

/** The two sidebar writes the check makes under `--repair`, recorded as `team register` calls them. */
type Writes = { rename: Array<[string, string, string]>; display: Array<[string, string, string]> };

type CheckOptions = {
  repair?: boolean;
  json?: boolean;
  writes?: Writes;
  titles?: Record<string, string>;
  displays?: Record<string, string>;
  screens?: Record<string, string>;
};

function check(root: string, home: string, options: CheckOptions = {}): { code: number; out: string } {
  // The world the writes change: a herdr that takes a line answers the next read with it.
  let titles = { ...TITLES, ...(options.titles ?? {}) };
  let displays = { ...DISPLAYS, ...(options.displays ?? {}) };
  const screens = { ...Object.fromEntries(SEATS.map((_, index) => [paneOf(index), CLAUDE_IDLE])), ...(options.screens ?? {}) };
  const writes = options.writes;
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck(
    { file: '.agents/team.yaml', ...(options.repair === true ? { repair: true } : {}), ...(options.json === true ? { json: true } : {}) },
    io,
    {
      live: () => live({ titles, displays, screens }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
      ...(writes === undefined
        ? {}
        : {
            renameWorkspace: (session: string, workspace: string, label: string) => {
              writes.rename.push([session, workspace, label]);
              const seat = SEATS[Number(workspace.slice(1)) - 1];
              if (seat !== undefined) titles = { ...titles, [seat.name]: label };
              return true;
            },
            reportDisplayAgent: (session: string, pane: string, text: string) => {
              writes.display.push([session, pane, text]);
              const seat = SEATS[Number(pane.slice(1, pane.indexOf(':'))) - 1];
              if (seat !== undefined) displays = { ...displays, [seat.name]: text };
              return true;
            },
          }),
    },
  );
  return { code, out: `${io.out}${io.err}` };
}

/** The signed team-level value the quiet count reads. */
function setDevMode(home: string, root: string, value: 'on' | 'off'): void {
  const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value }, { now: NOW });
  if (!written.ok) throw new Error(written.why);
}

describe('the owner\'s one repair', () => {
  test('one --repair re-records every marked seat, syncs the drifted line and drops the leftover', () => {
    const { root, home } = place();
    for (const name of ['dev-one', 'dev-two', 'dev-three']) record(home, root, name, { by: DEV_CALLER, dev: true });
    const writes: Writes = { rename: [], display: [] };
    // Without the repair the same world is five findings: three marks, the drifted label, the
    // leftover — and the check writes nothing.
    const plain = check(root, home, { titles: { lead: 'stale title' } });
    expect(plain.code).toBe(1);
    expect(plain.out).toContain('difference: dev-one: registered by an agent, not by the owner');
    expect(plain.out).toContain('difference: gone: left the team file but its record still claims pane w9:p1');
    expect(findAgent(home, { team: teamIdOf(root), seat: 'dev-one' })?.provenance.dev_mode).toBe(true);

    const { code, out } = check(root, home, { repair: true, writes, titles: { lead: 'stale title' } });
    expect(code).toBe(0);
    expect(out).toContain('repaired: dev-one: re-recorded with the caller gate in force; the dev-mode mark is cleared');
    expect(out).toContain('repaired: dev-two: re-recorded with the caller gate in force; the dev-mode mark is cleared');
    expect(out).toContain('repaired: dev-three: re-recorded with the caller gate in force; the dev-mode mark is cleared');
    expect(out).toContain(`repaired: lead: its herdr workspace label is set back to "${TITLES.lead}"`);
    expect(out).toContain('repaired: gone: left the team file and its record claimed pane w9:p1; its record is dropped');
    expect(out).toContain('0 difference(s)');
    expect(out).not.toContain('difference:');
    // The two writes are `team register`'s own, from the file alone, and only for the line that
    // drifted: the display lines are the file's, so nothing is reported to herdr for them.
    expect(writes.rename).toEqual([['acme', 'w1', TITLES['lead'] as string]]);
    expect(writes.display).toEqual([]);
    for (const name of ['dev-one', 'dev-two', 'dev-three']) {
      expect(findAgent(home, { team: teamIdOf(root), seat: name })?.provenance.dev_mode).toBeUndefined();
    }
    expect(readState(join(root, '.agents')).sessions.acme?.seats.gone).toBeUndefined();
  });

  test('a drifted display line is set back from the file in the same repair', () => {
    const { root, home } = place({ stale: false });
    const writes: Writes = { rename: [], display: [] };
    const { code, out } = check(root, home, { repair: true, writes, displays: { 'dev-one': 'Something Else default' } });
    expect(code).toBe(0);
    expect(out).toContain(`repaired: dev-one: its herdr display is set back to "${DISPLAYS['dev-one']}"`);
    expect(out).toContain('0 difference(s)');
    expect(writes.display).toEqual([['acme', paneOf(1), DISPLAYS['dev-one'] as string]]);
    expect(writes.rename).toEqual([]);
  });

  test('under a governing on policy the marks stay one quiet note, and --repair still clears them', () => {
    const { root, home } = place({ stale: false });
    record(home, root, 'dev-one', { by: DEV_CALLER, dev: true });
    setDevMode(home, root, 'on');
    const before = check(root, home);
    expect(before.out).toContain('note: 1 seat(s) recorded under dev mode');
    expect(before.out).not.toContain('registered by an agent, not by the owner');
    expect(before.code).toBe(0);

    const repaired = check(root, home, { repair: true });
    expect(repaired.code).toBe(0);
    expect(repaired.out).toContain('repaired: dev-one: re-recorded with the caller gate in force; the dev-mode mark is cleared');
    expect(repaired.out).not.toContain('seat(s) recorded under dev mode');
    expect(findAgent(home, { team: teamIdOf(root), seat: 'dev-one' })?.provenance.dev_mode).toBeUndefined();
  });

  test('a model drift keeps its relaunch advice: --repair writes no restart', () => {
    const { root, home } = place({ stale: false });
    record(home, root, 'lead', { by: 'owner' });
    const writes: Writes = { rename: [], display: [] };
    // The pane runs another model than the record signs: a difference whose repair is a decision
    // (accept the file's model, or relaunch), never a write the check makes.
    const { code, out } = check(root, home, { repair: true, writes, screens: { [paneOf(0)]: claudeScreen('Fable 5.1') } });
    expect(code).toBe(1);
    expect(out).toContain('difference: lead: signs as Claude Opus 5.5, runs Claude Fable 5.1');
    expect(out).toContain('relaunch on the recorded model');
    expect(out).not.toContain('repaired: lead: re-recorded');
  });

  test('--json carries the repaired lines, and the summary counts none', () => {
    const { root, home } = place({ stale: false });
    record(home, root, 'dev-one', { by: DEV_CALLER, dev: true });
    const { code, out } = check(root, home, { repair: true, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { repaired: string[]; differences: unknown[] };
    expect(parsed.repaired).toContain('dev-one: re-recorded with the caller gate in force; the dev-mode mark is cleared');
    expect(parsed.differences).toEqual([]);
  });
});
