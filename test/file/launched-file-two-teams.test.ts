// Two teams that share one pane id keep the file each was launched from: the pointer names
// the session and the pane, so neither launch overwrites the other, and a caller is handed
// a file only for a session it is placed in on that pane. A pointer written when the key was
// the pane id alone still serves its own team and no other. The last row drives `down`
// itself: a stopped team forgets its own pointer and leaves the other team's alone.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runDown, type DownLaunch, type DownSources } from '../../src/commands/down.ts';
import { launchedTeamFile, noteLaunchedPane } from '../../src/file/launched-file.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { installKey } from '../../src/store/keys.ts';
import { storesFolder } from '../../src/store/store.ts';
import { emptySession, updateState, type SeatState } from '../../src/state.ts';
import type { CallerSources } from '../../src/caller.ts';
import type { Io } from '../../src/io.ts';
import { claudeBox, testIo } from '../helpers.ts';

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' as const };
const NOW = new Date('2026-10-13T13:00:00Z');
// One pane id both teams hold a seat on; the ids here are fixtures, never a live pane.
const PANE = 'w7:q9';

let base: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-two-panes-')));
  home = join(base, 'home');
  mkdirSync(home);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function paneStore(): string {
  return join(storesFolder(home), 'panes');
}

/** A team whose state carries one launched session with one seat on the shared pane. */
function teamDir(name: string, session: string): { file: string } {
  const root = join(base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, 'format: 1\n');
  writeFileSync(
    join(root, '.agents', 'team.state.json'),
    `${JSON.stringify({
      format: 1,
      sessions: {
        [session]: {
          seats: { lead: { stage: 'ready', pane: PANE } },
          worktrees: {},
          launched_file: file,
        },
      },
    })}\n`,
  );
  return { file };
}

/** A pointer in the shape written before the session joined the key. */
function oldPointer(file: string): void {
  const dir = paneStore();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, encodeURIComponent(PANE)), `${file}\n`, { mode: 0o600 });
}

function placedIn(): CallerSources {
  return {
    ancestors: () => [{ pid: 10, name: 'zsh' }, { pid: 2, name: 'herdr' }, { pid: 1, name: 'launchd' }],
    agents: () => [{ name: 'lead', agent: 'claude', pane: PANE, workspace: 'ws-0', status: 'idle', cwd: null }],
    paneRootPid: (id) => (id === PANE ? 10 : null),
    env: {},
    stdinIsTTY: true,
  };
}

function outside(): CallerSources {
  return {
    ancestors: () => [{ pid: 10, name: 'zsh' }, { pid: 1, name: 'launchd' }],
    agents: () => [],
    paneRootPid: () => null,
    env: {},
    stdinIsTTY: true,
  };
}

/** A caller the walk places on the shared pane, and in the given sessions and no others. */
function ioIn(sessions: string[]): Pick<Io, 'env' | 'stdinIsTTY' | 'callerSources'> {
  return {
    env: {},
    stdinIsTTY: true,
    callerSources: (session: string | undefined) =>
      session === undefined || sessions.includes(session) ? placedIn() : outside(),
  };
}

