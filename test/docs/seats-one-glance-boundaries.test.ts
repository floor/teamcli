// The seats page's caller section: who may read the registry, row by row, held to the code that
// decides it. The page's four-row table and its two console lines are pinned as written; each
// rule the table states is pinned to the line that enforces it (the one sentence, the two flag
// refusals, the fail-closed verdicts, the delegates entries); and the admission the page promises
// is driven through `runSeats` itself — the seat on its recorded pane reads, a state that records
// no pane fails closed, and a pane the approved file names reads — so the page cannot claim an
// admission or a refusal the command does not give.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifiedOf } from '../../src/approve/approval.ts';
import { runSeats, type SeatsSources } from '../../src/commands/seats.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { emptySession, updateState } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import { testIo } from '../helpers.ts';

const PAGE = '../../docs/commands/seats.md';
const SEATS_SRC = '../../src/commands/seats.ts';
const CALLER_SRC = '../../src/caller.ts';
const GATE_SRC = '../../src/read-gate.ts';
const DELEGATE_SRC = '../../src/delegate.ts';

// The section as written: its heading, the four caller rows, the flag paragraph, and the two
// console lines — the seat name in them is what `describeCaller` gives a seat caller.
const HEADING = '## Who may run it';
const OWNER_ROW = 'read the team, and aim the read with `--file` and `--session`';
const SEAT_ROW_PLACED = "placed in the file's session, on the pane the state records for it";
const SEAT_ROW_CLOSED = 'a seat the state records no pane for, or records on another pane, fails closed';
const DELEGATES_ROW = 'a pane outside the team that the approved file names in its `delegates` entries';
const ANYONE_ROW = 'nothing: `team seats: this team is not yours to read`, exit 2';
const FLAG_PARAGRAPH = 'aimed by anyone else are refused before any file or session is read, and exit 1';
const CONSOLE_FILE = "team seats: --file is the owner's, from a terminal outside herdr; this call is claude-keeper";
const CONSOLE_SESSION = "team seats: --session is the owner's, from a terminal outside herdr; this call is claude-keeper";

// The lines that decide each row: the one sentence and its exit id, the two flag refusals and
// theirs, the two fail-closed verdicts behind "fails closed", the gate's admission sentence, and
// the delegates entries it reads.
const SRC_NOT_YOURS = "io.stderr('team seats: this team is not yours to read\\n');";
const SRC_EXIT_NOT_YOURS = '// exit: seats.not-yours';
const SRC_EXIT_FILE = '// exit: seats.file-owner';
const SRC_EXIT_SESSION = '// exit: seats.session-owner';
const SRC_FILE_TEMPLATE = "--file is the owner's, from a terminal outside herdr; this call is ${describeCaller(walked)}";
const SRC_SESSION_TEMPLATE = "--session is the owner's, from a terminal outside herdr; this call is ${describeCaller(walked)}";
const SRC_NO_PANE = "if (at.recordedPane === undefined) return { kind: 'no-pane', name };";
const SRC_ANOTHER_PANE =
  "return caller.pane === at.recordedPane ? { kind: 'ok' } : { kind: 'another-pane', name, recordedPane: at.recordedPane };";
