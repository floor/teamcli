import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { standingOf } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { realSources as restartRealSources, runRestart, USAGE, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import type { Machine } from '../src/watch/machine.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { RESTART_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { findAgent, readAgents, recordAgentSession, registerAgent } from '../src/registry/agents.ts';
import { setRoster, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { approvalStanding } from '../src/store/store.ts';
import { gateVerdict } from '../src/permissions/who.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-16T02:00:00Z');
const IDLE = CLAUDE_IDLE;
// The old pane's own Codex screens: idle before the stop, its composer holding `/exit` after the
// one text this scene types. Captured from codex 0.161.0, the version its launch line declares.
const CODEX_OLD_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8');
const CODEX_EXIT_TYPED = readFileSync(new URL('./fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');
// The same screen naming this scene's recipe: model GPT Sol, version 6.1.
const CODEX_NEW_IDLE = CODEX_OLD_IDLE.replace('gpt-5.6-terra', 'gpt-6.1-sol').replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
// Cursor's own idle screen, captured from cursor-agent 2026.10.01: the relaunched pane must draw
// a prompt this version reads as ready for a cursor seat to have launched.
const CURSOR_IDLE = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');
// Antigravity's own screens: idle before the stop, `/exit` in the composer after the one text
// this scene types. The footer names Gemini Flash 3.8, the model this scene's file declares.
const AGY_IDLE = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8');
const AGY_EXIT_TYPED = readFileSync(new URL('./fixtures/antigravity/1.2.16/exit-typed.txt', import.meta.url), 'utf8');
const AGY_CONVERSATION = 'b4b1b021-e8af-4213-9b7e-470b233b712f';

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

  - role: implementer
    name: parked-seat
    label: parked
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

// The same team with a Codex worker: its profile carries no resume flag, so a restored pane can
// only be recognized through the registry binding, never through the launch line a resume writes.
const CODEX_TEAM_YAML = TEAM_YAML.replace(
  `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
  `  - role: implementer
    name: worker
    label: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol`,
);

// The same team with a Cursor worker: a CLI with no measured resume form at all, so a recorded
// conversation has no launch-line way back and the stop is refused unless the caller abandons it.
const CURSOR_TEAM_YAML = TEAM_YAML.replace(
  `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
  `  - role: implementer
    name: worker
    label: worker
    cli: cursor
    vendor: cursor
    model: Grok
    version: "4.7"
    launch: cursor-agent --model cursor-model`,
);

// The same team with an Antigravity worker. Resume is `--conversation=<id>` on the launch line,
// read from the registry's reach.agent_session the way a Codex seat's subcommand is.
const AGY_TEAM_YAML = TEAM_YAML.replace(
  `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`,
  `  - role: implementer
    name: worker
    label: worker
    cli: antigravity
    vendor: google
    model: Gemini Flash
    version: "3.8"
    launch: agy`,
);

// The live restart reading: the file asks for 0.5 GB free swap — which no longer refuses a
// launch — and the OS's own pressure level is what the gate acts on.
const MACHINE_YAML = TEAM_YAML.replace('workspace:\n', 'machine:\n  swap_free_min: 0.5GB\nworkspace:\n');
const ROOMY: Machine = { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 8e9, swapFree: 4e9, swapUsed: 4e9 };
const TIGHT: Machine = { ...ROOMY, pressure: 'critical' };

type Fixture = {
  base: string;
  root: string;
  home: string;
  file: string;
  dir: string;
  yaml: string;
};

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the real restart launch', () => {
  test('registers a seat inbox with the team file the run read', () => {
    // Without this, a real restart leaves every file-route CLI unregistered: the launch host
    // forwards `registerInbox` only when the launch object defines it.
    expect(typeof restartRealSources.upLaunch.registerInbox).toBe('function');
  });
});

