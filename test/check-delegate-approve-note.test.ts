// A `delegates` entry that still names `approve`: `team approve` was removed, and the word stays
// accepted only so a file that already names it loads unchanged. `team check` names the stale word
// in a note above its findings — a note, not a difference: it is in neither the total nor the exit
// code, so a file whose only finding is the note still answers `team check: nothing wrong` — and
// the repair it names is the file, one word shorter. Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T11:00:00Z');

const HEAD = `format: 1
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
`;

/** The delegate pane the note names. */
const PANE = 'other/w1:p1';
/** The file with the stale word: a delegate granted the removed command too. */
const TEXT = `${HEAD}delegates:
  - pane: ${PANE}
    commands: [up, down, approve]
`;
/** The same file with the word dropped. */
const CLEAN = `${HEAD}delegates:
  - pane: ${PANE}
    commands: [up, down]
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const seat = loaded.team.seats[0]!;
/** Line 1 as the file writes it, so a clean world carries no label drift. */
const TITLE = workspaceLabel(seat);
/** Line 2 as the file writes it, so a clean world carries no display drift. */
const DISPLAY = displayAgent(seat);
/** The note, in full: what the check says and the repair it asks the owner for. */
const NOTE = `note: ${PANE}'s delegate entry names approve, which no command acts on since team approve was removed; drop it from the file`;

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

function place(text: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-approve-')));
  made.push(base);
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
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
  return root;
}

/** The live session as herdr answers it, with the seat's sidebar lines as the file writes them. */
function live(title = TITLE): Live {
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
    workspaces: [{ id: 'w1', label: title }],
    // The seat's own pane, readable: a quiet seat on a screen no profile reads is a difference
    // of its own, and the worlds here carry no finding beyond the one a scene names.
    screens: { 'w1:p1': CLAUDE_IDLE },
  };
}

function check(root: string, session: Live = live()): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    live: () => session,
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('a delegate entry naming approve', () => {
  test('the word is still accepted: the file loads unchanged', () => {
    expect(validateTeamFile(TEXT).ok).toBe(true);
  });

  test('the check notes the stale word, and the file is otherwise clean', () => {
    const root = place(TEXT);
    const { code, out } = check(root);
    expect(out).toContain(NOTE);
    // A note is not a difference: nothing to count, nothing to fail, no repair line of its own.
    expect(out).not.toContain('difference:');
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('an entry that does not name approve draws no note', () => {
    const root = place(CLEAN);
    const { code, out } = check(root);
    expect(out).not.toContain('note:');
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('the note and a difference answer together: the note above, the count without it', () => {
    const root = place(TEXT);
    const { code, out } = check(root, live('stale title'));
    // The note prints above the findings, as `team status` prints its notes.
    expect(out.indexOf('note: ')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('note: ')).toBeLessThan(out.indexOf('difference: '));
    // The drift is the one difference; the note is in neither the total nor the exit code.
    expect(out).toContain(`difference: lead: its herdr workspace label reads "stale title", the file says "${TITLE}"`);
    expect(out).toContain('1 difference(s)');
    expect(code).toBe(1);
  });

  test('a set-aside delivery_order in .agents/team.yaml is reported as a difference for the owner (D4) and validates under --json', () => {
    const withSetAside = [
      ...HEAD.trimEnd().split('\n'),
      '    delivery_order: [native, typed]',
      'delivery_order: [typed]',
      '',
    ].join('\n');
    const root = place(withSetAside);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({}, io, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(1);
    expect(io.out).toContain('difference: lead: delivery_order [native, typed] in .agents/team.yaml is set aside; [typed] stands\n');
    expect(io.out).toContain('  repair: drop the leg(s) not in the inherited delivery_order for lead in .agents/team.yaml\n');
    expect(io.out).toContain('  who: the owner\n');
    expect(io.out).toContain('1 difference(s), 1 for the owner\n');

    const jsonIo = testIo(root, { kind: 'owner' });
    const jsonCode = runTeamCheck({ json: true }, jsonIo, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(jsonCode).toBe(1);
    const doc = JSON.parse(jsonIo.out) as {
      schema: { name: string; version: number };
      format: number;
      project: string;
      session: string;
      differences: Array<{ what: string; repair: string; who: string; owner: boolean }>;
      summary: { differences: number; owner_differences: number };
    };
    expect(doc.schema).toEqual({ name: 'team.check', version: 1 });
    expect(doc.format).toBe(1);
    expect(doc.project).toBe('acme');
    expect(doc.session).toBe('acme');
    expect(doc.differences).toHaveLength(1);
    expect(doc.differences[0]?.who).toBe('the owner');
    expect(doc.summary).toEqual({ differences: 1, owner_differences: 1 });
  });
});
