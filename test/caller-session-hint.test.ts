import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { hintedHerdrSession, placedCallerTeam } from '../src/registry/binding.ts';
import { upsertTeam } from '../src/registry/teams.ts';

const AT = '2026-11-17T09:00:00.000Z';

/** A home with three teams in three herdr sessions, and caller sources that record which
 *  session each placement proof read. No proof places anyone: only the narrowing is measured. */
function scene(): { home: string; asked: string[]; sources: (session?: string) => CallerSources } {
  const home = mkdtempSync(join(tmpdir(), 'hint-'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    const root = join(home, 'repos', name);
    mkdirSync(join(root, '.agents'), { recursive: true });
    upsertTeam(home, `t-${name}`, { project: name, session: name, root, at: AT });
  }
  const asked: string[] = [];
  const sources = (session?: string): CallerSources => {
    asked.push(session ?? '');
    return { ancestors: () => null, agents: () => null, paneRootPid: () => null, env: {}, stdinIsTTY: false };
  };
  return { home, asked, sources };
}

const socket = (session: string) => `/home/u/.config/herdr/sessions/${session}/herdr.sock`;

describe('caller placement narrowed by the herdr session hint', () => {
  test('the socket path names the session; anything else is no hint', () => {
    expect(hintedHerdrSession({ HERDR_SOCKET_PATH: socket('material') })).toBe('material');
    expect(hintedHerdrSession({ HERDR_SOCKET_PATH: '/home/u/.config/herdr/herdr.sock' })).toBeNull();
    expect(hintedHerdrSession({ HERDR_SOCKET_PATH: '' })).toBeNull();
    expect(hintedHerdrSession({})).toBeNull();
    expect(hintedHerdrSession(undefined)).toBeNull();
  });

  test('a hint naming a team session proves only that session', () => {
    const { home, asked, sources } = scene();
    expect(placedCallerTeam(home, { env: { HERDR_SOCKET_PATH: socket('beta') }, stdinIsTTY: false, callerSources: sources })).toBeNull();
    expect([...new Set(asked)]).toEqual(['beta']);
  });

  test('no hint, or a hint no team uses, keeps the full scan', () => {
    for (const env of [{}, { HERDR_SOCKET_PATH: socket('elsewhere') }]) {
      const { home, asked, sources } = scene();
      placedCallerTeam(home, { env, stdinIsTTY: false, callerSources: sources });
      expect([...new Set(asked)].sort()).toEqual(['alpha', 'beta', 'gamma']);
    }
  });
});
