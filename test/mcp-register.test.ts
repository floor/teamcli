import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxEntryName, profileFor } from '../src/profiles/profile.ts';
import { registerInbox, removeInbox, selfRunner, type InboxRun } from '../src/mcp/register.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
// Another team, for the scenes where the seat's folder and the launch name different teams.
const elsewhere = example.replace('project: acme-web', 'project: elsewhere').replace('session: acme-web', 'session: elsewhere');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A seat's folder: the fixture's team file, and in a repository when `repo` says so. */
function folder(options: { repo?: 'plain' | 'ignored'; ignore?: string; text?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), options.text ?? example);
  if (options.repo) {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    if (options.repo === 'ignored') writeFileSync(join(dir, '.gitignore'), options.ignore ?? '.gemini/\n');
  }
  return dir;
}

/** The team file a folder holds: the file a launch that read this folder names. A registration
 *  that names no file resolves the registry instead, so every scene that wants the folder's team
 *  names the file, exactly as a file team's launch does. */
const fileOf = (dir: string): string => join(dir, '.agents', 'team.yaml');

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
      add: ['mcp', 'add', '-s', 'project', 'team-inbox', '{command}', '--', '{entry}', 'mcp', 'serve', '--seat', '{seat}', '--session', '{session}', '{epoch}', '{file}'],
      target: '.gemini/settings.json',
      file: null,
      remove: null,
    });
  });

  test('grok carries the same measured add, to its own project config', () => {
    const grok = profileFor('grok');
    expect(grok?.mcpInbox).toEqual({
      launchArgs: [],
      add: ['mcp', 'add', '-s', 'project', 'team-inbox', '{command}', '--', '{entry}', 'mcp', 'serve', '--seat', '{seat}', '{epoch}', '--session', '{session}', '{file}'],
      target: '.grok/config.toml',
      file: null,
      remove: null,
    });
  });

  test('a folder outside a repository registers: the CLI add runs with the runner and the seat', () => {
    const dir = folder();
    const { run, calls } = fakeAdd();
    const runner = selfRunner();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run })).toEqual({ ok: true });
    expect(calls).toEqual([{
      command: 'gemini',
      cwd: dir,
      args: ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command, '--', runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web', '--file', fileOf(dir)],
    }]);
  });

  test('a work tree that does not ignore the file excludes it and then registers', () => {
    const dir = folder({ repo: 'plain' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.gemini/settings.json\n');
  });

  test('a work tree that ignores the file registers', () => {
    const dir = folder({ repo: 'ignored' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test('a tracked file the project would otherwise ignore refuses like any tracked file', () => {
    const dir = folder({ repo: 'ignored' });
    mkdirSync(join(dir, '.gemini'));
    writeFileSync(join(dir, '.gemini', 'settings.json'), '{}\n');
    execFileSync('git', ['add', '-f', '--', '.gemini/settings.json'], { cwd: dir, stdio: 'ignore' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run })).toEqual({
      ok: false,
      reason: 'its project tracks .gemini/settings.json',
    });
    expect(calls).toEqual([]);
  });

  test('a non-json target the add does not write names that target', () => {
    const dir = folder({ repo: 'plain' });
    expect(registerInbox({ cli: 'grok', seat: 'helper', cwd: dir, file: fileOf(dir), run: () => ({ code: 0 }) })).toEqual({
      ok: false,
      reason: '.grok/config.toml was not written',
    });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.grok/config.toml\n');
  });

  test('a json add that exits falls back to writing the project file', () => {
    const dir = folder();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run: () => ({ code: 1 }) })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8')).mcpServers['team-inbox']).toBeDefined();
  });

  test('a refused add of a non-json target names the command and its exit', () => {
    const dir = folder();
    expect(registerInbox({ cli: 'grok', seat: 'helper', cwd: dir, file: fileOf(dir), run: () => ({ code: 1 }) })).toEqual({
      ok: false,
      reason: '`grok mcp add` exited 1',
    });
  });

  test('an add that says it wrote the file and did not is a refusal', () => {
    const dir = folder();
    const { run } = fakeAdd(false);
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: fileOf(dir), run })).toEqual({
      ok: false,
      reason: '.gemini/settings.json was not written',
    });
  });

  test('a launch that names no file and no registered team refuses: the folder is not read as the team', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(dir);
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, home: dir, run })).toEqual({
      ok: false,
      reason: 'no registered team holds seat "helper"',
    });
    expect(calls).toEqual([]);
  });

  test('a lobby folder with no team file registers from the file its launch read', () => {
    const project = folder();
    const lobby = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(lobby);
    const teamFile = join(project, '.agents', 'team.yaml');
    const { run, calls } = fakeAdd();
    const runner = selfRunner();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: lobby, file: teamFile, run })).toEqual({ ok: true });
    expect(calls).toEqual([{
      command: 'gemini',
      cwd: lobby,
      args: ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command, '--', runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web', '--file', teamFile],
    }]);
  });

  test('a launch team file with a space in its path reaches the add argv whole', () => {
    const project = folder();
    const spaced = join(project, 'a project');
    mkdirSync(join(spaced, '.agents'), { recursive: true });
    writeFileSync(join(spaced, '.agents', 'team.yaml'), example);
    const lobby = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(lobby);
    const teamFile = join(spaced, '.agents', 'team.yaml');
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: lobby, file: teamFile, run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    // The command is run with an argv array, never a shell: the path is one word.
    expect(calls[0]!.args.slice(-2)).toEqual(['--file', teamFile]);
  });

  test('the launch file wins over a different team file in the seat folder', () => {
    const seat = folder({ text: elsewhere });
    const chosen = folder();
    const teamFile = join(chosen, '.agents', 'team.yaml');
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: seat, file: teamFile, run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(-4)).toEqual(['--session', 'acme-web', '--file', teamFile]);
  });

  test('an unreadable launch file never falls back to the seat folder team', () => {
    const seat = folder();
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: seat, file: join(seat, 'gone.yaml'), run })).toEqual({
      ok: false,
      reason: 'the team file its launch read could not be read',
    });
    expect(calls).toEqual([]);
  });

  test('an empty launch file name refuses instead of reading the seat folder', () => {
    const seat = folder();
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: seat, file: '', run })).toEqual({
      ok: false,
      reason: 'the team file its launch read could not be read',
    });
    expect(calls).toEqual([]);
  });

  test('a launch file that is a folder refuses, leaving the seat folder team unread', () => {
    const seat = folder();
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: seat, file: seat, run })).toEqual({
      ok: false,
      reason: 'the team file its launch read could not be read',
    });
    expect(calls).toEqual([]);
  });

  test('a launch file that cannot be read refuses: the server would start with no team', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(dir);
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, file: join(dir, 'gone.yaml'), run })).toEqual({
      ok: false,
      reason: 'the team file its launch read could not be read',
    });
    expect(calls).toEqual([]);
  });

  test('a CLI with no route at all registers nothing', () => {
    expect(registerInbox({ cli: 'codex', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
    expect(registerInbox({ cli: 'muse', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
  });
});

describe('the antigravity user-level route', () => {
  test('antigravity declares its own store command, one entry per seat, and the remove that follows', () => {
    expect(profileFor('antigravity')?.mcpInbox).toEqual({
      launchArgs: [],
      add: ['mcp', 'add', '{inbox}', '{command}', '{entry}', 'mcp', 'serve', '--seat', '{seat}', '--session', '{session}', '{file}', '{epoch}'],
      target: null,
      file: null,
      remove: ['mcp', 'remove', '{inbox}'],
    });
  });

  test('the add names this team and this seat, and runs in the seat folder', () => {
    const dir = folder();
    const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
    const runner = selfRunner();
    expect(registerInbox({
      cli: 'antigravity',
      seat: 'helper',
      cwd: dir,
      run: (command, args, cwd) => { calls.push({ command, args, cwd }); return { code: 0 }; },
    })).toEqual({ ok: true });
    expect(calls).toEqual([{
      command: 'agy',
      cwd: dir,
      args: ['mcp', 'add', inboxEntryName('acme-web', 'helper'), runner.command, runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web'],
    }]);
  });

  test('a launch team file and its epoch reach the entry, whole', () => {
    const project = folder();
    const teamFile = join(project, '.agents', 'team.yaml');
    const lobby = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(lobby);
    const calls: { command: string; args: readonly string[] }[] = [];
    expect(registerInbox({
      cli: 'antigravity',
      seat: 'helper',
      cwd: lobby,
      file: teamFile,
      epoch: 'runtime-7',
      run: (command, args) => { calls.push({ command, args }); return { code: 0 }; },
    })).toEqual({ ok: true });
    expect(calls[0]!.args.slice(-4)).toEqual(['--file', teamFile, '--epoch', 'runtime-7']);
  });

  test('no project file is written and no git exclude is touched: the store is the CLI\'s own', () => {
    const dir = folder({ repo: 'plain' });
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: dir, run: () => ({ code: 0 }) })).toEqual({ ok: true });
    expect(() => statSync(join(dir, '.gemini'))).toThrow();
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.gemini');
  });

  test('an add that exits is a refusal naming the command and its exit', () => {
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: folder(), run: () => ({ code: 1 }) })).toEqual({
      ok: false,
      reason: '`agy mcp add` exited 1',
    });
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: folder(), run: () => ({ code: null }) })).toEqual({
      ok: false,
      reason: '`agy mcp add` exited without running',
    });
  });

  test('the seat folder is still read for the team: no team file refuses and runs nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(dir);
    let ran = false;
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: dir, run: () => { ran = true; return { code: 0 }; } })).toEqual({
      ok: false,
      reason: 'no team file could be read from its folder',
    });
    expect(ran).toBe(false);
  });
});

