// Independent scenes for what a config write says and what it leaves out. Every home, registry,
// signing key and owner seat is synthetic. No author test fixture is imported, and the absence of
// approval text is asserted separately from the gate's own list.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferencesOf, approvalOf } from '../src/approve/approval.ts';
import { runConfig } from '../src/commands/config.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { canonicalTeam, readTeamConfig } from '../src/file/team-config.ts';
import { importTeamFile } from '../src/file/team-import.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { teamConfigRecordPath } from '../src/registry/team-config-store.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { keyOf, signPayload } from '../src/store/keys.ts';
import { approvalStanding, approvedRecordOf, payloadOf, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-10-31T22:00:00.000Z');
const REMOVED = 'seat observer is missing since the last approval';
const LIMITS_CHANGED = '`limits` changed';
const REPAIR = 'this version has no command to refresh that snapshot';
const OLD_ADVICE = /approve the (?:team|file) again/;
const owner = { kind: 'owner' } as const;
const HEADER = [
  'format: 1', 'project: beacon', 'coordinator: captain', 'operator: captain',
  'workspace:', '  mode: shared', 'seats:',
].join('\n') + '\n';
function seat(name: string): string {
  return [
    '  - role: ' + (name === 'captain' ? 'coordinator' : 'implementer'),
    '    name: ' + name, '    cli: claude-code', '    vendor: anthropic',
    '    model: Claude Opus', '    version: "5.5"', '    launch: claude',
  ].join('\n') + '\n';
}
const THREE = HEADER + seat('captain') + seat('worker') + seat('observer');
const TWO = HEADER + seat('captain') + seat('worker');
const EXPLICIT = 'limits:\n  seats: 8\n';
let base: string, root: string, home: string, file: string, approvalFile: string, ownerStore: FakeStore;
let previous: Record<string, string | undefined>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'approval-report-gpt-')));
  root = join(base, 'project'); home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(home);
  file = join(root, '.agents', 'team.yaml');
  previous = { HOME: process.env.HOME, TEAM_CONFIG_SOURCE: process.env.TEAM_CONFIG_SOURCE, TEAM_NO_SYSTEM_TRASH: process.env.TEAM_NO_SYSTEM_TRASH };
  process.env.HOME = home; process.env.TEAM_CONFIG_SOURCE = 'registry'; process.env.TEAM_NO_SYSTEM_TRASH = '1';
  ownerStore = seatOwner(home);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});
function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}
function approve(text: string): void {
  writeFileSync(file, text);
  const team = parsed(text), store = storePath(team.project, root, home);
  writeApproval(store, { approval: approvalOf(team, root, NOW), file: text }, [], home, NOW);
  approvalFile = join(store, 'approval.json');
  expect(approvalStanding(root, home).kind).toBe('verified');
}
function registry(): void {
  const moved = importTeamFile({ cwd: root, home, mode: 'migrate', now: NOW });
  expect(moved.ok).toBe(true);
}
function current(): TeamFile {
  const got = readTeamConfig(root, { home, source: 'registry' });
  if (!got.ok) throw new Error(JSON.stringify(got.errors));
  return got.team;
}
function differences(team: TeamFile): string[] {
  const standing = approvalStanding(root, home);
  if (standing.kind !== 'verified') throw new Error('fixture lost its verified approval');
  return approvalDifferencesOf(standing, team);
}
async function edit(next: string, json = false) {
  const before = readFileSync(approvalFile, 'utf8');
  const io = testIo(root, owner);
  const code = await runConfig(['edit', ...(json ? ['--json'] : [])], io, {
    home, env: { HOME: home, TEAM_CONFIG_SOURCE: 'registry' }, ownerSeatStore: ownerStore,
    now: () => NOW, editor: (draft) => { writeFileSync(draft, next); return 0; },
  });
  expect(code).toBe(0);
  expect(readFileSync(approvalFile, 'utf8')).toBe(before);
  expect(approvalStanding(root, home).kind).toBe('verified');
  expect(ownerStore.prompts).toEqual([]);
  return io;
}
function spoilSignature(): void {
  const record = JSON.parse(readFileSync(approvalFile, 'utf8'));
  record.signature = '00'.repeat(64);
  writeFileSync(approvalFile, JSON.stringify(record));
}
async function migrate(afterRead: () => void, afterOutput?: () => void) {
  const io = testIo(root, owner);
  const stdout = io.stdout; let changed = false;
  io.stdout = (text) => {
    stdout(text);
    if (!changed && afterOutput !== undefined) { changed = true; afterOutput(); }
  };
  const code = await runMigrate(['--keep-file'], io, {
    home, ownerSeatStore: ownerStore, now: () => { afterRead(); return NOW; },
  });
  expect(code).toBe(0);
  expect(approvalStanding(root, home).kind).toBe('refused');
  expect(io.err).toBe('');
  expect(ownerStore.prompts).toEqual([]);
  return io;
}

