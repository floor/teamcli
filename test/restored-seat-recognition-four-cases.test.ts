// Independent coverage for builder-1 restored-seat recognition across the four cases the floor
// named: writer-06 (a Codex seat), architect (a Claude Code seat), a Codex CLI seat, and a Cursor
// CLI seat. The recognition reads two team-owned records and nothing else:
//
// - the agent registry's binding (`reach.agent_session`), taken only when it names this team,
//   seat, herdr session and the CLI the file declares; and
// - the seat state's own `agent_session` copy, the fallback only for a seat no record covers.
//
// A pane whose process ids are not the ones the launch recorded is still the seat when the live
// agent's session equals the recognized id; it stays a doubt when the two records disagree or
// name no session at all. `team seat` and `team status` read the same shared reader
// (`continuityIdsOf`), so the four cases are pinned there: two recognized panes, two doubts, and
// the repair a doubt advertises.
//
// Measured against the recognition change: on its pre-fix source (75a96e995^, fbccf2853) this
// file is 4 pass / 3 fail — writer-06 and the registry-bound Cursor pane stay doubts, and a
// doubt offers the plain restart instead of the `--abandon` form — while the Claude Code state
// copy and the two refusal scenes already behaved as pinned. On main 2bd7888eb it is 7 pass.
//
// Every pane, home and process reading here is a synthetic fixture; no live herdr session, CLI
// home or transcript is read. This file changes no product code.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSeat, type SeatSources } from '../src/commands/seat.ts';
import { runStatus } from '../src/commands/status.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { Live } from '../src/status/compare.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T12:00:00Z');
const SESSION = 'acme';
const DOUBT = 'restored, not launched by team';

// The captured idle screens, with each banner naming the model its seat's file declares.
const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
// The same screen left as captured: its banner names another model than the file, as the live
// Codex reviewer's pane did.
const CODEX_DRIFT = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8');
const CLAUDE_IDLE = readFileSync(new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url), 'utf8');
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.16/idle.txt', import.meta.url), 'utf8');
// A synthetic pane this build's Cursor profile does not read: the honest unknown the live
// reviewer-cursor seat showed, with no capture copied here.
const CURSOR_UNREAD = 'Cursor Agent is starting in this pane.\n';

let base: string;
let root: string;
let home: string;
let lobby: string;
let dir: string;

function teamText(): string {
  return `format: 1
project: acme
session: ${SESSION}
operator: architect
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: architect
    label: architect
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: writer-06
    label: writer-06
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
  - role: reviewer
    name: codex-reviewer
    label: codex-reviewer
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
  - role: reviewer
    name: reviewer-cursor
    label: reviewer-cursor
    cli: cursor
    vendor: cursor
    model: Grok
    version: "4.7"
    launch: cursor-agent --model grok-4.7-high
`;
}

/** The seat state a launch wrote before a host restore: the pane and the pids then. */
function recordState(extra: { cursorSession?: string } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.architect = {
      stage: 'ready', pane: 'w2:p1', workspace: 'w2', id: 'seat_222222222222',
      launched: { shell: 110, cli: [210] }, agent_session: 'ses_architect',
    } as never;
    // The registry-only record: written before the restore, with no session copy at all.
    session.seats['writer-06'] = {
      stage: 'ready', pane: 'w1:p1', workspace: 'w1', id: 'seat_111111111111',
      launched: { shell: 100, cli: [200] },
    } as never;
    session.seats['codex-reviewer'] = {
      stage: 'ready', pane: 'w3:p1', workspace: 'w3', id: 'seat_333333333333',
      launched: { shell: 120, cli: [220] }, agent_session: 'ses_codex_recorded',
    } as never;
    session.seats['reviewer-cursor'] = {
      stage: 'ready', pane: 'w4:p1', workspace: 'w4', id: 'seat_444444444444',
      launched: { shell: 130, cli: [230] },
      ...(extra.cursorSession === undefined ? {} : { agent_session: extra.cursorSession }),
    } as never;
  });
}

