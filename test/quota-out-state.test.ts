// Quota-out: the CLI's own usage wall as its own state. The reset is printed exactly as the
// screen words it (`at` a clock, `in` a span), the classifier reads the wall only where the CLI
// draws it (the block directly above the composer, per the captures and the reported frames),
// and a send keeps its signed note for a walled seat without a socket frame or a typed key.
// Frames: the retained captures for Claude Code and Gemini, a synthetic one derived from a
// reported Antigravity screen (no capture exists), and synthetic Codex frames built from the
// wording in Codex's own upstream source at the tested tags. No provider turn, no real pane.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { quotaOf, quotaText, type QuotaObservation } from '../src/information/quota.ts';
import { statusQuota } from '../src/information/quota-observe.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { requestDaemon, startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { storePath } from '../src/store/store.ts';
import {
  heldWork,
  outOfTokensState,
  tokenLeadLine,
  tokenSwapHook,
  tokenUnavailable,
  tokenWarnLine,
  weeklyBelowWarning,
} from '../src/quota/token-fallback.ts';
import type { CheckContext, Report, SeatObservation } from '../src/watch/check.ts';
import { outOfTokens } from '../src/watch/checks/out-of-tokens.ts';
import { readScreen } from '../src/watch/screen.ts';
import { claudeBox, testIo } from './helpers.ts';

const NOW_DATE = new Date('2026-10-22T08:00:00.000Z');
const NOW = NOW_DATE.getTime();
const RULE50 = '─'.repeat(50);

const capture = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// --- the classifier -------------------------------------------------------------------------

describe('a usage wall is the block the CLI draws above its composer', () => {
  test('the captured Claude Code frame keeps its reset, typed as the phrase words it', () => {
    expect(readScreen('claude-code', capture('./fixtures/claude-code/rate-limit.txt')))
      .toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } });
  });

  test('a quote inside a turn, with later text after it, is not the wall', () => {
    const quoted = [
      '● The handover note quotes the dialog it saw:',
      '  API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00',
      '  I answered it before the tests ran, so this is the box after.',
      '',
      claudeBox(''),
    ].join('\n');
    expect(readScreen('claude-code', quoted).kind).not.toBe('rate limit');
  });

  test('a quote a completed turn ended is history, not the live wall', () => {
    const scrolled = [
      '● Earlier my reply quoted:',
      '  API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00',
      '',
      '✻ Waited for 3s · done 10:58 AM',
      '',
      claudeBox(''),
    ].join('\n');
    expect(readScreen('claude-code', scrolled).kind).not.toBe('rate limit');
  });

  test('a working row between the quote and the box is not the wall either', () => {
    const busyQuote = [
      '  API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00',
      '✶ Transfiguring… (9m 34s · ↓ 64.5k tokens)',
      '',
      claudeBox(''),
    ].join('\n');
    expect(readScreen('claude-code', busyQuote).kind).not.toBe('rate limit');
  });

  test('with no readable composer the wall is read from the whole window, as before', () => {
    // No box in the window: adjacency has nothing to anchor on, and the wall must stay a wall
    // rather than become a free prompt. This is the frame that is already held today.
    const noBox = 'API Error: Request rejected (429)\nUsage limit reached\nYour limit will reset at 11:00\n';
    expect(readScreen('claude-code', noBox))
      .toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '11:00' } });
  });

  const agyIdle = capture('./fixtures/antigravity/1.4.2/idle.txt');
  const agyWith = (rows: string[]): string => {
    const lines = agyIdle.split('\n');
    const at = lines.findIndex((line) => line.startsWith('─'));
    return [...lines.slice(0, at), ...rows, ...lines.slice(at)].join('\n');
  };

  test('the reported Antigravity wall is a two-row block over the box, reset in the screen own words', () => {
    const frame = agyWith(['Individual quota reached', 'Resets in 47h31m']);
    expect(readScreen('antigravity', frame))
      .toEqual({ kind: 'rate limit', reset: { kind: 'in', value: '47h31m' } });
  });

  test('the same wall without a reset row is still quota out, with an explicit unknown', () => {
    expect(readScreen('antigravity', agyWith(['Individual quota reached'])))
      .toEqual({ kind: 'rate limit', reset: null });
  });

  test('an Antigravity sentence quoted with a reply row after it is not the wall', () => {
    const frame = agyWith(['Individual quota reached', 'Resets in 47h31m', '● I answered it and moved on.']);
    expect(readScreen('antigravity', frame).kind).not.toBe('rate limit');
  });

  const codexIdle = capture('./fixtures/codex/0.161.0/idle.txt');
  const codexWith = (row: string): string => {
    const lines = codexIdle.split('\n');
    const at = lines.findIndex((line) => line.startsWith('›'));
    return [...lines.slice(0, at), row, ...lines.slice(at)].join('\n');
  };

  test('the exhausted Codex message from its upstream source is quota out, with its clock', () => {
    const text = 'You’ve hit your usage limit for 5h. Switch to another model now, or try again at 3:05 PM.';
    expect(readScreen('codex', codexWith(text)))
      .toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '3:05 PM' } });
  });

  test('the Codex near-cap warning is not a wall', () => {
    expect(readScreen('codex', capture('./fixtures/codex/0.157.0/idle.txt')).kind).not.toBe('rate limit');
  });

  test('the captured Gemini dialog keeps its reading, reset and all', () => {
    expect(readScreen('gemini', capture('./fixtures/gemini/0.64.0/rate-limit.txt')))
      .toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '2:10 PM GMT+2' } });
  });
});

