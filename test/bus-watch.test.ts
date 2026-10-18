import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRIVILEGED_SELF_SUBSCRIPTION_RULE } from '../src/bus/kinds.ts';
import { createSequenceTracker, type SignedEventRecord } from '../src/bus/log.ts';
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

  test('refuses privileged self-subscription by a worker, logs the refusal, and raises team.policy-refused to lead and owner', async () => {
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

  test('watch subscribes first when bus is live, publishes seat.unreachable and seat.at-prompt, and falls back cleanly when no bus runs', async () => {
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

    // 2. Start the bus, publish reports from watch, and verify watch subscription receives them in sequence order.
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

    await publishWatchReportsToBus(
      root,
      'acme',
      [
        { key: 'missing:worker-1', text: 'worker-1 is missing from the session', to: 'operator' },
        { key: 'permission:op-1', text: 'op-1 is at a permission prompt', to: 'owner' },
      ],
      '2026-10-18T12:15:00.000Z',
      (r, ev) => publishToBus(r, ev),
    );

    const withBus = await syncWatchBus(root, tracker, {
      busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 500 }),
      onBusEvent: (ev) => seenEvents.push(ev),
      onBusGap: (oldest, newest) => seenGaps.push({ oldest, newest }),
    });
    expect(withBus).toBe(true);
    expect(seenEvents.map((e) => e.payload.kind)).toEqual(['seat.unreachable', 'seat.at-prompt']);
    expect(tracker.cursor).toBe(2);

    // Subsequent sync with no new events advances nothing and duplicates nothing.
    const nextSync = await syncWatchBus(root, tracker, {
      busSubscribe: (r, cursor) => subscribeBusOnce(r, { seat: 'watch', cursor }, { deadlineMs: 500 }),
      onBusEvent: (ev) => seenEvents.push(ev),
    });
    expect(nextSync).toBe(true);
    expect(seenEvents.length).toBe(2);
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
