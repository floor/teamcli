// The seats page's new paragraph: the handle belongs to the seat, not to one run of it.
// Minted on first launch or add, parked by down and remove --keep, recorded again by the
// next up or add, dropped by a plain remove. Every row here drives the commands and reads
// the state and the page the paragraph's reader would: nothing is seeded that a run should
// have written, apart from the one scene that needs a launched seat beside never-launched
// ones. The last row pins the sentence the code does not keep: down parks a temporary
// seat's handle too — the paragraph carries no carve-out — and is marked failing for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf, verifiedOf } from '../src/approve/approval.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runSeats, type SeatsSources } from '../src/commands/seats.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { SEAT_ID_PATTERN, emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import type { Machine } from '../src/watch/machine.ts';
import { claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T12:30:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const AMPLE: Machine = {
  loadPerCore: 0.3, memoryFree: 60, diskFree: 200e9, swapTotal: 10e9, swapFree: 9e9, swapUsed: 1e9,
};
const SEAT = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'acme' };
const owner = { kind: 'owner' } as const;
const NAMES = ['lead', 'builder-1', 'builder-2', 'tester-1', 'tester-2'];

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

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

// Five people: one orchestrator, two builders, two testers, every one launched by `up`.
function teamYaml(): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobby}
  - ${root}
  - ${join(base, 'worktrees')}
workspace:
  mode: shared
  base: main
seats:
${seat('lead', 'coordinator')}
    mode: shared
    cwd: .
