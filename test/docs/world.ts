// The world a page's examples run in: a herdr session of fake agents and panes, a machine with
// fixed figures, and the sources every command takes, so nothing reaches a real herdr, a real CLI,
// or the owner's home. Modelled on the fakes of test/commands/live.test.ts, widened to all the
// commands the reference documents.
import { join } from 'node:path';
import { budgetsInForce, watchInForce } from '../../src/approve/approval.ts';
import { standingSource } from '../../src/commands/status.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { AddSources } from '../../src/commands/add.ts';
import type { CheckSources } from '../../src/check/team.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { DownLaunch, DownSources } from '../../src/commands/down.ts';
import type { McpSources, PathStat } from '../../src/commands/mcp.ts';
import type { RemoveSources } from '../../src/commands/remove.ts';
import type { RegisterSources } from '../../src/commands/register.ts';
import type { RestartSources } from '../../src/commands/restart.ts';
import type { ListSources } from '../../src/commands/list.ts';
import type { ProjectSources } from '../../src/commands/projects.ts';
import type { StatusSources } from '../../src/commands/status.ts';
import type { Launch, UpSources } from '../../src/commands/up.ts';
import type { WatchSources } from '../../src/commands/watch.ts';
import type { Attempt, Fetch } from '../../src/release/http.ts';
import type { KeyReader } from '../../src/release/keychain.ts';
import type { Seat, TeamFile } from '../../src/file/types.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import type { Live } from '../../src/status/compare.ts';
import type { Machine } from '../../src/watch/machine.ts';
import { profileFor } from '../../src/profiles/index.ts';
import * as projectRegistry from '../../src/registry/projects.ts';
import { readScreen } from '../../src/watch/screen.ts';
import type { ScreenKind, Spec, ToolState } from './spec.ts';

/** The pid the fixture's state records for a watch that is alive. */
export const WATCH_PID = 4242;

/** The pid the fixture's `team proc` records call running — the proc page's own process, which
 *  its `--pid` example requires to be running. Every other number is a process that is gone. */
export const PROC_PID = 4243;

/** The pid a `team watch` run in a page has: never the recorded one, as a person's is not. */
export const RUN_WATCH_PID = 9001;

/** The project registry's reads, bound to one home: what a page's `~/.config/team/projects.yaml`
 *  holds. `team projects`, `team status --project` and `team send --list` read the fixture's own
 *  registry file through this, so a page's `yaml file=../../.config/team/projects.yaml` fence is
 *  the registry its examples are read against. */
export function projectsAt(home: string): ProjectSources {
  return {
    list: () => projectRegistry.list(home),
    byName: (name) => projectRegistry.byName(home, name),
    ofTeam: (team) => projectRegistry.ofTeam(home, team),
  };
}

/** One live agent, or a workspace herdr made before its agent started. */
type Slot = {
  name: string | null;
  agent: boolean;
  pane: string;
  workspace: string;
  label: string;
  cli: string;
  status: string;
  screen: ScreenKind;
  seat?: Seat;
};

const TOOL_TESTED: Record<string, { binary: string; version: string; old: string; login: string }> = {
  'claude-code': { binary: 'claude', version: '2.1.288', old: '2.1.200', login: 'claude-code' },
  codex: { binary: 'codex', version: '0.157.0', old: '0.150.0', login: 'codex' },
  cursor: { binary: 'cursor-agent', version: '2026.10.01', old: '2026.09.01', login: 'cursor' },
  antigravity: { binary: 'agy', version: '1.2.16', old: '1.1.0', login: 'antigravity' },
};

