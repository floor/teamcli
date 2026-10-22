// Independent acceptance of the durable idle-episode dispatcher: the actual `dispatchIdleWork`
// pass, the actual claim store (`captureIdleClaim` / `settleIdleClaim` / `endIdleClaims`), and
// the actual mailbox reader for the records the pass publishes.
//
// The reader is `team messages` — `runMessages` over the fixture checkout — because that is what
// serves `.agents/messages/<seat>/<id>.json`, the store `writeRuntimeMailboxRecord` writes. The
// MCP `readMessage` reader accepts only UUID ids under `send-drops`, so it cannot serve these
// notice records; no scene here calls it, and none claims it was called. The reader prints a
// body once and then writes the legacy `.read.json` receipt, so the scenes below prove the first
// notice is consumed by the product's own reader and that the receipt it leaves does not hide a
// later capture's notice.
//
// Everything is synthetic: a temporary crew root, its entity's own root, a temporary home with
// the registry and message key, and fake herdr screens. No live home, pane or session is read.
// No product code is changed by this file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMessages } from '../src/commands/messages.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, readState, STATE_FILE, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { captureIdleClaim, endIdleClaims } from '../src/watch/claim.ts';
import {
  dispatchIdleWork, forgetIdleEpisodes,
  type IdleDispatchInput, type IdleDispatchResult, type WorkPush, type WorkPushRequest,
} from '../src/watch/dispatch.ts';
import { testIo } from './helpers.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-20T03:00:00Z');
const SESSION = 'crew';
const SEAT = 'worker-1';
const SINCE = new Date(NOW - 10 * MIN).toISOString();
const RULE = '─'.repeat(40);
const STATUS = '  main · …/acme · Opus 5.5 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';
const IDLE_SCREEN = `● Done.\n\n${RULE}\n❯ \n${RULE}\n${STATUS}\n`;
const WIN = '5.5';

// The crew names its entity, so the main orchestrator is mapped from the registry; it declares
// no `tasks:` block, so its queue is the local `.agents/queue.yaml`.
const CREW = `format: 1
project: acme-web
entity: acme
session: ${SESSION}
coordinator: crew-lead
operator: crew-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: crew-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: worker
    name: ${SEAT}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
`;

// The entity's own team: its coordinator is the main orchestrator the dispatcher maps, and its
// root holds the copy of every notice addressed there.
const ENTITY = `format: 1
project: acme
entity: acme
session: acme
coordinator: head-lead
operator: head-op
workspace:
  mode: shared
seats:
  - role: coordinator
    name: head-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
  - role: operator
    name: head-op
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "${WIN}"
    launch: claude
`;

function teamWith(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

let base: string;
let root: string;
let entityRoot: string;
let home: string;
let dir: string;
let crew: TeamFile;
let clock: number;

function live(): Live {
  const agents: HerdrAgent[] = [
    { name: SEAT, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
  ];
  return {
    running: true,
    agents,
    workspaces: agents.map((one) => ({ id: one.workspace, label: one.name ?? '' })),
    screens: { 'w1:p1': IDLE_SCREEN },
  };
}

/** One dispatch pass, as the watch makes it: the pass reads the state file fresh, so a claim an
 *  earlier pass (or another process) wrote is the one this pass follows. */
function pass(extra: {
  push?: WorkPush;
  now?: Date;
  team?: TeamFile;
  live?: Live | null;
  pause?: IdleDispatchInput['pause'];
} = {}): Promise<IdleDispatchResult> {
  const team = extra.team ?? crew;
  const state = readState(dir).sessions[team.session] ?? emptySession();
  return dispatchIdleWork({
    root,
    dir,
    team,
    state,
    live: extra.live === undefined ? live() : extra.live,
    now: extra.now ?? new Date(clock),
    home,
    body: (seat) => `body for ${seat}`,
    ...(extra.push === undefined ? {} : { push: extra.push }),
    ...(extra.pause === undefined ? {} : { pause: extra.pause }),
  });
}

/** One push that refuses, recording its calls: the refusal is what produces the fallback notice
 *  without any product path that types into a seat. */
function refusing(said = 'the route refused'): { push: WorkPush; calls: WorkPushRequest[] } {
  const calls: WorkPushRequest[] = [];
  const push: WorkPush = async (request) => {
    calls.push(request);
    return { ok: false, refused: said };
  };
  return { push, calls };
}

function mailDir(seat: string, where = root): string {
  return join(where, '.agents', 'messages', seat);
}

/** The notice records themselves, never the receipts beside them. */
function notices(seat: string, where = root): string[] {
  const folder = mailDir(seat, where);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.json') && !name.endsWith('.read.json')).sort();
}

function receipts(seat: string, where = root): string[] {
  const folder = mailDir(seat, where);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith('.read.json')).sort();
}

function noticeBytes(seat: string, name: string, where = root): string {
  return readFileSync(join(mailDir(seat, where), name), 'utf8');
}

function stateBytes(): string {
  return readFileSync(join(dir, STATE_FILE), 'utf8');
}

/** The product's own reader: `team messages` over a checkout, with the synthetic home's key. */
async function readMail(where = root): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(where, { kind: 'owner' });
  const code = await runMessages([], io, { home, now: () => new Date(clock) });
  return { code, out: io.out, err: io.err };
}

