import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Caller, CallerSources } from '../src/caller.ts';
import { standingOf } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { realSources as restartRealSources, runRestart, USAGE, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { noteLaunchedPane } from '../src/file/launched-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { acquireRunLock } from '../src/launch/run-lock.ts';
import { codexEndpointSocket } from '../src/launch/codex-endpoint.ts';
import { seatDeliveryClass } from '../src/launch/delivery-class.ts';
import type { Machine } from '../src/watch/machine.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { markStopped, seatIsStopped } from '../src/file/lines.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readTeamText, writeTeamText } from '../src/file/team-text.ts';
import { RESTART_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { findAgent, readAgents, recordAgentSession, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { setRoster, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { approvalOf } from '../src/approve/approval.ts';
import { unverifiedRecordSentence } from '../src/approve/unverified-record.ts';
import { recordedGeneration } from '../src/store/keys.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gateVerdict } from '../src/permissions/who.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, shortSocketBase, testIo } from './helpers.ts';
import { intoRegistry, storedTeam, underRegistry, unreadableRegistryFolder } from './helpers/registry-team.ts';
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
// Grok's own screens. The idle footer names Grok 4.7, the model this scene's file declares.
const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.52/idle.txt', import.meta.url), 'utf8');
const GROK_EXIT_TYPED = readFileSync(new URL('./fixtures/grok/1.0.52/exit-typed.txt', import.meta.url), 'utf8');
const GROK_SESSION = '7c2e9a14-6b0d-4f83-9a21-0d5e8c3b71a6';

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

// The target team of the entity-reach scenes: one entity's project team, its own lead seat named
// exactly as the entity's main orchestrator is. A restart of that seat, run from the main
// orchestrator, is the pair a name comparison refuses.
function crossTeamTargetYaml(entity: string): string {
  return TEAM_YAML
    .replace('coordinator: lead', 'coordinator: orchestrator')
    .replace('    name: lead\n', '    name: orchestrator\n')
    .replace('workspace:\n', `entity: ${entity}\nworkspace:\n`);
}

// The entity's head team: the team whose project is the entity itself (`onMainCoordinator`'s
// place), its own lead seat named `orchestrator` too. The lead may be spelled either way the
// file allows — the legacy `coordinator:` key, or `leads: true` on the seat.
function headTeamYaml(project: string, entity: string, lead: 'coordinator' | 'leads' = 'coordinator'): string {
  const leadKey = lead === 'coordinator' ? 'coordinator: orchestrator\n' : '';
  const leadMark = lead === 'leads' ? '    leads: true\n' : '';
  return `format: 1
project: ${project}
${leadKey}operator: ops
entity: ${entity}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
${leadMark}    cli: claude-code
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
`;
}

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

// The same team with a Grok worker. Resume is `-r <id>` on the launch line, read from the
// registry's reach.agent_session the way an Antigravity seat's conversation flag is.
const GROK_TEAM_YAML = TEAM_YAML.replace(
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
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    launch: grok`,
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
  // The state folder sits under the short socket base so the endpoint path a managed launch owns
  // for this seat (`<dir>/run/<session>/<seat>/<binding>.sock`) stays inside the socket path
  // limit; the scene below measures that path against the limit.
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'tr-')));
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
  // A team that names an entity trusts its entity's lobby, and the loader says so: the injected
  // block lists it beside the default lobby.
  const entity = /^entity:[ \t]*(\S+)/m.exec(rawYaml)?.[1];
  const entityLobby = entity && entity !== 'null' ? `  - ~/.config/team/lobbies/${entity.toLowerCase()}\n` : '';
  const yaml = rawYaml.includes('trust:')
    ? rawYaml
    : rawYaml.replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n${entityLobby}  - ${root}\nworkspace:\n`);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yaml);
  return { base, root, home, file, dir, yaml };
}

/** The team before its implementer seats were added: the file a session launched earlier still
 *  points at. `worker` is undeclared there, as today's seats are in a retired file. */
function olderTeamYaml(yaml: string): string {
  const cut = yaml.indexOf('\n  - role: implementer');
  if (cut < 0) throw new Error('the fixture team names no implementer to leave out');
  return yaml.slice(0, cut);
}

/** The entity's head team beside a target fixture: its own checkout, its live file, and the
 *  folder its state is written to — the three records a main-orchestrator proof reads. */
function makeHeadTeam(base: string, project: string, entity: string, lead: 'coordinator' | 'leads' = 'coordinator'): { root: string; dir: string; session: string } {
  const root = join(base, project);
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  const yaml = headTeamYaml(project, entity, lead).replace(
    'workspace:\n',
    `trust:\n  - ~/.config/team/lobby\n  - ~/.config/team/lobbies/${entity.toLowerCase()}\n  - ${root}\nworkspace:\n`,
  );
  writeFileSync(join(dir, 'team.yaml'), yaml);
  return { root, dir, session: project };
}

/** The pane the head team's own launch recorded for its orchestrator: the proof's last step. */
function recordMainOrchestrator(dir: string, session: string, pane: string): void {
  updateState(dir, (state) => {
    const held = (state.sessions[session] ??= emptySession());
    held.seats.orchestrator = { stage: 'ready', pane, workspace: 'ws-main' };
  });
}

/**
 * The caller's walk as one shared herdr session shows it: the entity's main orchestrator on its
 * own pane, and the target team's seats beside it. Only the main orchestrator's pane root is
 * among the caller's ancestors, so the walk places the caller on that pane whatever session is
 * asked about; the target team's own `orchestrator` seat sits on a pane the walk never claims.
 */
function sharedFleetSources(options: { headPane: string; headRoot: string; targetRoot: string }): () => CallerSources {
  const agents: HerdrAgent[] = [
    { name: 'orchestrator', agent: 'claude-code', pane: options.headPane, workspace: 'ws-main', status: 'idle', cwd: options.headRoot },
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: options.targetRoot },
    { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: options.targetRoot },
    { name: 'orchestrator', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: options.targetRoot },
  ];
  return () => ({
    ancestors: () => [{ pid: 501, name: 'zsh' }, { pid: 500, name: 'herdr' }],
    agents: () => agents,
    paneRootPid: (pane) => (pane === options.headPane ? 501 : null),
    env: {},
    stdinIsTTY: false,
  });
}

/** The process sources one lead seat's terminal passes down: the walk places `lead` on its pane
 *  only when asked about that seat's session, so a candidate on any other session places nobody.
 *  A scene writes these onto its own io — never a spread copy — because `testIo`'s writers close
 *  over the object they were built on, and a copy would never see the output the command wrote. */
function leadCallerSources(sessionName: string, cwd: string): (session?: string) => CallerSources {
  return (session) => ({
    ancestors: () => [
      { pid: 200, name: 'claude' },
      { pid: 100, name: 'herdr' },
    ],
    agents: () =>
      session === undefined || session === sessionName
        ? [{ name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd }]
        : [],
    paneRootPid: (pane) => (pane === 'pane-lead' ? 200 : null),
    env: { HERDR_PANE_ID: 'pane-lead' },
    stdinIsTTY: false,
  });
}

/** A registry record torn by a write that did not finish: JSON a reader cannot parse. */
const CORRUPT_RECORD = '{"format": 1, "text": ';

/** Overwrites the registry's record of the fixture team with `CORRUPT_RECORD`; its path. */
function corruptStoredTeam(fixture: Fixture): string {
  const path = join(fixture.home, '.config', 'team', 'team-config', `${teamIdOf(fixture.root)}.json`);
  writeFileSync(path, CORRUPT_RECORD);
  return path;
}