/** What one seat's pane shows, in the shapes its CLI really prints. */
export function screenText(cli: string, kind: ScreenKind, seat?: Seat): string {
  if (cli !== 'claude-code') {
    throw new Error(`the docs fake knows no screens for \`${cli}\`: use a claude-code seat, or teach screenText its shapes`);
  }
  const family = seat?.model.replace(/^Claude\s+/, '') ?? 'Opus';
  const version = seat?.version ?? '5.5';
  const rule = '─'.repeat(24);
  const status = `  main · …/beacon · ${family} ${version} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
  switch (kind) {
    case 'idle':
      return `❯ \n${rule}\n${status}`;
    case 'working':
      return `✻ Working… (12s)\n❯ \n${rule}\n${status}`;
    case 'permission':
      return `Do you want to proceed?\n❯ 1. Yes\n  2. No\n`;
    case 'trust':
      return `Is this a project you created or one you trust?\n❯ 1. Yes\n  2. No\n`;
    case 'question':
      return `Which change should I make?\nEnter to select\n`;
    case 'unsent':
      return `❯ half a sentence\n${rule}\n${status}`;
    default:
      return `sh: no such file or directory\n`;
  }
}

/** What a pane shows once text is typed into it: the composer holding the text, in the shape
 *  `screenText` gives for an unsent box of the same CLI — the prompt row, then the rest. */
function typedBox(cli: string, text: string, seat?: Seat): string {
  const [first = '', ...rest] = text.split('\n');
  const unsent = screenText(cli, 'unsent', seat).split('\n');
  return [`❯ ${first}`, ...rest.map((line) => `  ${line}`), ...unsent.slice(1)].join('\n');
}

/** What herdr's own status says of a pane showing this screen: down.ts reads a dialog as blocked. */
function statusOf(kind: ScreenKind): string {
  if (kind === 'working') return 'working';
  if (kind === 'permission' || kind === 'trust' || kind === 'question') return 'blocked';
  return 'idle';
}

// The public records of material 3.0.2 as the release page shows them: published with provenance,
// the changelog entry right, but the tag not yet on the default branch — the specification's own
// example, so the page's transcript is the contract's. An unlisted URL is a failed read; no page
// reaches a real network.
const RELEASE_COMMIT = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';
const RELEASE_CHANGELOG = `# Changelog

All notable changes to material are documented here.

## [3.0.2] - 2026-10-01

- Fix the column the prompt is drawn in.
`;
const RELEASE_ANSWERS: Record<string, Attempt> = {
  'https://registry.npmjs.org/material/3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({
      name: 'material',
      version: '3.0.2',
      dist: { shasum: '9f2c1e7a4b3d5e6f8a0b1c2d3e4f5a6b7c8d9e0f', integrity: 'sha512-3d09ab7e52fd19a4ee7a0a78a1c8db93a4cf37b28c19a9f1aef3bb96b9c7b0c5d1e2f3a4b5c6d7e8f9a0b1c2==' },
    }),
  },
  'https://registry.npmjs.org/-/npm/v1/attestations/material%403.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ attestations: [{ predicateType: 'https://slsa.dev/provenance/v1' }] }),
  },
  // The page's material example warns: its `next` tag is a patch behind `latest`.
  'https://registry.npmjs.org/-/package/material/dist-tags': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ latest: '3.0.2', next: '3.0.1' }),
  },
  'https://api.github.com/repos/floor/material': { kind: 'http', status: 200, body: JSON.stringify({ full_name: 'floor/material', default_branch: 'main' }) },
  'https://api.github.com/repos/floor/material/git/ref/tags/v3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ ref: 'refs/tags/v3.0.2', object: { sha: RELEASE_COMMIT, type: 'commit' } }),
  },
  [`https://api.github.com/repos/floor/material/compare/${RELEASE_COMMIT}...main`]: {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ status: 'behind', ahead_by: 0, behind_by: 2 }),
  },
  'https://api.github.com/repos/floor/material/releases/tags/v3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ tag_name: 'v3.0.2', draft: false, prerelease: false }),
  },
  'https://api.github.com/repos/floor/material/contents/CHANGELOG.md?ref=main': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ name: 'CHANGELOG.md', type: 'file', encoding: 'base64', content: `${Buffer.from(RELEASE_CHANGELOG, 'utf8').toString('base64')}\n` }),
  },
};

// The records example the page shows beside material: widgets 3.0.2 with both optional pairs
// configured — the Linear project active with its done milestone and a qualifying status update,
// the marker exactly once in the public activity file. The key the Linear read carries is a
// deliberate stand-in string; no example reaches the Keychain or a real network.
const WIDGETS_COMMIT = 'b6e2e2f0c9f8d3a1b4c5d6e7f8a9b0c1d2e3f4a5';
const WIDGETS_CHANGELOG = `# Changelog

All notable changes to widgets are documented here.

## [3.0.2] - 2026-10-01

- Round the corner the panel is drawn with.
`;
const WIDGETS_ACTIVITY = `# Activity

release: widgets@3.0.2
`;
const RECORDS_PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const RECORDS_KEY = 'test-key-not-real';

