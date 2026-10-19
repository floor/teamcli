// A named team file is read and only that file. These scenes drive that promise through the
// commands that make it: the real restart launch registering a seat's inbox, `team mcp serve`
// resolving the team it serves, and the launch line / `mcp add` / config-file routes each CLI
// profile carries. Every folder is a synthetic temporary one, and every command is this
// checkout's own; no CLI's private state is read.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realSources as restartSources } from '../src/commands/restart.ts';
import { registerInbox, selfRunner } from '../src/mcp/register.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { testIo } from './helpers.ts';

const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const made: string[] = [];

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function teamText(options: { project: string; session: string; seats: readonly string[] }): string {
  const rows = options.seats.map((name, at) => `  - role: ${at === 0 ? 'coordinator' : 'worker'}
    name: ${name}
    cli: ${at === 0 ? 'claude-code' : 'codex'}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${at === 0 ? 'claude' : 'codex'}`).join('\n');
  return `format: 1
project: ${options.project}
coordinator: ${options.seats[0] ?? 'lead'}
operator: ${options.seats[0] ?? 'lead'}
session: ${options.session}
workspace:
  mode: shared
seats:
${rows}
`;
}

type Place = { root: string; teamFile: string };

function place(options: { project: string; session: string; seats: readonly string[] }): Place {
  const root = temp('team-file-place-');
  mkdirSync(join(root, '.agents'));
  const teamFile = join(root, '.agents', 'team.yaml');
  writeFileSync(teamFile, teamText(options));
  return { root, teamFile };
}

/** The real restart launch's own registration function. The launch object is the one `team
 *  restart` runs with: a missing function here is what leaves every file-route CLI unregistered
 *  on a real restart. */
function restartRegister(): (cli: string, seat: string, cwd: string, teamFile?: string) => unknown {
  const register = restartSources.upLaunch.registerInbox;
  if (typeof register !== 'function') throw new Error('the real restart launch carries no registerInbox');
  return register;
}

describe('the real restart launch registers a seat inbox', () => {
  test('a cursor seat registers from the launch file, not the folder it starts in', () => {
    const seatFolder = place({ project: 'elsewhere', session: 'elsewhere', seats: ['lead', 'worker'] });
    const chosen = place({ project: 'acme', session: 'acme', seats: ['lead', 'worker'] });

    expect(restartRegister()('cursor', 'lead', seatFolder.root, chosen.teamFile)).toEqual({ ok: true });

    // The written config is the launch's: the chosen file's session and path, not the seat
    // folder's team.
    const runner = selfRunner();
    const written = JSON.parse(readFileSync(join(seatFolder.root, '.cursor', 'mcp.json'), 'utf8')) as unknown;
    expect(written).toEqual({
      mcpServers: {
        'team-inbox': {
          command: runner.command,
          args: [runner.entry, 'mcp', 'serve', '--seat', 'lead', '--session', 'acme', '--file', chosen.teamFile],
        },
      },
    });
  });

  for (const [label, launchFile] of [
    ['a missing file', (seat: Place) => join(seat.root, 'gone.yaml')],
    ['an empty name', () => ''],
    ['a folder', (seat: Place) => seat.root],
  ] as const) {
    test(`${label} refuses, though the seat folder holds a valid team`, () => {
      const seatFolder = place({ project: 'elsewhere', session: 'elsewhere', seats: ['lead', 'worker'] });
      expect(restartRegister()('cursor', 'lead', seatFolder.root, launchFile(seatFolder))).toEqual({
        ok: false,
        reason: 'the team file its launch read could not be read',
      });
      // Nothing was written: the folder's own team was never registered in its place.
      expect(existsSync(join(seatFolder.root, '.cursor', 'mcp.json'))).toBe(false);
    });
  }

  test('a file that cannot be read is a refusal, though the seat folder holds a valid team', () => {
    const seatFolder = place({ project: 'elsewhere', session: 'elsewhere', seats: ['lead', 'worker'] });
    // A link to itself cannot be read; no chmod, no private state.
    const loop = join(seatFolder.root, 'loop.yaml');
    symlinkSync(loop, loop);
    expect(restartRegister()('cursor', 'lead', seatFolder.root, loop)).toEqual({
      ok: false,
      reason: 'the team file its launch read could not be read',
    });
    expect(existsSync(join(seatFolder.root, '.cursor', 'mcp.json'))).toBe(false);
  });
});