function makeHarness(
  fixture: Fixture,
  opts: {
    initialRunning?: boolean;
    workerStatus?: string;
    /** The name the faked herdr gives the third running seat; `worker` unless a scene restarts a
     *  seat whose name is another team's own (the main orchestrator's, for one). */
    workerName?: string;
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
    /** Workspace creation fails: the launch never reaches a pane. */
    createFails?: boolean;
    /** The launch command fails: the pane is there and its CLI never starts. */
    paneRunFails?: boolean;
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
        name: opts.workerName ?? 'worker',
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
      if (opts.createFails) return null;
      const pane = did.created === 1 ? 'pane-new' : `pane-new-${did.created}`;
      const workspace = did.created === 1 ? 'ws-new' : `ws-new-${did.created}`;
      newPanes.set(pane, { text: opts.newPaneScreen ?? IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      if (opts.paneRunFails) return false;
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

/** The endpoint URL a managed launch owns for this fixture's seat under `binding`. The bind reads
 *  only this URL, so a scene recording any other records an endpoint this seat's launch never
 *  started. */
function ownedEndpointUrl(fixture: Fixture, binding: string): string {
  const socket = codexEndpointSocket(fixture.dir, 'acme', 'worker', binding);
  if (socket === null) {
    const path = join(fixture.dir, 'run', 'acme', 'worker', `${binding}.sock`);
    throw new Error(`the fixture state folder is too long for an owned endpoint path: ${String(Buffer.byteLength(path))} bytes against the 100-byte limit`);
  }
  return socket.url;
}

/** What a real managed Codex launch leaves on the seat: a fresh presence incarnation and the
 *  app-server endpoint recorded under it, bound to each other. */
function managedEndpoint(fixture: Fixture, binding: string): NonNullable<Launch['codexEndpoint']> {
  const url = ownedEndpointUrl(fixture, binding);
  return {
    managed: async () => {
      updateState(fixture.dir, (state) => {
        const held = (state.sessions.acme ??= emptySession()).seats.worker;
        if (held !== undefined) {
          held.presence_binding = binding;
          held.codex_endpoint = {
            url,
            binding,
            pid: 4242,
            started_at: '2026-10-31T00:00:00.000Z',
            config: [],
          };
        }
      });
      return { kind: 'up' as const, url, started: true };
    },
    stop: () => ({ stopped: true }),
  } as unknown as NonNullable<Launch['codexEndpoint']>;
}

describe('the fixture temp folder', () => {
  // Measured, not assumed: the base comes from the runtime temp folder, and the endpoint a
  // managed launch owns for this seat is a unix socket path the build refuses over 100 bytes.
  test('keeps the owned endpoint inside the socket path limit', () => {
    const fixture = makeFixture();
    const path = join(fixture.dir, 'run', 'acme', 'worker', 'prs_0123456789ab.sock');
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(100);
    expect(codexEndpointSocket(fixture.dir, 'acme', 'worker', 'prs_0123456789ab')).not.toBeNull();
  });
});

describe('team restart <seat>', () => {
  test('owner restarts a free running seat, prints pre-close facts, updates state, and does not edit team.yaml', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    const { sources, did } = makeHarness(fixture);
    // The relaunched pane's own reading: a shell and the CLI in front of it. The restart writes
    // it as the seat's new identity — the write `team register` may repeat, never make.
    sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('worker: input box: empty\n');
    expect(io.out).toContain('worker: turn: not working (free)\n');
    expect(io.out).toContain('worker: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript; no recorded conversation\n');
    expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);

    const after = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
    expect(after?.id).toBe('seat_0123456789ab');
    // The launch's own write: the relaunched pane's process identity is the seat's new pane root.
    // `team register` may repeat this record; only a launch the daemon started (or the owner's
    // walk) makes one.
    expect(after?.launched).toEqual({ shell: 300, cli: [301] });

    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('restart [owner] restarted worker; pane pane-old -> pane-new\n');
  });

  // The launch wrote the state and the registry write that binds the seat to it failed. The seat
  // is ready but reachable only by pull, and the result says so instead of reporting a restart
  // whose native delivery was never written.
  test('a ready restart says pull-only when the final binding could not be written', async () => {
    function blocked(): { fixture: Fixture; io: ReturnType<typeof testIo> } {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
      });
      // The registry folder this run would write the agent record into is a file.
      mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
      writeFileSync(join(fixture.home, '.config', 'team', 'agents'), 'synthetic blocked registry');
      return { fixture, io: testIo(fixture.root, { kind: 'owner' }) };
    }

    const plain = blocked();
    expect(await runRestart(['worker'], plain.io, makeHarness(plain.fixture).sources)).toBe(0);
    expect(plain.io.err).toBe('');
    expect(plain.io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new; pull-only: no agent record for this seat\n');

    const json = blocked();
    expect(await runRestart(['worker', '--json'], json.io, makeHarness(json.fixture).sources)).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string; version: number };
      status: string;
      action_summary: string;
      seat: string;
      pull_only?: string | null;
    }>(json.io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.pull_only).toBe('no agent record for this seat');
    expect(doc.action_summary).toContain('pull-only: no agent record for this seat');
  });

  // The automatic order pass hangs off the ready exit only: a ready restart offers the
  // sidebar to it once (its hint rides the notes), and a dry run never does.
  test('a ready restart offers the sidebar to the automatic order pass; a dry run does not', async () => {
    const calls: string[] = [];
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const io = testIo(fixture.root, { kind: 'owner' });
    const sources = {
      ...makeHarness(fixture).sources,
      autoOrder: (input: { session: string; manage: boolean }) => {
        calls.push(`${input.session}:${input.manage}`);
        return 'the sidebar is out of roster order; run team order once its tail is idle';
      },
    };
    expect(await runRestart(['worker', '--json'], io, sources)).toBe(0);
    expect(calls).toEqual(['acme:true']);
    const doc = JSON.parse(io.out) as { notes?: string[] };
    expect(doc.notes?.some((note) => note.includes('run team order'))).toBe(true);

    const dryFixture = makeFixture();
    updateState(dryFixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const dryIo = testIo(dryFixture.root, { kind: 'owner' });
    const drySources = { ...makeHarness(dryFixture).sources, autoOrder: sources.autoOrder };
    expect(await runRestart(['worker', '--dry-run'], dryIo, drySources)).toBe(0);
    expect(calls).toEqual(['acme:true']);
  });

  // The Codex native route is addressed by the conversation the seat holds (`codex queue
  // --thread <agent_session>`), so the record alone does not make native delivery possible: a
  // relaunch whose new pane has not reported its session yet ends ready and says pull-only with
  // the reader's own reason. The registry writes themselves succeed here — what is missing is the
  // binding the route resolves.
  test('a Codex restart whose new pane has not reported its session says pull-only', async () => {
    function unsettled(): { fixture: Fixture; run: ReturnType<typeof makeHarness>; io: ReturnType<typeof testIo> } {
      const fixture = makeFixture(CODEX_TEAM_YAML);
      updateState(fixture.dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
      });
      const run = makeHarness(fixture, { foregroundArgv0: 'codex', newPaneScreen: CODEX_NEW_IDLE });
      // The relaunched pane's own process state, and its agent reports no session — the reading
      // the live agent list gives before the CLI has said which conversation it is in.
      run.sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
      const agents = run.sources.upLaunch.agents;
      run.sources.upLaunch.agents = (session) => (agents(session) ?? []).map((agent) => (
        agent.pane.startsWith('pane-new') ? { ...agent, agent: 'codex' } : agent
      ));
      run.sources.screenText = (_session, pane) =>
        pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
      return { fixture, run, io: testIo(fixture.root, { kind: 'owner' }) };
    }

    const plain = unsettled();
    expect(await runRestart(['worker'], plain.io, plain.run.sources), plain.io.err).toBe(0);
    expect(plain.io.err).toBe('');
    expect(plain.io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new; pull-only: the record names no agent session\n');
    // The record the launch wrote is there; the conversation its route resolves is not.
    expect(findAgent(plain.fixture.home, { team: teamIdOf(plain.fixture.root), seat: 'worker' })?.reach.agent_session)
      .toBeUndefined();

    const json = unsettled();
    expect(await runRestart(['worker', '--json'], json.io, json.run.sources), json.io.err).toBe(0);
    const doc = assertMatchesOutputSchema<{
      status: string;
      action_summary: string;
      pull_only?: string | null;
    }>(json.io.out, RESTART_OUTPUT_SCHEMA);
    expect(doc.status).toBe('ready');
    expect(doc.pull_only).toBe('the record names no agent session');
    expect(doc.action_summary).toContain('pull-only: the record names no agent session');
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

  test('a launched pointer to an older team file does not make the registry\'s seat undeclared', async () => {
    // The shape the power-loss note measured: the session's launched pointer names a team file
    // that no longer holds today's seats, while the registry's roster still places the seat on
    // this team. The pointer is a place, not a frozen definition: the seat is declared, so the
    // restart proceeds, and the fallback is spoken aloud.
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
      { agent: 'agt_222222222222', seat: 'worker', role: 'implementer' },
    ]);

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.created).toBe(1);
    expect(io.err).toContain('reading the team registered for session acme');
  });

  test('real process sources place the caller in the registry team\'s own session', async () => {
    // No `io.caller` is handed in: the placement is the walk every command makes. Under the
    // terminal host the sessionless walk names no session, so the registry authority is asked
    // with none, and each candidate is then judged by placing the caller in that candidate's own
    // session — the session-aware walk, not the sessionless one that places nobody.
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
      { agent: 'agt_222222222222', seat: 'worker', role: 'implementer' },
    ]);

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const io = testIo(lobby);
    io.callerSources = leadCallerSources('acme', lobby);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(io.err).toContain(`reading the team registered for session acme (${fixture.root})`);
  });

  test('a seat name on two sessions\' teams resolves by placement, not by the shared name', async () => {
    // Two registry records roster `worker`, on different sessions. The caller's own state places
    // it only on acme's team, so the other session's record is dropped by placement before the
    // one-candidate rule reads anything: a shared seat name never resolves a team by itself.
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
      { agent: 'agt_222222222222', seat: 'worker', role: 'implementer' },
    ]);
    // The second session's team: a checkout of its own holding a valid file that declares the
    // same seat name, recorded against a session the caller does not stand in.
    const beta = makeFixture();
    writeFileSync(beta.file, beta.yaml.replace(/^project: acme$/m, 'project: beta'));
    const betaId = teamIdOf(beta.root);
    upsertTeam(fixture.home, betaId, { project: 'beta', session: 'beta-sess', root: beta.root, at: NOW.toISOString() });
    setRoster(fixture.home, betaId, [
      { agent: 'agt_444444444444', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_555555555555', seat: 'worker', role: 'implementer' },
    ]);

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const io = testIo(lobby);
    io.callerSources = leadCallerSources('acme', lobby);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(io.err).toContain(`reading the team registered for session acme (${fixture.root})`);
    expect(io.err).not.toContain(beta.root);
  });

  test('two registry teams on the run\'s session keep the seat refused rather than guessing', async () => {
    // Both records carry the session the run names, so neither is narrowed away: the seat is
    // refused before either file is read. A second record whose file cannot be read is still a
    // candidate — it can neither collapse the ambiguity nor be skipped in favour of the first.
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
      { agent: 'agt_222222222222', seat: 'worker', role: 'implementer' },
    ]);
    // The second record carries the same session; its file is not even readable as a team.
    const otherRoot = join(fixture.base, 'beta');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), 'format: 99\nproject: beta\n');
    const otherId = teamIdOf(otherRoot);
    upsertTeam(fixture.home, otherId, { project: 'beta', session: 'acme', root: otherRoot, at: NOW.toISOString() });
    setRoster(fixture.home, otherId, [{ agent: 'agt_444444444444', seat: 'worker', role: 'implementer' }]);

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(1);
    expect(did.created).toBe(0);
    expect(io.err).toBe('team restart: worker is not a signed declared seat\n');
  });

  test('a registry team that names the session but cannot be read keeps the configuration refusal', async () => {
    // Exactly one record carries the session and its own team file does not load. The read is
    // not skipped back to the pointer: the run reports that configuration failure, the same
    // refusal the pointer's own file would get, and starts nothing.
    const fixture = makeFixture();
    const lobby = join(fixture.home, '.config', 'team', 'lobby');
    mkdirSync(join(fixture.home, '.config', 'team'), { recursive: true });
    mkdirSync(lobby, { mode: 0o700 });
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const id = teamIdOf(fixture.root);
    upsertTeam(fixture.home, id, { project: 'acme', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    setRoster(fixture.home, id, [
      { agent: 'agt_000000000000', seat: 'lead', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
      { agent: 'agt_222222222222', seat: 'worker', role: 'implementer' },
    ]);
    // The record's own team file no longer validates.
    writeFileSync(fixture.file, 'format: 99\nproject: acme\n');

    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(lobby, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(2);
    expect(did.created).toBe(0);
  });

  test('a launched pointer to an older team file falls back to the team the folder holds', async () => {
    // The same stale pointer, run from the checkout: the folder's own team is the second
    // authority that declares the seat, and the restart proceeds there.
    const fixture = makeFixture();
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const { sources, did } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['worker'], io, sources);
    expect(code).toBe(0);
    expect(io.out).toContain('team restart: restarted worker; pane none -> pane-new\n');
    expect(did.created).toBe(1);
    expect(io.err).toContain('reading the team this folder holds');
  });

  test('a launched pointer to an older team file keeps refusing a seat nothing declares', async () => {
    // The fallback never invents a declaration: a seat in neither the pointer's team, the
    // folder's team nor the registry's roster gets the same refusal as today.
    const fixture = makeFixture();
    const olderFile = join(fixture.dir, 'team-old.yaml');
    writeFileSync(olderFile, olderTeamYaml(fixture.yaml));
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.launched_file = olderFile;
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    noteLaunchedPane(fixture.home, olderFile, 'pane-lead', 'acme');
    const { sources } = makeHarness(fixture, { initialRunning: false });
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const io = testIo(fixture.root, leadCaller);

    const code = await runRestart(['ghost'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('team restart: ghost is not a signed declared seat\n');
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

  test('refuses unknown and temporary seats, and a held run-lock; supports --dry-run', async () => {
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

  // `remove --keep` writes the sign-off into the registry's record when the team lives there, and
  // leaves `.agents/team.yaml` as it was. A seat that leads the team restarts the stopped seat
  // from its own pane: the run reads the launched pointer through the seam, so the mark it
  // clears is the registry's own — in the same write that records the launch — and the stale
  // file beside it is left exactly as it was launched.
  test('a team\'s lead revives a registry team\'s stopped seat, clearing the registry mark the pointer leads to', async () => {
    const fixture = makeFixture();
    intoRegistry(fixture.root, fixture.home);
    const stored = storedTeam(fixture.root, fixture.home);
    if (stored === null) throw new Error('the fixture team is not in the registry');
    await underRegistry(async () => {
      expect(writeTeamText(fixture.file, markStopped(stored.text, 'worker'), { home: fixture.home, command: 'remove' }))
        .toEqual({ ok: true, target: 'registry' });
      // The mark is the registry's; the file the session was launched from is exactly as launched.
      expect(storedTeam(fixture.root, fixture.home)?.text ?? '').toContain('stopped: true');
      expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);

      updateState(fixture.dir, (state) => {
        const session = (state.sessions.acme ??= emptySession());
        session.launched_file = fixture.file;
        session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
        session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
      });
      noteLaunchedPane(fixture.home, fixture.file, 'pane-lead', 'acme');

      const { sources, did } = makeHarness(fixture);
      const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
      expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
      expect(io.err).toBe('');
      expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
      // The mark the restart cleared is the registry's, and the stale file is untouched.
      expect(seatIsStopped(storedTeam(fixture.root, fixture.home)?.text ?? '', 'worker')).toBe(false);
      // The write cleared that seat's mark and no other: the fixture's own signed-off seat stands.
      expect(seatIsStopped(storedTeam(fixture.root, fixture.home)?.text ?? '', 'parked-seat')).toBe(true);
      expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
      expect(did.typed).toEqual(['/exit']);
      expect(did.closed).toEqual(['ws-old']);
      expect(did.created).toBe(1);
      const after = readState(fixture.dir).sessions.acme?.seats.worker;
      expect(after?.stage).toBe('ready');
      expect(after?.pane).toBe('pane-new');
    });
  });

  // The owner's own terminal carries no launched pointer: the same mark is read from the registry
  // itself, and the owner's restart clears and relaunches the seat the same way.
  test('the owner revives a registry team\'s stopped seat from the owner\'s own terminal', async () => {
    const fixture = makeFixture();
    intoRegistry(fixture.root, fixture.home);
    const stored = storedTeam(fixture.root, fixture.home);
    if (stored === null) throw new Error('the fixture team is not in the registry');
    await underRegistry(async () => {
      expect(writeTeamText(fixture.file, markStopped(readTeamText(fixture.file, { home: fixture.home }), 'worker'), { home: fixture.home, command: 'remove' }))
        .toEqual({ ok: true, target: 'registry' });
      const { sources, did } = makeHarness(fixture);
      const io = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
      expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
      expect(seatIsStopped(storedTeam(fixture.root, fixture.home)?.text ?? '', 'worker')).toBe(false);
      expect(did.closed).toEqual(['ws-old']);
      expect(did.created).toBe(1);
    });
  });

  // A stopped seat is its own team's to revive: the owner, or a seat that leads this team on its
  // own recorded pane. The run clears `stopped: true` in the same write that records the launch,
  // then relaunches; a launch that does not reach ready puts the mark back. Every scene below
  // runs with dev mode off, except where it says otherwise.
  test('a team\'s lead restarts its own team\'s stopped seat: the mark is cleared in the run that launches it', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    expect(await runRestart(['parked-seat'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('team restart: restarted parked-seat; pane none -> pane-new\n');
    expect(seatIsStopped(readFileSync(fixture.file, 'utf8'), 'parked-seat')).toBe(false);
    expect(readFileSync(fixture.file, 'utf8')).not.toContain('stopped: true');
    expect(did.created).toBe(1);
    expect(did.runs).toHaveLength(1);
    const after = readState(fixture.dir).sessions.acme?.seats['parked-seat'];
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
  });

  // A seat may be written as a bare dash item: YAML reads the fields under `  -` as one entry, and
  // so must the write that signs the revival into the same file. The dry run never writes, so it
  // prints a plan; the real run's write decides the seat from the parsed record and clears its mark
  // through the record editor.
  test('a stopped seat written as a bare dash item is revived in one run, as the dry run planned', async () => {
    const yaml = TEAM_YAML.replace(
      `  - role: implementer
    name: parked-seat`,
      `  -
    role: implementer
    name: parked-seat`,
    );
    expect(validateTeamFile(yaml).ok).toBe(true);
    const fixture = makeFixture(yaml);
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture);
    const caller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
    const ioDry = testIo(fixture.root, caller);
    expect(await runRestart(['parked-seat', '--dry-run'], ioDry, sources)).toBe(0);
    expect(ioDry.err).toBe('');
    expect(ioDry.out).toContain('parked-seat');
    expect(ioDry.out).toContain('dry run: nothing was run\n');
    expect(did.created).toBe(0);
    const io = testIo(fixture.root, caller);
    expect(await runRestart(['parked-seat'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('team restart: restarted parked-seat; pane none -> pane-new\n');
    const after = readFileSync(fixture.file, 'utf8');
    expect(seatIsStopped(after, 'parked-seat')).toBe(false);
    expect(seatIsStopped(after, 'lead')).toBe(false);
    expect(after).toContain('    name: parked-seat\n');
    expect(did.created).toBe(1);
    expect(did.runs).toHaveLength(1);
    expect(readState(fixture.dir).sessions.acme?.seats['parked-seat']?.stage).toBe('ready');
  });

  // A seat may be written as a flow mapping: the validator declares it, while the line writer
  // finds no name inside the braces. The revival decides the seat from the parsed record and
  // rewrites its mark through the record editor, so the sign-off clears and the launch runs.
  test('a stopped seat written as a flow mapping is revived in one run', async () => {
    const yaml = TEAM_YAML.replace(
      `  - role: implementer
    name: parked-seat
    label: parked
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`,
      `  - { role: implementer, name: parked-seat, label: parked, cli: claude-code, vendor: anthropic, model: Claude Opus, version: "5.5", launch: claude --model claude-opus-5-5, stopped: true }
`,
    );
    expect(validateTeamFile(yaml).ok).toBe(true);
    const fixture = makeFixture(yaml);
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    expect(await runRestart(['parked-seat'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('team restart: restarted parked-seat; pane none -> pane-new\n');
    const after = readFileSync(fixture.file, 'utf8');
    expect(seatIsStopped(after, 'parked-seat')).toBe(false);
    expect(validateTeamFile(after).ok).toBe(true);
    expect(did.created).toBe(1);
    expect(did.runs).toHaveLength(1);
    expect(readState(fixture.dir).sessions.acme?.seats['parked-seat']?.stage).toBe('ready');
  });

  // A launch that never reaches ready is no revival: the run puts the sign-off back in its own
  // validated write, so the file keeps the mark exactly as it had it, and the failure is said.
  for (const failure of ['create', 'run'] as const) {
    test(`a stopped seat whose ${failure === 'create' ? 'workspace creation' : 'launch command'} fails keeps its mark`, async () => {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      });
      const { sources, did } = makeHarness(fixture, failure === 'create' ? { createFails: true } : { paneRunFails: true });
      const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
      expect(await runRestart(['parked-seat'], io, sources)).not.toBe(0);
      expect(did.created).toBe(1);
      expect(did.runs).toHaveLength(failure === 'run' ? 1 : 0);
      expect(seatIsStopped(readFileSync(fixture.file, 'utf8'), 'parked-seat')).toBe(true);
      expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
      expect(readState(fixture.dir).sessions.acme?.seats['parked-seat']?.stage).not.toBe('ready');
      expect(io.err).toContain('its sign-off was put back in the team file');
    });
  }

  // A worker is not `leads`, whatever pane it stands on: the caller gate refuses it as it always
  // has, and nothing is cleared or launched.
  test('a worker is refused the stopped seat, naming the caller, and nothing is written', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'worker', pane: 'pane-old', session: 'acme' });
    expect(await runRestart(['parked-seat'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: only the owner or `leads` restarts a seat; this call is worker\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  // A seat leading another team is placed, but not as a lead of this one: the placement alone is
  // no admission.
  test('another team\'s lead is refused this team\'s stopped seat, and nothing is written', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats['rival-lead'] = { stage: 'ready', pane: 'pane-rival', workspace: 'ws-rival' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'rival-lead', pane: 'pane-rival', session: 'acme' });
    expect(await runRestart(['parked-seat'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: only the owner or `leads` restarts a seat; this call is rival-lead\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  // The entity's main orchestrator stands as, and reaches as, each team lead, and the
  // proof is its own head team's record, live file and recorded pane — never its seat name. The
  // target team's lead is named `orchestrator` too, so the name alone would refuse the pair.
  test("the entity's main orchestrator restarts a team's seat named like itself", async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });
    const { sources, did } = makeHarness(fixture, { workerName: 'orchestrator' });
    const io = testIo(fixture.root);
    io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });

    expect(await runRestart(['orchestrator'], io, sources), io.err).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted orchestrator; pane pane-old -> pane-new\n');
  });

  // The reach carries the sign-off half of a lead's place too: the entity's main orchestrator
  // lifts a stopped seat of the entity's team, and the revival clears the mark in the same write
  // that records the launch, exactly as the team's own lead does.
  test("the entity's main orchestrator lifts a team's stopped seat", async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });
    const { sources, did } = makeHarness(fixture, { workerName: 'orchestrator' });
    const io = testIo(fixture.root);
    io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });

    expect(await runRestart(['parked-seat'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('team restart: restarted parked-seat; pane none -> pane-new\n');
    expect(seatIsStopped(readFileSync(fixture.file, 'utf8'), 'parked-seat')).toBe(false);
    expect(readFileSync(fixture.file, 'utf8')).not.toContain('stopped: true');
    expect(did.created).toBe(1);
    expect(did.runs).toHaveLength(1);
    // The target names an entity, so its own session is `<entity>-<project>`.
    const after = readState(fixture.dir).sessions['floor-acme']?.seats['parked-seat'];
    expect(after?.stage).toBe('ready');
    expect(after?.pane).toBe('pane-new');
  });

  // The proof reads the head team's live file as the file resolves its lead: `leads: true` on the
  // seat is the other spelling of the legacy `coordinator:` key, and the reach holds through it.
  test('the main orchestrator is proven through a head file that spells its lead with `leads: true`', async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor', 'leads');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });
    const { sources, did } = makeHarness(fixture, { workerName: 'orchestrator' });
    const io = testIo(fixture.root);
    io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });

    expect(await runRestart(['orchestrator'], io, sources), io.err).toBe(0);
    expect(did.typed).toEqual(['/exit']);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(io.out).toContain('team restart: restarted orchestrator; pane pane-old -> pane-new\n');
  });

  // The reach never lifts a seat off the pane it stands on: the head team's own orchestrator,
  // recorded on its own pane in its own session, is refused exactly as before.
  test("the head team's own orchestrator on its recorded pane is still refused", async () => {
    const fixture = makeFixture(headTeamYaml('floor', 'floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.floor ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-main', workspace: 'ws-main' };
    });
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'floor', entity: 'floor', session: 'floor', root: fixture.root, at: NOW.toISOString() });
    // A launched team's record carries its roster, and the record is the map's judge: a seat the
    // roster omits has no record at all. The head orchestrator is its own team's lead here, so
    // the caller gate admits it and the self guard — not the gate — is what refuses.
    setRoster(fixture.home, teamIdOf(fixture.root), [
      { agent: 'agt_000000000000', seat: 'orchestrator', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
    ]);
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root);
    io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: fixture.root, targetRoot: fixture.root });

    expect(await runRestart(['orchestrator'], io, sources)).toBe(1);
    expect(io.err).toBe('team restart: the orchestrator cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it\n');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  // The reach stops at the entity's edge: another entity's main orchestrator is named
  // `orchestrator` too, placed in this session on its own pane, and is refused the same seat.
  test("another entity's main orchestrator is refused the same seat", async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'radio', 'radio');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    // The target's record lists its own lead, named `orchestrator` too: the name is admitted by
    // this team's map, and the pane the target's state records for that seat is another one, so
    // the refusal is the placement's — the name proves nothing across entities.
    setRoster(fixture.home, teamIdOf(fixture.root), [
      { agent: 'agt_000000000000', seat: 'orchestrator', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator' },
    ]);
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'radio', entity: 'radio', session: head.session, root: head.root, at: NOW.toISOString() });
    const { sources, did } = makeHarness(fixture, { workerName: 'orchestrator' });
    const io = testIo(fixture.root);
    io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });

    expect(await runRestart(['orchestrator'], io, sources)).toBe(1);
    expect(io.err).toContain('not the pane this call is on');
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test("the entity's main orchestrator lifts a stopped seat's sign-off, and puts it back when the launch fails", async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });

    // 1. Failed launch restores `stopped: true` on `parked-seat`.
    const failedHarness = makeHarness(fixture, { createFails: true });
    const failIo = testIo(fixture.root);
    failIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['parked-seat'], failIo, failedHarness.sources)).not.toBe(0);
    expect(seatIsStopped(readFileSync(fixture.file, 'utf8'), 'parked-seat')).toBe(true);
    expect(failIo.err).toContain('its sign-off was put back in the team file');

    // 2. Successful launch clears `stopped: true` and brings `parked-seat` to ready.
    const { sources, did } = makeHarness(fixture);
    const okIo = testIo(fixture.root);
    okIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['parked-seat'], okIo, sources), okIo.err).toBe(0);
    expect(okIo.out).toContain('team restart: restarted parked-seat; pane none -> pane-new\n');
    expect(seatIsStopped(readFileSync(fixture.file, 'utf8'), 'parked-seat')).toBe(false);
    expect(did.created).toBe(1);
    expect(readState(fixture.dir).sessions.acme?.seats['parked-seat']?.stage).toBe('ready');
  });

  test("the entity's main orchestrator is still refused --abandon on the orchestrator, operator, or a working seat", async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      const held = (state.sessions.acme ??= emptySession());
      held.seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
      held.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
      held.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });

    for (const leadTarget of ['orchestrator', 'ops']) {
      const { sources, did } = makeHarness(fixture, { workerName: 'orchestrator' });
      const io = testIo(fixture.root);
      io.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
      expect(await runRestart([leadTarget, '--abandon'], io, sources), leadTarget).toBe(1);
      expect(io.err, leadTarget).toBe('team restart: a seat caller does not abandon the orchestrator\'s or the operator\'s seat; this call is orchestrator\n');
      expect(did.closed, leadTarget).toEqual([]);
      expect(did.created, leadTarget).toBe(0);
    }

    // `--abandon` on a `working` worker seat is also refused to the main orchestrator.
    const workingHarness = makeHarness(fixture, { workerScreen: 'working', workerStatus: 'working' });
    const workingIo = testIo(fixture.root);
    workingIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['worker', '--abandon'], workingIo, workingHarness.sources)).toBe(1);
    expect(workingIo.err).toContain('worker is working');
    expect(workingHarness.did.closed).toEqual([]);
    expect(workingHarness.did.created).toBe(0);
  });

  test('a same-named caller from a foreign session or wrong pane is refused, and the name self-guard still holds when mainOrchestrator is null', async () => {
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      const held = (state.sessions.acme ??= emptySession());
      held.seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
      held.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });

    // 1. Wrong pane in head session (`pane-spoof` when state records `pane-main`): refused.
    const wrongPaneHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const wrongPaneIo = testIo(fixture.root);
    wrongPaneIo.callerSources = sharedFleetSources({ headPane: 'pane-spoof', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['orchestrator'], wrongPaneIo, wrongPaneHarness.sources)).toBe(1);
    expect(wrongPaneHarness.did.created).toBe(0);

    // 2. Same-named caller placed in a foreign session (`stranger`): refused.
    const foreignHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const foreignIo = testIo(fixture.root, { kind: 'seat', name: 'orchestrator', pane: 'pane-main', session: 'stranger' });
    expect(await runRestart(['orchestrator'], foreignIo, foreignHarness.sources)).toBe(1);
    expect(foreignHarness.did.created).toBe(0);

    // 3. With `mainOrchestrator === null` (caller stands on `pane-spoof`) and dev mode folding the
    //    caller gate, the `byName` self-guard still refuses `orchestrator` restarting `orchestrator`.
    const devSelfHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const devSelfIo = testIo(fixture.root, { kind: 'seat', name: 'orchestrator', pane: 'pane-spoof', session: 'acme' });
    devSelfIo.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['orchestrator'], devSelfIo, devSelfHarness.sources)).toBe(1);
    expect(devSelfIo.err).toContain('team restart: the orchestrator cannot restart its own recorded pane; another `leads` seat (or the owner) restarts it\n');
    expect(devSelfHarness.did.created).toBe(0);
  });

  test('an unreadable teams registry, a target with no entity, and a head team without a valid single orchestrator all fail closed', async () => {
    // 1. Target team has no `entity:` in its file (`team.entity === null`).
    const noEntityFixture = makeFixture(
      TEAM_YAML.replace('coordinator: lead', 'coordinator: orchestrator').replace('    name: lead\n', '    name: orchestrator\n'),
    );
    updateState(noEntityFixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const noEntityHead = makeHeadTeam(noEntityFixture.base, 'floor', 'floor');
    recordMainOrchestrator(noEntityHead.dir, noEntityHead.session, 'pane-main');
    upsertTeam(noEntityFixture.home, teamIdOf(noEntityFixture.root), { project: 'acme', entity: null, session: 'acme', root: noEntityFixture.root, at: NOW.toISOString() });
    upsertTeam(noEntityFixture.home, teamIdOf(noEntityHead.root), { project: 'floor', entity: 'floor', session: noEntityHead.session, root: noEntityHead.root, at: NOW.toISOString() });
    const noEntityHarness = makeHarness(noEntityFixture, { workerName: 'orchestrator' });
    const noEntityIo = testIo(noEntityFixture.root);
    noEntityIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: noEntityHead.root, targetRoot: noEntityFixture.root });
    expect(await runRestart(['orchestrator'], noEntityIo, noEntityHarness.sources)).toBe(1);
    expect(noEntityHarness.did.created).toBe(0);

    // 2. Head team led by `leads: true` on one seat without top-level `coordinator:` resolves
    //    `loaded.team.orchestrator` to that seat (`src/file/sections/lead.ts:22-48`); whereas a
    //    head file with `leads: true` on two seats or on another seat (or no lead key at all) is
    //    refused (`!loaded.ok` or `placed.name !== loaded.team.orchestrator`).
    const fixture = makeFixture(crossTeamTargetYaml('floor'));
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.orchestrator = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const head = makeHeadTeam(fixture.base, 'floor', 'floor');
    recordMainOrchestrator(head.dir, head.session, 'pane-main');
    upsertTeam(fixture.home, teamIdOf(fixture.root), { project: 'acme', entity: 'floor', session: 'acme', root: fixture.root, at: NOW.toISOString() });
    upsertTeam(fixture.home, teamIdOf(head.root), { project: 'floor', entity: 'floor', session: head.session, root: head.root, at: NOW.toISOString() });
    setRoster(fixture.home, teamIdOf(head.root), [
      { agent: 'agt_000000000000', seat: 'orchestrator', role: 'coordinator', leads: true },
      { agent: 'agt_111111111111', seat: 'ops', role: 'coordinator', leads: true },
    ]);
    const headFile = join(head.dir, 'team.yaml');
    const validHeadText = readFileSync(headFile, 'utf8');

    // 2a. Head `team.yaml` with neither `coordinator:` nor `leads: true` fails closed (`!loaded.ok`).
    writeFileSync(headFile, validHeadText.replace('coordinator: orchestrator\n', ''));
    const noOrchestratorHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const noOrchestratorIo = testIo(fixture.root);
    noOrchestratorIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['orchestrator'], noOrchestratorIo, noOrchestratorHarness.sources)).toBe(1);
    expect(noOrchestratorHarness.did.created).toBe(0);

    // 2b. Head `team.yaml` omitting `coordinator:` and putting `leads: true` on `ops` instead of
    //     `orchestrator` refuses `orchestrator` (`placed.name !== loaded.team.orchestrator`).
    writeFileSync(
      headFile,
      validHeadText
        .replace('coordinator: orchestrator\n', '')
        .replace('    name: ops\n', '    name: ops\n    leads: true\n'),
    );
    const otherLeadHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const otherLeadIo = testIo(fixture.root);
    otherLeadIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['orchestrator'], otherLeadIo, otherLeadHarness.sources)).toBe(1);
    expect(otherLeadHarness.did.created).toBe(0);

    // 2c. Head `team.yaml` omitting `coordinator:` and putting `leads: true` on the single
    //     `orchestrator` seat resolves `loaded.team.orchestrator === 'orchestrator'` and is admitted.
    writeFileSync(
      headFile,
      validHeadText
        .replace('coordinator: orchestrator\n', '')
        .replace('    name: orchestrator\n', '    name: orchestrator\n    leads: true\n'),
    );
    const singleLeadsHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const singleLeadsIo = testIo(fixture.root);
    singleLeadsIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['orchestrator'], singleLeadsIo, singleLeadsHarness.sources), singleLeadsIo.err).toBe(0);
    expect(singleLeadsHarness.did.created).toBe(1);

    // 3. Restore valid head `team.yaml`, then corrupt `~/.config/team/teams.yaml`: unreadable registry fails closed.
    writeFileSync(headFile, validHeadText);
    writeFileSync(join(fixture.home, '.config', 'team', 'teams.yaml'), 'teams:\n  broken: [\n');
    const unreadableHarness = makeHarness(fixture, { workerName: 'orchestrator' });
    const unreadableIo = testIo(fixture.root);
    unreadableIo.callerSources = sharedFleetSources({ headPane: 'pane-main', headRoot: head.root, targetRoot: fixture.root });
    expect(await runRestart(['orchestrator'], unreadableIo, unreadableHarness.sources)).toBe(1);
    expect(unreadableHarness.did.created).toBe(0);
  });

  // Dev mode folds the caller gate into a warning; it does not lift the sign-off. The refusal
  // still stands, and names the command that does work.
  test('a worker is still refused the stopped seat with dev mode on, naming `team restart`', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old' };
    });
    const { sources, did } = makeHarness(fixture);
    const io = testIo(fixture.root, { kind: 'seat', name: 'worker', pane: 'pane-old', session: 'acme' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runRestart(['parked-seat'], io, sources)).toBe(1);
    expect(io.err).toContain('team restart: parked-seat is signed off; a `leads` seat of its own team clears it with `team restart parked-seat`\n');
    expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  // A team the registry holds is edited in its record; `--file` names the file a session was
  // launched from, not a second copy of the team. A record that cannot be read is the refusal
  // the plain read already gives, in the same words and at the same exit — before anything is
  // stopped or planned — never an exception out of the policy reader and never an answer read
  // from the stale file.
  test('a corrupt registry record refuses a `--file` restart plainly, before anything is stopped or planned', async () => {
    const fixture = makeFixture();
    intoRegistry(fixture.root, fixture.home);
    const record = corruptStoredTeam(fixture);
    await underRegistry(async () => {
      const { sources, did } = makeHarness(fixture);
      for (const extra of [[], ['--dry-run']]) {
        const io = testIo(fixture.root, { kind: 'owner' });
        expect(await runRestart(['worker', '--file', fixture.file, ...extra], io, sources), extra.join(' ')).toBe(2);
        expect(io.out).toBe('');
        expect(io.err).toContain("team restart: the registry's record of this team cannot be read: ");
        expect(io.err).toContain(record);
        // The refusal names the fault in fixed words: the parser's own message quotes the
        // record's text back, and a record may hold anything.
        expect(io.err).toContain('the record is not valid JSON');
      }
      expect(did.typed).toEqual([]);
      expect(did.closed).toEqual([]);
      expect(did.created).toBe(0);
      // Nothing was rewritten: the file the session launched from and the unreadable record stand.
      expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
      expect(readFileSync(record, 'utf8')).toBe(CORRUPT_RECORD);
    });
  });

  // The same refusal when the registry's folder cannot be read: it is not an empty registry, so
  // the restart neither falls back to the file beside it nor stops and plans a seat on an answer
  // the registry never gave.
  test('an unreadable registry folder refuses a `--file` restart plainly, before anything is stopped or planned', async () => {
    const fixture = makeFixture();
    intoRegistry(fixture.root, fixture.home);
    const id = teamIdOf(fixture.root);
    const registry = unreadableRegistryFolder(fixture.home);
    try {
      await underRegistry(async () => {
        const { sources, did } = makeHarness(fixture);
        for (const extra of [[], ['--dry-run']]) {
          const io = testIo(fixture.root, { kind: 'owner' });
          expect(await runRestart(['worker', '--file', fixture.file, ...extra], io, sources), extra.join(' ')).toBe(2);
          expect(io.out).toBe('');
          expect(io.err).toContain("team restart: the registry's record of this team cannot be read: ");
          expect(io.err).toContain(registry.path);
        }
        expect(did.typed).toEqual([]);
        expect(did.closed).toEqual([]);
        expect(did.created).toBe(0);
      });
      expect(readFileSync(fixture.file, 'utf8')).toBe(fixture.yaml);
      // The record itself was never rewritten: the held copy still says the team it was imported from.
      expect(registry.heldRecord(id)).toContain('project: acme');
    } finally {
      registry.restore();
    }
  });

  // The stop is a session mutation, so a restart stands aside while another run mutates the
  // session rather than refusing at the first reading or, worse, beginning the stop anyway. It
  // waits in counted steps — the run's own sleep — up to its bound; when the bound runs out it
  // refuses with the holder named and the seat exactly as it was.
  test('waits for the session lock up to its bound, then refuses with the holder named and nothing stopped', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
      };
    });
    const { sources, did } = makeHarness(fixture);
    const held = acquireRunLock(fixture.dir, 'acme');
    if ('held' in held) throw new Error('the scene could not take the session lock');
    // The refusal names the holder the token records: this process's pid and the start the
    // acquisition wrote beside its nonce.
    const recordedStart = Number(readFileSync(seatLockPath(fixture.dir, 'acme', '.run'), 'utf8').trim().split(' ')[2]);
    try {
      let steps = 0;
      sources.upLaunch.sleep = async () => {
        steps += 1;
      };
      const before = readState(fixture.dir);
      const io = testIo(fixture.root, { kind: 'owner' });

      expect(await runRestart(['worker'], io, sources)).toBe(1);
      // It stood aside first: the refusal is not the first reading's.
      expect(steps).toBeGreaterThan(0);
      expect(io.err).toBe(
        `team restart: another session-mutating run is holding session acme (pid ${process.pid}, started ${new Date(recordedStart).toISOString()}); try again when it is done\n`,
      );
      // Nothing was stopped, closed, typed into or launched, and the state is untouched.
      expect(did.typed).toEqual([]);
      expect(did.closed).toEqual([]);
      expect(did.created).toBe(0);
      expect(readState(fixture.dir)).toEqual(before);
    } finally {
      held.release();
    }
  });

  test('takes the session lock when it is released inside the wait, and restarts the seat', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
      };
    });
    const { sources, did } = makeHarness(fixture);
    const held = acquireRunLock(fixture.dir, 'acme');
    if ('held' in held) throw new Error('the scene could not take the session lock');
    let steps = 0;
    sources.upLaunch.sleep = async () => {
      steps += 1;
      if (steps === 3) held.release();
    };
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, sources)).toBe(0);
    // The restart waited for the holder to let go, then did the whole stop and relaunch.
    expect(steps).toBeGreaterThanOrEqual(3);
    expect(did.closed).toEqual(['ws-old']);
    expect(did.created).toBe(1);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-new');
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
    if (opts.cli === 'grok' || opts.cli === 'cursor') {
      const own = join(fixture.base, 'worker-tree'); mkdirSync(own);
      updateState(fixture.dir, state => {
        state.sessions.acme!.worktrees.worker = { path: own, branch: 'fix/worker', setup: 'ok' };
      });
    }
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

  // The check and the command it prints, on one fixture: herdr still names the seat on its
  // recorded pane, in this session, and the process there is not the one the record's launch
  // started. The registry binds the conversation herdr reports for the seat, so the pane is
  // provably the seat's and the pane's process is the restored launch. `team register` refuses a
  // pane holding another process, and a restart would abandon a live restored session that
  // `team up` can adopt in place, so the check names neither: the repair is `team up`, whose own
  // plan writes the restored launch identity before its address pass reads the pane.
  test('check names team up for a replaced process it can prove restored, and never a restart', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep', workerSession: 'ses_keep', launched: true });
    // The registry record a plain-name send resolves: the check reads the seat's agent record
    // through it, and the restart's own binding reads the same one.
    upsertTeam(fixture.home, teamIdOf(fixture.root), {
      project: 'acme',
      session: 'acme',
      root: fixture.root,
      at: NOW.toISOString(),
    });
    // The pane's own reading: a process whose shell and CLI pids are not the recorded ones, and
    // the socket that process carries — the one every reader without a pane skips.
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const sockets = join(fixture.base, 'sockets');
    mkdirSync(sockets, { recursive: true });
    writeFileSync(join(sockets, '201.sock'), '');
    // The launch's generated settings declare accept, backdated so the socket stands newer; the
    // team file names no word of its own, and a generated declaration admits the socket alone.
    const settings = cliHookSettingsPath(fixture.dir, 'acme', 'worker');
    if (settings === null) throw new Error('the fixture declares no settings path for worker');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
    const past = new Date(NOW.getTime() - 60_000);
    utimesSync(settings, past, past);

    const checkIo = testIo(fixture.root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, checkIo, {
      live: () => ({
        running: true,
        agents: [{ name: 'worker', agent: 'claude-code', pane: 'pane-old', workspace: 'ws-old', status: 'idle', cwd: fixture.root, session: 'ses_keep' }],
        workspaces: [{ id: 'ws-old', label: 'old' }],
        screens: { 'pane-old': CLAUDE_IDLE },
        processes: { 'pane-old': { shell: 101, foreground: [201] } },
      }),
      branch: () => 'main',
      standing: () => approvalStanding(fixture.root, fixture.home),
      now: () => NOW,
      home: fixture.home,
      sockets,
    });
    expect(code).toBe(1);
    // The line itself, whole: the honest reason, and the repair that runs — `team up` adopts the
    // restored process in place and records the address in one run. Never the `team register`
    // this record refuses, and never a restart of a live session the same run can adopt.
    expect(checkIo.out).toContain(
      "difference: worker: a reader without its pane sees pull-on-turn, not push: only the socket its pane's processes carry proves it, and its agent record holds no address this session can dial\n  repair: team up\n",
    );
    expect(checkIo.out).not.toContain('  repair: team restart worker');
  });

  // The incident's shape, on the CLI whose native route binds through the registry: the record
  // holds the stable handle of an earlier incarnation while the seat state names its own id. The
  // resume read refuses — correctly — and the relaunch starts fresh. The launch's own registry
  // write is the authority that repairs the record: the live seat id becomes its handle, so the
  // two records agree again and the native route binds (a send after the restart is native, not
  // a drop). An ordinary write, or a state mint alone, still never rewrites a handle.
  test('a relaunch repairs a record left with another incarnation\'s handle, and the native binding returns', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_keep', state: 'ses_keep', declaredCli: 'codex' });
    const OTHER = 'seat_fedcba987654';
    updateAgent(fixture.home, agentId!, { seat_handle: OTHER });
    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state: readState(fixture.dir).sessions.acme?.seats.worker,
    })).toEqual({ kind: 'refused', why: 'the record is another agent for this seat' });

    // The relaunched pane reports the conversation it actually started, as herdr does live.
    const agents = run.sources.upLaunch.agents;
    run.sources.upLaunch.agents = (session) => (agents(session) ?? []).map((agent) => (
      agent.pane.startsWith('pane-new') ? { ...agent, agent: 'codex', session: 'ses_new' } : agent
    ));
    run.sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
    // The old pane draws Codex's own screens around the one exit text the stop types.
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    expect(io.err).toContain('not resuming its recorded session (the record is another agent for this seat)');
    expect(run.did.runs.join('\n')).not.toContain('resume');
    const seat = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(seat?.id).toBe('seat_0123456789ab');
    expect(seat?.agent_session).toBe('ses_new');
    const record = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(record?.id).toBe(agentId);
    expect(record?.seat_handle).toBe('seat_0123456789ab');
    expect(record?.reach.agent_session).toBe('ses_new');
    // The read the Codex native route makes: the record and the state now bind this seat.
    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state: seat,
    }).kind).toBe('bound');
  });

  // The incident's other ending, and the live shape: the relaunched pane never reports the thread
  // it started, so the state ends naming no conversation while the managed launch has recorded a
  // fresh endpoint and a fresh presence incarnation for it. The endpoint's own thread read is made
  // and proves nothing (a socket that is not listening here), so the restart says exactly that
  // (pull-only), and the class a send prints must say the same: the runtime queue is addressed by
  // the conversation the records bind, and an endpoint alone never wakes anybody.
  test('a restart whose new pane and endpoint name no thread ends pull-only, and the class claims no wake', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_old', declaredCli: 'codex' });
    updateAgent(fixture.home, agentId!, { seat_handle: 'seat_fedcba987654' });
    const BOUND = 'prs_fedcba987654';
    // What the real managed launch leaves: the endpoint, recorded under a fresh incarnation.
    run.sources.upLaunch.codexEndpoint = managedEndpoint(fixture, BOUND);
    // The endpoint read this run makes: the socket is gone, so no thread is proven.
    run.sources.codexThreads = async () => ({
      kind: 'unavailable',
      why: 'the Codex endpoint socket is not listening (ENOENT)',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
    // The old pane draws Codex's own screens around the one exit text the stop types; the new
    // pane draws the idle prompt, but herdr lists no session for it.
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    // The resume read refuses the record that is another agent's, and the relaunch starts fresh.
    expect(io.err).toContain('not resuming its recorded session (the record is another agent for this seat)');
    // The pull-only reason is the binder's own: the endpoint read it made proves no thread.
    expect(io.out).toContain('pull-only: the Codex endpoint socket is not listening (ENOENT)');
    // The managed launch did its part: endpoint and incarnation are recorded, bound to each other.
    const seat = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(seat?.presence_binding).toBe(BOUND);
    expect(seat?.codex_endpoint?.binding).toBe(BOUND);
    // The conversation did not come with them: the pane reported no thread, so the state names
    // none, and the record keeps the one it held before the restart. Nothing addresses the queue.
    expect(seat?.agent_session).toBeUndefined();
    const record = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(record?.seat_handle).toBe('seat_0123456789ab');
    expect(record?.reach.agent_session).toBe('ses_old');
    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state: seat,
    }).kind).toBe('none');

    // The class a send prints for this seat: the endpoint is there, but with no bound
    // conversation it is no wake, and the words say what will actually happen.
    const delivery = seatDeliveryClass({
      home: fixture.home,
      dir: fixture.dir,
      root: fixture.root,
      session: 'acme',
      seat: 'worker',
      declared: { cli: 'codex', launch: 'codex -m gpt-6.1-sol' },
      state: seat,
    });
    expect(delivery.class).toBe('pull-on-turn');
    expect(delivery.words).toBe('queued; worker reads it at its next turn, and nothing here gives it one (pull-only)');
    expect(delivery.evidence.endpoint).toBe(false);
    expect(delivery.evidence.conversation).toBe(false);
    // The run says which read proved nothing, so a reader can tell an unreadable endpoint from a
    // pane that simply reported no thread.
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: no thread was bound from its Codex endpoint (the Codex endpoint socket is not listening (ENOENT))');
  });

  // The incident's live repair, on the preferred path: the relaunched pane reports no thread, but
  // the managed endpoint its launch started holds exactly one loaded thread, and that thread is
  // the conversation the seat's runtime queue is addressed by. The restart reads it from the
  // endpoint (never from the pane) and binds it to both records, so the seat ends reachable
  // through its queue rather than only at its next turn.
  test('a restart binds the one thread its Codex endpoint holds, and the class claims the wake', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_old', declaredCli: 'codex' });
    updateAgent(fixture.home, agentId!, { seat_handle: 'seat_fedcba987654' });
    const BINDING = 'prs_fedcba987654';
    const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
    run.sources.upLaunch.codexEndpoint = managedEndpoint(fixture, BINDING);
    const asked: string[] = [];
    run.sources.codexThreads = async (endpoint) => {
      asked.push(endpoint);
      return { kind: 'read', ids: [THREAD] };
    };
    run.sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    // The read is addressed by the seat's own recorded endpoint, never a home-derived path.
    expect(asked).toEqual([ownedEndpointUrl(fixture, BINDING)]);
    expect(io.out).not.toContain('pull-only');
    // Both records now name the endpoint's thread, under the incarnation the launch wrote.
    const seat = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(seat?.presence_binding).toBe(BINDING);
    expect(seat?.agent_session).toBe(THREAD);
    const record = findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' });
    expect(record?.seat_handle).toBe('seat_0123456789ab');
    expect(record?.reach.agent_session).toBe(THREAD);
    expect(recordedSeatSession({
      home: fixture.home,
      root: fixture.root,
      herdrSession: 'acme',
      seat: { name: 'worker', cli: 'codex' },
      state: seat,
    }).kind).toBe('bound');
    // The native route and the class read the same binding: this seat can be woken while idle.
    const delivery = seatDeliveryClass({
      home: fixture.home,
      dir: fixture.dir,
      root: fixture.root,
      session: 'acme',
      seat: 'worker',
      declared: { cli: 'codex', launch: 'codex -m gpt-6.1-sol' },
      state: seat,
    });
    expect(delivery.class).toBe('between-turns');
    expect(delivery.words).toBe('woken through its runtime queue');
    expect(delivery.evidence.endpoint).toBe(true);
    expect(delivery.evidence.conversation).toBe(true);
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain(`worker: its Codex endpoint holds thread ${THREAD}; bound as the seat's session`);
  });

  // The ambiguous reading: the endpoint holds two threads, so neither is proven to be this seat's.
  // Nothing is bound, and the restart stays honest about what a send will do.
  test('a restart whose Codex endpoint holds more than one thread binds none and stays pull-only', async () => {
    const { fixture, run, agentId } = seeded({ registry: 'ses_old', declaredCli: 'codex' });
    updateAgent(fixture.home, agentId!, { seat_handle: 'seat_fedcba987654' });
    const BINDING = 'prs_fedcba987654';
    run.sources.upLaunch.codexEndpoint = managedEndpoint(fixture, BINDING);
    run.sources.codexThreads = async () => ({
      kind: 'read',
      ids: ['019a0000-aaaa-7bbb-8ccc-ddddeeeeffff', '019a0000-1111-7222-8333-444455556666'],
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 300, foreground: [301] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    // Several threads prove nothing; the summary says which reading refused it.
    expect(io.out).toContain("pull-only: its Codex endpoint holds 2 threads; none is proven to be this seat's");
    const seat = readState(fixture.dir).sessions.acme?.seats.worker;
    expect(seat?.agent_session).toBeUndefined();
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_old');
    const log = readFileSync(join(fixture.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: no thread was bound from its Codex endpoint (its Codex endpoint holds 2 threads; none is proven to be this seat\'s)');
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
    const launch = 'zsh /home/owner/as-floor.sh agy --model gemini-3.8-flash';
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

  test('a restored Grok seat is proven by the registry binding and resumes that conversation through its launcher', async () => {
    // The state predates the id. The registry record is the proof, and the relaunch appends
    // the measured `-r <id>` before the profile's unattended flag.
    const { fixture, run } = seeded({
      registry: GROK_SESSION,
      cli: 'grok',
      model: 'Grok',
      version: '4.7',
      yaml: GROK_TEAM_YAML,
      launch: 'grok',
      workerSession: GROK_SESSION,
      launched: true,
      foregroundArgv0: 'grok',
      newPaneScreen: GROK_IDLE,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.doctor = { ...run.sources.doctor, version: () => '1.0.52' };
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? GROK_EXIT_TYPED : GROK_IDLE) : GROK_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).toContain(
      `AGENT_UNATTENDED=1 grok -r ${GROK_SESSION} --trust --permission-mode auto --allow 'Bash(bun *)' --allow 'Bash(team *)' --allow 'Bash(git *)' --sandbox team-seat-acme-worker`,
    );
    expect(io.err).toBe('');
  });

  test('a restored Grok wrapper keeps -r <id> on the forwarded launch line', async () => {
    const launch = 'zsh /home/owner/as-floor.sh grok --model grok-4.7';
    const { fixture, run } = seeded({
      registry: GROK_SESSION,
      cli: 'grok',
      model: 'Grok',
      version: '4.7',
      yaml: GROK_TEAM_YAML.replace('    launch: grok', `    launch: ${launch}`),
      launch,
      workerSession: GROK_SESSION,
      launched: true,
      foregroundArgv0: 'grok',
      newPaneScreen: GROK_IDLE,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.doctor = { ...run.sources.doctor, version: () => '1.0.52' };
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? GROK_EXIT_TYPED : GROK_IDLE) : GROK_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain(
      `AGENT_UNATTENDED=1 ${launch} -r ${GROK_SESSION} --trust --permission-mode auto --allow 'Bash(bun *)' --allow 'Bash(team *)' --allow 'Bash(git *)' --sandbox team-seat-acme-worker`,
    );
  });

  test('a restored Claude Code wrapper resumes inside its quoted script and says so before the close', async () => {
    // The launch line runs the CLI inside a quoted script: a word after the closing quote never
    // reaches `claude`, so the resume and the profile's options go inside it, and the pre-close
    // line quotes the line the run launches rather than the bare declaration.
    const launch = 'zsh -lc "claude --model claude-opus-5-5"';
    const worker = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      workerSession: 'ses_keep',
      launched: true,
      launch,
      yaml: TEAM_YAML.replace(worker, worker.replace('launch: claude --model claude-opus-5-5', `launch: ${launch}`)),
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    const resumed = 'zsh -lc "claude --model claude-opus-5-5 --resume ses_keep"';
    const settings = join(fixture.root, '.agents/hooks/acme/worker.json');
    const ran = run.did.runs.find((line) => line.includes('zsh -lc'));
    expect(ran).toBeDefined();
    // The resume and every profile option sit inside the quoted script, where the CLI reads
    // them; the settings file is the last word before the closing quote.
    expect(ran?.startsWith('AGENT_UNATTENDED=1 zsh -lc "claude --model claude-opus-5-5 --resume ses_keep --dangerously-skip-permissions --name worker --append-system-prompt ')).toBe(true);
    expect(ran?.endsWith(`--settings ${settings}"`)).toBe(true);
    expect(io.out).toContain(
      `worker: context: workspace close ends the pane; relaunch runs "${resumed}" in a new workspace and resumes the recorded conversation ses_keep\n`,
    );
    // The recipe the launch records is the declared line, with the resume it carried.
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.launch).toBe(resumed);
  });

  test('a wrapper chain hands the carried resume to the CLI as an argument', async () => {
    // The field's shape: a shell starts a wrapper that execs the command it is given, which starts
    // a second wrapper that handles some words itself and collects the rest for the CLI. Running
    // the line the restart plans proves which words reach the CLI, and in what order.
    const launch = '/bin/sh as-floor.sh /bin/bash claude-kimi.sh';
    const worker = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      workerSession: 'ses_keep',
      launched: true,
      launch,
      yaml: TEAM_YAML.replace(worker, worker.replace('launch: claude --model claude-opus-5-5', `launch: ${launch}`)),
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });

    // A stub CLI on PATH records the argv it is handed. The wrappers sit in the seat's folder,
    // where its launch line runs.
    const bin = join(fixture.base, 'bin');
    mkdirSync(bin, { recursive: true });
    const argvFile = join(fixture.base, 'argv.txt');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\n`, { mode: 0o755 });
    writeFileSync(join(fixture.root, 'as-floor.sh'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(
      join(fixture.root, 'claude-kimi.sh'),
      [
        '#!/bin/bash',
        'args=()',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --model) model="$2"; shift 2 ;;',
        '    *) args+=("$1"); shift ;;',
        '  esac',
        'done',
        'exec claude --model "${model:-kimi-k2}" "${args[@]}"',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    const command = run.did.runs.find((line) => line.includes('claude-kimi.sh'));
    expect(command).toBeDefined();
    execFileSync('/bin/sh', ['-c', command ?? ''], {
      cwd: fixture.root,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: fixture.home },
    });

    // The exact words the CLI receives, in order: the wrapper's own model, then the carried resume,
    // then the profile's unattended, naming, rules and hook options — and no positional prompt.
    // The stub terminates each word with NUL, so the multi-line rules text stays one word.
    const argv = readFileSync(argvFile, 'utf8').split('\0').filter((word) => word !== '');
    expect(argv).toHaveLength(11);
    expect(argv.slice(0, 7)).toEqual([
      '--model',
      'kimi-k2',
      '--resume',
      'ses_keep',
      '--dangerously-skip-permissions',
      '--name',
      'worker',
    ]);
    expect(argv[7]).toBe('--append-system-prompt');
    expect(argv[8]).toContain('Rules for this session');
    expect(argv[9]).toBe('--settings');
    expect(argv[10]).toMatch(/worker\.json$/);
  });

  test("a shell's own -c is not read as Claude Code's continue, so the line resumes", async () => {
    // `<shell> -c "<script>"` is the common quoted-script shape: the shell's -c is the shell's
    // option, not the CLI's continue. Both lines carry the recorded conversation, and the
    // profile's options go inside the script with it. The line is planned and recorded here;
    // the next scene runs one.
    for (const launch of ['/bin/sh -c "claude --model claude-opus-5-5"', 'zsh -c "claude --model claude-opus-5-5"']) {
      const worker = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
      const { fixture, run } = seeded({
        registry: 'ses_keep',
        state: 'ses_keep',
        workerSession: 'ses_keep',
        launched: true,
        launch,
        yaml: TEAM_YAML.replace(worker, worker.replace('launch: claude --model claude-opus-5-5', `launch: ${launch}`)),
      });
      run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
      const io = testIo(fixture.root, { kind: 'owner' });

      expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
      const ran = run.did.runs.find((line) => line.includes('--resume ses_keep'));
      expect(ran).toBeDefined();
      const settings = join(fixture.root, '.agents/hooks/acme/worker.json');
      expect(ran?.startsWith(
        `AGENT_UNATTENDED=1 ${launch.slice(0, -1)} --resume ses_keep --dangerously-skip-permissions --name worker --append-system-prompt `,
      )).toBe(true);
      expect(ran?.endsWith(`--settings ${settings}"`)).toBe(true);
      expect(io.out).toContain('resumes the recorded conversation ses_keep');
    }
  });

  test('a quoted script hands the profile options to the CLI as arguments', async () => {
    // The field's shape: a launch line whose last word is a quoted script running the CLI. A word
    // after the closing quote never reaches the CLI, so the profile's options must go inside it.
    // Running the planned line with a stub CLI on PATH proves which words the CLI is handed — the
    // containment check on the line cannot see the difference. The shell's own -c is not Claude
    // Code's --continue: only the words inside the script are the CLI's.
    const launch = '/bin/sh -c "claude --model claude-opus-5-5"';
    const worker = `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5`;
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      workerSession: 'ses_keep',
      launched: true,
      launch,
      yaml: TEAM_YAML.replace(worker, worker.replace('launch: claude --model claude-opus-5-5', `launch: ${launch}`)),
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });

    const bin = join(fixture.base, 'bin');
    mkdirSync(bin, { recursive: true });
    const argvFile = join(fixture.base, 'argv.txt');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvFile}'\n`, { mode: 0o755 });

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, run.sources), io.err).toBe(0);
    const command = run.did.runs.find((line) => line.includes('/bin/sh -c'));
    expect(command).toBeDefined();
    execFileSync('/bin/sh', ['-c', command ?? ''], {
      cwd: fixture.root,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: fixture.home },
    });

    // Every word the CLI receives, in order: the line's own model, the carried resume, then the
    // profile's unattended, naming, rules and hook options — none of them after the closing quote.
    const argv = readFileSync(argvFile, 'utf8').split('\0').filter((word) => word !== '');
    expect(argv).toHaveLength(11);
    expect(argv.slice(0, 7)).toEqual([
      '--model',
      'claude-opus-5-5',
      '--resume',
      'ses_keep',
      '--dangerously-skip-permissions',
      '--name',
      'worker',
    ]);
    expect(argv[7]).toBe('--append-system-prompt');
    expect(argv[8]).toContain('Rules for this session');
    expect(argv[9]).toBe('--settings');
    expect(argv[10]).toMatch(/worker\.json$/);
  });

  test('a restored Codex wrapper keeps resume <id> after the flags the seat already names', async () => {
    const launch = 'zsh /home/owner/as-floor.sh codex -m gpt-6.1-sol -c model_reasoning_effort=high';
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      yaml: CODEX_TEAM_YAML.replace('    launch: codex -m gpt-6.1-sol', `    launch: ${launch}`),
      launch,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain(
      `AGENT_UNATTENDED=1 ${launch} resume ses_codex`,
    );
    expect(run.did.runs.join('\n')).not.toContain('--resume');
  });

  test('a restarted Codex seat resumes its recorded thread on an endpoint carrying its permissions', async () => {
    const launch = 'zsh /home/owner/as-floor.sh codex -m gpt-6.1-sol';
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      yaml: CODEX_TEAM_YAML.replace('    launch: codex -m gpt-6.1-sol', `    launch: ${launch}`),
      launch,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    // The successor reports the thread its command actually selected. A fresh command
    // cannot pass by leaving the old id in the state or registry.
    const agents = run.sources.upLaunch.agents;
    run.sources.upLaunch.agents = (session) => (agents(session) ?? []).map((agent) => ({
      ...agent,
      ...(agent.pane.startsWith('pane-new') ? {
        agent: 'codex',
        session: /(?:^|\s)resume\s+(\S+)/.exec(run.did.runs.at(-1) ?? '')?.[1] ?? 'ses_fresh',
      } : {}),
    }));
    const endpointConfigs: (string[] | undefined)[] = [];
    run.sources.upLaunch.codexEndpoint = {
      managed: async (endpoint: { config?: string[] }) => {
        endpointConfigs.push(endpoint.config);
        return { kind: 'up', url: 'unix:///tmp/worker.sock', started: true };
      },
      stop: () => ({ stopped: true }),
    } as unknown as NonNullable<Launch['codexEndpoint']>;
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(0);
    const command = run.did.runs.join('\n');
    expect(command).toContain(`AGENT_UNATTENDED=1 ${launch} resume ses_codex`);
    expect(command.match(/(?:^|\s)resume(?=\s|$)/g)).toHaveLength(1);
    expect(command).not.toMatch(/(?:^|\s)(?:-a|-s)(?=\s|$)/);
    expect(command).toContain('--no-alt-screen');
    expect(command).toContain(' --remote unix:///tmp/worker.sock');
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.agent_session).toBe('ses_codex');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_codex');
    expect(io.err).not.toContain('starts a fresh Codex thread');
    // The endpoint carries what the attached line shed: its turns run under the endpoint's config.
    expect(endpointConfigs).toHaveLength(1);
    expect(endpointConfigs[0]).toEqual(expect.arrayContaining(['approval_policy="never"', 'sandbox_mode="danger-full-access"']));
    expect(endpointConfigs[0]!.some((word) => word.startsWith('mcp_servers.team_inbox.args='))).toBe(true);
  });

  test.each([
    { cli: 'codex', live: 'ses_other', why: 'its live agent session is not the recorded one' },
    { cli: 'claude-code', live: 'ses_codex', why: 'the record ran claude-code, the seat now declares codex' },
  ])('a managed Codex restart refuses an unbound conversation: $why', async ({ cli, live, why }) => {
    const { fixture, run } = seeded({
      registry: 'ses_codex', state: 'ses_codex', declaredCli: 'codex',
      workerSession: live, launched: true, cli,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    let endpointStarts = 0;
    run.sources.upLaunch.codexEndpoint = {
      managed: async () => {
        endpointStarts++;
        return { kind: 'up', url: 'unix:///tmp/worker.sock', started: true };
      },
      stop: () => ({ stopped: true }),
    } as unknown as NonNullable<Launch['codexEndpoint']>;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker'], io, run.sources)).toBe(1);
    expect(io.err).toContain(`not resuming its recorded session (${why})`);
    expect(run.did.runs).toEqual([]);
    expect(run.did.closed).toEqual([]);
    expect(run.did.typed).toEqual([]);
    expect(endpointStarts).toBe(0);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.agent_session).toBe('ses_codex');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_codex');
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
    expect(run.did.runs.join('\n')).not.toMatch(/(?:^|\s)resume(?=\s|$)/);
    expect(run.did.runs.join('\n')).toContain('codex -m gpt-6.1-sol');
    // The caller's own flag is the reason: the context line does not present it as none recorded.
    expect(io.out).toContain(
      'worker: context: workspace close ends the pane; relaunch runs "codex -m gpt-6.1-sol" in a new workspace without passing the old transcript; abandoned by the caller\n',
    );
  });

  test('--fresh launches a new conversation and records the id the new pane reports', async () => {
    // The recorded conversation is not put on the line: the successor reports the conversation
    // its command actually started, and both records take that id.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      state: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const agents = run.sources.upLaunch.agents;
    run.sources.upLaunch.agents = (session) => (agents(session) ?? []).map((agent) => ({
      ...agent,
      ...(agent.pane.startsWith('pane-new') ? { agent: 'codex', session: 'ses_fresh' } : {}),
    }));
    run.sources.screenText = (_session, pane) =>
      pane === 'pane-old' ? (run.did.typed.length > 0 ? CODEX_EXIT_TYPED : CODEX_OLD_IDLE) : CODEX_NEW_IDLE;
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--fresh'], io, run.sources)).toBe(0);
    const command = run.did.runs.join('\n');
    expect(command).toContain('codex -m gpt-6.1-sol');
    expect(command).not.toMatch(/(?:^|\s)resume(?=\s|$)/);
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.agent_session).toBe('ses_fresh');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe('ses_fresh');
    // The caller chose the new conversation: the context line says so, and no refusal was said.
    expect(io.out).toContain('started fresh by the caller');
    expect(io.err).toBe('');
  });

  test('--fresh refuses a launch line that itself names a conversation, before the stop', async () => {
    // A fresh start cannot run a line that selects a conversation of its own: the stop is not
    // made and nothing is typed.
    const { fixture, run } = seeded({
      registry: 'ses_codex',
      declaredCli: 'codex',
      workerSession: 'ses_codex',
      launched: true,
      launch: 'codex -m gpt-6.1-sol resume ses_other',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    const code = await runRestart(['worker', '--fresh'], io, run.sources);
    expect(run.did.runs).toEqual([]);
    expect(code).toBe(1);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
    expect(run.did.typed).toEqual([]);
    expect(io.err).toContain('worker: its launch line itself names a conversation, so --fresh cannot start a new one; left as it is (clear the resume selection from its launch line for a fresh start)');
  });

  test('--fresh starts fresh when the launch line itself sets a new session id', async () => {
    // A resume form exists, but the recorded line already names a new conversation of its own, so
    // a plain restart refuses to guess. The caller's --fresh runs the declared line as the profile
    // wrote it, and the conversation the launch mints is the one the seat records.
    const { fixture, run } = seeded({
      registry: 'ses_keep',
      state: 'ses_keep',
      launch: 'claude --model claude-opus-5-5 --session-id ses_new',
    });
    run.sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const io = testIo(fixture.root, { kind: 'owner' });

    expect(await runRestart(['worker', '--fresh'], io, run.sources), io.err).toBe(0);
    expect(run.did.closed).toContain('ws-old');
    expect(run.did.runs.join('\n')).toContain('claude --model claude-opus-5-5');
    expect(run.did.runs.join('\n')).not.toContain('--resume ses_keep');
    expect(io.err).toContain('worker: not resuming its recorded session (its launch line already sets a new session id)');
    const recorded = readState(fixture.dir).sessions.acme?.seats.worker?.agent_session;
    expect(recorded).toBeDefined();
    expect(recorded).not.toBe('ses_keep');
  });

  test('--fresh on a working seat is refused like any restart: no pane is taken', async () => {
    // --fresh decides the conversation, never the pane: a seat mid-turn is left alone, exactly as
    // a plain restart leaves it, and a lead gets the plain refusal.
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
      session.seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
        agent_session: 'ses_keep',
      };
    });
    const run = makeHarness(fixture, { workerScreen: 'working', workerStatus: 'working' });
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });

    expect(await runRestart(['worker', '--fresh'], io, run.sources)).toBe(1);
    expect(io.err).toContain('worker is working; left as it is');
    expect(run.did.typed).toEqual([]);
    expect(run.did.closed).toEqual([]);
    expect(run.did.created).toBe(0);
  });

  test('a team lead runs --fresh on a declared seat', async () => {
    const { fixture, run } = seeded({ registry: 'ses_keep', state: 'ses_keep' });
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    });
    const io = testIo(fixture.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });

    expect(await runRestart(['worker', '--fresh'], io, run.sources)).toBe(0);
    expect(run.did.runs.join('\n')).toContain('claude --model claude-opus-5-5');
    expect(run.did.runs.join('\n')).not.toContain('--resume ses_keep');
    expect(io.out).toContain('started fresh by the caller');
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
    // The context line repeats the reason the run gave: it never reads as a silent fresh start.
    expect(io.out).toContain(
      'worker: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript; not resuming its recorded conversation (its live agent session is not the recorded one)\n',
    );
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
    // The carried resume was dropped under the run lock: the context line says so, with the why.
    expect(io.out).toContain(
      'worker: context: workspace close ends the pane; relaunch runs "claude --model claude-opus-5-5" in a new workspace without passing the old transcript; its recorded conversation was dropped before the launch (the seat record changed before the launch)\n',
    );
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

