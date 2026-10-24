// The entity model rule's word on a launch line (Policies rule 10), asked before a launch has
// any effect: `up`, `add` and `restart` refuse a seat whose line names a model the rule in force
// does not allow on that seat, with the sentence `config set` uses, and a line the rule allows
// still runs. A line naming no model — a launcher that chooses one, a CLI started on its
// last-used model — is not judgeable and passes. The line is judged by the model its own flags
// carry, never by the vendor the file declares: a seat may declare one lab and name another.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { launchModelOf, launchRefusal } from '../src/launch/model-guard.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { parseModelRule } from '../src/policy/model-rule.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T10:00:00Z');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;
const IDLE = CLAUDE_IDLE;

/** The sentence every site refuses an allowed-lab breach with. */
const SENTENCE =
  'the model "claude-opus-5-5" runs under the lab "anthropic", which the entity model rule in force does not allow on this seat';
const UNKNOWN_SENTENCE =
  'the model "mystery-9" names no lab this version knows, and the entity model rule decides this seat';

function setRule(home: string, value: string, now: Date = NOW): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now });
  if (!wrote.ok) throw new Error(wrote.why);
}

describe('launchModelOf', () => {
  test('reads the model the CLI\'s own flag names, the last flag in the line winning', () => {
    expect(launchModelOf({ cli: 'claude-code', launch: 'claude --model claude-opus-5-5' }))
      .toEqual({ kind: 'lab', model: 'claude-opus-5-5', lab: 'anthropic' });
    expect(launchModelOf({ cli: 'claude-code', launch: 'claude --model gpt-6.1-sol --model claude-opus-5-5' }))
      .toEqual({ kind: 'lab', model: 'claude-opus-5-5', lab: 'anthropic' });
    expect(launchModelOf({ cli: 'codex', launch: 'codex -m gpt-6.1-sol' }))
      .toEqual({ kind: 'lab', model: 'gpt-6.1-sol', lab: 'openai' });
  });

  test('a line that names no model, or a CLI this version does not know, names no model', () => {
    expect(launchModelOf({ cli: 'claude-code', launch: 'claude' })).toEqual({ kind: 'none' });
    expect(launchModelOf({ cli: 'no-such-cli', launch: 'thing --model claude-opus-5-5' })).toEqual({ kind: 'none' });
  });

  test('an id whose maker this version cannot name is named as unknown', () => {
    expect(launchModelOf({ cli: 'claude-code', launch: 'claude --model mystery-9' }))
      .toEqual({ kind: 'unknown', model: 'mystery-9' });
  });
});

