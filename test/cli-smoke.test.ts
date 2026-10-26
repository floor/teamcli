import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { runApprove } from '../src/approve/command.ts';
import { markerMac, questionDigest, type MarkerBody } from '../src/commands/ask-show.ts';
import { commands } from '../src/cli.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { Io } from '../src/io.ts';
import { COMMAND_OUTPUT_SCHEMAS } from '../src/output/index.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { updateState } from '../src/state.ts';
import { installKey } from '../src/store/keys.ts';
import { assertCleanHumanOutput, assertMatchesOutputSchema } from './helpers/output.ts';

const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const contractPath = fileURLToPath(new URL('../contract/cli.json', import.meta.url));
const fixtureKeyPath = fileURLToPath(new URL('./fixtures/key.json', import.meta.url));

type ContractCommand = {
  name: string;
  hidden: boolean;
};

type ContractCli = {
  commands: ContractCommand[];
};

const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractCli;
const visibleContractNames = contract.commands.filter((c) => !c.hidden).map((c) => c.name);
// Every command in contract/cli.json (plus anything in src/cli.ts's commands table so a newly
// added command cannot escape before contract generation), excluding only the hidden stdin-RPC
// conformance-adapter protocol.
const allCommandNames = Array.from(
  new Set([
    ...contract.commands.filter((c) => c.name !== 'conformance-adapter').map((c) => c.name),
    ...Object.keys(commands),
  ]),
).sort();

/**
 * Commands excused from the read-only `--json` schema smoke pass because they mutate disk/session
 * state, require live tmux/herdr panes or network/Keychain access, or run long-lived daemons.
 */
export const EXCUSED_SIDE_EFFECT_COMMANDS: Record<string, string> = {
  ack: "writes one signed read receipt into the addressee's folder",
  approvals: 'lists or revokes owner-seat always rules under the owner home',
  forget: 'removes a team registry record from the owner home',
  answer: 'types an answer into a live herdr pane dialog',
  archive: 'stops the team as down does and moves its state into an archive folder, with no registered output schema',
  client: 'writes an Ed25519 client key pair into an owner folder and reads no project state',
  'development-mode': 'reads or writes the machine development-mode record, which is an owner setting with no registered output schema',
  'owner-seat': 'status reads the owner seat; setup, profile and serve create keys, prompt for Touch ID or start a local page, with no registered output schema',
  broker: 'starts a long-running local credential broker server on .agents/broker.sock and reads macOS Keychain',
  bus: 'starts a long-running local event bus server on .agents/bus.sock',
  daemon: 'starts the one machine daemon, and installs or removes its user service unit through the system service manager',
  hold: 'mutates .agents/state.json to place or clear a team hold',
  pause: 'writes pause state for one or more teams',
  resume: 'clears pause state for one or more teams',
  raise: "writes one signed owner mailbox record and one event, and rings the owner's notification",
  init: 'writes .agents/team.yaml and registers the project on disk',
  import: "writes this team's configuration record into the registry (~/.config/team/team-config)",
  migrate: "moves this team's .agents/team.yaml into the registry once (~/.config/team/team-config)",
  lock: 'mutates project lock state to acquire a named lock',
  next: 'claims the next open task and writes a local lease at .agents/leases/<id>.json',
  register: 'mutates .agents/state.json to bind a live pane to a seat',
  release: 'makes live network requests to registry.npmjs.org and api.github.com and reads macOS Keychain',
  reload: 'sends reload instructions to a live seat pane',
  remove: 'closes a live seat pane and removes its state entry',
  rename: 'mutates .agents/team.yaml, .agents/team.state.json, and registry records to rename a seat',
  reply: "writes one signed reply record into the answered record's sender's folder",
  restart: 'restarts a live seat CLI process in its herdr pane',
  tempo: 'mutates .agents/state.json to change the watch tempo',
  unlock: 'mutates project lock state to release a named lock',
  watch: 'runs the long-lived watch loop daemon',
};

type ReadOnlySmokeCase = {
  command: string;
  args: string[];
  schemaKey: string;
  expectedSchemaName?: string;
  asSeat?: boolean;
};

