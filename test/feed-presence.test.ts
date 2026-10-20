// The shared feed command over the actual presence path: a synthetic team file and state record,
// the real spool writer, the real ingester and the real publisher, then `team feed` reading the
// bus log through the verified feed adapter. Presence is one typed event in one timeline — never
// a message — and the message rows this command already printed keep their exact fields.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFeed } from '../src/commands/feed.ts';
import {
  presenceId,
  type PresenceEvent,
} from '../src/daemon/presence/contract.ts';
import { createPresenceIngester, type PresenceIngester } from '../src/daemon/presence/ingest.ts';
import { createPresencePublisher, type PresencePublisherStep } from '../src/daemon/presence/publish.ts';
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
// The ingester refuses a runtime event too far ahead of its own clock; the scene's records start
// in the past, never at a wall-clock guess.
const T0 = Date.now() - 120_000;

type World = {
  root: string;
  home: string;
  stateDir: string;
  ingester: PresenceIngester;
  publish: PresencePublisherStep;
};

let base = '';
let world: World | null = null;

afterEach(async () => {
  if (world !== null && !world.ingester.isClosed()) await world.ingester.close();
  world = null;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

/** The same team file the feed's own tests use, so the message side and the naming path are the
 *  ones this command already proved. */
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

function makeWorld(): World {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-feed-presence-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const stateDir = join(root, '.agents');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(stateDir, 'team.yaml'), teamFile(root, lobbyDir(home)));
  writeFileSync(
    join(stateDir, STATE_FILE),
    JSON.stringify({
      format: 1,
      sessions: { [SESSION]: { seats: { [SEAT]: { stage: 'ready', presence_binding: BINDING } }, worktrees: {} } },
    }),
  );
  const ingester = createPresenceIngester({ stateDir, session: SESSION });
  const publish = createPresencePublisher({ stateDir, session: SESSION, project: PROJECT, root, home });
  world = { root, home, stateDir, ingester, publish };
  return world;
}

let nonce = 0;
function stage(w: World, event: PresenceEvent, at: number): { id: string; ts: string } {
  nonce += 1;
  const ts = new Date(at).toISOString();
  const id = presenceId(ts, nonce.toString(16).padStart(8, '0'));
  if (id === null) throw new Error('the test supplied an invalid event instant');
  const staged = stagePresenceRecord(w.stateDir, {
    session: SESSION,
    seat: SEAT,
    binding: BINDING,
    source: 'runtime-hook',
    event,
    ts,
    id,
  });
  if (staged.kind !== 'staged') throw new Error(staged.why);
  return { id, ts };
}

/** Stages each event through the spool writer, lets the real ingester apply it, then publishes
 *  through the real publisher: the same path a daemon's presence pass walks. */
async function publish(w: World, events: Array<{ event: PresenceEvent; at: number }>): Promise<Array<{ id: string; ts: string }>> {
  const staged = events.map((one) => ({ ...one, ...stage(w, one.event, one.at) }));
  const ingested = await w.ingester.step();
  expect(ingested.ingested).toHaveLength(events.length);
  const result = await w.publish(new Date());
  expect(result.failed).toBeNull();
  expect(result.seats[0]?.published).toBe(events.length);
  return staged;
}

function feed(w: World, argv: string[] = [], poll: () => Promise<boolean> = async () => false) {
  const io = testIo(w.root);
  return runFeed(argv, io, { home: w.home, poll }).then((code) => ({ code, out: io.out, err: io.err }));
}

describe('team feed reads the actual presence path', () => {
  test('a published transition is one typed row, never a message with an invented sender', async () => {
    const w = makeWorld();
    await publish(w, [{ event: 'human-wait', at: T0 }]);

    const ran = await feed(w);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('presence.changed');
    expect(ran.out).toContain('waiting-for-a-person (human-wait via runtime-hook)');
    // The seat cell is the seat alone: nothing was addressed, so no arrow is printed.
    expect(ran.out).not.toContain('->');
    expect(ran.out).toContain('1 event');
  });

  test('--json carries the canonical fields and no from, to or body', async () => {
    const w = makeWorld();
    const staged = await publish(w, [{ event: 'turn-start', at: T0 }]);

    const ran = await feed(w, ['--json']);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toHaveLength(1);
    const event = doc.events[0]!;
    expect(event).toMatchObject({
      kind: 'presence.changed',
      ts: staged[0]!.ts,
      session: SESSION,
      seat: SEAT,
      state: 'working',
      event: 'turn-start',
      source: 'runtime-hook',
      binding: BINDING,
      seq: 1,
      presence_seq: 1,
      event_id: staged[0]!.id,
    });
    // The observed instant is when the ingester applied the record, a time of its own — never a
    // copy of the runtime event's instant.
    expect(typeof event.observed_at).toBe('string');
    expect(event.observed_at as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(event.observed_at).not.toBe(staged[0]!.ts);
    expect(event.from).toBeUndefined();
    expect(event.to).toBeUndefined();
    expect(event.body).toBeUndefined();
    expect(event.id).toContain(`presence:${SEAT}:${BINDING}:1:`);
  });

  test('messages keep their exact shape and share one chronological timeline', async () => {
    const w = makeWorld();
    appendHistory(PROJECT, w.root, w.home, {
      ts: new Date(T0).toISOString(),
      from: 'lead',
      to: SEAT,
      body: 'earlier message',
      id: 'feed-presence-message',
      outcome: 'delivered',
    });
    await publish(w, [{ event: 'human-wait', at: T0 + 2000 }]);

    const ran = await feed(w, ['--json']);
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(ran.out, FEED_OUTPUT_SCHEMA);
    expect(doc.events).toHaveLength(2);
    expect(doc.events[0]).toMatchObject({
      ts: new Date(T0).toISOString(),
      from: 'lead',
      to: SEAT,
      body: 'earlier message',
      id: 'feed-presence-message',
      outcome: 'delivered',
      status: 'delivered',
    });
    expect(doc.events[1]).toMatchObject({ kind: 'presence.changed', seat: SEAT });
    // The limit applies to the combined timeline: the presence row is the later one.
    const limited = await feed(w, ['--limit', '1', '--json']);
    const one = JSON.parse(limited.out) as FeedDoc;
    expect(one.events).toHaveLength(1);
    expect(one.events[0]).toMatchObject({ kind: 'presence.changed' });
  });

  test('--seat filters presence by its seat and messages by sender or recipient', async () => {
    const w = makeWorld();
    appendHistory(PROJECT, w.root, w.home, {
      ts: new Date(T0).toISOString(),
      from: 'lead',
      to: SEAT,
      body: 'earlier message',
      id: 'feed-presence-seat',
      outcome: 'delivered',
    });
    await publish(w, [{ event: 'human-wait', at: T0 + 2000 }]);

    const lead = await feed(w, ['--seat', 'lead', '--json']);
    const leadDoc = JSON.parse(lead.out) as FeedDoc;
    expect(leadDoc.events).toHaveLength(1);
    expect(leadDoc.events[0]).toMatchObject({ from: 'lead', body: 'earlier message' });

    const helper = await feed(w, ['--seat', SEAT, '--json']);
    const helperDoc = JSON.parse(helper.out) as FeedDoc;
    expect(helperDoc.events).toHaveLength(2);
    expect(helperDoc.events.map((event) => event.kind ?? 'message')).toEqual(['message', 'presence.changed']);
  });

  test('--follow prints each transition once and prints a later one as it arrives', async () => {
    const w = makeWorld();
    await publish(w, [{ event: 'turn-start', at: T0 }]);

    let publishedSecond = false;
    const io = testIo(w.root);
    const code = await runFeed(['--follow'], io, {
      home: w.home,
      poll: async (tick) => {
        if (tick === 1 && !publishedSecond) {
          publishedSecond = true;
          await publish(w, [{ event: 'turn-end', at: T0 + 1000 }]);
        }
        return tick < 3;
      },
    });
    expect(code).toBe(0);
    expect((io.out.match(/working \(turn-start via runtime-hook\)/g) ?? []).length).toBe(1);
    expect((io.out.match(/idle \(turn-end via runtime-hook\)/g) ?? []).length).toBe(1);
    // One batch per arrival, not per pass: the quiet pass prints nothing.
    expect((io.out.match(/presence\.changed/g) ?? []).length).toBe(2);
  });

  test('--all locates an indexed store and reads its presence log', async () => {
    const w = makeWorld();
    await publish(w, [{ event: 'human-wait', at: T0 }]);
    // The index entry `find` uses: a store folder named <project>-<hash> whose record names the
    // root the bus path is derived from.
    writeFileSync(join(storePath(PROJECT, w.root, w.home), 'approval.json'), JSON.stringify({ root: w.root }));

    const ran = await feed(w, ['--all']);
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('presence.changed');
    expect(ran.out).toContain('waiting-for-a-person (human-wait via runtime-hook)');
  });

  test('an unreadable presence event log is a refusal, not a quietly shorter feed', async () => {
    const w = makeWorld();
    const log = join(storePath(PROJECT, w.root, w.home), 'events.jsonl');
    mkdirSync(dirname(log), { recursive: true });
    symlinkSync('/etc/passwd', log);

    const ran = await feed(w);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('the presence event log cannot be read: a symbolic link was found and not followed');
  });
});
