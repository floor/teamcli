import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runTeamImport as run } from '../../src/commands/migrate.ts';
import { readArgs } from '../../src/args.ts';
const EXIT = { 'approval-requested': 0, 'approval-refused': 1, done: 0, detached: 1, 'not-owner': 1, 'already-migrated': 1, invocation: 2, invalid: 2, registry: 2, 'round-trip': 2 } as const;
const runTeamImport = async (mode: 'migrate' | 'import', argv: string[], io: Parameters<typeof run>[3], sources: Parameters<typeof run>[4]) =>
  EXIT[await run(mode, argv, readArgs(argv, [], ['json', 'dry-run', 'keep-file']), io, sources)];
import {
  DEFAULT_TEAM_CONFIG_SOURCE,
  leftoverDifferences,
  readTeamConfig,
  resolveTeamConfigSource,
} from '../../src/file/team-config.ts';
import { teamConfigDir } from '../../src/registry/team-config-store.ts';
import { testIo } from '../helpers.ts';

// Every scene builds its own home and its own repository under the system's temp folder: the
// real ~/.config/team is never read or written. The registry is named explicitly (`env: {}`), so
// the suite's preload, which keeps older tests on the file, does not apply here.

const TEAM = `format: 1
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
`;

const OWNER = { kind: 'owner' as const };
const NOW = () => new Date('2026-10-25T12:00:00.000Z');

function scene(text = TEAM): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-registry-')));
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return { home, root };
}

const registry = (home: string) => ({ home, env: {} });

describe('the source setting', () => {
  test('defaults to the registry', () => {
    const { home } = scene();
    expect(DEFAULT_TEAM_CONFIG_SOURCE).toBe('registry');
    expect(resolveTeamConfigSource(registry(home))).toEqual({ ok: true, source: 'registry', from: 'default' });
  });

  test('reads team-config.source from the machine settings, flat or nested', () => {
    const { home } = scene();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
    expect(resolveTeamConfigSource(registry(home))).toEqual({ ok: true, source: 'file', from: 'machine' });
    writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config:\n  source: file\n');
    expect(resolveTeamConfigSource(registry(home))).toEqual({ ok: true, source: 'file', from: 'machine' });
  });

  test('the environment overrides the machine, the option overrides both', () => {
    const { home } = scene();
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
    expect(resolveTeamConfigSource({ home, env: { TEAM_CONFIG_SOURCE: 'registry' } })).toMatchObject({ source: 'registry', from: 'environment' });
    expect(resolveTeamConfigSource({ home, env: { TEAM_CONFIG_SOURCE: 'registry' }, source: 'file' })).toMatchObject({ source: 'file', from: 'option' });
  });

  test('a value that is not a source is refused by name, never guessed', () => {
    const { home, root } = scene();
    const read = readTeamConfig(root, { home, env: { TEAM_CONFIG_SOURCE: 'registry-then-file' } });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]?.message).toContain('team-config.source is "registry-then-file"');
  });
});

