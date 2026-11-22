// The team registry file is parsed again only when its text changed, and every reader gets its
// own copy (src/registry/teams.ts `readTeams`, `getTeam`).
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterRunMemo, leaveRunMemo } from '../../src/run-memo.ts';
import { getTeam, readTeams, teamsFile, TeamsError, upsertTeam } from '../../src/registry/teams.ts';
import * as yaml from '../../src/yaml.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function homeWithTeams(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'teams-parse-cache-')));
  roots.push(home);
  for (const name of ['alpha', 'beta']) {
    upsertTeam(home, `team-${name}`, { project: name, session: name, root: join(home, name), roster: [{ agent: 'agt_000000000001', seat: 'lead', role: 'coordinator' }] });
  }
  return home;
}

describe('the team registry parse kept by text', () => {
  test('an unchanged file is not parsed again, a changed one is, and a corrupt one still throws', () => {
    const home = homeWithTeams();
    const parse = spyOn(yaml, 'parseYaml');
    try {
      expect(readTeams(home)['team-alpha']?.project).toBe('alpha');
      const after = parse.mock.calls.length;
      expect(readTeams(home)['team-beta']?.project).toBe('beta');
      expect(parse.mock.calls.length).toBe(after);
      // The same size, a different text: parsed again.
      const path = teamsFile(home);
      writeFileSync(path, readFileSync(path, 'utf8').replace('project: alpha', 'project: gamma'));
      expect(readTeams(home)['team-alpha']?.project).toBe('gamma');
      expect(parse.mock.calls.length).toBe(after + 1);
      const good = readFileSync(path, 'utf8');
      writeFileSync(path, 'teams: [not: valid\n');
      expect(() => readTeams(home)).toThrow(TeamsError);
      writeFileSync(path, good);
      expect(readTeams(home)['team-alpha']?.project).toBe('gamma');
    } finally {
      parse.mockRestore();
    }
  });

  test('a reader cannot change what the next reader is given, in a run or out of one', () => {
    const home = homeWithTeams();
    const first = readTeams(home);
    first['team-alpha']!.project = 'changed';
    first['team-alpha']!.roster[0]!.seat = 'changed';
    delete first['team-beta'];
    expect(readTeams(home)['team-alpha']?.project).toBe('alpha');
    expect(readTeams(home)['team-beta']).toBeDefined();
    enterRunMemo();
    try {
      const one = getTeam(home, 'team-alpha');
      expect(one?.roster[0]?.seat).toBe('lead');
      one!.roster[0]!.seat = 'changed';
      expect(getTeam(home, 'team-alpha')?.roster[0]?.seat).toBe('lead');
      expect(readTeams(home)['team-alpha']?.roster[0]?.seat).toBe('lead');
      expect(getTeam(home, 'team-none')).toBeNull();
      expect(getTeam(home, 'constructor')).toBeNull();
    } finally {
      leaveRunMemo();
    }
  });
});
