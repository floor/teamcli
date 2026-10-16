// The reload page's stopped rule, held to the command that enforces it. The page says a seat
// the file marks `stopped: true` is refused the same way as an unrecorded one, however far
// the file has drifted from the record: exit 1, nothing closed and no log line. These pins
// hold the sentence to the page, hold it to the line that enforces it — the stopped flag
// standing first in the no-ready-pane condition, ahead of the drift check — and drive the
// members no other scene does: the exact refusal bytes beside a live idle pane with the drift
// the seat would otherwise be closed for, the stopped seat whose record matches the file and
// is refused where an unstopped one is told it already runs what the file declares, and the
// not-recorded seat that answers with the same bytes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../../src/commands/reload.ts';
import type { Launch } from '../../src/commands/up.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const REFUSAL = 'team reload: worker has no ready pane to close\n';

const PAGE = '../../docs/commands/reload.md';
const SRC = '../../src/commands/reload.ts';

// The page's stopped rule and the sentences it stands between.
const STOPPED_RULE =
  'So is a seat the file marks `stopped: true`, however far the file has drifted from the record: exit 1, nothing closed and no log line.';
const SAME_WAY = 'is refused the same way';
const NEXT_LAUNCH = 'The next launch that reaches an idle prompt writes the record, and a later reload can read it.';

// The source that enforces it: the stopped flag first in the no-ready-pane condition, the one
// message that condition prints, and the drift check the refusal stands before.
const SRC_CONDITION = 'seat.stopped || !recorded || recorded.stage !== \'ready\'';
const SRC_MESSAGE = 'team reload: ${seat.name} has no ready pane to close';
const SRC_DRIFT = 'const detail = driftOf(recorded, seat);';

function prose(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

function raw(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

let base: string;
let root: string;
let dir: string;
let home: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
  });
}

// The worker with its effort line and stopping flag optional: the scenes rewrite the file the
// record was launched from.
function worker(options: { effort?: string; stopped?: boolean } = {}): string {
  return [
    '  - role: implementer',
    '    name: worker',
    '    label: worker',
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...(options.effort ? [`    effort: ${options.effort}`] : []),
    ...(options.stopped ? ['    stopped: true'] : []),
    '    mode: shared',
    '    cwd: .',
  ].join('\n');
}

const LEAD = [
  '  - role: coordinator',
  '    name: lead',
  '    label: lead',
  '    cli: claude-code',
  '    vendor: anthropic',
  '    model: Claude Opus',
  '    version: "5.5"',
  '    launch: claude --model claude-opus-5-5',
  '    effort: high',
  '    mode: shared',
  '    cwd: .',
].join('\n');

function teamYaml(workerSeat: ReturnType<typeof worker>): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${join(home, '.config', 'team', 'lobby')}
  - ${root}
workspace:
  mode: shared
seats:
${LEAD}
${workerSeat}
`;
}

function approve(text: string): void {
  const path = join(dir, 'team.yaml');
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function remember(name: string, effort: string | undefined): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.seats[name] = {
      stage: 'ready',
      pane: `${name}-pane`,
      workspace: `${name}-ws`,
      cli: 'claude-code',
      launched: { shell: 1, cli: [2] },
      model: 'Claude Opus',
      version: '5.5',
      launch_line: 'claude --model claude-opus-5-5',
      ...(effort === undefined ? {} : { effort }),
    };
  });
}

function logText(): string {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

function harness(): { sources: ReloadSources; closed: string[]; commands: string[] } {
  const panes = new Map<string, string>();
  const closed: string[] = [];
  const commands: string[] = [];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      const pane = 'made-1';
      panes.set(pane, IDLE);
      return { pane, workspace: 'ws-1' };
    },
    paneRun(_session, pane, command) {
      commands.push(command);
      panes.set(pane, IDLE);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
    ] satisfies HerdrAgent[],
    workspacePanes: (_session, workspace) => [workspace === 'worker-ws' ? 'worker-pane' : 'lead-pane'],
    paneText: (_session, pane) => panes.get(pane) ?? IDLE,
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async () => {},
    now: () => NOW,
  };
  return { sources: { launch, home, now: () => NOW }, closed, commands };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-stopped-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  chmodSync(join(home, '.config', 'team', 'lobby'), 0o700);
  mkdirSync(dir, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve(teamYaml(worker({ effort: 'high' })));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the reload page\'s stopped rule', () => {
  test('the stopped sentence stands as written, between the refusal it shares and the record it defers to', () => {
    const page = prose(PAGE);
    expect(page.includes(STOPPED_RULE), 'the page lost its stopped rule').toBe(true);
    expect(page.includes(SAME_WAY), 'the page lost the not-recorded refusal the stopped rule extends').toBe(true);
    expect(page.includes(NEXT_LAUNCH), 'the page lost the sentence that follows the stopped rule').toBe(true);
  });

  test('the stopped flag stands first in the condition that prints one message for both refusals', () => {
    const src = raw(SRC);
    expect(src.includes(SRC_CONDITION), 'the stopped flag no longer leads the no-ready-pane condition').toBe(true);
    expect(src.includes(SRC_MESSAGE), 'the shared no-ready-pane message moved').toBe(true);
    expect(src.includes(SRC_DRIFT), 'the drift check moved').toBe(true);
  });

  test('a stopped seat with a live idle pane and the drift to close for is refused, closed nothing, launched nothing', async () => {
    approve(teamYaml(worker({ effort: 'high', stopped: true })));
    remember('worker', 'low');
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    expect(await runReload(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe(REFUSAL);
    expect(io.out).toBe('');
    expect(closed).toEqual([]);
    expect(commands).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test('a stopped seat whose record matches the file is refused all the same, not told it already runs it', async () => {
    approve(teamYaml(worker({ effort: 'high', stopped: true })));
    remember('worker', 'high');
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    expect(await runReload(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe(REFUSAL);
    expect(io.out).not.toContain('already running what the file declares');
    expect(closed).toEqual([]);
    expect(commands).toEqual([]);
  });

  test('an unrecorded seat and a stopped one answer with the same bytes', async () => {
    // Unstopped and never recorded: the refusal the page says the stopped rule shares.
    const unrecorded = harness();
    const ioUnrecorded = testIo(root, OWNER);
    expect(await runReload(['worker'], ioUnrecorded, unrecorded.sources)).toBe(1);
    expect(ioUnrecorded.err).toBe(REFUSAL);
    // Stopped with no record at all: the file has drifted as far as it can.
    approve(teamYaml(worker({ effort: 'high', stopped: true })));
    const stopped = harness();
    const ioStopped = testIo(root, OWNER);
    expect(await runReload(['worker'], ioStopped, stopped.sources)).toBe(1);
    expect(ioStopped.err).toBe(ioUnrecorded.err);
    expect(stopped.closed).toEqual([]);
  });
});