// Independent checks of the --fresh flag, written for the independent test lane against the
// flag's own claims rather than the author's scenes: the dry A/B in one world (a plain restart
// still resumes; --fresh does not put the recorded id on the line), a real --fresh leaving the
// old conversation's transcript bytes on disk while both records take the session the new pane
// reports, and a signed-off seat revived by --fresh the way any restart revives it.
describe('independent checks: restart --fresh', () => {
  test('a dry plan in one world: plain restart resumes the recorded id, --fresh does not', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
        agent_session: 'ses_keep',
      };
    });
    registerAgent(fixture.home, {
      name: 'worker',
      signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: {
        team: teamIdOf(fixture.root),
        seat: 'worker',
        session: 'acme',
        pane: 'pane-old',
        address: null,
        agent_session: 'ses_keep',
      },
      seat_handle: 'seat_0123456789ab',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    const { sources, did } = makeHarness(fixture, { workerSession: 'ses_keep' });

    const plain = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--dry-run'], plain, sources)).toBe(0);
    expect(plain.err).toBe('');
    expect(plain.out).toContain('--resume ses_keep');

    const fresh = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--fresh', '--dry-run'], fresh, sources)).toBe(0);
    expect(fresh.err).toBe('');
    // The fresh dry plan is the same plan without the recorded id: no resume anywhere, and the
    // dry answer still decides nothing. (The fresh note itself is a real-run context line —
    // the real-run test below asserts it there.)
    expect(fresh.out).not.toMatch(/resume/);
    expect(fresh.out).toContain('claude --model claude-opus-5-5');
    expect(fresh.out).toContain('dry run: nothing was run');

    expect(did.typed).toEqual([]);
    expect(did.closed).toEqual([]);
    expect(did.created).toBe(0);
  });

  test('--fresh leaves the old conversation file on disk and both records take the new pane session', async () => {
    const fixture = makeFixture();
    updateState(fixture.dir, (state) => {
      (state.sessions.acme ??= emptySession()).seats.worker = {
        stage: 'ready',
        pane: 'pane-old',
        workspace: 'ws-old',
        id: 'seat_0123456789ab',
        agent_session: 'ses_keep',
      };
    });
    registerAgent(fixture.home, {
      name: 'worker',
      signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude --model claude-opus-5-5',
      reach: {
        team: teamIdOf(fixture.root),
        seat: 'worker',
        session: 'acme',
        pane: 'pane-old',
        address: null,
        agent_session: 'ses_keep',
      },
      seat_handle: 'seat_0123456789ab',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    // The old conversation's own file, where a CLI keeps it: the run may start a new
    // conversation, and nothing it does may touch this file's bytes.
    const sessionsDir = join(fixture.home, '.claude', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const transcript = join(sessionsDir, 'ses_keep.jsonl');
    const bytes = 'line one of the old conversation\nline two\n';
    writeFileSync(transcript, bytes);
    const { sources, did } = makeHarness(fixture, { workerSession: 'ses_keep' });
    sources.upLaunch.processInfo = () => ({ shell: 101, foreground: [201] });
    const agents = sources.upLaunch.agents;
    sources.upLaunch.agents = (session) => (agents(session) ?? []).map((agent) => (
      agent.pane.startsWith('pane-new') ? { ...agent, agent: 'claude-code', session: 'ses_minted' } : agent
    ));

    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker', '--fresh'], io, sources)).toBe(0);
    expect(io.err).toBe('');
    expect(readFileSync(transcript, 'utf8')).toBe(bytes);
    expect(did.runs.join('\n')).toContain('claude --model claude-opus-5-5');
    expect(did.runs.join('\n')).not.toMatch(/(?:^|\s)resume(?=\s|$)/);
    // The new conversation's id is whatever the new pane reported — not the recorded one — and
    // both records carry the SAME new id.
    const minted = readState(fixture.dir).sessions.acme?.seats.worker?.agent_session;
    expect(minted).toBeDefined();
    expect(minted).not.toBe('ses_keep');
    expect(findAgent(fixture.home, { team: teamIdOf(fixture.root), seat: 'worker' })?.reach.agent_session).toBe(minted);
    expect(io.out).toContain('started fresh by the caller');
  });

  test('--fresh revives a signed-off seat the way a plain restart does', async () => {
    const fixture = makeFixture();
    intoRegistry(fixture.root, fixture.home);
    const stored = storedTeam(fixture.root, fixture.home);
    if (stored === null) throw new Error('the fixture team is not in the registry');
    await underRegistry(async () => {
      expect(writeTeamText(fixture.file, markStopped(readTeamText(fixture.file, { home: fixture.home }), 'worker'), { home: fixture.home, command: 'remove' }))
        .toEqual({ ok: true, target: 'registry' });
      const { sources, did } = makeHarness(fixture);
      const io = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['worker', '--fresh'], io, sources), io.err).toBe(0);
      expect(io.out).toContain('team restart: restarted worker; pane pane-old -> pane-new\n');
      expect(seatIsStopped(storedTeam(fixture.root, fixture.home)?.text ?? '', 'worker')).toBe(false);
      expect(did.closed).toEqual(['ws-old']);
      expect(did.created).toBe(1);
      expect(did.runs.join('\n')).not.toMatch(/resume/);
    });
  });
});

