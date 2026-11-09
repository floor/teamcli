// Independent scenes for `team swap <seat> <preset>`.
// A placed lead or operator swaps a seat of their own team with no owner card. The preset's
// seat recipe (vendor, model, version, display) and harness become the seat's fields together,
// and the launch line carries the preset's model. Grok gets a worktree under the trusted
// workspace folder, recorded for that seat, and one restart. A later CLI keeps that recorded
// worktree, including when removal waits until merge. A dry run and a preset the model rule
// refuses write nothing. The orchestrator seat stays the owner's. Homes, presets and pane
// names are synthetic. The host below is a stub: it never starts a CLI or reads a credential store.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runSwap, type SwapCommandOptions } from '../src/commands/swap.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { hasVersionToken } from '../src/file/signature.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { launchedCliBinary } from '../src/launch/line.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { beginSession } from '../src/sessions/registry.ts';
import { emptySession, readState, updateState, worktreeOf } from '../src/state.ts';
import type { Screen } from '../src/watch/screen.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';

const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8');
const CODEX_EXIT = readFileSync(new URL('./fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');
const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.52/idle.txt', import.meta.url), 'utf8');
const GROK_EXIT = readFileSync(new URL('./fixtures/grok/1.0.52/exit-typed.txt', import.meta.url), 'utf8');

const NOW = new Date('2026-11-08T10:00:00Z');
const CODEX_SESSION = 'ses_0123456789ab';
const GROK_SESSION = 'ses_0123456789ac';
const KIMI_SESSION = 'ses_0123456789ad';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Independent',
      GIT_AUTHOR_EMAIL: 'independent@example.invalid',
      GIT_COMMITTER_NAME: 'Independent',
      GIT_COMMITTER_EMAIL: 'independent@example.invalid',
    },
  });
}

type Scene = { home: string; root: string; trees: string };

function open(): Scene {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'swap-preset-')));
  made.push(home);
  const root = join(home, 'repo');
  const trees = join(home, 'worktrees');
  const lobby = join(home, '.config', 'team', 'lobbies', 'lab');
  mkdirSync(join(root, '.agents', 'launchers'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobby, { recursive: true, mode: 0o700 });
  chmodSync(lobby, 0o700);
  mkdirSync(trees);
  writeFileSync(join(home, '.config', 'team', 'settings.yaml'), 'team-config.source: file\n');
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  return { home, root, trees };
}

const LEAD = `  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: Claude Opus 5.5
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: ops
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    display: Claude Opus 5.5
    launch: claude --model claude-opus-5-5
    mode: shared
`;

function writeTeam(scene: Scene, seats: string, remove: 'manual' | 'on-merge' = 'manual'): void {
  writeFileSync(join(scene.root, '.agents', 'team.yaml'), `format: 1
project: acme
entity: lab
session: acme
coordinator: lead
operator: ops
trust:
  - ${scene.root}
  - ${scene.trees}
  - ${join(scene.home, '.config', 'team', 'lobbies', 'lab')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  base: main
  branch: "{task}"
  remove: ${remove}
seats:
${LEAD}${seats}`);
}

function writePreset(scene: Scene, name: string, harness: string, modelArg: string, seat: { vendor: string; model: string; version: string; display: string }): void {
  writeFileSync(join(scene.root, '.agents', 'launchers', `${name}.yaml`), `format: 1
name: ${name}
kind: preset
harness: ${harness}
args:
  - --model
  - ${modelArg}
resume:
  mode: none
writable_folders:
  - path: '{root}'
seat:
  vendor: ${seat.vendor}
  model: ${seat.model}
  version: "${seat.version}"
  display: ${seat.display}
`);
}

