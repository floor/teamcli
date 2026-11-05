// C7.5 item 3: one Bus pane per team.
//
// The orders this file pins:
//
// - when the Bus is not answering but a workspace labelled for it already exists, `team up`
//   reuses that workspace's pane and creates no second workspace;
// - a Bus workspace whose pane holds anything beside its own shell is not typed into, and the
//   run makes no second workspace in its place;
// - a stray extra Bus workspace is closed only after the live Bus is up, and a stray that holds
//   a process is left as it is with the run saying why;
// - a Bus already answering has its strays closed with no wait and no Bus step.
//
// Every pane, workspace, process reading and screen here is a synthetic fixture: no live
// terminal host, registry, provider or pane is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { upPlan } from '../src/launch/plan.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { busLabel } from '../src/watch/pane.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-05T09:30:00Z');
const SESSION = 'acme';
const LEAD = 'lead';
const PROJECT = 'acme';
const LABEL = busLabel(PROJECT);
// Two workspaces the host lists under the Bus's label, and the pane in each. Neutral ids: the
// fixtures name no real terminal host's pane.
const BUS_ONE = 'fixture-bus-space-one';
const BUS_PANE_ONE = 'fixture-bus-pane-one';
const BUS_TWO = 'fixture-bus-space-two';
const BUS_PANE_TWO = 'fixture-bus-pane-two';
const WATCH_PANE = 'fixture-watch-pane';

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

