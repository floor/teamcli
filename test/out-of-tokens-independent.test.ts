// A seat whose live tail is an out-of-tokens screen is that state, never idle or done. One
// message goes to its lead. Send keeps the note without waking it. A weekly figure under the warning tells
// the lead, and exactly the threshold does not. The mark is cleared once the screen leaves.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readMessage } from '../src/mcp/inbox.ts';
import { readHistory } from '../src/send/history.ts';
import { runSend } from '../src/commands/send.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import {
  TOKEN_SKIP,
  TOKEN_WARN_PERCENT,
  heldWork,
  outOfTokensState,
  outOfTokensTail,
  recordTokenMark,
  tokenLeadLine,
  tokenUnavailable,
  tokenWarnLine,
  weeklyBelowWarning,
} from '../src/quota/token-fallback.ts';
import { DEFAULT_STATE_THRESHOLDS } from '../src/settings/inherit.ts';
import { outOfTokens } from '../src/watch/checks/out-of-tokens.ts';
import { type CheckContext, type Report, type SeatObservation } from '../src/watch/check.ts';
import { readScreen } from '../src/watch/screen.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { NOW, fake, owner, quietNative, world, type World } from './send-native-fixtures.ts';

const PANE = 'pane-lead';
const LIMIT = 'Usage limit reached';

const owned: string[] = [];
afterEach(() => {
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

function keep(made: World): World {
  owned.push(dirname(made.root));
  return made;
}

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

function entityFile(made: World): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity: 'box' });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, `${text.replace(lobbyDir(made.home), lobby)}entity: box\n`);
}

function seat(partial: Pick<SeatObservation, 'name' | 'role' | 'vendor' | 'screen' | 'agentsDir'>): SeatObservation {
  return {
    name: partial.name,
    seat: { cli: 'grok', model: 'Test', version: '1', display: 'Test 1' },
    rule: undefined,
    agent: undefined,
    herdr: true,
    screen: partial.screen,
    cli: 'grok',
    vendor: partial.vendor,
    account: partial.vendor,
    quota: [],
    identity: 'replaced',
    continuity: 'other',
    launcher: false,
    running: true,
    recorded: 'ready',
    quiet: true,
    working: false,
    prompt: false,
    lead: false,
    parked: false,
    stopped: false,
    queued: false,
    agentsDir: partial.agentsDir,
    role: partial.role,
    attention: null,
    dialogText: null,
    model: null,
    history: { lastWorking: undefined, idleSince: undefined },
    liveness: {
      idle_lead_seconds: DEFAULT_STATE_THRESHOLDS.idle_lead_seconds,
      idle_owner_seconds: DEFAULT_STATE_THRESHOLDS.idle_owner_seconds,
      blind_after_seconds: DEFAULT_STATE_THRESHOLDS.blind_after_seconds,
    },
  };
}

function context(): { ctx: CheckContext; reports: Report[] } {
  const seen = new Set<string>();
  const reports: Report[] = [];
  const ctx: CheckContext = {
    now: NOW.getTime(),
    watch: {
      interval: 30,
      idleFirst: 60,
      idleOwner: 60,
      blindAfter: 60,
      teamIdle: 60,
      nudgeWait: 60,
      unsentAfter: 60,
      unreadAfter: 60,
      leadUnreadAfter: 60,
      stuckAfter: 60,
      quotaMarks: [],
      checks: [],
    },
    budgets: { staleAfter: 60, checkEvery: 60, marks: [], accounts: {} },
    once(key, text, to) {
      if (seen.has(key)) return null;
      seen.add(key);
      const report: Report = { key, text, to: to ?? 'operator' };
      reports.push(report);
      return report;
    },
    keep() {},
    memory(_kind, start) {
      return start();
    },
  };
  return { ctx, reports };
}

