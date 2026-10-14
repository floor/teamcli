// Adversarial boundaries for the lobby pre-trust: the record a CLI reads names only
// the lobby — never a parent, the project, or a symlinked alias — and only a CLI the
// team launches gets one. Every home here is scratch. What cannot be written comes
// back as the repair line: a config path that is itself a link, or sits under one,
// must be refused, not written through.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lobbyPretrustLine, type PretrustSeat } from '../../src/launch/pretrust.ts';

const NOW = new Date('2026-10-14T14:00:00.000Z');
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Place = { base: string; home: string; lobby: string; root: string };

function place(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-pretrust-bounds-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const lobby = join(home, 'lobby');
  mkdirSync(home);
  mkdirSync(root);
  mkdirSync(lobby);
  return { base, home, lobby, root };
}

function seat(cli: string, cwd: string, extra: Partial<PretrustSeat> = {}): PretrustSeat {
  return { cli, cwd, lobby: true, ...extra };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out.sort();
}

function tables(text: string, kind: 'folders' | 'projects'): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`[${kind}.`))
    .sort();
}

function fieldAfter(text: string, header: string, key: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === header);
  if (at < 0) return null;
  for (let index = at + 1; index < lines.length; index++) {
    const line = (lines[index] ?? '').trim();
    if (line.startsWith('[')) break;
    if (line.startsWith(`${key} =`)) return line;
  }
  return null;
}

/** The directory cursor-agent slugs the lobby into, learned from a probe home rather
 *  than restated here. */
function cursorSlugDirName(lobby: string): string {
  const probe = realpathSync(mkdtempSync(join(tmpdir(), 'team-pretrust-slug-')));
  made.push(probe);
  lobbyPretrustLine(seat('cursor', lobby), probe, { write: true, now: NOW });
  const projects = join(probe, '.cursor', 'projects');
  const names = readdirSync(projects);
  if (names.length !== 1) throw new Error(`probe wrote ${names.length} slug dirs`);
  return names[0] as string;
}

describe('the record names only the lobby', () => {
  test('grok: a fresh home gains exactly one stanza, and none names the home, a parent, or the project', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW })).toBeNull();
    const text = readFileSync(join(home, '.grok', 'trusted_folders.toml'), 'utf8');
    expect(tables(text, 'folders')).toEqual([`[folders."${lobby}"]`]);
    expect(fieldAfter(text, `[folders."${lobby}"]`, 'trusted')).toBe('trusted = true');
  });

  test('grok: a stanza that already refuses the project stays refusing it', () => {
    const { home, lobby, root } = place();
    mkdirSync(join(home, '.grok'));
    const seed = `[folders."${root}"]\ntrusted = false\n`;
    writeFileSync(join(home, '.grok', 'trusted_folders.toml'), seed);
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW })).toBeNull();
    const text = readFileSync(join(home, '.grok', 'trusted_folders.toml'), 'utf8');
    expect(tables(text, 'folders')).toEqual([`[folders."${root}"]`, `[folders."${lobby}"]`].sort());
    expect(fieldAfter(text, `[folders."${root}"]`, 'trusted')).toBe('trusted = false');
    expect(fieldAfter(text, `[folders."${lobby}"]`, 'trusted')).toBe('trusted = true');
  });

  test('claude: the config names exactly the lobby, never the home, a parent, or the project', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW })).toBeNull();
    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { projects: Record<string, unknown> };
    expect(Object.keys(doc.projects).sort()).toEqual([lobby]);
  });

  test('codex: a fresh home gains exactly one table, and none names the home, a parent, or the project', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('codex', lobby), home, { write: true, now: NOW })).toBeNull();
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(tables(text, 'projects')).toEqual([`[projects."${lobby}"]`]);
    expect(fieldAfter(text, `[projects."${lobby}"]`, 'trust_level')).toBe('trust_level = "trusted"');
  });

  test('cursor: exactly one slug dir, and its marker names the lobby', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('cursor', lobby), home, { write: true, now: NOW })).toBeNull();
    const projects = join(home, '.cursor', 'projects');
    expect(readdirSync(projects)).toHaveLength(1);
    const marker = JSON.parse(readFileSync(filesUnder(projects)[0] as string, 'utf8')) as { workspacePath: string };
    expect(marker.workspacePath).toBe(lobby);
  });

  test('a lobby reached through a symlink is recorded by its real path, never by the link', () => {
    const { base, home, lobby } = place();
    const link = join(base, 'lobby-link');
    symlinkSync(lobby, link);
    expect(lobbyPretrustLine(seat('grok', link), home, { write: true, now: NOW })).toBeNull();
    const grok = readFileSync(join(home, '.grok', 'trusted_folders.toml'), 'utf8');
    expect(tables(grok, 'folders')).toEqual([`[folders."${lobby}"]`]);

    expect(lobbyPretrustLine(seat('claude-code', link), home, { write: true, now: NOW })).toBeNull();
    const doc = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as { projects: Record<string, unknown> };
    expect(Object.keys(doc.projects)).toEqual([lobby]);
  });
});