// A block-comment pin: the ` * ` markers survive whitespace collapse, so the needle stays within
// one comment line.
const SRC_ADMISSION = 'pane this call stands on, or a pane the approved file names';
const SRC_DELEGATES = 'const entries = team.delegates ?? [];';
const SRC_FIND_ENTRY = "return findEntry(entries, io).kind === 'match';";

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe("the seats page's caller section", () => {
  test('the four rows, the flag paragraph and both console lines stand as written', () => {
    const page = prose(PAGE);
    expect(page.includes(HEADING), 'seats.md lost its Who may run it heading').toBe(true);
    expect(page.includes(OWNER_ROW), 'the owner row lost its --file and --session aim').toBe(true);
    expect(page.includes(SEAT_ROW_PLACED), 'the seat row lost its recorded-pane placement').toBe(true);
    expect(page.includes(SEAT_ROW_CLOSED), 'the seat row lost its fails-closed clause').toBe(true);
    expect(page.includes(DELEGATES_ROW), 'the delegates row lost the approved-file naming').toBe(true);
    expect(page.includes(ANYONE_ROW), 'the anyone-else row lost the one sentence and its exit').toBe(true);
    expect(page.includes(FLAG_PARAGRAPH), 'the flag paragraph lost its before-any-read refusal').toBe(true);
    expect(page.includes(CONSOLE_FILE), 'the page lost the --file console line').toBe(true);
    expect(page.includes(CONSOLE_SESSION), 'the page lost the --session console line').toBe(true);
  });

  test('every row is decided by the line it names: the sentence, the refusals, the verdicts, the gate', () => {
    const command = raw(SEATS_SRC);
    expect(command.includes(SRC_NOT_YOURS), 'seats.ts no longer prints the one sentence').toBe(true);
    expect(command.includes(SRC_EXIT_NOT_YOURS), 'seats.ts lost the not-yours exit id').toBe(true);
    expect(command.includes(SRC_EXIT_FILE), 'seats.ts lost the --file refusal exit id').toBe(true);
    expect(command.includes(SRC_EXIT_SESSION), 'seats.ts lost the --session refusal exit id').toBe(true);
    const caller = raw(CALLER_SRC);
    expect(caller.includes(SRC_FILE_TEMPLATE), 'caller.ts lost the --file refusal template').toBe(true);
    expect(caller.includes(SRC_SESSION_TEMPLATE), 'caller.ts lost the --session refusal template').toBe(true);
    expect(caller.includes(SRC_NO_PANE), 'callerVerdict no longer fails closed on a missing pane record').toBe(true);
    expect(caller.includes(SRC_ANOTHER_PANE), 'callerVerdict no longer fails closed on another pane').toBe(true);
    expect(prose(GATE_SRC).includes(SRC_ADMISSION), 'read-gate.ts lost the admission sentence the rows state').toBe(true);
    const delegate = raw(DELEGATE_SRC);
    expect(delegate.includes(SRC_DELEGATES), 'the read gate no longer reads the delegates entries').toBe(true);
    expect(delegate.includes(SRC_FIND_ENTRY), 'the read gate no longer admits a named pane').toBe(true);
  });

  test('the admission the table promises, through the command itself', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seats-caller-')));
    try {
      const example = readFileSync(new URL('../fixtures/example.yaml', import.meta.url), 'utf8');
      const delegated = `${example.endsWith('\n') ? example : `${example}\n`}delegates:\n  - pane: foreign/w9:p1\n    commands: [up]\n`;
      const now = new Date('2026-10-12T20:00:00Z');
      const quiet: Live = { running: false, agents: [], workspaces: [], screens: {} };
      const sources: SeatsSources = {
        live: () => quiet,
        branch: () => null,
        standing: () => ({ kind: 'none' }),
        now: () => now,
        home: base,
        gate: { standing: () => ({ kind: 'none' }), agents: () => [] },
      };
      const seat = { kind: 'seat', name: 'claude-coordinator-acme', pane: 'w1:p1', session: 'acme-web' } as const;

      const folder = (text: string): string => {
        mkdirSync(join(base, '.agents'), { recursive: true });
        writeFileSync(join(base, '.agents', 'team.yaml'), text);
        return base;
      };
      const record = (): void => {
        updateState(join(base, '.agents'), (state) => {
          const session = (state.sessions['acme-web'] ??= emptySession());
          session.seats[seat.name] = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
        });
      };

      // A seat placed on the pane the state records for it, in the file's session, reads. The
      // fixture's deprecated `coordinator:` line warns on stderr; the admission claim is that the
      // one sentence never appears.
      folder(example);
      record();
      const placed = testIo(base, seat);
      const placedCode = await runSeats([], placed, sources);
      expect(placedCode).toBe(0);
      expect(placed.out).toContain('SEAT ');
      expect(placed.out).toContain(seat.name);
      expect(placed.err).not.toContain('not yours to read');

      // The same seat when the state records no pane for it fails closed: the one sentence, exit 2.
      writeFileSync(join(base, '.agents', 'team.yaml'), example);
      updateState(join(base, '.agents'), (state) => {
        state.sessions['acme-web'] = emptySession();
      });
      const unrecorded = testIo(base, seat);
      const unrecordedCode = await runSeats([], unrecorded, sources);
      expect(unrecordedCode).toBe(2);
      expect(unrecorded.err).toBe('team seats: this team is not yours to read\n');
      expect(unrecorded.out).toBe('');

      // A pane outside the team that the approved file names in its delegates entries reads.
      folder(delegated);
      const checked = validateTeamFile(delegated);
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
      const delegateSources: SeatsSources = {
        ...sources,
        standing: () => verifiedOf(checked.team, delegated, base, now),
        gate: {
          standing: () => verifiedOf(checked.team, delegated, base, now),
          approvedCopy: () => delegated,
          agents: () => [],
        },
      };
      const named = testIo(base, { kind: 'pane', pane: 'w9:p1', session: 'foreign' });
      const namedCode = await runSeats([], named, delegateSources);
      expect(namedCode).toBe(0);
      expect(named.out).toContain(seat.name);
      expect(named.err).not.toContain('not yours to read');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
