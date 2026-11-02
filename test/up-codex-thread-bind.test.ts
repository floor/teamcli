// Coverage: `team up` binds a ready Codex seat whose records name no conversation to the one
// thread its own managed endpoint holds — the same bind a restart makes, made at launch.
//
// Each scene drives the real `team up` against a ready seat the run leaves in place (its pane is
// working, so nothing is closed or typed) with a managed endpoint recorded under the seat's own
// incarnation. The endpoint read is a fixture: exactly one thread binds both records, several
// threads prove nothing, an unreadable endpoint says why, and a world that hands `up` no read at
// all binds nothing. The run's summary names every seat left pull-only with the binder's reason.
// No live herdr, no provider, no pane.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { codexEndpointSocket } from '../src/launch/codex-endpoint.ts';
import type { CodexLoadedThreadsRead } from '../src/daemon/presence/codex-source.ts';
import { findAgent, registerAgent } from '../src/registry/agents.ts';
import { recordedSeatSession } from '../src/registry/resume.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-10-22T09:30:00Z');
const SESSION = 'acme';
const SEAT = 'worker';
const HANDLE = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
const THREAD = '019a0000-aaaa-7bbb-8ccc-ddddeeeeffff';
const OTHER_THREAD = '019a0000-1111-7222-8333-444455556666';
// The captured idle screen, with the banner naming the model this scene's file declares.
const IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-6.1-sol')
  .replace('GPT-5.6-Terra', 'GPT-6.1-Sol');
// The record a launch wrote before a host restore: the pane, the workspace and the pids then.
const RECORD = { stage: 'ready' as const, id: HANDLE, pane: 'pane-2', workspace: 'pane-ws', launched: { shell: 100, cli: [200] } };
// The pids the pane holds now: the host restored the process, so they are not the launched ones.
const RESTORED = { shell: 101, foreground: [201] };
const SKIPPED = 'restored; left as it is';

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

/** One Codex seat, alone in its team: the only seat every run can touch. */
function teamText(): string {
  return `format: 1
project: acme
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT}
    label: ${SEAT}
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6.1"
    launch: codex -m gpt-6.1-sol
`;
}