describe('independent checks: restart clears unsent /exit on refused or swallowed Enter', () => {
  test('refused or swallowed Enter during restart clears our /exit with exit_clear and leaves the seat running', async () => {
    for (const mode of ['refused', 'swallowed'] as const) {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        (state.sessions.acme ??= emptySession()).seats.worker = {
          stage: 'ready',
          pane: 'pane-old',
          workspace: 'ws-old',
          id: 'seat_0123456789ab',
        };
      });
      const { sources, did } = makeHarness(fixture);
      const keysSent: string[] = [];
      let enterCalls = 0;
      let screenBox = claudeBox('');
      sources.screenText = () => screenBox;
      sources.launch!.typeText = (_session, _pane, text) => {
        did.typed.push(text);
        screenBox = claudeBox(text);
        return true;
      };
      sources.launch!.pressEnter = () => {
        enterCalls += 1;
        // Refused Enter returns false; swallowed Enter returns true without emptying the box or exiting to zsh.
        return mode === 'swallowed';
      };
      sources.launch!.sendKey = (_session, _pane, key) => {
        keysSent.push(key);
        if (key === 'ctrl+c') screenBox = claudeBox('');
        return true;
      };

      const io = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['worker'], io, sources), mode).toBe(1);
      expect(did.typed, mode).toEqual(['/exit']);
      expect(enterCalls, mode).toBe(1);
      expect(keysSent, mode).toEqual(['ctrl+c']);
      expect(did.closed, mode).toEqual([]);
      expect(did.created, mode).toBe(0);
      expect(io.out, mode).toContain(
        'worker: its exit was not confirmed; the text was cleared; left running (team restart worker --abandon closes it)\n',
      );
      expect(io.err, mode).toBe('team restart: worker could not be stopped; left as it is\n');
    }
  });

  test('person typing into the box or adding a continuation row after /exit during restart is never cleared', async () => {
    for (const boxAfterEnter of [claudeBox('my own draft'), claudeBox('/exit now'), claudeBox('/exit\n  second row')]) {
      const fixture = makeFixture();
      updateState(fixture.dir, (state) => {
        (state.sessions.acme ??= emptySession()).seats.worker = {
          stage: 'ready',
          pane: 'pane-old',
          workspace: 'ws-old',
          id: 'seat_0123456789ab',
        };
      });
      const { sources, did } = makeHarness(fixture);
      const keysSent: string[] = [];
      let screenBox = claudeBox('');
      sources.screenText = () => screenBox;
      sources.launch!.typeText = (_session, _pane, text) => {
        did.typed.push(text);
        screenBox = claudeBox(text);
        return true;
      };
      sources.launch!.pressEnter = () => {
        screenBox = boxAfterEnter;
        return false;
      };
      sources.launch!.sendKey = (_session, _pane, key) => {
        keysSent.push(key);
        return true;
      };

      const io = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['worker'], io, sources)).toBe(1);
      expect(did.typed).toEqual(['/exit']);
      expect(keysSent).toEqual([]);
      expect(did.closed).toEqual([]);
      expect(did.created).toBe(0);
      expect(io.out).toContain(
        'worker: its exit was not confirmed; the exit text was typed and not sent; left running (team restart worker --abandon closes it)\n',
      );
      expect(io.err).toBe('team restart: worker could not be stopped; left as it is\n');
    }
  });
});