test('an out-of-tokens tail is that state, and a sentence above the tail is not', () => {
  const scrolled = [
    ...Array.from({ length: 8 }, () => 'usage limit reached'),
    'ready',
    'the turn ended',
    'nothing is waiting',
    'the prompt is clear',
    'no dialog is open',
    'the seat is idle',
  ].join('\n');
  expect(outOfTokensTail('grok', scrolled)).toBe(false);
  const live = `ready\n${LIMIT}\n`;
  expect(outOfTokensTail('grok', live)).toBe(true);
  const screen = readScreen('grok', live);
  expect(screen).toEqual({ kind: 'rate limit', reset: null, reason: 'out of tokens' });
  expect(outOfTokensState(screen)).toBe('out of tokens');
  expect(screen.kind).not.toBe('idle');
  expect(screen.kind).not.toBe('done');
});

test('the lead hears one message naming the seat, the vendor, and the work it was holding', () => {
  const made = keep(world(null));
  const { ctx, reports } = context();
  const reviewer = seat({
    name: 'pebble',
    role: 'reviewer',
    vendor: 'kimi',
    screen: { kind: 'rate limit', reset: null, reason: 'out of tokens' },
    agentsDir: made.dir,
  });
  expect(heldWork(reviewer.role)).toBe('review');
  expect(outOfTokens.run(reviewer, ctx)).toHaveLength(1);
  expect(outOfTokens.run(reviewer, ctx)).toHaveLength(0);
  expect(reports).toEqual([{
    key: 'out-of-tokens:pebble',
    text: tokenLeadLine('pebble', 'kimi', 'review'),
    to: 'orchestrator',
  }]);
  expect(tokenUnavailable(made.dir, 'pebble')).toBe(TOKEN_SKIP);
});

test('a send keeps the note for an out-of-tokens seat without waking it', async () => {
  const made = keep(world(null));
  entityFile(made);
  const pane = quietNative();
  const host = fake(made, {
    agents: () => [{ name: 'lead', pane: PANE, cli: 'claude' }],
    processInfo: () => ({ shell: 410, foreground: [411] }),
    native: { ...pane, paneText: () => `ready\n${LIMIT}\n` },
  });
  const io = owner(made.root);
  expect(await runSend(['lead', 'a note'], io, host)).toBe(1);
  expect(host.frames).toEqual([]);
  expect(io.err).toContain('lead: not delivered: out of tokens');
  expect(io.err).toContain("kept in lead's inbox");
  expectQueuedMessage(made, 'a note');
});

test('a marked seat keeps its note without a wake when its pane cannot be read', async () => {
  const made = keep(world(null));
  entityFile(made);
  recordTokenMark(made.dir, 'lead', { vendor: 'kimi', held: 'task', at: NOW.getTime() });
  const host = fake(made, {
    agents: () => null,
  });
  const io = owner(made.root);
  expect(await runSend(['lead', 'a note'], io, host)).toBe(1);
  expect(host.frames).toEqual([]);
  expect(io.err).toContain('lead: not delivered: out of tokens');
  expect(io.err).toContain("kept in lead's inbox");
  expectQueuedMessage(made, 'a note');
});

test('a weekly figure under the warning tells the lead, and the threshold itself does not', () => {
  expect(weeklyBelowWarning(TOKEN_WARN_PERCENT)).toBe(false);
  expect(weeklyBelowWarning(TOKEN_WARN_PERCENT - 1)).toBe(true);
  expect(tokenWarnLine('kimi', TOKEN_WARN_PERCENT - 1)).toBe(
    `kimi weekly quota is ${TOKEN_WARN_PERCENT - 1}% left, below the ${TOKEN_WARN_PERCENT}% warning`,
  );
});

test('the mark is cleared once the screen leaves the out-of-tokens state', () => {
  const made = keep(world(null));
  recordTokenMark(made.dir, 'pebble', { vendor: 'kimi', held: 'task', at: NOW.getTime() });
  expect(tokenUnavailable(made.dir, 'pebble')).toBe(TOKEN_SKIP);
  const { ctx } = context();
  const left = seat({
    name: 'pebble',
    role: 'implementer',
    vendor: 'kimi',
    screen: { kind: 'idle' },
    agentsDir: made.dir,
  });
  expect(outOfTokens.run(left, ctx)).toEqual([]);
  expect(tokenUnavailable(made.dir, 'pebble')).toBeNull();
});
