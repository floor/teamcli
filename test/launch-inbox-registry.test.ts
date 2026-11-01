// A registry team's launch: `team init` writes only the registry record and `team migrate` moves
// `.agents/team.yaml` away, so the team file a registry read carries a path for need not exist.
// The launch names no file, the registration resolves the registry by the seat's roster, and the
// inbox server does the same — so the seat has an inbox and a send reaches it. One scene per CLI
// whose registration takes the file route, read from the profiles: cursor (its own JSON file),
// gemini and grok (their own `mcp add`, into their own project file). Codex's route is the launch
// line itself: its scene pins the line and serves from the arguments it carries. A file team's
// registration is pinned byte for byte beside them: a named file still reaches the add as
// `--file <path>`, exactly as it did before this change. Every folder is a synthetic temporary
// one; both the registry and the message key live under the scene's own home.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTeamFile } from '../src/file/load.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { executePlan, type Host } from '../src/launch/execute.ts';
import type { Step } from '../src/launch/plan.ts';
import { registerInbox, selfRunner, type InboxRun } from '../src/mcp/register.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { profileFor } from '../src/profiles/index.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { gitEnv, testIo } from './helpers.ts';
import { intoRegistry, underRegistry } from './helpers/registry-team.ts';

type FileRoute = 'cursor' | 'gemini' | 'grok';

const LAUNCH: Record<string, string> = { cursor: 'cursor-agent', gemini: 'gemini', grok: 'grok', codex: 'codex' };
const SESSION = 'acme';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function teamText(cli: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Grok
    version: "4.7"
    launch: claude
  - role: worker
    name: helper
    cli: ${cli}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${LAUNCH[cli]}
`;
}

type World = { home: string; root: string; lobby: string };

/** A registry team in the shape `team init` + `team migrate` leave: the record in the scene's
 *  home, the roster in the registry, and no `.agents/team.yaml` in the checkout at all. */
function registryWorld(cli: string): World {
  const base = temp('team-inbox-registry-');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const root = join(base, 'project');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(cli));
  intoRegistry(root, home);
  rmSync(join(root, '.agents', 'team.yaml'));
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: SESSION,
    root,
    roster: [
      { agent: 'agt_000000000001', seat: 'lead', role: 'coordinator' },
      { agent: 'agt_000000000002', seat: 'helper', role: 'worker' },
    ],
  });
  return { home, root, lobby: temp('team-inbox-lobby-') };
}

/** The launch's host, with the real registration wired the way `team up` wires it: the
 *  command's own home, the launch's session, and the seat's folder. */
function launchHost(input: {
  home: string;
  register: (seat: string, cwd: string, session: string, teamFile: string | undefined) => ReturnType<typeof registerInbox>;
  calls: string[];
}): Host {
  return {
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace: () => ({ pane: 'p1', workspace: 'w1' }),
    paneRun: () => { input.calls.push('paneRun'); return true; },
    registerInbox: (cli, seat, cwd, session, teamFile) => input.register(seat, cwd, session, teamFile),
    typeLine: () => false,
    renameAgent: () => true,
    closeWorkspace: () => true,
    stopSession: () => true,
    kill: () => true,
    agentPanes: () => [],
    classify: () => 'idle',
    sleep: async () => {},
    now: () => 0,
    allow: () => null,
    record: () => {},
    running: () => {},
    drop: () => {},
    say: () => {},
    log: () => {},
  };
}

function steps(input: { cli: string; cwd: string; teamFile?: string }): Step[] {
  return [{
    kind: 'run',
    argv: [],
    do: {
      do: 'launch',
      seat: 'helper',
      label: 'helper',
      command: LAUNCH[input.cli]!,
      pane: 'p1',
      cli: input.cli,
      cwd: input.cwd,
      ...(input.teamFile === undefined ? {} : { teamFile: input.teamFile }),
    },
  }];
}

/** What the seat's CLI writes when its own `mcp add` succeeds, measured shapes only. */
function writeTarget(cli: FileRoute, cwd: string): void {
  if (cli === 'gemini') {
    mkdirSync(join(cwd, '.gemini'), { recursive: true });
    writeFileSync(join(cwd, '.gemini', 'settings.json'), '{"mcpServers":{"team-inbox":{"command":"x","args":[]}}}\n');
    return;
  }
  if (cli === 'grok') {
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(join(cwd, '.grok', 'config.toml'), '[mcp_servers.team-inbox]\n');
    return;
  }
  throw new Error(`${cli} writes its own file`);
}

/** Writes a signed drop for `seat`, serves it the way the seat's client would, and asks the
 *  server what is waiting: the send reaching the seat. */
async function receives(at: World, seat: string, id: string, options: { session?: string } = {}): Promise<void> {
  const dropDir = join(at.root, '.agents', 'send-drops', SESSION, seat);
  mkdirSync(dropDir, { recursive: true, mode: 0o700 });
  const record = signRecord({
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root: realpathSync(at.root),
    session: SESSION,
    at: '2026-11-01T10:00:00.000Z',
    body: `for ${seat}`,
    from: 'lead',
    from_id: null,
    rule: 'the owner',
    thread: id,
  }, at.home);
  writeFileSync(join(dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  const io = testIo(at.lobby);
  const replies: string[] = [];
  const code = await runMcpServe(
    { seat, session: options.session },
    io,
    {
      lines: (async function* () {
        yield JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'inbox_check' } });
      })(),
      write: (line) => replies.push(line),
    },
    { home: at.home },
  );
  expect(code).toBe(0);
  expect(io.err).toBe('');
  const reply = JSON.parse(replies[0]!) as Record<string, any>;
  const listed = JSON.parse(reply.result.content[0].text) as { unread: { id: string }[] };
  expect(listed.unread.map((one) => one.id)).toEqual([id]);
}

for (const cli of ['cursor', 'gemini', 'grok'] as const) {
  test(`${cli}: a registry team's seat launches with its inbox registered, and a send reaches it`, async () => {
    await underRegistry(async () => {
      // A registry team, and no team file in its checkout.
      const at = registryWorld(cli);
      const loaded = readTeamConfig(at.root, { home: at.home });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.source).toBe('registry');
      // The load names no file, and the registration and the server resolve the registry.
      expect(launchTeamFile(loaded)).toBeUndefined();

      const runner = selfRunner();
      const runs: { command: string; args: string[]; cwd: string }[] = [];
      const calls: string[] = [];
      const host = launchHost({
        home: at.home,
        calls,
        register: (seat, cwd, session, teamFile) => registerInbox({
          cli,
          seat,
          cwd,
          session,
          home: at.home,
          ...(teamFile === undefined ? {} : { file: teamFile }),
          run: (command, args, runCwd) => {
            runs.push({ command, args: [...args], cwd: runCwd });
            writeTarget(cli, runCwd);
            return { code: 0 } satisfies InboxRun;
          },
        }),
      });
      const report = await executePlan(steps({ cli, cwd: at.lobby, teamFile: launchTeamFile(loaded) }), SESSION, host);
      expect(report.dropped).toEqual([]);
      expect(calls).toEqual(['paneRun']);

      // The runner and the seat, and the launch's own session. Neither profile has an epoch to
      // name here, so gemini's `{epoch}` and grok's `{epoch}` both substitute to nothing and the
      // two measured add lines collapse to the same argv.
      const expected = ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command, '--',
        runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', SESSION];
      if (cli === 'cursor') {
        const written = JSON.parse(readFileSync(join(at.lobby, '.cursor', 'mcp.json'), 'utf8'));
        expect(written).toEqual({
          mcpServers: { 'team-inbox': { command: runner.command, args: [runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', SESSION] } },
        });
        // No file is named anywhere: a registry team's launch has none to name.
        expect(written.mcpServers['team-inbox'].args).not.toContain('--file');
      } else {
        expect(runs).toEqual([{ command: cli, cwd: at.lobby, args: expected }]);
        expect(runs[0]!.args).not.toContain('--file');
      }

      await receives(at, 'helper', '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { session: SESSION });
    });
  });
}

describe('the codex launch line carries the inbox, naming no file', () => {
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

  test('a registry team: no --file in the args array, and a send reaches the server it starts', async () => {
    await underRegistry(async () => {
      const at = registryWorld('codex');
      const loaded = readTeamConfig(at.root, { home: at.home });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.source).toBe('registry');
      const teamFile = launchTeamFile(loaded);
      expect(teamFile).toBeUndefined();

      const runner = selfRunner();
      const line = launchCommand(codex, 'codex', 'Rules.', undefined, {
        seat: 'helper',
        session: SESSION,
        command: runner.command,
        entry: runner.entry,
        ...(teamFile === undefined ? {} : { file: teamFile }),
      });
      const argv = words(line);
      const filled = new Map<string, string>();
      for (const index of argv.flatMap((word, at2) => (word === '-c' ? [at2] : []))) {
        const value = argv[index + 1] ?? '';
        const equals = value.indexOf('=');
        filled.set(value.slice(0, equals), value.slice(equals + 1));
      }
      const args = JSON.parse(filled.get('mcp_servers.team_inbox.args')!) as string[];
      expect(args).toEqual([runner.entry, 'mcp', 'serve', '--seat', 'helper']);
      expect(args).not.toContain('--file');

      // The server started from that args array serves the registry team's drop folder.
      await receives(at, 'helper', '7b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e');
    });
  });
});