const SIGNATURE_WHY = 'the record does not carry a valid signature: it was changed after approval, or written without the key';

/** A signed approval in the fixture home, then one flipped signature byte. The stored file is
 *  what the sentence names. The bytes returned are the record after that flip. */
function plantUnverifiedApproval(fixture: Fixture): { approval: string; bytes: string; file: string; root: string; generation: number } {
  const loaded = loadTeamFile(fixture.root, { home: fixture.home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, fixture.home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: fixture.yaml },
    loaded.team.seats,
    fixture.home,
    NOW,
  );
  const approval = join(store, 'approval.json');
  const parsed = JSON.parse(readFileSync(approval, 'utf8')) as { signature?: string; file?: string };
  if (typeof parsed.signature !== 'string' || parsed.signature.length === 0 || typeof parsed.file !== 'string') {
    throw new Error('the planted approval has no signature');
  }
  const at = parsed.signature.length - 1;
  const last = parsed.signature[at] === 'a' ? 'b' : 'a';
  parsed.signature = `${parsed.signature.slice(0, at)}${last}`;
  const bytes = `${JSON.stringify(parsed, null, 2)}\n`;
  writeFileSync(approval, bytes);
  const standing = approvalStanding(loaded.root, fixture.home);
  if (standing.kind !== 'refused' || standing.why !== SIGNATURE_WHY) {
    throw new Error(`planted standing ${JSON.stringify(standing)}`);
  }
  const generation = recordedGeneration(loaded.root, fixture.home)?.generation;
  if (generation === undefined) throw new Error('the planted approval has no generation');
  return { approval, bytes, file: parsed.file, root: loaded.root, generation };
}

