import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/profile.ts';
import { registerInbox, selfRunner, type InboxRun } from '../src/mcp/register.ts';

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
    });
  });

  test('grok carries the same measured add, to its own project config', () => {
    const grok = profileFor('grok');
    expect(grok?.mcpInbox).toEqual({
      launchArgs: [],
      add: ['mcp', 'add', '-s', 'project', 'team-inbox', '{command}', '--', '{entry}', 'mcp', 'serve', '--seat', '{seat}', '{epoch}', '--session', '{session}', '{file}'],
      target: '.grok/config.toml',
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

  test('a work tree that does not ignore the file excludes it and then registers', () => {
    const dir = folder({ repo: 'plain' });
    const { run, calls } = fakeAdd();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.gemini/settings.json\n');
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
      reason: 'its project tracks .gemini/settings.json',
    });
    expect(calls).toEqual([]);
  });

  test('a non-json target the add does not write names that target', () => {
    const dir = folder({ repo: 'plain' });
    expect(registerInbox({ cli: 'grok', seat: 'helper', cwd: dir, run: () => ({ code: 0 }) })).toEqual({
      ok: false,
      reason: '.grok/config.toml was not written',
    });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.grok/config.toml\n');
  });

  test('a json add that exits falls back to writing the project file', () => {
    const dir = folder();
    expect(registerInbox({ cli: 'gemini', seat: 'helper', cwd: dir, run: () => ({ code: 1 }) })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8')).mcpServers['team-inbox']).toBeDefined();
  });

  test('a refused add of a non-json target names the command and its exit', () => {
    const dir = folder();
    expect(registerInbox({ cli: 'grok', seat: 'helper', cwd: dir, run: () => ({ code: 1 }) })).toEqual({
      ok: false,
      reason: '`grok mcp add` exited 1',
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

  test('a CLI with no file route registers nothing', () => {
    expect(registerInbox({ cli: 'codex', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
    expect(registerInbox({ cli: 'muse', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
    expect(registerInbox({ cli: 'antigravity', seat: 'helper', cwd: folder(), run: () => ({ code: 0 }) })).toBeNull();
  });
});

describe('the cursor file route', () => {
  test('cursor declares its own project config and the approval its launch needs', () => {
    expect(profileFor('cursor')?.mcpInbox).toEqual({
      launchArgs: ['--approve-mcps'],
      add: null,
      target: null,
      file: '.cursor/mcp.json',
    });
  });

  test('a folder outside a repository gets the file, holding the runner and the seat', () => {
    const dir = folder();
    const runner = selfRunner();
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: {
        'team-inbox': {
          command: runner.command,
          args: [runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme-web'],
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
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({ ok: true });
    const written = JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8'));
    expect(written.theme).toBe('dark');
    expect(Object.keys(written.mcpServers).sort()).toEqual(['other', 'team-inbox']);
    expect(written.mcpServers.other).toEqual({ command: 'x', args: [] });
  });

  test('a work tree that does not ignore the file excludes it and then writes it', () => {
    const dir = folder({ repo: 'plain' });
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({ ok: true });
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.cursor/mcp.json\n');
    expect(JSON.parse(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).mcpServers['team-inbox']).toBeDefined();
  });

  test('a work tree that ignores the file registers', () => {
    const dir = folder({ repo: 'ignored', ignore: '.cursor/\n' });
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({ ok: true });
  });

  test('a file that is not JSON is left exactly as it is', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), 'not json\n');
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({
      ok: false,
      reason: '.cursor/mcp.json is not JSON, so it was left as it is',
    });
    expect(readFileSync(join(dir, '.cursor', 'mcp.json'), 'utf8')).toBe('not json\n');
  });

  test('an mcpServers that is not an object is a refusal, not an overwrite', () => {
    const dir = folder();
    mkdirSync(join(dir, '.cursor'));
    writeFileSync(join(dir, '.cursor', 'mcp.json'), '{"mcpServers": []}\n');
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({
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
    expect(registerInbox({ cli: 'cursor', seat: 'helper', cwd: dir })).toEqual({
      ok: false,
      reason: '.cursor/mcp.json is not a regular file',
    });
    expect(readFileSync(outside, 'utf8')).toBe('{"untouched": true}\n');
  });
});
