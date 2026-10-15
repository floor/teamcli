// The refusals a granted approve answers with, at the edges the file's own rows describe:
// the seat the grant does not name (and the owner sentence that never prints beside it),
// the granted seat with no recorded pane, the granted seat restored onto another pane, the
// file that names no grant at all, and the grant a seat wrote into the live file itself.
// Every row drives runApprove against a signed store and the recorded state, and proves
// the refusal unsigned: the approval record stands and no audit line is written.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runApprove, type ApproveSources } from '../src/commands/approve.ts';
import type { Caller } from '../src/caller.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const T = new Date('2026-10-15T09:00:00.000Z');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEAT = `  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const WORKER = `  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** The file without its grant block: everything the owner signs, granting nothing. */
const PLAIN = `format: 1
project: acme
session: alpha
operator: lead
workspace:
  mode: shared
limits:
  seats: 9
rules:
  - Keep every change on a branch.
seats:
${SEAT}${WORKER}`;

/** The same file with the owner's grant: the orchestrator's seat may approve. */
const GRANTED = `${PLAIN}
grant:
  session: alpha
  seat: lead
  scope:
    - approve
`;

const RULES_EDIT = '  - Keep every change on a branch.\n  - Sign every commit.\n';

type Place = { base: string; home: string; root: string; file: string; dir: string };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-refusals-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return { base, home, root, file: join(dir, 'team.yaml'), dir };
}

function checked(at: Place, text: string): TeamFile {
  const result = validateTeamFile(text, { home: at.home, root: at.root });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

/** The owner signs `text`: the file on disk and the store's approved copy, in one write. */
function signed(at: Place, text: string): void {
  const team = checked(at, text);
  writeFileSync(at.file, text);
  writeApproval(
    storePath(team.project, at.root, at.home),
    { approval: approvalOf(team, at.root, T), file: text },
    team.seats,
    at.home,
  );
}

/** The state records the granted seat on its launched pane. */
function recordLead(at: Place): void {
  updateState(at.dir, (state) => {
    const session = (state.sessions.alpha ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'lead-pane' };
  });
}

const neverAsked = () => async (): Promise<string | null> => {
  throw new Error('a granted approve asked a question');
};
const neverRead = (): never => {
  throw new Error('a granted approve read the terminal');
};

async function run(
  at: Place,
  caller: Caller,
  argv: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(at.root, caller);
  const sources: ApproveSources = { ask: neverAsked(), waiting: neverRead, now: () => T, home: at.home };
  return { code: await runApprove(argv, io, sources), out: io.out, err: io.err };
}

function approvalOfPlace(at: Place, text: string) {
  return readApproval(storePath(checked(at, text).project, at.root, at.home));
}

/** The candidate the granted seat brings: the owner's file with one ordinary rules change. */
function candidateOf(text: string): string {
  return text.replace('  - Keep every change on a branch.\n', `  - Keep every change on a branch.\n${RULES_EDIT}`);
}

describe('the refusals a granted approve answers with', () => {
  test('a seat the grant does not name is refused by name, and the owner sentence never prints', async () => {
    const at = place();
    signed(at, GRANTED);
    recordLead(at);
    const candidate = candidateOf(GRANTED);
    writeFileSync(at.file, candidate);
    const before = approvalOfPlace(at, GRANTED);

    // The grant names lead; worker is a declared seat of the same file, on its own pane.
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'worker-pane', session: 'alpha' };
    const result = await run(at, worker);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'team approve: only the seat the grant names runs this: this call is worker\n',
    );
    // The file names a grant, so the not-owner sentence — the one its row ties to a file with
    // neither `delegates` nor `grant` — has no turn here.
    expect(result.err).not.toContain('only the owner approves a team file');
    expect(readApproval(storePath(checked(at, GRANTED).project, at.root, at.home))).toEqual(before);
    expect(existsSync(join(at.dir, 'team.log'))).toBe(false);
  });

  test('the granted seat with no recorded pane is told the repair that records one', async () => {
    const at = place();
    signed(at, GRANTED);
    // No recordLead: nothing in the state tells this seat apart from a renamed shell.
    const candidate = candidateOf(GRANTED);
    writeFileSync(at.file, candidate);
    const before = approvalOfPlace(at, GRANTED);

    const lead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'alpha' };
    const result = await run(at, lead);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'team approve: no pane is recorded for seat lead in this session: the owner stops that seat and runs `team up`\n',
    );
    expect(readApproval(storePath(checked(at, GRANTED).project, at.root, at.home))).toEqual(before);
    expect(existsSync(join(at.dir, 'team.log'))).toBe(false);
  });

  test('the granted seat restored onto another pane is told the stop-and-start repair', async () => {
    const at = place();
    signed(at, GRANTED);
    recordLead(at);
    const candidate = candidateOf(GRANTED);
    writeFileSync(at.file, candidate);
    const before = approvalOfPlace(at, GRANTED);

    // The state records lead-pane; the call comes from the pane a restore started it on.
    const restored: Caller = { kind: 'seat', name: 'lead', pane: 'restored-pane', session: 'alpha' };
    const result = await run(at, restored);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'team approve: the state records pane lead-pane for seat lead in this session, not the pane this call is on: the owner stops the team and starts it again (`team down`, then `team up`)\n',
    );
    expect(readApproval(storePath(checked(at, GRANTED).project, at.root, at.home))).toEqual(before);
    expect(existsSync(join(at.dir, 'team.log'))).toBe(false);
  });

  test('a file that names neither delegates nor grant keeps the owner sentence', async () => {
    const at = place();
    signed(at, PLAIN);
    recordLead(at);
    const candidate = candidateOf(PLAIN);
    writeFileSync(at.file, candidate);
    const before = approvalOfPlace(at, PLAIN);

    const lead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'alpha' };
    const result = await run(at, lead);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      'team approve: only the owner approves a team file, from a terminal outside herdr; this call is lead\n',
    );
    expect(readApproval(storePath(checked(at, PLAIN).project, at.root, at.home))).toEqual(before);
    expect(existsSync(join(at.dir, 'team.log'))).toBe(false);
  });

  test('a grant the seat wrote into the live file itself answers "this change needs the owner"', async () => {
    const at = place();
    signed(at, PLAIN);
    recordLead(at);
    // The owner signed a file granting nothing; the seat writes the grant in itself, naming
    // itself, with approve in its scope, over an ordinary rules change of its own too.
    const candidate = `${candidateOf(PLAIN)}
grant:
  session: alpha
  seat: lead
  scope:
    - approve
`;
    writeFileSync(at.file, candidate);
    const before = approvalOfPlace(at, PLAIN);

    const lead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'alpha' };
    const result = await run(at, lead);
    expect(result.code).toBe(1);
    expect(result.err).toBe('team approve: this change needs the owner: `grant` changed\n');
    expect(readApproval(storePath(checked(at, PLAIN).project, at.root, at.home))).toEqual(before);
    expect(existsSync(join(at.dir, 'team.log'))).toBe(false);
  });
});
