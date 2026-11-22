// A seat that cannot work is named at once. The detector returns ok, or one reason:
// 'no CLI', 'model failing', 'out of tokens', 'wake not taken'. Out of tokens is an
// injected observation until the token state is merged. A reason prints
// `not delivered: <reason>`. The lead hears that once per episode, within three minutes.
// No CLI is restarted from its record, the same path as `team restart <seat>`: resumed,
// never --abandon, and the restart is audited. A wake counts as delivered only when the
// screen shows the text submitted and the seat working, or the drop's read receipt is
// there. Anything else is `not delivered: wake not taken`, and the watch retries.
// Screens, homes and pane names are synthetic. No CLI is started.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { daemonLockPath } from '../src/daemon/paths.ts';
import { writeDaemonState } from '../src/daemon/state.ts';
import { runSend } from '../src/commands/send.ts';
import { runWatch } from '../src/commands/watch.ts';
import type { EventAppendInput } from '../src/bus/log.ts';
import { emptySession, updateState } from '../src/state.ts';
import { forgetIdleEpisodes } from '../src/watch/dispatch.ts';
import { unreadMachine } from '../src/watch/machine.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Live } from '../src/status/compare.ts';
import { receiptPath } from '../src/mcp/inbox.ts';
import { dropMessage } from '../src/send/native.ts';
import { readHistory } from '../src/send/history.ts';
import { signRecord } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { claudeBox } from './helpers.ts';
import { withHostedLoop } from './helpers/hosted-watch.ts';
import { withoutSendId } from './helpers/output.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';
import { seatCanWork, SEAT_WORK_REPORT_MS, type SeatWorkInput } from '../src/watch/seat-can-work.ts';
import { readScreen } from '../src/watch/screen.ts';
import { wakePath, wakeTryPath, wakeUnreadDrops } from '../src/watch/unread.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const CURSOR_FIXTURES = join(import.meta.dir, 'fixtures', 'cursor', '2026.10.22');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const CURSOR_IDLE = readFileSync(join(CURSOR_FIXTURES, 'idle.txt'), 'utf8');
const LOST = `API Error: Connection lost mid-response. The response above may be incomplete.\n${claudeBox('')}`;
const CLAUDE_IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'claude-code', '2.1.319', 'idle.txt'), 'utf8');
const THREE_MINUTES = 3 * 60 * 1000;

const OWN = { shell: 11, foreground: [22] };
const RECORDED = { shell: 11, cli: [22] };
const GONE = { shell: 11, foreground: [11] };

function ask(input: Partial<SeatWorkInput> & Pick<SeatWorkInput, 'cli' | 'screen'>): ReturnType<typeof seatCanWork> {
  return seatCanWork({
    seat: 'maker',
    recorded: RECORDED,
    processes: OWN,
    ...input,
  });
}

test('a pane whose CLI is gone is restarted from its record, once, and the lead is told', () => {
  expect(SEAT_WORK_REPORT_MS).toBe(THREE_MINUTES);
  const first = ask({ cli: 'antigravity', screen: IDLE, processes: GONE, elapsedMs: 0 });
  expect(first).toMatchObject({
    ok: false,
    reason: 'no CLI',
    line: 'not delivered: no CLI',
    tellLead: true,
    retry: false,
  });
  if (first.ok) return;
  expect(first.restart).toEqual({
    argv: ['maker'],
    resumed: true,
    audit: expect.stringContaining('maker'),
  });
  const argv = first.restart?.argv.join(' ') ?? '';
  expect(argv.includes('--abandon')).toBe(false);
  expect(argv.includes('--fresh')).toBe(false);
  expect(first.restart?.audit.includes('restart')).toBe(true);
  expect(first.restart?.audit.includes('--abandon')).toBe(false);
  const again = ask({ cli: 'antigravity', screen: IDLE, processes: GONE, told: true, elapsedMs: 1_000 });
  expect(again).toMatchObject({ ok: false, reason: 'no CLI', tellLead: false, retry: false });
  if (!again.ok) expect(again.restart).toBeUndefined();
  const late = ask({ cli: 'antigravity', screen: IDLE, processes: GONE, elapsedMs: THREE_MINUTES });
  expect(late).toMatchObject({ ok: false, reason: 'no CLI', tellLead: true });
  const missed = ask({ cli: 'antigravity', screen: IDLE, processes: GONE, elapsedMs: THREE_MINUTES + 1 });
  expect(missed).toMatchObject({ ok: false, reason: 'no CLI', tellLead: false });
  if (!missed.ok) {
    expect(missed.restart?.argv).toEqual(['maker']);
    expect(missed.restart?.argv.join(' ').includes('--abandon')).toBe(false);
  }
});