const REFUSED_BODY =
  'acme-web: worker-1 is idle with takeable work but was not told directly (the route refused); nothing was typed for it';

beforeEach(() => {
  forgetIdleEpisodes();
  clock = NOW;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-reader-')));
  root = join(base, 'crew');
  entityRoot = join(base, 'entity');
  home = join(base, 'home');
  dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), CREW);
  writeFileSync(join(entityRoot, '.agents', 'team.yaml'), ENTITY);
  writeFileSync(join(dir, 'queue.yaml'), '- id: t1\n  title: "First"\n');
  upsertTeam(home, teamIdOf(root), {
    project: 'acme-web',
    entity: 'acme',
    session: SESSION,
    root,
    roster: [{ agent: 'agt_crew000000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root: entityRoot,
    roster: [{ agent: 'agt_head000000', seat: 'head-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  messageKeyOf(home);
  updateState(dir, (state) => {
    const session = emptySession();
    session.seats[SEAT] = { stage: 'ready', last_active: SINCE };
    state.sessions[SESSION] = session;
  });
  crew = teamWith(CREW);
});

afterEach(() => {
  forgetIdleEpisodes();
  rmSync(base, { recursive: true, force: true });
});

describe('the actual reader consumes a notice once', () => {
  test('a refused capture is read once, and a refilled stamp publishes a notice the old receipt does not hide', async () => {
    const { push, calls } = refusing();
    const first = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(first.pushed).toEqual([{ seat: SEAT, ok: false, refused: 'the route refused' }]);
    expect(notices('crew-lead')).toHaveLength(1);
    expect(notices('head-lead', entityRoot)).toHaveLength(1);
    const firstLead = notices('crew-lead')[0] as string;

    // The actual reader prints the body and leaves its signed receipt beside the record.
    const readOne = await readMail();
    expect(readOne.code).toBe(0);
    expect(readOne.err).toBe('');
    expect(readOne.out).toContain(REFUSED_BODY);
    expect(notices('crew-lead')).toEqual([firstLead]);
    expect(receipts('crew-lead')).toHaveLength(1);

    // A second run has nothing to show: the receipt is the product's own consume record.
    const readTwo = await readMail();
    expect(readTwo.code).toBe(0);
    expect(readTwo.out).not.toContain(REFUSED_BODY);
    expect(readTwo.out).toContain('nothing is waiting');
    expect(receipts('crew-lead')).toHaveLength(1);

    // The episode ends: a paused pass withdraws the work and prunes every claim, pushing nothing.
    const by = 'crew-lead';
    const paused = await pass({
      push,
      pause: { by, at: new Date(clock).toISOString(), reason: 'a break', stops: [] },
    });
    expect(paused.pushed).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(readState(dir).sessions[SESSION]?.idle_claims).toBeUndefined();

    // Idle again at the very same persisted stamp: a new capture, a second attempt, and its own
    // notice. The first record and its receipt are both still there.
    const second = await pass({ push });
    expect(calls).toHaveLength(2);
    expect(second.pushed[0]?.ok).toBe(false);
    const lead = notices('crew-lead');
    expect(lead).toHaveLength(2);
    expect(lead).toContain(firstLead);
    expect(notices('head-lead', entityRoot)).toHaveLength(2);
    expect(receipts('crew-lead')).toHaveLength(1);

    // The old receipt cannot hide the second capture's body: the reader serves it.
    const readThree = await readMail();
    expect(readThree.code).toBe(0);
    expect(readThree.out).toContain(REFUSED_BODY);
    expect(readThree.out).not.toContain('nothing is waiting');
    expect(receipts('crew-lead')).toHaveLength(2);
    expect(notices('crew-lead')).toHaveLength(2);
  });
});

describe('a restarted watch reads the durable claim', () => {
  test('the same claim is not pushed again, and its notice keeps one id and one body across restarts', async () => {
    const { push, calls } = refusing();
    await pass({ push });
    const [name] = notices('crew-lead');
    if (name === undefined) throw new Error('the refusal wrote no notice');
    const before = noticeBytes('crew-lead', name);
    const mainBefore = noticeBytes('head-lead', notices('head-lead', entityRoot)[0] as string, entityRoot);

    // A restart forgets every in-process memory; the claim on disk is all that is left.
    forgetIdleEpisodes();
    clock = NOW + MIN;
    const again = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(again.pushed).toEqual([]);
    // The replay found both once-records already written: that is its own statement, not an
    // inference from the folder.
    expect(again.fallback?.written).toHaveLength(2);
    expect(again.fallback?.failed).toEqual([]);
    expect(again.fallback?.missing).toEqual([]);
    expect(notices('crew-lead')).toEqual([name]);
    expect(noticeBytes('crew-lead', name)).toBe(before);
    expect(noticeBytes('head-lead', notices('head-lead', entityRoot)[0] as string, entityRoot)).toBe(mainBefore);

    // The reader still serves that one body once; nothing new was written for it to serve.
    const read = await readMail();
    expect(read.code).toBe(0);
    expect(read.out).toContain(REFUSED_BODY);
    const empty = await readMail();
    expect(empty.out).toContain('nothing is waiting');
    expect(notices('crew-lead')).toEqual([name]);
  });

  test('a capture left pending by a stop is held, then its one unknown-outcome notice survives a restart', async () => {
    const seeded = captureIdleClaim(dir, {
      session: SESSION,
      seat: SEAT,
      idle_since: SINCE,
      at: new Date(NOW - 2 * MIN),
    });
    if (seeded.kind !== 'captured') throw new Error(`the fixture captured nothing: ${seeded.kind}`);

    // No push is made for a pending capture: the attempt may already have happened.
    const { push, calls } = refusing();
    const first = await pass({ push });
    expect(calls).toEqual([]);
    expect(first.pushed).toEqual([]);
    expect(first.fallback?.written).toHaveLength(2);
    expect(notices('crew-lead')).toHaveLength(1);
    const [name] = notices('crew-lead');
    if (name === undefined) throw new Error('the unknown outcome wrote no notice');
    const before = noticeBytes('crew-lead', name);
    const claim = readState(dir).sessions[SESSION]?.idle_claims?.[SEAT];
    expect(claim).toMatchObject({ claim_id: seeded.claim.claim_id, state: 'pending', notice: 'unknown' });

    const read = await readMail();
    expect(read.code).toBe(0);
    expect(read.out).toContain(
      "worker-1's direct work request of",
    );
    expect(read.out).toContain('has no recorded outcome; the attempt is held and will not be retried in this idle episode');
    const empty = await readMail();
    expect(empty.out).toContain('nothing is waiting');

    // A crash and a later pass: the same claim, the same notice, no push, no rewrite.
    forgetIdleEpisodes();
    clock = NOW + 5 * MIN;
    const later = await pass({ push });
    expect(calls).toEqual([]);
    expect(later.pushed).toEqual([]);
    expect(notices('crew-lead')).toEqual([name]);
    expect(noticeBytes('crew-lead', name)).toBe(before);
    expect(readState(dir).sessions[SESSION]?.idle_claims?.[SEAT]).toMatchObject({
      claim_id: seeded.claim.claim_id,
      state: 'pending',
      notice: 'unknown',
    });
  });
});

describe('publication recovers without another push', () => {
  test('a main orchestrator record that could not be written is retried by a later pass, and the seat is never pushed twice', async () => {
    // The entity's mailbox cannot be created: the messages path is a file, so the writer fails.
    writeFileSync(join(entityRoot, '.agents', 'messages'), 'not a folder\n');
    const { push, calls } = refusing();

    const first = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(first.fallback?.failed).toHaveLength(1);
    expect(first.fallback?.failed?.[0]).toContain('head-lead was not told');
    expect(first.fallback?.written).toHaveLength(1);
    expect(notices('crew-lead')).toHaveLength(1);
    expect(notices('head-lead', entityRoot)).toEqual([]);

    // A restart retries the same owed notice; the lead copy already exists, the main one is
    // still unwritable, and no work is pushed again.
    forgetIdleEpisodes();
    clock = NOW + MIN;
    const second = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(second.pushed).toEqual([]);
    expect(second.fallback?.failed).toHaveLength(1);
    expect(notices('crew-lead')).toHaveLength(1);
    expect(notices('head-lead', entityRoot)).toEqual([]);

    // The obstacle goes away: the next pass writes the main copy and nothing else.
    unlinkSync(join(entityRoot, '.agents', 'messages'));
    forgetIdleEpisodes();
    clock = NOW + 2 * MIN;
    const third = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(third.pushed).toEqual([]);
    expect(third.fallback?.failed).toEqual([]);
    expect(notices('crew-lead')).toHaveLength(1);
    expect(notices('head-lead', entityRoot)).toHaveLength(1);

    // Both ids are bound to the same claim and binding, with the target's role in the hash, so
    // each target has its own stable id. Measured: the target whose write was late receives the
    // replay's wording, while the lead's earlier copy keeps the route's own words. The body is
    // honest either way; this scene pins the wording each target actually holds and does not
    // claim the two copies are byte-identical.
    const lead = notices('crew-lead')[0] as string;
    const main = notices('head-lead', entityRoot)[0] as string;
    expect(lead).toMatch(/^evt-work-push-lead-worker-1-[0-9a-f]{16}\.json$/);
    expect(main).toMatch(/^evt-work-push-main-worker-1-[0-9a-f]{16}\.json$/);
    expect(noticeBytes('crew-lead', lead)).toContain(REFUSED_BODY);
    expect(noticeBytes('head-lead', main, entityRoot)).toContain(
      'acme-web: worker-1 is idle with takeable work and its direct work request was refused earlier in this idle episode; the attempt is spent and will not be repeated',
    );
    // The main team's own reader serves that recovered body once.
    const read = await readMail(entityRoot);
    expect(read.code).toBe(0);
    expect(read.out).toContain(
      'worker-1 is idle with takeable work and its direct work request was refused earlier in this idle episode',
    );
    expect(receipts('head-lead', entityRoot)).toHaveLength(1);
    const empty = await readMail(entityRoot);
    expect(empty.out).toContain('nothing is waiting');
  });
});

describe('a reading that cannot be trusted acts on nothing', () => {
  test('a tracker source with an unknown count leaves the claim and both notices exactly as they were', async () => {
    const { push, calls } = refusing();
    await pass({ push });
    const [name] = notices('crew-lead');
    if (name === undefined) throw new Error('the refusal wrote no notice');
    const main = notices('head-lead', entityRoot)[0] as string;
    const before = stateBytes();
    const beforeLead = noticeBytes('crew-lead', name);
    const beforeMain = noticeBytes('head-lead', main, entityRoot);

    // A team that names a tracker: the count is unknown, so the reading is not actionable.
    const tracker = teamWith(`${CREW}tasks:\n  source: linear\n  linear:\n    project: acme\n    keychainService: team.linear.acme\n`);
    forgetIdleEpisodes();
    clock = NOW + MIN;
    const reading = await pass({ push, team: tracker });
    expect(reading).toEqual({ pushed: [] });
    expect(calls).toHaveLength(1);
    expect(stateBytes()).toBe(before);
    expect(notices('crew-lead')).toEqual([name]);
    expect(noticeBytes('crew-lead', name)).toBe(beforeLead);
    expect(noticeBytes('head-lead', main, entityRoot)).toBe(beforeMain);
  });

  test('a policy chain that cannot be read leaves the claim and both notices exactly as they were', async () => {
    const { push, calls } = refusing();
    await pass({ push });
    const [name] = notices('crew-lead');
    if (name === undefined) throw new Error('the refusal wrote no notice');
    const main = notices('head-lead', entityRoot)[0] as string;
    const before = stateBytes();
    const beforeLead = noticeBytes('crew-lead', name);
    const beforeMain = noticeBytes('head-lead', main, entityRoot);

    // `policies` is handed through the team file as written; a scalar is not a policy map, and
    // the threshold in force cannot be read.
    const broken = teamWith(`${CREW}policies: nope\n`);
    forgetIdleEpisodes();
    clock = NOW + MIN;
    const reading = await pass({ push, team: broken });
    expect(reading).toEqual({ pushed: [] });
    expect(calls).toHaveLength(1);
    expect(stateBytes()).toBe(before);
    expect(notices('crew-lead')).toEqual([name]);
    expect(noticeBytes('crew-lead', name)).toBe(beforeLead);
    expect(noticeBytes('head-lead', main, entityRoot)).toBe(beforeMain);
  });
});

describe('a late answer cannot land on a successor', () => {
  test('a settle whose claim was replaced answers gone and leaves the successor pending', async () => {
    let oldId = '';
    let successorId = '';
    const push: WorkPush = async () => {
      // The pass's own capture is the standing one when the route is called.
      oldId = (readState(dir).sessions[SESSION]?.idle_claims?.[SEAT] as { claim_id?: string } | undefined)?.claim_id ?? '';
      // While the route is out, the episode ends and a later pass captures the same stamp anew.
      endIdleClaims(dir, { session: SESSION, current: [] });
      const successor = captureIdleClaim(dir, {
        session: SESSION,
        seat: SEAT,
        idle_since: SINCE,
        at: new Date(clock),
      });
      if (successor.kind !== 'captured') throw new Error(`the successor captured nothing: ${successor.kind}`);
      successorId = successor.claim.claim_id;
      return { ok: false, refused: 'the route refused' };
    };

    const result = await pass({ push });
    expect(result.pushed[0]?.ok).toBe(false);
    expect(oldId).not.toBe('');
    expect(successorId).not.toBe('');
    expect(successorId).not.toBe(oldId);

    // The pass's settle carried the old claim id, so it landed on nothing; the successor stands
    // pending with its own id, an idle clock it owns, and no notice from the old attempt.
    const standing = readState(dir).sessions[SESSION]?.idle_claims?.[SEAT];
    expect(standing).toMatchObject({ claim_id: successorId, idle_since: SINCE, state: 'pending' });
    expect(standing).not.toHaveProperty('notice');

    // A restart before the successor's grace: it is held, not pushed and not announced.
    forgetIdleEpisodes();
    clock = NOW + 10_000;
    const held = await pass({ push });
    expect(held.pushed).toEqual([]);
    expect(held.fallback).toBeUndefined();
    expect(readState(dir).sessions[SESSION]?.idle_claims?.[SEAT]).toMatchObject({
      claim_id: successorId,
      state: 'pending',
    });
  });
});

describe('two dispatch processes on one episode', () => {
  test('two processes dispatching the same episode at once make exactly one push', async () => {
    const dispatchPath = join(import.meta.dir, '..', 'src', 'watch', 'dispatch.ts');
    const script = join(base, 'dispatch-child.ts');
    writeFileSync(script, `import { appendFileSync, readFileSync } from 'node:fs';
import { dispatchIdleWork, forgetIdleEpisodes } from ${JSON.stringify(dispatchPath)};
import { readState } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'state.ts'))};

const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const marker = process.argv[3];
forgetIdleEpisodes();
const state = readState(payload.dir).sessions[payload.session];
const result = await dispatchIdleWork({
  root: payload.root,
  dir: payload.dir,
  team: payload.team,
  state,
  live: payload.live,
  now: new Date(payload.now),
  home: payload.home,
  body: (seat) => 'body for ' + seat,
  push: async () => {
    appendFileSync(marker, process.pid + '\\n');
    await new Promise((done) => setTimeout(done, 150));
    return { ok: true, outcome: 'typed (unconfirmed)' };
  },
});
process.stdout.write(JSON.stringify(result.pushed));
`);
    const payload = join(base, 'payload.json');
    const marker = join(base, 'pushes.log');
    writeFileSync(payload, JSON.stringify({
      root, dir, session: SESSION, team: crew, live: live(), now: NOW, home,
    }));
    const spawn = () => Bun.spawn([process.execPath, script, payload, marker], { cwd: root });
    const runs = await Promise.all([spawn(), spawn()].map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })));
    expect(runs.map((one) => ({ code: one.code, err: one.err }))).toEqual([
      { code: 0, err: '' },
      { code: 0, err: '' },
    ]);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    // The spending process recorded its own accepted answer; the other obeyed its claim.
    expect(readState(dir).sessions[SESSION]?.idle_claims?.[SEAT]).toMatchObject({ state: 'inflight' });
    expect(notices('crew-lead')).toEqual([]);
  }, 30_000);
});

describe('an accepted wake is not sent again', () => {
  test('an accepted wake is never pushed again, and its failed pickup is announced once and stable', async () => {
    const calls: WorkPushRequest[] = [];
    const push: WorkPush = async (request) => {
      calls.push(request);
      return { ok: true, outcome: 'typed (unconfirmed)' };
    };
    const accepted = await pass({ push });
    expect(accepted.pushed).toEqual([{ seat: SEAT, ok: true, outcome: 'typed (unconfirmed)' }]);
    expect(accepted.fallback).toBeUndefined();
    expect(notices('crew-lead')).toEqual([]);
    expect(readState(dir).sessions[SESSION]?.idle_claims?.[SEAT]).toMatchObject({ state: 'inflight' });

    // A restart inside the grace: no push and no notice.
    forgetIdleEpisodes();
    clock = NOW + 30_000;
    const inside = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(inside.pushed).toEqual([]);
    expect(inside.fallback).toBeUndefined();

    // Past the grace the seat is still idle with its old clock and holds no lease: one stalled
    // notice, and still no second push.
    forgetIdleEpisodes();
    clock = NOW + 61_000;
    const stalled = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(stalled.pushed).toEqual([]);
    expect(stalled.fallback?.written).toHaveLength(2);
    expect(notices('crew-lead')).toHaveLength(1);
    const [name] = notices('crew-lead');
    if (name === undefined) throw new Error('the failed pickup wrote no notice');
    const before = noticeBytes('crew-lead', name);
    expect(before).toContain(
      'worker-1 accepted a work wake a minute ago and is still idle with no observed claim; it will not be woken again in this idle episode',
    );
    expect(readState(dir).sessions[SESSION]?.idle_claims?.[SEAT]).toMatchObject({ state: 'done', notice: 'stalled' });

    const read = await readMail();
    expect(read.code).toBe(0);
    expect(read.out).toContain('accepted a work wake a minute ago and is still idle with no observed claim');
    const empty = await readMail();
    expect(empty.out).toContain('nothing is waiting');

    // A later restart replays the same notice by the same id; nothing is rewritten or re-sent.
    forgetIdleEpisodes();
    clock = NOW + 5 * MIN;
    const later = await pass({ push });
    expect(calls).toHaveLength(1);
    expect(later.pushed).toEqual([]);
    expect(notices('crew-lead')).toEqual([name]);
    expect(noticeBytes('crew-lead', name)).toBe(before);
    expect(receipts('crew-lead')).toHaveLength(1);
  });
});