/** A human lead only: these scenes are about the Bus, not about launching a seat. */
function teamText(): string {
  return `format: 1
project: ${PROJECT}
coordinator: ${LEAD}
operator: ${LEAD}
session: ${SESSION}
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${LEAD}
    label: ${LEAD}
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
    human: true
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

/** A live pane watch already carries this route: no watch step, no watch workspace. */
function seedWatch(): void {
  updateState(dir, (file) => {
    const session = (file.sessions[SESSION] ??= emptySession());
    session.watch = { heartbeat: NOW.toISOString(), pane: WATCH_PANE };
  });
}

const busState = () => readState(dir).sessions[SESSION]?.bus;

type PaneSeed = {
  workspace: string;
  process: { shell: number; foreground: number[] } | null;
};

type RunTrace = { created: string[]; closed: string[]; runs: { pane: string; command: string }[]; events: string[] };

function makeWorld(panes: Record<string, PaneSeed>): { sources: UpSources; trace: RunTrace } {
  const trace: RunTrace = { created: [], closed: [], runs: [], events: [] };
  const held = new Map<string, PaneSeed>(Object.entries(panes));
  const labels = new Map<string, string>();
  for (const pane of held.values()) labels.set(pane.workspace, LABEL);
  let made = 0;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace(_session, _cwd, label) {
      made += 1;
      trace.created.push(label);
      trace.events.push('create:fixture-bus-space-new');
      return { pane: 'fixture-bus-pane-new', workspace: 'fixture-bus-space-new' };
    },
    paneRun(_session, pane, command) {
      trace.runs.push({ pane, command });
      trace.events.push(`run:${pane}`);
      const seeded = held.get(pane);
      if (seeded === undefined) return false;
      seeded.process = { shell: 600 + made, foreground: [1100 + trace.runs.length] };
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      trace.events.push(`close:${workspace}`);
      labels.delete(workspace);
      for (const [id, seeded] of held) if (seeded.workspace === workspace) held.delete(id);
      return true;
    },
    agentPanes: () => [...held.keys()],
    agents: () => [],
    workspacePanes: (_session, workspace) =>
      [...held.entries()].filter(([, seeded]) => seeded.workspace === workspace).map(([id]) => id),
    paneText: () => null,
    typeText: () => true,
    pressEnter: () => true,
    agentStatus: () => 'idle',
    foreground: () => null,
    shellBack: () => null,
    processInfo: (_session, pane) => held.get(pane)?.process ?? null,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.289',
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
      agents: () => [],
      workspaces: () => [...labels.entries()].map(([id, label]) => ({ id, label })),
      busAlive: async () => false,
      home,
      doctor,
      launch,
      now: () => NOW,
      sleep: async () => {},
    },
    trace,
  };
}

const bare = (shell: number): PaneSeed['process'] => ({ shell, foreground: [shell] });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'up-bus-single-')));
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

const PLAN_BASE = {
  root: '/r',
  session: 'scratch',
  sessionRunning: true,
  watchAlive: true,
  watchLabel: 'Watch · scratch',
  seats: [],
};

test('a Bus workspace already labelled for the team is reused, not duplicated', async () => {
  seedWatch();
  const made = makeWorld({
    [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) },
    [BUS_PANE_TWO]: { workspace: BUS_TWO, process: bare(70) },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  // The first workspace's pane runs the Bus; no workspace was created.
  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toHaveLength(1);
  expect(made.trace.runs[0]?.pane).toBe(BUS_PANE_ONE);
  expect(made.trace.runs[0]?.command).toContain('bus');
  // The second, now stray, workspace closed only after the Bus ran.
  expect(made.trace.closed).toEqual([BUS_TWO]);
  expect(made.trace.events.indexOf(`run:${BUS_PANE_ONE}`)).toBeLessThan(made.trace.events.indexOf(`close:${BUS_TWO}`));
  expect(`${io.out}${io.err}`).toContain('bus: started');

  // The Bus is recorded where it now runs.
  expect(busState()?.pane).toBe(BUS_PANE_ONE);
  expect(busState()?.workspace).toBe(BUS_ONE);
});

test('a Bus pane holding a process beside its shell is not typed into, and no second workspace is made', async () => {
  seedWatch();
  const made = makeWorld({
    [BUS_PANE_ONE]: { workspace: BUS_ONE, process: { shell: 60, foreground: [60, 61] } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.created).toEqual([]);
  expect(made.trace.runs).toEqual([]);
  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`bus: its workspace ${BUS_ONE} holds a process beside its shell; not started there`);
  expect(busState()).toBeUndefined();
});

test('a stray Bus workspace holding a process is left as it is', async () => {
  seedWatch();
  const made = makeWorld({
    [BUS_PANE_ONE]: { workspace: BUS_ONE, process: bare(60) },
    [BUS_PANE_TWO]: { workspace: BUS_TWO, process: { shell: 70, foreground: [70, 71] } },
  });
  const io = testIo(root, { kind: 'owner' });
  expect(await runUp([], io, made.sources), `up said:\n${io.out}\n${io.err}`).toBe(0);

  expect(made.trace.runs).toHaveLength(1);
  expect(made.trace.runs[0]?.pane).toBe(BUS_PANE_ONE);
  expect(made.trace.runs[0]?.command).toContain('bus');
  expect(made.trace.closed).toEqual([]);
  expect(`${io.out}${io.err}`).toContain(`bus: its workspace ${BUS_TWO} holds a process beside its shell; left as it is`);
});

test('a Bus already answering has its strays closed with no Bus step', () => {
  const plan = upPlan({
    ...PLAN_BASE,
    startBus: true,
    busAlive: true,
    busLabel: LABEL,
    busStrays: [{ workspace: BUS_TWO }],
  });
  expect(plan.some((step) => step.do?.do === 'bus' || step.do?.do === 'create')).toBe(false);
  expect(plan.find((step) => step.do?.do === 'sweep')?.do).toEqual({ do: 'sweep', workspace: BUS_TWO });
});

test('a reused Bus is one bus step and no create, with the stray sweep after it', () => {
  const plan = upPlan({
    ...PLAN_BASE,
    startBus: true,
    busAlive: false,
    busLabel: LABEL,
    busReuse: { workspace: BUS_ONE, pane: BUS_PANE_ONE },
    busStrays: [{ workspace: BUS_TWO, pane: BUS_PANE_TWO }],
  });
  expect(plan.some((step) => step.do?.do === 'create')).toBe(false);
  const bus = plan.find((step) => step.do?.do === 'bus');
  expect(bus?.do).toEqual({ do: 'bus', label: LABEL, command: 'team bus', pane: BUS_PANE_ONE, workspace: BUS_ONE });
  const sweep = plan.findIndex((step) => step.do?.do === 'sweep');
  expect(plan[sweep]?.do).toEqual({ do: 'sweep', workspace: BUS_TWO, pane: BUS_PANE_TWO, after: 'bus' });
  expect(plan.indexOf(bus!)).toBeLessThan(sweep);
});

test('with no readable pane in the Bus workspace, no second one is made', () => {
  const plan = upPlan({
    ...PLAN_BASE,
    startBus: true,
    busAlive: false,
    busLabel: LABEL,
    busHold: `its workspace ${BUS_ONE} could not be read; not started there and no second one made`,
  });
  expect(plan.some((step) => step.do?.do === 'create' || step.do?.do === 'bus')).toBe(false);
  expect(plan.some((step) => step.kind === 'skip' && step.text.includes('no second one made'))).toBe(true);
});
