// A seat whose record writes two names: the `nickname:` field and the persona its written label
// names. The label's persona is the seat's name when the field could hold it, so a file where they
// differ has the seat sending under one name while its record says another — or, when the word
// cannot be a nickname at all (a space, an accent, the reserved `lead`, a word another seat
// carries), the label stays a workspace title and the field's name stands. A config set on either
// name writes the other with it whenever the pair can be one name (src/config/edit.ts), so this is
// what a hand edit leaves; `team check` names both values and says which is the address. A note,
// not a difference: the team keeps running.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, notesOtherThanSocket, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00Z');

const SEAT = (role: string, name: string, lines: string[] = []): string =>
  `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${lines.join('')}`;

/** A clean team whose worker's two names agree. */
const AGREE = `format: 1
project: acme
operator: lead
workspace:
  mode: shared
seats:
${SEAT('orchestrator', 'lead', ['    label: lead\n', '    leads: true\n'])}${SEAT('implementer', 'worker', ['    nickname: Cicero\n', '    label: Cicero · implementer\n'])}`;

/** The same file after a hand edit renamed the label and left the nickname behind. */
const DRIFT = AGREE.replace('label: Cicero · implementer', 'label: Joan · implementer');

const NOTE =
  'note: seat "worker": its nickname is "Cicero" and its written label names "Joan" — the label wins from the next launch, and a set on seats.worker.label writes the two together';

/** The same file where the label names a word the nickname field cannot hold: a space is not in
 *  the nickname alphabet, so the word stays display and the record's name stands. */
const SPACED = AGREE.replace('label: Cicero · implementer', 'label: Jane Doe · implementer');

const SPACED_NOTE =
  'note: seat "worker": its written label names "Jane Doe", but the seat goes by "Cicero" — a space, an accent, the reserved "lead" or a word another seat carries is not a nickname, so the label\'s word is the workspace title alone; set seats.worker.nickname to choose the address';

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** One clean world: the file in a git checkout, each seat recorded ready on its own pane, a
 *  watch pass recent enough that the run itself is no difference. */
function place(text: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-nickname-')));
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

function check(root: string, text: string): { code: number; out: string; json: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    home: join(dirname(root), 'home'),
    live: () => live(text),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}`, json: io.out };
}

describe('a seat whose nickname and label name two people', () => {
  test('a file where they agree draws no such note', () => {
    const { out } = check(place(AGREE), AGREE);
    expect(notesOtherThanSocket(out)).toEqual([]);
  });

  test('the check names both values and says the label wins, without counting it wrong', () => {
    const { code, out } = check(place(DRIFT), DRIFT);
    expect(out).toContain(NOTE);
    expect(out).not.toContain('difference:');
    expect(code).toBe(0);
  });

  test('a label word the field cannot hold is noted as display alone', () => {
    const { code, out } = check(place(SPACED), SPACED);
    expect(notesOtherThanSocket(out)).toEqual([SPACED_NOTE]);
    expect(out).not.toContain('difference:');
    expect(code).toBe(0);
  });

  test('the note carries in the --json report', () => {
    const root = place(DRIFT);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml', json: true }, io, {
      home: join(dirname(root), 'home'),
      live: () => live(DRIFT),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(root, 'nowhere')),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = JSON.parse(io.out) as { notes: string[]; differences: unknown[] };
    expect(doc.notes).toContain(NOTE.replace(/^note: /, ''));
    expect(doc.differences).toEqual([]);
  });
});
