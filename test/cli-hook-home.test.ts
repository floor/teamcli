// A seat's generated settings file lives under TeamCLI's machine folder, never in the project:
// it holds the seat's hooks and, for a read-only seat, its sandbox and denials. The suite's older
// scenes keep the project layout (`TEAM_HOOKS_HOME=project`, test/preload); these scenes set a
// scratch machine folder of their own.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliHookLegacySettingsPath, cliHookSettingsPath, installCliHooks } from '../src/launch/cli-hook.ts';
import { declaredInboundOf } from '../src/send/inbound.ts';

const SESSION = 'crew';
const CLAUDE = 'claude --model claude-opus-5-5';
let base: string;
let saved: string | undefined;
let home: string;
let root: string;
let dir: string;

beforeEach(() => {
  saved = process.env.TEAM_HOOKS_HOME;
  base = mkdtempSync(join(tmpdir(), 'cli-hook-home-'));
  home = join(base, 'hooks');
  mkdirSync(home, { mode: 0o700 });
  root = join(base, 'project');
  dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.TEAM_HOOKS_HOME = home;
});

afterEach(() => {
  if (saved === undefined) delete process.env.TEAM_HOOKS_HOME;
  else process.env.TEAM_HOOKS_HOME = saved;
});

describe('the seats\' settings files live in TeamCLI\'s machine folder', () => {
  test('the install writes the file there, owner-only, and nothing under the project\'s hooks folder', () => {
    const landed = installCliHooks(dir, SESSION, [{ name: 'worker', cli: 'claude-code', launch: CLAUDE }]);
    const path = landed.worker!;
    expect(path).toBe(cliHookSettingsPath(dir, SESSION, 'worker')!);
    expect(path.startsWith(`${home}/`)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    for (let folder = dirname(path); folder !== dirname(home); folder = dirname(folder)) {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(dir, 'hooks'))).toBe(false);
    // The hooks' own state files stay in the project state folder, which the seat's sandbox grants.
    expect(readdirSync(join(dir, 'seat-state'))).toEqual([SESSION]);
  });

  test('two projects never share a seat\'s file, and the name does not spell out the project path', () => {
    const other = join(base, 'other', '.agents');
    mkdirSync(other, { recursive: true });
    const one = cliHookSettingsPath(dir, SESSION, 'worker')!;
    const two = cliHookSettingsPath(other, SESSION, 'worker')!;
    expect(one).not.toBe(two);
    expect(one).not.toContain('project');
  });

  test('a seat still running on the file in the project keeps its socket declaration until its next launch', () => {
    const legacy = cliHookLegacySettingsPath(dir, SESSION, 'worker')!;
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"crossSessionInbound":"accept"}\n');
    const declared = declaredInboundOf({ dir, root, session: SESSION, seat: 'worker', launch: `${CLAUDE} --settings ${legacy}` });
    expect(declared.policy).toBe('accept');
    expect(declared.source).toBe(legacy);
  });
});
