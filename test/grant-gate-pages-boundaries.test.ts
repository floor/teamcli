// The grant gate's rows on the up and down pages, held to the code's own words. The builder's
// grant file pins the gate's behaviour; these rows pin what the pages claim about it, in both
// directions: each quoted sentence must stand on its page verbatim, and a run that drives the
// scene it describes must print a line the sentence matches — placeholders as wildcards — so a
// reword on either side fails. Two behavioural edges the builder's file leaves open are pinned
// whole: the approved copy the record carries but cannot validate, on both commands, and the
// grant's own never-approved refusal on down, which takes the place of the ordinary one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runDown, type DownLaunch, type DownSources } from '../src/commands/down.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T16:00:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;

// The panes of the fixture: the caller's process chain descends from the root of the pane it
// runs on, and only the sessions whose list names a pane can place it.
type Pane = { pane: string; name: string; root: number };
const LEAD = { pane: 'lead-pane', name: 'lead', root: 100 };
const PILOT = { pane: 'pilot-pane', name: 'pilot', root: 200 };
const WORKER = { pane: 'worker-pane', name: 'worker', root: 300 };
const ALPHA = ['lead-pane', 'pilot-pane', 'worker-pane'];

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

function seat(name: string, role: string, extra: string[] = []): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
    ...extra,
  ].join('\n');
}

function teamText(opts: { scope?: string[]; grant?: boolean } = {}): string {
  const scope = opts.scope ?? ['up', 'down'];
  const grant = opts.grant === false ? '' : [
    'grant:',
    '  session: alpha',
    '  seat: lead',
    '  scope:',
    ...scope.map((act) => `    - ${act}`),
    '',
  ].join('\n');
  return `format: 1
project: acme
coordinator: lead
operator: pilot
session: alpha
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: worktree
  path: ../worktrees/{repo}/{task}
  branch: "{kind}/{task}"
  base: main
  protected: [.]
seats:
${seat('lead', 'coordinator', ['    mode: shared', '    cwd: .'])}
${seat('pilot', 'operator', ['    count: 1'])}
${seat('worker', 'implementer', ['    count: 1'])}
${grant}`;
}

/** Writes the live file and the approval an owner's `team approve` of exactly that text leaves
 *  on this machine. */
function setup(opts: { scope?: string[]; grant?: boolean; live?: string } = {}): void {
  const text = opts.live ?? teamText(opts);
  writeFileSync(join(dir, 'team.yaml'), text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

/** Re-signs the store's record over a `file` text today's validator refuses: the standing stays
 *  verified — the signature covers what was stored — but the copy it carries is not a team
 *  file. The gate's own readable-copy check is the one that answers. */
function corruptCopy(): void {
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: 'not a team file\n' },
    loaded.team.seats,
    home,
    NOW,
  );
}

function record(seats: Record<string, { pane: string; workspace: string }>): void {
  updateState(dir, (file) => {
    file.sessions.alpha = {
      ...emptySession(),
      seats: Object.fromEntries(Object.entries(seats).map(([name, seat]) => [
        name,
        { stage: 'ready' as const, pane: seat.pane, workspace: seat.workspace },
      ])),
    };
  });
}

/** The real placement walk, driven per session: the agents a session lists, the pane roots it
 *  answers for, the caller's ancestor chain, and the pane the environment hints at. */
function placeIo(
  panes: Pane[],
  lists: Record<string, string[]>,
  chain: number[],
  hint?: string,
): ReturnType<typeof testIo> {
  const io = testIo(root);
  io.env = hint === undefined ? {} : { HERDR_PANE_ID: hint };
  io.callerSources = (session: string | undefined) => ({
    ancestors: () => [{ pid: 1, name: 'herdr' }, ...chain.map((pid) => ({ pid, name: `step-${pid}` }))],
    agents: () => (session === undefined ? [] : (lists[session] ?? []).flatMap((pane) => {
      const found = panes.find((one) => one.pane === pane);
      return found ? [{ pane: found.pane, name: found.name, agent: null, workspace: '', status: '', cwd: null }] : [];
    })),
    paneRootPid: (pane: string) => (session !== undefined && (lists[session] ?? []).includes(pane)
      ? panes.find((one) => one.pane === pane)?.root ?? null
      : null),
    env: io.env,
    stdinIsTTY: false,
  });
  return io;
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

type UpTrace = { workspaces: { label: string; cwd: string }[]; closed: string[] };

/** A launch whose every effect is recorded. A refused scene leaves both empty. */
function upTrace(): { sources: UpSources; trace: UpTrace } {
  const trace: UpTrace = { workspaces: [], closed: [] };
  const panes = new Map<string, string>();
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace(_session, cwd, label) {
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      trace.workspaces.push({ label, cwd });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane) {
      panes.set(pane, IDLE);
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane) ?? '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: UpSources = {
    sessionRunning: () => session === 'running',
    sessionState: () => session,
    agents: () => [],
    home,
    doctor: doctor(),
    launch,
    now: () => NOW,
  };
  return { sources, trace };
}