describe('reading from the registry', () => {
  test('a team not yet migrated is read from the file, once, and the notice names team migrate', () => {
    const { home, root } = scene();
    const read = readTeamConfig(root, registry(home));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.source).toBe('team-file');
    expect(read.team.project).toBe('acme');
    expect(read.notice).toContain('run `team migrate`');
    expect(read.notice).not.toContain('not in the registry');
  });

  test('--file reads the file it names whatever the setting', () => {
    const { home, root } = scene();
    const read = readTeamConfig(root, { ...registry(home), file: join(root, '.agents', 'team.yaml') });
    expect(read.ok && read.source).toBe('team-file');
  });

  test('team migrate imports once, reads back, and every read then comes from the registry', async () => {
    const { home, root } = scene();
    const io = testIo(root, OWNER);
    expect(await runTeamImport('migrate', ['--keep-file'], io, { home, now: NOW })).toBe(0);
    expect(io.out).toContain('read back and verified');
    const read = readTeamConfig(root, registry(home));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.source).toBe('registry');
    expect(read.team.project).toBe('acme');
    expect(read.leftover).toEqual({ path: join(root, '.agents', 'team.yaml'), matches: true });
    expect(leftoverDifferences(read.leftover)).toEqual([]);
    // With --keep-file the file stays; without it, it is retired, never deleted (test/registry-only.test.ts).
    expect(existsSync(join(root, '.agents', 'team.yaml'))).toBe(true);
  });

  test('a second migrate over a file that now differs is refused and names team import', async () => {
    const { home, root } = scene();
    await runTeamImport('migrate', ['--keep-file'], testIo(root, OWNER), { home, now: NOW });
    const file = join(root, '.agents', 'team.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('project: acme', 'project: acme-two'));
    const io = testIo(root, OWNER);
    expect(await runTeamImport('migrate', [], io, { home, now: NOW })).toBe(1);
    expect(io.err).toContain('team import');
  });

  test('--dry-run writes nothing', async () => {
    const { home, root } = scene();
    const io = testIo(root, OWNER);
    expect(await runTeamImport('migrate', ['--dry-run'], io, { home, now: NOW })).toBe(0);
    expect(io.out).toContain('nothing written');
    expect(existsSync(teamConfigDir(home))).toBe(false);
  });

  test('the registry is read without the file', async () => {
    const { home, root } = scene();
    await runTeamImport('migrate', [], testIo(root, OWNER), { home, now: NOW });
    writeFileSync(join(root, '.agents', 'team.yaml'), 'not: a team\n');
    const read = readTeamConfig(root, registry(home));
    expect(read.ok && read.team.project).toBe('acme');
  });

  test('a leftover file that differs is flagged, and team import makes it the record', async () => {
    const { home, root } = scene();
    await runTeamImport('migrate', [], testIo(root, OWNER), { home, now: NOW });
    writeFileSync(join(root, '.agents', 'team.yaml'), TEAM.replace('project: acme', 'project: acme\ntempo: urgent'));
    const before = readTeamConfig(root, registry(home));
    expect(before.ok && before.leftover?.matches).toBe(false);
    const rows = leftoverDifferences(before.ok ? before.leftover : undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repair).toBe('team import');
    const io = testIo(root, OWNER);
    expect(await runTeamImport('import', [], io, { home, now: NOW })).toBe(0);
    const after = readTeamConfig(root, registry(home));
    expect(after.ok && after.team.tempo).toBe('urgent');
    expect(after.ok && after.leftover?.matches).toBe(true);
  });

  test('formatting and comments alone are not a mismatch', async () => {
    const { home, root } = scene();
    await runTeamImport('migrate', [], testIo(root, OWNER), { home, now: NOW });
    writeFileSync(join(root, '.agents', 'team.yaml'), `# a comment\n${TEAM}`);
    const read = readTeamConfig(root, registry(home));
    expect(read.ok && read.leftover?.matches).toBe(true);
  });

  test('a record whose text does not match its digest is refused', async () => {
    const { home, root } = scene();
    await runTeamImport('migrate', [], testIo(root, OWNER), { home, now: NOW });
    const dir = teamConfigDir(home);
    const file = join(dir, execFileSync('ls', [dir], { encoding: 'utf8' }).trim());
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.text = record.text.replace('acme', 'other');
    writeFileSync(file, JSON.stringify(record));
    const read = readTeamConfig(root, registry(home));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[0]?.message).toContain('does not match its digest');
  });
});

describe('who may move the team', () => {
  test('a seat is refused', async () => {
    const { home, root } = scene();
    const io = testIo(root, { kind: 'seat', session: 'acme', seat: 'lead', pane: 'p1' } as never);
    expect(await runTeamImport('migrate', [], io, { home, now: NOW })).toBe(1);
    expect(existsSync(teamConfigDir(home))).toBe(false);
  });
});