// --- usage: the wall line, not "at in 47h31m" -------------------------------------------------

test('a wall screen hands the usage view the reset in the screen own phrase', () => {
  const target = { seat: 'lead', account: 'deepseek', cli: 'antigravity' };
  const frame = [
    'Individual quota reached',
    'Resets in 47h31m',
    '',
    RULE50,
    '>',
    RULE50,
    '? for shortcuts',
  ].join('\n');
  const found = statusQuota('antigravity', frame, target, NOW, []);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ wall: true, source: 'quota screen', resetText: 'in 47h31m' });
  const observations: QuotaObservation[] = found;
  const quota = quotaOf({
    labs: [{ lab: 'google', accounts: [{ account: 'deepseek', seats: ['lead'] }] }],
    observations,
    accountsFile: '~/.config/team/accounts.yaml',
    now: NOW,
  });
  expect(quotaText(quota)).toContain('    deepseek  walled  resets in 47h31m  seats: lead');
});

// --- `team send`: no effects on a walled seat -------------------------------------------------

const RULE = '─'.repeat(30);

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: deepseek
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; dir: string; sockets: string; home: string; team: TeamFile } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-quota-out-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

const WALL = `● Done.\n\nAPI Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00\n${claudeBox('')}`;
const IDLE = `● Done.\n\n${claudeBox('')}`;

type PaneHost = SendHost & DaemonHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  frames: string[];
  dials: () => number;
  show: (text: string) => void;
  setStatus: (status: string) => void;
};

/** A sending host whose pane text the scene scripts: a wall, a quote, or an idle box that reads
 *  back the trigger once it is typed. Nothing real is touched: the socket viewer throws before
 *  any dial can succeed, and the count still records it. */
function paneHost(w: { sockets: string; home: string }): PaneHost {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let dials = 0;
  let screen = IDLE;
  let status = 'idle';
  return {
    typed,
    enters,
    frames,
    dials: () => dials,
    show: (text) => { screen = text; },
    setStatus: (word) => { status = word; },
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'helper', pane: 'pane-helper' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (_socketPath: string, frame: string) => {
      dials += 1;
      frames.push(frame);
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        status = 'working';
        return true;
      },
      status: () => status,
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last && !enters.includes(pane)) return `${RULE}\n❯ ${last.text}\n${RULE}`;
        return screen;
      },
    },
    now: () => NOW_DATE,
    home: w.home,
    deliverWaitMs: 50,
    pollReadyMs: 5,
  };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

