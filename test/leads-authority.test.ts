// The default rule: a placed lead and a placed operator of the target team run every command
// for that team, with no dev mode. Grant, delegate, revoke, the owner's identity and keys, and
// the three decided rows stay the owner's. A charter deny and an excluded command still refuse
// the placed lead. A grant neither adds nor removes under own-team. `leads.authority: owner-asks` restores today's
// refusals. Every home, root and caller below is synthetic.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { ownerSeatStep } from '../src/client/owner-action-step.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runApprovals } from '../src/commands/approvals.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { runConfig } from '../src/commands/config.ts';
import { runImport } from '../src/commands/import.ts';
import { runForget } from '../src/commands/forget.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { LEADS_AUTHORITY_EXCLUDED, LEADS_DOOR_COMMANDS, leadsCommandExcluded, orchestratorSeatStaysOwner, policyNeedsOwner } from '../src/leads-authority.ts';
import { COMMAND_GATES } from '../src/permissions/map.ts';
import { gateVerdict } from '../src/permissions/who.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { getTeam, noteTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import * as projects from '../src/registry/projects.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, recordRenames, testIo } from './helpers.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEAM = {
  orchestrator: 'lead',
  operator: 'ops',
  seats: [
    { name: 'lead', role: 'lead' },
    { name: 'ops', role: 'operator' },
  ],
};

function homeOf(): { home: string; root: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'leads-authority-')));
  made.push(home);
  return { home, root: join(home, 'repo') };
}

function seat(name: string, pane = 'pane-lead'): Caller {
  return { kind: 'seat', name, pane, session: 'acme' };
}

const AT = { session: 'acme', recordedPane: 'pane-lead' };

test('the placed lead and the placed operator are admitted to every command outside the exclusion list', () => {
  const { home, root } = homeOf();
  const refused: string[] = [];
  for (const command of Object.keys(COMMAND_GATES)) {
    for (const caller of [seat('lead'), seat('ops')]) {
      const verdict = gateVerdict(caller, TEAM, root, home, command, AT);
      const excluded = leadsCommandExcluded(command);
      const ownerOnly = COMMAND_GATES[command]?.kind === 'owner-only';
      if (!excluded && verdict.kind !== 'ok') refused.push(`${command} as ${caller.kind === 'seat' ? caller.name : caller.kind}`);
      if (excluded && ownerOnly && verdict.kind !== 'refused') refused.push(`${command} was admitted`);
    }
  }
  expect(refused).toEqual([]);
});

test('owner-asks restores an owner-only refusal, and another team or another pane is not admitted', () => {
  const { home, root } = homeOf();
  expect(gateVerdict(seat('ada'), TEAM, root, home, 'add', AT).kind).toBe('refused');
  expect(gateVerdict(seat('lead', 'pane-other'), TEAM, root, home, 'add', AT).kind).toBe('refused');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
entity: acme
session: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: m
    version: "1"
    launch: claude
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: m
    version: "1"
    launch: claude
`);
  const set = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'leads.authority', value: 'owner-asks' }, { now: new Date('2026-11-07T18:00:00Z') });
  expect(set.ok).toBe(true);
  expect(gateVerdict(seat('lead'), TEAM, root, home, 'add', AT).kind).toBe('refused');
  expect(gateVerdict(seat('ops'), TEAM, root, home, 'add', AT).kind).toBe('refused');
});

test('a lead sync that names also_in leaves the recorded memberships unchanged', () => {
  const { home, root } = homeOf();
  mkdirSync(root);
  projects.upsertProject(home, 'served-a', { name: 'Served A', entity: 'acme' });
  const seed = {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    lobby: null,
    inProject: 'Home A',
    alsoIn: ['Served A'] as const,
  };
  expect(noteTeam(home, root, seed, 'running', 'owner', { owner: true })).toBeNull();
  const id = teamIdOf(root);
  const recorded = getTeam(home, id)?.projects;
  expect(recorded).toEqual(['home-a', 'served-a']);
  expect(noteTeam(home, root, { ...seed, alsoIn: ['Other'] }, 'running', 'lead')).toBeNull();
  expect(getTeam(home, id)?.projects).toEqual(recorded);
});

const NOW = new Date('2026-11-07T18:00:00Z');

// The commit names its own author: a runner with no git identity configured (a CI machine)
// refuses a commit that names none.
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
}

function repo(): { home: string; root: string } {
  const place = homeOf();
  mkdirSync(place.root, { recursive: true });
  git(place.root, 'init', '-q', '-b', 'main');
  writeFileSync(join(place.root, 'README.md'), 'acme\n');
  git(place.root, 'add', 'README.md');
  git(place.root, 'commit', '-q', '-m', 'first');
  return place;
}

function teamText(root: string, extra = ''): string {
  return `format: 1
project: acme
entity: acme
session: acme
coordinator: lead
operator: ops
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: m
    version: "1"
    launch: claude
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: m
    version: "1"
    launch: claude
${extra}`;
}

function writeTeam(root: string, extra = ''): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText(root, extra));
}

/** The file `add.coordinator` loads: no entity, so the lobby is the global one the trust line names,
 *  and the session derived from the project is `acme`, the session the pane record uses. */
function writeFlagTeam(root: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
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
`);
}

