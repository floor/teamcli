// Independent synthetic scenes for the retired Codex feature override and the settings dialog it
// leaves behind. A recorded false recipe sheds exactly that pair wherever a relaunch reads it,
// and refuses before closing anything when the line cannot prove the shed. A pane sitting on the
// dialog is closed and relaunched with zero typed or keyed input by `up` (same pane id, or a pane
// id the host moved) and by `restart`, the conversation is resumed, the managed endpoint is fresh,
// and `status` names the exact state. Every gate the close asks is judged negatively too: a
// working pane, a working screen that quotes the dialog, another conversation, another process,
// a seat that leads the team, and a non-Codex CLI never close. All names are synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { approvalOf, verifiedOf } from '../src/approve/approval.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { codexEndpointSocket } from '../src/launch/codex-endpoint.ts';
import { currentCodexRecipe, seatPins, seatPinWords } from '../src/launch/features.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { launchCommandOrRefusal, pinnedRecordLine, profileFor } from '../src/profiles/profile.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { fixtureBase, gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-09T00:00:00Z');
const SESSION = 'harbor';
const CONVERSATION = 'conversation-kelvin';
const PANE = 'pane-kelvin';
const PANE_MOVED = 'pane-kelvin-moved';
const WS = 'ws-kelvin';
const BINDING = 'prs_0123456789ab';
// The retired pair, spelled as the old recipe recorded it.
const PAIR = 'features.mcp_oauth_refresh_coordination=false';
const RECIPE_OLD = `codex -m gpt-6.1-sol -c ${PAIR}`;
// A line whose key the reader can find but whose words it cannot prove: the shell computes the
// value, so no span is safe to rewrite.
const RECIPE_UNSAFE = 'codex -m gpt-6.1-sol -c features.mcp_oauth_refresh_coordination=$(printf x)';

// Codex's startup dialog, the profile's not-started screen: the title once, then the option rows,
// the marker on the first. A title alone is not that screen.
const FEATURE_SCREEN = [
  '',
  '  Background server has incompatible feature settings',
  '',
  '  The running background server was started with different feature settings.',
  '',
  '› 1. Run without daemon this time',
  '  2. Restart with these settings',
  '  3. Cancel',
  '',
  '  Press enter to confirm or esc to cancel',
].join('\n');
// The same dialog quoted inside a running turn: the pane works, so it is never the dialog.
const WORKING_QUOTE = `${FEATURE_SCREEN}\n  esc to interrupt\n`;

// Codex's own idle screen, captured from codex 0.161.0, naming this scene's model: what a
// relaunched pane draws when it is ready.
const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol').replace('GPT-5.6-Terra', 'GPT-6.1-Sol');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---- the recipe reader -----------------------------------------------------------------------

describe('the recorded recipe sheds exactly the retired pair', () => {
  test('a separate -c pair goes, everything else stays byte for byte', () => {
    expect(currentCodexRecipe(`codex -m gpt-6.1-sol -c ${PAIR} --no-alt-screen`)).toBe('codex -m gpt-6.1-sol --no-alt-screen');
  });

  test('a --config pair and an inline --config= pair both go', () => {
    expect(currentCodexRecipe(`codex --config ${PAIR} -m gpt-6.1-sol`)).toBe('codex -m gpt-6.1-sol');
    expect(currentCodexRecipe(`codex --config=${PAIR} -m gpt-6.1-sol`)).toBe('codex -m gpt-6.1-sol');
    expect(currentCodexRecipe(`codex -c ${PAIR} --config=${PAIR} -m gpt-6.1-sol`)).toBe('codex -m gpt-6.1-sol');
  });

  test('a quoted value loses its quotes with the pair', () => {
    expect(currentCodexRecipe(`codex -c '${PAIR}' -m gpt-6.1-sol`)).toBe('codex -m gpt-6.1-sol');
  });

  test('a quoted script keeps its wrapper and its quoting', () => {
    expect(currentCodexRecipe(`sh -c 'codex -c ${PAIR} -m gpt-6.1-sol'`)).toBe(`sh -c 'codex -m gpt-6.1-sol'`);
  });

  test('a pair after the CLI delimiter is prompt text and stays', () => {
    const line = `codex -m gpt-6.1-sol -- -c ${PAIR}`;
    expect(currentCodexRecipe(line)).toBe(line);
  });

  test('a true value and another feature stay', () => {
    const trueLine = 'codex -c features.mcp_oauth_refresh_coordination=true -m gpt-6.1-sol';
    expect(currentCodexRecipe(trueLine)).toBe(trueLine);
    expect(currentCodexRecipe(`codex -c features.other_switch=false -c ${PAIR} -m gpt-6.1-sol`))
      .toBe('codex -c features.other_switch=false -m gpt-6.1-sol');
  });

  test('a line with no key is unchanged, and an unreadable line with the key is refused', () => {
    expect(currentCodexRecipe('codex -m gpt-6.1-sol')).toBe('codex -m gpt-6.1-sol');
    expect(currentCodexRecipe(`codex -c '${PAIR}`)).toBeNull();
    expect(currentCodexRecipe(RECIPE_UNSAFE)).toBeNull();
  });

  test('the profile pins only computer and browser use off, and the record line sheds the pair', () => {
    expect(seatPinWords(seatPins(profileFor('codex'), false))).toEqual([
      '-c', 'features.computer_use=false', '-c', 'features.browser_use=false',
      '-c', 'features.browser_use_external=false', '-c', 'features.in_app_browser=false', '-c', 'features.browser_use_full_cdp_access=false', '-c', 'mcp_servers.cua_repl.command=/usr/bin/false', '-c', 'mcp_servers.cua_repl.enabled=false', '-c', 'mcp_servers.node_repl.command=/usr/bin/false', '-c', 'mcp_servers.node_repl.enabled=false', '-c', 'plugins.computer-use@openai-bundled.enabled=false', '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false', '-c', 'plugins.browser@openai-bundled.enabled=false',
    ]);
    expect(pinnedRecordLine('codex', RECIPE_OLD, [])).toBe('codex -m gpt-6.1-sol');
  });

  test('the launch command migrates a safe recipe and refuses an unsafe one before launching', () => {
    const profile = profileFor('codex');
    if (profile === null) throw new Error('the codex profile is missing');
    const migrated = launchCommandOrRefusal(profile, RECIPE_OLD, '');
    expect(migrated.refusal).toBeUndefined();
    expect(migrated.command).toContain('codex -m gpt-6.1-sol');
    expect(migrated.command).not.toContain('mcp_oauth_refresh_coordination');
    const refused = launchCommandOrRefusal(profile, RECIPE_UNSAFE, '');
    expect(refused.command).toBe('');
    expect(refused.refusal).toBe('its obsolete Codex feature override cannot be safely removed from its launch line; update that recipe before restarting');
  });
});

// ---- shared fixture helpers ------------------------------------------------------------------

function harborYaml(root: string, home: string, kelvinLead: boolean, kelvinLaunch: string): string {
  // `team status` resolves its lobby from the running HOME, not from a source it is handed, so
  // the trust list carries that lobby beside the fixture's own.
  const runningHome = process.env.HOME;
  return `format: 1
project: harbor
coordinator: ${kelvinLead ? 'kelvin' : 'marla'}
operator: ${kelvinLead ? 'kelvin' : 'marla'}
session: harbor
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobbyDir(home))}
  - ${JSON.stringify(root)}${runningHome && lobbyDir(runningHome) !== lobbyDir(home) ? `\n  - ${JSON.stringify(lobbyDir(runningHome))}` : ''}
seats:
  - role: coordinator
    name: marla
    label: marla
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: kelvin
    label: kelvin
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: ${JSON.stringify(kelvinLaunch)}
`;
}

type World = { base: string; root: string; home: string; dir: string; file: string; yaml: string };

/** A fixture checkout with the harbor team on disk, approved, and kelvin recorded in the registry
 *  and the seat state with its conversation and launch identity. */
function world(opts: { kelvinLead?: boolean; kelvinLaunch?: string; registryLaunch?: string; pane?: string; noConversation?: boolean; noRegistryLaunch?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'cdp-')));
  made.push(base);
  const root = join(base, 'harbor');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
    stdio: 'ignore',
  });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  // The lobby the gate trusts must carry the mode a real one has.
  chmodSync(lobbyDir(home), 0o700);
  // The lobby of the running HOME is listed too, for the commands that resolve it themselves.
  const runningHome = process.env.HOME;
  if (runningHome && lobbyDir(runningHome) !== lobbyDir(home)) {
    mkdirSync(lobbyDir(runningHome), { recursive: true, mode: 0o700 });
    chmodSync(lobbyDir(runningHome), 0o700);
  }
  const yaml = harborYaml(root, home, opts.kelvinLead ?? false, opts.kelvinLaunch ?? RECIPE_OLD);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
    loaded.team.seats,
    home,
  );
  const id = teamIdOf(root);
  const marla = registerAgent(home, {
    name: 'Marla', signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' }, lab: 'test-lab',
    cli: 'claude-code', launcher: null, launch: 'claude --model claude-opus-5-5',
    reach: { team: id, seat: 'marla', session: SESSION, pane: 'pane-marla', address: null }, mcp: [], skills: [],
    lifecycle: 'running', by: 'team up',
  });
  const kelvin = registerAgent(home, {
    name: 'Kelvin', signing: { model: 'GPT Sol', version: '6.1', role: 'implementer' }, lab: 'test-lab',
    cli: 'codex', launcher: null, launch: opts.noRegistryLaunch ? '' : opts.registryLaunch ?? RECIPE_OLD,
    reach: {
      team: id, seat: 'kelvin', session: SESSION, pane: opts.pane ?? PANE, address: null,
      ...(opts.noConversation ? { agent_session: null } : { agent_session: CONVERSATION }),
    },
    mcp: [], skills: [], lifecycle: 'running', by: 'team up',
  });
  upsertTeam(home, id, {
    project: 'harbor', session: SESSION, root, lobby: lobbyDir(home),
    roster: [
      { agent: marla.id, seat: 'marla', role: 'coordinator', leads: true },
      { agent: kelvin.id, seat: 'kelvin', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats.marla = { stage: 'ready', pane: 'pane-marla', workspace: 'ws-marla', id: 'seat_marlarecord' };
    session.seats.kelvin = {
      stage: 'ready',
      pane: opts.pane ?? PANE,
      workspace: WS,
      id: 'seat_kelvinrecord',
      launched: { shell: 100, cli: [200] },
      ...(opts.noConversation ? {} : { agent_session: CONVERSATION }),
    };
  });
  return { base, root, home, dir, file, yaml };
}

function ownedEndpointUrl(dir: string): string {
  const socket = codexEndpointSocket(dir, SESSION, 'kelvin', BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

/** What a real managed Codex launch leaves on the seat: a fresh presence incarnation and the
 *  app-server endpoint recorded under it, bound to each other. */
function managedEndpoint(dir: string): NonNullable<Launch['codexEndpoint']> {
  const url = ownedEndpointUrl(dir);
  return {
    managed: async () => {
      updateState(dir, (state) => {
        const held = (state.sessions[SESSION] ??= emptySession()).seats.kelvin;
        if (held !== undefined) {
          held.presence_binding = BINDING;
          held.codex_endpoint = { url, binding: BINDING, pid: 4242, started_at: '2026-11-09T00:00:00.000Z', config: [] };
        }
      });
      return { kind: 'up' as const, url, started: true };
    },
    stop: () => ({ stopped: true }),
  } as unknown as NonNullable<Launch['codexEndpoint']>;
}

// ---- team up ---------------------------------------------------------------------------------

type UpDid = { typed: string[]; pasted: string[]; keys: string[]; enters: string[]; closed: string[]; created: string[]; runs: string[] };

type UpShape = {
  /** The live agents the host reports, with kelvin on `kelvinPane`. */
  kelvinPane?: string;
  kelvinStatus?: string;
  kelvinSession?: string;
  screen?: string;
  processInfo?: (pane: string) => { shell: number; foreground: number[] } | null;
  foreground?: (pane: string) => string[] | null;
  endpoint?: boolean;
};

function upHost(made: World, shape: UpShape): { sources: UpSources; did: UpDid } {
  const did: UpDid = { typed: [], pasted: [], keys: [], enters: [], closed: [], created: [], runs: [] };
  const kelvinPane = shape.kelvinPane ?? PANE;
  let agents: HerdrAgent[] = [
    { name: 'marla', agent: 'claude-code', pane: 'pane-marla', workspace: 'ws-marla', status: 'idle', cwd: made.root },
    {
      name: 'kelvin', agent: 'codex', pane: kelvinPane, workspace: WS, status: shape.kelvinStatus ?? 'idle', cwd: made.root,
      session: shape.kelvinSession ?? CONVERSATION,
    },
  ];
  const fresh = new Map<string, string>();
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      const at = did.created.length + 1;
      const pane = `pane-fresh${at === 1 ? '' : `-${at}`}`;
      const workspace = `ws-fresh${at === 1 ? '' : `-${at}`}`;
      did.created.push(pane);
      fresh.set(pane, workspace);
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      if (fresh.has(pane)) {
        agents = [...agents.filter((one) => one.pane !== kelvinPane || one.name !== 'kelvin'), {
          name: 'kelvin', agent: 'codex', pane, workspace: fresh.get(pane)!, status: 'idle', cwd: made.root,
          session: CONVERSATION,
        }];
      }
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === WS) agents = agents.filter((one) => one.name !== 'kelvin');
      return true;
    },
    agentPanes: () => agents.map((one) => one.pane),
    agents: () => agents,
    paneText: (_session, pane) => (pane === kelvinPane ? shape.screen ?? FEATURE_SCREEN : CODEX_IDLE),
    typeText(_session, _pane, text) {
      if (/^\x1b\[200~[\s\S]*\x1b\[201~$/.test(text)) did.pasted.push(text);
      else did.typed.push(text);
      return true;
    },
    sendKey: (_session, _pane, key) => { did.keys.push(key); return true; },
    pressEnter: () => { did.enters.push('enter'); return true; },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (shape.foreground ? shape.foreground(pane) : pane === 'pane-marla' ? ['claude'] : ['codex']),
    processInfo: (_session, pane) => (shape.processInfo
      ? shape.processInfo(pane)
      : pane === PANE
        ? { shell: 100, foreground: [200] }
        : pane === 'pane-marla'
          ? { shell: 900, foreground: [901] }
          : { shell: 300, foreground: [301] }),
    ...(shape.endpoint ? { codexEndpoint: managedEndpoint(made.dir) } : {}),
    now: () => NOW,
    sleep: async () => {},
  };
  // The live re-check immediately before a dialog close re-reads the host through the
  // executor's wider Host type, which carries these two reads; the Launch type the up sources
  // declare does not, so they are attached past it rather than dropped from the fake.
  Object.assign(launch, {
    agentList: () => agents,
    workspacePanes: (_session: string, workspace: string) =>
      agents.filter((one) => one.workspace === workspace).map((one) => one.pane),
  });
  const doctor: DoctorSources = {
    version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
    herdrVersion: () => '0.7.1', sessionRunning: () => true, now: () => NOW, home: made.home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents,
      workspaces: () => [{ id: WS, label: 'kelvin' }, { id: 'ws-marla', label: 'marla' }],
      home: made.home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    did,
  };
}

describe('team up closes a Codex settings dialog and relaunches with zero input', () => {
  test('the recorded pane: dry run closes no option and relaunches the migrated recipe', async () => {
    const made = world();
    const { sources } = upHost(made, {});
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runUp(['--dry-run'], io, sources), `${io.out}\n${io.err}`).toBe(0);
    expect(io.out).toContain('closed without choosing a dialog option; launched again with the coordination flag');
    expect(io.out).not.toContain('send-keys');
    expect(io.out).not.toContain('mcp_oauth_refresh_coordination');
    expect(io.out).toContain('codex -m gpt-6.1-sol');
  });

  test('the recorded pane: live run types nothing, closes the workspace, resumes, and writes a fresh endpoint', async () => {
    const made = world();
    const { sources, did } = upHost(made, { endpoint: true });
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runUp([], io, sources), `${io.out}\n${io.err}`).toBe(0);
    expect(did.typed).toEqual([]);
    expect(did.pasted).toEqual([]);
    expect(did.keys).toEqual([]);
    expect(did.enters).toEqual([]);
    expect(did.closed).toEqual([WS]);
    const codexRuns = did.runs.filter((command) => command.includes('codex'));
    expect(codexRuns.some((command) => command.includes('codex -m gpt-6.1-sol') && command.includes(`resume ${CONVERSATION}`))).toBe(true);
    expect(codexRuns.every((command) => !command.includes('mcp_oauth_refresh_coordination'))).toBe(true);
    const after = readState(made.dir).sessions[SESSION]?.seats.kelvin;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-fresh');
    expect(after?.workspace).toBe('ws-fresh');
    expect(after?.launch_line ?? '').not.toContain('mcp_oauth_refresh_coordination');
    expect(after?.presence_binding).toBe(BINDING);
    expect(after?.codex_endpoint?.url).toBe(ownedEndpointUrl(made.dir));
    expect(after?.codex_endpoint?.pid).toBe(4242);
    const record = findAgent(made.home, { team: teamIdOf(made.root), seat: 'kelvin' });
    expect(record?.reach.agent_session).toBe(CONVERSATION);
  });

  test('a pane id the host moved: the same proof adopts it, closes without input, and relaunches', async () => {
    const made = world();
    const { sources, did } = upHost(made, {
      kelvinPane: PANE_MOVED,
      kelvinSession: CONVERSATION,
      processInfo: (pane) => (pane === PANE ? null : pane === PANE_MOVED ? { shell: 101, foreground: [201] } : { shell: 300, foreground: [301] }),
      foreground: (pane) => (pane === PANE ? null : pane === 'pane-marla' ? ['claude'] : ['codex']),
    });
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runUp([], io, sources), `${io.out}\n${io.err}`).toBe(0);
    expect(did.typed).toEqual([]);
    expect(did.keys).toEqual([]);
    expect(did.closed).toEqual([WS]);
    expect(did.runs.some((command) => command.includes('codex -m gpt-6.1-sol') && command.includes(`resume ${CONVERSATION}`))).toBe(true);
    const after = readState(made.dir).sessions[SESSION]?.seats.kelvin;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-fresh');
  });

  test('an unsafe recipe refuses before anything is closed', async () => {
    // The registry record's own line is unreadable and a conversation is recorded: the resume
    // carry is judged ahead of the launch, and the seat is skipped whole — the close step never
    // renders, so the stale dialog pane is never closed over an unreadable recipe.
    const made = world({ registryLaunch: RECIPE_UNSAFE });
    const { sources } = upHost(made, {});
    const io = testIo(made.root, { kind: 'owner' });
    await runUp(['--dry-run'], io, sources);
    expect(io.out + io.err).toContain('its recorded conversation cannot be resumed');
    expect(io.out + io.err).toContain('no measured resume form');
    expect(io.out).not.toContain('closed without choosing a dialog option');
    expect(io.out).not.toContain(`workspace close ${WS}`);
  });

  test('no gate, no close: working, quoted-working, another conversation, another process, a lead, a non-Codex CLI', async () => {
    const cases: { name: string; shape: UpShape }[] = [
      { name: 'herdr says the pane works', shape: { kelvinStatus: 'working' } },
      { name: 'a working screen quotes the dialog', shape: { screen: WORKING_QUOTE } },
      { name: 'the pane holds another conversation', shape: { kelvinSession: 'conversation-other' } },
      { name: 'the pane holds no readable process', shape: { processInfo: () => null } },
      { name: 'the foreground program is not the CLI', shape: { foreground: () => ['zsh'] } },
    ];
    for (const one of cases) {
      const made = world();
      const { sources } = upHost(made, one.shape);
      const io = testIo(made.root, { kind: 'owner' });
      await runUp(['--dry-run'], io, sources);
      expect(io.out, one.name).not.toContain('closed without choosing a dialog option');
    }

    // The seat that leads this team is excluded from the automatic dialog cycle.
    const lead = world({ kelvinLead: true });
    const leadRun = upHost(lead, {});
    const leadIo = testIo(lead.root, { kind: 'owner' });
    await runUp(['--dry-run'], leadIo, leadRun.sources);
    expect(leadIo.out).not.toContain('closed without choosing a dialog option');
  });
});

