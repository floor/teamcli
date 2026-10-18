import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/profile.ts';
import { registerInbox, selfRunner, type InboxRun } from '../src/mcp/register.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A seat's folder: the fixture's team file, and in a repository when `repo` says so. */
function folder(options: { repo?: 'plain' | 'ignored' } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), example);
  if (options.repo) {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    if (options.repo === 'ignored') writeFileSync(join(dir, '.gitignore'), '.gemini/\n');
  }
  return dir;
}

/** Gemini's own add as the launch runs it: write the file the command is measured to write. */
function fakeAdd(writes = true): { run: (command: string, args: readonly string[], cwd: string) => InboxRun; calls: { command: string; args: readonly string[]; cwd: string }[] } {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  return {
    calls,
    run(command, args, cwd) {
      calls.push({ command, args, cwd });
      if (writes) {
        mkdirSync(join(cwd, '.gemini'), { recursive: true });
        writeFileSync(join(cwd, '.gemini', 'settings.json'), '{}\n');
      }
      return { code: 0 };
    },
  };
}

describe('registerInbox', () => {
  test('gemini carries a measured project-scope add, with the runner and the file it writes', () => {
    const gemini = profileFor('gemini');
    expect(gemini?.mcpInbox).toEqual({
      launchArgs: [],
      add: ['mcp', 'add', '-s', 'project', 'team-inbox', '{command}', '--', '{entry}', 'mcp', 'serve', '--seat', '{seat}', '--session', '{session}'],
      target: '.gemini/settings.json',
      file: null,
    });
  });

  test('a folder outside a repository registers: the CLI add runs with the runner and the seat', () => {
    const dir = folder();
    const { run, calls } = fakeAdd();
    const runner = selfRunner();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({ ok: true });
    expect(calls).toEqual([{
      command: 'gemini',
      cwd: dir,
      args: ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command, '--', runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web'],
    }]);
  });

  test('a work tree that does not ignore the file refuses, and the add never runs', () => {
    const dir = folder({ repo: 'plain' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({
      ok: false,
      reason: 'its project does not ignore .gemini/settings.json',
    });
    expect(calls).toEqual([]);
    expect(() => readFileSync(join(dir, '.gemini', 'settings.json'))).toThrow();
  });

  test('a work tree that ignores the file registers', () => {
    const dir = folder({ repo: 'ignored' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test('a tracked file the project would otherwise ignore refuses like any tracked file', () => {
    const dir = folder({ repo: 'ignored' });
    mkdirSync(join(dir, '.gemini'));
    writeFileSync(join(dir, '.gemini', 'settings.json'), '{}\n');
    execFileSync('git', ['add', '-f', '--', '.gemini/settings.json'], { cwd: dir, stdio: 'ignore' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({
      ok: false,
      reason: 'its project does not ignore .gemini/settings.json',
    });
    expect(calls).toEqual([]);
  });

  test('a refused add names the command and its exit', () => {
    const dir = folder();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run: () => ({ code: 2 }) })).toEqual({
      ok: false,
      reason: '`gemini mcp add` exited 2',
    });
  });

  test('an add that says it wrote the file and did not is a refusal', () => {
    const dir = folder();
    const { run } = fakeAdd(false);
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({
      ok: false,
      reason: '.gemini/settings.json was not written',
    });
  });

  test('a folder with no team file refuses: the server could not resolve the team there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(dir);
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({
      ok: false,
      reason: 'no team file could be read from its folder',
    });
    expect(calls).toEqual([]);
  });

  test('a CLI with no file route registers nothing', () => {
    expect(registerInbox({ cli: 'codex', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
    expect(registerInbox({ cli: 'muse', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
  });
});