function makeFixture(rawYaml = TEAM_YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-restart-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const yaml = rawYaml.includes('trust:')
    ? rawYaml
    : rawYaml.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

function makeHarness(
  fixture: Fixture,
  opts: {
    initialRunning?: boolean;
    workerStatus?: string;
    workerScreen?: 'idle' | 'working' | 'permission' | 'unsent' | 'unknown';
    /** The text the unsent box draws, when `workerScreen` is `unsent`. */
    workerDraft?: string;
    workerSession?: string;
    /** The foreground program the faked herdr reports: the CLI the scene declares. */
    foregroundArgv0?: string;
    /** The screen a relaunched pane draws: another CLI's idle screen, when the scene declares one. */
    newPaneScreen?: string;
    /** The relaunched pane never draws the paste: the restore's read-back fails. */
    pasteDrops?: boolean;
    closeFails?: boolean;
    doctorVersion?: string | null;
    machine?: (root: string) => Machine;
  } = {},
): {
  sources: RestartSources;
  did: { typed: string[]; pasted: string[]; closed: string[]; created: number; runs: string[] };
} {
  const did = { typed: [] as string[], pasted: [] as string[], closed: [] as string[], created: 0, runs: [] as string[] };
  let workerAlive = opts.initialRunning ?? true;
  let boxedText = opts.workerScreen === 'unsent' ? claudeBox(opts.workerDraft ?? 'draft') : claudeBox('');
  let shelled = false;
  // The delivered rules line is this seat's first turn: a CLI whose rules arrive as a message
  // (Codex's line cannot carry them) starts working once Enter takes it.
  let turnStarted = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();

  const currentAgents = (): HerdrAgent[] => {
    const list: HerdrAgent[] = [
      { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
      { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
    ];
    if (workerAlive) {
      list.push({
        name: 'worker',
        agent: 'claude-code',
        pane: 'pane-old',
        workspace: 'ws-old',
        status: opts.workerStatus ?? (opts.workerScreen === 'working' ? 'working' : 'idle'),
        cwd: fixture.root,
        ...(opts.workerSession ? { session: opts.workerSession } : {}),
      });
    }
    for (const [pane, slot] of newPanes) {
      if (slot.agent) {
        list.push({
          name: slot.name,
          agent: 'claude-code',
          pane,
          workspace: slot.workspace,
          status: 'idle',
          cwd: fixture.root,
        });
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
    agentPanes: () => currentAgents().map((a) => a.pane),
    closeWorkspace(_session, workspace) {
      if (opts.closeFails) return false;
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
      newPanes.set(pane, { text: opts.newPaneScreen ?? IDLE, agent: false, name: null, workspace });
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
    agentPanes: () => currentAgents().map((a) => a.pane),
    agents: () => currentAgents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? IDLE,
    // The relaunched seat's own box: a bracketed paste draws its text as the composer rows, so
    // the delivery's read-back verifies exactly as it does on a real CLI.
    typeText(_session, pane, text) {
      did.pasted.push(text);
      const slot = newPanes.get(pane);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      if (!slot || opts.pasteDrops) return true;
      if (opts.newPaneScreen?.includes('› Ask Codex to do anything')) {
        // The CLI's own composer: the first line replaces the grey placeholder, and Enter sends it.
        slot.text = opts.newPaneScreen.replace('› Ask Codex to do anything', `› ${pasted ? (pasted[1] ?? '') : text}`);
      } else if (opts.newPaneScreen?.includes('→ Plan, search, build anything')) {
        // Cursor's composer, from its capture: the first draft row takes the arrow, the rest are
        // indented under it, exactly as `cursor/2026.10.01/rules-fit-7.txt` draws them.
        const rows = (pasted ? pasted[1] ?? '' : text).split('\n');
        slot.text = opts.newPaneScreen.replace(
          '→ Plan, search, build anything',
          rows.map((row, at) => (at === 0 ? `→ ${row}` : `    ${row}`)).join('\n'),
        );
      } else if (opts.newPaneScreen?.includes('Antigravity CLI')) {
        // Antigravity's composer, from its capture: the first row takes the prompt, later rows
        // sit at the prompt's own width, exactly as `antigravity/1.2.16/unsent.txt` draws them.
        const body = pasted ? (pasted[1] ?? '') : text;
        const [first = '', ...rest] = body.split('\n');
        const drawn = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
        slot.text = opts.newPaneScreen.replace('\n>\n', `\n${drawn}\n`);
      } else if (pasted) slot.text = claudeBox(pasted[1] ?? '');
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot) {
        slot.text = opts.newPaneScreen ?? IDLE;
        if (opts.newPaneScreen !== undefined) turnStarted = true;
      }
      return true;
    },
    agentStatus: () => (turnStarted ? 'working' : 'idle'),
    foreground: () => [opts.foregroundArgv0 ?? 'claude'],
    sleep: async () => {},
    now: () => NOW,
  };

  const doctor: DoctorSources = {
    version: () => (opts.doctorVersion === undefined ? '2.1.288' : opts.doctorVersion),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home: fixture.home,
  };

  const screenKind = opts.workerScreen ?? 'idle';
  const sources: RestartSources = {
    home: fixture.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => currentAgents(),
    workspaces: () => currentAgents().map((a) => ({ id: a.workspace })),
    alive: () => true,
    screen: () => {
      if (screenKind === 'working') return { kind: 'working' };
      if (screenKind === 'permission') return { kind: 'permission' };
      if (screenKind === 'unsent') return { kind: 'unsent' };
      if (screenKind === 'unknown') return { kind: 'unknown' };
      return { kind: 'idle' };
    },
    screenText: () => boxedText,
    status: () => opts.workerStatus ?? (screenKind === 'working' ? 'working' : 'idle'),
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [opts.foregroundArgv0 ?? 'claude']),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    ...(opts.machine ? { machine: opts.machine } : {}),
  };

  return { sources, did };
}

describe('team restart <seat>', () => {
  test('owner restarts a free running seat, prints pre-close facts, updates state, and does not edit team.yaml', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('worker: input box: empty\n');
    expect(io.out).toContain('worker: turn: not working (free)\n');
    expect(io.out).toContain('worker: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript\n');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);

    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
    expect(after?.id).toBe('seat_0123456789ab');

    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('restart [owner] restarted worker; pane pane-old -> pane-new\n');
  });

  test('a dev-mode restart records the mark and the caller it admitted', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const recorded = () => readAgents(fixture.home).find((agent) => agent.reach.seat === 'worker');

    // A seat the gate refuses, folded into a warning: the restart proceeds, and its registry
    // write says which mode it ran in and who it admitted — not `dev_mode: false`.
    const folded = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    folded.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker'], folded, sources)).toBe(0);
    expect(folded.err).toBe('team restart: warning: only the owner or `leads` restarts a seat; this call is helper; dev mode continues\n');
    expect(recorded()?.provenance.dev_mode).toBe(true);
    expect(recorded()?.provenance.dev_mode_by).toBe('helper');
  });

  test('a lead\'s restart in force leaves an existing mark, and the owner\'s restart takes it off', async () => {
    /** The worker ready on `pane-old`, its record marked as a folded run wrote it. The lead is
     *  on the roster, as a launched team lists it: the gate reads the record, not the file. */
    function marked(): { fixture: Fixture; sources: RestartSources; recorded(): ReturnType<typeof readAgents>[number] | undefined } {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
        session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      });
      const loaded = loadTeamFile(fixture.root, { home: fixture.home });
      if (!loaded.ok) throw new Error('fixture team does not validate');
      const seat = (name: string) => loaded.team.seats.find((item) => item.name === name)!;
      registerLaunch({ home: fixture.home, team: loaded.team, root: fixture.root, by: 'owner' }, seat('lead'), 'pane-lead');
      registerLaunch({ home: fixture.home, team: loaded.team, root: fixture.root, by: 'helper', devMode: true }, seat('worker'), 'pane-old');
      return {
        fixture,
        sources: makeHarness(fixture).sources,
        recorded: () => readAgents(fixture.home).find((agent) => agent.reach.seat === 'worker'),
      };
    }

    // A lead's restart in force is routine: it re-points the record and leaves the mark for the
    // owner. The owner's own restart is the write that answers the finding.
    const byLead = marked();
    const lead = testIo(byLead.fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    expect(await runRestart(['worker'], lead, byLead.sources)).toBe(0);
    expect(byLead.recorded()?.provenance.dev_mode).toBe(true);
    expect(byLead.recorded()?.provenance.dev_mode_by).toBe('helper');

    const byOwner = marked();
    const owner = testIo(byOwner.fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], owner, byOwner.sources)).toBe(0);
    expect(byOwner.recorded()?.provenance.dev_mode).toBeUndefined();
    expect(byOwner.recorded()?.provenance.dev_mode_by).toBeUndefined();
  });

  test('the lead can restart another seat from its recorded pane, including from the lobby', async () => {
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = fixture.file;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    noteLaunchedPane(fixture.home, fixture.file, 'pane-lead', 'acme');

    const { sources } = makeHarness(fixture);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });

  test('the lead can start a seat the file lists and no pane holds', async () => {
    // The check names `team restart <seat>` for a seat that is in the file and not running, so a
    // lead must be able to run it with no record and no agent to stop: the map admits the team's
    // leads, and the seat starts where nothing was closed.
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(1);
  });

  test('check names the lead for the restart it prints, and the restart gate admits that lead', async () => {
    // The missing-seat line prints `team restart <seat>` with `who: the team's lead`. That is the
    // map's own row (`restart: owner-or-leads`) answered by the function `restart.ts` calls, so a
    // lead must be able to run the line as printed. `team add` is the owner's alone — the owner
    // writes a seat into the file — and the check names it nowhere: the two acts are different
    // rows, and a lead reading the line is handed the one it can run. The team is registered with
    // its roster, the shape a launched team has on this machine, not the file-declaration fallback
    // the test above reads.
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
    ]);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const opsCaller: Caller = { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' };

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const checkIo = testIo(fixture.root, leadCaller);
    const code = runTeamCheck({}, checkIo, {
      live: () => ({
        running: true,
        agents: [
          { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: fixture.root },
          { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: fixture.root },
        ],
        workspaces: [
          { id: 'ws-lead', label: 'lead' },
          { id: 'ws-ops', label: 'ops' },
        ],
        screens: { 'pane-lead': CLAUDE_IDLE, 'pane-ops': CLAUDE_IDLE },
      }),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, fixture.home),
      now: () => NOW,
      home: fixture.home,
    });
    expect(code).toBe(1);
    expect(checkIo.out).toContain(
      'difference: worker is in the file and is not running\n  repair: team restart worker\n  who: the team\'s lead\n',
    );
    expect(checkIo.out).not.toContain('team add');

    // The gate behind the printed command, in the registry-listed shape: the roster's `leads`
    // mark admits the lead, the map refuses a plain seat, and `team add` stays the owner's.
    const loaded = loadTeamFile(fixture.root, { home: fixture.home });
    if (!loaded.ok) throw new Error('fixture team does not validate');
    const standingOfLead = standingOf(fixture.dir, 'acme', leadCaller);
    const standingOfOps = standingOf(fixture.dir, 'acme', opsCaller);
    expect(gateVerdict(leadCaller, loaded.team, fixture.root, fixture.home, 'restart', standingOfLead, () => NOW)).toEqual({ kind: 'ok' });
    expect(gateVerdict(opsCaller, loaded.team, fixture.root, fixture.home, 'restart', standingOfOps, () => NOW)).toEqual({ kind: 'refused' });
    expect(gateVerdict(leadCaller, loaded.team, fixture.root, fixture.home, 'add', standingOfLead, () => NOW)).toEqual({ kind: 'refused' });
    expect(gateVerdict({ kind: 'owner' }, loaded.team, fixture.root, fixture.home, 'add', { session: 'acme' }, () => NOW)).toEqual({ kind: 'ok' });

    // And the lead runs the line as printed: the seat starts where nothing was closed.
    const io = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker'], io, sources)).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(1);
  });

  test('refuses self-restart from a seat caller', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture);
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['lead'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team restart: the lead cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('a lead --abandon closes a blocked non-lead seat, but refuses a working seat or a lead seat; a plain seat is refused by the map', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };

    // 1. Refuses --abandon on the operator's seat: the map admits the lead, and the abandon rule
    //    keeps a seat caller off the orchestrator's and the operator's seat.
    const leadRun = makeHarness(fixture, { workerScreen: 'permission' });
    const ioLead = testIo(fixture.root, leadCaller);
    expect(await runRestart(['ops', '--abandon'], ioLead, leadRun.sources)).toBe(1);
    expect(ioLead.err).toContain("does not abandon the orchestrator's or the operator's seat");

    // 2. Refuses --abandon on a working seat from a lead caller
    const workingRun = makeHarness(fixture, { workerScreen: 'working', workerStatus: 'working' });
    const ioWorking = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--abandon'], ioWorking, workingRun.sources)).toBe(1);
    expect(ioWorking.err).toBe("team restart: worker is working; a seat's --abandon leaves it (the owner's --abandon closes it)\n");
    expect(workingRun.did.closed).toEqual([]);

    // 3. Succeeds with --abandon on a blocked seat from a lead caller without typing
    const blockedRun = makeHarness(fixture, { workerScreen: 'permission', workerStatus: 'blocked' });
    const ioBlocked = testIo(fixture.root, leadCaller);
    expect(await runRestart(['worker', '--abandon'], ioBlocked, blockedRun.sources)).toBe(0);
    expect(blockedRun.did.typed).toEqual([]);
    expect(blockedRun.did.closed).toEqual(['ws-old']);
    expect(ioBlocked.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');

    // 4. A plain seat of the team is refused by the map's `restart` row before any of that: it
    //    admits the owner and the team's `leads`, and `ops` holds no `leads`.
    const opsRun = makeHarness(fixture);
    const ioOps = testIo(fixture.root, { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' });
    expect(await runRestart(['worker'], ioOps, opsRun.sources)).toBe(1);
    expect(ioOps.err).toBe('team restart: only the owner or `leads` restarts a seat; this call is ops\n');
    expect(opsRun.did.closed).toEqual([]);
  });

  test('a seat holding unsent text is restarted: the text is copied, the pane closed without typing, and the text pasted back', async () => {
    const fixture = makeFixture();
    const busyRun = makeHarness(fixture, { workerScreen: 'unsent' });
    const ioBusy = testIo(fixture.root, { kind: 'owner' });
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    expect(await runRestart(['worker'], ioBusy, busyRun.sources)).toBe(0);
    // Nothing was typed into the old box: the workspace closed, and the paste went to the new
    // pane only after it was ready.
    expect(busyRun.did.typed).toEqual([]);
    expect(busyRun.did.closed).toEqual(['ws-old']);
    expect(busyRun.did.created).toBe(1);
    expect(busyRun.did.pasted).toEqual(['\x1b[200~draft\x1b[201~']);
    expect(existsSync(copy)).toBe(false);
    expect(ioBusy.out).toContain(`worker: input box: holds unsent text, copied to ${copy} and pasted back once the new pane is ready\n`);
    expect(ioBusy.out).toContain('worker: unsent text pasted back\n');
    expect(ioBusy.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(join(fixture.dir, 'team.log'), 'utf8')).toContain('restart [owner] worker: unsent text pasted back\n');

    // Preflight doctor failure leaves the running seat untouched
    const docRun = makeHarness(fixture, { doctorVersion: null });
    const ioDoc = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioDoc, docRun.sources)).toBe(1);
    expect(docRun.did.typed).toEqual([]);
    expect(docRun.did.closed).toEqual([]);
    expect(docRun.did.created).toBe(0);
  });

  test('a multi-line unsent draft is refused: its rows cannot be told from a soft wrap', async () => {
    const fixture = makeFixture();
    // The box draws the draft's rows at its own indent, exactly as a one-line draft the composer
    // word-wrapped would draw: the screen cannot say which break is a newline, so nothing is
    // copied and the pane is left as it is.
    const draft = 'first line\nsecond line\n\nfourth line';
    const run = makeHarness(fixture, { workerScreen: 'unsent', workerDraft: draft });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toBe('team restart: worker holds unsent text in its input box over more than one drawn row, where a soft wrap cannot be told from a newline; left as it is (the owner clears it in its pane, or team restart worker --abandon closes it)\n');
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.pasted).toEqual([]);
    expect(existsSync(join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft'))).toBe(false);
  });

  test('a draft that cannot be copied faithfully still refuses the restart, and nothing is closed', async () => {
    const fixture = makeFixture();
    const chip = makeHarness(fixture, { workerScreen: 'unsent', workerDraft: '[Pasted text #2 +7 lines]' });
    const ioChip = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioChip, chip.sources)).toBe(1);
    expect(ioChip.err).toBe('team restart: worker holds unsent text in its input box behind a paste chip; left as it is (the owner clears it in its pane, or team restart worker --abandon closes it)\n');
    expect(chip.did.closed).toEqual([]);
    expect(chip.did.created).toBe(0);

    // A seat herdr reports mid-turn keeps the old word: its turn is not the restart's to end.
    const working = makeHarness(fixture, { workerScreen: 'unsent', workerStatus: 'working' });
    const ioWorking = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioWorking, working.sources)).toBe(1);
    expect(ioWorking.err).toBe('team restart: worker holds unsent text in its input box; left as it is\n');
    expect(working.did.closed).toEqual([]);
  });

  test('an earlier copy with different text is never overwritten: the restart refuses and the old copy keeps its words', async () => {
    const fixture = makeFixture();
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    mkdirSync(join(fixture.dir, 'restart-drafts', 'acme'), { recursive: true });
    writeFileSync(copy, 'older unsent text');
    const run = makeHarness(fixture, { workerScreen: 'unsent' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toBe(`team restart: worker holds unsent text and a different copy already sits at ${copy}; left as it is\n`);
    expect(readFileSync(copy, 'utf8')).toBe('older unsent text');
    expect(run.did.closed).toEqual([]);
  });

  test('a paste the new pane never draws back is named, and its copy stays', async () => {
    const fixture = makeFixture();
    const run = makeHarness(fixture, { workerScreen: 'unsent', pasteDrops: true });
    const io = testIo(fixture.root, { kind: 'owner' });
    const copy = join(fixture.dir, 'restart-drafts', 'acme', 'worker.draft');
    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('draft');
    expect(io.out).toContain(`worker: the unsent text could not be pasted back (the pasted text did not read back as its rows); its copy is at ${copy}\n`);
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
  });

  test('refuses a busy seat without --abandon, and refuses when preflight fails before stopping the seat', async () => {
    const fixture = makeFixture();
    const busyRun = makeHarness(fixture, { workerScreen: 'permission', workerStatus: 'blocked' });
    const ioBusy = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioBusy, busyRun.sources)).toBe(1);
    expect(ioBusy.err).toBe('team restart: worker is blocked at a prompt, which team never answers; left as it is\n');
    expect(busyRun.did.closed).toEqual([]);

    // Preflight doctor failure leaves the running seat untouched
    const docRun = makeHarness(fixture, { doctorVersion: null });
    const ioDoc = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioDoc, docRun.sources)).toBe(1);
    expect(docRun.did.typed).toEqual([]);
    expect(docRun.did.closed).toEqual([]);
    expect(docRun.did.created).toBe(0);
  });

  test('never launches beside a pane that failed to close or holds a replaced process', async () => {
    const fixture = makeFixture();
    const closeFail = makeHarness(fixture, { closeFails: true });
    const ioClose = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioClose, closeFail.sources)).toBe(1);
    expect(closeFail.did.created).toBe(0);

    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        launched: { shell: 100, cli: [200] },
      };
    });
    const replaced = makeHarness(fixture);
    replaced.sources.upLaunch.processInfo = () => ({ shell: 100, foreground: [999] });
    const ioReplaced = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioReplaced, replaced.sources)).toBe(1);
    expect(ioReplaced.err).toBe('team restart: worker has a process in its old pane that is not the signed seat; left as it is\n');
    expect(replaced.did.closed).toEqual([]);
    expect(replaced.did.created).toBe(0);
  });

  test('refuses unknown, temporary, signed-off seats, and held run-lock; supports --dry-run', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats['worker-tmp-1'] = { stage: 'ready', temporary: { like: 'worker', until: 'result:out.md' } };
    });
    const { sources, did } = makeHarness(fixture);

    const ioUnknown = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['no-such-seat'], ioUnknown, sources)).toBe(1);
    expect(ioUnknown.err).toBe('team restart: no-such-seat is not a signed declared seat\n');

    const ioTemp = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker-tmp-1'], ioTemp, sources)).toBe(1);
    expect(ioTemp.err).toBe('team restart: worker-tmp-1 is a temporary copy; use team remove worker-tmp-1 then team add --temporary --like worker\n');

    const ioStopped = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['parked-seat'], ioStopped, sources)).toBe(1);
    expect(ioStopped.err).toBe('team restart: parked-seat is signed off; the owner takes the sign-off off in the file and runs team up\n');

    // Dry run
    const ioDry = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--dry-run'], ioDry, sources)).toBe(0);
    expect(ioDry.out).toContain('stop worker in pane-old (free)\n');
    expect(ioDry.out).toContain('dry run: nothing was run\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);

    // Run lock held
    mkdirSync(join(fixture.dir, 'seat-locks', 'acme'), { recursive: true });
    writeFileSync(seatLockPath(fixture.dir, 'acme', '.run'), `${process.pid} 0a1b2c3d\n`);
    const ioLocked = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], ioLocked, sources)).toBe(1);
    expect(ioLocked.err).toContain('another session-mutating run is holding');
  });

  test('an unread screen on a seat herdr calls idle does not block a lead: closed without typing, then restarted', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown' });
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const code = await runRestart(['worker'], io, sources);
    expect(code, io.err).toBe(0);
    // The workspace is closed without a typed exit: the screen is not recognised.
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('worker: input box: not read (the screen is not recognised)\n');
    expect(io.out).toContain('worker: screen: not recognised; herdr reports it idle; the workspace is closed without typing into it\n');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');
  });

  test('a dry run on an unread screen says how the workspace is closed', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--dry-run'], io, sources)).toBe(0);
    expect(io.out).toContain('stop worker in pane-old (unknown)\n');
    expect(io.out).toContain('worker: screen: not recognised; herdr reports it idle; the workspace is closed without typing into it\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('--json: a restarted seat is the team.restart document, its working lines collapsed to notes', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--json'], io, sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      format: number;
      dry_run: boolean;
      status: string;
      action_summary: string;
      project: string;
      session: string;
      seat: string;
      pane: string | null;
      notes: string[];
    }>(io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.restart', version: 1 });
    expect(doc).toMatchObject({
      format: 1,
      dry_run: false,
      status: 'ready',
      action_summary: 'team restart: restarted worker; pane pane-old -> pane-new',
      project: 'acme',
      seat: 'worker',
      pane: 'pane-new',
    });
    expect(doc.notes).toContain('worker: input box: empty');
    expect(doc.notes).toContain('worker: turn: not working (free)');
    expect(io.out).not.toContain('worker: input box: empty\n');
  });

  test('--json --dry-run: the plan carries the stop then the launch, and nothing is run', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--dry-run', '--json'], io, sources)).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<{
      dry_run: boolean;
      status: string;
      action_summary: string;
      seat: string;
      plan: { step: string; detail: string; seat?: string; prefix?: string }[];
    }>(io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      dry_run: true,
      status: 'dry-run',
      action_summary: 'dry run: nothing was run',
      seat: 'worker',
    });
    expect(doc.plan[0]).toEqual({
      step: 'stop',
      seat: 'worker',
      detail: 'stop worker in pane-old (free)',
      prefix: '+',
    });
    expect(doc.plan.some((step) => step.step === 'launch' && step.seat === 'worker')).toBe(true);
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('the same unread screen with herdr reporting a turn stays a refusal', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture, { workerScreen: 'unknown', workerStatus: 'working' });
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: worker shows a screen the profile does not recognise; left as it is (team restart worker --abandon closes its workspace without typing)\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('--json: a dev-mode warning is a note, on the plan and on the real run, and stdout is the document alone', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources } = makeHarness(fixture);
    const warning = 'warning: only the owner or `leads` restarts a seat; this call is helper; dev mode continues';

    // The dry answer is the document: the warning rides in its notes, never in front of it.
    const dry = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    dry.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker', '--dry-run', '--json'], dry, sources)).toBe(0);
    expect(dry.err).toBe('');
    const dryDoc = JSON.parse(dry.out) as { status: string; notes: string[] };
    expect(dryDoc.status).toBe('dry-run');
    expect(dryDoc.notes).toContain(warning);
    expect(dry.out.startsWith('{')).toBe(true);

    // The real run's terminal line carried the command's name; the document's note does not.
    const real = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    real.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['worker', '--json'], real, sources)).toBe(0);
    expect(real.err).toBe('');
    const realDoc = JSON.parse(real.out) as { status: string; notes: string[] };
    expect(realDoc.status).toBe('ready');
    expect(realDoc.notes).toContain(warning);
    expect(realDoc.notes.some((note) => note.startsWith('team restart:'))).toBe(false);
  });

  test('--json: the owner-or-leads repair names the owner\'s command without this run\'s --json', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });

    expect(await runRestart(['worker', '--json'], io, sources)).toBe(1);
    expect(io.err).toBe('');
    const doc = assertJsonErrorShape(io.out, { id: 'restart.caller', messageContains: 'only the owner or `leads` restarts a seat' });
    expect(doc.error.repair).toContain('`team restart worker`');
    expect(doc.error.repair).not.toContain('--json');

    // The dry answer's line is the same command, without the dry run's own flag.
    const dry = testIo(fixture.root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });
    expect(await runRestart(['worker', '--dry-run'], dry, sources)).toBe(1);
    expect(dry.out).toContain('! to unblock: a `leads` seat runs `team restart worker`');
    expect(dry.out).not.toContain('--dry-run`');
  });

  test('--json: a refusal is the team.error document and leaves stderr empty', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['no-such-seat', '--json'], io, sources)).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, {
      id: 'restart.unknown',
      messageContains: 'no-such-seat is not a signed declared seat',
      repair: 'team seats lists the seats the file declares',
    });
  });

  test('--json: a bad invocation is the usage row, without the usage text in the document', async () => {
    const fixture = makeFixture();
    const { sources } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['--json'], io, sources)).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'restart.usage', messageContains: 'a seat name is required' });
    expect(io.out).not.toContain('Usage:');
    expect(USAGE).toContain('Exits 0 when the seat is restarted');
  });
});