// ---- team restart ----------------------------------------------------------------------------

type RestartDid = UpDid & { renamed: { pane: string; name: string }[] };

function restartHost(made: World, opts: { screen?: string; upProcess?: (pane: string) => { shell: number; foreground: number[] } | null } = {}): { sources: RestartSources; did: RestartDid } {
  const did: RestartDid = { typed: [], pasted: [], keys: [], enters: [], closed: [], created: [], runs: [], renamed: [] };
  let kelvinAlive = true;
  let kelvinPaneNow = PANE;
  const agents = (): HerdrAgent[] => [
    { name: 'marla', agent: 'claude-code', pane: 'pane-marla', workspace: 'ws-marla', status: 'idle', cwd: made.root },
    ...(kelvinAlive
      ? [{
          name: 'kelvin', agent: 'codex', pane: kelvinPaneNow,
          workspace: kelvinPaneNow === PANE ? WS : 'ws-fresh', status: 'idle', cwd: made.root, session: CONVERSATION,
        } as HerdrAgent]
      : []),
  ];
  const downLaunch: DownLaunch = {
    typeText(_session, _pane, text) { did.typed.push(text); return true; },
    sendKey: (_session, _pane, key) => { did.keys.push(key); return true; },
    pressEnter: () => { did.enters.push('enter'); return true; },
    agentPanes: () => agents().map((one) => one.pane),
    closeWorkspace(_session, workspace) {
      did.closed.push(workspace);
      if (workspace === WS) kelvinAlive = false;
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
    createWorkspace() { did.created.push('pane-fresh'); return { pane: 'pane-fresh', workspace: 'ws-fresh' }; },
    paneRun(_session, pane, command) { did.runs.push(command); kelvinAlive = true; kelvinPaneNow = pane; return true; },
    renameAgent(_session, pane, name) { did.renamed.push({ pane, name }); return true; },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((one) => one.pane),
    agents: () => agents(),
    paneText: (_session, pane) => (pane === PANE ? opts.screen ?? FEATURE_SCREEN : CODEX_IDLE),
    typeText(_session, _pane, text) {
      if (/^\x1b\[200~[\s\S]*\x1b\[201~$/.test(text)) did.pasted.push(text);
      else did.typed.push(text);
      return true;
    },
    sendKey: downLaunch.sendKey,
    pressEnter: downLaunch.pressEnter,
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-marla' ? ['claude'] : ['codex']),
    processInfo: (_session, pane) => (opts.upProcess ? opts.upProcess(pane) : pane === PANE ? { shell: 100, foreground: [200] } : { shell: 300, foreground: [301] }),
    codexEndpoint: managedEndpoint(made.dir),
    now: () => NOW,
    sleep: async () => {},
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288', onPath: () => true, loggedIn: () => true,
    herdrVersion: () => '0.7.1', sessionRunning: () => true, now: () => NOW, home: made.home,
  };
  return {
    sources: {
      home: made.home,
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => agents(),
      workspaces: () => [{ id: WS, label: 'kelvin' }, { id: 'ws-marla', label: 'marla' }],
      alive: () => true,
      screen: () => ({ kind: 'idle' }),
      screenText: (_session, pane) => (pane === PANE ? opts.screen ?? FEATURE_SCREEN : CODEX_IDLE),
      status: () => 'idle',
      foreground: (_session, pane) => (pane === 'pane-marla' ? ['claude'] : ['codex']),
      now: () => NOW,
      sleep: async () => {},
      launch: downLaunch,
      upLaunch,
      doctor,
    },
    did,
  };
}

describe('team restart closes the dialog with no input and relaunches the migrated recipe', () => {
  test('no exit text, no key, no option: the workspace closes and the conversation resumes', async () => {
    const made = world();
    const { sources, did } = restartHost(made, {});
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runRestart(['kelvin'], io, sources), `${io.out}\n${io.err}`).toBe(0);
    expect(did.typed).toEqual([]);
    expect(did.pasted).toEqual([]);
    expect(did.keys).toEqual([]);
    expect(did.enters).toEqual([]);
    expect(did.closed).toEqual([WS]);
    expect(io.out).toContain('input box: not read (Codex settings dialog; closed without input)');
    expect(io.out).toContain('restarted kelvin; pane pane-kelvin -> pane-fresh');
    expect(did.runs.some((command) => command.includes('codex -m gpt-6.1-sol') && command.includes(`resume ${CONVERSATION}`))).toBe(true);
    expect(did.runs.every((command) => !command.includes('mcp_oauth_refresh_coordination'))).toBe(true);
    const after = readState(made.dir).sessions[SESSION]?.seats.kelvin;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-fresh');
    expect(after?.launched).toEqual({ shell: 300, cli: [301] });
    expect(after?.presence_binding).toBe(BINDING);
    expect(after?.codex_endpoint?.url).toBe(ownedEndpointUrl(made.dir));
    const record = findAgent(made.home, { team: teamIdOf(made.root), seat: 'kelvin' });
    expect(record?.reach.agent_session).toBe(CONVERSATION);
  });

  test('an unreadable recipe refuses before the pane is closed', async () => {
    // No conversation is bound and the registry records no launch line, so the declared line is
    // the one the relaunch would run: the recipe gate is the first refusal the run meets, the
    // sentence names the recipe, and nothing is closed.
    const made = world({ kelvinLaunch: RECIPE_UNSAFE, noConversation: true, noRegistryLaunch: true });
    const { sources, did } = restartHost(made, {});
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runRestart(['kelvin'], io, sources)).toBe(1);
    expect(io.err + io.out).toContain('its obsolete Codex feature override cannot be safely removed from its launch line; update that recipe before restarting');
    expect(did.closed).toEqual([]);
    expect(did.typed).toEqual([]);
    expect(did.created).toEqual([]);
    expect(readState(made.dir).sessions[SESSION]?.seats.kelvin?.pane).toBe(PANE);
  });

  test('a bound conversation on an unreadable recipe is refused before anything is closed', async () => {
    // The recorded conversation is carried ahead of the recipe gate, and the unreadable line
    // cannot carry it: the stop is never made. The refusal names the resume, and the pane is
    // left exactly as it was.
    const made = world({ registryLaunch: RECIPE_UNSAFE });
    const { sources, did } = restartHost(made, {});
    const io = testIo(made.root, { kind: 'owner' });
    expect(await runRestart(['kelvin'], io, sources)).toBe(1);
    expect(io.err + io.out).toContain('its recorded conversation cannot be resumed');
    expect(io.err + io.out).toContain('left as it is');
    expect(did.closed).toEqual([]);
    expect(did.typed).toEqual([]);
    expect(did.created).toEqual([]);
    expect(did.runs).toEqual([]);
    expect(readState(made.dir).sessions[SESSION]?.seats.kelvin?.pane).toBe(PANE);
  });
});

// ---- team status -----------------------------------------------------------------------------

describe('team status names the dialog exactly', () => {
  function standingFor(made: { root: string; dir: string; file: string; yaml: string }) {
    const parsed = validateTeamFile(made.yaml);
    if (!parsed.ok) throw new Error(`the fixture file does not validate: ${JSON.stringify(parsed.errors)}`);
    return verifiedOf(parsed.team, made.yaml, made.root, NOW);
  }

  function statusRun(made: World, live: { agents: HerdrAgent[]; screens: Record<string, string> }) {
    const io = testIo(made.root, { kind: 'owner' });
    const sources: StatusSources = {
      live: () => ({ running: true, agents: live.agents, workspaces: [{ id: WS, label: 'kelvin' }], screens: live.screens }),
      branch: () => 'main',
      standing: () => standingFor(made),
      now: () => NOW,
    };
    return runStatus(['--file', made.file], io, sources).then((code) => ({ code, out: io.out, err: io.err }));
  }

  const kelvinAgent = (status: string): HerdrAgent => ({
    name: 'kelvin', agent: 'codex', pane: PANE, workspace: WS, status, cwd: null,
  });

  test('an idle codex seat on the dialog gets the exact state and the restart repair', async () => {
    const made = world();
    const run = await statusRun(made, { agents: [kelvinAgent('idle')], screens: { [PANE]: FEATURE_SCREEN } });
    // A seat on the dialog is a difference, so the report exits nonzero while naming it.
    expect(run.code, `status err: ${run.err}`).toBe(1);
    expect(run.out).toContain('Codex settings dialog');
    expect(run.out).toContain('team restart kelvin');
    expect(run.out).not.toContain('team down, then team up');
  });

  test('a lead seat on the dialog gets the whole-team repair instead', async () => {
    const made = world({ kelvinLead: true });
    const run = await statusRun(made, { agents: [kelvinAgent('idle')], screens: { [PANE]: FEATURE_SCREEN } });
    expect(run.out).toContain('Codex settings dialog');
    expect(run.out).toContain('team down, then team up (to restart the whole team)');
  });

  test('a working pane or a working screen that quotes the dialog is not the dialog', async () => {
    const working = world();
    const workingRun = await statusRun(working, { agents: [kelvinAgent('working')], screens: { [PANE]: FEATURE_SCREEN } });
    expect(workingRun.out).not.toContain('Codex settings dialog');

    const quoted = world();
    const quotedRun = await statusRun(quoted, { agents: [kelvinAgent('idle')], screens: { [PANE]: WORKING_QUOTE } });
    expect(quotedRun.out).not.toContain('Codex settings dialog');
  });
});