function setup(): void {
  const text = teamText();
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

/** The URL the seat's own managed launch owns for `BINDING`. */
function ownedUrl(): string {
  const socket = codexEndpointSocket(dir, SESSION, SEAT, BINDING);
  if (socket === null) throw new Error('the fixture state folder is too long for an owned endpoint path');
  return socket.url;
}

/** The state and the registry record a managed launch left: the seat's own incarnation and
 *  endpoint, and a conversation only the registry names (the state copy is sessionless). */
function record(opts: { registrySession?: string | null } = {}): void {
  updateState(dir, (state) => {
    const session = (state.sessions[SESSION] ??= emptySession());
    session.seats[SEAT] = {
      ...RECORD,
      presence_binding: BINDING,
      codex_endpoint: { url: ownedUrl(), binding: BINDING, pid: 4242, started_at: NOW.toISOString() },
    };
  });
  const registrySession = opts.registrySession === undefined ? THREAD : opts.registrySession;
  registerAgent(home, {
    name: SEAT,
    signing: { model: 'GPT Sol', version: '6.1', role: 'coordinator' },
    lab: 'openai',
    cli: 'codex',
    launcher: null,
    launch: 'codex -m gpt-6.1-sol',
    reach: {
      team: teamIdOf(root),
      seat: SEAT,
      session: SESSION,
      pane: 'pane-2',
      address: null,
      ...(registrySession === null ? {} : { agent_session: registrySession }),
    },
    seat_handle: HANDLE,
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
}

type Trace = { created: string[]; closed: string[]; typed: string[]; runs: string[] };

/** The readings one run takes: herdr names the seat on its recorded pane with `live` as the
 *  conversation it runs, the pane is mid-turn (so the run leaves it), and the process is the
 *  restored one. `threads` is the endpoint read; absent, no read is handed to `up` at all. */
function sources(
  live: string,
  opts: { threads?: (endpoint: string) => Promise<CodexLoadedThreadsRead> } = {},
): { sources: UpSources; trace: Trace; asked: string[] } {
  const trace: Trace = { created: [], closed: [], typed: [], runs: [] };
  const asked: string[] = [];
  const madePanes = new Map<string, string>();
  const agents = () => [
    {
      name: SEAT, agent: 'codex', pane: 'pane-2', workspace: 'pane-ws',
      status: 'working', cwd: root, session: live,
    },
  ];
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      const pane = `made-${trace.created.length + 1}`;
      trace.created.push(label);
      madePanes.set(pane, IDLE);
      return { pane, workspace: `ws-${trace.created.length}` };
    },
    paneRun(_session, pane, command) {
      trace.runs.push(command);
      madePanes.set(pane, IDLE);
      return true;
    },
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => ['pane-2', ...madePanes.keys()],
    agents,
    paneText: (_session, pane) => madePanes.get(pane) ?? IDLE,
    foreground: () => ['codex'],
    processInfo: () => RESTORED,
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
    home,
  };
  return {
    sources: {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents,
      workspaces: () => [{ id: 'pane-ws', label: SEAT }],
      home,
      doctor,
      launch,
      now: () => NOW,
      ...(opts.threads === undefined
        ? {}
        : {
            codexThreads: (endpoint: string) => {
              asked.push(endpoint);
              return opts.threads!(endpoint);
            },
          }),
    },
    trace,
    asked,
  };
}

const seatState = () => readState(dir).sessions[SESSION]?.seats[SEAT];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(shortSocketBase(), 'ub-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

test('the registry names the thread and the endpoint proves exactly one: up heals the state copy', async () => {
  record();
  // Before the run the two records disagree: the registry names the thread, the state copy names
  // none, so a send has no conversation to address the runtime queue by.
  expect(seatState()?.agent_session).toBeUndefined();
  expect(recordedSeatSession({
    home, root, herdrSession: SESSION, seat: { name: SEAT, cli: 'codex' }, state: seatState(),
  }).kind).toBe('none');

  const made = sources('ses_other', { threads: async () => ({ kind: 'read', ids: [THREAD] }) });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  // The read is addressed by the seat's own recorded endpoint, never a home-derived path, and the
  // state copy now names the thread both records agree on.
  expect(made.asked).toEqual([ownedUrl()]);
  expect(io.err).not.toContain('pull-only');
  expect(seatState()?.agent_session).toBe(THREAD);
  expect(findAgent(home, { team: teamIdOf(root), seat: SEAT })?.reach.agent_session).toBe(THREAD);
  expect(recordedSeatSession({
    home, root, herdrSession: SESSION, seat: { name: SEAT, cli: 'codex' }, state: seatState(),
  }).kind).toBe('bound');
  expect(readFileSync(join(dir, 'team.log'), 'utf8'))
    .toContain(`${SEAT}: its Codex endpoint holds thread ${THREAD}; bound as the seat's session`);
});

test('an endpoint holding several threads binds none, and the summary says why', async () => {
  record();
  const made = sources('ses_other', { threads: async () => ({ kind: 'read', ids: [THREAD, OTHER_THREAD] }) });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  expect(seatState()?.agent_session).toBeUndefined();
  expect(findAgent(home, { team: teamIdOf(root), seat: SEAT })?.reach.agent_session).toBe(THREAD);
  expect(io.err).toContain(`pull-only: ${SEAT} (its Codex endpoint holds 2 threads; none is proven to be this seat's)`);
  expect(readFileSync(join(dir, 'team.log'), 'utf8'))
    .toContain(`${SEAT}: no thread was bound from its Codex endpoint (its Codex endpoint holds 2 threads; none is proven to be this seat's)`);
});

test('an endpoint that does not answer binds none, and the summary says which read failed', async () => {
  record();
  const made = sources('ses_other', {
    threads: async () => ({ kind: 'unavailable', why: 'the Codex endpoint socket is not listening (ENOENT)' }),
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  expect(seatState()?.agent_session).toBeUndefined();
  expect(io.err).toContain(`pull-only: ${SEAT} (the Codex endpoint socket is not listening (ENOENT))`);
});

test('a world that hands up no endpoint read binds nothing and claims no pull-only reason', async () => {
  record();
  const made = sources('ses_other');
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources)).toBe(0);

  expect(made.asked).toEqual([]);
  expect(seatState()?.agent_session).toBeUndefined();
  expect(io.err).not.toContain('pull-only');
  expect(readFileSync(join(dir, 'team.log'), 'utf8')).not.toContain('bound as the seat\'s session');
});