function placeLead(root: string): void {
  updateState(join(root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead' };
  });
}

function blockingCharter(home: string): void {
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'charter.json'), '{}\n');
}

/** A launch that records the seat it starts. The catalogue's other add scenes stop before launch. */
function startedAdd(home: string): { sources: AddSources; creates: string[] } {
  const creates: string[] = [];
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  let session: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: CLAUDE_IDLE, agent: false });
      creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent() {
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((id) => id.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  recordRenames(launch);
  return {
    creates,
    sources: {
      home,
      now: () => NOW,
      sessionState: () => session,
      agents: () => [],
      workspaces: () => [],
      doctor: {
        version: () => '2.1.288',
        onPath: () => true,
        loggedIn: () => true,
        herdrVersion: () => '0.7.1',
        sessionRunning: () => false,
        now: () => NOW,
        home,
      },
      launch,
    },
  };
}

function addSources(home: string): AddSources {
  const halt = (): never => { throw new Error('add fixture reached a launch'); };
  const launch: Launch = {
    sessionState: halt,
    startServer: halt,
    sessionUp: halt,
    createWorkspace: halt,
    paneRun: halt,
    renameAgent: halt,
    closeWorkspace: halt,
    agentPanes: halt,
    agents: halt,
    paneText: halt,
    foreground: halt,
    sleep: halt,
    now: halt,
  };
  return {
    home,
    now: () => NOW,
    sessionState: () => null,
    agents: () => null,
    workspaces: () => null,
    doctor: {
      version: () => null,
      onPath: () => false,
      loggedIn: () => null,
      herdrVersion: () => null,
      sessionRunning: () => false,
      now: () => NOW,
      home,
    },
    launch,
  };
}

function removeSources(home: string): RemoveSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => null,
    foreground: () => null,
    now: () => NOW,
    home,
  };
}