const READ_ONLY_SMOKE_CASES: ReadOnlySmokeCase[] = [
  { command: '--about', args: ['--about'], schemaKey: 'team.about' },
  { command: 'status', args: ['status'], schemaKey: 'team.status' },
  { command: 'seats', args: ['seats'], schemaKey: 'team.seats' },
  { command: 'settings', args: ['settings', 'claude-keeper'], schemaKey: 'team.settings' },
  { command: 'seat', args: ['seat', 'claude-keeper'], schemaKey: 'team.seat' },
  { command: 'config', args: ['config', 'keys'], schemaKey: 'team.config-keys' },
  { command: 'sessions', args: ['sessions'], schemaKey: 'team.sessions' },
  { command: 'doctor', args: ['doctor'], schemaKey: 'team.doctor' },
  { command: 'check', args: ['check'], schemaKey: 'team.check' },
  { command: 'list', args: ['list'], schemaKey: 'team.list' },
  { command: 'projects', args: ['projects'], schemaKey: 'team.projects' },
  { command: 'policy', args: ['policy'], schemaKey: 'team.policy' },
  { command: 'proc', args: ['proc', 'list'], schemaKey: 'team.proc' },
  { command: 'issues', args: ['issues'], schemaKey: 'team.issues' },
  { command: 'plan', args: ['plan'], schemaKey: 'team.plan', asSeat: true },
  { command: 'queue', args: ['queue', 'list'], schemaKey: 'team.queue' },
  { command: 'feed', args: ['feed'], schemaKey: 'team.feed' },
  { command: 'messages', args: ['messages'], schemaKey: 'team.messages' },
  { command: 'worktree', args: ['worktree', 'list'], schemaKey: 'team.worktree' },
  { command: 'commits', args: ['commits', 'check', 'HEAD'], schemaKey: 'team.commits' },
  { command: 'pr', args: ['pr', 'check', 'pr-body.md'], schemaKey: 'team.pr' },
  {
    command: 'ask-show',
    args: ['ask-show', 'req-1', '--ask', 'ask.txt', '--marker', 'marker.json', '--key', 'key.txt'],
    schemaKey: 'team.ask-show',
  },
  { command: 'mcp', args: ['mcp', 'status'], schemaKey: 'team.mcp' },
  { command: 'send', args: ['send', '--list'], schemaKey: 'team.send', expectedSchemaName: 'team.send.list' },
  { command: 'usage', args: ['usage'], schemaKey: 'team.usage' },
  { command: 'route', args: ['route', 'claude-keeper', '--dry-run'], schemaKey: 'team.route' },
  { command: 'up', args: ['up', '--dry-run'], schemaKey: 'team.up' },
  { command: 'down', args: ['down', '--dry-run'], schemaKey: 'team.down' },
  { command: 'drops', args: ['drops'], schemaKey: 'team.drops', asSeat: true },
  { command: 'add', args: ['add', 'claude-helper', '--dry-run'], schemaKey: 'team.add' },
  { command: 'grant', args: ['grant', 'claude-keeper', '--scope', 'up', '--dry-run'], schemaKey: 'team.grant' },
  { command: 'delegate', args: ['delegate', 'ext/w1:p1', '--commands', 'add', '--dry-run'], schemaKey: 'team.delegate' },
  { command: 'revoke', args: ['revoke', 'grant', '--dry-run'], schemaKey: 'team.revoke' },
  { command: 'brief', args: ['brief', 'rollout'], schemaKey: 'team.brief' },
  { command: 'swap', args: ['swap'], schemaKey: 'team.swap' },
  { command: 'workflow', args: ['workflow', 'check', 'workflow.yaml'], schemaKey: 'team.workflow' },
];

/** One cold entry into src/cli.ts is a fresh Bun process; a healthy `--help` answers in well
 *  under a second. This per-child deadline names a hung command at its own window, instead of
 *  leaving it to the runner's test timeout, which kills every child still in flight (exit 143). */
const COLD_ENTRY_DEADLINE_MS = 10_000;

/** The batch below launches two cold entries per command through 16 lanes. A 2-vCPU hosted
 *  runner needs more than one 5s test deadline for that many spawns; the per-child deadline
 *  above, not this budget, is what catches a hang. */
const COLD_ENTRY_BATCH_DEADLINE_MS = 30_000;

async function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, COLD_ENTRY_DEADLINE_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(deadline);
  }
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