type DownTrace = { closed: string[]; typed: string[] };

/** The stop side: a worker that answers its box, workspaces that record their close. */
function downTrace(makePeople: () => HerdrAgent[]): { sources: DownSources; trace: DownTrace } {
  const trace: DownTrace = { closed: [], typed: [] };
  let workerLive = true;
  let box = claudeBox('');
  const launch: DownLaunch = {
    typeText(_session, _pane, text) {
      trace.typed.push(text);
      box = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter() {
      workerLive = false;
      return true;
    },
    agentPanes: () => makePeople()
      .filter((agent) => agent.pane !== 'worker-pane' || workerLive)
      .map((agent) => agent.pane),
    closeWorkspace(_session, workspace) {
      trace.closed.push(workspace);
      return true;
    },
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
  };
  const sources: DownSources = {
    sessionRunning: () => true,
    agents: () => makePeople().filter((agent) => !trace.closed.includes(agent.workspace)),
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => box,
    status: () => 'idle',
    foreground: () => (workerLive ? ['claude'] : ['zsh']),
    now: () => NOW,
    home,
    launch,
  };
  return { sources, trace };
}

/** The named people of a running session, the shape herdr answers with. */
function people(): HerdrAgent[] {
  return [
    { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
    { name: 'pilot', agent: 'claude', pane: 'pilot-pane', workspace: 'pilot-ws', status: 'idle', cwd: null },
    { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
  ];
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-pages-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  setup();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

// The grant gate's sentences as the up page quotes them — placeholders and all. Each constant
// is asserted verbatim on the page and matched, wildcards for placeholders, against a run.
const SENTENCES = {
  flag: `--<flag> is the owner's; the granted seat cannot use it`,
  approval: `a grant needs a verified approval: <what is not in force>`,
  copy: 'a grant needs a readable approved copy: run `team approve`',
  drift: 'a grant needs the approved file: the file is not the approved one (<differences>): run `team approve`',
  caller: 'only the seat the grant names runs this: this call is <caller>',
  scope: 'the grant does not list `up`',
} as const;

/** A quoted sentence with its `<…>` placeholders as wildcards, anchored to a whole refusal. */
function template(sentence: string): RegExp {
  const parts = sentence.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.+')}$`);
}

/** The page's text with runs of whitespace collapsed, so wrapping survives, rewording fails. */
function page(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
}

const UP_PAGE = '../docs/internal/up.md';
const DOWN_PAGE = '../docs/internal/down.md';

/** Whether a run's stderr carries a refusal line the page's sentence matches. */
function says(err: string, sentence: string): boolean {
  return err.split('\n').some((line) => template(sentence).test(line.replace(/^team (up|down): /, '')));
}

describe('the approved copy the record carries but cannot validate', () => {
  test('up refuses the seat before anything runs, in the page\'s own words', async () => {
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    corruptCopy();
    const { sources, trace } = upTrace();
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runUp([], io, sources);
    expect(code, `up said:\n${io.out}\n${io.err}`).toBe(1);
    expect(io.err).toBe('team up: a grant needs a readable approved copy: run `team approve`\n');
    expect(trace.workspaces).toEqual([]);
    expect(trace.closed).toEqual([]);
  });

  test('down refuses in the same words, taking the place of its own copy check', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    corruptCopy();
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code, `down said:\n${io.out}\n${io.err}`).toBe(1);
    // The grant's line alone: the ordinary approved-copy refusal it replaces never prints.
    expect(io.err).toBe('team down: a grant needs a readable approved copy: run `team approve`\n');
    expect(trace.closed).toEqual([]);
    expect(trace.typed).toEqual([]);
  });
});

describe('the grant\'s never-approved refusal on down', () => {
  test('stands in for the ordinary one, whole, and stops nothing', async () => {
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
    if (!loaded.ok) throw new Error('load');
    rmSync(storePath(loaded.team.project, loaded.root, home), { recursive: true, force: true });
    const { sources, trace } = downTrace(() => people());
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    const code = await runDown([], io, sources);
    expect(code, `down said:\n${io.out}\n${io.err}`).toBe(1);
    expect(io.err).toBe('team down: a grant needs a verified approval: the file was never approved on this machine: run `team approve`\n');
    expect(trace.closed).toEqual([]);
    expect(trace.typed).toEqual([]);
  });
});

describe('the pages\' grant rows, pinned to the code\'s words', () => {
  test('the up page carries every sentence it quotes, verbatim', () => {
    const text = page(UP_PAGE);
    for (const sentence of Object.values(SENTENCES)) {
      expect(text, `the up page must carry: ${sentence}`).toContain(sentence.replace(/\s+/g, ' '));
    }
  });

  test('the down page\'s row names the grant gate and exactly its four ids', () => {
    const text = page(DOWN_PAGE);
    expect(text).toContain('team down: <the grant gate\'s text>');
    for (const id of ['down.grant-approval', 'down.grant-approved-copy', 'down.grant-drift', 'down.grant-scope']) {
      expect(text, `the down row must name ${id}`).toContain(id);
    }
  });

  test('a run of each scene prints a line its quoted sentence matches', async () => {
    // The copy scene: the record's file text does not validate, on both commands.
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    corruptCopy();
    const upIo = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    expect(await runUp([], upIo, upTrace().sources)).toBe(1);
    expect(says(upIo.err, SENTENCES.copy)).toBe(true);
    const downIo = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    expect(await runDown([], downIo, downTrace(() => people()).sources)).toBe(1);
    expect(says(downIo.err, SENTENCES.copy)).toBe(true);

    // The never-approved scene, on down: the grant's words stand in for the ordinary ones.
    setup();
    record({
      lead: { pane: 'lead-pane', workspace: 'lead-ws' },
      pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' },
      worker: { pane: 'worker-pane', workspace: 'worker-ws' },
    });
    const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
    if (!loaded.ok) throw new Error('load');
    rmSync(storePath(loaded.team.project, loaded.root, home), { recursive: true, force: true });
    const io = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    expect(await runDown([], io, downTrace(() => people()).sources)).toBe(1);
    expect(says(io.err, SENTENCES.approval)).toBe(true);

    // The drift scene: the live file edits the grant the approval signed.
    setup();
    writeFileSync(join(dir, 'team.yaml'), teamText({ scope: ['up', 'down', 'approve'] }));
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const drifted = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    expect(await runUp([], drifted, upTrace().sources)).toBe(1);
    expect(says(drifted.err, SENTENCES.drift)).toBe(true);

    // The caller scene: the operator's seat asks, the grant names the orchestrator's.
    setup();
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, pilot: { pane: 'pilot-pane', workspace: 'pilot-ws' } });
    const stranger = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [PILOT.root], PILOT.pane);
    expect(await runUp([], stranger, upTrace().sources)).toBe(1);
    expect(says(stranger.err, SENTENCES.caller)).toBe(true);

    // The scope scene: the grant lists `down`, the seat asks for `up`.
    setup({ scope: ['down'] });
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    const narrow = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
    expect(await runUp([], narrow, upTrace().sources)).toBe(1);
    expect(says(narrow.err, SENTENCES.scope)).toBe(true);

    // The flag scene: a passed grant still cannot aim the owner's flags, either spelling.
    setup();
    record({ lead: { pane: 'lead-pane', workspace: 'lead-ws' }, worker: { pane: 'worker-pane', workspace: 'worker-ws' } });
    for (const argv of [['--session', 'beta'], ['--file', join(base, 'no-such-file.yaml')]] as const) {
      const aimed = placeIo([LEAD, PILOT, WORKER], { alpha: ALPHA }, [LEAD.root], LEAD.pane);
      expect(await runUp([...argv], aimed, upTrace().sources)).toBe(1);
      expect(says(aimed.err, SENTENCES.flag)).toBe(true);
    }
  });
});
