// The move off .agents/team.yaml: `team migrate` imports, verifies and retires the file (never
// deleting it), the approval stays in force across the move, `team config` edits the registry's
// record, and a leftover file is named by one line. Every scene keeps its registry under its own
// temp home; the real ~/.config/team is never read or written.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import { runConfig } from '../src/commands/config.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { leftoverNote, readTeamConfig } from '../src/file/team-config.ts';
import { importForUp } from '../src/file/team-import.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { realRegistryTouched, storedTeam } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-26T09:00:00.000Z');
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(realRegistryTouched()).toBe(false);
});

type Place = { home: string; root: string; file: string };
function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-only-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, TEAM);
  return { home, root, file };
}
const registry = { ...process.env, TEAM_CONFIG_SOURCE: 'registry' };

async function migrate(at: Place, argv: string[] = []) {
  const io = testIo(at.root, { kind: 'owner' });
  const previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'registry';
  try {
    const code = await runMigrate(argv, io, { home: at.home, now: () => NOW });
    return { code, out: io.out, err: io.err };
  } finally {
    process.env.TEAM_CONFIG_SOURCE = previous;
  }
}
async function config(at: Place, argv: string[], editor?: (path: string) => number) {
  const io = testIo(at.root, { kind: 'owner' });
  const code = await runConfig(argv, io, { home: at.home, env: registry, now: () => NOW, ...(editor ? { editor } : {}) });
  return { code, out: io.out, err: io.err };
}

test('team migrate imports, reads back, and retires the file without deleting it', async () => {
  const at = place();
  const ran = await migrate(at);
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).toContain('read back and verified');
  expect(ran.out).toContain(`renamed to ${at.file}.migrated`);
  expect(existsSync(at.file)).toBe(false);
  expect(readFileSync(`${at.file}.migrated`, 'utf8')).toBe(TEAM);
  expect(storedTeam(at.root, at.home)?.text).toBe(TEAM);
  // A second run has nothing to do, and says so.
  const again = await migrate(at);
  expect(again.code).toBe(0);
  expect(again.out).toContain('already holds this team');
});

test('--keep-file leaves the file, the leftover is named by one line, and a later run retires it', async () => {
  const at = place();
  const kept = await migrate(at, ['--keep-file']);
  expect(kept.code).toBe(0);
  expect(kept.out).toContain('was kept (--keep-file)');
  expect(existsSync(at.file)).toBe(true);
  const read = readTeamConfig(at.root, { home: at.home, source: 'registry' });
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  expect(leftoverNote(read.leftover)).toContain('run `team migrate`');
  const later = await migrate(at);
  expect(later.code).toBe(0);
  expect(existsSync(at.file)).toBe(false);
  expect(existsSync(`${at.file}.migrated`)).toBe(true);
});

test('a dry run writes nothing and moves nothing', async () => {
  const at = place();
  const ran = await migrate(at, ['--dry-run']);
  expect(ran.code).toBe(0);
  expect(ran.out).toContain('would be moved to the Trash');
  expect(existsSync(at.file)).toBe(true);
  expect(storedTeam(at.root, at.home)).toBe(null);
});

test('the approval stays in force across the move: it is signed over the canonical record', async () => {
  const at = place();
  const checked = validateTeamFile(TEAM, { home: at.home, root: at.root });
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  writeApproval(storePath('acme', at.root, at.home), { approval: approvalOf(checked.team, at.root, NOW), file: TEAM }, checked.team.seats, at.home);
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');
  const ran = await migrate(at);
  expect(ran.code, ran.err).toBe(0);
  expect(ran.out).toContain('the approval is still in force');
  expect(approvalStanding(at.root, at.home).kind).toBe('verified');
  const read = readTeamConfig(at.root, { home: at.home, source: 'registry' });
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  expect(approvalDifferences(read.team, at.root, at.home)).toEqual([]);
  // An owner-section edit through team config is named as no longer approved.
  const edited = await config(at, ['set', 'seats.lead.model', 'Claude Sonnet']);
  expect(edited.code, edited.err).toBe(0);
  expect(edited.out).toContain('the approval no longer covers');
  const after = readTeamConfig(at.root, { home: at.home, source: 'registry' });
  if (!after.ok) throw new Error(JSON.stringify(after.errors));
  expect((approvalDifferences(after.team, at.root, at.home) ?? []).length).toBeGreaterThan(0);
});

test('team config get, set and unset edit the registry record, and never write a file', async () => {
  const at = place();
  await migrate(at);
  expect((await config(at, ['get', 'seats.lead.cli'])).out).toBe('claude-code\n');
  expect((await config(at, ['get', 'seats.0.name'])).out).toBe('lead\n');
  const set = await config(at, ['set', 'seats.lead.label', 'boss']);
  expect(set.code, set.err).toBe(0);
  expect(set.out).toContain("in the registry's record; validated");
  expect(storedTeam(at.root, at.home)?.edited_by).toBe('config set');
  expect((await config(at, ['get', 'seats.lead.label'])).out).toBe('boss\n');
  expect((await config(at, ['unset', 'seats.lead.label'])).code).toBe(0);
  expect((await config(at, ['get', 'seats.lead.label'])).code).toBe(1);
  const bad = await config(at, ['set', 'format', '9']);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain('does not validate');
  expect(existsSync(at.file)).toBe(false);
  const json = await config(at, ['get', 'seats.lead', '--json']);
  expect(JSON.parse(json.out).value.name).toBe('lead');
});

test('team config edit writes a valid edit back, and keeps an invalid one for the owner', async () => {
  const at = place();
  await migrate(at);
  const good = await config(at, ['edit'], (path) => {
    writeFileSync(path, readFileSync(path, 'utf8').replace('label: lead', 'label: chief # kept comment'));
    return 0;
  });
  expect(good.code, good.err).toBe(0);
  expect(storedTeam(at.root, at.home)?.text).toContain('label: chief # kept comment');
  let draft = '';
  const bad = await config(at, ['edit'], (path) => {
    draft = path;
    writeFileSync(path, 'format: [\n');
    return 0;
  });
  expect(bad.code).toBe(1);
  expect(bad.err).toContain(`your edit is kept at ${draft}`);
  expect(existsSync(draft)).toBe(true);
  expect(storedTeam(at.root, at.home)?.text).toContain('label: chief');
  rmSync(join(draft, '..'), { recursive: true, force: true });
});

test('team up imports a team the registry does not hold, with a notice, and keeps the file', () => {
  const at = place();
  const previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'registry';
  try {
    expect(importForUp(at.root, at.home, true, NOW)).toContain('a real run imports');
    expect(storedTeam(at.root, at.home)).toBe(null);
    expect(importForUp(at.root, at.home, false, NOW)).toContain('read back and verified');
    expect(storedTeam(at.root, at.home)?.text).toBe(TEAM);
    expect(existsSync(at.file)).toBe(true);
    expect(importForUp(at.root, at.home, false, NOW)).toBe(null);
  } finally {
    process.env.TEAM_CONFIG_SOURCE = previous;
  }
});