test('owner deny beats default: charter refuses config set', async () => {
  const { home, root } = repo();
  writeTeam(root);
  placeLead(root);
  blockingCharter(home);
  const io = testIo(root, seat('lead'));
  const code = await runConfig(['set', 'project', 'other'], io, { home, env: { TEAM_CONFIG_SOURCE: 'file' }, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('team setup --edit');
});

test('owner deny beats default: charter refuses remove', async () => {
  const { home, root } = repo();
  writeTeam(root);
  placeLead(root);
  blockingCharter(home);
  const io = testIo(root, seat('lead'));
  const code = await runRemove(['ops'], io, removeSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain('team setup --edit');
});

test('owner deny beats default: charter refuses migrate', async () => {
  const { home, root } = repo();
  writeTeam(root);
  placeLead(root);
  blockingCharter(home);
  const io = testIo(root, seat('lead'));
  const code = await runMigrate([], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('owner charter');
});

function grantScopedToDown(home: string, root: string): void {
  // Entity acme's lobby is under lobbies/acme. The global lobby line the other scenes use does not load here.
  const text = teamText(root, 'grant:\n  session: acme\n  seat: lead\n  scope:\n    - down\n')
    .replace('  - ~/.config/team/lobby\n', '  - ~/.config/team/lobbies/acme\n');
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  placeLead(root);
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    roster: [{ agent: 'agt_000000000000', seat: 'ops', role: 'implementer' }],
  });
}

test('a grant does not narrow the default: lead runs status past a grant scoped to down', async () => {
  const { home, root } = repo();
  grantScopedToDown(home, root);
  const io = testIo(root, seat('lead'));
  const sources: StatusSources = {
    live: () => null,
    branch: () => null,
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
    home,
  };
  const code = await runStatus([], io, sources);
  expect(code).toBe(2);
  expect(io.err).toContain('herdr doesn\'t answer');
  expect(io.err.includes('deny')).toBe(false);
  expect(io.err.includes('not yours to read')).toBe(false);
});

test('owner-asks: a grant scoped to down refuses up', async () => {
  const { home, root } = repo();
  grantScopedToDown(home, root);
  const asked = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'leads.authority', value: 'owner-asks' }, { now: NOW });
  expect(asked.ok).toBe(true);
  const io = testIo(root, seat('lead'));
  const code = await runUp([], io, { sessionRunning: () => false, agents: () => [], home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('deny');
  expect(io.err.includes('herdr')).toBe(false);
});

test('flag gate: add --file inside this team root is the placed lead\'s', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['lead', '--file', join(root, '.agents', 'team.yaml')], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("only the owner changes the orchestrator's seat");
  expect(io.err.includes("--file is the owner's")).toBe(false);
});

test('flag gate: add --file outside this team root stays the owner\'s', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const outside = join(home, 'other', 'team.yaml');
  mkdirSync(join(home, 'other'), { recursive: true });
  writeFileSync(outside, 'format: 1\nproject: other\n');
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['lead', '--file', outside], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("--file is the owner's");
  expect(io.err.includes('only the owner changes the orchestrator')).toBe(false);
});

test('flag gate: add --file through a symlink that leaves the root stays the owner\'s', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const outside = join(home, 'escaped.yaml');
  writeFileSync(outside, 'format: 1\nproject: other\n');
  const link = join(root, '.agents', 'escape.yaml');
  symlinkSync(outside, link);
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['lead', '--file', link], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("--file is the owner's");
});

test('flag gate: a lead placed through caller sources may aim --file inside this team', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root);
  io.env = { HERDR_PANE_ID: 'pane-lead' };
  io.callerSources = () => ({
    ancestors: () => [{ pid: 200, name: 'claude' }, { pid: 100, name: 'herdr' }],
    agents: () => [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root }],
    paneRootPid: (pane) => (pane === 'pane-lead' ? 200 : null),
    env: { HERDR_PANE_ID: 'pane-lead' },
    stdinIsTTY: false,
  });
  const code = await runAdd(['lead', '--file', join(root, '.agents', 'team.yaml')], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("only the owner changes the orchestrator's seat");
  expect(io.err.includes("--file is the owner's")).toBe(false);
});

test('flag gate: add --session of this team is the placed lead\'s', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['lead', '--session', 'acme'], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("only the owner changes the orchestrator's seat");
  expect(io.err.includes("--session is the owner's")).toBe(false);
});