describe('the mcp add routes take the launch file\'s values unescaped as argv', () => {
  const chosenPath = (dir: string) => join(dir, 'my "project"\\folder', '.agents', 'team.yaml');

  for (const cli of ['gemini', 'grok'] as const) {
    test(`${cli} names the chosen file and session in its own arguments`, () => {
      const seatFolder = place({ project: 'elsewhere', session: 'elsewhere', seats: ['lead', 'worker'] });
      const chosenDir = temp('team-file-chosen-');
      const chosen = chosenPath(chosenDir);
      mkdirSync(join(chosen, '..'), { recursive: true });
      writeFileSync(chosen, teamText({ project: 'acme', session: 'acme', seats: ['lead', 'worker'] }));

      const calls: { command: string; args: string[]; cwd: string }[] = [];
      const target = cli === 'gemini' ? '.gemini/settings.json' : '.grok/config.toml';
      const outcome = registerInbox({
        cli,
        seat: 'lead',
        cwd: seatFolder.root,
        file: chosen,
        run: (command, args, cwd) => {
          calls.push({ command, args: [...args], cwd });
          mkdirSync(join(seatFolder.root, cli === 'gemini' ? '.gemini' : '.grok'), { recursive: true });
          writeFileSync(join(seatFolder.root, target), 'written by the CLI\n');
          return { code: 0 };
        },
      });

      expect(outcome).toEqual({ ok: true });
      const runner = selfRunner();
      // A command's argv is not a shell: the path with a space, a quote and a backslash stays
      // one argument, byte for byte, and `{file}` is the server's own `--file` pair.
      expect(calls).toEqual([{
        command: cli,
        args: ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command,
          '--', runner.entry, 'mcp', 'serve', '--seat', 'lead', '--session', 'acme', '--file', chosen],
        cwd: seatFolder.root,
      }]);
      expect(readFileSync(join(seatFolder.root, target), 'utf8')).toBe('written by the CLI\n');
    });
  }
});

describe('the codex launch line round-trips its values through shell quoting and TOML', () => {
  const codex = profileFor('codex');
  if (!codex) throw new Error('codex has no profile');

  /** A POSIX shell word splitter for the single-quote quoting `shellQuote` produces. */
  function words(line: string): string[] {
    const found: string[] = [];
    let word = '';
    let started = false;
    let quoted = false;
    for (let at = 0; at < line.length; at++) {
      const char = line[at]!;
      if (quoted) {
        if (char === "'") quoted = false;
        else word += char;
        continue;
      }
      if (char === "'") {
        quoted = true;
        started = true;
        continue;
      }
      if (char === '\\') {
        word += line[++at] ?? '';
        started = true;
        continue;
      }
      if (char === ' ') {
        if (started) {
          found.push(word);
          word = '';
          started = false;
        }
        continue;
      }
      word += char;
      started = true;
    }
    if (started) found.push(word);
    return found;
  }

  function pairs(line: string): Map<string, string> {
    const argv = words(line);
    const at = argv.flatMap((word, index) => (word === '-c' ? [index] : []));
    expect(at).toHaveLength(2);
    const filled = new Map<string, string>();
    for (const index of at) {
      const value = argv[index + 1] ?? '';
      const equals = value.indexOf('=');
      filled.set(value.slice(0, equals), value.slice(equals + 1));
    }
    return filled;
  }

  test('spaces, quotes and backslashes come back as the values the launch was given', () => {
    const command = '/opt/My Tools/"bun"\\bin';
    const entry = '/src/dir with space/"cli"\\main.ts';
    const file = '/tmp/my "project"\\folder/.agents/team.yaml';
    const filled = pairs(launchCommand(codex, 'codex', 'Rules.', undefined, {
      seat: 'helper', session: 'acme', command, entry, file,
    }));

    // The `-c` value is a double-quoted TOML string: a JSON string parser reads it back.
    expect(JSON.parse(filled.get('mcp_servers.team_inbox.command')!)).toBe(command);
    expect(JSON.parse(filled.get('mcp_servers.team_inbox.args')!)).toEqual([
      entry, 'mcp', 'serve', '--seat', 'helper', '--file', file,
    ]);
  });

  test('a single quote in the values survives the shell word and the TOML string', () => {
    const command = "/opt/it's here/bun";
    const entry = "/src/it's and \\ more/cli.ts";
    const file = "/tmp/it's \"team\"\\file.yaml";
    const filled = pairs(launchCommand(codex, 'codex', 'Rules.', undefined, {
      seat: 'helper', session: 'acme', command, entry, file,
    }));
    expect(JSON.parse(filled.get('mcp_servers.team_inbox.command')!)).toBe(command);
    expect(JSON.parse(filled.get('mcp_servers.team_inbox.args')!)).toEqual([
      entry, 'mcp', 'serve', '--seat', 'helper', '--file', file,
    ]);
  });

  test('a launch that read no file names no --file in the args array', () => {
    const filled = pairs(launchCommand(codex, 'codex', 'Rules.', undefined, {
      seat: 'helper', session: 'acme', command: '/opt/bun', entry: '/src/cli.ts',
    }));
    expect(JSON.parse(filled.get('mcp_servers.team_inbox.args')!)).toEqual([
      '/src/cli.ts', 'mcp', 'serve', '--seat', 'helper',
    ]);
  });
});

