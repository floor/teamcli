// The stale-approval report after an owner-section change: a removed seat is named instead of a
// bare `limits` change, a default seat ceiling that followed the roster says so, and the printed
// repair is an outcome this build can actually reach. Display only: the gate's own list is
// unchanged. Every scene keeps its registry under its own temp home; the real one is never read.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { runConfig } from '../src/commands/config.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { intoRegistry, realRegistryTouched, storedTeam } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-31T09:00:00.000Z');
const SEATS = `seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const HEAD = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
`;
const TEAM = HEAD + SEATS;
const TEAM_NO_TEMPORARY = HEAD + `limits:
  temporary: 0
` + SEATS;
const TEAM_EXPLICIT_SEATS = HEAD + `limits:
  seats: 2
` + SEATS;
// A pre-default approval: the session was written explicitly; the live record takes the default.
const MOVED = `format: 1
project: acme
entity: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
` + SEATS;
const MOVED_APPROVED = MOVED.replace('entity: acme\n', 'entity: acme\nsession: acme\n');
// The same team, one owner section further on than the copy the approval holds.
const MOVED_FURTHER = MOVED.replace('seats:\n', 'limits:\n  temporary: 1\nseats:\n');
// A fixed seat ceiling: taking the worker out moves no owner section, so the approval's own
// comparison stays empty while the two records differ.
const MOVED_FIXED = MOVED.replace('seats:\n', 'limits:\n  seats: 2\nseats:\n');
const MOVED_FIXED_ONE = MOVED_FIXED.replace(/  - role: implementer\n(?:    [^\n]*\n)*/, '');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string };
/** A registry-backed team whose stored approval may name an earlier record than the live one. */
function placeApproved(approved: string, current: string): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-approval-stale-report-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), current);
  intoRegistry(root, home);
  const checked = validateTeamFile(approved);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: approved }, checked.team.seats, home, NOW);
  return { home, root };
}
function place(text: string): Place {
  return placeApproved(text, text);
}
/** A team file on disk and no registry record yet: `team migrate` writes the registry itself. */
function migratePlace(approved: string, current: string = approved): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-approval-stale-report-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), current);
  const checked = validateTeamFile(approved);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: approved }, checked.team.seats, home, NOW);
  return { home, root };
}
/** The next `now()` call tampers with the stored signature: a bad signature over an unchanged copy. */
function tamperAfterReading(at: Place): () => Date {
  let tampered = false;
  return () => {
    if (!tampered) {
      tampered = true;
      const file = join(storePath('acme', at.root, at.home), 'approval.json');
      const record = JSON.parse(readFileSync(file, 'utf8')) as { signature?: string };
      record.signature = '00';
      writeFileSync(file, JSON.stringify(record));
    }
    return NOW;
  };
}
async function migrate(at: Place, argv: string[], now: () => Date) {
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runMigrate(argv, io, { home: at.home, now });
  return { code, out: io.out, err: io.err };
}

async function config(at: Place, argv: string[]) {
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runConfig(argv, io, {
    home: at.home,
    env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' },
    now: () => NOW,
  });
  return { code, out: io.out, err: io.err };
}

function live(at: Place) {
  const text = storedTeam(at.root, at.home)?.text ?? '';
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return { text, team: checked.team };
}

test('a removed seat is named, and the default ceiling says it followed the roster', async () => {
  const at = place(TEAM);
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  expect(removed.out).toContain('seat worker is missing since the last approval');
  expect(removed.out).toContain('the default seat ceiling follows the roster (3 seats)');
  expect(removed.out).not.toContain('`limits` changed');
  // The repair names an outcome this build has, never a command it does not.
  expect(removed.out).toContain('the change was applied');
  expect(removed.out).toContain('the stored team approval still describes an earlier record');
  expect(removed.out).toContain('this version has no command to refresh that snapshot');
  expect(removed.out).not.toContain('approve the team again');
});

test('a seat change beside the removal is named too', async () => {
  const at = place(TEAM);
  const changed = await config(at, ['set', 'seats.lead.model', 'Claude Sonnet']);
  expect(changed.code, changed.err).toBe(0);
  expect(changed.out).toContain('seat lead changed');
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  expect(removed.out).toContain('seat lead changed');
  expect(removed.out).toContain('seat worker is missing since the last approval');
  expect(removed.out).toContain('the default seat ceiling follows the roster (3 seats)');
});

test('one seat left reads as one seat', async () => {
  const at = place(TEAM_NO_TEMPORARY);
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  expect(removed.out).toContain('the default seat ceiling follows the roster (1 seat)');
});