function standardPresets(scene: Scene): void {
  writePreset(scene, 'grok-high', 'grok', 'grok-4.7', { vendor: 'xai', model: 'Grok', version: '4.7', display: 'Grok 4.7' });
  writePreset(scene, 'claude-opus', 'claude-code', 'claude-opus-5-5', { vendor: 'anthropic', model: 'Claude Opus', version: '5.5', display: 'Claude Opus 5.5' });
  writePreset(scene, 'claude-glm', 'claude-code', 'glm-4.6', { vendor: 'zhipu', model: 'GLM', version: '4.6', display: 'GLM 4.6' });
}

function lead(): Caller {
  return { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
}

function operator(): Caller {
  return { kind: 'seat', name: 'ops', pane: 'pane-ops', session: 'acme' };
}

type Held = { name: string; pane: string; cli: string; cwd: string; text: string; exitText?: string };

type Host = { sources: RestartSources; runs: string[]; started: () => number };

function stubHost(scene: Scene, held: Held[]): Host {
  const runs: string[] = [];
  let started = 0;
  let clock = NOW.getTime();
  const now = (): Date => new Date(clock);
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
  };
  const shelled = new Set<string>();
  const text = new Map(held.map((seat) => [seat.pane, seat.text]));
  const live = held.map((seat) => ({ ...seat, workspace: `ws-${seat.name}` }));
  const fresh = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string; cwd: string }>();
  const binaries = new Map<string, string>();
  const binaryOf = (cli: string): string => (cli === 'claude-code' ? 'claude' : cli);
  const agents = (): HerdrAgent[] => [
    ...live.map((seat) => ({
      name: seat.name,
      agent: seat.cli,
      pane: seat.pane,
      workspace: seat.workspace,
      status: 'idle',
      cwd: seat.cwd,
    })),
    ...[...fresh.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name,
      agent: binaries.get(pane) ?? 'claude',
      pane,
      workspace: slot.workspace,
      status: 'idle',
      cwd: slot.cwd,
    })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    for (let index = live.length - 1; index >= 0; index -= 1) {
      if (live[index]!.workspace === workspace) live.splice(index, 1);
    }
    for (const [pane, slot] of [...fresh.entries()]) {
      if (slot.workspace === workspace) fresh.delete(pane);
    }
    return true;
  };
  const downLaunch: DownLaunch = {
    typeText(_session, pane, typed) {
      const seat = live.find((one) => one.pane === pane);
      if (seat !== undefined && typed.includes('/exit') && seat.exitText !== undefined) text.set(pane, seat.exitText);
      else if (seat !== undefined) text.set(pane, claudeBox(typed));
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      shelled.add(pane);
      return true;
    },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep,
    now,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    registerInbox: () => ({ ok: true }),
    createWorkspace(_session, cwd) {
      started += 1;
      const pane = `pane-new-${started}`;
      const workspace = `ws-new-${started}`;
      fresh.set(pane, { text: CLAUDE_IDLE, agent: false, name: null, workspace, cwd });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push(command);
      const binary = binaryOf(launchedCliBinary(command) ?? 'claude');
      binaries.set(pane, binary);
      const slot = fresh.get(pane);
      if (slot) {
        slot.agent = true;
        // A foreign model on claude-code is unread unless the screen names it. A Claude
        // banner would be read as Opus and refuse the GLM preset, so that launch gets no banner.
        slot.text = command.includes('glm-4.6')
          ? 'idle\n'
          : binary === 'grok' ? GROK_IDLE : binary === 'codex' ? CODEX_IDLE : CLAUDE_IDLE;
      }
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = fresh.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => {
      const found = [
        ...live.filter((seat) => seat.workspace === workspace).map((seat) => seat.pane),
        ...[...fresh.entries()].filter(([, slot]) => slot.workspace === workspace).map(([pane]) => pane),
      ];
      return found.length > 0 ? found : [`${workspace}-pane`];
    },
    paneText: (_session, pane) => fresh.get(pane)?.text ?? text.get(pane) ?? CLAUDE_IDLE,
    agentStatus: () => 'idle',
    foreground: (_session, pane) => {
      if (shelled.has(pane)) return ['zsh'];
      return [binaries.get(pane) ?? binaryOf(live.find((seat) => seat.pane === pane)?.cli ?? 'claude')];
    },
    shellBack: (_session, pane) => shelled.has(pane),
    typeText(_session, pane, typed) {
      const slot = fresh.get(pane);
      if (slot) slot.text = claudeBox(typed);
      return true;
    },
    pressEnter: () => true,
    sleep,
    now,
  };
  const doctor: DoctorSources = {
    version: (binary) => {
      const base = binary.split('/').pop() ?? binary;
      if (base === 'grok') return '1.0.52';
      if (base === 'codex') return '0.161.0';
      return '2.1.288';
    },
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now,
    home: scene.home,
  };
  const screenOf = (): Screen => ({ kind: 'idle' });
  const sources: RestartSources = {
    home: scene.home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agents(),
    workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: () => screenOf(),
    screenText: (_session, pane) => text.get(pane) ?? fresh.get(pane)?.text ?? CLAUDE_IDLE,
    status: () => 'idle',
    foreground: (_session, pane) => (
      shelled.has(pane) ? ['zsh'] : [binaries.get(pane) ?? binaryOf(live.find((seat) => seat.pane === pane)?.cli ?? 'claude')]
    ),
    now,
    sleep,
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, runs, started: () => started };
}