${seat('builder-1', 'implementer')}
${seat('builder-2', 'implementer')}
${seat('tester-1', 'reviewer')}
${seat('tester-2', 'reviewer')}
`;
}

function writeFile(text: string): void {
  writeFileSync(join(dir, 'team.yaml'), text);
}

function approveAt(text: string): string {
  writeFile(text);
  const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  const store = storePath(loaded.team.project, loaded.root, home);
  writeApproval(
    store,
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  return join(store, 'approval.json');
}

function session(): ReturnType<typeof readState>['sessions'][string] {
  const read = readState(dir).sessions.acme;
  if (!read) throw new Error('no acme session in state');
  return read;
}

function record(seats: Record<string, string>): void {
  updateState(dir, (file) => {
    const one = (file.sessions.acme ??= emptySession());
    for (const [name, pane] of Object.entries(seats)) {
      one.seats[name] = { stage: 'ready', pane };
    }
  });
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
  let clock = NOW.getTime();
  let running: 'absent' | 'running' = 'absent';
  const launch: Launch = {
    sessionState: () => running,
    startServer() {
      running = 'running';
      return true;
    },
    sessionUp: () => running === 'running',
    createWorkspace(_session, _cwd, _label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    typeText: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return {
    launch,
    get clock() { return clock; },
  };
}

function upSources(made: ReturnType<typeof world>): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    home,
    doctor: doctor(),
    machine: () => AMPLE,
    launch: made.launch,
    now: () => new Date(made.clock),
  };
}

function addSources(made: ReturnType<typeof world>): AddSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => new Date(made.clock),
    launch: made.launch,
  };
}

function agentOf(name: string, pane: string, workspace: string): HerdrAgent {
  return { name, agent: 'claude', pane, workspace, status: 'idle', cwd: null };
}

function removeSources(agents: HerdrAgent[]): RemoveSources {
  const launchHost = {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => agents.map((one) => one.pane),
    closeWorkspace: () => true,
    stopSession: () => false,
    deleteSession: () => false,
    kill: () => false,
    sleep: async () => {},
    now: () => NOW,
  };
  return {
    home,
    sessionRunning: () => true,
    agents: () => agents,
    alive: () => false,
    screen: () => ({ kind: 'unknown' }),
    screenText: () => claudeBox(''),
    status: () => 'idle',
    now: () => NOW,
    sleep: async () => {},
    launch: launchHost,
    foreground: () => [],
    shellBack: () => true,
  };
}

// One screen per recorded pane and a clock that moves when the command sleeps: the exit
// flow polls, and a pane leaves when its Enter lands.
function downSources(): DownSources {
  const IDLE_BOX = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
  const boxes = new Map<string, string>();
  const gone = new Set<string>();
  let clock = NOW.getTime();
  const people = (): HerdrAgent[] =>
    Object.entries(session().seats).map(([name, held]) => agentOf(name, held.pane ?? `${name}-pane`, held.workspace ?? `${name}-ws`));
  const launch = {
    typeText(_session: string, pane: string, text: string) {
      boxes.set(pane, claudeBox(text));
      return true;
    },
    sendKey(_session: string, pane: string) {
      boxes.set(pane, IDLE_BOX);
      return true;
    },
    pressEnter(_session: string, pane: string) {
      gone.add(pane);
      return true;
    },
    agentPanes: () => people().map((one) => one.pane).filter((pane) => !gone.has(pane)),
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return {
    sessionRunning: () => true,
    agents: people,
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: (_session: string, pane: string) => boxes.get(pane) ?? IDLE_BOX,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => new Date(clock),
    home,
    launch,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-seat-handle-')));
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
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function liveText(): string {
  return readFileSync(join(dir, 'team.yaml'), 'utf8');
}

/** Every handle the session currently records, keyed by seat name. */
function idsIn(seats: Record<string, { id?: string }>): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, held] of Object.entries(seats)) {
    if (held.id) ids[name] = held.id;
  }
  return ids;
}

async function mounted(): Promise<Record<string, string>> {
  approveAt(teamYaml());
  record({ lead: 'lead-pane' });
  const made = world();
  const io = testIo(root, owner);
  const code = await runUp([], io, upSources(made));
  expect(code, `up said:\n${io.out}\n${io.err}`).toBe(0);
  return idsIn(session().seats);
}

describe('the stable seat handle', () => {
  test('is minted on first launch, parked by down, and recorded again by the next up', async () => {
    const first = await mounted();
    expect(Object.keys(first).sort()).toEqual([...NAMES].sort());
    for (const id of Object.values(first)) expect(id).toMatch(SEAT_ID_PATTERN);
    expect(session().retained_seats ?? {}).toEqual({});

    const io = testIo(root, owner);
    const code = await runDown([], io, downSources());
    expect(code, `down said:\n${io.out}\n${io.err}`).toBe(0);
    expect(session().seats).toEqual({});
    const parked = session().retained_seats ?? {};
    expect(Object.keys(parked).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) expect(parked[name]?.id).toBe(first[name]);

    const made = world();
    const again = testIo(root, owner);
    const upCode = await runUp([], again, upSources(made));
    expect(upCode, `the second up said:\n${again.out}\n${again.err}`).toBe(0);
    expect(idsIn(session().seats)).toEqual(first);
    expect(session().retained_seats ?? {}).toEqual({});
  });

  test('remove --keep parks it and add records the same handle again', async () => {
    const ids = await mounted();
    const io = testIo(root, owner);
    const held = session().seats['tester-2']!;
    const code = await runRemove(
      ['--keep', 'tester-2'],
      io,
      removeSources([agentOf('tester-2', held.pane ?? 't2-pane', held.workspace ?? 't2-ws')]),
    );
    expect(code, `remove said:\n${io.out}\n${io.err}`).toBe(0);
    // --keep keeps the declared seat; only the runtime record goes.
    expect(liveText()).toContain('name: tester-2');
    expect((session().retained_seats ?? {})['tester-2']?.id).toBe(ids['tester-2']);

    const made = world();
    const add = testIo(root, owner);
    const addCode = await runAdd(['tester-2'], add, addSources(made));
    expect(addCode, `add said:\n${add.out}\n${add.err}`).toBe(0);
    expect(session().seats['tester-2']?.id).toBe(ids['tester-2']);
    expect((session().retained_seats ?? {})['tester-2']).toBeUndefined();
  });

  test('a plain remove drops the handle with the record, and the next add mints a fresh one', async () => {
    const ids = await mounted();
    const io = testIo(root, owner);
    const held = session().seats['builder-1']!;
    const code = await runRemove(
      ['builder-1'],
      io,
      removeSources([agentOf('builder-1', held.pane ?? 'b1-pane', held.workspace ?? 'b1-ws')]),
    );
    expect(code, `remove said:\n${io.out}\n${io.err}`).toBe(0);
    expect((session().retained_seats ?? {})['builder-1']).toBeUndefined();

    // Plain remove took the seat out of the file; the owner writes it back and approves
    // that file, then add mounts it — the name starting over with a fresh handle.
    approveAt(teamYaml());
    const made = world();
    const add = testIo(root, owner);
    const addCode = await runAdd(['builder-1'], add, addSources(made));
    expect(addCode, `add said:\n${add.out}\n${add.err}`).toBe(0);
    const minted = session().seats['builder-1']?.id;
    expect(minted).toMatch(SEAT_ID_PATTERN);
    expect(minted).not.toBe(ids['builder-1']);
  });

  test('the page: - before first launch, the parked handle after down', async () => {
    const text = approveAt(teamYaml());
    const loaded = loadTeamFile(root, { file: join(dir, 'team.yaml'), home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    // One launched seat (the handle a first launch mints) beside four that never launched.
    record({ lead: 'lead-pane' });
    updateState(dir, (file) => {
      file.sessions.acme!.seats.lead!.id = 'seat_abc123def456';
    });
    let live: Live = {
      running: true,
      agents: [agentOf('lead', 'lead-pane', 'w1')],
      workspaces: [{ id: 'w1', label: 'claude opus 5.5' }],
      screens: { 'lead-pane': IDLE },
    };
    const sources: SeatsSources = {
      live: () => live,
      branch: () => 'main',
      standing: () => verifiedOf(loaded.team, text, root, NOW),
      now: () => NOW,
      home,
    };
    const cellOf = (page: string, name: string): string | undefined =>
      page.split('\n').find((line) => line.startsWith(`${name}  `))?.trim().split(/\s{2,}/)[1];

    const before = testIo(root, owner);
    expect(await runSeats(['--all'], before, sources), `seats said:\n${before.out}\n${before.err}`).toBe(0);
    expect(cellOf(before.out, 'lead')).toBe('seat_abc123def456');
    for (const name of NAMES.filter((one) => one !== 'lead')) {
      expect(cellOf(before.out, name), `the ${name} row:\n${before.out}`).toBe('-');
    }

    // Down parks every launched handle, and the page keeps showing it: a seat that is
    // stopped comes back as itself, handle included.
    const made = world();
    const up = testIo(root, owner);
    expect(await runUp([], up, upSources(made))).toBe(0);
    const ids = idsIn(session().seats);
    const down = testIo(root, owner);
    expect(await runDown([], down, downSources())).toBe(0);
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const after = testIo(root, owner);
    expect(await runSeats(['--all'], after, sources), `seats said:\n${after.out}\n${after.err}`).toBe(0);
    for (const name of NAMES) {
      expect(cellOf(after.out, name), `the ${name} row:\n${after.out}`).toBe(ids[name]);
    }
  });

  // The paragraph parks every handle `team down` stops, with no carve-out for a temporary
  // seat; the code parks no temporary handle. Pinned as the sentence, marked failing.
  test.failing('down parks a temporary seat\'s handle too', async () => {
    approveAt(teamYaml());
    record(Object.fromEntries(NAMES.map((name) => [name, `${name}-pane`])));
    updateState(dir, (file) => {
      const one = file.sessions.acme!;
      for (const [at, name] of NAMES.entries()) {
        one.seats[name]!.id = `seat_${at.toString(16).padStart(2, '0')}aaaaaaaaaa`;
      }
      one.seats['tester-2']!.temporary = { like: 'lead', until: 'merged:fix/fresh' };
    });
    const io = testIo(root, owner);
    const code = await runDown([], io, downSources());
    expect(code, `down said:\n${io.out}\n${io.err}`).toBe(0);
    const parked = session().retained_seats ?? {};
    expect(parked['lead']?.id).toBe('seat_00aaaaaaaaaa');
    expect(parked['tester-2']?.id).toBe('seat_04aaaaaaaaaa');
  });
});