describe('two teams that share one pane id', () => {
  test('each team resolves the file it was launched from', () => {
    const first = teamDir('first-root', 'first');
    const second = teamDir('second-root', 'second');
    noteLaunchedPane(home, first.file, PANE, 'first');
    noteLaunchedPane(home, second.file, PANE, 'second');
    expect(launchedTeamFile(ioIn(['first']), home)).toBe(first.file);
    expect(launchedTeamFile(ioIn(['second']), home)).toBe(second.file);
  });

  test('a caller placed in neither session is given no file', () => {
    const first = teamDir('first-root', 'first');
    const second = teamDir('second-root', 'second');
    noteLaunchedPane(home, first.file, PANE, 'first');
    noteLaunchedPane(home, second.file, PANE, 'second');
    expect(launchedTeamFile(ioIn([]), home)).toBeUndefined();
  });

  test('a pointer stored under the pane id alone serves its own team and no other', () => {
    const first = teamDir('first-root', 'first');
    teamDir('second-root', 'second');
    oldPointer(first.file);
    expect(launchedTeamFile(ioIn(['first']), home)).toBe(first.file);
    expect(launchedTeamFile(ioIn(['second']), home)).toBeUndefined();
  });

  test("the second team's launch no longer overwrites the first's pointer", () => {
    const first = teamDir('first-root', 'first');
    const second = teamDir('second-root', 'second');
    noteLaunchedPane(home, first.file, PANE, 'first');
    noteLaunchedPane(home, second.file, PANE, 'second');
    const dir = paneStore();
    const keys = readdirSync(dir);
    expect(keys).toHaveLength(2);
    expect(readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8').trim()).sort())
      .toEqual([first.file, second.file].sort());
    expect(launchedTeamFile(ioIn(['first']), home)).toBe(first.file);
  });
});

describe('down over one of the two teams', () => {
  let secondRoot: string;

  beforeEach(async () => {
    secondRoot = join(base, 'second-root');
    mkdirSync(join(secondRoot, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: secondRoot, stdio: 'ignore' });
    installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
    writeFileSync(join(secondRoot, '.agents/team.yaml'), EXAMPLE);
    const approved = await runApprove(FILE, testIo(secondRoot, OWNER), {
      ask: async () => '5',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    expect(approved).toBe(0);
  });

  test('a stopped team forgets only its own pointer', async () => {
    const first = teamDir('first-root', 'first');
    const secondFile = join(secondRoot, '.agents/team.yaml');
    const seat: SeatState = {
      stage: 'launched',
      pane: PANE,
      workspace: 'ws-7',
      waiting: { state: 'waiting-owner', classification: 'trust' },
    };
    updateState(join(secondRoot, '.agents'), (file) => {
      file.sessions['acme-web'] = { ...emptySession(), seats: { 'deepseek-acme': seat } };
    });
    noteLaunchedPane(home, first.file, PANE, 'first');
    noteLaunchedPane(home, secondFile, PANE, 'acme-web');
    expect(readdirSync(paneStore())).toHaveLength(2);

    const agent: HerdrAgent = { name: 'deepseek-acme', agent: 'claude', pane: PANE, workspace: 'ws-7', status: 'idle', cwd: null };
    // The pane is asked to exit and answers: the box carries what is typed, the CLI is the
    // foreground process until the Enter, and the close follows.
    let sent = false;
    let box = claudeBox('');
    const closed: string[] = [];
    let stopped = false;
    const launch: DownLaunch = {
      typeText: (_session, _pane, text) => {
        box = claudeBox(text);
        return true;
      },
      sendKey: (_session, _pane) => {
        box = claudeBox('');
        return true;
      },
      pressEnter: () => {
        sent = true;
        return true;
      },
      agentPanes: () => (closed.length === 0 ? [PANE] : []),
      closeWorkspace: (_session, workspace) => {
        closed.push(workspace);
        return true;
      },
      stopSession: () => {
        stopped = true;
        return true;
      },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: DownSources = {
      sessionRunning: () => !stopped,
      agents: () => (closed.length === 0 ? [agent] : []),
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => box,
      status: () => 'idle',
      foreground: () => (sent ? [] : ['claude']),
      now: () => NOW,
      home,
      launch,
    };
    const io = testIo(secondRoot, OWNER);
    const code = await runDown([...FILE], io, sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['ws-7']);
    expect(io.out).toContain('stopped and cleared');

    // The stopped team's pointer went with it; the other team's is untouched and still resolves.
    expect(readdirSync(paneStore())).toEqual([encodeURIComponent(`first\0${PANE}`)]);
    expect(launchedTeamFile(ioIn(['first']), home)).toBe(first.file);
  });
});
