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
    enterRunMemo();
    try {
      declaredEntityRules(home).get('ent-a')?.push('injected');
      expect(entityRules(home, 'ent-a')).toEqual(['first']);
      declaredProjectRules(home).clear();
      writeProjects('still first');
      expect(projectRules(home, 'beacon')).toEqual(['still first']);
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
    const code = await runUp(['--dry-run'], testIo(made.root, { kind: 'owner' }), {
      home: made.home,
      agents: () => [],
      sessionRunning: () => {
        seen.push(currentRunMemo() !== null);
        return false;
      },
      now: () => NOW,
    });

    expect(code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((held) => held)).toBe(true);
    expect(currentRunMemo()).toBeNull();
  });
});