function place(scene: Scene, subject: { name: string; pane: string; session: string; worktree?: { slot: string; path: string } }): void {
  updateState(join(scene.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops' };
    session.seats[subject.name] = { stage: 'ready', pane: subject.pane, agent_session: subject.session };
    if (subject.worktree !== undefined) {
      session.worktrees[subject.worktree.slot] = {
        path: subject.worktree.path,
        branch: subject.worktree.slot,
        seat: subject.name,
        setup: 'ok',
      };
    }
  });
  const parsed = validateTeamFile(readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8'), { root: scene.root, home: scene.home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  const seat = parsed.team.seats.find((one) => one.name === subject.name);
  if (seat === undefined) throw new Error(`no ${subject.name}`);
  const recorded = beginSession({
    home: scene.home,
    root: scene.root,
    team: parsed.team,
    session: parsed.team.session,
    seat,
    pane: subject.pane,
    cli_session: subject.session,
    now: NOW,
  });
  if ('note' in recorded) throw new Error(recorded.note);
}

async function swap(scene: Scene, argv: string[], caller: Caller, sources: RestartSources): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(scene.root, caller);
  const options: SwapCommandOptions = { home: scene.home, now: () => NOW, sources, credentialProbe: () => 'present' };
  const code = await runSwap(argv, io, options);
  return { code, out: io.out, err: io.err };
}

function readSeat(scene: Scene, name: string) {
  const text = readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8');
  const parsed = validateTeamFile(text, { root: scene.root, home: scene.home });
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => error.message).join('; '));
  const seat = parsed.team.seats.find((one) => one.name === name);
  if (seat === undefined) throw new Error(`no ${name}`);
  return seat;
}

function recordedPath(scene: Scene, name: string): string | undefined {
  const state = readState(join(scene.root, '.agents'));
  return worktreeOf(state.sessions.acme, name)?.path;
}

const STAFF: Held[] = [
  { name: 'lead', pane: 'pane-lead', cli: 'claude-code', cwd: '.', text: CLAUDE_IDLE },
  { name: 'ops', pane: 'pane-ops', cli: 'claude-code', cwd: '.', text: CLAUDE_IDLE },
];

