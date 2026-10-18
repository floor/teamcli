// `team raise` at its edges: the lead's caller rule, the hour's merge, the day's cap, `--dry-run`
// writing nothing at all, and the owner's mailbox as the only place the line lands. The record and
// the event are read back through the same readers the watch and the owner use.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readEvents, type EventPayload } from '../src/bus/log.ts';
import { ownerRecordId } from '../src/bus/owner.ts';
import { type Caller } from '../src/caller.ts';
import { messageFile } from '../src/commands/messages.ts';
import {
  MERGE_WINDOW_MS,
  RAISES_PER_DAY,
  realRaiseSources,
  runRaise,
  type RaiseSources,
} from '../src/commands/raise.ts';
import { RAISE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

const TEAM = `format: 1
project: acme
session: acme
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** The same team, with the lead spelled the deprecated way: `coordinator:` and no mark. */
const TEAM_KEYED = TEAM.replace('    leads: true\n', '').replace('project: acme\n', 'project: acme\ncoordinator: lead\n');

/** A team whose second seat is a person: one that must never be typed into. */
const TEAM_HUMAN = TEAM.replace(
  '  - role: builder\n    name: helper\n    cli: claude-code',
  '  - role: helper\n    name: desk\n    human: true\n    cli: claude-code',
);

const NOW = new Date('2026-10-04T09:00:00Z');

const LEAD: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
const HELPER: Caller = { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' };

const files: string[] = [];

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place(team = TEAM): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-raise-')));
  files.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), team);
  return { root, home };
}

/** Record a pane for a seat, the way a launch would: the caller rule admits a seat only on the
 *  pane the state holds for it. */
function recordPane(where: { root: string }, name: string, pane: string): void {
  updateState(join(where.root, '.agents'), (state) => {
    const session = (state.sessions['acme'] ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}

async function raise(
  argv: string[],
  where: { root: string; home: string },
  caller: Caller = LEAD,
  now: Date = NOW,
  notified: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where.root, caller);
  const sources = {
    home: where.home,
    now: () => now,
    notify: (text: string) => notified.push(text),
  } satisfies RaiseSources;
  const code = await runRaise(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

function eventsOf(where: { root: string; home: string }): EventPayload[] {
  const read = readEvents('acme', where.root, where.home);
  if (!read.ok) throw new Error(read.reason);
  return read.events.map((record) => record.payload);
}

function bodyOf(where: { root: string }, id: string): string {
  const parsed = JSON.parse(readFileSync(messageFile(where.root, 'owner', id), 'utf8')) as { payload: { body: string } };
  return parsed.payload.body;
}

function ownerRecords(where: { root: string }): string[] {
  try {
    return readdirSync(join(where.root, '.agents', 'messages', 'owner')).sort();
  } catch {
    return [];
  }
}

describe('who may raise', () => {
  test('the seat the file marks leads raises, and the owner gets one record and one event', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const notified: string[] = [];
    const ran = await raise(['release.ready', 'the release is ready for the owner'], where, LEAD, NOW, notified);
    expect(ran.code).toBe(0);
    expect(ran.err).toBe('');
    expect(ran.out).toBe('team acme, session "acme"\nraise: release.ready delivered to the owner at once\n');
    expect(notified).toEqual(['the release is ready for the owner']);
    const events = eventsOf(where);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      kind: 'release.ready',
      session: 'acme',
      from: 'lead',
      to: 'owner',
      reason: 'the release is ready for the owner',
    });
    const id = ownerRecordId(events[0] as EventPayload);
    expect(ownerRecords(where)).toEqual([`${id}.json`]);
    expect(bodyOf(where, id)).toBe('the release is ready for the owner');
  });

  test('the lead spelled by the coordinator key is the same caller, and raises', async () => {
    const where = place(TEAM_KEYED);
    recordPane(where, 'lead', 'w1:p1');
    const ran = await raise(['decision.needed', 'pick the launch name'], where);
    expect(ran.code).toBe(0);
    expect(ran.out).toBe('team acme, session "acme"\nraise: decision.needed delivered to the owner at once\n');
    expect(eventsOf(where).map((event) => event.kind)).toEqual(['decision.needed']);
  });

  test('a seat the file does not mark leads is refused, and nothing is written', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    recordPane(where, 'helper', 'w2:p1');
    const ran = await raise(['release.ready', 'the release is ready for the owner'], where, HELPER);
    expect(ran.code).toBe(1);
    expect(ran.out).toBe('');
    expect(ran.err).toBe("team raise: only the orchestrator's seat or a lead's raises to the owner; this call is helper\n");
    expect(eventsOf(where)).toEqual([]);
    expect(existsSync(join(where.root, '.agents', 'messages'))).toBe(false);
  });

  test('the refusal carries the rule (leads) in --json, and the same sentence', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    recordPane(where, 'helper', 'w2:p1');
    const ran = await raise(['release.ready', 'the release is ready', '--json'], where, HELPER);
    expect(ran.code).toBe(1);
    const doc = assertJsonErrorShape(ran.out, {
      id: 'raise.refused',
      messageContains: "only the orchestrator's seat or a lead's raises to the owner; this call is helper",
      repair: null,
    });
    expect(doc.error.rule).toBe('leads');
    expect(eventsOf(where)).toEqual([]);
  });

  test('a lead the state holds on another pane, or on none, keeps the named repairs', async () => {
    const where = place();
    const absent = await raise(['release.ready', 'the release is ready'], where);
    expect(absent.code).toBe(1);
    expect(absent.err).toBe(
      'team raise: no pane is recorded for seat lead in this session: a lead stops that seat and runs `team up`\n',
    );
    recordPane(where, 'lead', 'w9:p1');
    const elsewhere = await raise(['release.ready', 'the release is ready'], where);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.err).toBe(
      'team raise: the state records pane w9:p1 for seat lead in this session, not the pane this call is on: a lead stops the team and starts it again (`team down`, then `team up`)\n',
    );
  });
});

describe('the hour and the day', () => {
  test('the same kind and line from the same seat inside the hour is one record, counted', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const notified: string[] = [];
    const line = 'the release is ready for the owner';
    const first = await raise(['release.ready', line], where, LEAD, NOW, notified);
    expect(first.code).toBe(0);
    const second = await raise(['release.ready', line], where, LEAD, new Date(NOW.getTime() + MERGE_WINDOW_MS), notified);
    expect(second.code).toBe(0);
    expect(second.out).toBe(`team acme, session "acme"\nraise: release.ready merged into the owner's record (×2)\n`);
    // One event, one record, one ring: a merge adds no event and does not ring again.
    const events = eventsOf(where);
    expect(events.length).toBe(1);
    expect(ownerRecords(where)).toEqual([`${ownerRecordId(events[0] as EventPayload)}.json`]);
    expect(bodyOf(where, ownerRecordId(events[0] as EventPayload))).toBe(`${line} (×2)`);
    expect(notified).toEqual([line]);
  });

  test('a repeat past the hour is a delivery of its own, under a free id', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const line = 'the release is ready for the owner';
    await raise(['release.ready', line], where, LEAD, NOW);
    const later = new Date(NOW.getTime() + 2 * MERGE_WINDOW_MS + 1);
    const again = await raise(['release.ready', line], where, LEAD, later);
    expect(again.code).toBe(0);
    expect(again.out).toBe('team acme, session "acme"\nraise: release.ready delivered to the owner at once\n');
    const events = eventsOf(where);
    expect(events.length).toBe(2);
    if (events[0]!.record_id === events[1]!.record_id) throw new Error('two deliveries share one record id');
    expect(events[1]!.record_id).toBe(`${events[0]!.record_id}-2`);
    expect(ownerRecords(where).length).toBe(2);
    expect(bodyOf(where, ownerRecordId(events[1] as EventPayload))).toBe(line);
  });

  test('the eleventh raise of the day is refused, and the lead is told why', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    for (let n = 1; n <= RAISES_PER_DAY; n += 1) {
      const delivered = await raise(['release.ready', `release line ${String(n)}`], where);
      expect(delivered.code).toBe(0);
    }
    expect(eventsOf(where).length).toBe(RAISES_PER_DAY);
    const eleventh = await raise(['decision.needed', 'one more line'], where);
    expect(eleventh.code).toBe(1);
    expect(eleventh.out).toBe('');
    expect(eleventh.err).toBe(
      'team raise: ten raises have reached the owner today; this decision.needed line was not delivered\n',
    );
    expect(eventsOf(where).length).toBe(RAISES_PER_DAY);
    expect(ownerRecords(where).length).toBe(RAISES_PER_DAY);
  });

  test('a merge still works with the day spent: it adds no raise to the count', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    for (let n = 1; n <= RAISES_PER_DAY; n += 1) await raise(['release.ready', `release line ${String(n)}`], where);
    const merged = await raise(['release.ready', 'release line 1'], where);
    expect(merged.code).toBe(0);
    expect(merged.out).toBe(`team acme, session "acme"\nraise: release.ready merged into the owner's record (×2)\n`);
    expect(eventsOf(where).length).toBe(RAISES_PER_DAY);
  });

  test('the capped refusal carries raise.capped in --json', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    for (let n = 1; n <= RAISES_PER_DAY; n += 1) await raise(['release.ready', `release line ${String(n)}`], where);
    const eleventh = await raise(['release.ready', 'one more line', '--json'], where);
    expect(eleventh.code).toBe(1);
    assertJsonErrorShape(eleventh.out, {
      id: 'raise.capped',
      messageContains: 'ten raises have reached the owner today; this release.ready line was not delivered',
      repair: null,
    });
  });
});

