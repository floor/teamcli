// A granted orchestrator approves an ordinary change of this folder's own file. The first
// approval, an owner section, a roster edit that moves the derived ceiling, a scope that
// omits approve, and a foreign --file all refuse, and none of them signs.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferencesOf, approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runApprove, type ApproveSources } from '../src/approve/command.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, readApproval, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const T = new Date('2026-10-14T12:00:00.000Z');
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

function teamText(seats: string, scope: string, limits: boolean): string {
  return `format: 1
project: acme
session: alpha
operator: lead
workspace:
  mode: shared
${limits ? 'limits:\n  seats: 9\n' : ''}rules:
  - Keep every change on a branch.
seats:
${seats}grant:
  session: alpha
  seat: lead
  scope:
${scope}`;
}

const ORDINARY = teamText(SEAT, '    - approve\n', true);
const OPEN = teamText(SEAT, '    - approve\n', false);
const NARROW = teamText(SEAT, '    - up\n', true);

type Place = { base: string; home: string; root: string; file: string; dir: string };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-approve-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return { base, home, root, file: join(dir, 'team.yaml'), dir };
}

function checked(place: Place, text: string): TeamFile {
  const result = validateTeamFile(text, { home: place.home, root: place.root });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function signed(place: Place, text: string): void {
  const team = checked(place, text);
  writeFileSync(place.file, text);
  writeApproval(
    storePath(team.project, place.root, place.home),
    { approval: approvalOf(team, place.root, T), file: text },
    team.seats,
    place.home,
  );
}

function recordLead(place: Place): void {
  updateState(place.dir, (state) => {
    const session = (state.sessions.alpha ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'lead-pane' };
  });
}

const lead: Caller = { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'alpha' };
const neverAsked = () => async (): Promise<string | null> => {
  throw new Error('a granted approve asked a question');
};
const neverRead = (): never => {
  throw new Error('a granted approve read the terminal');
};

function sources(place: Place): ApproveSources {
  return { ask: neverAsked(), waiting: neverRead, now: () => T, home: place.home };
}

async function run(place: Place, argv: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(place.root, lead);
  return { code: await runApprove(argv, io, sources(place)), out: io.out, err: io.err };
}

function storeFile(place: Place, text: string): string {
  return storePath(checked(place, text).project, place.root, place.home);
}

describe('the granted orchestrator approves an ordinary change', () => {
  test('a rules change is signed, the audit line names it, and the terminal is not asked', async () => {
    const here = place();
    signed(here, ORDINARY);
    recordLead(here);
    const candidate = ORDINARY.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(here.file, candidate);

    const result = await run(here);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('Approved.');
    expect(readFileSync(join(here.dir, 'team.log'), 'utf8')).toBe(
      `${T.toISOString()} grant [grant] lead approve: \`rules\` changed\n`,
    );
    const standing = approvalStanding(here.root, here.home);
    expect(standing.kind).toBe('verified');
    if (standing.kind !== 'verified') throw new Error('not verified');
    expect(approvalDifferencesOf(standing, checked(here, candidate))).toEqual([]);
    expect(readApproval(storeFile(here, candidate))?.file).toBe(candidate);
  });

  test('a roster edit that moves the derived ceiling is refused and unsigned', async () => {
    const here = place();
    signed(here, OPEN);
    recordLead(here);
    const candidate = OPEN.replace(SEAT, `${SEAT}${WORKER}`);
    writeFileSync(here.file, candidate);
    const before = readApproval(storeFile(here, candidate));

    const result = await run(here);
    expect(result.code).toBe(1);
    expect(result.err).toContain('this change needs the owner: `limits` changed');
    expect(readApproval(storeFile(here, candidate))).toEqual(before);
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });

  test('the first approval stays the owner\'s', async () => {
    const here = place();
    writeFileSync(here.file, ORDINARY);
    recordLead(here);
    const result = await run(here);
    expect(result.code).toBe(1);
    expect(result.err).toContain('a grant needs a verified approval: the file was never approved on this machine');
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });

  test('a trust change stays the owner\'s', async () => {
    const here = place();
    signed(here, ORDINARY);
    recordLead(here);
    const lobby = join(here.home, '.config', 'team', 'lobby');
    mkdirSync(lobby, { recursive: true });
    const candidate = ORDINARY.replace('workspace:\n', `trust:\n  - ${lobby}\n  - ${here.root}\nworkspace:\n`);
    writeFileSync(here.file, candidate);
    const before = readApproval(storeFile(here, candidate));

    const result = await run(here);
    expect(result.code).toBe(1);
    expect(result.err).toContain('this change needs the owner: `trust` changed');
    expect(readApproval(storeFile(here, candidate))).toEqual(before);
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });

  test('a grant that does not list approve refuses', async () => {
    const here = place();
    signed(here, NARROW);
    recordLead(here);
    const candidate = NARROW.replace('  - Keep every change on a branch.\n', '  - Keep every change on a branch.\n  - Sign every commit.\n');
    writeFileSync(here.file, candidate);
    const before = readApproval(storeFile(here, candidate));

    const result = await run(here);
    expect(result.code).toBe(1);
    expect(result.err).toContain('the grant does not list `approve`');
    expect(readApproval(storeFile(here, candidate))).toEqual(before);
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });

  test('a foreign --file is refused and never read', async () => {
    const here = place();
    signed(here, ORDINARY);
    recordLead(here);
    const foreign = join(here.base, 'other.yaml');
    writeFileSync(foreign, 'format: [\n');
    const before = readApproval(storeFile(here, ORDINARY));

    const result = await run(here, ['--file', foreign]);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`team approve: --file is the owner's; the granted seat cannot use it\n`);
    expect(readFileSync(foreign, 'utf8')).toBe('format: [\n');
    expect(readApproval(storeFile(here, ORDINARY))).toEqual(before);
    expect(existsSync(join(here.dir, 'team.log'))).toBe(false);
  });
});
