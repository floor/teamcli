// The lobby the team registry recorded is the one the team operates on: editing a running team's
// `entity` does not move it. `team check` names the gap between what the file's entity derives and
// what the registry records in a note above its findings — a note, not a difference: it is in
// neither the total nor the exit code, so a file whose only remark is the note still answers
// `team check: nothing wrong`. Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { noteTeam, setRoster, teamIdOf } from '../src/registry/teams.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T11:00:00Z');

/** The team file, with the entity whose lobby the file itself would derive. */
function teamYaml(entity: string): string {
  return `format: 1
project: acme
session: acme
entity: ${entity}
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
`;
}

const loaded = validateTeamFile(teamYaml('acme'));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;
/** Line 1 as the file writes it, so a clean world carries no label drift. */
const TITLE = workspaceLabel(seat);
/** Line 2 as the file writes it, so a clean world carries no display drift. */
const DISPLAY = displayAgent(seat);

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function place(text: string): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-lobby-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  // The seat's pane as the launch recorded it, and a watch pass recent enough that the run
  // itself is no difference: the two ambient findings every clean check world seeds away.
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: { lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1' } },
      worktrees: {},
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    };
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({ dir: join(root, '.agents'), root, session: 'acme', seats: ['lead'], home, at: NOW.toISOString() });
  return { root, home };
}

/** A registered team, with its seat on the roster the permission bridge reads. */
function record(root: string, home: string, entity: string, session = 'acme'): void {
  noteTeam(home, root, { project: 'acme', entity, session, lobby: null }, 'defined', 'owner');
  setRoster(home, teamIdOf(root), [{ agent: 'agt_000000000000', seat: 'lead', role: 'orchestrator', leads: true }]);
}

/** The live session as herdr answers it, with the seat's sidebar lines as the file writes them. */
function live(): Live {
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'w1:p1',
        workspace: 'w1',
        status: 'idle',
        cwd: null,
        displayAgent: DISPLAY,
      },
    ],
    workspaces: [{ id: 'w1', label: TITLE }],
    // The seat's own pane, readable: a quiet seat on a screen no profile reads is a difference
    // of its own, and the worlds here carry no finding beyond the one a scene names.
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

function check(root: string, home: string): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
    home,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe("a file whose entity no longer derives the registry's lobby", () => {
  test('the check notes the gap, and the file is otherwise clean', () => {
    const { root, home } = place(teamYaml('fleet'));
    // Registered while the file said `acme`: the record holds that lobby, and the file's entity
    // now derives another folder.
    record(root, home, 'Acme');
    const { code, out } = check(root, home);
    expect(out).toContain(
      'note: the file\'s entity derives the lobby ~/.config/team/lobbies/fleet, '
      + 'and the registry records ~/.config/team/lobbies/acme: the recorded lobby stands',
    );
    // A note is not a difference: nothing to count, nothing to fail, no repair line of its own.
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a file whose entity still derives the recorded lobby draws no note', () => {
    const { root, home } = place(teamYaml('acme'));
    record(root, home, 'Acme');
    const { code, out } = check(root, home);
    expect(out).not.toContain('note:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a team the registry holds no record of draws no note: nothing has derived a lobby yet', () => {
    const { root, home } = place(teamYaml('fleet'));
    const { code, out } = check(root, home);
    expect(out).not.toContain('note:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('another team\'s record in the same checkout draws no note: its lobby is not this file\'s', () => {
    const { root, home } = place(teamYaml('fleet'));
    // The registry is keyed by the root; this record belongs to the team running session beta.
    record(root, home, 'Zeta', 'beta');
    const { code, out } = check(root, home);
    expect(out).not.toContain('note:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });
});
