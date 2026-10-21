// Independent acceptance for the shared feed command at 4ac0793f7 (`feat(presence): read the
// verified presence feed in team feed`). Every world is synthetic under a temporary directory and walks
// the actual path: the real spool writer, the real ingester, the real publisher, the real bus
// log's signature verification, and the command's own `runFeed`. No live seat, pane, checkout
// store, owner home or CLI is touched.
//
// What the scenes hold the command to, beyond the ones its own tests already walk:
//   - a message row keeps exactly the fields it had, and a presence row is a distinct typed
//     event with the canonical contract fields and no sender, recipient, body or owner;
//   - the combined timeline is ordered by the instants the timestamps denote, not by the bytes
//     of their spellings: the presence contract accepts whole-second UTC as well as 1..3
//     fractional digits, so a same-second `Z` and `.500Z` must sort numerically, and `--limit`
//     must cut the last n numerally;
//   - `--all` reads a store through the root its approval record names: two indexed folders of
//     one project whose recorded root belongs to only one of them must not surface the same bus
//     record twice, and a folder's own log must not be aliased into another store's answer;
//   - `--follow` keeps one exclusive cursor per store: a retention hole in one store is
//     disclosed with its declared range and resynced, while the sibling store's cursor keeps
//     following, and no transition is printed twice across the resync;
//   - a malformed or unreadable presence source refuses with `feed.presence-unreadable` (exit
//     1), while a self-contradicting record is dropped whole, never repaired into a row;
//   - every `--json` answer matches FEED_OUTPUT_SCHEMA against the actual output.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, pruneEventLog } from '../src/bus/log.ts';
import { runFeed } from '../src/commands/feed.ts';
import { presenceId, type PresenceEvent } from '../src/daemon/presence/contract.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import {
  createPresencePublisher, PRESENCE_PUBLISH_KIND, presenceRecordIdOf,
  type PresencePublisherStep,
} from '../src/daemon/presence/publish.ts';
import { stagePresenceRecord } from '../src/daemon/presence/spool.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { FEED_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { appendHistory } from '../src/send/history.ts';
import { STATE_FILE } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

type FeedDoc = {
  schema: { name: string; version: number };
  format: number;
  project: string | null;
  session: string | null;
  events: Array<Record<string, unknown>>;
};

const PROJECT = 'acme';
const SESSION = 'acme';
const SEAT = 'helper';
const BINDING = 'prs_0123456789ab';
// The ingester refuses a runtime event too far ahead of its own clock; every record starts two
// minutes in the past, on a whole second so a no-fraction timestamp denotes the same instant.
const BASE = Math.floor((Date.now() - 120_000) / 1000) * 1000;
const iso = (at: number): string => new Date(at).toISOString();
/** The contract's no-fraction UTC form for an instant that is a whole second. */
const whole = (at: number): string => iso(at).replace(/\.\d{3}Z$/, 'Z');

type Shared = { base: string; home: string };

type Store = {
  root: string;
  stateDir: string;
  ingester: PresenceIngester;
  publish: PresencePublisherStep;
};

let shared: Shared | null = null;
let stores: Store[] = [];

afterEach(async () => {
  for (const store of stores) if (!store.ingester.isClosed()) await store.ingester.close();
  stores = [];
  if (shared !== null) rmSync(shared.base, { recursive: true, force: true });
  shared = null;
});

function makeShared(): Shared {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'b7-feed-accept-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  shared = { base, home };
  return shared;
}

/** The team file the command's own world uses: one coordinator and one implementer seat. */
function teamFile(root: string, lobby: string): string {
  return `format: 1
project: ${PROJECT}
coordinator: lead
operator: lead
session: ${SESSION}
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
    name: ${SEAT}
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m implementer
`;
}

/** One team checkout with its own state, binding, ingester and publisher, all on one home. */
function makeStore(together: Shared, name: string): Store {
  const root = join(together.base, name);
  const stateDir = join(root, '.agents');
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(stateDir, 'team.yaml'), teamFile(root, lobbyDir(together.home)));
  writeFileSync(
    join(stateDir, STATE_FILE),
    JSON.stringify({
      format: 1,
      sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', presence_binding: BINDING } }, worktrees: {} } },
    }),
  );
  const store: Store = {
    root,
    stateDir,
    ingester: createPresenceIngester({ stateDir, session: SESSION }),
    publish: createPresencePublisher({ stateDir, session: SESSION, project: PROJECT, root, home: together.home }),
  };
  stores.push(store);
  return store;
}