function expectQueuedMessage(w: { root: string; dir: string; home: string }, body: string): void {
  const drops = join(w.dir, 'send-drops', 'acme', 'lead');
  expect(existsSync(drops)).toBe(true);
  const ids = readdirSync(drops).filter((id) => !id.includes('.'));
  expect(ids).toHaveLength(1);
  const id = ids[0]!;
  expect(existsSync(join(drops, `${id}.read.json`))).toBe(false);
  const history = readHistory('acme', w.root, w.home);
  expect(history.ok).toBe(true);
  if (history.ok) {
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({ to: 'lead', outcome: 'queued, not woken', via: 'drop' });
  }
  const read = readMessage({ root: w.root, dropDir: drops, session: 'acme', seat: 'lead' }, id, w.home);
  expect(read.ok).toBe(true);
  expect(JSON.stringify(read)).toContain(body);
}

describe('a walled seat keeps the note without a wake', () => {
  test('a send keeps a signed note without a socket frame or typed key', async () => {
    const w = world();
    const host = paneHost(w);
    host.show(WALL);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: not delivered: out of tokens');
    expect(io.err).toContain("kept in lead's inbox");
    expect(io.out).toBe('');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(existsSync(join(w.root, '.agents', 'send-drops', 'acme', 'lead'))).toBe(true);
    expectQueuedMessage(w, 'hello');
  });

  test('a host that still says working does not cancel the wall the screen proves', async () => {
    const w = world();
    const host = paneHost(w);
    host.show(WALL);
    host.setStatus('working');
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('lead: not delivered: out of tokens');
    expect(io.err).toContain("kept in lead's inbox");
    expectQueuedMessage(w, 'hello');
    expect(host.typed).toEqual([]);
    expect(host.dials()).toBe(0);
  });

  test('a quote above a live idle box is not the wall: the send walks its legs', async () => {
    const w = world();
    const host = paneHost(w);
    host.show([
      '● The handover note quotes the dialog it saw:',
      '  API Error: Request rejected (429) · Usage limit reached for 5 hour. Your limit will reset at 11:00',
      '  I answered it, so this is the box after.',
      '',
      claudeBox(''),
    ].join('\n'));
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(host.typed.length).toBe(0);
  });

  test('the daemon refuses before the drop file is staged', async () => {
    const w = world();
    const host = paneHost(w);
    host.show(WALL);
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const answer = await requestDaemon(started.handle.socketPath, {
      v: 1,
      op: 'send',
      from: 'owner',
      to: 'lead',
      body: 'hello',
    });

    expect(answer && 'outcome' in answer ? answer.outcome : null).toBe('refused');
    expect(answer && 'detail' in answer ? answer.detail : '').toBe('lead: quota out on deepseek, resets at 11:00; nothing was sent');
    expect(host.typed).toEqual([]);
    const store = storePath(w.team.project, w.root, w.home);
    expect(existsSync(join(store, 'drops'))).toBe(false);
  });
});

const SHIPPED = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok', 'gemini', 'muse', 'jules'] as const;

const LIMIT_TAILS = [
  "There's an issue with the selected model (k3-256k)\n❯ ",
  'Usage limit reached\n❯ ',
  'Request rejected (429)\n❯ ',
  'weekly quota exhausted\n❯ ',
  'weekly limit reached\n❯ ',
  'rate limit\n❯ ',
];

function tokenSeat(dir: string, over: Partial<SeatObservation> = {}): SeatObservation {
  return {
    name: 'alpha',
    running: true,
    working: false,
    vendor: 'kimi',
    role: 'builder',
    agentsDir: dir,
    screen: { kind: 'rate limit', reset: null, reason: 'out of tokens' },
    ...over,
  } as SeatObservation;
}