test('a placed lead swaps codex to grok: worktree recorded, fields written, one restart', async () => {
  const scene = open();
  standardPresets(scene);
  writeTeam(scene, `  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    display: GPT Sol 5.0
    launch: codex --model gpt-sol
    mode: shared
`);
  place(scene, { name: 'worker', pane: 'pane-worker', session: CODEX_SESSION });
  const host = stubHost(scene, [...STAFF, { name: 'worker', pane: 'pane-worker', cli: 'codex', cwd: scene.root, text: CODEX_IDLE, exitText: CODEX_EXIT }]);
  const result = await swap(scene, ['worker', 'grok-high'], lead(), host.sources);
  expect(result.code).toBe(0);
  const seat = readSeat(scene, 'worker');
  expect(seat.cli).toBe('grok');
  expect(seat.vendor).toBe('xai');
  expect(seat.model).toBe('Grok');
  expect(seat.version).toBe('4.7');
  expect(seat.display).toBe('Grok 4.7');
  expect(hasVersionToken(seat.display, seat.version)).toBe(true);
  expect(seat.launch).toContain('grok-4.7');
  expect(seat.mode).toBe('worktree');
  expect(seat.cwd).not.toBe('.');
  const recorded = recordedPath(scene, 'worker');
  expect(recorded).toBeDefined();
  const landed = resolve(scene.root, recorded!);
  expect(landed).toBe(resolve(scene.root, seat.cwd));
  expect(landed.startsWith(scene.trees + sep)).toBe(true);
  expect(landed === scene.root || landed.startsWith(scene.root + sep)).toBe(false);
  expect(host.started()).toBe(1);
  expect(host.runs.some((command) => command.includes(CODEX_SESSION))).toBe(false);
});

test('grok to claude keeps the recorded worktree when removal is manual and when it waits for merge', async () => {
  for (const remove of ['manual', 'on-merge'] as const) {
    const scene = open();
    standardPresets(scene);
    const slot = 'maker-slot';
    const absolute = join(scene.trees, 'acme', slot);
    mkdirSync(dirname(absolute), { recursive: true });
    git(scene.root, 'worktree', 'add', '-q', '-b', slot, absolute);
    const relative = `../worktrees/acme/${slot}`;
    writeTeam(scene, `  - role: implementer
    name: maker
    cli: grok
    vendor: xai
    model: Grok
    version: "4.7"
    display: Grok 4.7
    launch: grok --model grok-4.7
    cwd: ${relative}
    mode: worktree
`, remove);
    place(scene, { name: 'maker', pane: 'pane-maker', session: GROK_SESSION, worktree: { slot, path: relative } });
    const host = stubHost(scene, [...STAFF, { name: 'maker', pane: 'pane-maker', cli: 'grok', cwd: absolute, text: GROK_IDLE, exitText: GROK_EXIT }]);
    const caller = remove === 'manual' ? lead() : operator();
    const result = await swap(scene, ['maker', 'claude-opus'], caller, host.sources);
    expect(result.code).toBe(0);
    const seat = readSeat(scene, 'maker');
    expect(seat.cli).toBe('claude-code');
    expect(seat.vendor).toBe('anthropic');
    expect(seat.model).toBe('Claude Opus');
    expect(seat.version).toBe('5.5');
    expect(seat.display).toBe('Claude Opus 5.5');
    expect(hasVersionToken(seat.display, seat.version)).toBe(true);
    expect(seat.launch).toContain('claude-opus-5-5');
    expect(host.started()).toBe(1);
    expect(host.runs.some((command) => command.includes(GROK_SESSION))).toBe(false);
    expect(recordedPath(scene, 'maker')).toBe(relative);
  }
});

