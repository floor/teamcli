// `remove --keep` and `add` edit a seat stanza of the live file and do not rewrite
// the stored approval. The owner sections — `limits`, `machine`, `delegates` — stay
// as the last approval wrote them. This pins the round trip: approve A, stop a seat
// with --keep, approve B with an owner section changed, add the seat back. The live
// file keeps B's owner sections, and so does the stored approval: the change the
// owner made is not reverted, and nothing the owner retired in B comes back. The
// seat stanza itself may differ from the stored copy; that difference is not a
// refusal. The variant where B is an older file than a delegates entry A carried
// pins the other side: the entry must not resurrect.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { approvalStanding } from '../../src/store/store.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runRemove, type RemoveSources } from '../../src/commands/remove.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import type { DownLaunch } from '../../src/commands/down.ts';
import type { Launch } from '../../src/commands/up.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-15T09:00:00Z');
const IDLE = CLAUDE_IDLE;

let base: string;
let project: string;
let home: string;
const owner = { kind: 'owner' } as const;

// A: the worker runs, the owner sections hold A's values. `delegates` is spliced in
// for the older-B variant; `stopped` marks the worker for the seat-absent variant.
function fileA(extra = ''): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
  base: main
machine:
  swap_free_min: 500MB
limits:
  seats: 6
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${extra}
`;
}

const DELEGATES = `\ndelegates:
  - pane: main/w1:p1
    commands: [up]`;

function approveFile(text: string): void {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  const yaml = text.includes('trust:')
    ? text
    : text.replace('workspace:', `trust:\n  - ~/.config/team/lobby\n  - ${trustPath}\n  - ${join(home, 'worktrees')}\nworkspace:`);
  writeFileSync(join(project, '.agents', 'team.yaml'), yaml);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
    loaded.team.seats,
    home,
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-owner-sections-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', join(base, 'remote.git'));
  git(project, 'push', '-q', '-u', 'origin', 'main');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function record(panes: Record<string, string>): void {
  updateState(join(project, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    for (const [name, pane] of Object.entries(panes)) {
      session.seats[name] = { stage: 'ready', pane };
    }
  });
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

function world(): { launch: Launch; session: 'absent' | 'running' } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  const made = { launch: {} as Launch, session: 'absent' as 'absent' | 'running' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  return made;
}

function addSources(made: ReturnType<typeof world>): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
  };
}

function removeSources(agents: HerdrAgent[]): RemoveSources {
  const launchHost: DownLaunch = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => agents.map((agent) => agent.pane),
    closeWorkspace: () => true,
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => claudeBox(''),
    status: () => 'idle',
    now: () => NOW,
    sleep: async () => {},
    launch: launchHost,
    foreground: () => [],
    shellBack: () => true,
  };
}

const WORKER_AGENT: HerdrAgent = { name: 'worker', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };

function liveText(): string {
  return readFileSync(join(project, '.agents', 'team.yaml'), 'utf8');
}

function storedFile(): string {
  const standing = approvalStanding(project, home);
  if (standing.kind !== 'verified') throw new Error(`the standing is ${standing.kind}`);
  return standing.record.file;
}

// The owner sections of the live file and of the stored approval are B's, not A's:
// the changed ones carry B's values, and nothing B dropped is back.
function expectOwnerSections(text: string, b: string, dropped: string[]): void {
  for (const line of b.split('\n')) {
    if (/^(machine|limits|delegates):/.test(line) || /^\s+(swap_free_min|seats|temporary|vendors|pane|commands):/.test(line)) {
      expect(text, `an owner-section line left the file:\n${text}`).toContain(line);
    }
  }
  for (const gone of dropped) {
    expect(text, `a value the owner retired in B is back:\n${text}`).not.toContain(gone);
  }
}

// Add edits the seat stanza and does not re-sign, so a seat difference is expected.
// An owner section must not be one of the differences.
function ownerSectionsHeld(root: string, storeHome: string): boolean {
  const loaded = loadTeamFile(root, { home: storeHome });
  if (!loaded.ok) return false;
  const differences = approvalDifferences(loaded.team, root, storeHome) ?? [];
  return differences.every((line) => !/^`(limits|machine|delegates|watch|tempo)` changed$/.test(line));
}

describe('remove --keep and add between two approvals', () => {
  test('the owner sections of B survive the add, live and in the stored approval', async () => {
    approveFile(fileA());
    record({ lead: 'lead-pane', worker: 'w1:p1' });
    const stop = testIo(project, owner);
    expect(await runRemove(['worker', '--keep'], stop, removeSources([WORKER_AGENT])), `${stop.out}${stop.err}`).toBe(0);
    expect(liveText()).toContain('stopped: true');
    // The owner edits the live file — the stopped seat stays stopped — and approves B.
    const b = liveText().replace('  seats: 6', '  seats: 32').replace('swap_free_min: 500MB', 'swap_free_min: 250MB');
    expect(b).not.toBe(liveText());
    approveFile(b);
    const add = testIo(project, owner);
    expect(await runAdd(['worker'], add, addSources(world())), `${add.out}${add.err}`).toBe(0);
    expectOwnerSections(liveText(), b, ['  seats: 6', 'swap_free_min: 500MB']);
    expectOwnerSections(storedFile(), b, ['  seats: 6', 'swap_free_min: 500MB']);
    expect(ownerSectionsHeld(project, home)).toBe(true);
  });

  test('a delegates entry A carried stays retired when B is the older file', async () => {
    approveFile(fileA(DELEGATES));
    record({ lead: 'lead-pane', worker: 'w1:p1' });
    const stop = testIo(project, owner);
    expect(await runRemove(['worker', '--keep'], stop, removeSources([WORKER_AGENT])), `${stop.out}${stop.err}`).toBe(0);
    // B is the older file: no delegates section, and the limits change on top of it.
    const split = liveText().replace('  seats: 6', '  seats: 32').split('\ndelegates:\n  - pane: main/w1:p1\n    commands: [up]');
    expect(split.length, `${split}`).toBe(2);
    const b = split[0] ?? '';
    expect(b).not.toContain('delegates:');
    approveFile(b);
    const add = testIo(project, owner);
    expect(await runAdd(['worker'], add, addSources(world())), `${add.out}${add.err}`).toBe(0);
    expectOwnerSections(liveText(), b, ['  seats: 6', 'delegates:', 'main/w1:p1']);
    expectOwnerSections(storedFile(), b, ['  seats: 6', 'delegates:', 'main/w1:p1']);
    expect(ownerSectionsHeld(project, home)).toBe(true);
  });

  test('add does not restore a plain-removed seat from the stored copy of B', async () => {
    // B is approved with the worker in it and the limits changed; a plain remove then
    // takes the stanza out of the live file and re-signs nothing. The stored stanza
    // cannot make the seat eligible for add: it must be declared in the live file.
    const b = fileA().replace('  seats: 6', '  seats: 32');
    approveFile(b);
    record({ lead: 'lead-pane', worker: 'w1:p1' });
    const stop = testIo(project, owner);
    expect(await runRemove(['worker'], stop, removeSources([WORKER_AGENT])), `${stop.out}${stop.err}`).toBe(0);
    expect(liveText()).not.toContain('name: worker');
    const removed = liveText();
    const stored = storedFile();
    expect(stored).toContain('name: worker');
    const add = testIo(project, owner);
    expect(await runAdd(['worker'], add, addSources(world())), `${add.out}${add.err}`).toBe(1);
    expect(add.err).toContain('the file has no seat "worker"');
    expect(liveText()).toBe(removed);
    expect(storedFile()).toBe(stored);
    expectOwnerSections(liveText(), b, ['  seats: 6']);
    expectOwnerSections(storedFile(), b, ['  seats: 6']);
    expect(ownerSectionsHeld(project, home)).toBe(true);
  });

  test('two adds in a row leave the owner sections of B in place', async () => {
    const scribe = `\n  - role: implementer
    name: scribe
    label: scribe
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
    approveFile(fileA(scribe));
    record({ lead: 'lead-pane', worker: 'w1:p1', scribe: 'w2:p1' });
    const stop = testIo(project, owner);
    expect(await runRemove(['worker', '--keep'], stop, removeSources([WORKER_AGENT])), `${stop.out}${stop.err}`).toBe(0);
    // B changes the limits and declares the scribe not yet started, as the owner's
    // file does while seats wait to be added; both adds then edit the live file.
    const live = liveText();
    const launch = '    launch: claude --model claude-opus-5-5\n';
    const at = live.lastIndexOf(launch);
    expect(at).toBeGreaterThan(0);
    const b = (live.slice(0, at + launch.length) + '    stopped: true\n' + live.slice(at + launch.length))
      .replace('  seats: 6', '  seats: 32');
    expect(b.match(/stopped: true/g)?.length, `${b}`).toBe(2);
    approveFile(b);
    const first = testIo(project, owner);
    expect(await runAdd(['worker'], first, addSources(world())), `${first.out}${first.err}`).toBe(0);
    const second = testIo(project, owner);
    expect(await runAdd(['scribe'], second, addSources(world())), `${second.out}${second.err}`).toBe(0);
    expectOwnerSections(liveText(), b, ['  seats: 6']);
    expectOwnerSections(storedFile(), b, ['  seats: 6']);
    expect(ownerSectionsHeld(project, home)).toBe(true);
  });
});
