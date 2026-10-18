import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import { displayAgent, workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyOf } from '../src/lobby/recorded.ts';
import { rulesFilePath } from '../src/launch/rules-file.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T21:00:00Z');
const AGY_TRUST = readFileSync(join(import.meta.dir, 'fixtures/antigravity/1.2.16/trust.txt'), 'utf8').replace('<project-worktree>', '/tmp/acme');
const AGY_IDLE = readFileSync(join(import.meta.dir, 'fixtures/antigravity/1.2.16/idle.txt'), 'utf8');
const AGY_WORKING = readFileSync(join(import.meta.dir, 'fixtures/antigravity/1.2.16/working.txt'), 'utf8');

const made: string[] = [];
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function approve(root: string, home: string): Promise<void> {
  const code = await runApprove(['--file', '.agents/team.yaml'], testIo(root, { kind: 'owner' }), {
    ask: async () => '2',
    waiting: () => 'empty',
    now: () => NOW,
    home,
  });
  expect(code).toBe(0);
}

function makeWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'trust-resume-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = `format: 1
project: acme
coordinator: lead
operator: operator-1
session: acme
trust:
  - ${lobbyOf(home, root, { project: 'acme', session: 'acme' })}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: operator
    name: operator-1
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    display: Gemini 3.8 Flash
    launch: agy