describe('a config path that is a link is refused, never written through', () => {
  test('grok: trusted_folders.toml itself a link to a file outside the home', () => {
    const { base, home, lobby } = place();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'trusted_folders.toml');
    const seed = '[folders."/already"]\ntrusted = true\n';
    writeFileSync(target, seed);
    mkdirSync(join(home, '.grok'));
    symlinkSync(target, join(home, '.grok', 'trusted_folders.toml'));

    const line = lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for grok: run grok --trust in ${lobby}`);
    expect(readFileSync(target, 'utf8')).toBe(seed);
  });

  test('claude: .claude.json a dangling link, its target outside the home', () => {
    const { base, home, lobby } = place();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'claude.json');
    symlinkSync(target, join(home, '.claude.json'));

    const line = lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for claude: run claude in ${lobby} and accept the folder`);
    expect(existsSync(target)).toBe(false);
  });

  test('cursor: the workspace-trusted marker a dangling link, its target outside the home', () => {
    const { base, home, lobby } = place();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = join(outside, '.workspace-trusted');
    const slug = cursorSlugDirName(lobby);
    mkdirSync(join(home, '.cursor', 'projects', slug), { recursive: true });
    symlinkSync(target, join(home, '.cursor', 'projects', slug, '.workspace-trusted'));

    const line = lobbyPretrustLine(seat('cursor', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for cursor: run cursor-agent --trust in ${lobby}`);
    expect(existsSync(target)).toBe(false);
  });

  test('codex: config.toml itself a link to a file outside the home', () => {
    const { base, home, lobby } = place();
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'config.toml');
    const seed = '[projects."/already"]\ntrust_level = "trusted"\n';
    writeFileSync(target, seed);
    mkdirSync(join(home, '.codex'));
    symlinkSync(target, join(home, '.codex', 'config.toml'));

    const line = lobbyPretrustLine(seat('codex', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for codex: run codex in ${lobby} and accept the folder`);
    expect(readFileSync(target, 'utf8')).toBe(seed);
  });

  test('grok: the .grok directory itself a link to a directory outside the home', () => {
    const { base, home, lobby } = place();
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, '.grok'));

    const line = lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for grok: run grok --trust in ${lobby}`);
    expect(filesUnder(elsewhere)).toEqual([]);
  });
});

describe('only a CLI the team launches gets a record', () => {
  test('a grok seat and a claude seat leave cursor and codex without any config', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(existsSync(join(home, '.cursor'))).toBe(false);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  test('an antigravity seat reports no line and gets no guessed file', () => {
    const { home, lobby } = place();
    expect(lobbyPretrustLine(seat('antigravity', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(lobbyPretrustLine(seat('antigravity', lobby), home, { write: false, now: NOW })).toBeNull();
    expect(filesUnder(home)).toEqual([]);
  });

  test('a seat on hold, refused, or already running is left alone', () => {
    const { home, lobby } = place();
    const held: PretrustSeat[] = [
      seat('claude-code', lobby, { unidentifiedHold: 'held' }),
      seat('claude-code', lobby, { launchProblem: 'prior refusal' }),
      seat('claude-code', lobby, { stage: 'named', pane: 'a-pane' }),
      seat('claude-code', lobby, { stage: 'launched', pane: 'a-pane', agentLive: true }),
    ];
    for (const one of held) {
      expect(lobbyPretrustLine(one, home, { write: true, now: NOW })).toBeNull();
    }
    expect(filesUnder(home)).toEqual([]);
  });
});

describe('what cannot be written comes back as the repair line', () => {
  test('claude: a lobby that is the home itself is never written', () => {
    const { home } = place();
    const line = lobbyPretrustLine(seat('claude-code', home), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for claude: run claude in ${home} and accept the folder`);
    expect(existsSync(join(home, '.claude.json'))).toBe(false);
  });

  test('claude: a config that is not JSON is left byte-identical', () => {
    const { home, lobby } = place();
    const seed = 'not json at all{';
    writeFileSync(join(home, '.claude.json'), seed);
    const line = lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for claude: run claude in ${lobby} and accept the folder`);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(seed);
  });

  test('claude: projects that is not an object is left byte-identical', () => {
    const { home, lobby } = place();
    const seed = '{"projects":[]}';
    writeFileSync(join(home, '.claude.json'), seed);
    const line = lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for claude: run claude in ${lobby} and accept the folder`);
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe(seed);
  });

  test('grok: a config path occupied by a directory is refused, and the tree is left as it is', () => {
    const { home, lobby } = place();
    mkdirSync(join(home, '.grok', 'trusted_folders.toml'), { recursive: true });
    const line = lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW });
    expect(line).toBe(`the lobby is not trusted for grok: run grok --trust in ${lobby}`);
    expect(existsSync(join(home, '.grok', 'trusted_folders.toml'))).toBe(true);
  });

  test('a dry run writes nothing for any CLI', () => {
    for (const cli of ['grok', 'cursor', 'claude-code', 'codex']) {
      const { home, lobby } = place();
      expect(lobbyPretrustLine(seat(cli, lobby), home, { write: false, now: NOW })).toBeNull();
      expect(filesUnder(home)).toEqual([]);
    }
  });
});
