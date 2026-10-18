// A seat literally named `lead`: `lead@<team>` is the send grammar's address for the seat that
// holds `leads`, and the word may not become a new seat's name or any nickname — but a file
// written before 0.5.0 may carry it, so it keeps loading. Where the named seat is the team's
// lead, the address and the bare name reach the same seat and there is nothing to say. Where
// another seat leads, `team check` names it in a note — a note, not a difference: the address
// still reaches the lead, the legacy seat answers its bare name, and the repair `team rename`
// (landing after this change) gives it another one. A nickname of that name is refused at load:
// nicknames are new, and the reservation binds them.
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
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

const SEAT = (role: string, name: string, lines: string[] = []): string =>
  `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${lines.join('')}`;

/** An upgraded file whose lead's seat is still literally named `lead`: the name is the legacy
 *  bit here, so the role is 0.5's word and this file draws no note beyond the `coordinator:` key. */
const LEGACY = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'lead', ['    leads: true\n'])}`;

/** The same team where another seat leads: the name stays a legacy seat's bare address. */
const SPLIT = `format: 1
project: acme
operator: atlas
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'atlas', ['    leads: true\n'])}${SEAT('builder', 'lead')}`;

/** A nickname may not take the reserved word: nicknames are written from 0.5.0 on. */
const NICKNAMED = `format: 1
project: acme
operator: atlas
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'atlas', ['    leads: true\n'])}${SEAT('builder', 'builder-1', ['    nickname: lead\n'])}`;

const split = validateTeamFile(SPLIT);
if (!split.ok) throw new Error(JSON.stringify(split.errors));
const atlas = split.team.seats.find((seat) => seat.name === 'atlas')!;
const legacySeat = split.team.seats.find((seat) => seat.name === 'lead')!;

const NOTE =
  'note: seat "lead" does not hold leads: lead@<team> addresses the seat that does, so this seat answers only to its bare name; the team\'s lead: run team rename lead <new-name> to give it another name';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** One clean world: the file in a git checkout, each seat recorded ready on its own pane, a
 *  watch pass recent enough that the run itself is no difference. */
function place(text: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-lead-name-')));
  made.push(base);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
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

describe('a legacy seat named lead', () => {
  test('a file whose named seat holds leads loads and draws no note: the address and the name reach it', () => {
    expect(validateTeamFile(LEGACY).ok).toBe(true);
    const { code, out } = check(place(LEGACY), LEGACY);
    expect(out).not.toContain('note:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a named seat another seat leads by loads, and the check notes it without counting it wrong', () => {
    expect(validateTeamFile(SPLIT).ok).toBe(true);
    const { code, out } = check(place(SPLIT), SPLIT);
    expect(out).toContain(NOTE);
    // A note is not a difference, and the repair is the team's lead's: the exit stays 0.
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('the note carries in the --json report', () => {
    const root = place(SPLIT);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ json: true }, io, {
      live: () => live(SPLIT),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(NOTE.replace(/^note: /, ''));
    expect(doc.differences).toEqual([]);
  });

  test('a nickname may not take the reserved word: the file is refused at load', () => {
    const loaded = validateTeamFile(NICKNAMED);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors.map((problem) => problem.message)).toContain(
      'seat "builder-1": "lead" is reserved: lead@<team> addresses the team\'s lead, so no nickname takes it',
    );
  });

  test('a seat named lead with another seat leading is not a load error', () => {
    expect(atlas.name).toBe('atlas');
    expect(legacySeat.name).toBe('lead');
  });
});
