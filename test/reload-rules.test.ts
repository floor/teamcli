// A message seat's rules file is a launch input: when it no longer holds the live text,
// `team reload` closes the seat and launches it again with the rules delivered, so the repair
// `team check` names actually leaves the check clean. The seat is a gemini seat (its rules
// travel as the first message, never as a launch option) with no model in its record — the
// live case: the record is filled from the screen, which matches, while the rules file is stale.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, type ReloadSources } from '../src/commands/reload.ts';
import { rulesFileDifferences } from '../src/commands/status.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { rulesFilePath } from '../src/launch/rules-file.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import type { Launch } from '../src/commands/up.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const OWNER = { kind: 'owner' as const };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/gemini/0.64.0/${name}.txt`, import.meta.url), 'utf8');
const GEMINI_IDLE = fixture('idle');
const GEMINI_ACCEPTED = fixture('rules-accepted');

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function teamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    effort: high
    mode: shared
    cwd: .
  - role: implementer
    name: worker
    label: worker
    cli: gemini
    vendor: google
    model: Gemini Pro
    version: "3"
    launch: gemini -m gemini-3-pro
    mode: shared
    cwd: .
`;
}

function approve(): void {
  const path = join(dir, 'team.yaml');
  const text = teamYaml();
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

/** A ready launch record from before the record kept a model: ready, on its pane, no model. */
function forget(name: string): void {
  updateState(dir, (file) => {
    (file.sessions.alpha ??= emptySession()).seats[name] = {
      stage: 'ready', pane: `${name}-pane`, workspace: `${name}-ws`, launched: { shell: 1, cli: [2] },
    };
  });
}

/** The idle composer with `line` typed into it: the placeholder row replaced by the prompt row
 *  and continuation rows at column 3, as the 0.64.0 capture draws a typed line. Chunks are 47
 *  characters — the width between column 3 and the box's closing rule. */
function geminiTyped(line: string): string {
  const rows: string[] = [];
  for (let at = 0; at < line.length; at += 47) rows.push(line.slice(at, at + 47));
  const [first = '', ...rest] = rows;
  const box = [` * ${first}`, ...rest.map((row) => `   ${row}`)].join('\n');
  return GEMINI_IDLE.replace(' *   Type your message or @path/to/file', box);
}

function harness(): { sources: ReloadSources; closed: string[]; commands: string[] } {
  const panes = new Map<string, string>([['worker-pane', GEMINI_IDLE]]);
  const closed: string[] = [];
  const commands: string[] = [];
  let clock = NOW.getTime();
  let status = 'idle';
  let n = 0;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, GEMINI_IDLE);
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane, command) {
      commands.push(command);
      panes.set(pane, GEMINI_IDLE);
      status = 'idle';
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [
      { name: 'worker', agent: 'gemini', pane: 'worker-pane', workspace: 'worker-ws', status, cwd: null },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText: (_session, pane) => panes.get(pane) ?? null,
    typeText(_session, pane, text) {
      panes.set(pane, geminiTyped(text));
      return true;
    },
    pressEnter(_session, pane) {
      panes.set(pane, GEMINI_ACCEPTED);
      status = 'working';
      return true;
    },
    agentStatus: () => status,
    foreground: () => ['gemini'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { sources: { launch, home, now: () => new Date(clock) }, closed, commands };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-rules-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team reload and a drifted rules file', () => {
  test('an unrecorded seat whose rules file drifted is reloaded, and the check is clean after', async () => {
    forget('worker');
    // The stale file: right place, right mode, older text — what an edited team file leaves.
    const store = storePath('acme', root, home);
    const rules = join(store, 'rules');
    mkdirSync(rules, { recursive: true, mode: 0o700 });
    chmodSync(rules, 0o700);
    const path = rulesFilePath('acme', root, home, 'worker');
    if (path === null) throw new Error('worker has no rules path');
    writeFileSync(path, 'older rules\n', { mode: 0o600 });

    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('verified');
    const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const before = rulesFileDifferences(standing, loaded.team, loaded.root, home);
    expect(before.map((row) => row.what)).toEqual(["worker: its rules file differs from the team file's rules"]);
    expect(before[0]?.repair).toBe('team reload worker');

    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err }).toEqual({ code: 0, err: '' });
    expect(closed).toEqual(['worker-ws']);
    expect(io.out).toContain("its rules file differs from the team file's rules");
    // The repair the check named leaves the check with nothing to say: the file holds the live
    // text, and the seat is recorded with the model its screen showed.
    expect(rulesFileDifferences(standing, loaded.team, loaded.root, home)).toEqual([]);
    const seat = loaded.team.seats.find((item) => item.name === 'worker');
    if (!seat) throw new Error('worker gone');
    expect(readFileSync(path, 'utf8')).toBe(rulesOf(loaded.team, seat, loaded.root));
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ stage: 'ready', model: 'Gemini Pro', version: '3' });
  });
});