describe('team mcp serve reads the selected file, never the folder team', () => {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });

  async function serve(
    cwd: string,
    home: string,
    options: { seat: string; session?: string; file?: string },
    lines: string[] = [],
  ): Promise<{ code: number; out: string; err: string }> {
    const io = testIo(cwd);
    const replies: string[] = [];
    const code = await runMcpServe(
      { seat: options.seat, session: options.session, ...(options.file === undefined ? {} : { file: options.file }) },
      io,
      {
        lines: (async function* () {
          for (const line of lines) yield line;
        })(),
        write: (line) => replies.push(line),
      },
      { home },
    );
    return { code, out: replies.join('\n'), err: io.err };
  }

  function servedTeam(out: string): string | undefined {
    const reply = JSON.parse(out.split('\n')[0]!) as { result?: { serverInfo?: { name?: string } } };
    return reply.result?.serverInfo?.name;
  }

  test('the chosen file\'s session and roster are the ones served', async () => {
    const cwd = place({ project: 'other', session: 'other', seats: ['lead', 'worker'] });
    const chosen = place({ project: 'acme', session: 'acme', seats: ['lead', 'worker', 'extra'] });

    const happy = await serve(cwd.root, cwd.root, { seat: 'lead', session: 'acme', file: chosen.teamFile }, [initialize]);
    expect(happy.code).toBe(0);
    expect(servedTeam(happy.out)).toBe('team-inbox');

    // The default session is the chosen file's too.
    const byDefault = await serve(cwd.root, cwd.root, { seat: 'lead', file: chosen.teamFile }, [initialize]);
    expect(byDefault.code).toBe(0);
    expect(servedTeam(byDefault.out)).toBe('team-inbox');

    // A seat only the chosen file declares can be served; the folder's roster is not consulted.
    const extra = await serve(cwd.root, cwd.root, { seat: 'extra', file: chosen.teamFile }, [initialize]);
    expect(extra.code).toBe(0);
    const missing = await serve(cwd.root, cwd.root, { seat: 'extra' }, []);
    expect(missing.code).toBe(2);
    expect(missing.err).toBe('team mcp serve: the team file declares no seat "extra"\n');
  });

  test('a session taken from the folder team is refused: the chosen file\'s is the team\'s', async () => {
    const cwd = place({ project: 'other', session: 'other', seats: ['lead', 'worker'] });
    const chosen = place({ project: 'acme', session: 'acme', seats: ['lead', 'worker'] });
    const run = await serve(cwd.root, cwd.root, { seat: 'lead', session: 'other', file: chosen.teamFile }, []);
    expect(run.code).toBe(2);
    expect(run.err).toBe("team mcp serve: the team's session is \"acme\", not \"other\"\n");
  });

  test('a missing, empty, folder or unreadable file refuses, though the folder has a team', async () => {
    const cwd = place({ project: 'other', session: 'other', seats: ['lead', 'worker'] });
    const nested = join(cwd.root, 'nested');
    mkdirSync(nested);
    const loop = join(cwd.root, 'loop.yaml');
    symlinkSync(loop, loop);

    const missing = join(cwd.root, 'gone.yaml');
    for (const [file, message] of [
      [missing, `no team file at ${missing}`],
      ['', `the team file at ${cwd.root} could not be read`],
      [nested, `the team file at ${nested} could not be read`],
      [loop, `no team file at ${loop}`],
    ] as const) {
      const run = await serve(cwd.root, cwd.root, { seat: 'lead', file }, []);
      expect(run.code).toBe(2);
      expect(run.err).toBe(`team mcp serve: ${message}\n`);
      // The refusal came before any listener or inbox folder was made.
      expect(existsSync(join(cwd.root, '.agents', 'send-drops'))).toBe(false);
    }
  });
});

