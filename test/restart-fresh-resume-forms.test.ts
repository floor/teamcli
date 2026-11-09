// `team restart <seat> --fresh` clears a pinned conversation for each measured resume
// form: Codex `resume <id>`, Claude Code `-r <id>`, and Grok `-r <id>` (an id may contain
// `:`). One restart writes the stripped launch and `agent_session: null` together. Without
// `--fresh` the recorded line stays. Synthetic panes, a stubbed host, no live CLI.
import { execFileSync } from 'node:child_process';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runRestart, type RestartSources } from '../src/commands/restart.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { withoutResume } from '../src/profiles/profile.ts';
import { agentsDir, registerAgent, type Agent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { CLAUDE_IDLE, claudeBox, shortSocketBase, testIo } from './helpers.ts';

const NOW = new Date('2026-11-08T10:00:00Z');
// Codex and Grok stop on their own composer. A Claude box does not read as their idle
// prompt, so the exit is never typed. These are the captures restart's own scenes use:
// idle before the stop, `/exit` in the composer after the one text this scene types.
const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replaceAll('gpt-5.6-terra', 'gpt-6.1-sol')
  .replaceAll('GPT-5.6-Terra', 'GPT-6.1-Sol');
const CODEX_EXIT_TYPED = readFileSync(new URL('./fixtures/codex/0.161.0/exit-typed.txt', import.meta.url), 'utf8');
const GROK_IDLE = readFileSync(new URL('./fixtures/grok/1.0.52/idle.txt', import.meta.url), 'utf8');
const GROK_EXIT_TYPED = readFileSync(new URL('./fixtures/grok/1.0.52/exit-typed.txt', import.meta.url), 'utf8');

/** The pane before the exit is typed: that CLI's empty composer. */
function idleScreen(cli: string): string {
  if (cli === 'codex') return CODEX_IDLE;
  if (cli === 'grok') return GROK_IDLE;
  return claudeBox('');
}

/** The pane after `/exit` is typed: the composer holding that text, as the profile reads it back. */
function exitScreen(cli: string, text: string): string {
  if (cli === 'codex') return CODEX_EXIT_TYPED;
  if (cli === 'grok') return GROK_EXIT_TYPED;
  return claudeBox(text);
}

type Form = {
  cli: string;
  vendor: string;
  model: string;
  version: string;
  process: string;
  clean: string;
  pinned: string;
  pin: string;
};

const CODEX: Form = {
  cli: 'codex',
  vendor: 'openai',
  model: 'GPT Sol',
  version: '6.1',
  process: 'codex',
  clean: 'codex -m gpt-x -c model_reasoning_effort=high',
  pin: 'ses_0123456789ab',
  pinned: 'codex -m gpt-x -c model_reasoning_effort=high resume ses_0123456789ab',
};
const CLAUDE: Form = {
  cli: 'claude-code',
  vendor: 'anthropic',
  model: 'Claude Opus',
  version: '5.5',
  process: 'claude',
  clean: 'claude --model claude-opus-5-5',
  pin: 'ses_0123456789ab',
  pinned: 'claude --model claude-opus-5-5 -r ses_0123456789ab',
};
const GROK: Form = {
  cli: 'grok',
  vendor: 'xai',
  model: 'Grok',
  version: '4.7',
  process: 'grok',
  clean: 'grok --model grok-4.7',
  pin: 'ses:0123456789ab',
  pinned: 'grok --model grok-4.7 -r ses:0123456789ab',
};

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

type Scene = {
  home: string;
  root: string;
  dir: string;
  agent: Agent;
  runs: string[];
  sources: RestartSources;
};

function teamText(form: Form, workerLaunch: string): string {
  const seat = (name: string, role: string, launch: string) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${name === 'worker' ? form.cli : 'claude-code'}
    vendor: ${name === 'worker' ? form.vendor : 'anthropic'}
    model: ${name === 'worker' ? form.model : 'Claude Opus'}
    version: "${name === 'worker' ? form.version : '5.5'}"
    launch: ${launch}`;
  return `format: 1
project: acme
coordinator: lead
operator: ops
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator', 'claude --model claude-opus-5-5')}
${seat('ops', 'coordinator', 'claude --model claude-opus-5-5')}
${seat('worker', 'implementer', workerLaunch)}
`;
}

function open(form: Form, workerLaunch: string): Scene {
  const base = realpathSync(mkdtempSync(join(shortSocketBase(), 'restart-fresh-forms-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'team.yaml'), teamText(form, workerLaunch).replace('workspace:\n', `trust:\n  - ~/.config/team/lobby\n  - ${root}\nworkspace:\n`));
  // Grok writes its start folder. The checkout itself would grant that whole tree, so the seat
  // waits in its own folder under the scene, beside the checkout.
  const own = join(base, 'worker-tree');
  if (form.cli === 'grok') mkdirSync(own);
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = { stage: 'ready', pane: 'pane-lead', workspace: 'ws-lead' };
    session.seats.ops = { stage: 'ready', pane: 'pane-ops', workspace: 'ws-ops' };
    session.seats.worker = { stage: 'ready', pane: 'pane-old', workspace: 'ws-old', agent_session: form.pin };
    if (form.cli === 'grok') session.worktrees.worker = { seat: 'worker', path: own, branch: 'fix/worker', setup: 'ok' };
  });
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  const lead = loaded.team.seats.find((seat) => seat.name === 'lead');
  if (lead === undefined) throw new Error('no lead');
  const placed = registerLaunch({ home, team: loaded.team, root, by: 'owner' }, lead, 'pane-lead');
  if ('note' in placed) throw new Error(placed.note);
  const agent = registerAgent(home, {
    name: 'worker',
    signing: { model: form.model, version: form.version, role: 'implementer' },
    lab: form.vendor,
    cli: form.cli,
    launcher: null,
    launch: form.pinned,
    reach: {
      team: teamIdOf(root),
      seat: 'worker',
      session: 'acme',
      pane: 'pane-old',
      address: null,
      agent_session: form.pin,
    },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    settings: { effort: { word: 'steady' } },
    by: 'the test',
  });

  const runs: string[] = [];
  let workerAlive = true;
  let shelled = false;
  const drawn = new Map<string, string>();
  const fresh = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  const agents = (): HerdrAgent[] => [
    { name: 'lead', agent: 'claude-code', pane: 'pane-lead', workspace: 'ws-lead', status: 'idle', cwd: root },
    { name: 'ops', agent: 'claude-code', pane: 'pane-ops', workspace: 'ws-ops', status: 'idle', cwd: root },
    ...(workerAlive
      ? [{ name: 'worker', agent: form.cli, pane: 'pane-old', workspace: 'ws-old', status: 'idle' as const, cwd: form.cli === 'grok' ? own : root, session: form.pin }]
      : []),
    ...[...fresh.entries()].filter(([, slot]) => slot.agent).map(([pane, slot]) => ({
      name: slot.name,
      agent: form.cli,
      pane,
      workspace: slot.workspace,
      status: 'idle' as const,
      cwd: form.cli === 'grok' ? own : root,
    })),
  ];
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      drawn.set(pane, exitScreen(form.cli, text));
      return text.includes('/exit');
    },
    sendKey: () => true,
    pressEnter() {
      shelled = true;
      return true;
    },
    agentPanes: () => agents().map((item) => item.pane),
    closeWorkspace(_session, workspace) {
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
    registerInbox: () => ({ ok: true }),
    createWorkspace() {
      const pane = 'pane-new';
      const workspace = 'ws-new';
      fresh.set(pane, { text: form.cli === 'claude-code' ? CLAUDE_IDLE : idleScreen(form.cli), agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      runs.push(command);
      const slot = fresh.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = fresh.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace: downLaunch.closeWorkspace,
    agentPanes: () => agents().map((item) => item.pane),
    agents: () => agents(),
    workspacePanes: (_session, workspace) => {
      if (workspace === 'ws-old' && workerAlive) return ['pane-old'];
      return [...fresh.entries()].filter(([, slot]) => slot.workspace === workspace).map(([pane]) => pane);
    },
    paneText: (_session, pane) => drawn.get(pane) ?? fresh.get(pane)?.text ?? CLAUDE_IDLE,
    typeText(_session, pane, text) {
      const slot = fresh.get(pane);
      if (slot) slot.text = claudeBox(text);
      return true;
    },
    pressEnter() {
      return true;
    },
    agentStatus: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [form.process]),
    shellBack: (_session, pane) => pane === 'pane-old' && shelled,
    sleep: async () => {},
    now: () => NOW,
  };
  const doctor: DoctorSources = {
    version: (binary) => (binary === 'codex' ? '0.160.0' : binary === 'grok' ? '1.0.52' : '2.1.288'),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now: () => NOW,
    home,
  };
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => agents(),
    workspaces: () => agents().map((item) => ({ id: item.workspace })),
    alive: () => true,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session, pane) => drawn.get(pane) ?? (pane === 'pane-old' ? idleScreen(form.cli) : claudeBox('')),
    status: () => 'idle',
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [form.process]),
    now: () => NOW,
    sleep: async () => {},
    launch: downLaunch,
    upLaunch,
    doctor,
    autoOrder: () => null,
  };
  return { home, root, dir, agent, runs, sources };
}

function recordText(scene: Scene): string {
  return readFileSync(join(agentsDir(scene.home), `${scene.agent.id}.yaml`), 'utf8');
}

function launchLine(text: string): string {
  return text.split('\n').find((line) => line.startsWith('launch:')) ?? '';
}

function resumed(command: string, form: Form): boolean {
  if (command.includes(form.pin)) return true;
  if (form.cli === 'codex') return /(^|\s)resume(\s|$)/.test(command);
  return command.includes('--resume') || /(^|\s)-r(\s|=|$)/.test(command);
}

test('withoutResume strips a codex or grok resume by its source span and leaves an unproved line', () => {
  expect(withoutResume('codex', CODEX.pinned)).toBe(CODEX.clean);
  expect(withoutResume('codex', "codex -m 'gpt x' resume 'ses_1'")).toBe("codex -m 'gpt x'");
  expect(withoutResume('codex', '/bin/sh -c "codex -m gpt-x resume ses_1"')).toBe('/bin/sh -c "codex -m gpt-x"');
  expect(withoutResume('codex', 'codex resume')).toBeNull();
  expect(withoutResume('codex', 'codex resume ses_1 # keep')).toBeNull();
  expect(withoutResume('codex', 'codex resume "ses_1')).toBeNull();
  expect(withoutResume('grok', GROK.pinned)).toBe(GROK.clean);
  expect(withoutResume('grok', 'grok --resume=ses:1 --model grok-4.7')).toBe('grok --model grok-4.7');
  expect(withoutResume('grok', 'grok --resume ses:1')).toBe('grok');
  expect(withoutResume('grok', '/bin/sh -c "grok -r ses:1 --model grok-4.7"')).toBe('/bin/sh -c "grok --model grok-4.7"');
  expect(withoutResume('claude-code', CLAUDE.pinned)).toBe(CLAUDE.clean);
});

for (const form of [CODEX, CLAUDE, GROK]) {
  test(`restart --fresh clears a pinned ${form.cli} conversation in one write and launches with no resume`, async () => {
    const scene = open(form, form.clean);
    const before = recordText(scene);
    expect(before).toContain(form.pin);
    const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
    const code = await runRestart(['worker', '--fresh'], io, scene.sources);
    expect(code).toBe(0);
    const after = recordText(scene);
    expect(after.includes(form.pin)).toBe(false);
    expect(after).toContain('agent_session: null');
    expect(scene.runs.length).toBeGreaterThan(0);
    for (const command of scene.runs) expect(resumed(command, form)).toBe(false);
    const log = readFileSync(join(scene.dir, 'team.log'), 'utf8');
    expect(log).toContain('worker: cleared the pinned conversation from its agent record');
  });
}

test('restart without --fresh leaves the pinned codex launch line untouched', async () => {
  const scene = open(CODEX, CODEX.pinned);
  const before = recordText(scene);
  const io = testIo(scene.root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' });
  const code = await runRestart(['worker'], io, scene.sources);
  expect(code).toBe(0);
  const after = recordText(scene);
  expect(launchLine(after)).toBe(launchLine(before));
  expect(after).toContain(`agent_session: ${JSON.stringify(CODEX.pin)}`);
  expect(after.includes('agent_session: null')).toBe(false);
  expect(scene.runs.some((command) => command.includes(CODEX.pin))).toBe(true);
});