describe('a stored approval that does not verify', () => {
  test('the sentence names the record, the first lines, and the re-sign command', () => {
    const file = 'format: 1\nproject: acme\ncoordinator: lead\n';
    expect(unverifiedRecordSentence("acme's approval record", file)).toBe(
      'acme\'s approval record does not verify: 3 unverified lines ("format: 1"; "project: acme"; "coordinator: lead"); standing cannot be renewed in this build, and the owner is to be told',
    );
    expect(unverifiedRecordSentence('the approval record', 'rules: read this\n')).toBe(
      'the approval record does not verify: 1 unverified line ("rules: read this"); standing cannot be renewed in this build, and the owner is to be told',
    );
  });

  function ready(fixture: Fixture): RestartSources {
    updateState(fixture.dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', id: 'seat_0123456789ab' };
    });
    return makeHarness(fixture).sources;
  }

  test('dev mode says the record and the re-sign command, and continues without signing', async () => {
    const fixture = makeFixture();
    const planted = plantUnverifiedApproval(fixture);
    const sources = ready(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const sentence = unverifiedRecordSentence(`${fixture.yaml.match(/^project: (\S+)/m)?.[1] ?? 'acme'}'s approval record`, planted.file);
    expect(await runRestart(['worker'], io, sources), io.err).toBe(0);
    expect(io.err).toBe(`team restart: ${sentence}\n`);
    expect(io.out).toContain('restarted worker');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(recordedGeneration(planted.root, fixture.home)?.generation).toBe(planted.generation);
  });

  test('dev mode keeps the sentence on the document and leaves stdout as that document', async () => {
    const fixture = makeFixture();
    const planted = plantUnverifiedApproval(fixture);
    const sources = ready(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const sentence = unverifiedRecordSentence("acme's approval record", planted.file);
    expect(await runRestart(['worker', '--json'], io, sources), io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out.startsWith('{')).toBe(true);
    const doc = JSON.parse(io.out) as { notes?: string[] };
    expect(doc.notes).toContain(sentence);
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(recordedGeneration(planted.root, fixture.home)?.generation).toBe(planted.generation);
  });

  test('outside dev mode the refusal stays the signature sentence and nothing restarts', async () => {
    const fixture = makeFixture();
    const planted = plantUnverifiedApproval(fixture);
    const sources = ready(fixture);
    const io = testIo(fixture.root, { kind: 'owner' });
    expect(await runRestart(['worker'], io, sources), io.err).toBe(1);
    expect(io.err).toBe(`team restart: ${SIGNATURE_WHY}\n`);
    expect(io.out).toBe('');
    expect(readState(fixture.dir).sessions.acme?.seats.worker?.pane).toBe('pane-old');
    expect(readFileSync(planted.approval, 'utf8')).toBe(planted.bytes);
    expect(recordedGeneration(planted.root, fixture.home)?.generation).toBe(planted.generation);
  });
});



describe('review: restart honors recorded own and peer folders', () => {
  for (const cli of ['grok', 'cursor']) for (const occupied of [false, true]) {
    test(`${cli} recorded worktree, occupied=${occupied}`, async () => {
      const fixture = makeFixture(cli === 'grok' ? GROK_TEAM_YAML : CURSOR_TEAM_YAML);
      const own = join(fixture.base, 'own'); mkdirSync(own);
      updateState(fixture.dir, state => {
        const session = state.sessions.acme ??= emptySession();
        session.worktrees.task = { seat: 'worker', path: own, branch: 'fix/own', setup: 'ok' };
        if (occupied) session.worktrees.peer = { seat: 'lead', path: own, branch: 'fix/peer', setup: 'ok' };
      });
      const run = makeHarness(fixture, { initialRunning: false, foregroundArgv0: cli === 'grok' ? 'grok' : 'cursor-agent' });
      const io = testIo(fixture.root, { kind: 'owner' });
      expect(await runRestart(['worker', '--dry-run'], io, run.sources), io.err).toBe(occupied ? 1 : 0);
      if (occupied) expect(io.err).toContain('overlaps seat lead');
      else expect(io.out).toContain(own);
      expect(run.did.closed).toEqual([]);
      expect(run.did.created).toBe(0);
    });
  }
});
