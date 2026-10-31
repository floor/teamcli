// The stale-approval report after an owner-section change: a removed seat is named instead of a
// bare `limits` change, a default seat ceiling that followed the roster says so, and the printed
// repair is an outcome this build can actually reach. Display only: the gate's own list is
// unchanged. Every scene keeps its registry under its own temp home; the real one is never read.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { runConfig } from '../src/commands/config.ts';
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

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string };
function place(text: string): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-approval-stale-report-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  intoRegistry(root, home);
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: text }, checked.team.seats, home, NOW);
  return { home, root };
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