function contentsOf(text: string): Attempt {
  return {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ type: 'file', encoding: 'base64', content: `${Buffer.from(text, 'utf8').toString('base64')}\n` }),
  };
}

const RELEASE_RECORDS_ANSWERS: Record<string, Attempt> = {
  'https://registry.npmjs.org/widgets/3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({
      name: 'widgets',
      version: '3.0.2',
      dist: { shasum: '4c1f9b2a8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b', integrity: 'sha512-7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9==' },
    }),
  },
  'https://api.github.com/repos/floor/widgets': { kind: 'http', status: 200, body: JSON.stringify({ full_name: 'floor/widgets', default_branch: 'main' }) },
  'https://api.github.com/repos/floor/widgets/git/ref/tags/v3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ ref: 'refs/tags/v3.0.2', object: { sha: WIDGETS_COMMIT, type: 'commit' } }),
  },
  [`https://api.github.com/repos/floor/widgets/compare/${WIDGETS_COMMIT}...main`]: {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ status: 'identical', ahead_by: 0, behind_by: 0 }),
  },
  'https://api.github.com/repos/floor/widgets/releases/tags/v3.0.2': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({ tag_name: 'v3.0.2', draft: false, prerelease: false }),
  },
  'https://api.github.com/repos/floor/widgets/contents/CHANGELOG.md?ref=main': contentsOf(WIDGETS_CHANGELOG),
  'https://api.github.com/repos/floor/widgets/contents/activity/2026/widgets.md?ref=main': contentsOf(WIDGETS_ACTIVITY),
  'https://api.linear.app/graphql': {
    kind: 'http',
    status: 200,
    body: JSON.stringify({
      data: {
        project: {
          id: RECORDS_PROJECT,
          archivedAt: null,
          projectMilestones: { nodes: [{ name: '3.0.2', status: 'done' }], pageInfo: { hasNextPage: false } },
          projectUpdates: { nodes: [{ createdAt: '2026-10-01T12:00:00Z', archivedAt: null }], pageInfo: { hasNextPage: false } },
        },
      },
    }),
  },
};

export function releaseAnswers(url: string): Attempt {
  return RELEASE_ANSWERS[url] ?? RELEASE_RECORDS_ANSWERS[url] ?? { kind: 'transport' };
}

export type World = {
  /** What `status` and the watch see, or null when herdr doesn't answer. */
  live(session: string): Live | null;
  upSources(): UpSources;
  downSources(): DownSources;
  removeSources(): RemoveSources;
  restartSources(): RestartSources;
  addSources(): AddSources;
  registerSources(): RegisterSources;
  checkSources(): CheckSources;
  statusSources(): StatusSources;
  listSources(): ListSources;
  watchSources(): WatchSources;
  doctorSources(): DoctorSources;
  mcpSources(): McpSources;
  /** The recorded npm, GitHub and Linear answers the release page's examples replay. */
  releaseFetch(): Fetch;
  /** The release page's stand-in for the Keychain read: a fixed, deliberate non-real key. */
  releaseKeyReader(): KeyReader;
  /** The pane a running seat of the fixture is in, or undefined when nothing runs it. */
  paneOf(name: string): string | undefined;
  /** What the watch a run just started does before a reader types the next line: its pane's
   *  command is up, so its first pass has run — the pid `team status` and the checks read. */
  settle(): void;
  setScreen(seat: string, kind: ScreenKind): void;
  setMachine(kind: Spec['machine']): void;
  /** One CLI's installed-and-logged-in state, on top of the fixture's own. */
  setTools(tools: Record<string, ToolState>): void;
  /** The session's state in herdr, for one example (`herdr=` on a console fence). */
  setHerdr(kind: Spec['herdr']): void;
  readonly did: {
    starts: number;
    runs: string[];
    typed: string[];
    closed: string[];
    stopped: number;
    deleted: string[];
    killed: number[];
    notified: string[];
  };
};

