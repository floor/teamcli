// One CLI run reads the owner's entities file and projects file once: the per-run memo keeps the
// declared rules for the life of the run, and a writer inside the run drops what it changed so the
// next read sees the write. Nothing crosses a run boundary — the scope is entered on entry and
// discarded in `finally` — so a later command reads the files as they are then.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUp } from '../src/commands/up.ts';
import { declaredEntityRules, entityRules, writeEntityRulesSet } from '../src/entities.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { declaredProjectRules, projectRules, setProjectRules } from '../src/registry/projects.ts';
import { currentRunMemo, enterRunMemo, leaveRunMemo } from '../src/run-memo.ts';
import { testIo } from './helpers.ts';
import { NOW, world, type World } from './send-native-fixtures.ts';

let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'team-run-memo-'));
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeEntities(...rules: string[]): void {
  writeFileSync(
    join(home, '.config', 'team', 'entities.yaml'),
    ['entities:', '  ent-a:', '    name: Ent A', '    rules:', ...rules.map((rule) => `      - ${JSON.stringify(rule)}`), ''].join('\n'),
  );
}

function writeProjects(...rules: string[]): void {
  writeFileSync(
    join(home, '.config', 'team', 'projects.yaml'),
    ['projects:', '  beacon:', '    name: Beacon', '    rules:', ...rules.map((rule) => `      - ${JSON.stringify(rule)}`), ''].join('\n'),
  );
}

describe('the per-run rules memo', () => {
  test('one run reads entities.yaml once; the next run sees the file as it is then', () => {
    writeEntities('first');
    enterRunMemo();
    try {
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
      writeEntities('second');
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
    } finally {
      leaveRunMemo();
    }
    expect(entityRules(home, 'ent-a')).toEqual(['second']);
  });

  test('one run reads projects.yaml once; the next run sees the file as it is then', () => {
    writeProjects('first');
    enterRunMemo();
    try {
      expect(projectRules(home, 'beacon')).toEqual(['first']);
      writeProjects('second');
      expect(projectRules(home, 'beacon')).toEqual(['first']);
    } finally {
      leaveRunMemo();
    }
    expect(projectRules(home, 'beacon')).toEqual(['second']);
  });

  test('a reader gets its own copy: a caller cannot write through into the memo', () => {
    writeEntities('first');
    writeProjects('first');
    enterRunMemo();
    try {
      declaredEntityRules(home).get('ent-a')?.push('injected');
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
      declaredProjectRules(home).clear();
      // A direct write to the file is not the run's writer: the run's read stands, and the copy
      // the caller cleared never reached the memo.
      writeProjects('still first');
      expect(projectRules(home, 'beacon')).toEqual(['first']);
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
    } finally {
      leaveRunMemo();
    }
  });

  test('an entity rules write inside the run drops what the run read', () => {
    writeEntities('first');
    enterRunMemo();
    try {
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
      expect(writeEntityRulesSet(home, 'ent-a', ['second']).written).toBe(true);
      expect(entityRules(home, 'ent-a')).toEqual(['second']);
    } finally {
      leaveRunMemo();
    }
  });

  test('a project rules write inside the run drops what the run read', () => {
    writeProjects('first');
    enterRunMemo();
    try {
      expect(projectRules(home, 'beacon')).toEqual(['first']);
      expect(setProjectRules(home, 'beacon', ['second']).written).toBe(true);
      expect(projectRules(home, 'beacon')).toEqual(['second']);
    } finally {
      leaveRunMemo();
    }
  });

  test('no scope is active outside a run', () => {
    expect(currentRunMemo()).toBeNull();
    enterRunMemo();
    expect(currentRunMemo()).not.toBeNull();
    leaveRunMemo();
    expect(currentRunMemo()).toBeNull();
  });
});

describe('a team up run holds the memo', () => {
  let made: World | null = null;

  afterEach(() => {
    made?.cleanup();
    made = null;
  });

  test('for the whole run, and drops it when the run returns', async () => {
    made = world();
    const seen: boolean[] = [];
    // What the run returns is not this scene's subject — the world is approved by nothing, so a
    // dry run may refuse — but every step it did reach saw the same scope, and the scope is gone
    // when it returns.
    await runUp(['--dry-run'], testIo(made.root, { kind: 'owner' }), {
      home: made.home,
      agents: () => [],
      sessionRunning: () => {
        seen.push(currentRunMemo() !== null);
        return false;
      },
      now: () => NOW,
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((held) => held)).toBe(true);
    expect(currentRunMemo()).toBeNull();
  });

  test('composes identical entity and home-project rules across multiple seats even if files change mid-run', () => {
    const parsed = validateTeamFile(
      [
        'format: 1',
        'project: alpha',
        'entity: ent-a',
        'in_project: Beacon',
        'coordinator: lead-a',
        'operator: lead-a',
        'session: alpha',
        'workspace:',
        '  mode: shared',
        'seats:',
        '  - role: coordinator',
        '    name: lead-a',
        '    cli: claude-code',
        '    vendor: anthropic',
        '    model: Claude Opus 4.6',
        '    version: "1"',
        '    launch: claude',
        '  - role: builder',
        '    name: seat-b',
        '    cli: claude-code',
        '    vendor: anthropic',
        '    model: Claude Opus 4.6',
        '    version: "1"',
        '    launch: claude',
        '',
      ].join('\n'),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const [seat1, seat2] = parsed.team.seats;

    writeEntities('Entity rule v1');
    writeFileSync(
      join(home, '.config', 'team', 'projects.yaml'),
      [
        'projects:',
        '  beacon-id:',
        '    name: Beacon',
        '    rules:',
        '      - "Project rule v1"',
        '',
      ].join('\n'),
    );

    enterRunMemo();
    try {
      const firstSeatRules = rulesOf(parsed.team, seat1!, '/tmp/root-a', undefined, 'file', home);
      // Simulate the owner editing entities.yaml and projects.yaml on disk mid-plan between seats:
      writeEntities('Entity rule v2');
      writeFileSync(join(home, '.config', 'team', 'projects.yaml'), 'projects: {}\n');
      const secondSeatRules = rulesOf(parsed.team, seat2!, '/tmp/root-a', undefined, 'file', home);

      expect(firstSeatRules).toContain('Entity rules (ent-a):\n- Entity rule v1');
      expect(firstSeatRules).toContain('Project rules (beacon-id):\n- Project rule v1');
      expect(secondSeatRules).toContain('Entity rules (ent-a):\n- Entity rule v1');
      expect(secondSeatRules).toContain('Project rules (beacon-id):\n- Project rule v1');
      expect(secondSeatRules).not.toContain('Entity rule v2');
    } finally {
      leaveRunMemo();
    }
  });
});