function onceHarness(): { ctx: CheckContext; finish: () => void } {
  const active = new Set<string>();
  let current = new Set<string>();
  const ctx: CheckContext = {
    now: 1_000,
    watch: {} as CheckContext['watch'],
    budgets: {} as CheckContext['budgets'],
    once(key: string, text: string, to: Report['to'] = 'operator'): Report | null {
      current.add(key);
      return active.has(key) ? null : { key, text, to };
    },
    keep(key: string): void {
      if (active.has(key)) current.add(key);
    },
    memory<T>(_kind: string, start: () => T): T {
      return start();
    },
  };
  return {
    ctx,
    finish() {
      active.clear();
      for (const key of current) active.add(key);
      current = new Set();
    },
  };
}

describe('an out-of-tokens screen is not idle or done', () => {
  test('each shipped CLI reads the model-issue screen as out of tokens, never idle or done', () => {
    const tail = "There's an issue with the selected model (k3-256k)\n❯ ";
    for (const cli of SHIPPED) {
      const screen = readScreen(cli, tail);
      expect(screen, cli).toEqual({ kind: 'rate limit', reset: null, reason: 'out of tokens' });
      expect(outOfTokensState(screen)).toBe('out of tokens');
    }
  });

  test('a usage limit, a 429, and an exhausted weekly quota on the live tail are out of tokens', () => {
    for (const tail of LIMIT_TAILS) {
      expect(readScreen('claude-code', tail), tail).toEqual({
        kind: 'rate limit',
        reset: null,
        reason: 'out of tokens',
      });
    }
  });

  test('the status word is out of tokens, and a quoted sentence above the live box is not', () => {
    const live = readScreen('claude-code', "There's an issue with the selected model (k3-256k)\n❯ ");
    expect(outOfTokensState(live)).toBe('out of tokens');
    expect(outOfTokensState(live)).not.toBe('idle');
    expect(outOfTokensState(live)).not.toBe('done');
    const quoted = [
      "There's an issue with the selected model (k3-256k)",
      'I answered it before the tests ran, so this is the box after.',
      '',
      claudeBox(''),
    ].join('\n');
    expect(outOfTokensState(readScreen('claude-code', quoted))).toBeNull();
  });

  test('a running turn that mentions the sentence stays a running turn', () => {
    const busy = "There's an issue with the selected model (k3-256k)\nesc to interrupt\n";
    expect(readScreen('claude-code', busy).kind).toBe('working');
  });

  test('one message to the lead names the seat, the vendor, and what it held, and the seat is marked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-fallback-'));
    try {
      const { ctx, finish } = onceHarness();
      const first = outOfTokens.run(tokenSeat(dir), ctx);
      expect(first.map((report) => `${report.to}: ${report.text}`)).toEqual([
        `orchestrator: ${tokenLeadLine('alpha', 'kimi', 'task')}`,
      ]);
      expect(tokenUnavailable(dir, 'alpha')).toContain('not taking a send or a review');
      expect(tokenSwapHook({ seat: 'alpha', vendor: 'kimi', held: heldWork('builder') })).toEqual({
        kind: 'waiting',
        why: 'the automatic swap waits for team swap',
      });
      finish();
      expect(outOfTokens.run(tokenSeat(dir), ctx)).toEqual([]);
      const review = outOfTokens.run(tokenSeat(dir, { name: 'reviewer-a', role: 'reviewer', vendor: 'kimi' }), onceHarness().ctx);
      expect(review.map((report) => report.text)).toEqual([tokenLeadLine('reviewer-a', 'kimi', 'review')]);
      outOfTokens.run(tokenSeat(dir, { screen: { kind: 'idle' } }), onceHarness().ctx);
      expect(tokenUnavailable(dir, 'alpha')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a weekly figure below 20% warns, and exactly 20% does not', () => {
    expect(weeklyBelowWarning(19)).toBe(true);
    expect(weeklyBelowWarning(20)).toBe(false);
    expect(tokenWarnLine('kimi', 19)).toBe('kimi weekly quota is 19% left, below the 20% warning');
  });
});
