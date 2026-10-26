// Phase 3: under `team-config.source: registry` the editing commands write the team's registry
// record, and the team file is neither read nor written. Every scene builds its own home and its
// own repository under the system's temp folder and hands that home to every call: the real
// ~/.config/team is never read or written. The registry source is set for the scene only, and the
// suite preload's `file` comes back after it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readArgs } from '../../src/args.ts';
import { runInit } from '../../src/commands/init.ts';
import { runTeamImport } from '../../src/commands/migrate.ts';
import { runTempo } from '../../src/commands/tempo.ts';
import { readTeamConfig } from '../../src/file/team-config.ts';
import { readTeamText, teamTextTarget, writeTeamText } from '../../src/file/team-text.ts';
import { readStoredTeamConfig, sha256 } from '../../src/registry/team-config-store.ts';
import { teamIdOf } from '../../src/registry/teams.ts';
import { testIo } from '../helpers.ts';

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

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.TEAM_CONFIG_SOURCE;
  process.env.TEAM_CONFIG_SOURCE = 'registry';
});
afterEach(() => {
  if (previous === undefined) delete process.env.TEAM_CONFIG_SOURCE;
  else process.env.TEAM_CONFIG_SOURCE = previous;
});

function scene(text: string | null = TEAM): { home: string; root: string; file: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-config-writers-')));
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  const file = join(root, '.agents', 'team.yaml');
  if (text !== null) writeFileSync(file, text);
  return { home, root, file };
}

async function migrated(text = TEAM): Promise<{ home: string; root: string; file: string }> {
  const at = scene(text);
  const io = testIo(at.root, OWNER);
  expect(await runTeamImport('migrate', [], readArgs([], [], ['json', 'dry-run']), io, { home: at.home, now: NOW })).toBe('done');
  return at;
}

const stored = (at: { home: string; root: string }) => readStoredTeamConfig(at.home, teamIdOf(at.root));

describe('the writers seam', () => {
  test('under the registry, this checkout\'s team is the registry record', async () => {
    const at = await migrated();
    expect(teamTextTarget(at.file, { home: at.home }).kind).toBe('registry');
    expect(readTeamText(at.file, { home: at.home })).toBe(TEAM);
  });

  test('an edit replaces the record, recomputes both digests, and leaves the file as it was', async () => {
    const at = await migrated();
    const next = TEAM.replace('format: 1\n', 'format: 1\ntempo: urgent\n');
    const wrote = writeTeamText(at.file, next, { home: at.home, command: 'tempo', now: NOW });
    expect(wrote).toEqual({ ok: true, target: 'registry' });
    const record = stored(at)!;
    expect(record.text).toBe(next);
    expect(record.text_sha256).toBe(sha256(next));
    expect(record.edited_by).toBe('tempo');
    expect(record.imported_by).toBe('migrate');
    expect(readFileSync(at.file, 'utf8')).toBe(TEAM);
    const back = readTeamConfig(at.root, { home: at.home, source: 'registry' });
    expect(back.ok && back.team.tempo).toBe('urgent');
  });

  test('an invalid edit is refused and the record is left as it was', async () => {
    const at = await migrated();
    const wrote = writeTeamText(at.file, 'format: [\n', { home: at.home });
    expect(wrote.ok).toBe(false);
    expect(stored(at)!.text).toBe(TEAM);
  });

  test('a file the caller names elsewhere, and the file source, stay on the file', async () => {
    const at = await migrated();
    const other = join(at.root, 'copy.yaml');
    writeFileSync(other, TEAM);
    expect(teamTextTarget(other, { home: at.home }).kind).toBe('file');
    expect(teamTextTarget(at.file, { home: at.home, source: 'file' }).kind).toBe('file');
  });
});

describe('the commands write the registry', () => {
  test('team tempo sets the word in the record, not the file', async () => {
    const at = await migrated();
    const io = testIo(at.root, OWNER);
    expect(await runTempo(['urgent'], io, { home: at.home })).toBe(0);
    expect(stored(at)!.text).toContain('tempo: urgent');
    expect(stored(at)!.edited_by).toBe('tempo');
    expect(readFileSync(at.file, 'utf8')).toBe(TEAM);
  });

  test('team init writes a new team into the registry and no file', async () => {
    const at = scene(null);
    const io = testIo(at.root, OWNER);
    expect(await runInit([], io, at.home, undefined, { loggedIn: () => false })).toBe(0);
    expect(existsSync(at.file)).toBe(false);
    const record = stored(at);
    expect(record?.edited_by).toBe('init');
    const back = readTeamConfig(at.root, { home: at.home, source: 'registry' });
    expect(back.ok).toBe(true);
    // A second init is refused: the registry already holds the team.
    const again = testIo(at.root, OWNER);
    expect(await runInit([], again, at.home, undefined, { loggedIn: () => false })).toBe(1);
    expect(`${again.out}${again.err}`).toContain('the registry already holds this team');
  });
});

describe('a team read from a file under the registry source', () => {
  test('a team the registry does not hold is edited on the file it was read from', () => {
    const at = scene();
    expect(teamTextTarget(at.file, { home: at.home }).kind).toBe('file');
    const next = TEAM.replace('format: 1\n', 'format: 1\ntempo: relaxed\n');
    expect(writeTeamText(at.file, next, { home: at.home })).toEqual({ ok: true, target: 'file' });
    expect(readFileSync(at.file, 'utf8')).toBe(next);
    expect(stored(at)).toBeNull();
  });
});