test('a limits edit of its own keeps its own line beside the removed seat', async () => {
  const at = place(TEAM_NO_TEMPORARY);
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  const temporary = await config(at, ['set', 'limits.temporary', '3']);
  expect(temporary.code, temporary.err).toBe(0);
  expect(temporary.out).toContain('`limits` changed');
  expect(temporary.out).toContain('seat worker is missing since the last approval');
  expect(temporary.out).not.toContain('the default seat ceiling follows the roster');
  expect(temporary.out).toContain('this version has no command to refresh that snapshot');
});

test('an explicit limits.seats keeps a removal out of the stale report', async () => {
  const at = place(TEAM_EXPLICIT_SEATS);
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  expect(removed.out).not.toContain('the approval no longer covers');
  expect(removed.out).not.toContain('seat worker is missing');
});

test('the gate list is unchanged: no option, no report lines', async () => {
  const at = place(TEAM);
  const removed = await config(at, ['unset', 'seats.worker']);
  expect(removed.code, removed.err).toBe(0);
  const after = live(at);
  expect(approvalDifferences(after.team, at.root, at.home)).toEqual(['`limits` changed']);
  // The report the config write prints adds the two display lines and never drops the gate's.
  expect(approvalDifferences(after.team, at.root, at.home, { text: after.text })).toEqual([
    'seat worker is missing since the last approval',
    'the default seat ceiling follows the roster (3 seats)',
  ]);
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');
});

// The removed `team approve` cannot be run, so the config report never sends the owner to it,
// while the option that works stays. Both surfaces the report writes are checked.
test('a session-default move drops the removed re-approval and keeps the viable option', async () => {
  const at = placeApproved(MOVED_APPROVED, MOVED);
  const human = await config(at, ['set', 'watch.interval', '20s']);
  expect(human.code, human.err).toBe(0);
  expect(human.out).toContain('`session` changed: "acme" -> "acme-acme", the new default session (<entity>-<project>)');
  expect(human.out).toContain('set `session: acme` to keep the old one');
  expect(human.out).not.toContain('approve the file again');
  expect(human.out).toContain('this version has no command to refresh that snapshot');
});

test('the JSON report carries the same session line without the removed re-approval', async () => {
  const at = placeApproved(MOVED_APPROVED, MOVED);
  const json = await config(at, ['set', 'watch.interval', '20s', '--json']);
  expect(json.code, json.err).toBe(0);
  const report = JSON.parse(json.out) as { approval_differences: string[] };
  const session = report.approval_differences.filter((line) => line.startsWith('`session` changed'));
  expect(session).toHaveLength(1);
  expect(session[0]).toContain('set `session: acme` to keep the old one');
  expect(session[0]).not.toContain('approve the file again');
});

// After a migration the approval may stop verifying because its signature was disturbed, with
// the team record untouched. The line names the signature; it does not call the record older.
test('a signature that does not verify is named as that, not as an older record', async () => {
  const at = migratePlace(MOVED);
  const ran = await migrate(at, ['--keep-file'], tamperAfterReading(at));
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).toContain('migration completed; the team record is unchanged, and the stored approval no longer verifies (the record does not carry a valid signature');
  expect(ran.out).toContain('this version has no command to refresh that snapshot');
  expect(ran.out).not.toContain('describes an earlier team record');
});

// When the record really moved on from the approved copy, the line says so — beside the reason
// the approval no longer verifies, never instead of it.
test('a record that really differs is called an earlier record', async () => {
  const at = migratePlace(MOVED, MOVED_FURTHER);
  const ran = await migrate(at, ['--keep-file'], tamperAfterReading(at));
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).toContain('migration completed; the stored approval describes an earlier team record and no longer verifies');
  expect(ran.out).toContain('this version has no command to refresh that snapshot');
});

// An empty approval comparison is not record equality: the gate ignores a removed seat on
// purpose, so with a fixed ceiling the records differ and the line may not call them equal.
test('a removed seat under a fixed ceiling is not called unchanged', async () => {
  const at = migratePlace(MOVED_FIXED, MOVED_FIXED_ONE);
  const ran = await migrate(at, ['--keep-file'], tamperAfterReading(at));
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).not.toContain('the team record is unchanged');
  expect(ran.out).toContain('the stored approval describes an earlier team record and no longer verifies');
});

// The second migrate finds the registry already holds the team: nothing was applied, and the
// line does not say a change was.
test('an unchanged migrate does not claim a change was applied', async () => {
  const at = migratePlace(MOVED);
  const first = await migrate(at, ['--keep-file'], () => NOW);
  expect(first.code, first.err).toBe(0);
  unlinkSync(join(at.root, '.agents', 'team.yaml'));
  const again = await migrate(at, ['--keep-file'], tamperAfterReading(at));
  expect(again.code, again.err).toBe(0);
  expect(again.out).toContain('the registry already holds this team; nothing to import');
  expect(again.out).toContain('migration completed; the team record is unchanged, and the stored approval no longer verifies');
  expect(again.out).not.toContain('the change was applied');
  expect(again.out).not.toContain('describes an earlier team record');
});