// ---- the seat's own recorded conversation ---------------------------------------------------
//
// The resume id comes from the two team-owned records agreeing — the agent registry's
// `reach.agent_session` and the seat state's own — bound to this team, seat, agent, CLI and
// herdr session. A record that does not agree is never resumed: the restart says why and
// launches fresh, exactly as it did before the records were read.
describe('team restart resumes the seat\'s own recorded session', () => {
  function seeded(opts: { registry?: string; state?: string; cli?: string; declaredCli?: 'claude-code' | 'codex'; workerSession?: string; launched?: boolean; launch?: string; yaml?: string; model?: string; version?: string; foregroundArgv0?: string; newPaneScreen?: string } = {}) {
    const fixture = makeFixture(opts.yaml ?? (opts.declaredCli === 'codex' ? CODEX_TEAM_YAML : TEAM_YAML));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
        ...(opts.launched ? { launched: { shell: 100, cli: [200] } } : {}),
        ...(opts.state === undefined ? {} : { agent_session: opts.state }),
      };
    });
    let agentId: string | undefined;
    if (opts.registry !== undefined) {
      agentId = registerAgent(fixture.home, {
        name: 'worker',
        signing: {
          model: opts.model ?? (opts.declaredCli === 'codex' ? 'GPT Sol' : 'Claude Opus'),
          version: opts.version ?? (opts.declaredCli === 'codex' ? '6.1' : '5.5'),
          role: 'implementer',
        },
        lab: 'anthropic',
        cli: opts.cli ?? opts.declaredCli ?? 'claude-code',
        launcher: null,
        launch: opts.launch ?? (opts.declaredCli === 'codex' ? 'codex -m gpt-6.1-sol' : 'claude --model claude-opus-5-5'),
        reach: {
          team: teamIdOf(fixture.root),
          seat: 'worker',
          session: 'acme',
          pane: 'pane-old',
          address: null,
          agent_session: opts.registry,
        },
        seat_handle: 'seat_0123456789ab',
        mcp: [],
        skills: [],
        lifecycle: 'running',
        by: 'team up',
      }).id;
    }
    return {
      fixture,
      run: makeHarness(fixture, {
        workerSession: opts.workerSession,
        ...(opts.foregroundArgv0 === undefined ? {} : { foregroundArgv0: opts.foregroundArgv0 }),
        ...(opts.newPaneScreen === undefined ? {} : { newPaneScreen: opts.newPaneScreen }),
        ...(opts.declaredCli === 'codex' ? { foregroundArgv0: 'codex', newPaneScreen: CODEX_NEW_IDLE } : {}),
      }),
      agentId,
    };
  }

  test('both records agreeing on one id resume it on the new declaration', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain('claude --model claude-opus-5-5 --resume ses_keep');
    expect(io.err).toBe('');
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: resuming session ses_keep on the new declaration');
    // The relaunch's herdr reading carried no id here: the registry keeps the one it held rather
    // than clearing it, so the next restart can still bind the conversation.
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_keep');
  });

  test('a host-restored process on the recorded pane can be replaced when its registry session agrees', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep', workerSession: 'ses_keep', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).toContain('claude --model claude-opus-5-5 --resume ses_keep');
    expect(io.err).toBe('');
  });

  test('a state-file session alone cannot prove a host-restored process when the registry disagrees', async () => {
    const { fixture, run } = seeded({ registry: 'ses_registry', state: 'ses_state', workerSession: 'ses_state', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(io.err).toContain('has a process in its old pane that is not the signed seat; left as it is');
  });

  test('a restored Codex seat is proven by the registry binding and resumes that conversation through its launcher', async () => {
    // The state predates the id, and this profile resumes by subcommand, not by a flag: the
    // registry record is the only proof, the live agent's own session is what it is compared
    // against, and the relaunch carries the recorded id as a word after `resume`.
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_codex', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    // The old pane draws its exit text once the stop types it; the new pane draws the idle
    // prompt this declaration's model names.
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    // The recorded recipe, then Codex's own resume subcommand with the id the pane proved.
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol resume ses_codex');
    // Not a flag: the id is a word after `resume`, as `codex resume --help` measures it.
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toBe('');
  });

  test('a restored Antigravity seat is proven by the registry binding and resumes that conversation through its launcher', async () => {
    // The state predates the id. The registry record is the proof, the live agent's own session
    // is what it is compared against, and the relaunch appends the measured `--conversation=<id>`.
    const { fixture, run } = seeded({
      registry: AGY_CONVERSATION,
      cli: 'antigravity',
      model: 'Gemini Flash',
      version: '3.8',
      yaml: AGY_TEAM_YAML,
      launch: 'agy',
      workerSession: AGY_CONVERSATION,
      launched: true,
      foregroundArgv0: 'agy',
      newPaneScreen: AGY_IDLE,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.doctor = { ...run.sources.doctor, version: () => '1.4.2' };
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? AGY_EXIT_TYPED : AGY_IDLE) : AGY_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    // A typical `agy` seat: the profile's unattended flag follows the conversation the record named.
    expect(run.did.runs.join('\n')).toContain(
      `AGENT_UNATTENDED=1 agy --conversation=${AGY_CONVERSATION} --dangerously-skip-permissions`,
    );
    expect(io.err).toBe('');
  });

  test('a restored Antigravity wrapper keeps --conversation=<id> on the forwarded launch line', async () => {
    const launch = 'zsh /Users/owner/as-floor.sh agy --model gemini-3.8-flash';
    const { fixture, run } = seeded({
      registry: AGY_CONVERSATION,
      cli: 'antigravity',
      model: 'Gemini Flash',
      version: '3.8',
      yaml: AGY_TEAM_YAML.replace('    launch: agy', `    launch: ${launch}`),
      launch,
      workerSession: AGY_CONVERSATION,
      launched: true,
      foregroundArgv0: 'agy',
      newPaneScreen: AGY_IDLE,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.doctor = { ...run.sources.doctor, version: () => '1.4.2' };
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? AGY_EXIT_TYPED : AGY_IDLE) : AGY_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain(
      `AGENT_UNATTENDED=1 ${launch} --conversation=${AGY_CONVERSATION} --dangerously-skip-permissions`,
    );
  });

  test('a recorded launcher that selects another conversation is refused before the stop', async () => {
    // The registry binds ses_codex, and the recorded launcher itself names ses_other. Running
    // that line would resume a conversation nothing proved and destroy this one: the stop is
    // not made, and the fresh start stays the caller's explicit --abandon.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume ses_other',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('resume ses_other');
    expect(io.err).toContain('worker: its recorded launcher does not select the recorded conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)');
  });

  test('a recorded launcher that resumes --last is refused before the stop', async () => {
    // A selection that names no id cannot be told from the bound one. It is not run.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume --last',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.runs.join('\n')).not.toContain('--last');
    expect(io.err).toContain('worker: its recorded launcher does not select the recorded conversation; left as it is (its launch line names a conversation of its own: clear that selection from its launch line for a fresh start)');
  });

  test('a CLI with no resume form is refused before the stop, its conversation unresumable', async () => {
    // Cursor has no measured resume form: a recorded conversation has no launch line to carry it.
    // Stopping the seat would destroy it, so the stop is not made and --abandon is named.
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      cli: 'cursor',
      model: 'Grok',
      version: '4.7',
      yaml: CURSOR_TEAM_YAML,
      launch: 'cursor-agent --model cursor-model',
      launched: true,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.runs).toEqual([]);
    expect(io.err).toContain('worker: its recorded conversation cannot be resumed (its launch line has no measured resume form); left as it is (team restart worker --abandon for a fresh start)');
  });

  test('a CLI with no resume form starts fresh once the caller abandons the conversation', async () => {
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      cli: 'cursor',
      model: 'Grok',
      version: '4.7',
      yaml: CURSOR_TEAM_YAML,
      launch: 'cursor-agent --model cursor-model',
      foregroundArgv0: 'cursor-agent',
      newPaneScreen: CURSOR_IDLE,
      launched: true,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--abandon'], io, run.sources)).toBe(0);
    // The stop is made and the record's own line runs, with no resume word on it.
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).toContain('cursor-agent --model cursor-model');
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (its launch line has no measured resume form)');
  });

  test('a recorded launcher that already names the bound id resumes it unchanged', async () => {
    // No second resume word: the line's own selection is the one the record binds.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume ses_codex',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    const runs = run.did.runs.join('\n');
    expect(runs).toContain('codex -m gpt-6.1-sol resume ses_codex');
    expect(runs.split('resume ses_codex').length - 1).toBe(1);
    expect(io.err).toBe('');
  });

  test('--abandon refuses a launch line that itself names another conversation, before the stop', async () => {
    // The recorded launcher pins a conversation of its own. `--abandon` is the caller's fresh
    // start, and a fresh start cannot run that line: the stop is not made and nothing is typed.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume ses_other',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker', '--abandon'], io, run.sources);
    // The argv assertion leads: a red run quotes the line the flag would have run.
    expect(run.did.runs).toEqual([]);
    expect(code).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.typed).toEqual([]);
    expect(io.err).toContain('worker: its launch line itself names a conversation, so --abandon cannot start a fresh one; left as it is (clear the resume selection from its launch line for a fresh start)');
  });

  test('--abandon refuses a launch line that itself names the recorded conversation, before the stop', async () => {
    // Fresh means fresh: a line the caller's flag cannot make conversation-free is not run, even
    // when the id it names is the recorded one.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume ses_codex',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker', '--abandon'], io, run.sources);
    expect(run.did.runs).toEqual([]);
    expect(code).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(io.err).toContain('worker: its launch line itself names a conversation, so --abandon cannot start a fresh one; left as it is (clear the resume selection from its launch line for a fresh start)');
  });

  test('--abandon on a plain launch line starts the seat fresh: no recorded id is added', async () => {
    // The id the records bind is not put on a line the caller abandons. The recorded launcher
    // runs as it is, which starts a fresh conversation.
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_codex', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--abandon'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).not.toContain('resume');
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol');
  });

  test('a restored Codex seat running another conversation is still left as it is', async () => {
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_other', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(io.err).toContain('has a process in its old pane that is not the signed seat; left as it is');
  });

  test('--abandon replaces a doubt pane herdr names on the recorded pane, without typing', async () => {
    // The live reviewer shape: herdr names the seat on its recorded pane, the pids are not the
    // launched ones, and no recorded session can prove what came back. The caller's own
    // `--abandon` takes the pane: it is closed without a key, and the launcher starts a fresh one.
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_other', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.screenText = (_session, pane) => (pane === 'pane-old' ? CODEX_OLD_IDLE : CODEX_NEW_IDLE);
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--abandon'], io, run.sources)).toBe(0);
    expect(run.did.typed).toEqual([]);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol');
    // The live pane runs another conversation, so that id is not resumed; the run says so and
    // the flag's fresh start goes ahead.
    expect(run.did.runs.join('\n')).not.toContain('resume ses_');
    expect(io.err).toContain('worker: not resuming its recorded session (its live agent session is not the recorded one)');
  });

  test('--abandon still leaves a doubt pane herdr does not name as this seat', async () => {
    // The process on the recorded pane is not tied to the seat by herdr, so even the explicit
    // flag has nothing to take: closing it could end a stranger's turn.
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_other', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.agents = () => [{
      name: 'worker', agent: 'codex', pane: 'pane-else', workspace: 'ws-else', status: 'idle', cwd: fixture.root, session: 'ses_other',
    }];
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--abandon'], io, run.sources)).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(io.err).toContain('has a process in its old pane that is not the signed seat; left as it is');
  });

  test('the plain refusal names --abandon when herdr names the seat on the recorded pane', async () => {
    const { fixture, run } = seeded({ registry: 'ses_codex', declaredCli: 'codex', workerSession: 'ses_other', launched: true });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--json'], io, run.sources)).toBe(1);
    const doc = JSON.parse(io.out) as { error: { id: string; repair: string | null } };
    expect(doc.error.id).toBe('restart.replaced');
    expect(doc.error.repair).toBe('team restart worker --abandon');
  });

  test('a state naming another session is never resumed, and the run says why', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_other' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('team restart: worker: not resuming its recorded session (the seat state and the agent record name different sessions)');
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: not resuming its recorded session (the seat state and the agent record name different sessions)');
  });

  test('a record written by another CLI is not resumed', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep', cli: 'codex' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (the record ran codex, the seat now declares claude-code)');
  });

  test('a live pane running another conversation is never resumed', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    // The pane on the recorded endpoint says it is running a different conversation: resuming the
    // recorded one would put two live copies of the seat's history beside each other.
    const listed = run.sources.agents;
    run.sources.agents = (session) => (listed(session) ?? []).map((agent) => (
      agent.name === 'worker' && agent.pane === 'pane-old' ? { ...agent, session: 'ses_live' } : agent
    ));
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (its live agent session is not the recorded one)');
  });

  test('a record that changes between the caller\'s read and the run lock is not resumed', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    // A concurrent writer lands a new conversation after the caller's own read: the state and the
    // registry now agree on another id. The run lock serializes the restart, and the binding is
    // read again under it, so what launches is the fresh conversation the records now name — never
    // the id the caller saw a moment before. The writer lands on the run's second listing, after
    // the caller's read and before the run lock's own.
    const listed = run.sources.agents;
    let calls = 0;
    let moved = false;
    run.sources.agents = (session) => {
      calls += 1;
      if (calls === 2) {
        moved = true;
        updateState(fixture.dir, (state) => {
          const seat = state.sessions.acme?.seats.worker;
          if (seat) seat.agent_session = 'ses_new';
        });
        recordAgentSession(fixture.home, agentId!, 'ses_new');
      }
      return listed(session);
    };
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(moved).toBe(true);
    expect(run.did.runs.join('\n')).not.toContain('--resume');
    expect(io.err).toContain('worker: not resuming its recorded session (the seat record changed before the launch)');
  });

  test('a dry run prints the resume the launch would use, and writes no log line', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--dry-run'], io, run.sources)).toBe(0);
    expect(io.out).toContain('--resume ses_keep');
    expect(io.out).toContain('dry run: nothing was run');
    const logged = existsSync(join(fixture.dir, 'team.log')) ? readFileSync(join(fixture.dir, 'team.log'), 'utf8') : '';
    expect(logged).not.toContain('resuming session');
    expect(run.did.created).toBe(0);
  });
});