describe('a file team keeps the registration it always had', () => {
  test('the load names its file, and the add carries it byte for byte', async () => {
    await underRegistry(async () => {
      const base = temp('team-inbox-file-');
      const home = join(base, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const root = join(base, 'project');
      mkdirSync(join(root, '.agents'), { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
      const teamFile = join(root, '.agents', 'team.yaml');
      writeFileSync(teamFile, teamText('gemini'));

      // The registry holds no record for this root: the file is the definition, and it is named.
      const loaded = readTeamConfig(root, { home });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.source).toBe('team-file');
      expect(launchTeamFile(loaded)).toBe(teamFile);

      const lobby = temp('team-inbox-lobby-');
      const runner = selfRunner();
      const runs: { command: string; args: string[]; cwd: string }[] = [];
      expect(registerInbox({
        cli: 'gemini',
        seat: 'helper',
        cwd: lobby,
        session: loaded.team.session,
        home,
        file: teamFile,
        run: (command, args, runCwd) => {
          runs.push({ command, args: [...args], cwd: runCwd });
          writeTarget('gemini', runCwd);
          return { code: 0 };
        },
      })).toEqual({ ok: true });
      expect(runs).toEqual([{
        command: 'gemini',
        cwd: lobby,
        args: ['mcp', 'add', '-s', 'project', 'team-inbox', runner.command, '--', runner.entry, 'mcp', 'serve', '--seat', 'helper', '--session', 'acme', '--file', teamFile],
      }]);
    });
  });
});