describe('removeInbox', () => {
  test('it runs the CLI\'s own remove, naming only this seat\'s entry', () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    expect(removeInbox({
      cli: 'antigravity',
      seat: 'helper',
      session: 'acme-web',
      run: (command, args) => { calls.push({ command, args }); return { code: 0 }; },
    })).toEqual({ ok: true, removed: true });
    expect(calls).toEqual([{ command: 'agy', args: ['mcp', 'remove', inboxEntryName('acme-web', 'helper')] }]);
  });

  test('the store\'s one measured not-found message, and only it, means the entry is gone', () => {
    // The message names the entry that was asked for: the run says "not found", and the entry it
    // names is this seat's. Exit 1 alone proves nothing.
    const entry = inboxEntryName('acme-web', 'helper');
    expect(removeInbox({
      cli: 'antigravity', seat: 'helper', session: 'acme-web',
      run: () => ({ code: 1, stderr: `Error: MCP server "${entry}" not found\n` }),
    })).toEqual({ ok: true, removed: false });
  });

  test('exit 1 for any other reason is a failed removal, and the entry is kept', () => {
    const other = (stderr?: string) => removeInbox({
      cli: 'antigravity', seat: 'helper', session: 'acme-web',
      run: () => (stderr === undefined ? { code: 1 } : { code: 1, stderr }),
    });
    expect(other('Error: the store is locked\n')).toEqual({ ok: false, reason: '`agy mcp remove` exited 1' });
    expect(other()).toEqual({ ok: false, reason: '`agy mcp remove` exited 1' });
    // A not-found message for another entry is not proof that this one is gone.
    expect(other('Error: MCP server "team-inbox-somewhere-else" not found\n'))
      .toEqual({ ok: false, reason: '`agy mcp remove` exited 1' });
  });

  test('a command that did not run, or exited otherwise, is reported and the entry kept', () => {
    expect(removeInbox({ cli: 'antigravity', seat: 'helper', session: 'acme-web', run: () => ({ code: null }) }))
      .toEqual({ ok: false, reason: '`agy mcp remove` did not run' });
    expect(removeInbox({ cli: 'antigravity', seat: 'helper', session: 'acme-web', run: () => ({ code: 2 }) }))
      .toEqual({ ok: false, reason: '`agy mcp remove` exited 2' });
  });

  test('the session and seat are folded the same way the add named the entry', () => {
    const calls: string[][] = [];
    removeInbox({
      cli: 'antigravity',
      seat: 'builder 4',
      session: 'acme/web',
      run: (_command, args) => { calls.push([...args]); return { code: 0 }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toMatch(/^team-inbox-acme-web-builder-4-[0-9a-f]{8}$/);
  });

  test('a route that leaves nothing in a shared store removes nothing', () => {
    expect(removeInbox({ cli: 'gemini', seat: 'helper', session: 'acme-web', run: () => ({ code: 0 }) })).toBeNull();
    expect(removeInbox({ cli: 'grok', seat: 'helper', session: 'acme-web', run: () => ({ code: 0 }) })).toBeNull();
    expect(removeInbox({ cli: 'cursor', seat: 'helper', session: 'acme-web', run: () => ({ code: 0 }) })).toBeNull();
    expect(removeInbox({ cli: 'codex', seat: 'helper', session: 'acme-web', run: () => ({ code: 0 }) })).toBeNull();
  });
});

describe('the cursor file route', () => {
  test('cursor declares its own project config and the approval its launch needs', () => {
    expect(profileFor('cursor')?.mcpInbox).toEqual({
      launchArgs: ['--approve-mcps'],
      add: null,
      target: null,
      file: '.cursor/mcp.json',
      remove: null,
    });
  });

  test('a folder outside a repository gets the file, holding the runner and the seat', () => {
    const dir = folder();
    const runner = selfRunner();
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        'team-inbox': {
          command: runner.command,
          args: [runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web', '--file', fileOf(dir)],
        },
      },
    });
    expect(statSync(join(dir, '.cursor', 'mcp.json')).mode & 0o777).toBe(0o600);
  });

  test('the launch file wins over a different team file in the seat folder', () => {
    const seat = folder({ text: elsewhere });
    const chosen = folder();
    const teamFile = join(chosen, '.agents', 'team.yaml');
    const runner = selfRunner();
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: seat, file: teamFile })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(seat, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        'team-inbox': {
          command: runner.command,
          args: [runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web', '--file', teamFile],
        },
      },
    });
  });

  test('a lobby folder writes its file from the launch team file, naming it to the server', () => {
    const project = folder();
    const lobby = mkdtempSync(join(tmpdir(), 'team-mcp-register-'));
    dirs.push(lobby);
    const teamFile = join(project, '.agents', 'team.yaml');
    const runner = selfRunner();
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: lobby, file: teamFile })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(lobby, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        'team-inbox': {
          command: runner.command,
          args: [runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web', '--file', teamFile],
        },
      },
    });
  });

  test('an existing file keeps its other keys and its other servers', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x', args: [] } } }));
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({ ok: true });
    const written = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.mcpServers).sort()).toEqual(['other', 'team-inbox']);
    expect(written.mcpServers.other).toEqual({ command: 'x', args: [] });
  });

  test('a work tree that does not ignore the file excludes it and then writes it', () => {
    const dir = folder({ repo: 'plain' });
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({ ok: true });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.cursor/mcp.json\n');
    expect(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).mcpServers['team-inbox']).toBeDefined();
  });

  test('a work tree that ignores the file registers', () => {
    const dir = folder({ repo: 'ignored', ignore: '.cursor/\n' });
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({ ok: true });
  });

  test('a file that is not JSON is left exactly as it is', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), 'not json\n');
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({
      ok: false,
      reason: '.cursor/mcp.json is not JSON, so it was left as it is',
    });
    expect(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).toBe('not json\n');
  });

  test('an mcpServers that is not an object is a refusal, not an overwrite', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), '{"mcpServers": []}\n');
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({
      ok: false,
      reason: '.cursor/mcp.json holds mcpServers that is not an object, so it was left as it is',
    });
    expect(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).toBe('{"mcpServers": []}\n');
  });

  test('a link is never followed: the file it names is not written through', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    const outside = join(dir, 'outside.json');
    writeFileSync(outside, '{"untouched": true}\n');
    symlinkSync(outside, join(dir, '.cursor', 'mcp.json'));
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir, file: fileOf(dir) })).toEqual({
      ok: false,
      reason: '.cursor/mcp.json is not a regular file',
    });
    expect(readFileSync(outside, 'utf8')).toBe('{"untouched": true}\n');
  });
});
