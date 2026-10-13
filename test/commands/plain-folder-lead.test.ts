// A lead whose pane starts in the lobby, with the team file in a folder that is not a git
// repository. `up` records that file. The lead's later command resolves it from the record.
// `--file` stays the owner's.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runAnswer, type AnswerHost } from '../../src/commands/answer.ts';
import { runDown, type DownSources } from '../../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { NOT_A_REPO } from '../../src/file/load.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { readState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-12T21:00:00Z');
const SESSION = 'acme-web';
const OTHER = 'other-web';
const LEAD = 'claude-coordinator-acme';

let base: string;

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function fresh(): { home: string; lobby: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-plain-lead-')));
  const home = join(base, 'home');
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  return { home, lobby };
}

function teamText(root: string, session: string, project: string): string {
  return `format: 1
project: ${project}
session: ${session}
coordinator: ${LEAD}
operator: claude-operator-acme
workspace:
  mode: shared
  base: main
trust:
  - ~/.config/team/lobby
  - ${root}
watch:
  interval: 120s
  checks:
    extra: off
    team-idle: off
    load: off
    memory: off
    disk: off
    swap-free: off
    swap-growth: off
    budget: off
    idle: off
    unsent: off
    restored: off
seats:
  - role: coordinator
    name: ${LEAD}
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: operator
    name: claude-operator-acme
    label: operator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

function approve(home: string, root: string, text: string): string {
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
  return file;
}

function world(prefix: string): Launch {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let session: 'absent' | 'running' = 'absent';
  let n = 0;
  let clock = NOW.getTime();
  return {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `${prefix}${n}:p1`;
      panes.set(pane, { text: IDLE, agent: false });
      return { pane, workspace: `${prefix}${n}` };
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
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
}

function doctor(home: string): DoctorSources {
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

function upSources(home: string, launch: Launch): UpSources {
  return {
    sessionRunning: () => launch.sessionUp(''),
    agents: () => [],
    home,
    getuid: () => process.getuid?.() ?? 0,
    now: launch.now,
    sleep: launch.sleep,
    doctor: doctor(home),
    launch,
  };
}

async function bringUp(home: string, root: string, text: string, prefix: string): Promise<{ file: string; pane: string }> {
  const file = approve(home, root, text);
  const io = testIo(root, { kind: 'owner' });
  const code = await runUp(['--file', '.agents/team.yaml'], io, upSources(home, world(prefix)));
  expect(code, io.out + io.err).toBe(0);
  const session = readState(join(root, '.agents')).sessions[text.includes(`session: ${OTHER}`) ? OTHER : SESSION];
  const pane = session?.seats[LEAD]?.pane;
  expect(pane, io.out + io.err).toBeTruthy();
  return { file, pane: pane as string };
}

describe('a lead in the lobby of a plain folder', () => {
  test('up records the file, and the lead runs add and down from the lobby with no flag', async () => {
    const { home, lobby } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    const { file, pane } = await bringUp(home, root, teamText(root, SESSION, 'acme'), 'w');
    const state = readState(join(root, '.agents')).sessions[SESSION];
    expect(state?.launched_file).toBe(file);

    const lead = { kind: 'seat' as const, name: LEAD, pane, session: SESSION };
    const added = testIo(lobby, lead);
    const addCode = await runAdd(['claude-operator-acme'], added, {
      home,
      sessionState: () => 'running',
      agents: () => [{ name: LEAD, agent: null, pane, workspace: 'w1', status: 'idle', cwd: lobby }],
      workspaces: () => [],
      doctor: doctor(home),
      now: () => NOW,
      launch: world('n'),
    } satisfies AddSources);
    expect(added.err).not.toContain(NOT_A_REPO);
    expect(addCode).not.toBe(2);

    const down = testIo(lobby, lead);
    const downCode = await runDown([], down, {
      sessionRunning: () => true,
      agents: () => [{ name: LEAD, agent: null, pane, workspace: 'w1', status: 'idle', cwd: lobby }],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => ['claude'],
      now: () => NOW,
      sleep: async () => {},
      home,
      launch: {
        typeText: () => true,
        sendKey: () => true,
        pressEnter: () => true,
        agentPanes: () => [pane],
        closeWorkspace: () => true,
        stopSession: () => true,
        deleteSession: () => true,
        kill: () => true,
        sleep: async () => {},
        now: () => NOW,
      },
    } satisfies DownSources);
    expect(down.err).not.toContain(NOT_A_REPO);
    expect(downCode).not.toBe(2);
  });

  test("a lead's --file is still the owner's, and the other project is not opened", async () => {
    const { home, lobby } = fresh();
    const root = join(base, 'acme');
    const other = join(base, 'other');
    mkdirSync(root);
    mkdirSync(join(other, '.agents'), { recursive: true });
    const otherFile = join(other, '.agents', 'team.yaml');
    writeFileSync(otherFile, 'format: 1\nproject: other\n');
    const { pane } = await bringUp(home, root, teamText(root, SESSION, 'acme'), 'w');
    const lead = { kind: 'seat' as const, name: LEAD, pane, session: SESSION };
    const io = testIo(lobby, lead);
    const code = await runAdd(['--file', otherFile, 'claude-operator-acme'], io, {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor: doctor(home),
      now: () => NOW,
      launch: world('n'),
    });
    expect(code).toBe(1);
    expect(io.err).toContain('--file is the owner\'s');
    expect(existsSync(join(other, '.agents', 'team.state.json'))).toBe(false);
  });

  test('a pane the session does not record still gets the not-a-repo line', async () => {
    const { home, lobby } = fresh();
    const root = join(base, 'acme');
    mkdirSync(root);
    await bringUp(home, root, teamText(root, SESSION, 'acme'), 'w');
    const stranger = { kind: 'seat' as const, name: LEAD, pane: 'w9:p9', session: SESSION };
    const io = testIo(lobby, stranger);
    const code = await runDown([], io, {
      sessionRunning: () => true,
      agents: () => [],
      alive: () => false,
      screen: () => ({ kind: 'idle' }),
      screenText: () => '',
      status: () => 'idle',
      foreground: () => null,
      now: () => NOW,
      home,
    });
    expect(code).toBe(2);
    expect(io.err).toContain(NOT_A_REPO);
  });

  test("a pane recorded for one session does not load the other session's file", async () => {
    const { home, lobby } = fresh();
    const root = join(base, 'acme');
    const other = join(base, 'other');
    mkdirSync(root);
    mkdirSync(other);
    const { pane } = await bringUp(home, root, teamText(root, SESSION, 'acme'), 'w');
    await bringUp(home, other, teamText(other, OTHER, 'other'), 'b');
    const before = readFileSync(join(other, '.agents', 'team.state.json'), 'utf8');
    const lead = { kind: 'seat' as const, name: LEAD, pane, session: SESSION };
    const io = testIo(lobby, lead);
    const code = await runAdd(['claude-operator-acme'], io, {
      home,
      sessionState: () => 'running',
      agents: () => [{ name: LEAD, agent: null, pane, workspace: 'w1', status: 'idle', cwd: lobby }],
      workspaces: () => [],
      doctor: doctor(home),
      now: () => NOW,
      launch: world('n'),
    });
    expect(io.err).not.toContain(NOT_A_REPO);
    expect(code).not.toBe(2);
    expect(readFileSync(join(other, '.agents', 'team.state.json'), 'utf8')).toBe(before);
    expect(io.err).not.toContain('project: other');
    expect(io.out).not.toContain('other-web');
  });

  test('a non-owner aiming --session from a folder with no .agents is refused and the folder stays empty', async () => {
    const { home } = fresh();
    const empty = join(base, 'empty');
    mkdirSync(empty);
    const calls: string[] = [];
    const io = testIo(empty);
    io.callerSources = () => ({
      ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
      agents: () => {
        calls.push('agents(no session)');
        return [];
      },
      paneRootPid: (pane) => {
        calls.push(`paneRoot(${pane})`);
        return null;
      },
      env: {},
      stdinIsTTY: true,
    });
    const note = (name: string) => {
      calls.push(name);
    };
    const host: AnswerHost = {
      version: () => { note('version'); return null; },
      agents: () => { note('host.agents'); return null; },
      pane: () => { note('pane'); return undefined; },
      sendKey: () => { note('sendKey'); return false; },
      rename: () => { note('rename'); return false; },
      foreground: () => { note('foreground'); return null; },
      foregroundCwd: () => { note('foregroundCwd'); return null; },
      list: () => { note('list'); return null; },
      status: () => { note('status'); return null; },
      type: () => { note('type'); return false; },
      enter: () => { note('enter'); return false; },
      now: () => { note('now'); return NOW; },
      sleep: async () => { note('sleep'); },
      home,
      standing: () => { note('standing'); return { kind: 'none' }; },
    };
    const code = await runAnswer(['seat', 'trust', '--session', OTHER], io, host);
    expect({ code, out: io.out, err: io.err }).toEqual({
      code: 1,
      out: '',
      err: "team answer: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n",
    });
    expect(calls).toEqual([]);
    expect(existsSync(join(empty, '.agents'))).toBe(false);
  });
});
