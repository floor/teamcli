// A registry entry can list a team, and name the session it runs in, before `team migrate` has
// stored a config record. The definition is still the file until then, but a file that omits
// `session:` must not invent `<entity>-<project>` over the session the registry already records,
// and the notice must not claim the team is absent from the registry.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runUp } from '../src/commands/up.ts';
import { CANONICAL_RECORD_VERSION } from '../src/file/canonical-record.ts';
import { currentTeam } from '../src/file/current.ts';
import { FILE_FALLBACK_LISTED, FILE_FALLBACK_UNLISTED } from '../src/file/load.ts';
import { canonicalTeam, readTeamConfig } from '../src/file/team-config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { sha256, writeStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, storedTeam, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-16T02:00:00Z');

const TEAM = (project: string, extra = ''): string => `format: 1
project: ${project}
entity: floor
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
${extra}`;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scene(text: string): { home: string; root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-registry-session-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'docs');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return { home, root };
}

function listTeam(home: string, root: string, session: string): void {
  upsertTeam(home, teamIdOf(root), {
    project: 'docs',
    entity: 'floor',
    session,
    root,
    lifecycle: 'running',
    roster: [{ agent: 'agt_crew000000', seat: 'lead', role: 'coordinator', leads: true }],
    by: 'owner',
    at: NOW.toISOString(),
  });
}

describe('a listed team with no config record', () => {
  test('a file that omits session uses the registry session, and does not say the team is unlisted', async () => {
    const { home, root } = scene(TEAM('docs'));
    listTeam(home, root, 'docs');
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.source).toBe('team-file');
      expect(read.team.session).toBe('docs');
      expect(read.notice).toBe(FILE_FALLBACK_LISTED);
      expect(read.notice).not.toContain('not in the registry');
    });
  });

  test('team down reports the registry session, not <entity>-<project>', async () => {
    const { home, root } = scene(TEAM('docs'));
    listTeam(home, root, 'docs');
    const seen: string[] = [];
    const sources: DownSources = {
      home,
      now: () => NOW,
      sessionRunning: (session) => {
        seen.push(session);
        return false;
      },
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => ['zsh'],
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await underRegistry(() => runDown([], io, sources));
    expect(code).toBe(0);
    expect(seen).toEqual(['docs']);
    expect(io.out).toContain('session docs is not running: nothing to stop');
    expect(io.out).not.toContain('floor-docs');
    expect(io.out).toContain(FILE_FALLBACK_LISTED);
    expect(io.out).not.toContain('not in the registry');
  });

  test('an explicit session in the file is kept when the registry records another', async () => {
    const { home, root } = scene(TEAM('docs', 'session: other\n'));
    listTeam(home, root, 'docs');
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok && read.team.session).toBe('other');
      if (read.ok) expect(read.notice).toBe(FILE_FALLBACK_LISTED);
    });
  });

  test('a team the registry does not list keeps the derived session and says no record exists', async () => {
    const { home, root } = scene(TEAM('docs'));
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.team.session).toBe('floor-docs');
      expect(read.notice).toBe(FILE_FALLBACK_UNLISTED);
    });
  });

  test('a listed team with no file and no config record is not described as absent from the registry', async () => {
    const { home, root } = scene(TEAM('docs'));
    listTeam(home, root, 'docs');
    writeFileSync(join(root, '.agents', 'team.yaml'), '');
    rmSync(join(root, '.agents', 'team.yaml'));
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      const message = read.errors[0]?.message ?? '';
      expect(message).toContain('the registry lists this team but holds no config record');
      expect(message).toContain('not here to import');
      expect(message).not.toContain('not in the registry');
    });
  });

  test('a root the registry does not list, with no file, is not registered', async () => {
    const { home, root } = scene(TEAM('docs'));
    rmSync(join(root, '.agents', 'team.yaml'));
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.errors[0]?.message).toContain('no team is registered');
    });
  });
});

describe('a migrated config record that omits session', () => {
  test('keeps the session the team registry recorded, and the leftover file still matches', async () => {
    const { home, root } = scene(TEAM('docs'));
    listTeam(home, root, 'docs');
    intoRegistry(root, home);
    const stored = storedTeam(root, home);
    expect(stored?.text).not.toContain('session:');
    await underRegistry(() => {
      const beside = readTeamConfig(root, { home });
      expect(beside.ok).toBe(true);
      if (!beside.ok) return;
      expect(beside.source).toBe('registry');
      expect(beside.team.session).toBe('docs');
      expect(beside.leftover?.matches).toBe(true);
      // `--file` is the file as written: an omitted key is still the derived name.
      const filed = readTeamConfig(root, { home, file: join(root, '.agents', 'team.yaml') });
      expect(filed.ok && filed.source).toBe('team-file');
      expect(filed.ok && filed.team.session).toBe('floor-docs');

      rmSync(join(root, '.agents', 'team.yaml'));
      const read = readTeamConfig(root, { home });
      expect(read.ok && read.source).toBe('registry');
      expect(read.ok && read.team.session).toBe('docs');
      expect(read.ok && read.leftover).toBeUndefined();
      const current = currentTeam(root, undefined, NOW, home, false);
      expect(current.ok && current.team.session).toBe('docs');
    });
  });

  test('up and down address the recorded session, not <entity>-<project>', async () => {
    const { home, root } = scene(TEAM('docs'));
    listTeam(home, root, 'docs');
    intoRegistry(root, home);
    rmSync(join(root, '.agents', 'team.yaml'));
    const seen: string[] = [];
    const down: DownSources = {
      home,
      now: () => NOW,
      sessionRunning: (session) => {
        seen.push(session);
        return false;
      },
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => ['zsh'],
    };
    await underRegistry(async () => {
      const stopped = testIo(root, { kind: 'owner' });
      expect(await runDown([], stopped, down)).toBe(0);
      expect(seen).toEqual(['docs']);
      expect(stopped.out).toContain('session docs is not running: nothing to stop');
      expect(stopped.out).not.toContain('floor-docs');

      const dry = testIo(root, { kind: 'owner' });
      dry.env = { TEAMCLI_DEV_MODE: '1' };
      const code = await runUp(['--dry-run'], dry, {
        home,
        sessionRunning: () => false,
        agents: () => [],
      });
      expect(code).toBe(0);
      expect(dry.out).toContain('herdr --session docs ');
      expect(dry.out).not.toContain('floor-docs');
    });
  });

  test('an explicit session in the stored definition is kept when the registry records another', async () => {
    const { home, root } = scene(TEAM('docs', 'session: other\n'));
    listTeam(home, root, 'docs');
    intoRegistry(root, home);
    rmSync(join(root, '.agents', 'team.yaml'));
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok && read.team.session).toBe('other');
    });
  });

  test('a record whose digest was taken on the derived session still reads the recorded one', async () => {
    const { home, root } = scene(TEAM('docs'));
    const text = TEAM('docs');
    const validated = validateTeamFile(text, { root });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.team.session).toBe('floor-docs');
    writeStoredTeamConfig(home, {
      format: 1,
      id: teamIdOf(root),
      root,
      text,
      text_sha256: sha256(text),
      record_version: CANONICAL_RECORD_VERSION,
      record_sha256: sha256(canonicalTeam(validated.team)),
      imported_from: join(root, '.agents', 'team.yaml'),
      imported_at: NOW.toISOString(),
      imported_by: 'migrate',
    });
    listTeam(home, root, 'docs');
    rmSync(join(root, '.agents', 'team.yaml'));
    await underRegistry(() => {
      const read = readTeamConfig(root, { home });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.source).toBe('registry');
      expect(read.team.session).toBe('docs');
    });
  });
});