describe('--dry-run', () => {
  test('says what it would do and writes nothing at all', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    // The state the fixture wrote is the baseline: a dry run must leave it byte for byte.
    const statePath = join(where.root, '.agents', 'team.state.json');
    const stateBefore = readFileSync(statePath, 'utf8');
    const notified: string[] = [];
    const dry = await raise(['release.ready', 'the release is ready for the owner', '--dry-run'], where, LEAD, NOW, notified);
    expect(dry.code).toBe(0);
    expect(dry.out).toBe('team acme, session "acme"\nraise: would deliver release.ready to the owner at once\n');
    expect(dry.err).toBe('');
    expect(notified).toEqual([]);
    expect(eventsOf(where)).toEqual([]);
    expect(existsSync(join(where.root, '.agents', 'messages'))).toBe(false);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
  });

  test('reads the count a merge would write, and leaves the next real raise the count it read', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const line = 'the release is ready for the owner';
    await raise(['release.ready', line], where);
    const dryMerge = await raise(['release.ready', line, '--dry-run'], where);
    expect(dryMerge.code).toBe(0);
    expect(dryMerge.out).toBe(`team acme, session "acme"\nraise: would merge release.ready into the owner's record (×2)\n`);
    const real = await raise(['release.ready', line], where);
    expect(real.out).toBe(`team acme, session "acme"\nraise: release.ready merged into the owner's record (×2)\n`);
  });

  test('the --json document is the dry-run shape: record null, count read, status dry-run', async () => {
    const where = place();
    recordPane(where, 'lead', 'w1:p1');
    const dry = await raise(['decision.needed', 'pick the launch name', '--dry-run', '--json'], where);
    expect(dry.code).toBe(0);
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(dry.out, RAISE_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      format: 1,
      dry_run: true,
      status: 'dry-run',
      project: 'acme',
      session: 'acme',
      kind: 'decision.needed',
      text: 'pick the launch name',
      route: 'owner',
      record: null,
      count: 1,
    });
  });
});

describe('the owner is the only mailbox', () => {
  test('a raise writes the owner record and rings it; no seat is typed into', async () => {
    const where = place(TEAM_HUMAN);
    recordPane(where, 'lead', 'w1:p1');
    const notified: string[] = [];
    const ran = await raise(['release.ready', 'the release is ready for the owner'], where, LEAD, NOW, notified);
    expect(ran.code).toBe(0);
    expect(notified).toEqual(['the release is ready for the owner']);
    // The only mailbox the line lands in is the owner's: neither the lead's nor the person's seat
    // gets a record, and the command's sources hold no pane channel at all, so nothing can be
    // typed into a human pane.
    expect(readdirSync(join(where.root, '.agents', 'messages'))).toEqual(['owner']);
    expect(Object.keys(realRaiseSources).sort()).toEqual(['home', 'notify', 'now']);
    expect(eventsOf(where).map((event) => event.to)).toEqual(['owner']);
  });
});