export function createWorld(input: { team: TeamFile | null; spec: Spec; root: string; home: string }): World {
  const { team, spec, root, home } = input;
  const dir = join(root, '.agents');
  const session = team?.session ?? 'beacon';
  let clock = Date.parse(spec.now);
  let herdr = spec.herdr;
  // A watch that is already alive, or one the plan starts: `up` must not start a second.
  let watchPid: number | null = spec.watch === 'alive' || spec.watch === 'stale' ? WATCH_PID : null;
  // The fixture's own process table: the pids a page calls running. Every command that reads a
  // pid is handed this, so no example depends on a process the machine running the suite has.
  const alivePid = (pid: number): boolean => pid === PROC_PID || (watchPid !== null && pid === watchPid);
  // The pane a run started a watch in, until `settle` records the pass it reaches next.
  let startedWatch: string | null = null;
  let made = 0;
  const slots: Slot[] = [];
  // What each pane holds once text was typed into it, so a read-back reads the typed text.
  const typedInto = new Map<string, string>();
  const did: World['did'] = { starts: 0, runs: [], typed: [], closed: [], stopped: 0, deleted: [], killed: [], notified: [] };
  const now = () => new Date(clock);
  const sleep = async (ms: number) => {
    clock += ms;
  };

  const chosen = (seat: Seat): boolean => spec.agents === 'all' || spec.agents.includes(seat.name);
  if (team) {
    for (const seat of team.seats) {
      if (!chosen(seat)) continue;
      made++;
      const screen = spec.screens[seat.name] ?? 'idle';
      slots.push({
        name: seat.name,
        agent: true,
        pane: `w${made}:p1`,
        workspace: `w${made}`,
        label: seat.label,
        cli: seat.cli,
        status: statusOf(screen),
        screen,
        seat,
      });
    }
  }

  const agentOf = (pane: string) => slots.find((slot) => slot.pane === pane);
  const agents = (): HerdrAgent[] =>
    slots
      .filter((slot) => slot.agent)
      .map((slot) => ({
        name: slot.name,
        agent: slot.cli,
        pane: slot.pane,
        workspace: slot.workspace,
        status: slot.status,
        cwd: root,
      }));
  const texts = (): Record<string, string> => {
    const screens: Record<string, string> = {};
    for (const slot of slots) if (slot.agent) screens[slot.pane] = screenText(slot.cli, slot.screen, slot.seat);
    return screens;
  };
  const workspaces = () => slots.map((slot) => ({ id: slot.workspace, label: slot.label }));
  const sessionState = (): 'absent' | 'running' | 'stopped' => (herdr === 'running' ? 'running' : herdr === 'stopped' ? 'stopped' : 'absent');

  // A page may change the machine or a CLI's tool state for one example (`machine=` or `tools=` on
  // a console fence); the fixture's own are back for the next one.
  let machineKind = spec.machine;
  let toolState: Record<string, ToolState> = { ...spec.tools };
  const machine = (): Machine =>
    machineKind === 'calm'
      ? { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }
      : machineKind === 'tight'
        ? { loadPerCore: 1.2, memoryFree: 8, diskFree: 120e9, swapTotal: 16e9, swapFree: 8e9, swapUsed: 0 }
        : { loadPerCore: 0.4, memoryFree: 62, diskFree: 120e9, swapTotal: 1e9, swapFree: 0.5e9, swapUsed: 0.5e9 };

  const action = {
    sessionState: () => (herdr === 'none' ? null : sessionState()),
    startServer() {
      did.starts++;
      herdr = 'running';
      return true;
    },
    sessionUp: () => herdr === 'running',
    createWorkspace(_session: string, cwd: string, label: string) {
      const seat = team?.seats.find((candidate) => candidate.label === label);
      made++;
      const pane = `w${made}:p1`;
      const screen = seat ? (spec.screens[seat.name] ?? 'idle') : 'idle';
      slots.push({
        name: null,
        agent: false,
        pane,
        workspace: `w${made}`,
        label,
        cli: seat?.cli ?? 'claude-code',
        status: statusOf(screen),
        screen,
        seat,
      });
      return { pane, workspace: `w${made}` };
    },
    paneRun(_session: string, pane: string, command: string) {
      did.runs.push(command);
      const slot = agentOf(pane);
      // The watch's pane runs a shell command, not an agent: herdr lists no agent in it.
      const watch = /\bteam watch\b/.test(command);
      if (slot && !watch) slot.agent = true;
      // A watch a run starts is settled once the run is done: its own first pass, which a real
      // one reaches the moment its command starts, is what records the process beside the pane.
      if (watch) {
        watchPid = WATCH_PID;
        startedWatch = pane;
        updateState(dir, (state) => {
          const record = (state.sessions[session] ??= emptySession());
          record.watch = { pane, heartbeat: now().toISOString() };
        });
      }
      return true;
    },
    renameAgent(_session: string, pane: string, name: string) {
      const slot = agentOf(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace(_session: string, workspace: string) {
      did.closed.push(workspace);
      const at = slots.findIndex((slot) => slot.workspace === workspace);
      if (at >= 0) slots.splice(at, 1);
      return true;
    },
    agentPanes: () => slots.filter((slot) => slot.agent).map((slot) => slot.pane),
    agents: () =>
      slots
        .filter((slot) => slot.agent && slot.name !== null)
        .map((slot) => ({
          name: slot.name,
          agent: slot.cli,
          pane: slot.pane,
          workspace: slot.workspace,
          status: slot.status,
          cwd: null,
        })),
    paneText: (_session: string, pane: string) => {
      const slot = agentOf(pane);
      if (!slot) return '';
      const typed = typedInto.get(pane);
      return typed !== undefined ? typedBox(slot.cli, typed, slot.seat) : screenText(slot.cli, slot.screen, slot.seat);
    },
    typeText: (_session: string, pane: string, text: string) => {
      did.typed.push(text);
      typedInto.set(pane, text);
      return true;
    },
    // Enter submits the composer: the text is sent and the box reads empty again (the CLI's turn
    // is not modelled here — a screen that was idle stays idle).
    pressEnter: (_session: string, pane: string) => {
      typedInto.delete(pane);
      return true;
    },
    agentStatus: (_session: string, pane: string) => agentOf(pane)?.status ?? null,
    sleep,
    now,
  };

  const launch: Launch = {
    sessionState: action.sessionState,
    startServer: action.startServer,
    sessionUp: action.sessionUp,
    createWorkspace: action.createWorkspace,
    paneRun: action.paneRun,
    renameAgent: action.renameAgent,
    closeWorkspace: action.closeWorkspace,
    agentPanes: action.agentPanes,
    agents: action.agents,
    paneText: action.paneText,
    typeText: action.typeText,
    pressEnter: action.pressEnter,
    agentStatus: action.agentStatus,
    foreground: (_session, pane) => {
      const cli = agentOf(pane)?.cli ?? 'claude-code';
      return [profileFor(cli)?.processNames[0] ?? 'claude'];
    },
    deleteSession(session: string) {
      did.deleted.push(session);
      herdr = 'absent';
      return true;
    },
    sleep,
    now,
  };

  const shelled = new Set<string>();
  const downLaunch: DownLaunch = {
    typeText: action.typeText,
    sendKey: () => true,
    pressEnter(session, pane) {
      shelled.add(pane);
      return action.pressEnter(session, pane);
    },
    agentPanes: action.agentPanes,
    closeWorkspace: action.closeWorkspace,
    stopSession(_session: string) {
      did.stopped++;
      // A stopped session stays listed in herdr until it is cleared.
      herdr = 'stopped';
      return true;
    },
    // The one case `team` deletes a session: `down` clearing the one it has itself just stopped.
    deleteSession(_session: string) {
      did.deleted.push(_session);
      herdr = 'absent';
      return true;
    },
    kill(pid: number) {
      did.killed.push(pid);
      return true;
    },
    sleep,
    now,
  };

  const live = (): Live | null => {
    if (herdr === 'none') return null;
    if (herdr !== 'running') return { running: false, agents: [], workspaces: [], screens: {} };
    return { running: true, agents: agents(), workspaces: workspaces(), screens: texts() };
  };

  const doctorSources = (): DoctorSources => ({
    version(binary) {
      for (const [cli, tool] of Object.entries(TOOL_TESTED)) {
        if (tool.binary !== binary) continue;
        const state = toolState[cli] ?? 'fine';
        if (state === 'missing') return null;
        if (state === 'old') return tool.old;
        return tool.version;
      }
      return null;
    },
    onPath: () => true,
    loggedIn(profile) {
      const state = toolState[profile.cli] ?? 'fine';
      if (profile.loginCheck === null) return null;
      return state === 'logged-out' ? false : true;
    },
    // The two reads `doctor --jules` makes, answered as fixtures: the Jules CLI saying it is
    // logged in and listing this project's repository, and the project's own origin remote. No
    // page's example reaches a real `jules` or a real `git`.
    command(binary, args) {
      if (binary === 'jules' && args.join(' ') === 'remote list --repo') {
        return { status: 0, stdout: 'floor/agents\nfloor/beacon\nfloor/welcome\n', stderr: '' };
      }
      if (binary === 'git' && args[0] === '-C' && args.slice(2).join(' ') === 'remote get-url origin') {
        return { status: 0, stdout: 'git@github.com:floor/beacon.git\n', stderr: '' };
      }
      return null;
    },
    herdrVersion: () => (herdr === 'none' ? null : '0.7.1'),
    sessionRunning: () => (herdr === 'none' ? null : herdr === 'running'),
    now,
    home,
    machine,
  });

  // A machine where the MCP bring-up ran and every leg is up: one helper under the install root,
  // one bridge under the lobby, one front answering. Nothing here reads a real socket, a real
  // HTTP endpoint or a real process — every answer is a fixture — so a page's example output is
  // the same everywhere and needs no network.
  const mcpSources = (): McpSources => {
    const helperRoot = '/usr/local/teamcli-helper';
    const lobby = join(home, '.config', 'team', 'lobby');
    const frame = join(lobby, 'mcp-1');
    const config = join(frame, 'bridge.json');
    const signer = join(frame, 'signer.sock');
    const mailbox = join(frame, 'mailbox');
    const audit = join(frame, 'audit.jsonl');
    // A real Ed25519 SPKI key: the config parser reads it as the deployed loader does.
    const publicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAXPtFj070wFMReZCEIEoqh6h0qjuWZy4l0lwzQcPVQTM=\n-----END PUBLIC KEY-----\n';
    const configText = `${JSON.stringify({
      version: 1,
      wss_url: 'wss://mcp.example.test/connector',
      connector_token: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM',
      queue_hmac_key: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
      relay_public_keys: { 'relay-a': publicKey },
      seats: [
        { alias: 'beacon', route: 'seat-beacon-1', key_id: 'seat-beacon-1', public_key: publicKey },
      ],
      signer_socket: signer,
      mailbox_dir: mailbox,
      audit_file: audit,
    }, null, 2)}\n`;
    const stats: Record<string, PathStat> = {
      [helperRoot]: { kind: 'dir', mode: 0o755, size: 96 },
      [join(helperRoot, 'keys')]: { kind: 'dir', mode: 0o700, size: 64 },
      [join(helperRoot, 'queue')]: { kind: 'dir', mode: 0o700, size: 64 },
      [join(helperRoot, 'state')]: { kind: 'dir', mode: 0o700, size: 64 },
      [join(helperRoot, 'sock')]: { kind: 'dir', mode: 0o750, size: 64 },
      [join(helperRoot, 'bin', 'bun')]: { kind: 'file', mode: 0o755, size: 57_000_000 },
      [join(helperRoot, 'app', 'src', 'connector', 'bridge-main.ts')]: { kind: 'file', mode: 0o644, size: 12_345 },
      [join(helperRoot, 'helper-config.json')]: { kind: 'file', mode: 0o600, size: 512 },
      [lobby]: { kind: 'dir', mode: 0o755, size: 64 },
      [frame]: { kind: 'dir', mode: 0o700, size: 96 },
      // The config embeds the run's temp home, whose path length is platform-specific (macOS
      // /private/var/folders/… vs Linux /tmp/…: 1031 vs 875 bytes on CI), so report the size
      // as if the home were a fixed path — the page's example output must hold byte for byte.
      [config]: { kind: 'file', mode: 0o600, size: configText.split(home).join('/home/user').length },
      [signer]: { kind: 'socket', mode: 0o660, size: 0 },
      [mailbox]: { kind: 'dir', mode: 0o700, size: 64 },
      [audit]: { kind: 'file', mode: 0o600, size: 46 },
    };
    return {
      home: () => home,
      helperRoot: () => helperRoot,
      now,
      listDir: (path) => (path === lobby ? ['mcp-1'] : null),
      stat: (path) => stats[path] ?? null,
      readText: (path) => (path === config ? configText : null),
      readTail: (path) => (path === audit ? '{"ts":"2026-10-04T08:55:00Z","event":"ws-open"}\n' : null),
      countSuffix: (dir) => (dir === join(mailbox, 'outbound') ? 2 : dir === join(mailbox, 'inbound') ? 0 : null),
      probeSocket: async () => 'ok',
      probeHttp: async () => 401,
      certExpiry: async () => ({ validTo: '2027-01-02T09:00:00Z', authorized: true }),
      processRunning: () => true,
    };
  };

  const downSources = (): DownSources => ({
    sessionRunning: () => (herdr === 'none' ? null : herdr === 'running'),
    agents: () => (herdr === 'running' ? agents() : []),
    alive: (pid) => watchPid !== null && pid === watchPid,
    screen: (_session, pane) => readScreen(agentOf(pane)?.cli ?? '', action.paneText('', pane)),
    screenText: (_session, pane) => action.paneText('', pane),
    status: (_session, pane) => agentOf(pane)?.status ?? null,
    // The CLI is the foreground until its exit is typed; the pane is then back at its shell.
    foreground: (_session, pane) => {
      if (shelled.has(pane)) return ['zsh'];
      const cli = agentOf(pane)?.cli ?? 'claude-code';
      return [profileFor(cli)?.processNames[0] ?? 'claude'];
    },
    now,
    sleep,
    launch: downLaunch,
    home,
  });

  return {
    live,
    did,
    paneOf: (name) => slots.find((slot) => slot.name === name)?.pane,
    setScreen(seat, kind) {
      const slot = slots.find((candidate) => candidate.name === seat);
      if (!slot) throw new Error(`the fixture has no running seat "${seat}"`);
      slot.screen = kind;
      slot.status = statusOf(kind);
    },
    setMachine(kind) {
      machineKind = kind;
    },
    setTools(tools) {
      toolState = { ...spec.tools, ...tools };
    },
    setHerdr(kind) {
      herdr = kind;
    },
    settle() {
      if (!startedWatch) return;
      const pane = startedWatch;
      startedWatch = null;
      updateState(dir, (state) => {
        const record = (state.sessions[session] ??= emptySession());
        const workspace = record.watch?.workspace;
        record.watch = { pid: WATCH_PID, heartbeat: now().toISOString(), pane, ...(workspace ? { workspace } : {}) };
      });
    },
    upSources(): UpSources {
      return {
        sessionRunning: () => (herdr === 'none' ? null : herdr === 'running'),
        sessionState: action.sessionState,
        agents: () => (herdr === 'running' ? agents() : []),
        workspaces: () => (herdr === 'running' ? workspaces() : []),
        home,
        doctor: doctorSources(),
        machine,
        now,
        sleep,
        alive: (pid) => watchPid !== null && pid === watchPid,
        watchCommand: (session) => (session === 'default' ? 'team watch' : `team watch --session ${session}`),
        launch,
      };
    },
    downSources,
    removeSources(): RemoveSources {
      const down = downSources();
      return {
        ...down,
        home,
        foreground: (session, pane) => down.foreground?.(session, pane) ?? ['zsh'],
        // A non-owner's removal on an unrecognised screen renames the pane's agent out of the
        // seat's name; the fake session takes the rename like herdr's.
        renameAgent: action.renameAgent,
      };
    },
    restartSources(): RestartSources {
      const down = downSources();
      return {
        ...down,
        home,
        sessionState: () => (herdr === 'none' ? null : sessionState()),
        workspaces: () => (herdr === 'running' ? workspaces() : []),
        foreground: (session, pane) => down.foreground?.(session, pane) ?? ['zsh'],
        upLaunch: launch,
        doctor: doctorSources(),
        machine,
      };
    },
    addSources(): AddSources {
      return {
        home,
        sessionState: () => (herdr === 'none' ? null : sessionState()),
        agents: () => (herdr === 'running' ? agents() : []),
        workspaces: () => (herdr === 'running' ? workspaces() : []),
        doctor: doctorSources(),
        machine,
        now,
        launch,
      };
    },
    registerSources(): RegisterSources {
      return {
        home,
        sessionState: () => (herdr === 'none' ? null : sessionState()),
        agents: () => (herdr === 'running' ? agents() : []),
        // Every agent herdr lists holds a CLI in front of the pane's own shell: one shell pid
        // and one process beside it, per pane, so identity reads as a launched pane; the
        // foreground argv0 is the one the seat's `claude-code` profile names.
        processInfo: (_session, pane) => {
          const index = slots.findIndex((slot) => slot.pane === pane);
          return { shell: 5000 + index, foreground: [5001 + index] };
        },
        foreground: () => ['claude'],
        paneText: (_session, pane) => action.paneText('', pane),
        // The address a register records: the fixture runs no sockets, so the stub answers null.
        refreshAddress: () => ({ address: null }),
        // The two sidebar writes an adoption re-applies: noops that report "done", so an example
        // spawns no herdr.
        renameWorkspace: () => true,
        reportDisplayAgent: () => true,
        now,
      };
    },
    statusSources(): StatusSources {
      return {
        live: () => live(),
        branch: () => 'main',
        standing: standingSource(home),
        now,
        home,
        machine,
        projects: projectsAt(home),
        // The fixture's process table, not the machine's: the proc notes a page shows are the
        // records the same page's `team proc` examples made, never the host's own pids.
        alive: alivePid,
      };
    },
    listSources(): ListSources {
      return {
        sessions() {
          if (herdr === 'none') return null;
          if (herdr === 'absent') return [];
          return [{ name: session, running: herdr === 'running' }];
        },
        roster() {
          if (herdr !== 'running') return null;
          return agents().map((agent) => ({
            name: agent.name,
            status: agent.status && agent.status !== 'unknown' ? agent.status : null,
          }));
        },
        team(asked) {
          if (!team || asked !== team.session) return null;
          return { project: team.project, root, seats: team.seats.length, unreadable: false };
        },
      };
    },
    checkSources(): CheckSources {
      return {
        // The whole world the check reads, behind `src/check/team.ts`'s narrowing: this fake's
        // panes are the fixture's own, so the live read is already only its seats'.
        live: () => live(),
        branch: () => 'main',
        standing: standingSource(home),
        now,
        home,
        // A recorded watch's liveness is the fixture's process table too: a page whose state
        // records a watch says whether its process runs, and the machine never answers.
        alive: alivePid,
        // The caller gate's own reads, so a page's unapproved caller meets the world and not a
        // real herdr or a real store.
        gate: {
          standing: standingSource(home),
          state: (dir) => readState(dir),
          agents: () => (herdr === 'running' ? agents() : []),
          sessionRunning: () => (herdr === 'none' ? null : herdr === 'running'),
        },
      };
    },
    watchSources(): WatchSources {
      return {
        live: () => live(),
        machine,
        standing: standingSource(home),
        // A page's world runs no real check commands: every account reads what the pass saw.
        readChecks: () => [],
        screen: (pane) => action.paneText('', pane),
        status: (_pane) => agentOf(_pane)?.status ?? null,
        foreground: (pane) => {
          const cli = agentOf(pane)?.cli ?? 'claude-code';
          return [profileFor(cli)?.processNames[0] ?? 'claude'];
        },
        // The watch orders these (pane, text, session); the fake's own action takes (session, pane, text).
        typeText: (pane, text, session) => action.typeText(session, pane, text),
        pressEnter: action.pressEnter,
        sleep: async () => {},
        notify: (text) => did.notified.push(text),
        now,
        // One pass, then the loop ends: a page shows a pass, not a watch that runs forever.
        wait: async () => false,
        alive: (pid) => watchPid !== null && pid === watchPid,
        pid: RUN_WATCH_PID,
        home,
      };
    },
    doctorSources,
    mcpSources,
    releaseFetch(): Fetch {
      return (url) => Promise.resolve(releaseAnswers(url));
    },
    releaseKeyReader(): KeyReader {
      return () => Promise.resolve({ ok: true, key: RECORDS_KEY });
    },
  };
}