test('an approved delegate still starts the declared orchestrator seat', async () => {
  const { home, root } = repo();
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
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
delegates:
  - pane: main/pane-1
    commands: [add]
`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  const started = startedAdd(home);
  const io = testIo(root, { kind: 'seat', name: 'pilot', pane: 'pane-1', session: 'main' });
  const code = await runAdd(['lead'], io, { ...started.sources, delegateGate: () => ({ kind: 'passed', pane: 'main/pane-1' }) });
  expect(code).toBe(0);
  // The stub records the workspace label. This file names no label of its own, so the title is the seat and its role.
  expect(started.creates).toEqual(['lead · coordinator']);
  expect(io.err.includes("only the owner changes the orchestrator's seat")).toBe(false);
});

test('a placed lead restores a stopped ordinary seat under the default', async () => {
  const { home, root } = repo();
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
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
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  placeLead(root);
  const started = startedAdd(home);
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['worker'], io, started.sources);
  expect(code).toBe(0);
  expect(readFileSync(file, 'utf8').includes('stopped: true')).toBe(false);
  expect(readFileSync(join(root, '.agents', 'team.log'), 'utf8')).toContain('add [lead] warning: owner gate; admitted as lead');
});

test('a placed lead is refused when abandoning an ordinary seat, and the owner still closes an unknown screen', async () => {
  const { home, root } = repo();
  const text = `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
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
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
  const file = join(root, '.agents', 'team.yaml');
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(storePath(loaded.team.project, loaded.root, home), { approval: approvalOf(loaded.team, loaded.root, NOW), file: text }, loaded.team.seats, home);
  placeLead(root);
  const typed: string[] = [];
  const closed: string[] = [];
  const sources: RemoveSources = {
    home,
    sessionRunning: () => true,
    agents: () => [{ name: 'worker', agent: 'claude', pane: 'pane-w3', workspace: 'w3', status: 'idle', cwd: null }],
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
    launch: {
      typeText: (_session, _pane, line) => { typed.push(line); return true; },
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => ['pane-w3'],
      closeWorkspace: (_session, workspace) => { closed.push(workspace); return true; },
      stopSession: () => false,
      deleteSession: () => false,
      kill: () => false,
      sleep: async () => {},
      now: () => NOW,
    },
  };
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, seat('lead'));
  const code = await runRemove(['worker', '--abandon', '--json'], io, sources);
  expect(code, `${io.out}\n${io.err}`).toBe(1);
  expect(io.out).toContain('remove.abandon');
  expect(io.out).toContain('only the owner abandons a seat, from a terminal outside herdr');
  expect(typed).toEqual([]);
  expect(closed).toEqual([]);
  expect(readFileSync(file, 'utf8')).toBe(before);
  const orchestrator = testIo(root, seat('lead'));
  const refused = await runRemove(['lead', '--abandon'], orchestrator, sources);
  expect(refused).toBe(1);
  expect(orchestrator.err).toContain('only the owner abandons');
  expect(readFileSync(file, 'utf8')).toBe(before);
  const owner = testIo(root, { kind: 'owner' });
  const passed = await runRemove(['worker', '--abandon'], owner, sources);
  expect(passed, `${owner.out}\n${owner.err}`).toBe(0);
  expect(typed).toEqual([]);
  expect(closed).toEqual(['w3']);
  expect(readFileSync(file, 'utf8').includes('name: worker')).toBe(false);
});

test('flag gate: add --session of another team stays the owner\'s', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runAdd(['lead', '--session', 'other'], io, addSources(home));
  expect(code).toBe(1);
  expect(io.err).toContain("--session is the owner's");
});

