// The lead seat's role word: 0.3.5 and 0.4 files spell it `coordinator`, and a team upgraded from
// them keeps the word. Admission, the `lead@<team>` address and the listing all key on the lead's
// place in the file — the `leads` mark or the legacy `coordinator:` key — never on a role's word,
// so every send reaches the seat either way; `team check` names the 0.5 word `orchestrator` in a
// note so the file can be brought over when convenient. A note, not a difference: the file works,
// and the exit stays 0.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-18T09:00:00Z');

const SEAT = (role: string, name: string, lines: string[] = []): string =>
  `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${lines.join('')}`;

/** A team upgraded from 0.3.5/0.4, spelled the old way throughout: its lead is named by the
 *  `coordinator:` key, and the seat's role is the old word. */
const LEGACY = `format: 1
project: acme
coordinator: steward
operator: steward
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'steward')}`;

/** The same team in 0.5's spelling: the mark on the lead's seat, and its 0.5 role word. */
const MODERN = `format: 1
project: acme
operator: steward
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'steward', ['    leads: true\n'])}`;

const NOTE =
  'note: the lead seat "steward" carries the 0.3.5/0.4 role word "coordinator"; the 0.5 word is "orchestrator" — sends reach it either way, since admission keys on the lead seat, not the role: set `role: orchestrator` on it when convenient';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** One clean world: the file in a git checkout, each seat recorded ready on its own pane, a
 *  watch pass recent enough that the run itself is no difference. */
function place(text: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-lead-role-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[parsed.team.session] ??= emptySession());
    session.worktrees = {};
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    parsed.team.seats.forEach((seat, index) => {
      session.seats[seat.name] = { stage: 'ready', pane: `w${String(index + 1)}:p1`, workspace: `w${String(index + 1)}` };
    });
  });
  // The launch delivered the general brief before it typed: the seat's record and its state entry.
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: parsed.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });
  return root;
}

/** The live session as herdr answers it, each seat's sidebar lines as the file writes them. */
function live(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return {
    running: true,
    agents: parsed.team.seats.map((seat, index) => ({
      name: seat.name,
      agent: 'claude',
      pane: `w${String(index + 1)}:p1`,
      workspace: `w${String(index + 1)}`,
      status: 'idle',
      cwd: null,
      displayAgent: displayAgent(seat),
    })),
    workspaces: parsed.team.seats.map((seat, index) => ({ id: `w${String(index + 1)}`, label: workspaceLabel(seat) })),
    screens: Object.fromEntries(parsed.team.seats.map((_, index) => [`w${String(index + 1)}:p1`, CLAUDE_IDLE])),
  };
}

function check(root: string, text: string): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => live(text),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe("a lead seat carrying the legacy role word", () => {
  test('the check notes the 0.5 word without counting it wrong', () => {
    expect(validateTeamFile(LEGACY).ok).toBe(true);
    const { code, out } = check(place(LEGACY), LEGACY);
    expect(out).toContain(NOTE);
    // A note is not a difference: the file works as it stands, and the exit stays 0.
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a lead already spelled with the 0.5 word draws no role note', () => {
    expect(validateTeamFile(MODERN).ok).toBe(true);
    const { code, out } = check(place(MODERN), MODERN);
    expect(out).not.toContain('role word');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('the note carries in the --json report', () => {
    const root = place(LEGACY);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ json: true }, io, {
      live: () => live(LEGACY),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(NOTE.replace(/^note: /, ''));
    expect(doc.differences).toEqual([]);
  });
});
