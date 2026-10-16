import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { accountsWithRoom, seatBudget } from '../src/budgets/gate.ts';
import { saveReadings, saveSpendReadings, type Seen, type SpendReading } from '../src/budgets/readings.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo, withWas } from './helpers.ts';

const NOW = new Date('2026-10-04T09:00:00Z');
const now = NOW.getTime();
const FILE = ['--file', '.agents/team.yaml'];
const OWNER = { kind: 'owner' } as const;
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
const TAIL = 'openai weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic';
const WHY = `refused: ${TAIL}`;
/** Line 1 of the lead, its written label. The worker's written label is `worker`. */
const TITLE = 'lead';

const BASE = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
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
    mode: shared
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: openai
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

// The same file with the worker's account spent by check instead of a subscription.
const SPEND = BASE.replace(
  'openai: { kind: subscription, reserve: 10%, sources: [status_line] }',
  'openai: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }',
);
const SPEND_TAIL = 'openai spend 4.20 USD, at or below its 5.00 USD floor, read 3m ago; accounts with room: anthropic';
const SPEND_WHY = `refused: ${SPEND_TAIL}`;

// The same file with the worker's account read by check first, the status line as the fallback (§ 3).
const CHECK = BASE.replace(
  'openai: { kind: subscription, reserve: 10%, sources: [status_line] }',
  'openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }',
);
// And with no status line to fall back to.
const CHECK_ONLY = BASE.replace(
  'openai: { kind: subscription, reserve: 10%, sources: [status_line] }',
  'openai: { kind: subscription, reserve: 10%, sources: [check], check: openai-usage }',
);
const CHECK_TAIL = 'openai weekly left 5%, inside its 10% reserve, read 3m ago; accounts with room: anthropic';
const CHECK_WHY = `refused: ${CHECK_TAIL}`;

let base: string;
let root: string;
let home: string;

function reading(account: string, left: number, over: Partial<Seen> = {}): Seen {
  return {
    account,
    window: 'weekly',
    left,
    used: 100 - left,
    changedAt: now - 60_000,
    resetsAt: now + 3_600_000,
    seat: account,
    source: 'status_line',
    confirmed: true,
    ...over,
  };
}

function spend(account: string, amount: number, at: number = now, over: Partial<SpendReading> = {}): SpendReading {
  return { account, amount, currency: 'USD', at, ...over };
}

// A reading a check command wrote, in the same slot as a screen reading (§ 5): no seat saw it, it
// is confirmed at first sight, and its own measurement time is what ages it.
function checkReading(account: string, left: number, over: Partial<Seen> = {}): Seen {
  return reading(account, left, { seat: null, source: 'check', changedAt: now - 3 * 60_000, ...over });
}

function store(list: Seen[]): void {
  saveReadings(join(root, '.agents'), list, now);
}

function storeSpend(list: SpendReading[]): void {
  saveSpendReadings(join(root, '.agents'), list);
}