test('[changed] config plain names no approval report', async () => {
  approve(THREE); registry();
  const io = await edit(TWO);
  expect(differences(current())).toEqual([LIMITS_CHANGED]);
  expect(io.out).toContain('validated');
  expect(io.out).not.toContain(REMOVED);
  expect(io.out).not.toContain('the default seat ceiling follows the roster');
  expect(io.out).not.toContain(REPAIR);
  expect(io.out).not.toMatch(OLD_ADVICE);
});
test('[changed] config JSON gives no explanation and leaves the gate list alone', async () => {
  approve(THREE); registry();
  const io = await edit(TWO, true);
  const doc = JSON.parse(io.out) as Record<string, unknown>;
  expect(doc.changed).toBe(true);
  expect(Object.hasOwn(doc, 'approval_differences')).toBe(false);
  expect(differences(current())).toEqual([LIMITS_CHANGED]);
});
test('[changed] a legacy session-default write draws no approval advice', async () => {
  const text = TWO.replace('project: beacon\n', 'project: beacon\nentity: lab\nsession: beacon\n');
  approve(text); registry();
  const io = testIo(root, owner);
  expect(await runConfig(['unset', 'session'], io, {
    home, env: { HOME: home, TEAM_CONFIG_SOURCE: 'registry' }, ownerSeatStore: ownerStore,
  })).toBe(0);
  expect(io.out).not.toContain('new default session');
  expect(io.out).not.toContain(REPAIR);
  expect(io.out).not.toMatch(OLD_ADVICE);
  const gate = differences(current());
  expect(gate).toHaveLength(1);
  expect(gate[0]).toContain('new default session');
  expect(gate[0]).toContain('to keep the old one');
  expect(gate[0]).not.toMatch(OLD_ADVICE);
});
test('[changed] migrate distinguishes unchanged content from a signature that no longer verifies', async () => {
  approve(TWO);
  const io = await migrate(spoilSignature);
  expect(approvedRecordOf(TWO)).toBe(canonicalTeam(current()));
  expect(io.out).toContain('the team record is unchanged');
  expect(io.out).toContain('the stored approval no longer verifies');
  expect(io.out).toContain('valid signature');
  expect(io.out).toContain(REPAIR);
  expect(io.out).not.toContain('earlier team record');
  expect(io.out).not.toMatch(OLD_ADVICE);
});
test('[changed] formatting and comments do not turn canonical equality into an earlier record', async () => {
  approve(TWO);
  writeFileSync(file, '# same definition\n' + TWO.replace('project: beacon\n', '').replace('format: 1\n', 'format: 1\nproject: "beacon"\n'));
  const io = await migrate(spoilSignature);
  expect(approvedRecordOf(TWO)).toBe(canonicalTeam(current()));
  expect(io.out).toContain('the team record is unchanged');
  expect(io.out).not.toContain('earlier team record');
});
test('[changed] removed-seat records with no gate difference still compare as different records', async () => {
  approve(THREE + EXPLICIT);
  const next = TWO + EXPLICIT;
  expect(differences(parsed(next))).toEqual([]);
  expect(approvedRecordOf(THREE + EXPLICIT)).not.toBe(approvedRecordOf(next));
  writeFileSync(file, next);
  const io = await migrate(spoilSignature);
  expect(io.out).toContain('describes an earlier team record');
  expect(io.out).not.toContain('team record is unchanged');
  expect(io.out).toContain(REPAIR);
});
test('[changed] a changed owner section reports an earlier record', async () => {
  approve(TWO);
  writeFileSync(file, TWO + 'limits:\n  seats: 7\n');
  const io = await migrate(spoilSignature);
  expect(io.out).toContain('describes an earlier team record');
  expect(io.out).not.toContain('team record is unchanged');
});
test('[changed] an unreadable registry comparison reports only approval standing', async () => {
  approve(TWO);
  const io = await migrate(spoilSignature, () => writeFileSync(teamConfigRecordPath(home, teamIdOf(root)), '{'));
  expect(io.out).toContain('the stored approval no longer verifies');
  expect(io.out).toContain(REPAIR);
  expect(io.out).not.toContain('team record is unchanged');
  expect(io.out).not.toContain('earlier team record');
});
test('[changed] a valid older text signature with an unparseable copy gives no content comparison claim', async () => {
  approve(TWO);
  const record = JSON.parse(readFileSync(approvalFile, 'utf8'));
  const { file: _file, generation, signature: _signature, ...approval } = record;
  const invalid = 'format: [\n';
  const signature = signPayload(payloadOf(approval, invalid, generation), keyOf(home));
  writeFileSync(approvalFile, JSON.stringify({ ...approval, file: invalid, generation, signature }));
  expect(approvalStanding(root, home).kind).toBe('verified');
  const io = await migrate(spoilSignature);
  expect(io.out).toContain('the stored approval no longer verifies');
  expect(io.out).not.toContain('team record is unchanged');
  expect(io.out).not.toContain('earlier team record');
});