test('kimi to glm on claude-code changes launch, model, version and display together, and does not resume', async () => {
  const scene = open();
  standardPresets(scene);
  writeTeam(scene, `  - role: implementer
    name: kimi
    cli: claude-code
    vendor: moonshot
    model: Kimi
    version: "2.5"
    display: Kimi 2.5
    launch: claude --model kimi-k2
    mode: shared
`);
  place(scene, { name: 'kimi', pane: 'pane-kimi', session: KIMI_SESSION });
  const host = stubHost(scene, [...STAFF, { name: 'kimi', pane: 'pane-kimi', cli: 'claude-code', cwd: scene.root, text: CLAUDE_IDLE }]);
  const result = await swap(scene, ['kimi', 'claude-glm'], operator(), host.sources);
  expect(result.code).toBe(0);
  const seat = readSeat(scene, 'kimi');
  expect(seat.cli).toBe('claude-code');
  expect(seat.vendor).toBe('zhipu');
  expect(seat.model).toBe('GLM');
  expect(seat.version).toBe('4.6');
  expect(seat.display).toBe('GLM 4.6');
  expect(hasVersionToken(seat.display, seat.version)).toBe(true);
  expect(seat.launch).toContain('glm-4.6');
  expect(seat.launch.includes('kimi-k2')).toBe(false);
  expect(host.started()).toBe(1);
  expect(host.runs.some((command) => command.includes(KIMI_SESSION))).toBe(false);
  expect(recordedPath(scene, 'kimi')).toBeUndefined();
});

test('a dry run prints the swap and writes nothing', async () => {
  const scene = open();
  standardPresets(scene);
  writeTeam(scene, `  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    display: GPT Sol 5.0
    launch: codex --model gpt-sol
    mode: shared
`);
  place(scene, { name: 'worker', pane: 'pane-worker', session: CODEX_SESSION });
  const before = readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8');
  const beforeTrees = JSON.stringify(readState(join(scene.root, '.agents')).sessions.acme?.worktrees ?? {});
  const host = stubHost(scene, [...STAFF, { name: 'worker', pane: 'pane-worker', cli: 'codex', cwd: scene.root, text: CODEX_IDLE, exitText: CODEX_EXIT }]);
  const result = await swap(scene, ['worker', 'grok-high', '--dry-run'], lead(), host.sources);
  expect(result.code).toBe(0);
  expect(`${result.out}${result.err}`).toContain('worker');
  expect(`${result.out}${result.err}`).toContain('grok-high');
  expect(readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8')).toBe(before);
  expect(JSON.stringify(readState(join(scene.root, '.agents')).sessions.acme?.worktrees ?? {})).toBe(beforeTrees);
  expect(host.started()).toBe(0);
  expect(host.runs).toEqual([]);
});

test('a preset the seat policy does not allow is refused and writes nothing', async () => {
  const scene = open();
  standardPresets(scene);
  writeTeam(scene, `  - role: implementer
    name: worker
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    display: GPT Sol 5.0
    launch: codex --model gpt-sol
    mode: shared
`);
  const ruled = writePolicySet(scene.home, { level: 'entity', target: 'lab', name: 'model-rule', value: 'worker=!xai' }, { now: NOW });
  if (!ruled.ok) throw new Error(ruled.why);
  place(scene, { name: 'worker', pane: 'pane-worker', session: CODEX_SESSION });
  const before = readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8');
  const host = stubHost(scene, [...STAFF, { name: 'worker', pane: 'pane-worker', cli: 'codex', cwd: scene.root, text: CODEX_IDLE, exitText: CODEX_EXIT }]);
  const result = await swap(scene, ['worker', 'grok-high'], lead(), host.sources);
  expect(readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8')).toBe(before);
  expect(recordedPath(scene, 'worker')).toBeUndefined();
  expect(host.started()).toBe(0);
  if (result.code === 0) expect(`${result.out}${result.err}`.toLowerCase()).toMatch(/request|card/);
  else expect(result.code).toBe(1);
});

test('a placed operator cannot swap the orchestrator seat', async () => {
  const scene = open();
  standardPresets(scene);
  writeTeam(scene, '');
  place(scene, { name: 'lead', pane: 'pane-lead', session: 'ses_0123456789ae' });
  const before = readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8');
  const host = stubHost(scene, STAFF);
  const result = await swap(scene, ['lead', 'grok-high'], operator(), host.sources);
  expect(result.code).toBe(1);
  expect(result.err).toContain('only the owner swaps the orchestrator seat');
  expect(readFileSync(join(scene.root, '.agents', 'team.yaml'), 'utf8')).toBe(before);
  expect(host.started()).toBe(0);
});