describe('the CLI route reaches the same refusal', () => {
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });

  function env(home: string): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || key === 'TEAM_OWNER_APPROVAL' || key === 'TEAMCLI_DEV_MODE') continue;
      clean[key] = value;
    }
    clean.HOME = home;
    return clean;
  }

  async function cli(
    args: string[],
    options: { cwd: string; home: string; stdin?: string },
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
      cwd: options.cwd,
      env: env(options.home),
      stdin: options.stdin === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (options.stdin !== undefined && proc.stdin) {
      proc.stdin.write(options.stdin);
      await proc.stdin.end();
    }
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  test('--file names the team the server reads, and --session is checked against it', async () => {
    const cwd = place({ project: 'other', session: 'other', seats: ['lead', 'worker'] });
    const chosen = place({ project: 'acme', session: 'acme', seats: ['lead', 'worker'] });
    const home = temp('team-file-home-');

    const served = await cli(['mcp', 'serve', '--seat', 'lead', '--session', 'acme', '--file', chosen.teamFile],
      { cwd: cwd.root, home, stdin: `${initialize}\n` });
    expect(served.code, served.err).toBe(0);
    const reply = JSON.parse(served.out.split('\n')[0]!) as { result?: { serverInfo?: { name?: string } } };
    expect(reply.result?.serverInfo?.name).toBe('team-inbox');

    const wrong = await cli(['mcp', 'serve', '--seat', 'lead', '--session', 'other', '--file', chosen.teamFile],
      { cwd: cwd.root, home });
    expect(wrong.code).toBe(2);
    expect(wrong.err).toBe("team mcp serve: the team's session is \"acme\", not \"other\"\n");
  });

  test('an empty --file is refused by the parser; the server never reads the folder team', async () => {
    const cwd = place({ project: 'other', session: 'other', seats: ['lead', 'worker'] });
    const home = temp('team-file-home-');

    const empty = await cli(['mcp', 'serve', '--seat', 'lead', '--file', ''], { cwd: cwd.root, home });
    expect(empty.code).toBe(2);
    expect(empty.err.startsWith('team mcp: --file needs a value\n')).toBe(true);
    expect(empty.err).toContain('Usage: team mcp status');

    const missing = join(cwd.root, 'gone.yaml');
    const gone = await cli(['mcp', 'serve', '--seat', 'lead', '--file', missing], { cwd: cwd.root, home });
    expect(gone.code).toBe(2);
    expect(gone.err).toBe(`team mcp serve: no team file at ${missing}\n`);
    expect(existsSync(join(cwd.root, '.agents', 'send-drops'))).toBe(false);
  });
});
