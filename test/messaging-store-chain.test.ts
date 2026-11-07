// The store chain a send reads: the receiving seat's signed `messaging.store` records and the
// team file's own words, resolved by the same rules the settings resolver applies. The scenes
// pin the direction the approval fixed — any level may tighten toward `first`, only the entity
// and the project may loosen — and the refusal a project, team or seat record that exists and
// cannot be read earns, since each of those may be the level that closed the door.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import type { ProjectRecord } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { StoreChainUnreadable, messagingStoreChainOf } from '../src/send/store.ts';

const NOW = new Date('2026-11-03T12:00:00Z');

function teamText(extraTop = '', helperExtra = ''): string {
  return `format: 1
project: acme
entity: lab
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: worker
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
${helperExtra}${extraTop}`;
}

describe('the store chain', () => {
  let base: string;
  let root: string;
  let home: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'store-chain-'));
    root = join(base, 'team');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function file(extraTop = '', helperExtra = ''): TeamFile {
    const text = teamText(extraTop, helperExtra);
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const result = validateTeamFile(text);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.team;
  }

  function set(level: 'entity' | 'project' | 'team' | 'seat', target: string, value: string): void {
    const wrote = writePolicySet(
      home,
      { level, target, name: 'messaging.store', value, ...(level === 'team' ? { teamRoot: root } : {}) },
      { now: NOW },
    );
    if (!wrote.ok) throw new Error(wrote.why);
  }

  function chain(team: TeamFile | undefined, projectOfTeam: (id: string) => ProjectRecord | null = () => null, agentId: string | null = 'agent-helper') {
    return messagingStoreChainOf({
      root,
      seat: 'helper',
      agentId,
      home,
      ...(team === undefined ? {} : { file: team }),
      projectOfTeam,
      now: NOW,
    });
  }

  const project = (id: string): ProjectRecord => ({ id, name: 'acme', entity: 'lab', root } as unknown as ProjectRecord);

  test('nothing declares it: first, from no level', () => {
    const resolved = chain(file());
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBeNull();
    expect(resolved.refused).toEqual([]);
  });

  test('the entity loosens toward parallel or none', () => {
    set('entity', 'lab', 'none');
    const resolved = chain(file());
    expect(resolved.value).toBe('none');
    expect(resolved.source).toBe('entity');
  });

  test('the project tightens the entity back toward first', () => {
    set('entity', 'lab', 'none');
    set('project', 'p-1', 'parallel');
    const resolved = chain(file(), () => project('p-1'));
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('project');
  });

  test('a team record tightens the entity back to first', () => {
    const loaded = file();
    set('entity', 'lab', 'none');
    set('team', root, 'first');
    const resolved = chain(loaded);
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBe('team');
  });

  test('a team file word fills in where the team holds no signed record', () => {
    set('entity', 'lab', 'none');
    const resolved = chain(file('messaging:\n  store: first\n'));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBe('team');
  });

  test("a seat's file word may close the door the entity opened", () => {
    set('entity', 'lab', 'none');
    const resolved = chain(file('', '    messaging:\n      store: first\n'));
    expect(resolved.value).toBe('first');
    expect(resolved.source).toBe('seat');
  });

  test("a seat's file word that loosens is set aside", () => {
    set('entity', 'lab', 'parallel');
    const resolved = chain(file('', '    messaging:\n      store: none\n'));
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'seat', value: 'none' }]);
  });

  test("a seat record that loosens is set aside under the entity's parallel", () => {
    const loaded = file();
    const agent = registerAgent(home, {
      name: 'helper',
      signing: { model: 'Test', version: '1', role: 'worker' },
      lab: 'test',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(root), seat: 'helper', session: 'acme', pane: null, address: null },
      mcp: [],
      skills: [],
      lifecycle: 'registered',
      by: 'test',
    });
    set('entity', 'lab', 'parallel');
    set('seat', agent.id, 'none');
    const resolved = chain(loaded, () => null, agent.id);
    expect(resolved.value).toBe('parallel');
    expect(resolved.source).toBe('entity');
    expect(resolved.refused).toEqual([{ level: 'seat', value: 'none' }]);
  });

  test('a project policy record that exists and cannot be read refuses the chain', () => {
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    writeFileSync(join(home, '.config', 'team', 'projects.yaml'), 'projects: { this is not valid yaml\n');
    let caught: unknown = null;
    try {
      chain(file(), () => project('p-1'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreChainUnreadable);
    expect((caught as Error).message).toContain("the project's messaging.store record cannot be read");
  });

  test('a registry that cannot name the project refuses the chain', () => {
    let caught: unknown = null;
    try {
      chain(file(), () => {
        throw new Error('teams.yaml does not read');
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StoreChainUnreadable);
    expect((caught as Error).message).toContain('the project registry cannot name');
  });
});