test('[control] removing a seat within an explicit unchanged ceiling draws no report', async () => {
  approve(THREE + EXPLICIT); registry();
  const io = await edit(TWO + EXPLICIT, true);
  expect(differences(current())).toEqual([]);
  expect(Object.hasOwn(JSON.parse(io.out) as Record<string, unknown>, 'approval_differences')).toBe(false);
});
test('[control] changing a seat still gives exactly its original gate refusal', async () => {
  approve(TWO); registry();
  const next = TWO.replace('    launch: claude\n', '    launch: claude --verbose\n');
  await edit(next, true);
  expect(differences(current())).toEqual(['seat captain changed']);
});
test('[control] a no-op edit changes neither approval nor gate', async () => {
  approve(TWO); registry(); const io = await edit(TWO, true);
  const doc = JSON.parse(io.out) as Record<string, unknown>;
  expect(doc.changed).toBe(false);
  expect(Object.hasOwn(doc, 'approval_differences')).toBe(false);
  expect(differences(current())).toEqual([]);
});
test('[control] a matching migration leaves the signature and gate approved', async () => {
  approve(TWO); const before = readFileSync(approvalFile, 'utf8');
  const io = testIo(root, owner);
  expect(await runMigrate(['--keep-file'], io, {home,ownerSeatStore:ownerStore,now:()=>NOW})).toBe(0);
  expect(io.out).toContain('the approval is still in force');
  expect(approvalStanding(root, home).kind).toBe('verified');
  expect(differences(current())).toEqual([]);
  expect(readFileSync(approvalFile, 'utf8')).toBe(before);
});
test('[control] a bad signature is refused before and after migration', async () => {
  approve(TWO); spoilSignature();
  expect(approvalStanding(root, home).kind).toBe('refused');
  const io = testIo(root, owner);
  expect(await runMigrate(['--keep-file'], io, {home,ownerSeatStore:ownerStore,now:()=>NOW})).toBe(0);
  expect(approvalStanding(root, home).kind).toBe('refused');
  expect(io.out).not.toContain('approval is still in force');
});