/** The index entry `--all` walks: a store folder whose approval record names its root. */
function index(store: Store, home: string, recorded = store.root): void {
  const folder = storePath(PROJECT, store.root, home);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'approval.json'), JSON.stringify({ root: recorded }));
}

let hex = 0;
/** Stages one runtime event at exactly this instant, lets the real ingester apply it, then
 *  publishes through the real publisher. The timestamp is used verbatim, so the contract's
 *  precision variants reach the bus log as written. */
async function publishOne(store: Store, event: PresenceEvent, ts: string): Promise<{ id: string; ts: string }> {
  hex += 1;
  const id = presenceId(ts, hex.toString(16).padStart(8, '0'));
  if (id === null) throw new Error(`the test supplied an invalid event instant ${ts}`);
  const staged = stagePresenceRecord(store.stateDir, {
    session: SESSION, seat: SEAT, binding: BINDING, source: 'runtime-hook', event, ts, id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  const ingested = await store.ingester.step();
  expect(ingested.ingested.length).toBeGreaterThan(0);
  const result = await store.publish(new Date());
  expect(result.failed).toBeNull();
  return { id, ts };
}

type Ran = { code: number; out: string; err: string };

function feed(root: string, argv: string[], home: string, poll?: () => Promise<boolean>): Promise<Ran> {
  const io = testIo(root);
  return runFeed(argv, io, { home, poll }).then((code) => ({ code, out: io.out, err: io.err }));
}

const presenceRows = (doc: FeedDoc): Array<Record<string, unknown>> =>
  doc.events.filter((event) => event.kind === 'presence.changed');

describe('team feed acceptance over the actual publisher and verified bus', () => {
  test('message rows keep their fields; presence rows are typed, canonical and unaddressed', async () => {
    makeShared();
    const together = shared!;
    const store = makeStore(together, 'crew');
    appendHistory(PROJECT, store.root, together.home, {
      ts: iso(BASE),
      from: 'lead',
      to: SEAT,
      body: 'the earlier message',
      id: 'feed-accept-message',
      outcome: 'delivered',
    });
    const staged = await publishOne(store, 'turn-start', iso(BASE + 2000));

    const ran = await feed(store.root, ['--json'], together.home);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toHaveLength(2);

    const message = doc.events.find((event) => event.kind === undefined);
    expect(message).toBeDefined();
    // Exactly the shape the command printed before presence existed: nothing gained, lost or
    // renamed by sharing the timeline with a typed event.
    expect(Object.keys(message!).sort()).toEqual(['body', 'from', 'id', 'outcome', 'status', 'to', 'ts']);
    expect(message).toMatchObject({
      ts: iso(BASE), from: 'lead', to: SEAT, body: 'the earlier message',
      id: 'feed-accept-message', outcome: 'delivered', status: 'delivered',
    });

    const presence = presenceRows(doc)[0]!;
    // The canonical contract fields, and exactly them: no sender, recipient, body, owner, status
    // or outcome was invented for a state that nobody sent.
    expect(Object.keys(presence).sort()).toEqual([
      'binding', 'event', 'event_id', 'id', 'kind', 'observed_at', 'presence_seq',
      'seat', 'seq', 'session', 'source', 'state', 'ts',
    ]);
    expect(presence).toMatchObject({
      kind: 'presence.changed', ts: staged.ts, session: SESSION, seat: SEAT,
      state: 'working', event: 'turn-start', source: 'runtime-hook', binding: BINDING,
      seq: 1, presence_seq: 1, event_id: staged.id,
    });
    expect(typeof presence.observed_at).toBe('string');
    for (const absent of ['from', 'to', 'body', 'owner']) expect(presence[absent]).toBeUndefined();

    // The plain table keeps the distinction: the message row is addressed, the presence row is
    // the seat alone, and neither is printed as the other.
    const plain = await feed(store.root, [], together.home);
    expect(plain.code).toBe(0);
    const lines = plain.out.split('\n').filter((line) => line.includes('presence.changed') || line.includes('->'));
    const presenceLine = lines.find((line) => line.includes('presence.changed'))!;
    const messageLine = lines.find((line) => line.includes('->'))!;
    expect(presenceLine).not.toContain('->');
    expect(presenceLine).toContain(`working (turn-start via runtime-hook)`);
    expect(messageLine).toContain('lead -> helper');

    // --seat keeps a message by sender or recipient and a presence row by its seat.
    const onlyLead = JSON.parse((await feed(store.root, ['--seat', 'lead', '--json'], together.home)).out) as FeedDoc;
    expect(onlyLead.events.map((event) => event.kind ?? 'message')).toEqual(['message']);
    const both = JSON.parse((await feed(store.root, ['--seat', SEAT, '--json'], together.home)).out) as FeedDoc;
    expect(both.events.map((event) => event.kind ?? 'message')).toEqual(['message', 'presence.changed']);
  });

  test('mixed accepted timestamp precision sorts by the instant, not the spelling', async () => {
    // The presence contract accepts whole-second UTC (`Z`) and 1..3 fractional digits; the
    // history writes `.sssZ`. In the same second the raw spellings disagree with the instants:
    // "01.500Z" is byte-wise before "01Z" but half a second after it.
    makeShared();
    const together = shared!;
    const store = makeStore(together, 'crew');
    appendHistory(PROJECT, store.root, together.home, {
      ts: iso(BASE), from: 'lead', to: SEAT, body: 'at zero',
      id: 'feed-accept-early', outcome: 'delivered',
    });
    const p0 = await publishOne(store, 'turn-start', iso(BASE + 250));   // 00.250 -> working
    const p1 = await publishOne(store, 'human-wait', whole(BASE + 1000)); // 01.000
    appendHistory(PROJECT, store.root, together.home, {
      ts: iso(BASE + 1500), from: 'lead', to: SEAT, body: 'half a second after one',
      id: 'feed-accept-late', outcome: 'delivered',
    });

    const ran = await feed(store.root, ['--json'], together.home);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    // The documented order: message 00.000, presence 00.250, presence 01.000, message 01.500.
    // A byte-wise sort moves the whole-second presence behind the fractional message.
    expect(doc.events.map((event) => event.kind ?? 'message')).toEqual([
      'message', 'presence.changed', 'presence.changed', 'message',
    ]);
    expect(doc.events.map((event) => (event.kind === 'presence.changed' ? event.event_id : event.id))).toEqual([
      'feed-accept-early', p0.id, p1.id, 'feed-accept-late',
    ]);
  });

  test('mixed accepted timestamp precision limits by the instant, not the spelling', async () => {
    makeShared();
    const together = shared!;
    const store = makeStore(together, 'crew');
    appendHistory(PROJECT, store.root, together.home, {
      ts: iso(BASE), from: 'lead', to: SEAT, body: 'at zero',
      id: 'feed-accept-early', outcome: 'delivered',
    });
    const p0 = await publishOne(store, 'turn-start', iso(BASE + 250));
    const p1 = await publishOne(store, 'human-wait', whole(BASE + 1000));
    appendHistory(PROJECT, store.root, together.home, {
      ts: iso(BASE + 1500), from: 'lead', to: SEAT, body: 'half a second after one',
      id: 'feed-accept-late', outcome: 'delivered',
    });

    const idOf = (event: Record<string, unknown>): unknown =>
      event.kind === 'presence.changed' ? event.event_id : event.id;
    // The numerically latest event is the message at 01.500, not the whole-second presence at
    // 01.000 that its spelling sorts after.
    const one = await feed(store.root, ['--limit', '1', '--json'], together.home);
    const doc1 = assertMatchesOutputSchema<FeedDoc>(one.out, FEED_OUTPUT_SCHEMA);
    expect(doc1.events.map(idOf)).toEqual(['feed-accept-late']);

    const two = await feed(store.root, ['--limit', '2', '--json'], together.home);
    const doc2 = assertMatchesOutputSchema<FeedDoc>(two.out, FEED_OUTPUT_SCHEMA);
    expect(doc2.events.map(idOf)).toEqual([p1.id, 'feed-accept-late']);

    const three = await feed(store.root, ['--limit', '3', '--json'], together.home);
    const doc3 = JSON.parse(three.out) as FeedDoc;
    expect(doc3.events.map(idOf)).toEqual([p0.id, p1.id, 'feed-accept-late']);
  });

  test('--all reads a store through its recorded root, never aliasing or duplicating one', async () => {
    // Two indexed folders of one project. Folder B's approval names B's root, truthfully. Folder
    // A's approval names B's root too, although A's folder name hashes A's own root: the record
    // locates B, so A must not become a second name for B's bus log — and A's own log, which no
    // record locates, must not be substituted for B's either.
    makeShared();
    const together = shared!;
    const a = makeStore(together, 'alpha');
    const b = makeStore(together, 'beta');
    await publishOne(a, 'turn-start', iso(BASE));      // only in A's own log
    const bEvent = await publishOne(b, 'human-wait', iso(BASE + 2000));
    index(a, together.home, b.root);                    // mismatched: names B
    index(b, together.home);                            // truthful

    const ran = await feed(a.root, ['--all', '--json'], together.home);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    const presence = presenceRows(doc);
    // A's own log, which no record locates, is not substituted for B's.
    expect(presence.some((event) => event.event === 'turn-start')).toBe(false);
    // B's one verified record is present exactly once: no cross-store duplicate or alias.
    const ids = presence.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(presence).toHaveLength(1);
    // B's data was not omitted either.
    expect(presence[0]).toMatchObject({
      seat: SEAT, state: 'waiting-for-a-person', event: 'human-wait', event_id: bEvent.id,
    });
  });

  test('--follow keeps per-store cursors, discloses a retention hole and resyncs without repeats', async () => {
    makeShared();
    const together = shared!;
    const a = makeStore(together, 'alpha');
    const b = makeStore(together, 'beta');
    index(a, together.home);
    index(b, together.home);

    const io = testIo(a.root);
    const code = await runFeed(['--all', '--follow'], io, {
      home: together.home,
      poll: async (tick) => {
        if (tick === 0) {
          await publishOne(a, 'turn-start', iso(BASE));
          await publishOne(b, 'human-wait', iso(BASE + 1000));
        }
        if (tick === 1) {
          // A second transition in A lands and is then dropped by the bus's own retention
          // before the follower's next read; the declared drop record names the range.
          await publishOne(a, 'turn-end', iso(BASE + 2000));
          pruneEventLog(PROJECT, a.root, together.home, {
            retentionSeconds: -1, kept: 2, session: SESSION,
          });
        }
        if (tick === 2) await publishOne(a, 'session-end', iso(BASE + 3000));
        if (tick === 3) await publishOne(b, 'turn-end', iso(BASE + 4000));
        return tick < 4;
      },
    });
    expect(code).toBe(0);
    const out = io.out;
    // The gap is disclosed with its declared range and the project it belongs to (--all names
    // no single team's context, so the notice carries the store's project).
    expect(out.match(/presence: gap for acme — events 2\.\.2 passed retention; resyncing from the retained log/g))
      .toHaveLength(1);
    // Each transition the follower saw is printed exactly once: A's lost turn-end is not
    // invented, A's resynced session-end is new, and B keeps following on its own cursor.
    expect(out.match(/working \(turn-start via runtime-hook\)/g)).toHaveLength(1);
    expect(out.match(/waiting-for-a-person \(human-wait via runtime-hook\)/g)).toHaveLength(1);
    expect(out.match(/gone \(session-end via runtime-hook\)/g)).toHaveLength(1);
    expect(out.match(/idle \(turn-end via runtime-hook\)/g)).toHaveLength(1);
    expect(out.match(/presence\.changed/g)).toHaveLength(4);
  });

  test('an unreadable source refuses as feed.presence-unreadable; a contradictory record is dropped', async () => {
    makeShared();
    const together = shared!;
    const store = makeStore(together, 'crew');
    const log = join(storePath(PROJECT, store.root, together.home), 'events.jsonl');
    mkdirSync(log, { recursive: true });

    const refused = await feed(store.root, ['--json'], together.home);
    expect(refused.code).toBe(1);
    const error = JSON.parse(refused.out) as {
      schema: { name: string; version: number };
      error: { id: string; message: string };
    };
    expect(error.schema).toEqual({ name: 'team.error', version: 1 });
    expect(error.error.id).toBe('feed.presence-unreadable');
    expect(error.error.message).toContain('the presence event log cannot be read: the event log path is a directory');
    const plain = await feed(store.root, [], together.home);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain('the event log path is a directory');

    // A signed record that contradicts the contract's own event->state mapping is dropped whole
    // by the verified feed, never repaired into a row and never a refusal.
    rmSync(log, { recursive: true, force: true });
    mkdirSync(join(storePath(PROJECT, store.root, together.home)), { recursive: true });
    const ts = iso(BASE);
    const eventId = `${ts}-0badc0de`;
    const appended = appendEvent(PROJECT, store.root, together.home, {
      ts,
      kind: PRESENCE_PUBLISH_KIND,
      session: SESSION,
      record_id: presenceRecordIdOf(SEAT, { binding: BINDING, seq: 1, id: eventId }),
      seat: SEAT,
      presence_state: 'idle',            // the mapping says turn-start is working
      presence_event: 'turn-start',
      presence_source: 'runtime-hook',
      presence_binding: BINDING,
      presence_event_id: eventId,
      presence_observed_at: ts,
      presence_seq: 1,
    });
    expect(appended.ok).toBe(true);
    const ran = await feed(store.root, ['--json'], together.home);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toEqual([]);
  });
});