function writeTeamYaml(text: string): string {
  const yaml = text.includes('trust:')
    ? text
    : text.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n`);
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  return yaml;
}

function approve(text: string = BASE): void {
  const yaml = writeTeamYaml(text);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: yaml },
    loaded.team.seats,
    home,
  );
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
  const made = {
    launch: {} as Launch,
    labels: [] as string[],
    session: 'absent' as 'absent' | 'running',
    seed(pane: string, text: string, agent: boolean) {
      panes.set(pane, { text, agent });
    },
  };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.labels.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async () => {},
    now: () => NOW,
  };
  return made;
}

async function up(argv: string[], made: ReturnType<typeof world>, over: Partial<UpSources> = {}) {
  const io = testIo(root, OWNER);
  const sources: UpSources = {
    sessionRunning: () => made.session === 'running',
    sessionState: () => made.session,
    agents: () => [],
    home,
    now: () => NOW,
    launch: made.launch,
    ...over,
  };
  const code = await runUp([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels };
}

async function add(argv: string[], made: ReturnType<typeof world>) {
  const io = testIo(root, OWNER);
  const sources: AddSources = {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
  };
  const code = await runAdd([...argv, ...FILE], io, sources);
  return { code, out: io.out, err: io.err, labels: made.labels };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-budget-refusal-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a stored reading refuses one seat', () => {
  test('a confirmed fresh reading inside the reserve refuses, and names who has room', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${TAIL}\n`);
    expect(dry.out).toContain(`--label ${TITLE}`);
    expect(dry.out).not.toContain('<pane of worker>');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: ${WHY}\n`);
    expect(live.out).toContain('lead: ready\n');
    expect(live.out).not.toContain('worker: ready');
    expect(live.labels).toEqual([TITLE]);
  });

  test('a stale reading with its reset still ahead keeps refusing', async () => {
    store([
      reading('anthropic', 80),
      reading('openai', 5, { changedAt: now - 31 * 60_000 }),
    ]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain('skip worker: would refuse: openai weekly left 5%, inside its 10% reserve, changed 31m ago; accounts with room: anthropic');
  });

  test('a point on the stored reading moves no verdict and no refusal line', async () => {
    // § 5: the gate counts figures and ages, never points. The same store, the same file and the
    // same `up --dry-run` — the refusal, the room it names and the seat it skips, line for line,
    // whether the readings carry points or do not.
    const readings = [reading('anthropic', 80), reading('openai', 5), reading('openai', 62, { window: 'session' })];
    const run = async (points: boolean) => {
      store(points ? readings.map(withWas) : readings);
      return up(['--dry-run'], world());
    };
    const plain = await run(false);
    const pointed = await run(true);
    // Non-vacuity: the refusal this pins is the stored reading's own — the point rides a reading
    // the gate actually counted — and the point is distinct from the figure beside it.
    expect(plain.out).toContain(`  skip worker: would refuse: ${TAIL}\n`);
    expect(withWas(reading('openai', 5)).was).toEqual({ left: 12, at: now - 31 * 60_000 });
    expect(pointed).toEqual(plain);
  });

  test('a first sight, an unknown figure, a stale reading with no reset, and an account with no entry do not refuse', async () => {
    store([reading('anthropic', 80), reading('openai', 5, { confirmed: false })]);
    const first = await up(['--dry-run'], world());
    expect(first.out).not.toContain('would refuse');
    expect(first.out).toContain('openai: first sight only, not yet counted; would launch');
    expect(first.out).toContain('<pane of worker>');
    const firstLive = await up([], world());
    expect(firstLive.code).toBe(0);
    expect(firstLive.err).toContain('worker: openai: first sight only, not yet counted\n');
    expect(firstLive.out).toContain('worker: ready\n');

    store([reading('anthropic', 80)]);
    const unknown = await up(['--dry-run'], world());
    expect(unknown.out).not.toContain('would refuse');
    expect(unknown.out).toContain('openai is unknown; would launch');

    store([
      reading('anthropic', 80),
      reading('openai', 5, { changedAt: now - 31 * 60_000, resetsAt: null }),
    ]);
    const stale = await up(['--dry-run'], world());
    expect(stale.out).not.toContain('would refuse');
    expect(stale.out).toContain('openai is unknown; would launch');

    approve(BASE.replace('    openai: { kind: subscription, reserve: 10%, sources: [status_line] }\n', ''));
    store([reading('anthropic', 80)]);
    const missing = await up(['--dry-run'], world());
    expect(missing.out).not.toContain('would refuse');
    expect(missing.out).not.toContain('is unknown');
    expect(missing.out).toContain('<pane of worker>');
  });

  test('a stale figure with no reset only counts well outside the reserve', async () => {
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    const budgets = loaded.team.budgets;
    const old = { changedAt: now - 31 * 60_000, resetsAt: null };
    // Past twice the 10% reserve, the room the figure last held clears the launch...
    store([reading('anthropic', 80), reading('openai', 70, old)]);
    const far = await up(['--dry-run'], world());
    expect(far.out).not.toContain('would refuse');
    expect(far.out).not.toContain('is unknown');
    expect(far.out).toContain('<pane of worker>');
    // ...at exactly twice it and inside it, a depleted figure is unknown — never a clearance.
    expect(seatBudget(budgets, [reading('openai', 20, old)], worker, now))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    expect(seatBudget(budgets, [reading('openai', 5, old)], worker, now))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    // And a no-reset figure is never a refusal, wherever it sits.
    expect(seatBudget(budgets, [reading('openai', 70, old)], worker, now)).toEqual({ kind: 'clear' });
  });

  test('the same reading refuses after a restart, with no seat running', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const made = world();
    expect(made.session).toBe('absent');
    const dry = await up(['--dry-run'], made);
    expect(dry.out).toContain(`skip worker: would refuse: ${TAIL}`);
    expect(dry.labels).toEqual([]);
  });

  test('a launched seat that is already running finishes setup', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const remember = (stage: 'launched' | 'named') => {
      updateState(join(root, '.agents'), (state) => {
        const session = state.sessions.acme ?? emptySession();
        session.seats.worker = { stage, pane: 'w7:p1', workspace: 'w7' };
        state.sessions.acme = session;
      });
    };
    const agent: HerdrAgent = {
      name: 'worker',
      agent: 'claude',
      pane: 'w7:p1',
      workspace: 'w7',
      status: 'idle',
      cwd: null,
    };
    remember('launched');
    const made = world();
    made.session = 'running';
    made.seed('w7:p1', IDLE, true);
    const live = await up([], made, {
      agents: () => [agent],
      workspaces: () => [{ id: 'w7', label: 'deepseek flash v4.1' }],
    });
    expect(live.code).toBe(0);
    expect(live.err).toContain(`worker: ${TAIL}\n`);
    expect(live.out).not.toContain('refused');
    expect(live.out).toContain('worker: ready\n');
    expect(live.labels).toEqual([TITLE]);

    remember('launched');
    const blocked = world();
    blocked.session = 'running';
    const dry = await up(['--dry-run'], blocked, {
      workspaces: () => [{ id: 'w7', label: 'deepseek flash v4.1' }],
    });
    expect(dry.out).toContain(`skip worker: would refuse: ${TAIL}`);
    expect(dry.out).not.toContain('rename w7:p1 worker');

    remember('named');
    const named = await up(['--dry-run'], world(), {
      sessionState: () => 'running',
      agents: () => [agent],
      workspaces: () => [{ id: 'w7', label: 'deepseek flash v4.1' }],
    });
    expect(named.out).not.toContain('would refuse');
    expect(named.out).toContain(`(${TAIL})`);
    expect(named.out).toContain('worker: named, and its rules went with the launch; marked ready');
  });

  test('an unknown account is said, and the seat still starts', async () => {
    store([reading('anthropic', 80)]);
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.err).toContain('worker: openai is unknown\n');
    expect(live.out).toContain('worker: ready\n');
    expect(live.labels).toEqual([TITLE, 'worker']);
  });

  test('the tightest window is the one named', () => {
    approve();
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error('file');
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    const inside = seatBudget(loaded.team.budgets, [
      reading('openai', 8),
      reading('openai', 5, { window: 'session' }),
      reading('anthropic', 80),
    ], worker, now);
    expect(inside).toEqual({
      kind: 'refuse',
      why: 'openai session left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic',
    });
    const tied = seatBudget(loaded.team.budgets, [
      reading('openai', 5),
      reading('openai', 5, { window: 'session' }),
      reading('anthropic', 80),
    ], worker, now);
    expect(tied).toEqual({
      kind: 'refuse',
      why: 'openai session left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic',
    });
    // The lowest left beats the window rank: weekly, the higher rank, is the tighter one here.
    const lowest = seatBudget(loaded.team.budgets, [
      reading('openai', 5),
      reading('openai', 8, { window: 'session' }),
      reading('anthropic', 80),
    ], worker, now);
    expect(lowest).toEqual({
      kind: 'refuse',
      why: 'openai weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic',
    });
  });

  test('a spend account is unknown until a money reading exists', () => {
    approve(SPEND);
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    expect(seatBudget(loaded.team.budgets, [], worker, now)).toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
  });
});

describe('a spend floor refuses one seat', () => {
  beforeEach(() => approve(SPEND));

  function loadedTeam() {
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    return loaded.team;
  }

  function seatOf(name: string) {
    const seat = loadedTeam().seats.find((one) => one.name === name);
    if (!seat) throw new Error(name);
    return seat;
  }

  test('a counted reading at or below the floor refuses, and the other seats still start', async () => {
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 4.2, now - 3 * 60_000)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${SPEND_TAIL}\n`);
    expect(dry.out).not.toContain('<pane of worker>');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: ${SPEND_WHY}\n`);
    expect(live.out).toContain('lead: ready\n');
    expect(live.labels).toEqual([TITLE]);
  });

  test('exactly at the floor refuses; above it launches', async () => {
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 5)]);
    const at = await up(['--dry-run'], world());
    expect(at.out).toContain('would refuse: openai spend 5.00 USD, at or below its 5.00 USD floor, read 0m ago; accounts with room: anthropic');

    storeSpend([spend('openai', 8)]);
    const above = await up([], world());
    expect(above.code).toBe(0);
    expect(above.labels).toEqual([TITLE, 'worker']);
    expect(above.out).not.toContain('refused');
    expect(above.out).not.toContain('is unknown');
  });

  test('a reading with more decimals than the cents prints as read, never rounded into a contradiction', async () => {
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 4.996, now - 3 * 60_000)]);
    const tail = 'openai spend 4.996 USD, at or below its 5.00 USD floor, read 3m ago; accounts with room: anthropic';

    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${tail}\n`);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: refused: ${tail}\n`);

    const added = await add(['worker'], world());
    expect(added.code).toBe(1);
    expect(added.err).toBe(`team add: refused: ${tail}\n`);

    const addedDry = await add(['worker', '--dry-run'], world());
    expect(addedDry.code).toBe(1);
    expect(addedDry.out).toContain(`worker: would refuse: ${tail}\n`);
  });

  test('the comparison keeps the real value while the figure prints as read', async () => {
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 4.9999)]);
    const just = await up(['--dry-run'], world());
    expect(just.out).toContain('would refuse: openai spend 4.9999 USD, at or below its 5.00 USD floor');

    storeSpend([spend('openai', 5)]);
    const at = await up(['--dry-run'], world());
    expect(at.out).toContain('would refuse: openai spend 5.00 USD, at or below its 5.00 USD floor');

    storeSpend([spend('openai', 5.0001)]);
    const above = await up([], world());
    expect(above.code).toBe(0);
    expect(above.labels).toEqual([TITLE, 'worker']);
    expect(above.out).not.toContain('refused');
  });

  test('a floor with more decimals prints as the file wrote it', async () => {
    approve(SPEND.replace('floor: 5 USD', 'floor: 5.2534 USD'));
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 4.2)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain('would refuse: openai spend 4.20 USD, at or below its 5.2534 USD floor');
  });

  test('another currency than the floor\'s reads unknown, and the seat still starts', async () => {
    storeSpend([spend('openai', 4.2, now, { currency: 'EUR' })]);
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.err).toContain('worker: openai is unknown\n');
    expect(live.labels).toEqual([TITLE, 'worker']);
  });

  test('no reading at all reads unknown', async () => {
    const dry = await up(['--dry-run'], world());
    expect(dry.out).not.toContain('would refuse');
    expect(dry.out).toContain('openai is unknown; would launch');
  });

  test('a stale reading reads unknown, per § 5 — it never refuses', async () => {
    storeSpend([spend('openai', 4.2, now - 31 * 60_000)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).not.toContain('would refuse');
    expect(dry.out).toContain('openai is unknown; would launch');
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.labels).toEqual([TITLE, 'worker']);
  });

  test('add refuses the same seat before launching it', async () => {
    store([reading('anthropic', 80)]);
    storeSpend([spend('openai', 4.2, now - 3 * 60_000)]);
    const refused = await add(['worker'], world());
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`team add: ${SPEND_WHY}\n`);
    expect(refused.labels).toEqual([]);

    const dry = await add(['worker', '--dry-run'], world());
    expect(dry.code).toBe(1);
    expect(dry.out).toContain(`worker: would refuse: ${SPEND_TAIL}\n`);
    expect(dry.labels).toEqual([]);
  });

  test('the gate counts the reading by the in-force floor, currency and age', () => {
    const worker = seatOf('worker');
    const budgets = loadedTeam().budgets;
    const anthropic = reading('anthropic', 80);
    expect(seatBudget(budgets, [anthropic], worker, now, [spend('openai', 4.2, now - 3 * 60_000)]))
      .toEqual({ kind: 'refuse', why: SPEND_TAIL });
    expect(seatBudget(budgets, [], worker, now, [spend('openai', 4.2)]))
      .toEqual({ kind: 'refuse', why: 'openai spend 4.20 USD, at or below its 5.00 USD floor, read 0m ago; accounts with room: none' });
    expect(seatBudget(budgets, [anthropic], worker, now, [spend('openai', 8)])).toEqual({ kind: 'clear' });
    expect(seatBudget(budgets, [anthropic], worker, now, [spend('openai', 4.2, now, { currency: 'EUR' })]))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    expect(seatBudget(budgets, [anthropic], worker, now, [spend('openai', 4.2, now - 31 * 60_000)]))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    expect(seatBudget(budgets, [anthropic], worker, now, [spend('other', 4.2)]))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
  });

  test('a spend account with room is named, and one stale or in another currency is not', () => {
    const budgets = loadedTeam().budgets;
    const anthropic = reading('anthropic', 80);
    expect(accountsWithRoom(budgets, [anthropic], now, [spend('openai', 8)])).toEqual(['anthropic', 'openai']);
    expect(accountsWithRoom(budgets, [anthropic], now, [spend('openai', 5)])).toEqual(['anthropic']);
    expect(accountsWithRoom(budgets, [anthropic], now, [spend('openai', 8, now, { currency: 'EUR' })])).toEqual(['anthropic']);
    expect(accountsWithRoom(budgets, [anthropic], now, [spend('openai', 8, now - 31 * 60_000)])).toEqual(['anthropic']);
  });
});

describe('a subscription check reading refuses one seat', () => {
  beforeEach(() => approve(CHECK));

  test('a fresh one inside the reserve refuses up and add after the watch exited', async () => {
    // The check is the only real figure: the pane's own screen shows plenty (up's pane width cuts
    // Codex's line), and no watch runs — the state is all that is left of it.
    store([reading('anthropic', 80), reading('openai', 80), checkReading('openai', 5)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(`  skip worker: would refuse: ${CHECK_TAIL}\n`);
    expect(dry.out).not.toContain('<pane of worker>');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain(`worker: left out: ${CHECK_WHY}\n`);
    expect(live.out).toContain('lead: ready\n');
    expect(live.labels).toEqual([TITLE]);

    const refused = await add(['worker'], world());
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`team add: ${CHECK_WHY}\n`);
    expect(refused.labels).toEqual([]);
  });

  test('a fresh one with room clears the account even while the status line shows it inside', async () => {
    store([reading('anthropic', 80), reading('openai', 4), checkReading('openai', 80)]);
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.labels).toEqual([TITLE, 'worker']);
    expect(live.out).not.toContain('refused');
    expect(live.out).not.toContain('is unknown');
  });

  test('a stale one with room reads unknown; a status line below it is still read, and rule 4 still refuses', async () => {
    const old = { changedAt: now - 31 * 60_000 };
    // With room on the account, a stale check counts for nothing: § 3 falls through to the next
    // source, and with nothing below it the account reads unknown.
    store([reading('anthropic', 80), checkReading('openai', 50, old)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).not.toContain('would refuse');
    expect(dry.out).toContain('openai is unknown; would launch');
    const live = await up([], world());
    expect(live.code).toBe(0);
    expect(live.labels).toEqual([TITLE, 'worker']);

    // § 3: a lower source is used when the higher one is stale — the screen's own figure decides.
    store([reading('anthropic', 80), checkReading('openai', 50, old), reading('openai', 4)]);
    const onScreen = await up(['--dry-run'], world());
    expect(onScreen.out).toContain('openai weekly left 4%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic');

    // And a stale screen below it inside the reserve keeps refusing until its known reset (rule 4).
    store([reading('anthropic', 80), checkReading('openai', 50, old), reading('openai', 4, old)]);
    const refused = await up(['--dry-run'], world());
    expect(refused.out).toContain('openai weekly left 4%, inside its 10% reserve, changed 31m ago; accounts with room: anthropic');
  });

  test('a stale check reading inside its reserve keeps refusing until its reset', async () => {
    // Rule 4 is about the reserve, not the source: a check figure measured 31 minutes ago, 5%
    // left inside the 10% reserve and its reset 100 h ahead must keep refusing after the watch
    // has exited, exactly as the same figure from a status line does.
    const old = { changedAt: now - 31 * 60_000, resetsAt: now + 100 * 3_600_000 };
    store([reading('anthropic', 80), checkReading('openai', 5, old)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain('  skip worker: would refuse: openai weekly left 5%, inside its 10% reserve, read 31m ago; accounts with room: anthropic\n');
    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain('worker: left out: refused: openai weekly left 5%, inside its 10% reserve, read 31m ago; accounts with room: anthropic\n');
    expect(live.labels).toEqual([TITLE]);

    // A fresh lower source still wins: the status line's own figure clears the account.
    store([reading('anthropic', 80), checkReading('openai', 5, old), reading('openai', 50)]);
    const cleared = await up([], world());
    expect(cleared.code).toBe(0);
    expect(cleared.out).not.toContain('refused');
    expect(cleared.labels).toEqual([TITLE, 'worker']);
  });

  test('an account whose sources do not name the check never reads one', async () => {
    approve(BASE);
    store([reading('anthropic', 80), checkReading('openai', 5)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).not.toContain('would refuse');
    expect(dry.out).toContain('openai is unknown; would launch');

    approve(CHECK_ONLY);
    store([reading('anthropic', 80), reading('openai', 4)]);
    const only = await up(['--dry-run'], world());
    expect(only.out).not.toContain('would refuse');
    expect(only.out).toContain('openai is unknown; would launch');
  });

  test('the gate counts a check reading by § 5: its own time, its reset, the in-force reserve', () => {
    const loaded = loadTeamFile(root);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker');
    if (!worker) throw new Error('worker');
    const budgets = loaded.team.budgets;
    expect(seatBudget(budgets, [checkReading('openai', 5)], worker, now))
      .toEqual({ kind: 'refuse', why: 'openai weekly left 5%, inside its 10% reserve, read 3m ago; accounts with room: none' });
    expect(seatBudget(budgets, [checkReading('openai', 50)], worker, now)).toEqual({ kind: 'clear' });
    // Stale, inside its reserve and its reset ahead: rule 4 keeps the refusal.
    expect(seatBudget(budgets, [checkReading('openai', 5, { changedAt: now - 31 * 60_000 })], worker, now))
      .toEqual({ kind: 'refuse', why: 'openai weekly left 5%, inside its 10% reserve, read 31m ago; accounts with room: none' });
    // Rule 4 needs a known reset: with none, the stale figure reads unknown.
    expect(seatBudget(budgets, [checkReading('openai', 5, { changedAt: now - 31 * 60_000, resetsAt: null })], worker, now))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    // § 5 measures from the reading's own `at`: a figure measured long ago is stale, however fresh
    // the run that fetched it. Outside the reserve its reset ahead drops it to unknown.
    expect(seatBudget(budgets, [checkReading('openai', 50, { changedAt: now - 40 * 60_000, resetsAt: now + 3_600_000 })], worker, now))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
    // A reset that has passed drops it: it is not a reading at all.
    expect(seatBudget(budgets, [checkReading('openai', 5, { resetsAt: now - 1 })], worker, now))
      .toEqual({ kind: 'unknown', account: 'openai', text: 'openai is unknown' });
  });
});

describe('the source fallback is per window', () => {
  // § 3: a check that filled one window does not answer for a window it never reported. The
  // status line below it in `sources` counts for that window — and its figure can refuse.
  const budgets = {
    staleAfter: 30 * 60,
    checkEvery: 600,
    marks: [50, 75, 90],
    accounts: {
      openai: { kind: 'subscription', shared: false, reserve: 20, floor: null, sources: ['check', 'status_line'], check: 'openai-usage' },
    },
  } as unknown as TeamFile['budgets'];
  const worker = { name: 'worker', vendor: 'openai' } as Seat;

  test('a session-only check leaves the status line\'s weekly figure to refuse', () => {
    const list = [checkReading('openai', 80, { window: 'session' }), reading('openai', 5)];
    expect(seatBudget(budgets, list, worker, now)).toEqual({
      kind: 'refuse',
      why: 'openai weekly left 5%, inside its 20% reserve, changed 1m ago; accounts with room: none',
    });
  });

  test('the check still answers for the window it did fill', () => {
    const list = [checkReading('openai', 5, { window: 'session' }), reading('openai', 80)];
    expect(seatBudget(budgets, list, worker, now)).toEqual({
      kind: 'refuse',
      why: 'openai session left 5%, inside its 20% reserve, read 3m ago; accounts with room: none',
    });
  });
});

describe('team add', () => {
  test('refuses the seat before launching it, and --dry-run shows that', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    const refused = await add(['worker'], world());
    expect(refused.code).toBe(1);
    expect(refused.err).toBe(`team add: ${WHY}\n`);
    expect(refused.labels).toEqual([]);

    const dry = await add(['worker', '--dry-run'], world());
    expect(dry.code).toBe(1);
    expect(dry.out).toContain(`worker: would refuse: ${TAIL}\n`);
    expect(dry.out).toContain('dry run: nothing was run\n');
    expect(dry.labels).toEqual([]);
  });
});

// RFC 0003 § 3b: one vendor's two accounts are two buckets. The seat names its account with
// `account:`, defaulting to its vendor, so a reading on one account refuses only the seats on it.
const TWO = `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
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
    mode: shared
  - role: implementer
    name: work
    label: work
    cli: claude-code
    vendor: openai
    account: openai-work
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
  - role: implementer
    name: home
    label: home
    cli: claude-code
    vendor: openai
    account: openai-home
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    mode: shared
budgets:
  accounts:
    anthropic: { kind: subscription, reserve: 20%, sources: [status_line] }
    openai-work: { kind: subscription, reserve: 10%, sources: [status_line] }
    openai-home: { kind: subscription, reserve: 10%, sources: [status_line] }
