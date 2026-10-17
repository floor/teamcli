// The team file at the project level. Today's `project:` key names the team itself (it becomes
// the team's name); a team names its project in a field this phase adds, and a file written
// before that field existed must load exactly as it did.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTeamFile } from '../src/file/load.ts';
import { gitEnv } from './helpers.ts';

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-file-project-')));
  root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function write(text: string): void {
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
}

function loaded() {
  const result = loadTeamFile(root, { home: join(base, 'home') });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

/** A file written before the project level: `project:` names the team, and no key names a
 *  project — the trust lines and the seat roster are the real files' own. */
function before(extra: string[] = []): string {
  return [
    'format: 1',
    'project: acme',
    'operator: lead',
    ...extra,
    'trust:',
    '  - ~/.config/team/lobby',
    `  - ${root}`,
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: coordinator',
    '    name: lead',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    '    leads: true',
    '',
  ].join('\n');
}

describe('a team file written before the project level', () => {
  test('loads unchanged, with `project:` still naming the team', () => {
    write(before());
    const result = loaded();
    expect(result.team.project).toBe('acme');
    expect(result.root).toBe(root);
    expect(result.path).toBe(join(root, '.agents', 'team.yaml'));
    expect(result.warnings).toEqual([]);
  });

  test('its lead and roster read exactly as they did', () => {
    write(before());
    const result = loaded();
    expect(result.team.orchestrator).toBe('lead');
    expect(result.team.operator).toBe('lead');
    expect(result.team.seats.map((seat) => seat.name)).toEqual(['lead']);
  });

  test('an entity and a lobby written outright still resolve', () => {
    write(before(['entity: Acme', 'lobby: ~/work/lobby']).replace('  - ~/.config/team/lobby', '  - ~/work/lobby'));
    const result = loaded();
    expect(result.team.entity).toBe('Acme');
    expect(result.team.lobby).toBe('~/work/lobby');
  });

  test('every team file the repository keeps as a fixture loads unchanged', () => {
    // The v0.1.2 copies, loaded in place: project name, lead, roster size and the one
    // deprecation each carries are the file's own, and nothing in this phase moves them.
    const cases = [
      { file: 'team.yaml', project: 'team', lead: 'claude-coordinator', seats: 9 },
      { file: 'example.yaml', project: 'acme-web', lead: 'claude-coordinator-acme', seats: 5 },
      { file: 'examples-team.yaml', project: 'beacon', lead: 'claude-keeper', seats: 7 },
    ] as const;
    for (const one of cases) {
      const result = loadTeamFile(import.meta.dir, { file: join(import.meta.dir, 'fixtures', 'legacy', 'v0.1.2', one.file) });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.team.project).toBe(one.project);
      expect(result.team.orchestrator).toBe(one.lead);
      expect(result.team.seats).toHaveLength(one.seats);
      for (const warning of result.warnings) {
        expect(warning.message).toContain('`coordinator:` is now `leads: true`');
      }
    }
  });

  test('an older file spelling the lead `coordinator:` still loads, with the warning that names it', () => {
    write(before().replace('    leads: true', '') .replace('operator: lead\n', 'coordinator: lead\noperator: lead\n'));
    const result = loaded();
    expect(result.team.orchestrator).toBe('lead');
    expect(result.team.project).toBe('acme');
    expect(result.warnings).toEqual([
      {
        line: 3,
        message: '`coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
        repair: "set `leads: true` on the lead's seat and remove `coordinator:` from .agents/team.yaml",
      },
    ]);
  });
});
