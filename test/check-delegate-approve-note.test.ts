// A `delegates` entry that still names `approve`: `team approve` was removed, and the word stays
// accepted only so a file that already names it loads unchanged. `team check` names the stale word
// in a note above its findings — a note, not a difference: it is in neither the total nor the exit
// code, so a file whose only finding is the note still answers `0 difference(s)` — and
// the repair it names is the file, one word shorter. Fake herdr throughout: no live session is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { check as checkCommand } from '../src/commands/check.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { CHECK_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { approvalStanding } from '../src/store/store.ts';
import { updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-17T11:00:00Z');

const HEAD = `format: 1
project: acme
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
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), text);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
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
    home: join(dirname(root), 'home'),
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
    expect(out).toContain('no differences');
    expect(code).toBe(0);
  });

  test('an entry that does not name approve draws no note', () => {
    const root = place(CLEAN);
    const { code, out } = check(root);
    expect(out).not.toContain('note:');
    expect(out).toContain('no differences');
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
    expect(out).toContain('1 difference');
    expect(code).toBe(1);
  });

  test("a set-aside delivery_order in team config is reported as the lead's difference (D4) and validates under --json", () => {
    const withSetAside = [
      ...HEAD.trimEnd().split('\n'),
      '    delivery_order: [mcp-inbox, typed]',
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
    expect(io.out).toContain('difference: lead: delivery_order [mcp-inbox, typed] in team config is set aside; [typed] stands\n');
    expect(io.out).toContain('  repair: drop the 1 leg not in the inherited delivery_order for lead in team config\n');
    expect(io.out).toContain("  who: the team's lead\n");
    expect(io.out).toContain('1 difference\n');
    expect(io.out).not.toContain('(s)');

    const withTwoExtraLegs = [
      ...HEAD.trimEnd().split('\n'),
      '    delivery_order: [native, mcp-inbox, typed]',
      'delivery_order: [typed]',
      '',
    ].join('\n');
    const root2 = place(withTwoExtraLegs);
    const io2 = testIo(root2, { kind: 'owner' });
    const code2 = runTeamCheck({}, io2, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code2).toBe(1);
    expect(io2.out).toContain('  repair: drop the 2 legs not in the inherited delivery_order for lead in team config\n');
    expect(io2.out).not.toContain('(s)');

    const jsonIo = testIo(root, { kind: 'owner' });
    const jsonCode = runTeamCheck({ json: true }, jsonIo, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(jsonCode).toBe(1);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      project: string;
      session: string;
      warnings: string[];
      repaired: string[];
      notes: string[];
      differences: Array<{ what: string; repair: string; who: string }>;
      summary: { differences: number; owner_differences: number };
    }>(jsonIo.out, CHECK_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.check', version: 1 });
    expect(doc.format).toBe(1);
    expect(doc.project).toBe('acme');
    expect(doc.session).toBe('acme');
    expect(doc.differences).toHaveLength(1);
    expect(doc.differences[0]?.who).toBe("the team's lead");
    expect(doc.summary).toEqual({ differences: 1, owner_differences: 0 });
  });

  test('a seat word that adds only the native leg is no difference: the walk may declare it', () => {
    // `native` is the one leg a delivery order may add — the sender choosing its own SendMessage
    // and recording the delivery — so a seat word naming it is within the order in force.
    const addingNative = [
      ...HEAD.trimEnd().split('\n'),
      '    delivery_order: [native, typed]',
      'delivery_order: [typed]',
      '',
    ].join('\n');
    const root = place(addingNative);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({}, io, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(io.out).toContain('no differences\n');
  });

  test("a human seat's drop-only word under a team order that lacks drop is no difference: human wins", () => {
    // The seat walks `drop` alone because it is a person's pane, whatever the inherited order
    // says, so the resolver's set-aside verdict does not describe its delivery.
    const humanDrop = [
      ...HEAD.trimEnd().split('\n'),
      '    human: true',
      '    delivery_order: [drop]',
      'delivery_order: [typed]',
      '',
    ].join('\n');
    const root = place(humanDrop);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({}, io, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(io.out).not.toContain('difference:');
    expect(io.out).toContain('no differences\n');
  });

  test('--json invocation refusals (--json --nope, --nope --json, --json extra, --json=1) emit team.error on stdout', async () => {
    const root = place(CLEAN);
    const cases: Array<[string[], string]> = [
      [['--json', '--nope'], 'unknown option --nope'],
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json', 'extra'], 'unexpected "extra"'],
      [['--json=1'], '--json takes no value'],
    ];
    for (const [argv, messageContains] of cases) {
      const io = testIo(root, { kind: 'owner' });
      const code = await checkCommand(argv, io);
      expect(code).toBe(2);
      expect(io.err).toBe('');
      assertJsonErrorShape(io.out, { id: 'check.invocation', messageContains, repair: null });
    }
  });

  test('every deprecation warning in team check carries its repair command', () => {
    const withDeprecations = [
      ...HEAD.trimEnd().split('\n'),
      'dialogs:',
      '  trust: coordinator',
      'watch:',
      '  quota_marks: [50, 75]',
      'budgets:',
      '  marks: [50, 75]',
      '',
    ].join('\n');
    const root = place(withDeprecations);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ json: true }, io, {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' }),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = assertMatchesOutputSchema<{ warnings: string[] }>(io.out, CHECK_OUTPUT_SCHEMA);
    expect(doc.warnings).toEqual([
      "warning: the file, line 3: `coordinator:` is now `leads: true` on the lead's seat, and is still read; repair: set `leads: true` on the lead's seat and remove `coordinator:` from team config",
      'warning: the file, line 19: watch.quota_marks is now budgets.marks, and is still read; repair: move `watch.quota_marks` to `budgets.marks` in team config',
      'warning: the file, line 21: budgets.marks replaces watch.quota_marks; repair: remove `watch.quota_marks` from team config and keep `budgets.marks`',
      'warning: the file, line 16: `dialogs:` is deprecated and grants nothing; repair: remove dialogs: from team config; trust answering is now an owner grant: team grant @team --capabilities dialogs.trust',
    ]);
  });

  test('team check on a fallback copy emits the fallback notice in plain text and in the team.check JSON envelope', () => {
    const root = place(CLEAN);
    const sources = {
      live: () => live(TITLE),
      branch: () => 'main',
      standing: () => ({ kind: 'none' as const }),
      now: () => NOW,
    };
    // Seed last_valid as status/watch/hold do (team check itself never writes last_valid).
    updateState(join(root, '.agents'), (s) => {
      s.last_valid = { read_at: NOW.toISOString(), file: CLEAN };
    });
    // Break team.yaml so currentTeam falls back to last_valid with a notice.
    writeFileSync(join(root, '.agents', 'team.yaml'), 'format: [\n', 'utf8');

    const plainIo = testIo(root, { kind: 'owner' });
    expect(runTeamCheck({}, plainIo, sources)).toBe(0);
    const lines = plainIo.out.split('\n');
    expect(lines[0]).toBe(
      'team config is invalid (line 1: "[" is not closed on its line); using the copy of 2026-10-17T11:00:00.000Z',
    );
    expect(lines[1]).toBe('team acme, session "acme"');

    const jsonIo = testIo(root, { kind: 'owner' });
    expect(runTeamCheck({ json: true }, jsonIo, sources)).toBe(0);
    const doc = assertMatchesOutputSchema<{ notice?: string }>(jsonIo.out, CHECK_OUTPUT_SCHEMA);
    expect(doc.notice).toBe(
      'team config is invalid (line 1: "[" is not closed on its line); using the copy of 2026-10-17T11:00:00.000Z',
    );
  });

  test('idle or done on an unrecognised screen is not a difference in check, and an unknown herdr status is a note (exit 0)', () => {
    const root = place(CLEAN);
    for (const status of ['idle', 'done']) {
      const io = testIo(root, { kind: 'owner' });
      const code = runTeamCheck({ json: true }, io, {
        live: () => ({
          running: true,
          agents: [
            {
              name: 'lead',
              agent: 'claude',
              pane: 'w1:p1',
              workspace: 'w1',
              status,
              cwd: null,
              displayAgent: DISPLAY,
            },
          ],
          workspaces: [{ id: 'w1', label: TITLE }],
          screens: { 'w1:p1': 'Some unrecognised terminal text\n' },
        }),
        branch: () => 'main',
        standing: () => ({ kind: 'none' as const }),
        now: () => NOW,
      });
      expect(code).toBe(0);
      const doc = assertMatchesOutputSchema<{ differences: unknown[]; notes: string[] }>(io.out, CHECK_OUTPUT_SCHEMA);
      expect(doc.differences).toEqual([]);
      expect(doc.notes.some((n) => n.includes('herdr reports the status'))).toBe(false);
    }

    const unknownIo = testIo(root, { kind: 'owner' });
    const unknownCode = runTeamCheck({ json: true }, unknownIo, {
      live: () => ({
        running: true,
        agents: [
          {
            name: 'lead',
            agent: 'claude',
            pane: 'w1:p1',
            workspace: 'w1',
            status: 'unknown',
            cwd: null,
            displayAgent: DISPLAY,
          },
        ],
        workspaces: [{ id: 'w1', label: TITLE }],
        screens: { 'w1:p1': CLAUDE_IDLE },
      }),
      branch: () => 'main',
      standing: () => ({ kind: 'none' as const }),
      now: () => NOW,
    });
    expect(unknownCode).toBe(0);
    const unknownDoc = assertMatchesOutputSchema<{ differences: unknown[]; notes: string[] }>(
      unknownIo.out,
      CHECK_OUTPUT_SCHEMA,
    );
    expect(unknownDoc.differences).toEqual([]);
    expect(unknownDoc.notes).toContain('lead: herdr reports the status "unknown"');
  });

  test('a jules seat herdr reports unknown is read from its screen: no note and no attention (exit 0)', () => {
    // The same world as the unknown-status scene above, one cli different: the profile says herdr
    // cannot report this CLI, so the screen is the reading and `unknown` is not a finding.
    const head = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: jules
    vendor: google
    model: Jules
    version: "0.1.42"
    launch: jules
    leads: true
`;
    const root = place(head);
    const parsed = validateTeamFile(head);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const julesSeat = parsed.team.seats[0]!;
    const julesIdle = readFileSync(new URL('./fixtures/jules/0.1.42/idle.txt', import.meta.url), 'utf8');
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml', json: true }, io, {
      live: () => ({
        running: true,
        agents: [
          {
            name: 'lead',
            agent: null,
            pane: 'w1:p1',
            workspace: 'w1',
            status: 'unknown',
            cwd: null,
            displayAgent: displayAgent(julesSeat),
          },
        ],
        workspaces: [{ id: 'w1', label: workspaceLabel(julesSeat) }],
        screens: { 'w1:p1': julesIdle },
      }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, join(root, 'nowhere')),
      now: () => NOW,
    });
    expect(code).toBe(0);
    const doc = assertMatchesOutputSchema<{ differences: unknown[]; notes: string[] }>(io.out, CHECK_OUTPUT_SCHEMA);
    expect(doc.differences).toEqual([]);
    expect(doc.notes.some((note) => note.includes('herdr reports the status'))).toBe(false);
  });
});
