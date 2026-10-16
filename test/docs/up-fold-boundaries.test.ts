// The up fold's admission story. The pages now say one word answers every caller the run does
// not admit — a real run and a dry run alike, stderr the four characters `deny`, stdout empty,
// no plan — while the granted seat keeps its own refusal words for the owner's flags. The first
// test drives the real command for the word itself; the rest hold each page to its sentences and
// each sentence to the source that prints it, so no page can claim a refusal the code does not
// give, and no row can name an exit id or a CLI variant the source never wrote.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');

// The pages' own sentences, as written. Whitespace runs collapse before the match.
const UP_PAGE = '../../docs/commands/up.md';
const UP_LONG = '../../docs/internal/up.md';
const DOWN_LONG = '../../docs/internal/down.md';
const TEAM_FILE_PAGE = '../../docs/team-file.md';
const UP_SRC = '../../src/commands/up.ts';
const DOWN_SRC = '../../src/commands/down.ts';
const PRETRUST_SRC = '../../src/launch/pretrust.ts';

const ADMIT_ROW =
  'a caller the run does not admit | a real run and a `--dry-run` are answered alike, with the one word `deny` on stderr and nothing on stdout — no reason, and no plan — and exit 1';
const ADMIT_EXIT_ROW =
  'a caller the run does not admit | `deny`, and nothing else: no `team up:` prefix, no reason, no plan | 1';
const GRANTED_ROW =
  "the orchestrator's seat, when the file's `grant` lists `up` | run it on this folder's own team file. The run does not relaunch or close that seat. `--session` and `--file` are refused before either is read";
const ADMIT_CONSOLE =
  '$ team up --file other.yaml ; echo "exit $?" deny exit 1 $ team up --dry-run --file other.yaml ; echo "exit $?" deny exit 1';
const FLAG_ROW =
  "``--<flag> is the owner's; the granted seat cannot use it`` — the granted seat, for `--session` and `--file`, refused before the file or the session the flag names is read";
const DENY_ROW_WHO =
  'a caller `up` does not admit: not the owner, not a pane the file\'s `delegates` names with `up`, and not the seat the file\'s `grant` names for it';
const DENY_ROW_SHAPE =
  'Stderr is the four characters `deny` and a newline — no `team up:` prefix, no reason — and stdout is empty; a `--dry-run` by that caller is the same reply and prints no plan';
const DENY_ROW_SWALLOW = 'their ids all exit through this word';
const LOBBY_TEMPLATE =
  'left out: refused: the lobby is not trusted for <cli>: run <cli> in <lobby> and accept the folder';
const LOBBY_GROK_CURSOR =
  'A `grok` or `cursor` seat is told its own flag instead (`run grok --trust in <lobby>`, `run cursor-agent --trust in <lobby>`)';
const DOWN_ROW =
  "the file has a `grant` and the orchestrator's own seat ran `down`: one of `down.grant-approval`, `down.grant-approved-copy`, `down.grant-drift`, `down.grant-scope`";
const TEAM_FILE_SENTENCE =
  "`team up` admits the orchestrator's seat when the file's `grant` lists `up`";

// The source's own words, which the pages paraphrase only at their peril.
const UP_DENY_PRINT = "out.stderr('deny\\n')";
const UP_FLAG_PRINT = "--${flag} is the owner's; the granted seat cannot use it";
const DOWN_GRANT_IDS = [
  '// exit: down.grant-approval',
  '// exit: down.grant-approved-copy',
  '// exit: down.grant-drift',
  '// exit: down.grant-scope',
];
const PRETRUST_CLAUDE = 'the lobby is not trusted for claude: run claude in ${lobby} and accept the folder';
const PRETRUST_GROK = 'the lobby is not trusted for grok: run grok --trust in ${lobby}';
const PRETRUST_CURSOR = 'the lobby is not trusted for cursor: run cursor-agent --trust in ${lobby}';

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
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string, extra: string[] = []): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra,
  ].join('\n');
}

/** The fixture team file: the grant names the lead seat, and the caller of every scene below is
 *  the worker — a seat of the session the grant does not name. */
function teamText(): string {
  return `format: 1
project: acme
coordinator: lead
operator: pilot
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seat('pilot', 'operator', ['    count: 1'])}
${seat('worker', 'implementer', ['    count: 1'])}
grant:
  session: alpha
  seat: lead
  scope:
    - up
    - down
`;
}

