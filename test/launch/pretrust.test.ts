import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lobbyPretrustLine, type PretrustSeat } from '../../src/launch/pretrust.ts';

const NOW = new Date('2026-10-14T15:14:28.000Z');

function homeOf(): string {
  return mkdtempSync(join(tmpdir(), 'pretrust-home-'));
}

function lobbyOf(): string {
  const lobby = mkdtempSync(join(tmpdir(), 'pretrust-lobby-'));
  return realpathSync(lobby);
}

function seat(cli: string, cwd: string, extra: Partial<PretrustSeat> = {}): PretrustSeat {
  return { cli, cwd, lobby: true, ...extra };
}

describe('lobby pretrust', () => {
  test('grok writes the trusted_folders stanza and leaves another folder', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.grok', 'trusted_folders.toml');
    mkdirSync(join(home, '.grok'), { recursive: true });
    writeFileSync(file, '[folders."/already"]\ntrusted = true\ndecided_at = 1\n');
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW })).toBeNull();
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('[folders."/already"]\ntrusted = true\ndecided_at = 1\n');
    expect(text).toContain(`[folders."${lobby}"]\ntrusted = true\ndecided_at = ${Math.floor(NOW.getTime() / 1000)}\n`);
    const again = readFileSync(file, 'utf8');
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: new Date(NOW.getTime() + 5000) })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(again);
  });

  test('grok turns a recorded untrusted folder into a trusted one', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.grok', 'trusted_folders.toml');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `[folders."${lobby}"]\ntrusted = false\ndecided_at = 1\n`);
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(
      `[folders."${lobby}"]\ntrusted = true\ndecided_at = ${Math.floor(NOW.getTime() / 1000)}\n`,
    );
  });

  test('a dry run writes no grok record', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    expect(lobbyPretrustLine(seat('grok', lobby), home, { write: false, now: NOW })).toBeNull();
    expect(existsSync(join(home, '.grok'))).toBe(false);
  });

  test('cursor writes the workspace marker from the path slug', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const slug = lobby.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    expect(lobbyPretrustLine(seat('cursor', lobby), home, { write: true, now: NOW })).toBeNull();
    const file = join(home, '.cursor', 'projects', slug, '.workspace-trusted');
    const marker = JSON.parse(readFileSync(file, 'utf8')) as {
      trustedAt: string;
      workspacePath: string;
      trustMethod: string;
    };
    expect(marker).toEqual({
      trustedAt: NOW.toISOString(),
      workspacePath: lobby,
      trustMethod: 'cli-flag',
    });
    writeFileSync(file, '{"trustedAt":"yesterday"}\n');
    expect(lobbyPretrustLine(seat('cursor', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe('{"trustedAt":"yesterday"}\n');
  });

  test('claude merges the trust flag and keeps the rest of the file', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.claude.json');
    writeFileSync(file, `${JSON.stringify({ numStartups: 3, projects: { '/other': { hasTrustDialogAccepted: false } } }, null, 2)}\n`);
    expect(lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW })).toBeNull();
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      numStartups: number;
      projects: Record<string, { hasTrustDialogAccepted: boolean }>;
    };
    expect(doc.numStartups).toBe(3);
    expect(doc.projects['/other']?.hasTrustDialogAccepted).toBe(false);
    expect(doc.projects[lobby]?.hasTrustDialogAccepted).toBe(true);
  });

  test('claude leaves a file that already trusts the lobby', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.claude.json');
    const text = JSON.stringify({ projects: { [lobby]: { hasTrustDialogAccepted: true, extra: 1 } } });
    writeFileSync(file, text);
    expect(lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  test('claude leaves a file it cannot merge, and does not trust the home directory', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.claude.json');
    writeFileSync(file, 'not json\n');
    const line = lobbyPretrustLine(seat('claude-code', lobby), home, { write: false, now: NOW });
    expect(line).toBe(`the lobby is not trusted for claude: run claude in ${lobby} and accept the folder`);
    expect(lobbyPretrustLine(seat('claude-code', lobby), home, { write: true, now: NOW })).toBe(line);
    expect(readFileSync(file, 'utf8')).toBe('not json\n');

    const homePath = realpathSync(home);
    const homeLine = lobbyPretrustLine(seat('claude-code', homePath), home, { write: true, now: NOW });
    expect(homeLine).toBe(`the lobby is not trusted for claude: run claude in ${homePath} and accept the folder`);
    expect(readFileSync(file, 'utf8')).toBe('not json\n');
  });

  test('codex sets trust_level and keeps the rest of the config', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    const file = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(file, 'model = "gpt-6.1-sol"\n\n[projects."/other"]\ntrust_level = "untrusted"\n');
    expect(lobbyPretrustLine(seat('codex', lobby), home, { write: true, now: NOW })).toBeNull();
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('model = "gpt-6.1-sol"\n\n[projects."/other"]\ntrust_level = "untrusted"\n')).toBe(true);
    expect(text).toContain(`[projects."${lobby}"]\ntrust_level = "trusted"\n`);
    const again = readFileSync(file, 'utf8');
    expect(lobbyPretrustLine(seat('codex', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(again);
  });

  test('antigravity is started without a guessed settings file', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    expect(lobbyPretrustLine(seat('antigravity', lobby), home, { write: false, now: NOW })).toBeNull();
    expect(lobbyPretrustLine(seat('antigravity', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(existsSync(join(home, '.gemini'))).toBe(false);
  });

  test('a seat that is not starting in the lobby is left alone', () => {
    const home = homeOf();
    const lobby = lobbyOf();
    expect(lobbyPretrustLine(seat('antigravity', lobby, { lobby: false }), home, { write: true, now: NOW })).toBeNull();
    expect(lobbyPretrustLine(seat('grok', lobby, { stage: 'ready', pane: 'kept' }), home, { write: true, now: NOW })).toBeNull();
    expect(lobbyPretrustLine(seat('no-such-cli', lobby), home, { write: true, now: NOW })).toBeNull();
    expect(existsSync(join(home, '.grok'))).toBe(false);
  });

  test('a home that cannot hold the record is the repair line', () => {
    const root = homeOf();
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const lobby = lobbyOf();
    expect(lobbyPretrustLine(seat('grok', lobby), blocked, { write: true, now: NOW })).toBe(
      `the lobby is not trusted for grok: run grok --trust in ${lobby}`,
    );
  });
});