describe('team restart machine atomicity', () => {
  test('a machine refusal under the run lock leaves the running seat and its pane untouched', async () => {
    const fixture = makeFixture(MACHINE_YAML);
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    // The live shape: the preflight reading passes, and by the time the run holds the lock
    // the OS reports critical memory pressure. The refusal must land before the stop, so the
    // seat keeps its pane and nothing is typed, closed or created.
    const readings = [ROOMY, TIGHT];
    let calls = 0;
    const { sources, did } = makeHarness(fixture, {
      machine: () => readings[Math.min(calls++, readings.length - 1)]!,
    });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: memory pressure is critical\n');
    expect(calls).toBe(2);
    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
    expect(did.runs).toEqual([]);
    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-old');
  });

  test('a reading that goes bad after the stop is never taken, so the stopped seat is not stranded', async () => {
    const fixture = makeFixture(MACHINE_YAML);
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    // The reading is honest up to the stop and bad after it: the old workspace is closed and the
    // OS now reports critical memory pressure. The launch takes no reading after the stop, so the
    // decision made before it stands and the seat comes back up.
    const reads: number[] = [];
    const { sources, did } = makeHarness(fixture, {
      machine: () => {
        reads.push(did.closed.length);
        return did.closed.length === 0 ? ROOMY : TIGHT;
      },
    });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
    // Both readings were taken while the old workspace was still open; none after the close.
    expect(reads).toEqual([0, 0]);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(did.runs.join('\n')).toContain('claude --model claude-opus-5-5');
    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
  });
});
