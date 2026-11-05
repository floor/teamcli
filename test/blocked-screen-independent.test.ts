// Independent coverage of an unrecognised screen telling the lead once within 2N.
// A rate limit or a provider error writes no lead report, and a later idle screen still types.
// An unknown screen records delivered-but-blocked with via lead-report. A failed history write
// leaves no blocked claim and the 2N report says queued, not woken. A failed event append after
// a good history write keeps the history, the drop and the marker; the next pass appends
// seat.blocked once, and a concurrent history line survives.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { appendHistory, readHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { readRecord, signRecord } from '../src/send/record.ts';
import type { TypedWakeResult } from '../src/send/typed-wake.ts';
import { storePath } from '../src/store/store.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { readScreen } from '../src/watch/screen.ts';
import { reportUnreadDrops, reportedPath, wakePath, wakeUnreadDrops } from '../src/watch/unread.ts';
import { discardFixtures } from './fixture-cleanup.ts';

const NOW = new Date('2026-11-04T15:00:00.000Z');
const N = 600;
const MIN = 60_000;
const UNREAD = '019a4f61-4000-7000-8000-000000000001';
const OTHER = '019a4f61-4000-7000-8000-000000000002';
const SURVEY = ['● Done.', '', "How's the CLI experience so far? [1] Good [2] Fine [3] Bad [0] Skip"].join('\n');
const IDLE = readFileSync(new URL('./fixtures/antigravity/1.4.2/idle.txt', import.meta.url), 'utf8');
const RATE_LIMIT = (() => {
  const lines = IDLE.split('\n');
  const at = lines.findIndex((line) => line.startsWith('─'));
  return [...lines.slice(0, at), 'Individual quota reached', 'Resets in 47h31m', ...lines.slice(at)].join('\n');
})();
const DELIVERED: TypedWakeResult = {
  delivered: true,
  typed: true,
  tries: 1,
  reason: 'the working screen showed after 1 Enter',
};

let base = '';

afterEach(() => {
  if (base !== '') discardFixtures([base], { roots: [tmpdir()] });
  base = '';
});