test('excluded command refuses before target lookup: forget of an unknown team', async () => {
  const { home, root } = repo();
  writeTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runForget(['abc123abc123'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner');
  expect(io.err.includes('no team record')).toBe(false);
});

test('the orchestrator seat stays the owner\'s, and a needs-owner key is marked', () => {
  expect(orchestratorSeatStaysOwner(TEAM, 'lead')).toBe(true);
  expect(orchestratorSeatStaysOwner(TEAM, 'ops')).toBe(false);
  expect(policyNeedsOwner('leads.authority')).toBe(true);
  expect(policyNeedsOwner('owner-signers')).toBe(true);
  expect(policyNeedsOwner('owner-signer-mode')).toBe(true);
  expect(policyNeedsOwner('grant-emission')).toBe(true);
  expect(policyNeedsOwner('owner.reserved-scope')).toBe(true);
  expect(policyNeedsOwner('dev-mode')).toBe(true);
  expect(policyNeedsOwner('dev_mode')).toBe(true);
  expect(policyNeedsOwner('development-mode')).toBe(true);
  expect(policyNeedsOwner('development_mode')).toBe(true);
  expect(policyNeedsOwner('daemon.broker')).toBe(true);
  expect(policyNeedsOwner('daemon_broker')).toBe(true);
  expect(policyNeedsOwner('daemon.chores')).toBe(true);
  expect(policyNeedsOwner('daemon.heartbeat')).toBe(true);
  expect(policyNeedsOwner('message-display')).toBe(false);
});

test('a placed lead\'s entity-level policy set is not a default-rule admission', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runPolicy(['set', 'entity', 'vault-root', '/synthetic/vault'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner');
  expect(io.err.includes('admitted as lead')).toBe(false);
});

test('a placed lead\'s policy --file of another team is not a default-rule admission', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const otherRoot = join(home, 'other');
  mkdirSync(join(otherRoot, '.agents'), { recursive: true });
  const otherFile = join(otherRoot, '.agents', 'team.yaml');
  writeFileSync(otherFile, readFileSync(join(root, '.agents', 'team.yaml'), 'utf8').replace('project: acme', 'project: other'));
  const before = readFileSync(otherFile, 'utf8');
  const io = testIo(root, seat('lead'));
  const code = await runPolicy(['set', 'team', 'vault-root', '/synthetic/vault', '--file', otherFile], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner');
  expect(io.err.includes('admitted as')).toBe(false);
  expect(readFileSync(otherFile, 'utf8')).toBe(before);
});

test('a placed lead\'s project-level policy set is not a default-rule admission', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runPolicy(['set', 'project', 'vault-root', '/synthetic/vault'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner');
  expect(io.err.includes('admitted as lead')).toBe(false);
});

test('the owner-seat door and the exclusion list name the same acts', () => {
  expect(Object.keys(LEADS_DOOR_COMMANDS).sort()).toEqual(['approvals', 'import', 'up']);
  for (const [door, gate] of Object.entries(LEADS_DOOR_COMMANDS)) {
    expect(LEADS_AUTHORITY_EXCLUDED.has(gate)).toBe(true);
    expect(leadsCommandExcluded(door)).toBe(true);
    expect(leadsCommandExcluded(gate)).toBe(true);
  }
});

test('a placed lead\'s config --request writes nothing', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const file = join(root, '.agents', 'team.yaml');
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, seat('lead'));
  const code = await runConfig(['set', 'project', 'evil', '--request'], io, { home, now: () => NOW });
  expect(code).toBe(0);
  expect(io.out).toContain('owner-seat request');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a placed operator\'s config --request cannot move the orchestrator seat', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  const file = join(root, '.agents', 'team.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('operator: lead', 'operator: ops'));
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.ops = { stage: 'ready', pane: 'pane-ops' };
  });
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, seat('ops', 'pane-ops'));
  const code = await runConfig(['set', 'coordinator', 'ops', '--request'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain("only the owner changes the orchestrator's seat");
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a placed lead is not admitted to approvals revoke, including a folder outside the team', () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const ask = { request: false, approval: undefined, dry: false, json: false };
  const own = ownerSeatStep('approvals', 'team-revoke-approval', ['revoke', 'oa_0123456789abcdef01234567'], ask, io, { home, root }, [root]);
  expect(own.kind).not.toBe('admitted');
  const other = join(home, 'other');
  mkdirSync(other);
  const mixed = ownerSeatStep('approvals', 'team-revoke-approval', ['revoke', 'oa_0123456789abcdef01234567'], ask, io, { home, root }, [root, other]);
  expect(mixed.kind).not.toBe('admitted');
});

test('a placed lead\'s approvals revoke of an own-team rule writes nothing', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runApprovals(['revoke', 'oa_0123456789abcdef01234567'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.out.includes('revoked')).toBe(false);
});

test('a placed lead\'s approvals --request records the card and revokes nothing', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runApprovals(['revoke', 'oa_0123456789abcdef01234567', '--request'], io, { home, now: () => NOW });
  expect(code).toBe(0);
  expect(io.out).toContain('owner-seat request');
  expect(io.out.includes('revoked')).toBe(false);
});

test('a placed lead\'s import --request writes nothing', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const file = join(root, '.agents', 'team.yaml');
  const before = readFileSync(file, 'utf8');
  const io = testIo(root, seat('lead'));
  const code = await runImport(['--request'], io, { home, now: () => NOW });
  expect(code).toBe(0);
  expect(io.out).toContain('owner-seat request');
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('a placed lead can\'t turn dev mode on through policy', async () => {
  const { home, root } = repo();
  writeFlagTeam(root);
  placeLead(root);
  const io = testIo(root, seat('lead'));
  const code = await runPolicy(['set', 'team', 'dev-mode', 'on'], io, { home, now: () => NOW });
  expect(code).toBe(1);
  expect(io.err).toContain('only the owner');
  expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8').includes('dev-mode')).toBe(false);
});