describe('launchRefusal', () => {
  const worker = { name: 'worker', role: 'implementer', cli: 'claude-code', launch: 'claude --model claude-opus-5-5' };
  const silent = { ...worker, launch: 'claude' };

  function rule(value: string) {
    const entries = parseModelRule(value);
    if (entries === null) throw new Error(`rule does not parse: ${value}`);
    return { kind: 'rule' as const, rule: value, entries };
  }

  test('a team with no entity, or a rule naming no lab this seat may run, passes', () => {
    expect(launchRefusal(worker, { kind: 'none' })).toBeNull();
    expect(launchRefusal(worker, rule('worker=!openai; *=anthropic'))).toBeNull();
    expect(launchRefusal(worker, rule('keeper=!anthropic'))).toBeNull();
  });

  test('a line naming a lab the seat\'s entry refuses is refused with the shared sentence', () => {
    expect(launchRefusal(worker, rule('worker=!anthropic; *=anthropic'))).toBe(SENTENCE);
  });

  test('a line that names no model passes, even where the rule decides the seat', () => {
    expect(launchRefusal(silent, rule('worker=!anthropic; *=anthropic'))).toBeNull();
  });

  test('a model whose maker is unknown is refused only where the rule decides the seat', () => {
    const mystery = { ...worker, launch: 'claude --model mystery-9' };
    expect(launchRefusal(mystery, rule('worker=!anthropic; *=anthropic'))).toBe(UNKNOWN_SENTENCE);
    expect(launchRefusal(mystery, rule('keeper=!anthropic'))).toBeNull();
  });

  test('a rule that cannot be read refuses a line that names a model and passes one that names none', () => {
    const unreadable = { kind: 'unreadable' as const, why: 'bad signature' };
    expect(launchRefusal(worker, unreadable)).toContain('cannot be read (bad signature)');
    expect(launchRefusal(silent, unreadable)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `up` and `add`: the same team the budget refusals use, with an entity and a
// signed rule, so the refusal is the rule's and nothing else's.
// ---------------------------------------------------------------------------

const BASE = `format: 1
project: acme
entity: lab
session: acme
coordinator: lead
operator: lead
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
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

/** The worker's own entry refuses the lab its launch line names; every other seat may run it. */
const REFUSED = 'worker=!anthropic; *=anthropic';
/** The same rule pointed at a lab this line never names: the launch passes. */
const ALLOWED = 'worker=!openai; *=anthropic';

describe('up and add under the entity model rule', () => {
  let base: string;
  let root: string;
  let home: string;
  const WATCH = 'Watch · acme';

  function writeTeamYaml(text: string): void {
    // A team that declares an entity also trusts the entity's own lobby folder.
    const entityLobby = join(home, '.config', 'team', 'lobbies', 'lab');
    const yaml = text.includes('trust:')
      ? text
      : text.replace(
          'coordinator: lead\n',
          `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n  - ${entityLobby}\n`,
        );
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  }

  function approve(): void {
    writeTeamYaml(BASE);
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    writeApproval(
      storePath(loaded.team.project, loaded.root, home),
      { approval: approvalOf(loaded.team, loaded.root), file: readFileSync(join(root, '.agents', 'team.yaml'), 'utf8') },
      loaded.team.seats,
      home,
    );
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

  function world() {
    const panes = new Map<string, { text: string; agent: boolean }>();
    let n = 0;
    const made = {
      launch: {} as Launch,
      labels: [] as string[],
      session: 'absent' as 'absent' | 'running',
      seed(pane: string, text: string, agent: boolean) {
        panes.set(pane, { text, agent });
      },
    };
    made.launch = {
      sessionState: () => made.session,
      startServer() {
        made.session = 'running';
        return true;
      },
      sessionUp: () => made.session === 'running',
      createWorkspace(_session, _cwd, label) {
        n += 1;
        panes.set(`w${n}:p1`, { text: IDLE, agent: false });
        made.labels.push(label);
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
      foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
      sleep: async () => {},
      now: () => NOW,
    };
    return made;
  }

  async function up(argv: string[], made: ReturnType<typeof world>) {
    const io = testIo(root, OWNER);
    const sources: UpSources = {
      sessionRunning: () => made.session === 'running',
      sessionState: () => made.session,
      agents: () => [],
      home,
      now: () => NOW,
      launch: made.launch,
    };
    const code = await runUp([...argv, ...FILE], io, sources);
    return { code, out: io.out, err: io.err, labels: made.labels };
  }

  async function add(argv: string[], made: ReturnType<typeof world>) {
    const io = testIo(root, OWNER);
    const sources: AddSources = {
      home,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      doctor: doctor(),
      now: () => NOW,
      launch: made.launch,
    };
    const code = await runAdd([...argv, ...FILE], io, sources);
    return { code, out: io.out, err: io.err, labels: made.labels };
  }

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'team-launch-guard-')));
    root = join(base, 'acme');
    home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    approve();
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test('up leaves the refused seat out in the plan and never launches it', async () => {
    setRule(home, REFUSED);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${SENTENCE}\n`);
    expect(dry.out).not.toContain('<pane of worker>');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: refused: ${SENTENCE}\n`);
    expect(live.out).toContain('lead: ready\n');
    expect(live.labels).toEqual(['lead', WATCH]);
  });

  test('up launches a line the rule allows', async () => {
    setRule(home, ALLOWED);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).not.toContain('would refuse');
    expect(dry.out).toContain('<pane of worker>');

    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.out).not.toContain('left out: refused');
    expect(live.labels).toEqual(['lead', 'worker', WATCH]);
  });

  test('up judges the line a restored seat will run, not the file\'s own', async () => {
    // The file's worker names an allowed lab; the registry's recorded launch — the line a fresh
    // launch of this restored seat runs — names a refused one. The rule's word follows the line.
    setRule(home, 'worker=!deepseek; *=anthropic');
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'launched' };
    });
    registerAgent(home, {
      name: 'worker',
      signing: { model: 'DeepSeek Flash', version: '4.1', role: 'implementer' },
      lab: 'deepseek',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model deepseek-flash',
      reach: { team: teamIdOf(root), seat: 'worker', session: 'acme', pane: 'w9:p1', address: null, agent_session: 'ses_deepseek' },
      seat_handle: null,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });

    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain(
      '  skip worker: would refuse: the model "deepseek-flash" runs under the lab "deepseek", which the entity model rule in force does not allow on this seat\n',
    );
    expect(dry.out).not.toContain('<pane of worker>');
  });

  test('add refuses the seat before it edits the file or makes a workspace', async () => {
    setRule(home, REFUSED);
    const before = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const refused = await add(['worker'], world());
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`team add: worker: ${SENTENCE}\n`);
    expect(refused.labels).toEqual([]);
    expect(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8')).toBe(before);

    const dry = await add(['worker', '--dry-run'], world());
    expect(dry.code).toBe(1);
    expect(dry.out).toContain(`worker: would refuse: ${SENTENCE}\n`);
    expect(dry.out).toContain('dry run: nothing was run\n');
  });

  test('add launches a line the rule allows', async () => {
    setRule(home, ALLOWED);
    const added = await add(['worker'], world());
    expect(added.code).toBe(0);
    expect(added.err).not.toContain('model rule');
    expect(added.labels).toEqual(['worker']);
  });
});

// ---------------------------------------------------------------------------
// `restart`: the restart scene's own fixture, so the allowed side is a real
// relaunch and the refused side shows the old seat untouched.
// ---------------------------------------------------------------------------

const TEAM_YAML = `format: 1
project: acme
coordinator: lead
operator: ops
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

  - role: coordinator
    name: ops
    label: ops
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

const ENTITY_TEAM = TEAM_YAML.replace('project: acme\n', 'project: acme\nentity: lab\n');

type Fixture = {
  base: string;
  root: string;
  home: string;
  file: string;
  dir: string;
  yaml: string;
};

function makeFixture(rawYaml: string): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-launch-guard-restart-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  // A team that declares an entity also trusts the entity's own lobby folder.
  const entity = /^entity: (\S+)$/m.exec(rawYaml)?.[1];
  const trust = [
    '  - ~/.config/team/lobby',
    `  - ${root}`,
    ...(entity ? [`  - ${join(home, '.config', 'team', 'lobbies', entity)}`] : []),
  ].join('\n');
  const yaml = rawYaml.includes('trust:')
    ? rawYaml
    : rawYaml.replace('workspace:\n', `trust:\n${trust}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

function makeHarness(fixture: Fixture): {
  sources: RestartSources;
  did: { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };
} {
  const did = { typed: [] as string[], pasted: [] as string[], closed: [] as string[], created: 0, runs: [] as string[] };
  let workerAlive = true;
  let boxedText = claudeBox('');
  let shelled = false;
  let turnStarted = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({ name: slot.name, agent: 'claude-code', pane, workspace: slot.workspace, status: 'idle', cwd: fixture.root });
      }
    }
    return list;
  };

  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) {
      did.typed.push(text);
      boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === 'ws-old') workerAlive = false;
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };

  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      did.created += 1;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => currentAgents().map((agent) => agent.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (!slot) return true;
      if (pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) {
        slot.text = IDLE;
        turnStarted = true;
      }
      return true;
    },
    agentStatus: () => (turnStarted ? 'working' : 'idle'),
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: () => boxedText,
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : ['claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
  };

  return { sources, did };
}

describe('restart under the entity model rule', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function ready(fixture: Fixture): void {
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
  }

  test('refuses before stopping the seat, and a dry run answers the same way', async () => {
    const fixture = makeFixture(ENTITY_TEAM);
    made.push(fixture.base);
    setRule(fixture.home, REFUSED);
    ready(fixture);
    const { sources, did } = makeHarness(fixture);

    const io = testIo(fixture.root, OWNER);
    expect(await runRestart(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe(`team restart: worker: ${SENTENCE}\n`);
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);

    const dryIo = testIo(fixture.root, OWNER);
    expect(await runRestart(['worker', '--dry-run'], dryIo, sources)).toBe(1);
    expect(dryIo.err).toBe(`team restart: worker: ${SENTENCE}\n`);
    expect(did.typed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('relaunches a line the rule allows', async () => {
    const fixture = makeFixture(ENTITY_TEAM);
    made.push(fixture.base);
    setRule(fixture.home, ALLOWED);
    ready(fixture);
    const { sources, did } = makeHarness(fixture);

    const io = testIo(fixture.root, OWNER);
    expect(await runRestart(['worker'], io, sources)).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });
});