test('a provider-error screen is model failing, and the lead is told at once', () => {
  expect(readScreen('claude-code', LOST).kind).toBe('provider error');
  const found = ask({ cli: 'claude-code', screen: LOST });
  expect(found).toMatchObject({
    ok: false,
    reason: 'model failing',
    line: 'not delivered: model failing',
    tellLead: true,
    retry: false,
  });
  if (!found.ok) expect(found.restart).toBeUndefined();
});

test('an injected out-of-tokens observation is out of tokens, and nothing is restarted', () => {
  const found = ask({
    cli: 'antigravity',
    screen: IDLE,
    tokens: { reason: 'out of tokens' },
  });
  expect(found).toMatchObject({
    ok: false,
    reason: 'out of tokens',
    line: 'not delivered: out of tokens',
    tellLead: true,
    retry: false,
  });
  if (!found.ok) expect(found.restart).toBeUndefined();
  const idle = ask({ cli: 'antigravity', screen: IDLE });
  expect(idle).toEqual({ ok: true });
});

test('an antigravity idle screen after a wake that never submitted is wake not taken', () => {
  expect(readScreen('antigravity', IDLE).kind).toBe('idle');
  const found = ask({
    cli: 'antigravity',
    screen: IDLE,
    wake: { submitted: false, working: false, receipt: false },
  });
  expect(found).toMatchObject({
    ok: false,
    reason: 'wake not taken',
    line: 'not delivered: wake not taken',
    tellLead: true,
    retry: true,
  });
  if (!found.ok) expect(found.restart).toBeUndefined();
  const submittedOnly = ask({
    cli: 'antigravity',
    screen: IDLE,
    wake: { submitted: true, working: false, receipt: false },
  });
  expect(submittedOnly).toMatchObject({ ok: false, reason: 'wake not taken', retry: true });
});

test('a wake the screen confirms, or a drop receipt, means the seat can work', () => {
  expect(readScreen('antigravity', WORKING).kind).toBe('working');
  const confirmed = ask({
    cli: 'antigravity',
    screen: WORKING,
    wake: { submitted: true, working: true, receipt: false },
  });
  expect(confirmed).toEqual({ ok: true });
  const receipt = ask({
    cli: 'antigravity',
    screen: IDLE,
    wake: { submitted: false, working: false, receipt: true },
  });
  expect(receipt).toEqual({ ok: true });
});

