// A seat whose chain declares `messaging.store: none`: its sends keep no copy, and `team check`
// names what that gives up in a note above its findings — a note, not a difference, so the total
// and the exit stay quiet, and the word is a choice rather than a fault. The note says the frame
// still carries the signed record's bytes, which a receiver verifies, and names the four things
// the copy would have carried. A person's seat is different: its pane is reached by the stored
// copy alone, so the note says a send to it is refused. A chain that keeps the copy draws no
// note at all. Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, notesOtherThanSocket, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';
import { CHECK_OUTPUT_SCHEMA } from '../src/output/index.ts';

const NOW = new Date('2026-10-17T11:00:00Z');

/** One seat, an entity whose own records this check reads the chain through. */
function teamYaml(lines: string[] = []): string {
  return `format: 1
project: acme
session: acme
entity: floor
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
${lines.join('')}`;
}

const PLAIN = teamYaml();
const HUMAN = teamYaml(['    human: true\n']);

/** The note a seat whose sends keep no copy draws, in full. */
const SEND_NOTE =
  'lead: messaging.store is none by the entity; its sends keep no copy — the frame still carries the signed record\'s bytes and a receiver verifies them, but the retry, the unread re-wake, the read receipt and the "queued, not woken" flag are given up';
/** The note a person's seat draws instead: the copy is the only way into a pane. */
const HUMAN_NOTE =
  "lead: messaging.store is none by the entity; a person's pane is reached by the stored copy alone, so a send to this seat is refused";

const made: string[] = [];
afterEach(() => {
  for (const base of made.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** One clean world: the file in a git checkout, the seat recorded ready on its own pane, a watch
 *  pass recent enough that the run itself is no difference, and the launch's brief delivered. */
function place(text: string): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-check-store-')));
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
    state.sessions.acme = {
      seats: { lead: { stage: 'ready', pane: 'fixture-pane-1', workspace: 'fixture-work-1' } },
      worktrees: {},
      watch: { pid: 1, heartbeat: NOW.toISOString() },
    };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: parsed.team.session,
    seats: ['lead'],
    home,
    at: NOW.toISOString(),
  });
  // A live endpoint, so this scene's notes stay notes and the missing reply is not a difference.
  const wrote = writePolicySet(
    home,
    { level: 'entity', target: 'floor', name: 'owner-reply-to', value: 'lead@acme' },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
  return { root, home };
}

/** The live session as herdr answers it, the seat's sidebar lines as the file writes them. */
function live(text: string): Live {
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const seat = parsed.team.seats[0]!;
  return {
    running: true,
    agents: [
      {
        name: 'lead',
        agent: 'claude',
        pane: 'fixture-pane-1',
        workspace: 'fixture-work-1',
        status: 'idle',
        cwd: null,
        displayAgent: displayAgent(seat),
      },
    ],
    workspaces: [{ id: 'fixture-work-1', label: workspaceLabel(seat) }],
    screens: { 'fixture-pane-1': CLAUDE_IDLE },
  };
}

/** The entity's signed word: the level that may loosen away from the shipped `first`. */
function store(home: string, value: 'first' | 'none'): void {
  const written = writePolicySet(
    home,
    { level: 'entity', target: 'floor', name: 'messaging.store', value },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

function check(root: string, text: string): { code: number; out: string } {
  const io = testIo(root, { kind: 'owner' });
  const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
    home: join(dirname(root), 'home'),
    live: () => live(text),
    branch: () => 'main',
    standing: (at) => approvalStanding(at, join(root, 'nowhere')),
    now: () => NOW,
  });
  return { code, out: `${io.out}${io.err}` };
}

describe('a chain that declares messaging.store none', () => {
  test("the seat is told what its sends stop keeping, and the file is otherwise clean", () => {
    const { root, home } = place(PLAIN);
    store(home, 'none');
    const { code, out } = check(root, PLAIN);
    expect(out).toContain(`note: ${SEND_NOTE}`);
    // A note is not a difference: nothing to count, nothing to fail.
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('a chain that keeps the copy draws no note', () => {
    const { root, home } = place(PLAIN);
    store(home, 'first');
    const { code, out } = check(root, PLAIN);
    expect(notesOtherThanSocket(out)).toEqual([]);
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test("a person's seat is told the send is refused, not the losses a copy would carry", () => {
    const { root, home } = place(HUMAN);
    store(home, 'none');
    const { code, out } = check(root, HUMAN);
    expect(out).toContain(`note: ${HUMAN_NOTE}`);
    expect(out).not.toContain('the retry, the unread re-wake');
    expect(out).not.toContain('difference:');
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('the note carries in the --json report', () => {
    const { root, home } = place(PLAIN);
    store(home, 'none');
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ json: true }, io, {
      home: join(dirname(root), 'home'),
      live: () => live(PLAIN),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = assertMatchesOutputSchema<{ notes: string[]; differences: unknown[] }>(io.out, CHECK_OUTPUT_SCHEMA);
    expect(doc.notes).toContain(SEND_NOTE);
    expect(doc.differences).toEqual([]);
  });
});