describe('CLI cold-entry smoke test across every command', () => {
  test('contract/cli.json covers every command in src/cli.ts', () => {
    expect(visibleContractNames.length).toBeGreaterThan(0);
    expect(new Set(visibleContractNames)).toEqual(new Set(Object.keys(commands)));
  });

  test('every command in src/cli.ts is either in READ_ONLY_SMOKE_CASES or EXCUSED_SIDE_EFFECT_COMMANDS', () => {
    const covered = new Set([
      ...READ_ONLY_SMOKE_CASES.filter((c) => c.command !== '--about').map((c) => c.command),
      ...Object.keys(EXCUSED_SIDE_EFFECT_COMMANDS),
    ]);
    expect(covered).toEqual(new Set(Object.keys(commands)));
  });

  test('every command in the contract loads cleanly through src/cli.ts with --help and --json --help', async () => {
    const cases = allCommandNames.flatMap((name) => [
      { name, args: [name, '--help'] },
      { name, args: [name, '--json', '--help'] },
    ]);

    const results = await mapConcurrent(cases, 16, async ({ name, args }) => ({
      name,
      args,
      ...(await runCli(args)),
    }));

    for (const { name, args, code, stdout, stderr, timedOut } of results) {
      expect(timedOut, `${args.join(' ')} finished within ${COLD_ENTRY_DEADLINE_MS}ms`).toBe(false);
      expect(stderr, `${args.join(' ')} stderr`).not.toContain('before initialization');
      expect(stderr, `${args.join(' ')} stderr`).not.toMatch(/^\s*at\s+/m);
      expect(stderr, `${args.join(' ')} stderr`).toBe('');
      expect(code, `${args.join(' ')} exit code`).toBe(0);
      expect(stdout.trim().length, `${args.join(' ')} stdout non-empty`).toBeGreaterThan(0);
      if (name !== 'help') {
        expect(stdout, `${args.join(' ')} usage header`).toMatch(new RegExp(`^Usage: team ${name}\\b`));
      }
    }
  }, COLD_ENTRY_BATCH_DEADLINE_MS);

  test('every read-only command runs in a scratch fixture, validates its --json schema, and prints clean human output', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-cli-smoke-')));
    const home = join(base, 'home');
    const root = join(base, 'beacon');
    const bin = join(base, 'bin');
    mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true, mode: 0o700 });
    chmodSync(join(home, '.config', 'team', 'lobby'), 0o700);
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(bin, { recursive: true });

    try {
      // Minimal herdr and claude shims so commands never touch a real tmux/herdr server or spawn real agent CLIs.
      const herdrShim = join(bin, 'herdr');
      writeFileSync(
        herdrShim,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "herdr 0.7.1"
  exit 0
fi
echo '{"result":{"sessions":[],"agents":[],"workspaces":[],"panes":[]}}'
exit 0
`,
      );
      chmodSync(herdrShim, 0o755);

      const claudeShim = join(bin, 'claude');
      writeFileSync(
        claudeShim,
        `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo '{"loggedIn":true}'
  exit 0
fi
echo "2.1.76 (Claude Code)"
exit 0
`,
      );
      chmodSync(claudeShim, 0o755);

      const teamYaml = `format: 1
project: beacon
coordinator: claude-keeper
operator: claude-keeper

trust:
  - ~/.config/team/lobby
  - ${root}
  - ${join(base, 'worktrees', 'beacon')}

machine:
  load_start: 100
  load_max: 100
  memory_start: 1%
  memory_min: 1%
  disk_min: 1MB
  swap_free_min: 1MB

workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main

tasks:
  source: file
  path: .agents/tasks.yaml

seats:
  - role: coordinator
    name: claude-keeper
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: claude-helper
    label: implementer
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;
      writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml);
      writeFileSync(join(root, '.agents', 'tasks.yaml'), '- id: m1\n  title: verify smoke fixture\n');
      updateState(join(root, '.agents'), (state) => {
        state.sessions.beacon = {
          seats: {
            'claude-keeper': {
              stage: 'ready',
              pane: 'w1:p1',
              launched: { shell: 4000, cli: [4100] },
            },
          },
          worktrees: {},
        };
      });
      writeFileSync(
        join(root, 'pr-body.md'),
        'Summary of changes.\n\nAgent: Claude Opus 5.5 · coordinator\n',
      );
      writeFileSync(
        join(root, 'workflow.yaml'),
        'name: smoke-workflow\nstart: build\nstates:\n  build:\n    run:\n      role: implementer\n      task: verify smoke workflow\n    next:\n      - on: task-done\n        to: done\n  done:\n    end: pass\n',
      );

      // Signed ask-show fixture files.
      const keyBytes = randomBytes(32);
      const question = 'ship the release candidate?';
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const markerBody: MarkerBody = {
        v: 1,
        request_id: 'req-1',
        question_sha256: questionDigest(question),
        expires_at: expiresAt,
      };
      writeFileSync(
        join(root, 'ask.txt'),
        `TeamCLI signed ask v1\n${JSON.stringify({ v: 1, request_id: 'req-1', question, expires_at: expiresAt })}\n`,
      );
      writeFileSync(
        join(root, 'marker.json'),
        JSON.stringify({ ...markerBody, mac: markerMac(keyBytes, markerBody) }),
      );
      const keyFile = join(root, 'key.txt');
      writeFileSync(keyFile, keyBytes.toString('base64url'), { mode: 0o600 });
      chmodSync(keyFile, 0o600);

      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      execFileSync('git', ['config', 'user.name', 'Smoke Test'], { cwd: root });
      execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: root });
      execFileSync('git', ['add', '.agents/team.yaml', '.agents/tasks.yaml'], { cwd: root });
      execFileSync(
        'git',
        ['commit', '-q', '-m', 'feat: initial smoke commit\n\nAgent: Claude Opus 5.5 · coordinator'],
        { cwd: root },
      );

      installKey(home, JSON.parse(readFileSync(fixtureKeyPath, 'utf8')));
      const approveIo: Io = {
        stdout: () => {},
        stderr: () => {},
        cwd: root,
        env: { HOME: home },
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const approveCode = await runApprove([], approveIo, {
        ask: async () => '1',
        waiting: () => 'empty',
        now: () => new Date(),
        home,
      });
      expect(approveCode).toBe(0);

      const loaded = loadTeamFile(root, { home });
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        registerLaunch(
          { home, team: loaded.team, root, by: 'owner', owner: true },
          loaded.team.seats[0]!,
          'w1:p1',
        );
      }

      // Run all read-only smoke cases (both --json and human mode) in a child process whose
      // OS HOME is `home` and PATH leads with `bin` (for the herdr shim).
      const runnerScript = join(base, 'smoke-runner.ts');
      writeFileSync(
        runnerScript,
        `import { main } from ${JSON.stringify(cliEntry)};
import { setHerdrRun } from ${JSON.stringify(fileURLToPath(new URL('../src/herdr.ts', import.meta.url)))};
import type { Io } from ${JSON.stringify(fileURLToPath(new URL('../src/io.ts', import.meta.url)))};

const root = ${JSON.stringify(root)};
const home = ${JSON.stringify(home)};

setHerdrRun(() => ({
  running: true,
  sessions: [{ name: 'beacon', running: true }],
  agents: [
    {
      name: 'claude-keeper',
      agent: 'claude',
      pane_id: 'w1:p1',
      workspace_id: 'w1',
      agent_status: 'idle',
      cwd: root,
      display_agent: 'Claude Opus 5.5',
    },
  ],
  workspaces: [{ workspace_id: 'w1', title: 'Claude Opus 5.5 · coordinator' }],
  panes: [{ pane_id: 'w1:p1' }],
  process_info: {
    shell_pid: 4000,
    foreground_processes: [{ pid: 4100, argv0: 'claude' }],
  },
  pane: { foreground_cwd: root },
  text: '✻ Claude Opus 5.5\\n> ',
}));

const cases = ${JSON.stringify(READ_ONLY_SMOKE_CASES)};

async function invoke(args: string[], asSeat?: boolean) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => { stdout += t; },
    stderr: (t) => { stderr += t; },
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH },
    stdinIsTTY: true,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    caller: asSeat
      ? { kind: 'seat', name: 'claude-keeper', pane: 'w1:p1', session: 'beacon' }
      : { kind: 'owner' },
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

const out: Record<string, { json: { code: number; stdout: string; stderr: string }; human: { code: number; stdout: string; stderr: string } }> = {};
await Promise.all(
  cases.map(async (c: { command: string; args: string[]; asSeat?: boolean }) => {
    const [json, human] = await Promise.all([
      invoke([...c.args, '--json'], c.asSeat),
      invoke(c.args, c.asSeat),
    ]);
    out[c.command] = { json, human };
  }),
);

process.stdout.write(JSON.stringify(out));
`,
      );

      const proc = Bun.spawn([process.execPath, runnerScript], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [rawOut, rawErr, runnerCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(rawErr).toBe('');
      expect(runnerCode).toBe(0);

      const results = JSON.parse(rawOut) as Record<
        string,
        {
          json: { code: number; stdout: string; stderr: string };
          human: { code: number; stdout: string; stderr: string };
        }
      >;

      for (const smokeCase of READ_ONLY_SMOKE_CASES) {
        const entry = results[smokeCase.command];
        expect(entry, `missing result for ${smokeCase.command}`).toBeDefined();
        const spec = COMMAND_OUTPUT_SCHEMAS.find((s) => s.name === smokeCase.schemaKey);
        expect(spec, `missing schema spec for ${smokeCase.schemaKey}`).toBeDefined();
        const parsed = assertMatchesOutputSchema<{ schema: { name: string; version: number } }>(
          entry!.json.stdout,
          spec!,
        );
        expect(parsed.schema.name, `${smokeCase.command} --json schema.name`).toBe(
          smokeCase.expectedSchemaName ?? smokeCase.schemaKey,
        );
        expect(entry!.json.stderr, `${smokeCase.command} --json stderr`).toBe('');

        const humanCombined = `${entry!.human.stdout}${entry!.human.stderr}`;
        expect(humanCombined.trim().length, `${smokeCase.command} human non-empty`).toBeGreaterThan(0);
        assertCleanHumanOutput(humanCombined, { home });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 15_000);
});