function wakeHost(screen: (prompts: number) => string): { host: TypedWakeHost; prompts: string[] } {
  const prompts: string[] = [];
  let prompted = 0;
  const host: TypedWakeHost = {
    read: () => screen(prompted),
    type: () => true,
    enter: () => true,
    prompt: (_pane, line) => {
      prompts.push(line);
      prompted += 1;
      return true;
    },
    wait: async () => {},
  };
  return { host, prompts };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test('a wake confirmed on the antigravity working screen is delivered', async () => {
  const made = world(null, [{ name: 'maker', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
  cleanups.push(made.cleanup);
  const pane = wakeHost((prompts) => (prompts > 0 ? WORKING : IDLE));
  const host = fake(made, {
    agents: () => [{ name: 'maker', pane: 'pane-maker' }],
    processInfo: () => OWN,
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  const code = await runSend(['maker', 'hello'], io, host);
  expect(code, io.err + io.out).toBe(0);
  expect(withoutSendId(io.err + io.out)).toContain('maker: delivered (typed wake)');
  expect(io.err + io.out).not.toContain('not delivered');
  expect(pane.prompts).toHaveLength(1);
  const drops = join(made.dir, 'send-drops', 'acme', 'maker');
  expect(readdirSync(drops).filter((name) => !name.includes('.'))).toHaveLength(1);
});

test('an antigravity screen that stays idle reports wake not taken and types nothing more', async () => {
  const made = world(null, [{ name: 'maker', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
  cleanups.push(made.cleanup);
  const pane = wakeHost(() => IDLE);
  const host = fake(made, {
    agents: () => [{ name: 'maker', pane: 'pane-maker' }],
    processInfo: () => OWN,
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  const code = await runSend(['maker', 'hello'], io, host);
  expect(io.err + io.out, `exit ${code}`).toContain('not delivered: wake not taken');
  expect(io.err + io.out).not.toContain('delivered (typed wake)');
  expect(pane.prompts.length).toBeLessThanOrEqual(1);
});

test('a reason found before the send is printed at once and the pane is not prompted', async () => {
  const bare = world(null, [{ name: 'maker', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
  cleanups.push(bare.cleanup);
  const quiet = wakeHost(() => IDLE);
  const shell = fake(bare, {
    agents: () => [{ name: 'maker', pane: 'pane-maker' }],
    processInfo: () => GONE,
    typedWake: () => quiet.host,
  });
  const refused = owner(bare.root);
  const stopped = await runSend(['maker', 'hello'], refused, shell);
  expect(stopped, refused.err + refused.out).toBe(1);
  expect(refused.err + refused.out).toContain('not delivered: no CLI');
  expect(refused.err + refused.out).toContain('kept');
  expect(quiet.prompts).toEqual([]);
  dropKept(bare, 'maker', 'hello');
});

/** The captured empty prompt for the whole wake. Reads taken after the wake line was issued are
 *  kept, so a scene can show the pane never left that prompt. */
function emptyPrompt(screen: string): { host: TypedWakeHost; typed: string[]; prompts: string[]; enters: number; after: string[] } {
  const typed: string[] = [];
  const prompts: string[] = [];
  const after: string[] = [];
  let enters = 0;
  let issued = 0;
  const host: TypedWakeHost = {
    read: () => {
      if (issued > 0) after.push(screen);
      return screen;
    },
    type: (_pane, text) => {
      typed.push(text);
      issued += 1;
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    prompt: (_pane, line) => {
      prompts.push(line);
      issued += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    prompts,
    after,
    get enters() {
      return enters;
    },
  };
}

/** The signed drop is still the seat's to read: one live record, and no read receipt. */
function dropKept(made: World, seat: string, body: string): void {
  const drops = join(made.dir, 'send-drops', 'acme', seat);
  const ids = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(ids).toHaveLength(1);
  const id = ids[0] as string;
  expect(existsSync(receiptPath(drops, id))).toBe(false);
  expect(readFileSync(join(drops, id), 'utf8')).toContain(body);
}

test('an antigravity empty prompt after the wake line is not delivered and the drop stays', async () => {
  expect(readScreen('antigravity', IDLE).kind).toBe('idle');
  const made = world(null, [{ name: 'maker', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
  cleanups.push(made.cleanup);
  const pane = emptyPrompt(IDLE);
  const host = fake(made, {
    agents: () => [{ name: 'maker', pane: 'pane-maker' }],
    processInfo: () => OWN,
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  const code = await runSend(['maker', 'hello'], io, host);
  expect(code, io.err + io.out).toBe(1);
  expect(io.err + io.out).toContain('maker: not delivered: wake not taken');
  expect(io.err + io.out).not.toContain('delivered (typed wake)');
  expect(io.err + io.out).not.toContain('handed to the daemon');
  expect(pane.prompts).toHaveLength(1);
  expect(pane.after.length).toBeGreaterThan(0);
  expect(pane.after.every((frame) => frame === IDLE)).toBe(true);
  dropKept(made, 'maker', 'hello');
});

test('a cursor empty prompt after the wake line is not delivered and the drop stays', async () => {
  expect(readScreen('cursor', CURSOR_IDLE).kind).toBe('idle');
  const made = world(null, [{ name: 'maker', role: 'implementer', cli: 'cursor', launch: 'cursor-agent' }]);
  cleanups.push(made.cleanup);
  const pane = emptyPrompt(CURSOR_IDLE);
  const host = fake(made, {
    agents: () => [{ name: 'maker', pane: 'pane-maker' }],
    processInfo: () => OWN,
    typedWake: () => pane.host,
  });
  const io = owner(made.root);
  const code = await runSend(['maker', 'hello'], io, host);
  expect(code, io.err + io.out).toBe(1);
  expect(io.err + io.out).toContain('maker: not delivered: wake not taken');
  expect(io.err + io.out).not.toContain('delivered (typed wake)');
  expect(io.err + io.out).not.toContain('handed to the daemon');
  expect(pane.typed).toHaveLength(1);
  expect(pane.enters).toBe(0);
  expect(pane.after.length).toBeGreaterThan(0);
  expect(pane.after.every((frame) => frame === CURSOR_IDLE)).toBe(true);
  dropKept(made, 'maker', 'hello');
});

const RETRY_AT = new Date('2026-11-08T12:00:00.000Z');
const RETRY_ID = 'e0b7ee00-1111-4000-8000-0000000000b1';
const BACKOFF_MS = 5_000;

/** One watch wake. The first stays on the empty prompt. A later one shows the working screen
 *  only after the wake line, which is what confirms it. */
function retryHost(idle: string, working: string, take: number): TypedWakeHost {
  let issued = 0;
  return {
    read: () => (take > 1 && issued > 0 ? working : idle),
    type: () => {
      issued += 1;
      return true;
    },
    enter: () => true,
    prompt: () => {
      issued += 1;
      return true;
    },
    wait: async () => {},
  };
}

test('a wake the empty prompt did not take is retried once and the confirmed one is delivered once', async () => {
  expect(readScreen('antigravity', WORKING).kind).toBe('working');
  const made = world(null, [{ name: 'maker', role: 'implementer', cli: 'antigravity', launch: 'agy' }]);
  cleanups.push(made.cleanup);
  const checked = validateTeamFile(readFileSync(join(made.root, '.agents', 'team.yaml'), 'utf8'));
  if (!checked.ok) throw new Error('the fixture team did not load');
  const landed = new Date(RETRY_AT.getTime() - 11 * 60 * 1000);
  const record = signRecord({
    kind: 'message',
    id: RETRY_ID,
    to: 'maker',
    to_id: null,
    root: made.root,
    session: 'acme',
    at: landed.toISOString(),
    body: 'the brief waits',
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: RETRY_ID,
  }, made.home);
  const dropDir = join(made.dir, 'send-drops', 'acme', 'maker');
  dropMessage(dropDir, RETRY_ID, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, RETRY_ID), new Date(), landed);
  const live: Live = {
    running: true,
    agents: [{ name: 'maker', agent: 'agy', pane: 'pane-maker', workspace: 'maker', status: 'idle', cwd: null }],
    workspaces: [],
    screens: {},
  };
  let calls = 0;
  const said: string[] = [];
  const scene = (now: Date) => ({
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: checked.team,
    live,
    ownPane: null,
    now,
    say: (text: string) => said.push(text),
    sources: {
      screen: () => IDLE,
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: async (pane: string, line: string, cli: string) => {
        calls += 1;
        return deliverTypedWake(retryHost(IDLE, WORKING, calls), pane, line, cli, {
          settleMs: 0,
          enterSettleMs: 0,
          pollMs: 1,
          ackSettleMs: 0,
          verifyMs: 1,
        });
      },
    },
  });
  const delivered = (): number => {
    const history = readHistory('acme', made.root, made.home);
    if (!history.ok) return 0;
    return history.entries.filter((entry) => entry.id === RETRY_ID && entry.outcome === 'delivered (typed wake)').length;
  };

  await wakeUnreadDrops(scene(RETRY_AT), { unreadAfter: 600 });
  expect(calls).toBe(1);
  expect(existsSync(join(dropDir, RETRY_ID))).toBe(true);
  expect(existsSync(receiptPath(dropDir, RETRY_ID))).toBe(false);
  expect(existsSync(wakePath(dropDir, RETRY_ID))).toBe(false);
  expect(delivered()).toBe(0);
  const ledger = JSON.parse(readFileSync(wakeTryPath(dropDir, RETRY_ID), 'utf8')) as { tries: number };
  expect(ledger.tries).toBe(1);

  await wakeUnreadDrops(scene(new Date(RETRY_AT.getTime() + BACKOFF_MS)), { unreadAfter: 600 });
  expect(calls).toBe(2);
  expect(delivered()).toBe(1);
  expect(said.filter((line) => line.includes('delivered'))).toHaveLength(1);

  await wakeUnreadDrops(scene(new Date(RETRY_AT.getTime() + 60_000)), { unreadAfter: 600 });
  expect(calls).toBe(2);
  expect(delivered()).toBe(1);
  expect(said.filter((line) => line.includes('delivered'))).toHaveLength(1);
});

test('a dispatcher-owned blocked seat is reported once, and a seat it does not own still reports it cannot work', async () => {
  const when = new Date('2026-11-08T12:00:00.000Z');
  const since = new Date(when.getTime() - 10 * 60 * 1000).toISOString();
  const made = world(null, [
    {
      name: 'pebble',
      role: 'implementer',
      cli: 'claude-code',
      launch: 'claude --dangerously-load-development-channels server:team-inbox',
    },
    { name: 'cobble', role: 'implementer', cli: 'claude-code', launch: 'claude' },
  ]);
  cleanups.push(made.cleanup);
  const teamPath = join(made.root, '.agents', 'team.yaml');
  writeFileSync(teamPath, `${readFileSync(teamPath, 'utf8')}tasks:\n  source: file\n  path: .agents/queue.yaml\n  pull: self\n`);
  writeFileSync(join(made.dir, 'queue.yaml'), '- id: task-pebble\n  title: "One task"\n  assignee: pebble\n');
  updateState(made.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.pebble = {
      stage: 'ready',
      cli: 'claude-code',
      pane: 'pane-pebble',
      last_active: since,
      launched: { shell: 11, cli: [22] },
    };
    session.seats.cobble = {
      stage: 'ready',
      cli: 'claude-code',
      pane: 'pane-cobble',
      last_active: since,
      launched: { shell: 31, cli: [32] },
    };
  });
  const live: Live = {
    running: true,
    agents: [
      { name: 'pebble', agent: 'claude', pane: 'pane-pebble', workspace: 'pebble', status: 'idle', cwd: made.root },
      { name: 'cobble', agent: 'claude', pane: 'pane-cobble', workspace: 'cobble', status: 'idle', cwd: made.root },
    ],
    workspaces: [],
    screens: { 'pane-pebble': CLAUDE_IDLE, 'pane-cobble': LOST },
    processes: {
      'pane-pebble': { shell: 11, foreground: [11] },
      'pane-cobble': { shell: 31, foreground: [32] },
    },
    foreground: {
      'pane-pebble': ['zsh'],
      'pane-cobble': ['claude'],
    },
  };
  const events: EventAppendInput[] = [];
  forgetIdleEpisodes();
  writeDaemonState(made.home, {
    format: 1,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: when.toISOString(),
    startedBy: 'manual',
    version: 'test',
    heartbeatAt: when.toISOString(),
    socket: join(made.home, 'daemon.sock'),
    features: { broker: 'absent' },
    stuck: [],
    roots: [{ root: made.root, team: 'acme', send: 'serving', bus: 'serving', why: null }],
  });
  mkdirSync(dirname(daemonLockPath(made.home)), { recursive: true });
  writeFileSync(daemonLockPath(made.home), `${String(process.pid)}\n`);
  const io = owner(made.root);
  const code = await runWatch([], io, withHostedLoop({
    live: () => live,
    machine: () => unreadMachine(),
    standing: () => ({ kind: 'none' }),
    readChecks: () => [],
    screen: () => null,
    status: () => null,
    foreground: () => null,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    notify: () => {},
    now: () => when,
    wait: async () => false,
    alive: () => false,
    pid: 1,
    home: made.home,
    pushWork: async () => ({ ok: false, refused: 'the route refused' }),
    busPublish: async (_root, event) => {
      events.push(event);
      return { kind: 'unavailable' };
    },
  }));
  forgetIdleEpisodes();
  expect(code, `${io.out}\n${io.err}`).toBe(0);

  const folder = join(made.dir, 'messages', 'lead');
  const names = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json') && !name.endsWith('.read.json')) : [];
  const owned = names.filter((name) => name.startsWith('evt-work-push-lead-pebble-'));
  expect(owned).toHaveLength(1);
  expect(readFileSync(join(folder, owned[0] as string), 'utf8')).toContain('pebble is idle with takeable work but was not told directly');
  expect(names.some((name) => name.startsWith('evt-cant-work-pebble-'))).toBe(false);
  expect(io.out).not.toContain('pebble: can\'t work');
  expect(events.some((event) => event.record_id.startsWith('watch:cant-work:pebble'))).toBe(false);

  expect(io.out).toContain('cobble: can\'t work: model failing');
  expect(events).toHaveLength(0);
  const leadDrops = join(made.dir, 'send-drops', 'acme', 'lead');
  const noticeNames = existsSync(leadDrops)
    ? readdirSync(leadDrops).filter((name) => name.startsWith('blocked-episode-') && !name.includes('.'))
    : [];
  expect(noticeNames).toHaveLength(1);
  expect(readFileSync(join(leadDrops, noticeNames[0] as string), 'utf8')).toContain('cobble: can\'t work: model failing');
  expect(noticeNames.some((name) => name.startsWith('blocked-episode-pebble-'))).toBe(false);
  expect(names.some((name) => name.startsWith('evt-cant-work-cobble-'))).toBe(false);
});