function approve(text: string): void {
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function record(): void {
  updateState(dir, (file) => {
    file.sessions.alpha = {
      ...emptySession(),
      seats: {
        lead: { stage: 'ready', pane: 'lead-pane', workspace: 'lead-ws' },
        pilot: { stage: 'ready', pane: 'pilot-pane', workspace: 'pilot-ws' },
        worker: { stage: 'ready', pane: 'worker-pane', workspace: 'worker-ws' },
      },
    };
  });
}

/** The worker's own terminal: the real placement walk, with the worker's process chain
 *  descending from its pane's root and alpha's list naming every pane. */
function workerIo(): ReturnType<typeof testIo> {
  const io = testIo(root);
  io.env = { HERDR_PANE_ID: 'worker-pane' };
  io.callerSources = (session: string | undefined) => ({
    ancestors: () => [{ pid: 1, name: 'herdr' }, { pid: 300, name: 'step-300' }],
    agents: () => session === undefined ? [] : [
      { pane: 'lead-pane', name: 'lead', agent: null, workspace: '', status: '', cwd: null },
      { pane: 'pilot-pane', name: 'pilot', agent: null, workspace: '', status: '', cwd: null },
      { pane: 'worker-pane', name: 'worker', agent: null, workspace: '', status: '', cwd: null },
    ],
    paneRootPid: (pane: string) =>
      session !== undefined && pane === 'worker-pane' ? 300 : session !== undefined && pane === 'lead-pane' ? 100 : null,
    env: io.env,
    stdinIsTTY: false,
  });
  return io;
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

/** A launch whose every effect is recorded, so a denied scene can prove it had none. */
function upTrace(): { sources: UpSources; made: () => number; closed: () => number; audits: () => number } {
  let made = 0;
  let closed = 0;
  let audits = 0;
  const launch: Launch = {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      made += 1;
      return { pane: `made-${made}`, workspace: `ws-${made}` };
    },
    paneRun: () => true,
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace() {
      closed += 1;
      return true;
    },
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: UpSources = {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    doctor: doctor(),
    launch,
    now: () => NOW,
    logGranted() {
      audits += 1;
    },
  };
  return { sources, made: () => made, closed: () => closed, audits: () => audits };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-fold-b-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const text = teamText();
  writeFileSync(join(dir, 'team.yaml'), text);
  approve(text);
  record();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('the up fold: one word for the unadmitted caller', () => {
  test('a real run and a dry run are answered alike: deny on stderr, nothing on stdout, no effect', async () => {
    const { sources, made, closed, audits } = upTrace();
    const cases: string[][] = [
      [],
      ['--dry-run'],
      ['--file', 'no-such-file.yaml'],
      ['--dry-run', '--file', 'no-such-file.yaml'],
    ];
    for (const argv of cases) {
      const io = workerIo();
      const code = await runUp(argv, io, sources);
      expect(code, `up ${argv.join(' ') || '(plain)'} by the worker`).toBe(1);
      expect(io.err, `up ${argv.join(' ') || '(plain)'} stderr`).toBe('deny\n');
      expect(io.out, `up ${argv.join(' ') || '(plain)'} prints no plan`).toBe('');
    }
    expect(made()).toBe(0);
    expect(closed()).toBe(0);
    expect(audits()).toBe(0);
  });

  test('the up pages carry the admission rows, the console pair and the granted seat\'s own words', () => {
    const page = prose(UP_PAGE);
    expect(page.includes(ADMIT_ROW), 'up.md lost the unadmitted-caller row').toBe(true);
    expect(page.includes(ADMIT_EXIT_ROW), 'up.md lost the deny exit row').toBe(true);
    expect(page.includes(GRANTED_ROW), 'up.md lost the granted seat\'s row, or its grant is no longer the file\'s').toBe(true);
    expect(page.includes(ADMIT_CONSOLE), 'up.md lost the deny console pair, real and dry').toBe(true);
  });

  test('the long reads carry the flag row, the deny row and the lobby-trust left-out row', () => {
    const up = prose(UP_LONG);
    expect(up.includes(FLAG_ROW), 'internal/up.md lost the granted seat\'s flag refusal row').toBe(true);
    expect(up.includes(DENY_ROW_WHO), 'internal/up.md lost the deny row\'s who').toBe(true);
    expect(up.includes(DENY_ROW_SHAPE), 'internal/up.md lost the deny row\'s shape: four characters, no prefix, no plan on a dry run').toBe(true);
    expect(up.includes(DENY_ROW_SWALLOW), 'internal/up.md lost the sentence that the old refusal ids exit through this word').toBe(true);
    expect(up.includes(LOBBY_TEMPLATE), 'internal/up.md lost the lobby-trust left-out template').toBe(true);
    expect(up.includes(LOBBY_GROK_CURSOR), 'internal/up.md lost the grok and cursor flag variants').toBe(true);
    const down = prose(DOWN_LONG);
    expect(down.includes(DOWN_ROW), 'internal/down.md lost the grant gate row with its four ids').toBe(true);
    const teamFile = prose(TEAM_FILE_PAGE);
    expect(teamFile.includes(TEAM_FILE_SENTENCE), 'team-file.md no longer reads the admission from the file\'s grant').toBe(true);
  });

  test('every sentence names a refusal the source really prints', () => {
    const up = raw(UP_SRC);
    expect(up.includes(UP_DENY_PRINT), 'up.ts no longer prints the bare word').toBe(true);
    expect(up.includes(UP_FLAG_PRINT), 'up.ts no longer prints the granted seat\'s flag refusal').toBe(true);
    const down = raw(DOWN_SRC);
    for (const id of DOWN_GRANT_IDS) {
      expect(down.includes(id), `down.ts lost the exit id ${id}`).toBe(true);
    }
    const pretrust = raw(PRETRUST_SRC);
    expect(pretrust.includes(PRETRUST_CLAUDE), 'pretrust.ts lost the claude trust sentence').toBe(true);
    expect(pretrust.includes(PRETRUST_GROK), 'pretrust.ts lost the grok flag sentence').toBe(true);
    expect(pretrust.includes(PRETRUST_CURSOR), 'pretrust.ts lost the cursor flag sentence').toBe(true);
  });
});
