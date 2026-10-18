import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVILEGED_SELF_SUBSCRIPTION_RULE } from '../src/bus/kinds.ts';
import { createSequenceTracker, type SignedEventRecord } from '../src/bus/log.ts';
import { reconcilePass } from '../src/bus/reconcile.ts';
import {
  busSocket,
  publishToBus,
  startBus,
  subscribeBusOnce,
  type BusHandle,
} from '../src/bus/server.ts';
import { runBus } from '../src/commands/bus.ts';
import { publishWatchReportsToBus, syncWatchBus } from '../src/commands/watch.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { registerAgent, updateAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession } from '../src/state.ts';
import type { CheckContext, Report, SeatObservation } from '../src/watch/check.ts';
import { attention as checkAttention } from '../src/watch/checks/attention.ts';
import { missing as checkMissing } from '../src/watch/checks/missing.ts';
import { providerError as checkProviderError } from '../src/watch/checks/provider-error.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { readScreen } from '../src/watch/screen.ts';

const dirs: string[] = [];
const handles: BusHandle[] = [];

const SAMPLE_TEAM_YAML = `format: 1
project: acme
coordinator: clerk
operator: op-1
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: op-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

function makeScratch(): { root: string; home: string } {
  const base = mkdtempSync(join(realpathSync('/tmp'), 'tb-'));
  dirs.push(base);
  const root = join(base, 'r');
  const home = join(base, 'h');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), SAMPLE_TEAM_YAML);
  return { root, home };
}

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop()!;
    await h.close();
  }
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe('bus socket server, privileged subscription refusal, and watch integration (RFC 002 Amendment 01 §4.2, §4.4)', () => {
  test('starts on .agents/bus.sock at mode 0600, refuses a second start as busy, publishes events, and filters by recipient', async () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    const sockPath = busSocket(root);
    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).mode & 0o777).toBe(0o600);

    // Second start while serving answers busy.
    const second = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
    });
    expect(second.kind).toBe('busy');

    // Publish a message.arrived event for worker-1.
    const pub1 = await publishToBus(root, {
      ts: '2026-10-18T12:00:00.000Z',
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'm-1',
      from: 'clerk',
      to: 'worker-1',
    });
    expect(pub1.kind).toBe('published');
    if (pub1.kind !== 'published') return;
    expect(pub1.event.payload.seq).toBe(1);

    // Subscribe as worker-1 from cursor 0: receives m-1.
    const subWorker = await subscribeBusOnce(root, { seat: 'worker-1', cursor: 0 });
    expect(subWorker.kind).toBe('events');
    if (subWorker.kind === 'events') {
      expect(subWorker.events.map((e) => e.payload.record_id)).toEqual(['m-1']);
      expect(subWorker.cursor).toBe(1);
    }

    // Subscribe as op-1 (not recipient of m-1) from cursor 0: receives 0 matching events, cursor advances to 1.
    const subOp = await subscribeBusOnce(root, { seat: 'op-1', cursor: 0 });
    expect(subOp.kind).toBe('events');
    if (subOp.kind === 'events') {
      expect(subOp.events.length).toBe(0);
      expect(subOp.cursor).toBe(1);
    }
  });

  test('a subscription resolves an agent registry id to its seat and binds a claimed pane, and a routing recipient named by id reaches that seat', async () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const agent = registerAgent(home, {
      name: 'worker-1',
      signing: { model: 'claude', version: '4.6', role: 'worker' },
      lab: 'anthropic',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(root), seat: 'worker-1', session: 'acme', pane: 's1:p3', address: null },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });

    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      // A routing word that names a seat by its registry id, as a stored declaration may.
      additiveRouting: { 'message.delivered': [agent.id] },
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    const published = await publishToBus(root, {
      ts: '2026-10-18T12:00:00.000Z',
      kind: 'message.delivered',
      session: 'acme',
      record_id: 'd-1',
      from: 'clerk',
      to: 'worker-1',
    });
    expect(published.kind).toBe('published');

    // Subscribing by the agent id, with the pane the registry holds, reaches the agent's seat.
    const byId = await subscribeBusOnce(root, { seat: agent.id, pane: 's1:p3', cursor: 0 });
    expect(byId.kind).toBe('events');
    if (byId.kind === 'events') expect(byId.events.map((e) => e.payload.record_id)).toEqual(['d-1']);

    // By plain name it is the same subscription.
    const byName = await subscribeBusOnce(root, { seat: 'worker-1', cursor: 0 });
    expect(byName.kind).toBe('events');
    if (byName.kind === 'events') expect(byName.events.map((e) => e.payload.record_id)).toEqual(['d-1']);

    // A pane that contradicts the registry, and an id no agent of this team holds, are refused at
    // the caller before any event is read.
    const stalePane = await subscribeBusOnce(root, { seat: agent.id, pane: 's9:p9', cursor: 0 });
    expect(stalePane.kind).toBe('refused');
    if (stalePane.kind === 'refused') expect(stalePane.at).toBe('caller');

    const unknownId = await subscribeBusOnce(root, { seat: 'agt_000000000000', cursor: 0 });
    expect(unknownId.kind).toBe('refused');
    if (unknownId.kind === 'refused') expect(unknownId.at).toBe('caller');

    // A retired agent no longer holds its seat: its id is refused, and the plain name still works.
    updateAgent(home, agent.id, { lifecycle: 'retired' });
    const retiredId = await subscribeBusOnce(root, { seat: agent.id, cursor: 0 });
    expect(retiredId.kind).toBe('refused');
    const stillByName = await subscribeBusOnce(root, { seat: 'worker-1', cursor: 0 });
    expect(stillByName.kind).toBe('events');
  });

  test('refuses privileged self-subscription by a worker, logs the refusal, and raises team.policy-refused to the owner only', async () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    const refused = await subscribeBusOnce(root, {
      seat: 'worker-1',
      cursor: 0,
      kinds: ['seat.at-prompt'],
    });
    expect(refused.kind).toBe('refused');
    if (refused.kind === 'refused') {
      expect(refused.at).toBe('policy');
      expect(refused.rule).toBe(PRIVILEGED_SELF_SUBSCRIPTION_RULE);
      expect(refused.eventKind).toBe('seat.at-prompt');
    }

    // Operational log records the refusal.
    const teamLog = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(teamLog).toContain(PRIVILEGED_SELF_SUBSCRIPTION_RULE);
    expect(teamLog).toContain('worker-1');

    // `owner` receives the `team.policy-refused` event (Q12 / `EVENT_ROUTING_DEFAULTS`); seats do not.
    const ownerSub = await subscribeBusOnce(root, { seat: 'owner', cursor: 0 });
    expect(ownerSub.kind).toBe('events');
    if (ownerSub.kind === 'events') {
      expect(ownerSub.events.map((e) => e.payload.kind)).toContain('team.policy-refused');
    }

    const leadSub = await subscribeBusOnce(root, { seat: 'clerk', cursor: 0 });
    expect(leadSub.kind).toBe('events');
    if (leadSub.kind === 'events') {
      expect(leadSub.events.map((e) => e.payload.kind)).not.toContain('team.policy-refused');
    }

    const workerSub = await subscribeBusOnce(root, { seat: 'worker-1', cursor: 0 });
    expect(workerSub.kind).toBe('events');
    if (workerSub.kind === 'events') {
      expect(workerSub.events.map((e) => e.payload.kind)).not.toContain('team.policy-refused');
    }
  });

  test('answers gap when subscriber buffer limit is exceeded or cursor was rotated out', async () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      bufferLimit: 2,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    for (let i = 1; i <= 3; i++) {
      await publishToBus(root, {
        ts: new Date(Date.UTC(2026, 9, 18, 12, 0, i)).toISOString(),
        kind: 'message.arrived',
        session: 'acme',
        record_id: `m-${String(i)}`,
        from: 'clerk',
        to: 'worker-1',
      });
    }

    const overBuffer = await subscribeBusOnce(root, { seat: 'worker-1', cursor: 0 });
    expect(overBuffer.kind).toBe('gap');
    if (overBuffer.kind === 'gap') {
      expect(overBuffer.oldest_seq).toBe(1);
      expect(overBuffer.newest_seq).toBe(3);
    }
  });

  test('watch subscribes first when bus is live, maps real check reports (permission, question, vendor notice, blocked, missing, provider-error/:owner), resyncs on gap, and falls back cleanly when no bus runs', async () => {
    const { root, home } = makeScratch();
    const parsed = validateTeamFile(SAMPLE_TEAM_YAML);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const tracker = createSequenceTracker(0);
    const seenEvents: SignedEventRecord[] = [];
    const seenGaps: Array<{ oldest: number; newest: number }> = [];

    // 1. No bus running: syncWatchBus returns false cleanly without throwing.
    const noBus = await syncWatchBus(root, tracker, {
      busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 200 }),
      onBusEvent: (ev) => seenEvents.push(ev),
      onBusGap: (oldest, newest) => seenGaps.push({ oldest, newest }),
    });
    expect(noBus).toBe(false);
    expect(seenEvents.length).toBe(0);

    // 2. Start the bus, build reports from the shipped checks (`attention`, `missing`, `providerError`),
    //    and verify publishWatchReportsToBus maps every real key to accepted §4.3 kinds without
    //    dropping permission/blocked or inventing a `<seat>:owner` seat.
    const started = await startBus({
      root,
      team: parsed.team,
      home,
      stderr: () => {},
      reconcileIntervalMs: 0,
      bufferLimit: 20,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    handles.push(started.handle);

    const slots: Record<string, unknown> = {};
    const ctx: CheckContext = {
      now: Date.parse('2026-10-18T12:15:00.000Z'),
      watch: parsed.team.watch,
      budgets: parsed.team.budgets,
      once: (key, text, to = 'operator') => ({ key, text, to }),
      keep: () => {},
      memory: <T>(kind: string, init: () => T): T => (slots[kind] ??= init()) as T,
    };

    const makeSeatObs = (overrides: Partial<SeatObservation>): SeatObservation => ({
      name: 'worker-1',
      cli: 'claude-code',
      vendor: 'anthropic',
      account: 'anthropic',
      quota: [],
      lead: false,
      parked: false,
      stopped: false,
      seat: parsed.team.seats[2],
      recorded: 'ready',
      identity: 'same',
      continuity: 'doubt',
      launcher: false,
      running: true,
      herdr: true,
      agent: { name: 'worker-1', pane: 's1:p3', workspace: 'w1', status: 'idle', agent: 'claude', cwd: null },
      screen: { kind: 'idle' },
      model: null,
      attention: null,
      quiet: true,
      working: false,
      prompt: false,
      history: { lastWorking: undefined, idleSince: undefined },
      liveness: { idle_lead_seconds: 300, idle_owner_seconds: 1800, blind_after_seconds: 600 },
      ...overrides,
    });

    const realReports: Report[] = [
      ...checkAttention.run(makeSeatObs({ name: 'worker-1', attention: 'permission', prompt: true }), ctx),
      ...checkAttention.run(makeSeatObs({ name: 'worker-1', attention: 'question', prompt: true }), ctx),
      ...checkAttention.run(makeSeatObs({ name: 'worker-1', attention: 'vendor notice', prompt: true }), ctx),
      ...checkAttention.run(makeSeatObs({ name: 'worker-2', attention: 'blocked', quiet: false }), ctx),
      ...checkMissing.run(makeSeatObs({ name: 'worker-3', running: false, agent: undefined }), ctx),
      ...checkProviderError.run(
        makeSeatObs({
          name: 'worker-4',
          running: true,
          working: false,
          screen: { kind: 'rate limit', reset: '5pm' },
        }),
        ctx,
      ),
      ...checkProviderError.run(
        makeSeatObs({
          name: 'worker-5',
          running: true,
          working: false,
          screen: { kind: 'provider error' },
        }),
        ctx,
      ),
    ];
    // 4 attention + 1 missing + 2*2 provider-error (operator + :owner) = 9 reports -> 7 deduplicated events.
    expect(realReports.length).toBe(9);

    await publishWatchReportsToBus(
      root,
      'acme',
      realReports,
      '2026-10-18T12:15:00.000Z',
      (r, ev) => publishToBus(r, ev),
    );

    const withBus = await syncWatchBus(root, tracker, {
      busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 500 }),
      onBusEvent: (ev) => seenEvents.push(ev),
      onBusGap: (oldest, newest) => seenGaps.push({ oldest, newest }),
    });
    expect(withBus).toBe(true);
    expect(
      seenEvents.map((e) => ({
        kind: e.payload.kind,
        seat: e.payload.seat,
        prompt: e.payload.prompt,
      })),
    ).toEqual([
      { kind: 'seat.at-prompt', seat: 'worker-1', prompt: 'permission' },
      { kind: 'seat.blocked', seat: 'worker-1', prompt: undefined },
      { kind: 'seat.at-prompt', seat: 'worker-1', prompt: 'vendor notice' },
      { kind: 'seat.blocked', seat: 'worker-2', prompt: undefined },
      { kind: 'seat.unreachable', seat: 'worker-3', prompt: undefined },
      { kind: 'seat.at-prompt', seat: 'worker-4', prompt: 'rate limit' },
      { kind: 'seat.blocked', seat: 'worker-5', prompt: undefined },
    ]);
    expect(seenEvents.some((e) => e.payload.seat?.endsWith(':owner'))).toBe(false);
    expect(tracker.cursor).toBe(7);

    // 3. Subsequent sync with no new events advances nothing and duplicates nothing.
    const nextSync = await syncWatchBus(root, tracker, {
      busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 500 }),
      onBusEvent: (ev) => seenEvents.push(ev),
    });
    expect(nextSync).toBe(true);
    expect(seenEvents.length).toBe(7);

    // 4. Pin the gap rebuild end-to-end (N6):
    //    - `gapFollower` and `fullReplayFollower` both observe `t0` (state before the gap).
    //    - During `t1` and `t2`, `fullReplayFollower` subscribes after each pair of events (staying
    //      within `bufferLimit: 2`, so it replays every event without a gap) while `gapFollower` misses
    //      both steps: `m-1` advances to `read`, `worker-1` clears its permission prompt across two
    //      passes, `m-2` arrives for `op-1`, and `op-1` hits a question prompt.
    //    - At `t2`, `gapFollower` subscribes from its pre-gap cursor (`2`), receives a real `gap`
    //      (`oldest_seq: 3, newest_seq: 6`), resets its tracker + clears `memory.active` so the pass
    //      re-announces still-true reports, rebuilds its message projection from the durable
    //      drop/receipt records on disk, and runs `pass()`.
    //    - Verify `stateBeforeGap` differs from `fullReplayState`, and `rebuiltState` equals `fullReplayState`.
    const { root: gapRoot, home: gapHome } = makeScratch();
    const gapBus = await startBus({
      root: gapRoot,
      team: parsed.team,
      home: gapHome,
      stderr: () => {},
      reconcileIntervalMs: 0,
      bufferLimit: 2,
    });
    expect(gapBus.kind).toBe('serving');
    if (gapBus.kind !== 'serving') return;
    handles.push(gapBus.handle);

    const dropDirWorker1 = join(gapRoot, '.agents', 'send-drops', 'acme', 'worker-1');
    const dropDirOp1 = join(gapRoot, '.agents', 'send-drops', 'acme', 'op-1');
    mkdirSync(dropDirWorker1, { recursive: true });
    mkdirSync(dropDirOp1, { recursive: true });

    const foldMessageEvent = (messages: Record<string, string>, ev: SignedEventRecord): void => {
      const id = ev.payload.record_id?.replace(/:(delivered|read|replied|held)$/, '');
      if (!id) return;
      if (ev.payload.kind === 'message.arrived' && !messages[id]) messages[id] = 'arrived';
      if (ev.payload.kind === 'message.delivered' && messages[id] !== 'read') messages[id] = 'delivered';
      if (ev.payload.kind === 'message.read') messages[id] = 'read';
    };

    const rebuildMessagesFromDisk = (r: string): Record<string, string> => {
      const rebuilt: Record<string, string> = {};
      const sessionDir = join(r, '.agents', 'send-drops', 'acme');
      for (const seat of ['clerk', 'op-1', 'worker-1']) {
        const dir = join(sessionDir, seat);
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).sort();
        for (const f of files) {
          if (f.includes('.')) continue;
          rebuilt[f] = 'arrived';
          if (existsSync(join(dir, `${f}.delivered`))) rebuilt[f] = 'delivered';
          if (existsSync(join(dir, `${f}.read`))) rebuilt[f] = 'read';
        }
      }
      return rebuilt;
    };

    const machineWorld = {
      loadPerCore: 1,
      memoryFree: 50,
      diskFree: 200e9,
      swapTotal: 8e9,
      swapFree: 7e9,
      swapUsed: 1e9,
    };

    const makeFollower = () => ({
      tracker: createSequenceTracker(0),
      memory: newMemory(),
      messages: {} as Record<string, string>,
      gaps: [] as Array<{ oldest: number; newest: number }>,
    });

    const gapFollower = makeFollower();
    const fullReplayFollower = makeFollower();

    const stepFollower = async (
      follower: ReturnType<typeof makeFollower>,
      nowMs: number,
      screens: Record<string, string>,
    ) => {
      const ok = await syncWatchBus(
        gapRoot,
        follower.tracker,
        {
          busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 500 }),
          onBusEvent: (ev) => foldMessageEvent(follower.messages, ev),
          onBusGap: (oldest, newest) => {
            follower.gaps.push({ oldest, newest });
            follower.messages = rebuildMessagesFromDisk(gapRoot);
          },
        },
        follower.memory,
      );
      expect(ok).toBe(true);
      const liveWorld = {
        running: true,
        agents: [
          { name: 'clerk', pane: 's1:p1', workspace: 'w1', status: 'idle', agent: 'claude', cwd: null },
          { name: 'op-1', pane: 's1:p2', workspace: 'w1', status: 'idle', agent: 'claude', cwd: null },
          { name: 'worker-1', pane: 's1:p3', workspace: 'w1', status: 'idle', agent: 'claude', cwd: null },
        ],
        workspaces: [{ id: 'w1', label: 'acme' }],
        screens,
      };
      const result = pass({
        team: parsed.team,
        state: emptySession(),
        live: liveWorld,
        machine: machineWorld,
        now: nowMs,
        memory: follower.memory,
        watch: parsed.team.watch,
        readScreen: (cli, raw) => (raw === undefined ? { kind: 'idle' } : readScreen(cli, raw)),
      });
      return {
        cursor: follower.tracker.cursor,
        active: [...follower.memory.active].sort(),
        grace: [...follower.memory.grace].sort(),
        messages: { ...follower.messages },
        reports: result.reports.map((rep) => rep.key),
      };
    };

    // t0 (before the gap): m-1 arrives for worker-1, and worker-1 is at a permission prompt (seq 1..2).
    const t0Iso = '2026-10-18T12:16:00.000Z';
    writeFileSync(join(dropDirWorker1, 'm-1'), 'from clerk\n\ntask 1\n', { mode: 0o600 });
    reconcilePass({ project: 'acme', root: gapRoot, session: 'acme', home: gapHome, now: new Date(t0Iso) });
    await publishWatchReportsToBus(
      gapRoot,
      'acme',
      checkAttention.run(makeSeatObs({ name: 'worker-1', attention: 'permission', prompt: true }), ctx),
      t0Iso,
      (r, ev) => publishToBus(r, ev),
    );
    const screensAtT0 = { 's1:p3': 'Do you want to proceed?\n❯ 1. Yes\n  2. No' };
    const stateBeforeGap = await stepFollower(gapFollower, Date.parse(t0Iso), screensAtT0);
    const fullAtT0 = await stepFollower(fullReplayFollower, Date.parse(t0Iso), screensAtT0);
    expect(stateBeforeGap).toEqual(fullAtT0);
    expect(stateBeforeGap).toEqual({
      cursor: 2,
      active: ['blocked:worker-1'],
      grace: [],
      messages: { 'm-1': 'arrived' },
      reports: ['blocked:worker-1'],
    });

    // t1 (during the gap): m-1 gets delivered + read receipts (seq 3..4), and worker-1 returns to idle.
    // `fullReplayFollower` steps at t1 (2 new events <= bufferLimit 2, so no gap); `gapFollower` misses t1.
    const t1Iso = '2026-10-18T12:17:00.000Z';
    writeFileSync(join(dropDirWorker1, 'm-1.delivered'), '2026-10-18T12:16:20.000Z\n', { mode: 0o600 });
    writeFileSync(join(dropDirWorker1, 'm-1.read'), '2026-10-18T12:16:40.000Z\n', { mode: 0o600 });
    reconcilePass({ project: 'acme', root: gapRoot, session: 'acme', home: gapHome, now: new Date(t1Iso) });
    const fullAtT1 = await stepFollower(fullReplayFollower, Date.parse(t1Iso), {});
    expect(fullAtT1).toEqual({
      cursor: 4,
      active: ['blocked:worker-1'],
      grace: ['blocked:worker-1'],
      messages: { 'm-1': 'read' },
      reports: [],
    });

    // t2 (end of gap): m-2 arrives for op-1 and op-1 hits a question prompt (seq 5..6).
    // `fullReplayFollower` steps at t2 (seq 5..6 <= bufferLimit 2, no gap; `blocked:worker-1` clears after
    // its second quiet pass). `gapFollower` now syncs from its pre-gap cursor (2), hits the real gap
    // (6 - 2 = 4 > bufferLimit 2), resets its tracker + stale flicker memory, rebuilds from disk, and runs pass().
    const t2Iso = '2026-10-18T12:18:00.000Z';
    writeFileSync(join(dropDirOp1, 'm-2'), 'from clerk\n\ntask 2\n', { mode: 0o600 });
    reconcilePass({ project: 'acme', root: gapRoot, session: 'acme', home: gapHome, now: new Date(t2Iso) });
    await publishWatchReportsToBus(
      gapRoot,
      'acme',
      checkAttention.run(makeSeatObs({ name: 'op-1', attention: 'question', prompt: true }), ctx),
      t2Iso,
      (r, ev) => publishToBus(r, ev),
    );
    const screensAtT2 = { 's1:p2': '? Which branch should we target?\n❯ 1. main\n  2. int/0.5.1\nEnter to select · ↑/↓ to navigate' };
    const fullReplayState = await stepFollower(fullReplayFollower, Date.parse(t2Iso), screensAtT2);
    const rebuiltState = await stepFollower(gapFollower, Date.parse(t2Iso), screensAtT2);

    expect(fullReplayFollower.gaps).toEqual([]);
    expect(gapFollower.gaps).toEqual([{ oldest: 3, newest: 6 }]);
    expect(stateBeforeGap).not.toEqual(fullReplayState);
    expect(rebuiltState).toEqual(fullReplayState);
    expect(rebuiltState).toEqual({
      cursor: 6,
      active: ['question:op-1'],
      grace: [],
      messages: { 'm-1': 'read', 'm-2': 'arrived' },
      reports: ['question:op-1'],
    });
  });

  test('runBus command enforces usage (2), detached/non-owner refusal (1), and clean start/stop (0)', async () => {
    const { root, home } = makeScratch();
    const errs: string[] = [];
    const baseIo = (overrides: Partial<Io> = {}): Io => ({
      cwd: root,
      env: { HOME: home },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
      stdout: () => {},
      stderr: (t) => errs.push(t),
      ...overrides,
    });

    // Usage error -> exit 2 (`bus.usage`).
    const usageCode = await runBus(['extra'], baseIo({ caller: { kind: 'owner' } }));
    expect(usageCode).toBe(2);

    // Detached caller -> exit 1 (`bus.refused`).
    const detachedCode = await runBus([], baseIo({ caller: { kind: 'owner-no-tty' }, stdinIsTTY: false, stdoutIsTTY: false }));
    expect(detachedCode).toBe(1);

    // Seat caller under herdr -> exit 1 (`bus.refused`).
    const seatCode = await runBus([], baseIo({ caller: { kind: 'seat', name: 'worker-1', pane: 's1:p1', session: 'acme' } }));
    expect(seatCode).toBe(1);

    // Owner outside herdr -> starts and stops cleanly with exit 0 (`bus.started` / `bus.stopped`).
    const cleanCode = await runBus([], baseIo({ caller: { kind: 'owner' } }), {
      home,
      reconcileIntervalMs: 0,
      stop: (end) => {
        setTimeout(end, 20);
        return () => {};
      },
    });
    expect(cleanCode).toBe(0);
    expect(existsSync(busSocket(root))).toBe(false);
  });
});