function teamText(root: string, lobby: string, cli: 'claude-code' | 'antigravity'): string {
  const seat = cli === 'antigravity'
    ? { vendor: 'google', model: 'Gemini 4 Argon', launch: 'agy' }
    : { vendor: 'test', model: 'Test', launch: 'claude' };
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
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: ${cli}
    vendor: ${seat.vendor}
    model: ${seat.model}
    version: "1"
    launch: ${seat.launch}
`;
}

type World = { root: string; dir: string; home: string };

function world(cli: 'claude-code' | 'antigravity'): { made: World; team: ReturnType<typeof validateTeamFile> & { ok: true } } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-blocked-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const text = teamText(root, lobbyDir(home), cli);
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const validated = validateTeamFile(text);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return { made: { root, dir: join(root, '.agents'), home }, team: validated };
}

type Pane = { screen: string | null; status: string; typed: string[]; enters: number; keys: string[] };

function pane(screen: string, status: string): Pane {
  return { screen, status, typed: [], enters: 0, keys: [] };
}

function typedSources(one: Pane, calls: { pane: string; line: string }[]): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
    typedWake: async (paneId, line) => {
      calls.push({ pane: paneId, line });
      return DELIVERED;
    },
  };
}

function live(status: string): Live {
  const agents: HerdrAgent[] = [
    { name: 'helper', agent: 'claude', pane: 'pane-helper', workspace: 'first', status, cwd: null },
    { name: null, agent: 'claude', pane: 'pane-lead', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

function seed(made: World, body: string, ageMin: number): string {
  const dropDir = join(made.dir, 'send-drops', 'acme', 'helper');
  const at = new Date(NOW.getTime() - ageMin * MIN);
  const record = signRecord({
    kind: 'message',
    id: UNREAD,
    to: 'helper',
    to_id: null,
    root: realpathSync(made.root),
    session: 'acme',
    at: at.toISOString(),
    body,
    from: 'owner',
    from_id: null,
    rule: 'the owner',
    thread: UNREAD,
  }, made.home);
  dropMessage(dropDir, UNREAD, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, UNREAD), new Date(), at);
  return dropDir;
}

function scene(
  made: World,
  team: { ok: true; team: import('../src/file/types.ts').TeamFile },
  said: string[],
  sources: RetrySources,
  now: Date,
  status: string,
) {
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: team.team,
    live: live(status),
    ownPane: null,
    sources,
    now,
    say: (text: string) => said.push(text),
  };
}

function leadBody(dir: string): string {
  const dropDir = join(dir, 'send-drops', 'acme', 'lead');
  const ids = readdirSync(dropDir).filter((name) => MESSAGE_ID.test(name) && name !== UNREAD);
  expect(ids).toHaveLength(1);
  const id = ids[0];
  if (id === undefined) throw new Error('the lead report is missing');
  const read = readRecord(join(dropDir, id), id);
  if (!read.ok || read.record === null) throw new Error('the lead report did not verify');
  return read.record.payload.body;
}

describe('blocked screen tells the lead', () => {
  test('a rate-limit screen writes no lead report, and a later idle screen still types', async () => {
    expect(readScreen('antigravity', RATE_LIMIT).kind).toBe('rate limit');
    expect(readScreen('antigravity', IDLE).kind).toBe('idle');
    const { made, team } = world('antigravity');
    const dropDir = seed(made, 'from the owner\n\nrate limit', 11);
    const calls: { pane: string; line: string }[] = [];
    const blocked = pane(RATE_LIMIT, 'done');
    const said: string[] = [];
    await wakeUnreadDrops(scene(made, team, said, typedSources(blocked, calls), NOW, 'done'), { unreadAfter: N });
    expect(calls).toEqual([]);
    expect(said).toEqual([]);
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
    expect(existsSync(join(made.dir, 'send-drops', 'acme', 'lead'))).toBe(false);
    const historyBefore = readHistory('acme', made.root, made.home);
    expect(historyBefore.ok && historyBefore.entries).toEqual([]);

    const idle = pane(IDLE, 'idle');
    await wakeUnreadDrops(
      scene(made, team, said, typedSources(idle, calls), new Date(NOW.getTime() + MIN), 'idle'),
      { unreadAfter: N },
    );
    expect(calls).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('typed wake');
    const historyAfter = readHistory('acme', made.root, made.home);
    expect(historyAfter.ok && historyAfter.entries).toHaveLength(1);
    if (historyAfter.ok) expect(historyAfter.entries[0]?.outcome).toBe('delivered (typed wake)');
  });

  test('an unknown screen tells the lead once within 2N with via lead-report', async () => {
    expect(readScreen('antigravity', SURVEY).kind).toBe('unknown');
    const { made, team } = world('antigravity');
    seed(made, 'from the owner\n\nsurvey', 11);
    const one = pane(SURVEY, 'done');
    const calls: { pane: string; line: string }[] = [];
    const said: string[] = [];
    const sources = typedSources(one, calls);
    await wakeUnreadDrops(scene(made, team, said, sources, NOW, 'done'), { unreadAfter: N });

    expect(one.typed).toEqual([]);
    expect(one.keys).toEqual([]);
    expect(calls).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('delivered-but-blocked');
    const body = leadBody(made.dir);
    expect(body).toContain('delivered-but-blocked');
    expect(body).toContain('unknown');
    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ outcome: 'delivered-but-blocked', via: 'lead-report' });
    }

    await wakeUnreadDrops(
      scene(made, team, said, sources, new Date(NOW.getTime() + 4 * MIN), 'done'),
      { unreadAfter: N },
    );
    expect(said).toHaveLength(1);
    expect(calls).toEqual([]);
    const events = readEvents('acme', made.root, made.home);
    expect(events.ok && events.events.filter((event) => event.payload.kind === 'seat.blocked')).toHaveLength(1);
  });

  test('a failed history write still reports the message lost at 2N', async () => {
    const { made, team } = world('antigravity');
    const dropDir = seed(made, 'from the owner\n\nhistory fails', 11);
    const historyStore = storePath('acme', made.root, made.home);
    mkdirSync(historyStore, { recursive: true });
    mkdirSync(join(historyStore, 'messages.jsonl'));
    const one = pane(SURVEY, 'done');
    const said: string[] = [];
    const sources = typedSources(one, []);
    await wakeUnreadDrops(scene(made, team, said, sources, NOW, 'done'), { unreadAfter: N });
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(false);
    expect(said).toEqual([]);
    const leadDir = join(made.dir, 'send-drops', 'acme', 'lead');
    expect(existsSync(leadDir) ? readdirSync(leadDir) : []).toEqual([]);
    const failed = readEvents('acme', made.root, made.home);
    expect(failed.ok && failed.events.filter((event) => event.payload.kind === 'seat.blocked')).toEqual([]);

    const reported: string[] = [];
    reportUnreadDrops(
      scene(made, team, reported, sources, new Date(NOW.getTime() + 10 * MIN), 'done'),
      { unreadAfter: N },
    );
    expect(existsSync(reportedPath(dropDir, UNREAD))).toBe(true);
    const owner = JSON.parse(readFileSync(join(made.root, '.agents', 'messages', 'owner', `unread-${UNREAD}.json`), 'utf8')) as { payload: { body: string } };
    expect(owner.payload.body).toContain('queued, not woken - unread for 21 min');
    expect(owner.payload.body).not.toContain('delivered-but-blocked');
    const atReport = readEvents('acme', made.root, made.home);
    expect(atReport.ok && atReport.events.filter((event) => event.payload.kind === 'seat.blocked')).toEqual([]);
  });

  test('a failed event append keeps the history, the drop and the marker, and the next pass appends seat.blocked once', async () => {
    const { made, team } = world('antigravity');
    const dropDir = seed(made, 'from the owner\n\nevent fails after history', 11);
    const eventsPath = join(storePath('acme', made.root, made.home), 'events.jsonl');
    mkdirSync(eventsPath, { recursive: true });
    let injected = false;
    let projectReads = 0;
    const watched = new Proxy(team.team, {
      get(target, prop, receiver) {
        if (prop === 'project') {
          projectReads += 1;
          if (!injected && projectReads >= 3) {
            injected = true;
            appendHistory('acme', made.root, made.home, {
              ts: NOW.toISOString(),
              from: 'owner',
              to: 'helper',
              body: 'a line another writer appended during the pass',
              id: OTHER,
              thread: OTHER,
              outcome: 'delivered (typed wake)',
              via: 'typed',
            });
          }
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const one = pane(SURVEY, 'done');
    const said: string[] = [];
    const sources = typedSources(one, []);
    await wakeUnreadDrops(scene(made, { ok: true, team: watched }, said, sources, NOW, 'done'), { unreadAfter: N });
    expect(injected).toBe(true);
    expect(said).toHaveLength(1);

    const history = readHistory('acme', made.root, made.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      const ids = history.entries.map((entry) => entry.id).sort();
      expect(ids).toEqual([OTHER, UNREAD].sort());
      expect(history.entries.find((entry) => entry.id === UNREAD)).toMatchObject({
        outcome: 'delivered-but-blocked',
        via: 'lead-report',
      });
    }
    expect(existsSync(wakePath(dropDir, UNREAD))).toBe(true);
    expect(leadBody(made.dir)).toContain('delivered-but-blocked');
    rmdirSync(eventsPath);
    const blocked = readEvents('acme', made.root, made.home);
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.events.filter((event) => event.payload.kind === 'seat.blocked')).toEqual([]);

    const next: string[] = [];
    await wakeUnreadDrops(
      scene(made, team, next, sources, new Date(NOW.getTime() + 4 * MIN), 'done'),
      { unreadAfter: N },
    );
    expect(next).toEqual([]);
    const caughtUp = readEvents('acme', made.root, made.home);
    expect(caughtUp.ok).toBe(true);
    if (caughtUp.ok) {
      const blockedEvents = caughtUp.events.filter((event) => event.payload.kind === 'seat.blocked');
      expect(blockedEvents).toHaveLength(1);
      expect(blockedEvents[0]?.payload.record_id).toBe(`unread-blocked:${UNREAD}`);
    }
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('delivered-but-blocked');

    await wakeUnreadDrops(
      scene(made, team, next, sources, new Date(NOW.getTime() + 5 * MIN), 'done'),
      { unreadAfter: N },
    );
    const again = readEvents('acme', made.root, made.home);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.events.filter((event) => event.payload.kind === 'seat.blocked')).toHaveLength(1);
    expect(said).toHaveLength(1);
    expect(next).toEqual([]);
    const kept = readHistory('acme', made.root, made.home);
    expect(kept.ok && kept.entries.map((entry) => entry.id).sort()).toEqual([OTHER, UNREAD].sort());

    reconcilePass({ project: 'acme', root: made.root, home: made.home, session: 'acme', now: NOW });
    const reconciled = readEvents('acme', made.root, made.home);
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) {
      const delivered = reconciled.events.filter(
        (event) => event.payload.kind === 'message.delivered' && event.payload.record_id === `${UNREAD}:delivered`,
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.payload).toMatchObject({ outcome: 'delivered-but-blocked', via: 'lead-report' });
    }
  });
});