/** One agent registry record: the launch's binding of a seat to the conversation it ran. */
function registerSeat(name: string, cli: string, handle: string, pane: string, id: string | null): void {
  registerAgent(home, {
    name,
    signing: cli === 'cursor'
      ? { model: 'Grok', version: '4.7', role: 'reviewer' }
      : cli === 'codex'
        ? { model: 'GPT Sol', version: '6.1', role: 'implementer' }
        : { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: cli === 'cursor' ? 'cursor' : cli === 'codex' ? 'openai' : 'anthropic',
    cli,
    launcher: null,
    launch: cli === 'cursor' ? 'cursor-agent --model grok-4.7-high' : cli === 'codex' ? 'codex -m gpt-6.1-sol' : 'claude --model claude-opus-5-5',
    reach: {
      team: teamIdOf(root),
      seat: name,
      session: SESSION,
      pane,
      address: null,
      ...(id === null ? {} : { agent_session: id }),
    },
    seat_handle: handle,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

/** The four panes, each restored by the host: the pids in front are not the recorded ones. */
function live(over: { cursorSession?: string; cursorScreen?: string } = {}): Live {
  return {
    running: true,
    agents: [
      { name: 'architect', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null, session: 'ses_architect' },
      { name: 'writer-06', agent: 'codex', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null, session: 'ses_writer06' },
      { name: 'codex-reviewer', agent: 'codex', pane: 'w3:p1', workspace: 'w3', status: 'idle', cwd: null, session: 'ses_codex_live' },
      {
        name: 'reviewer-cursor', agent: 'cursor', pane: 'w4:p1', workspace: 'w4', status: 'idle', cwd: null,
        ...(over.cursorSession === undefined ? {} : { session: over.cursorSession }),
      },
    ],
    workspaces: [
      { id: 'w1', label: 'writer-06' },
      { id: 'w2', label: 'architect' },
      { id: 'w3', label: 'codex-reviewer' },
      { id: 'w4', label: 'reviewer-cursor' },
    ],
    screens: {
      'w1:p1': CODEX_IDLE,
      'w2:p1': CLAUDE_IDLE,
      'w3:p1': CODEX_DRIFT,
      'w4:p1': over.cursorScreen ?? CURSOR_IDLE,
    },
    processes: {
      'w1:p1': { shell: 101, foreground: [201] },
      'w2:p1': { shell: 111, foreground: [211] },
      'w3:p1': { shell: 121, foreground: [221] },
      'w4:p1': { shell: 131, foreground: [231] },
    },
  };
}

function seatSources(world: Live | null): SeatSources {
  return {
    live: () => world,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  };
}

async function readSeat(name: string, world: Live | null = live()): Promise<{ code: number; doc: Record<string, unknown> }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runSeat([name, '--json'], io, seatSources(world));
  if (code === 2) throw new Error(`team seat ${name} refused the read: ${io.out}${io.err}`);
  if (io.out === '') throw new Error(`team seat ${name} printed nothing: ${io.err}`);
  return { code, doc: JSON.parse(io.out) as Record<string, unknown> };
}

type StatusDoc = {
  rows: Array<{ name: string; state: string }>;
  differences: Array<{ what: string; repair: string; who: string }>;
};

async function readStatus(world: Live): Promise<{ code: number; doc: StatusDoc }> {
  const io = testIo(root, { kind: 'owner' });
  const code = await runStatus(['--json'], io, {
    live: () => world,
    branch: () => 'main',
    standing: () => ({ kind: 'none' } as const),
    now: () => NOW,
    home,
  });
  return { code, doc: JSON.parse(io.out) as StatusDoc };
}

const rowOf = (doc: StatusDoc, name: string) => doc.rows.find((row) => row.name === name);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'restored-four-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root, env: gitEnv(),
  });
  writeFileSync(join(dir, 'team.yaml'), teamText());
  recordState();
  // The two proofs the scenes vary: a registry binding only, and a registry binding whose state
  // copy agrees with it. The architect and the Cursor seat have no registry record at all.
  registerSeat('writer-06', 'codex', 'seat_111111111111', 'w1:p1', 'ses_writer06');
  registerSeat('codex-reviewer', 'codex', 'seat_333333333333', 'w3:p1', 'ses_codex_recorded');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('writer-06: a Codex seat recognized through the registry binding alone', () => {
  test('the pane is the seat: the idle screen is read, not a doubt', async () => {
    const { code, doc } = await readSeat('writer-06');
    expect(code).toBe(0);
    const status = doc.status as Record<string, unknown>;
    expect(status.name).toBe('writer-06');
    expect(status.cli).toBe('codex');
    expect(status.status).toBe('idle');
    expect(status.state).toBe('idle');
    expect(status.pane).toBe('w1:p1');
    expect(status.model).not.toBe('-');
  });
});

describe('architect: a Claude Code seat recognized through the state copy', () => {
  test('no registry record, the state\'s own session ties the pane: the seat is read', async () => {
    const { code, doc } = await readSeat('architect');
    expect(code).toBe(0);
    const status = doc.status as Record<string, unknown>;
    expect(status.cli).toBe('claude-code');
    expect(status.status).toBe('idle');
    expect(status.state).toBe('idle');
    expect(status.pane).toBe('w2:p1');
  });
});

describe('a Codex seat whose live conversation is not the recorded one', () => {
  test('stays a doubt in the per-seat read: unknown, never under the declared model', async () => {
    const { code, doc } = await readSeat('codex-reviewer');
    expect(code).toBe(0);
    const status = doc.status as Record<string, unknown>;
    expect(status.status).toBe(DOUBT);
    expect(status.state).toBe('unknown');
    expect(status.model).toBe('-');
    expect(status.pane).toBe('w3:p1');
  });

  test('status names the same doubt and the repair that really runs', async () => {
    const { code, doc } = await readStatus(live());
    expect(code).toBe(1);
    expect(rowOf(doc, 'codex-reviewer')?.state).toBe(DOUBT);
    const repair = doc.differences.find((difference) => difference.repair === 'team restart codex-reviewer --abandon');
    expect(repair).toBeDefined();
    expect(repair?.what).toContain('codex-reviewer runs GPT Terra 5.6');
    expect(repair?.what).toContain('the process in its pane is not the one team launched');
  });
});

describe('reviewer-cursor: a Cursor seat the registry does not bind', () => {
  test('stays a doubt: nothing ties the restored pane to a conversation', async () => {
    const { code, doc } = await readSeat('reviewer-cursor');
    expect(code).toBe(0);
    const status = doc.status as Record<string, unknown>;
    expect(status.status).toBe(DOUBT);
    expect(status.state).toBe('unknown');
    expect(status.model).toBe('-');
  });

  test('status reports it as a doubt and offers the look, never a command that refuses', async () => {
    const { code, doc } = await readStatus(live({ cursorScreen: CURSOR_UNREAD }));
    expect(code).toBe(1);
    expect(rowOf(doc, 'reviewer-cursor')?.state).toBe(DOUBT);
    const difference = doc.differences.find((entry) => entry.what.startsWith('reviewer-cursor:'));
    expect(difference).toBeDefined();
    expect(difference?.what).toBe('reviewer-cursor: its pane holds a process this record cannot tie to the launch');
    expect(difference?.repair).toBe('look at the pane');
  });

  test('a registry binding with the live conversation recognized the pane: Cursor is read like any CLI', async () => {
    // The Cursor profile keeps no session id of its own at launch, so the registry is the only
    // record that can tie this restored pane to the seat. When it does, the seat is the seat: the
    // Cursor idle screen is read as idle, not as a doubt.
    registerSeat('reviewer-cursor', 'cursor', 'seat_444444444444', 'w4:p1', 'ses_cursor');
    const { code, doc } = await readSeat('reviewer-cursor', live({ cursorSession: 'ses_cursor' }));
    expect(code).toBe(0);
    const status = doc.status as Record<string, unknown>;
    expect(status.cli).toBe('cursor');
    expect(status.status).toBe('idle');
    expect(status.state).toBe('idle');
    expect(status.pane).toBe('w4:p1');
  });
});