`;
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, text);
  const loaded = validateTeamFile(text);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  return { base, home, root, dir: join(root, '.agents'), file, team: loaded.team };
}

describe('trust dialog resume and pane naming', () => {
  test('(2) up names the pane right after the pane is created, before any wait, so a left-out pane is findable', async () => {
    const w = makeWorld();
    await approve(w.root, w.home);

    const events: string[] = [];
    const panes = new Map<string, { name: string | null; workspace: string; label: string }>();
    let nextWs = 0;

    const upSources: UpSources = {
      home: w.home,
      now: () => NOW,
      standing: (r) => approvalStanding(r, w.home),
      sessionRunning: () => true,
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [...panes.values()].map((p) => ({ id: p.workspace, label: p.label })),
      agents: () =>
        [...panes.entries()].map(([pane, info]) => ({
          name: info.name,
          agent: pane === 'w1:p1' ? 'claude' : 'agy',
          pane,
          workspace: info.workspace,
          status: 'idle',
          cwd: null,
        })),
      launch: {
        sessionState: () => 'running',
        now: () => NOW,
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: (_session, _cwd, label) => {
          nextWs++;
          const workspace = `w${nextWs}`;
          const pane = `${workspace}:p1`;
          panes.set(pane, { name: null, workspace, label });
          events.push(`create:${pane}:${label}`);
          return { pane, workspace };
        },
        renameAgent: (_session, pane, name) => {
          const entry = panes.get(pane);
          if (entry) entry.name = name;
          events.push(`rename:${pane}:${name}`);
          return true;
        },
        paneRun: (_session, pane, command) => {
          events.push(`run:${pane}:${command.split(' ')[0]}`);
          return true;
        },
        paneText: (_session, pane) => {
          events.push(`read:${pane}`);
          return pane === 'w1:p1' ? CLAUDE_IDLE : AGY_TRUST;
        },
        agentStatus: (_session, pane) => (pane === 'w1:p1' ? 'idle' : 'working'),
        agentPanes: () => [...panes.keys()],
        workspacePanes: (_session, ws) => [`${ws}:p1`],
        agents: () =>
          [...panes.entries()].map(([pane, info]) => ({
            name: info.name,
            agent: pane === 'w1:p1' ? 'claude' : 'agy',
            pane,
            workspace: info.workspace,
            status: 'idle',
            cwd: null,
          })),
        processInfo: (_session, pane) => (pane === 'w1:p1' ? { shell: 100, foreground: [101] } : { shell: 200, foreground: [201] }),
        foreground: (_session, pane) => (pane === 'w1:p1' ? ['claude'] : ['agy']),
        closeWorkspace: () => true,
        reportDisplayAgent: () => true,
        renameWorkspace: () => true,
        sleep: async () => {},
      },
      sleep: async () => {},
      terminal: () => ({
        drain() {},
        async key() {
          return 'timeout';
        },
      }),
    };

    const io = testIo(w.root, { kind: 'owner' });
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 100, cli: [101] } },
        },
        worktrees: {},
        watch: { pid: 999, heartbeat: NOW.toISOString() },
      };
    });
    panes.set('w1:p1', { name: 'lead', workspace: 'w1', label: workspaceLabel(w.team.seats[0]!) });
    nextWs = 1;

    const code = await runUp([], io, upSources);
    expect(code).toBe(1);
    expect(io.out).toContain('operator-1: left out: timed out after 90 s waiting for an answer; left as it is\n');

    // The rename happened immediately after create, before paneRun and before any paneText wait read.
    const createIdx = events.indexOf(`create:w2:p1:${workspaceLabel(w.team.seats[1]!)}`);
    const renameIdx = events.indexOf('rename:w2:p1:operator-1');
    const runIdx = events.findIndex((e) => e.startsWith('run:w2:p1:'));
    const readIdx = events.indexOf('read:w2:p1');
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBe(createIdx + 1);
    expect(runIdx).toBeGreaterThan(renameIdx);
    expect(readIdx).toBeGreaterThan(runIdx);
    expect(panes.get('w2:p1')?.name).toBe('operator-1');
  });

  test('(1a) up finds a waiting-for-trust seat by its recorded pane even when unnamed, and finishes rename, metadata, and rules delivery', async () => {
    const w = makeWorld();
    await approve(w.root, w.home);

    const operatorSeat = w.team.seats[1]!;
    const leadSeat = w.team.seats[0]!;
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 100, cli: [101] } },
          'operator-1': {
            stage: 'launched',
            pane: 'w46:p1',
            workspace: 'w46',
            launched: { shell: 200, cli: [201] },
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        },
        worktrees: {},
        watch: { pid: 999, heartbeat: NOW.toISOString() },
      };
    });

    let operatorName: string | null = null;
    let status: 'done' | 'working' = 'done';
    let typedLine = '';
    let pasted = false;
    const renames: string[] = [];
    const displays: string[] = [];
    const sent: string[] = [];

    const boxed = () => {
      const [first = '', ...rest] = typedLine.split('\n');
      const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      return AGY_IDLE.replace('\n>\n', `\n${body}\n`);
    };

    const listAgents = (): HerdrAgent[] => [
      { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
      { name: operatorName, agent: 'agy', pane: 'w46:p1', workspace: 'w46', status, cwd: null },
    ];

    const upSources: UpSources = {
      home: w.home,
      now: () => NOW,
      standing: (r) => approvalStanding(r, w.home),
      sessionRunning: () => true,
      sessionState: () => 'running',
      alive: () => true,
      workspaces: () => [
        { id: 'w1', label: workspaceLabel(leadSeat) },
        { id: 'w46', label: workspaceLabel(operatorSeat) },
      ],
      agents: listAgents,
      launch: {
        sessionState: () => 'running',
        now: () => NOW,
        startServer: () => true,
        sessionUp: () => true,
        createWorkspace: () => null,
        renameAgent: (_session, pane, name) => {
          renames.push(`${pane}:${name}`);
          if (pane === 'w46:p1') operatorName = name;
          return true;
        },
        reportDisplayAgent: (_session, pane, text) => {
          displays.push(`${pane}:${text}`);
          return true;
        },
        renameWorkspace: () => true,
        paneRun: () => true,
        paneText: (_session, pane) => {
          if (pane === 'w1:p1') return CLAUDE_IDLE;
          if (pasted) return boxed();
          return status === 'working' ? AGY_WORKING : AGY_IDLE;
        },
        agentStatus: (_session, pane) => (pane === 'w46:p1' ? status : 'idle'),
        agentPanes: () => ['w1:p1', 'w46:p1'],
        agents: listAgents,
        processInfo: (_session, pane) => (pane === 'w1:p1' ? { shell: 100, foreground: [101] } : { shell: 200, foreground: [201] }),
        foreground: (_session, pane) => (pane === 'w1:p1' ? ['claude'] : ['agy']),
        typeText: (_session, pane, text) => {
          typedLine = text;
          pasted = true;
          sent.push(`${pane}:${text}`);
          return true;
        },
        pressEnter: (_session, pane) => {
          sent.push(`${pane}:Enter`);
          pasted = false;
          status = 'working';
          return true;
        },
        closeWorkspace: () => true,
        sleep: async () => {},
      },
      sleep: async () => {},
    };

    const io = testIo(w.root, { kind: 'owner' });
    const code = await runUp([], io, upSources);
    expect(code).toBe(0);
    expect(io.out).not.toContain('its waiting pane is gone');
    expect(io.out).toContain('operator-1: ready\n');
    expect(renames).toEqual(['w46:p1:operator-1']);
    expect(displays).toContain(`w46:p1:${displayAgent(operatorSeat)}`);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('w46:p1:Read ');
    expect(sent[0]).toContain('rules/operator-1.md');
    expect(sent[1]).toBe('w46:p1:Enter');

    const recorded = readState(w.dir).sessions.acme?.seats['operator-1'];
    expect(recorded?.stage).toBe('ready');
    expect(recorded?.waiting).toBeUndefined();
    expect(recorded?.rules).toBe('message');
    expect(recorded?.pane).toBe('w46:p1');
  });

  test('(1b) register finds a waiting-for-trust seat by its recorded pane without --pane, and finishes rename, metadata, and rules delivery', async () => {
    const w = makeWorld();
    await approve(w.root, w.home);

    const operatorSeat = w.team.seats[1]!;
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: {
          'operator-1': {
            stage: 'launched',
            pane: 'w46:p1',
            workspace: 'w46',
            launched: { shell: 200, cli: [201] },
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        },
      };
    });

    let status: 'idle' | 'working' = 'idle';
    let typedLine = '';
    let pasted = false;
    const renames: string[] = [];
    const titles: string[] = [];
    const displays: string[] = [];
    const sent: string[] = [];

    const boxed = () => {
      const [first = '', ...rest] = typedLine.split('\n');
      const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      return AGY_IDLE.replace('\n>\n', `\n${body}\n`);
    };

    const regSources: RegisterSources = {
      home: w.home,
      now: () => NOW,
      standing: (r) => approvalStanding(r, w.home),
      sessionState: () => 'running',
      agents: () => [
        { name: null, agent: 'agy', pane: 'w46:p1', workspace: 'w46', status, cwd: null },
      ],
      processInfo: () => ({ shell: 200, foreground: [201] }),
      foreground: () => ['agy'],
      paneText: () => (pasted ? boxed() : status === 'working' ? AGY_WORKING : AGY_IDLE),
      agentStatus: () => status,
      renameAgent: (session, pane, name) => {
        renames.push(`${session}:${pane}:${name}`);
        return true;
      },
      renameWorkspace: (session, ws, label) => {
        titles.push(`${session}:${ws}:${label}`);
        return true;
      },
      reportDisplayAgent: (session, pane, text) => {
        displays.push(`${session}:${pane}:${text}`);
        return true;
      },
      typeText: (_session, pane, text) => {
        typedLine = text;
        pasted = true;
        sent.push(`${pane}:${text}`);
        return true;
      },
      pressEnter: (_session, pane) => {
        sent.push(`${pane}:Enter`);
        pasted = false;
        status = 'working';
        return true;
      },
      sleep: async () => {},
    };

    const io = testIo(w.root, { kind: 'owner' });
    const code = await runRegister(['operator-1'], io, regSources);
    expect(code).toBe(0);
    expect(io.out).toContain('operator-1: registered — pane w46:p1; nothing was launched\n');
    expect(renames).toEqual(['acme:w46:p1:operator-1']);
    expect(titles).toEqual([`acme:w46:${workspaceLabel(operatorSeat)}`]);
    expect(displays).toEqual([`acme:w46:p1:${displayAgent(operatorSeat)}`]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('w46:p1:Read ');
    expect(sent[0]).toContain('rules/operator-1.md');
    expect(sent[1]).toBe('w46:p1:Enter');

    const recorded = readState(w.dir).sessions.acme?.seats['operator-1'];
    expect(recorded?.stage).toBe('ready');
    expect(recorded?.waiting).toBeUndefined();
    expect(recorded?.rules).toBe('message');
    expect(recorded?.pane).toBe('w46:p1');
    expect(existsSync(rulesFilePath('acme', w.root, w.home, 'operator-1')!)).toBe(true);
  });

  test('(1c) answer finds a waiting-for-trust seat by its recorded pane when paused before rename, renames it, and delivers rules', async () => {
    const w = makeWorld();
    await approve(w.root, w.home);
    const lobby = lobbyOf(w.home, w.root, { project: 'acme', session: 'acme' });
    mkdirSync(lobby, { recursive: true });
    writeGrant(
      w.home,
      {
        name: `team-${teamIdOf(w.root)}`,
        kind: 'team',
        grantee: teamIdOf(w.root),
        capabilities: ['dialogs.trust'],
        roots: [w.root],
        scope: [w.root],
      },
      { now: NOW },
    );
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        ...emptySession(),
        seats: {
          'operator-1': {
            stage: 'launched',
            pane: 'w46:p1',
            workspace: 'w46',
            launched: { shell: 200, cli: [201] },
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        },
      };
    });

    const trustScreen = readFileSync(join(import.meta.dir, 'fixtures/antigravity/1.2.16/trust.txt'), 'utf8').replace('<project-worktree>', lobby);
    let screen = trustScreen;
    let status = 'idle';
    let named = false;
    const keys: string[] = [];
    const renames: string[] = [];
    const typed: string[] = [];

    const agyBox = (value: string) => {
      const [first = '', ...rest] = value.split('\n');
      const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
      return AGY_IDLE.replace('\n>\n', `\n${body}\n`);
    };

    const host: AnswerHost = {
      version: () => '1.2.16',
      agents: () => [
        { name: 'lead', pane: 'w1:p1', workspace: 'w1' },
        { name: named ? 'operator-1' : '', pane: 'w46:p1', workspace: 'w46' },
      ],
      pane: (_session, pane) => (pane === 'w46:p1' ? screen : undefined),
      sendKey: (_session, pane, key) => {
        keys.push(`${pane}:${key}`);
        screen = AGY_IDLE;
        return true;
      },
      rename: (_session, pane, name) => {
        renames.push(`${pane}:${name}`);
        named = true;
        return true;
      },
      foreground: () => ['agy'],
      foregroundCwd: () => lobby,
      list: () => ['teamcli'],
      status: () => status,
      type: (_session, pane, text) => {
        typed.push(`${pane}:${text}`);
        screen = agyBox(text);
        return true;
      },
      enter: () => {
        screen = AGY_IDLE;
        status = 'working';
        return true;
      },
      processInfo: () => ({ shell: 200, foreground: [201] }),
      now: () => NOW,
      sleep: async () => {},
      home: w.home,
      standing: (r) => approvalStanding(r, w.home),
    };

    const io = testIo(w.root, { kind: 'owner' });
    const code = await runAnswer(['operator-1', 'trust'], io, host);
    expect(code).toBe(0);
    expect(io.out).toBe(`team acme, session "acme"\noperator-1: answered trust (${lobby})\n`);
    expect(keys).toEqual(['w46:p1:enter']);
    expect(renames).toEqual(['w46:p1:operator-1']);
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('w46:p1:Read ');
    expect(typed[0]).toContain('rules/operator-1.md');

    const recorded = readState(w.dir).sessions.acme?.seats['operator-1'];
    expect(recorded?.stage).toBe('ready');
    expect(recorded?.waiting).toBeUndefined();
    expect(recorded?.rules).toBe('message');
    expect(recorded?.pane).toBe('w46:p1');
  });

  test('(3) team check row for waiting for owner (trust) names the honest actors with and without dialogs.trust', async () => {
    const w = makeWorld();
    await approve(w.root, w.home);

    const leadSeat = w.team.seats[0]!;
    const operatorSeat = w.team.seats[1]!;
    updateState(w.dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'ready', pane: 'w1:p1', workspace: 'w1', launched: { shell: 100, cli: [101] } },
          'operator-1': {
            stage: 'launched',
            pane: 'w46:p1',
            workspace: 'w46',
            launched: { shell: 200, cli: [201] },
            waiting: { state: 'waiting-owner', classification: 'trust' },
          },
        },
        worktrees: {},
        watch: { pid: 999, heartbeat: NOW.toISOString() },
      };
    });

    const checkOnce = () => {
      const io = testIo(w.root, { kind: 'owner' });
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => ({
          running: true,
          agents: [
            { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
            { name: 'operator-1', agent: 'agy', pane: 'w46:p1', workspace: 'w46', status: 'idle', cwd: null },
          ],
          workspaces: [
            { id: 'w1', label: workspaceLabel(leadSeat) },
            { id: 'w46', label: workspaceLabel(operatorSeat) },
          ],
          screens: {
            'w1:p1': CLAUDE_IDLE,
            'w46:p1': AGY_TRUST,
          },
          processes: {
            'w1:p1': { shell: 100, foreground: [101] },
            'w46:p1': { shell: 200, foreground: [201] },
          },
        }),
        branch: () => 'main',
        standing: (at) => approvalStanding(at, w.home),
        now: () => NOW,
        home: w.home,
      });
      return { code, out: `${io.out}${io.err}` };
    };

    // Without dialogs.trust grant: the owner answers the dialog in the pane, then team up.
    const withoutGrant = checkOnce();
    expect(withoutGrant.code).toBe(1);
    expect(withoutGrant.out).toContain(
      'difference: operator-1: waiting for owner (trust)\n  repair: the owner answers the dialog in the pane, then team up\n',
    );

    // With dialogs.trust grant in force: team answer operator-1 trust, or the owner answers the dialog in the pane, then team up.
    const written = writeGrant(
      w.home,
      {
        name: `team-${teamIdOf(w.root)}`,
        kind: 'team',
        grantee: teamIdOf(w.root),
        capabilities: ['dialogs.trust'],
        roots: [w.root],
        scope: [w.root],
      },
      { now: NOW },
    );
    expect(written.ok).toBe(true);
    const withGrant = checkOnce();
    expect(withGrant.code).toBe(1);
    expect(withGrant.out).toContain(
      'difference: operator-1: waiting for owner (trust)\n  repair: team answer operator-1 trust, or the owner answers the dialog in the pane, then team up\n',
    );
  });
});