`;

describe('two accounts on one vendor', () => {
  beforeEach(() => approve(TWO));

  test('a reading inside one account refuses only the seats that spend it', async () => {
    store([reading('anthropic', 80), reading('openai-work', 5), reading('openai-home', 80)]);
    const dry = await up(['--dry-run'], world());
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('  skip work: would refuse: openai-work weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic, openai-home\n');
    expect(dry.out).toContain('<pane of home>');
    expect(dry.out).not.toContain('<pane of work>');
    expect(dry.labels).toEqual([]);

    const live = await up([], world());
    expect(live.code).toBe(1);
    expect(live.out).toContain('work: left out: refused: openai-work weekly left 5%, inside its 10% reserve, changed 1m ago; accounts with room: anthropic, openai-home\n');
    expect(live.out).toContain('lead: ready\n');
    expect(live.out).toContain('home: ready\n');
    expect(live.labels).toEqual([TITLE, 'home']);
  });
});

describe('an unapproved edit to the budgets', () => {
  // A reserve the file lowers on its own: valid, and weaker than the approved one. If it were
  // read before approval, the same reading would unblock the launch it now refuses.
  const WEAKER = BASE.replace('reserve: 10%', 'reserve: 1%');

  test('up: unblocks nothing until the owner approves it', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    writeTeamYaml(WEAKER);
    const dry = await up(['--dry-run'], world());
    expect(dry.out).toContain(`skip worker: would refuse: ${TAIL}`);
    expect(dry.out).not.toContain('not the approved one');
    expect(dry.out).not.toContain('team approve');
    const refused = await up([], world());
    expect(refused.code).toBe(1);
    expect(refused.labels).toEqual([]);
    // The owner approves the reserve the file now sets: the same reading no longer refuses.
    approve(WEAKER);
    const after = await up([], world());
    expect(after.code).toBe(0);
    expect(after.labels).toEqual([TITLE, 'worker']);
    expect(after.out).not.toContain('would refuse');
  });

  test('add: launches nothing until the owner approves it', async () => {
    store([reading('anthropic', 80), reading('openai', 5)]);
    writeTeamYaml(WEAKER);
    const before = await add(['worker'], world());
    expect(before.err).not.toContain('not the approved one');
    expect(before.err).not.toContain('team approve');
    expect(before.labels).toEqual([]);
    approve(WEAKER);
    const after = await add(['worker'], world());
    expect(after.code).toBe(0);
    expect(after.labels).toEqual(['worker']);
  });
});
