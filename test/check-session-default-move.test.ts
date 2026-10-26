// The default session moved to <entity>-<project>. A team approved under the old default (the
// project name alone) reads, in `team check`, the same line the approval's comparison names: the
// old and the new session and the way to keep the old one. A note, not a difference: the file
// works, and the exit stays 0.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../src/approve/approval.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Standing } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-18T09:00:00Z');

const team = (lines: string): string => `format: 1
project: acme
${lines}operator: steward
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: steward
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** The file as it stands: an entity, and no `session:`, so the default is `lab-acme`. */
const MOVED = team('entity: lab\n');

const NOTE =
  'note: `session` changed: "acme" -> "lab-acme", the new default session (<entity>-<project>); approve the file again, or set `session: acme` to keep the old one';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function parse(text: string): TeamFile {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function place(text: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-session-move-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = parse(text);
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.seats.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: `w${String(index + 1)}:p1`, workspace: `w${String(index + 1)}` };
    });
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.session,
    seats: parsed.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return root;
}

function live(text: string): Live {
  const parsed = parse(text);
  return {
    running: true,
    agents: parsed.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: `w${String(index + 1)}:p1`,
      workspace: `w${String(index + 1)}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.seats.map((seat, index) => ({ id: `w${String(index + 1)}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.seats.map((_, index) => [`w${String(index + 1)}:p1`, CLAUDE_IDLE])),
  };
}

/** The record an approval under `approvedText` would have left for this root. */
function approvedUnder(approvedText: string, root: string): Standing {
  return verifiedOf(parse(approvedText), join(root, '.agents/team.yaml'), root, NOW);
}

function check(root: string, standing: Standing, json = false): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck(json ? { json: true } : { file: '.agents/team.yaml' }, io, {
    live: () => live(MOVED),
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('team check names the default-session move', () => {
  test('a team approved under the project name reads old -> new and how to keep the old one', () => {
    const root = place(MOVED);
    const { code, out } = check(root, approvedUnder(team('entity: lab\nsession: acme\n'), root));
    expect(out).toContain(NOTE);
    expect(out).not.toContain('difference:');
    expect(code).toBe(0);
  });

  test('the note carries in the --json report', () => {
    const root = place(MOVED);
    const { code, out } = check(root, approvedUnder(team('entity: lab\nsession: acme\n'), root), true);
    expect(code).toBe(0);
    const doc = JSON.parse(out) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(NOTE.replace(/^note: /, ''));
  });

  test('a team approved under the new default, or never approved, draws no note', () => {
    const root = place(MOVED);
    expect(check(root, approvedUnder(MOVED, root)).out).not.toContain('new default session');
    expect(check(root, { kind: 'none' }).out).not.toContain('new default session');
  });

  test('any other session change is not the move, and draws no note', () => {
    const root = place(MOVED);
    expect(check(root, approvedUnder(team('entity: lab\nsession: other\n'), root)).out).not.toContain('new default session');
  });
});
