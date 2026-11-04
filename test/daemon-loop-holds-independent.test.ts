import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import {
  sweepFallbackEscalations,
  sweepFallbackEscalationsSliced,
  type FallbackSweepResult,
} from '../src/daemon/fallback-sweep.ts';
import { probeDaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  escalatedRecordId,
  fallbackKeyOf,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';

const TEAM_YAML = `format: 1
entity: acme-org
project: acme
session: acme-dev
coordinator: crew-lead
operator: crew-lead
workspace:
  mode: shared
seats:
  - name: crew-lead
    role: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: worker-1
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - name: worker-2
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const AT = '2026-10-20T10:00:00.000Z';
const DUE = '2026-10-20T10:05:00.000Z';
const DIGEST = 'b'.repeat(64);
const CALLER = { kind: 'seat', name: 'worker-1', pane: 'fixture-pane-1', session: 'acme-dev' } as const;

type World = {
  base: string;
  root: string;
  entityRoot: string;
  home: string;
  team: TeamFile;
  ctx: FallbackContext;
  recipient: CanonicalRecipient;
};

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeWorld(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-loop-holds-')));
  dirs.push(base);
  const root = join(base, 'repo-1');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'acme-org',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'acme-org',
    entity: 'acme-org',
    session: 'acme-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return {
    base,
    root,
    entityRoot,
    home,
    team: validated.team,
    ctx: { caller: CALLER, team: validated.team, root, home, now: () => new Date(AT) },
    recipient: { team: 'acme', seat: 'worker-2', toId: 'agt_worker2', session: 'acme-dev', root },
  };
}

function addRoot(world: World, name: string): { root: string; team: TeamFile; recipient: CanonicalRecipient; ctx: FallbackContext } {
  const root = join(world.base, name);
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  upsertTeam(world.home, teamIdOf(root), {
    project: 'acme',
    entity: 'acme-org',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const recipient: CanonicalRecipient = { ...world.recipient, root };
  const ctx: FallbackContext = { caller: CALLER, team: validated.team, root, home: world.home, now: () => new Date(AT) };
  return { root, team: validated.team, recipient, ctx };
}

function factFor(recipient: CanonicalRecipient, messageId: string, over: Partial<TransportFact> = {}): TransportFact {
  return {
    recipient,
    messageId,
    recordDigest: DIGEST,
    route: 'socket',
    outcome: 'unreachable',
    at: AT,
    ms: 100,
    reason: 'the socket did not answer',
    liveRoutesRemain: false,
    ...over,
  };
}

function mailboxDir(world: World): string {
  return join(world.entityRoot, '.agents', 'messages', 'entity-lead');
}

function mailboxCount(world: World): number {
  return existsSync(mailboxDir(world)) ? readdirSync(mailboxDir(world)).length : 0;
}

function readMarkerFor(recipient: CanonicalRecipient, messageId: string): FallbackMarker {
  return JSON.parse(readFileSync(markerPathOf(recipient, messageId), 'utf8')) as FallbackMarker;
}

function verifiedEventsFor(world: World, root: string) {
  const res = readEvents(world.team.project, root, world.home);
  if (!res.ok) throw new Error(res.reason);
  return res.events;
}

function episodeLockDir(world: World, recipient: CanonicalRecipient, messageId: string): string {
  const digest = createHash('sha256').update(fallbackKeyOf(recipient, messageId)).digest('hex').slice(0, 16);
  return join(dirname(historyPath(world.team.project, recipient.root, world.home)), 'locks', `fallback-${digest}`);
}

const HOLDER_SOURCE = (stateModule: string): string => `import { existsSync, writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(stateModule)};

const [lockDir, readyPath, releasePath] = process.argv.slice(2);
withLock(
  lockDir,
  () => {
    writeFileSync(readyPath, 'held\\n');
    const deadline = Date.now() + 10_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  },
  { waitMs: 5_000 },
);
`;

function holdEpisodeLock(
  world: World,
  recipient: CanonicalRecipient,
  messageId: string,
): { readyPath: string; releasePath: string; exit: Promise<number> } {
  const scriptPath = join(world.base, `hold-lock-${messageId}.ts`);
  const readyPath = join(world.base, `holder-${messageId}.ready`);
  const releasePath = join(world.base, `holder-${messageId}.release`);
  writeFileSync(scriptPath, HOLDER_SOURCE(join(import.meta.dir, '..', 'src', 'state.ts')));
  const proc = Bun.spawn([process.execPath, scriptPath, episodeLockDir(world, recipient, messageId), readyPath, releasePath], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { readyPath, releasePath, exit: proc.exited };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not hold before the deadline');
}

describe('fix/daemon-loop-holds independent verification', () => {
  test('probe 1: no due escalation is skipped, doubled or starved across slices, including a marker arriving mid-pass and a key lock held by another process', async () => {
    const world = makeWorld();
    const root2 = addRoot(world, 'repo-2');

    for (const id of ['m-01', 'm-02', 'm-03', 'm-04']) {
      const noted = noteTransport(world.ctx, factFor(world.recipient, id));
      if (!noted.ok) throw new Error(noted.reason);
    }
    for (const id of ['r2-01', 'r2-02']) {
      const noted = noteTransport(root2.ctx, factFor(root2.recipient, id));
      if (!noted.ok) throw new Error(noted.reason);
    }

    // Hold m-02's key lock in a real child process so pass 1 meets live contention on m-02:
    const holder = holdEpisodeLock(world, world.recipient, 'm-02');
    await waitFor(() => existsSync(holder.readyPath), 5_000);

    try {
      // Fake sliceClock advances by 10 ms every call so every single work item crosses the 10 ms slice boundary.
      let fakeMs = 0;
      const sliceClock = (): number => {
        const current = fakeMs;
        fakeMs += 10;
        return current;
      };

      let pass1Yields = 0;
      let midPassPlanted = false;
      const pass1 = await sweepFallbackEscalationsSliced({
        home: world.home,
        roots: [
          { root: world.root, team: world.team },
          { root: root2.root, team: root2.team },
        ],
        now: () => new Date(DUE),
        sliceClock,
        slices: {
          sliceMs: 10,
          stopping: () => false,
          yield: async () => {
            pass1Yields += 1;
            // Mid-pass arrival during slice yield #2 (while root 1 is mid-walk):
            if (pass1Yields === 2 && !midPassPlanted) {
              midPassPlanted = true;
              const mid1 = noteTransport(world.ctx, factFor(world.recipient, 'm-mid-root1'));
              if (!mid1.ok) throw new Error(mid1.reason);
              const mid2 = noteTransport(root2.ctx, factFor(root2.recipient, 'r2-mid-root2'));
              if (!mid2.ok) throw new Error(mid2.reason);
            }
            return true;
          },
        },
      });

      expect(midPassPlanted).toBe(true);
      expect(pass1Yields).toBeGreaterThanOrEqual(8);

      // In pass 1:
      // - root 1 escalates m-01, m-03, m-04 (never starved by m-02's held lock) and defers m-02.
      // - root 2 (whose scan begins after yield #2) escalates r2-01, r2-02, AND r2-mid-root2.
      const pass1Root1 = pass1.roots[0]!.report!;
      const pass1Root2 = pass1.roots[1]!.report!;
      expect(pass1Root1.deferred.map((d) => d.messageId)).toEqual(['m-02']);
      expect(pass1Root1.escalated.map((e) => e.event.payload.record_id).sort()).toEqual(
        ['m-01', 'm-03', 'm-04'].map((id) => escalatedRecordId(world.recipient, id)).sort(),
      );
      expect(pass1Root2.deferred).toEqual([]);
      expect(pass1Root2.escalated.map((e) => e.event.payload.record_id).sort()).toEqual(
        ['r2-01', 'r2-02', 'r2-mid-root2'].map((id) => escalatedRecordId(root2.recipient, id)).sort(),
      );

      // Release m-02's lock before pass 2:
      writeFileSync(holder.releasePath, 'release\n');
      await holder.exit;

      // Pass 2 picks up both the previously lock-deferred m-02 and the mid-pass arrival m-mid-root1,
      // and never doubles any of the 6 already-escalated episodes:
      let pass2Yields = 0;
      const pass2 = await sweepFallbackEscalationsSliced({
        home: world.home,
        roots: [
          { root: world.root, team: world.team },
          { root: root2.root, team: root2.team },
        ],
        now: () => new Date(DUE),
        sliceClock,
        slices: {
          sliceMs: 10,
          stopping: () => false,
          yield: async () => {
            pass2Yields += 1;
            return true;
          },
        },
      });
      expect(pass2Yields).toBeGreaterThanOrEqual(8);
      expect(pass2.roots[0]!.report!.deferred).toEqual([]);
      expect(pass2.roots[0]!.report!.escalated.map((e) => e.event.payload.record_id).sort()).toEqual(
        ['m-02', 'm-mid-root1'].map((id) => escalatedRecordId(world.recipient, id)).sort(),
      );
      expect(pass2.roots[1]!.report!.escalated).toEqual([]);

      // Verify every single episode across both roots escalated exactly once (zero skipped, zero doubled):
      for (const id of ['m-01', 'm-02', 'm-03', 'm-04', 'm-mid-root1']) {
        expect(readMarkerFor(world.recipient, id).escalatedAt).toBe(DUE);
        const matching = verifiedEventsFor(world, world.root).filter(
          (ev) => ev.payload.record_id === escalatedRecordId(world.recipient, id),
        );
        expect(matching).toHaveLength(1);
      }
      for (const id of ['r2-01', 'r2-02', 'r2-mid-root2']) {
        expect(readMarkerFor(root2.recipient, id).escalatedAt).toBe(DUE);
        const matching = verifiedEventsFor(world, root2.root).filter(
          (ev) => ev.payload.record_id === escalatedRecordId(root2.recipient, id),
        );
        expect(matching).toHaveLength(1);
      }
      expect(mailboxCount(world)).toBe(8);
    } finally {
      writeFileSync(holder.releasePath, 'release\n');
      await holder.exit.catch(() => 0);
    }
  }, 15_000);

  test('probe 2: close stops at a slice boundary, reports nothing for a partly walked root, and daemon.close() awaits the in-flight pass before releasing ownership', async () => {
    const world = makeWorld();
    const root2 = addRoot(world, 'repo-2');

    const root1Ids = ['s-01', 's-02', 's-03', 's-04', 's-05'];
    const root2Ids = ['s-06', 's-07', 's-08'];
    for (const id of root1Ids) {
      const noted = noteTransport(world.ctx, factFor(world.recipient, id));
      if (!noted.ok) throw new Error(noted.reason);
    }
    for (const id of root2Ids) {
      const noted = noteTransport(root2.ctx, factFor(root2.recipient, id));
      if (!noted.ok) throw new Error(noted.reason);
    }

    // 2a. Deterministic slice-boundary stop via fake sliceClock after exactly 2 markers on root 1 escalate:
    let fakeMs = 0;
    const sliceClock = (): number => {
      const current = fakeMs;
      fakeMs += 10;
      return current;
    };
    let stopping = false;
    let yields = 0;
    const partial = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [
        { root: world.root, team: world.team },
        { root: root2.root, team: root2.team },
      ],
      now: () => new Date(DUE),
      sliceClock,
      slices: {
        sliceMs: 10,
        stopping: () => stopping,
        yield: async () => {
          yields += 1;
          const escalatedSoFar = root1Ids.filter(
            (id) => readMarkerFor(world.recipient, id).escalatedAt !== undefined,
          ).length;
          if (escalatedSoFar >= 2) {
            stopping = true;
            return false;
          }
          return true;
        },
      },
    });

    // Partly walked root produces no report entry, and only 2 of the 8 markers across both roots escalated:
    expect(partial.roots).toEqual([]);
    expect(yields).toBeGreaterThanOrEqual(2);
    const escalatedAfterStop = root1Ids.filter(
      (id) => readMarkerFor(world.recipient, id).escalatedAt !== undefined,
    );
    expect(escalatedAfterStop).toHaveLength(2);
    for (const id of root2Ids) {
      expect(readMarkerFor(root2.recipient, id).escalatedAt).toBeUndefined();
    }
    expect(mailboxCount(world)).toBe(2);

    // Resuming on a later pass finishes the remaining 6 markers without doubling the first 2:
    stopping = false;
    const resumed = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [
        { root: world.root, team: world.team },
        { root: root2.root, team: root2.team },
      ],
      now: () => new Date(DUE),
      sliceClock,
      slices: {
        sliceMs: 10,
        stopping: () => false,
        yield: async () => true,
      },
    });
    expect(resumed.roots[0]!.report!.escalated).toHaveLength(3);
    expect(resumed.roots[1]!.report!.escalated).toHaveLength(3);
    expect(mailboxCount(world)).toBe(8);

    // 2b. Live daemon close() mid-walk stops at the next slice boundary and awaits sweepRun before resolving:
    const liveWorld = makeWorld();
    const liveRoot2 = addRoot(liveWorld, 'repo-live-2');
    for (let i = 0; i < 60; i += 1) {
      const id = `live-${String(i).padStart(3, '0')}`;
      const n1 = noteTransport(liveWorld.ctx, factFor(liveWorld.recipient, id));
      if (!n1.ok) throw new Error(n1.reason);
      const n2 = noteTransport(liveRoot2.ctx, factFor(liveRoot2.recipient, id));
      if (!n2.ok) throw new Error(n2.reason);
    }

    const started = await startMachineDaemon({
      home: liveWorld.home,
      roots: [liveWorld.root, liveRoot2.root],
      version: '0.5.12-close-slice-test',
      heartbeatMs: 15,
      now: () => new Date(DUE),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;

    // Wait until the beat's sliced pass has escalated at least 1 marker (so sweepRun is mid-walk),
    // then immediately close the daemon:
    await waitFor(() => mailboxCount(liveWorld) >= 1, 5_000);
    await started.daemon.close();

    const mailboxesAtClose = mailboxCount(liveWorld);
    const eventsAtClose =
      verifiedEventsFor(liveWorld, liveWorld.root).length +
      verifiedEventsFor(liveWorld, liveRoot2.root).length;

    // Stopped mid-backlog at a slice boundary rather than walking all 120 episodes to the end:
    expect(mailboxesAtClose).toBeGreaterThanOrEqual(1);
    expect(mailboxesAtClose).toBeLessThan(120);

    // Because close() awaited sweepRun before releasing ownership, zero writes land after close() resolves:
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mailboxCount(liveWorld)).toBe(mailboxesAtClose);
    expect(
      verifiedEventsFor(liveWorld, liveWorld.root).length +
        verifiedEventsFor(liveWorld, liveRoot2.root).length,
    ).toBe(eventsAtClose);
  }, 20_000);

  test('probe 3: health probes at the 500 ms budget all answer under a several-root due backlog while escalations advance', async () => {
    const world = makeWorld();
    const r2 = addRoot(world, 'repo-2');
    const r3 = addRoot(world, 'repo-3');
    const r4 = addRoot(world, 'repo-4');
    const checkouts = [
      { root: world.root, team: world.team, ctx: world.ctx, recipient: world.recipient },
      r2,
      r3,
      r4,
    ];

    const failedAt = new Date(Date.now() - 301_000).toISOString();
    for (const one of checkouts) {
      const ctx = { ...one.ctx, now: () => new Date(failedAt) };
      for (let i = 0; i < 150; i += 1) {
        const noted = noteTransport(ctx, factFor(one.recipient, `backlog-${String(i)}`, { at: failedAt }));
        if (!noted.ok) throw new Error(noted.reason);
      }
    }

    const started = await startMachineDaemon({
      home: world.home,
      roots: checkouts.map((c) => c.root),
      version: '0.5.12-probe-budget-test',
      heartbeatMs: 25,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const until = Date.now() + 2_000;
      const missed: string[] = [];
      let answeredCount = 0;
      while (Date.now() < until) {
        // Default timeoutMs in probeDaemonHealth is 500 ms:
        const probe = await probeDaemonHealth(started.daemon.socketPath);
        if (probe.kind !== 'answered') {
          missed.push(probe.kind === 'unanswered' ? probe.reason : probe.error.code);
        } else {
          answeredCount += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(missed).toEqual([]);
      expect(answeredCount).toBeGreaterThan(10);
      // Confirm the sliced fallback pass actively escalated due markers while answering probes:
      expect(mailboxCount(world)).toBeGreaterThan(0);
    } finally {
      await started.daemon.close();
    }
  }, 25_000);

  test('probe 4: the sliced result equals the one-shot result across due, settled, future, unreadable, retirement and lock-reclaim items', async () => {
    const world = makeWorld();
    const root2 = addRoot(world, 'repo-2');

    for (const target of [
      { ctx: world.ctx, recipient: world.recipient, root: world.root },
      { ctx: root2.ctx, recipient: root2.recipient, root: root2.root },
    ]) {
      // 3 due episodes:
      for (const id of ['due-1', 'due-2', 'due-3']) {
        const noted = noteTransport(target.ctx, factFor(target.recipient, id));
        if (!noted.ok) throw new Error(noted.reason);
      }
      // 2 settled (delivered) episodes (eligible for retirement):
      for (const id of ['del-1', 'del-2']) {
        const noted = noteTransport(
          target.ctx,
          factFor(target.recipient, id, { outcome: 'delivered', route: 'native' }),
        );
        if (!noted.ok) throw new Error(noted.reason);
      }
      // 1 future (not yet due) episode:
      const futureCtx: FallbackContext = { ...target.ctx, now: () => new Date(DUE) };
      const future = noteTransport(futureCtx, factFor(target.recipient, 'future-1', { at: DUE }));
      if (!future.ok) throw new Error(future.reason);

      // 1 unreadable marker file:
      const corruptPath = markerPathOf(target.recipient, 'corrupt-1');
      mkdirSync(dirname(corruptPath), { recursive: true });
      writeFileSync(corruptPath, '{not-valid-json');

      // 1 aged empty lock folder to reclaim:
      const staleLock = episodeLockDir(world, target.recipient, 'stale-lock-1');
      mkdirSync(staleLock, { recursive: true });
      const oldDate = new Date(Date.parse(DUE) - 60_000);
      utimesSync(staleLock, oldDate, oldDate);
    }

    // Snapshot the populated world so one-shot and sliced runs execute against the exact same paths and state:
    const snapshotDir = realpathSync(mkdtempSync(join(tmpdir(), 'team-loop-snapshot-')));
    dirs.push(snapshotDir);
    const savedBase = join(snapshotDir, 'base');
    cpSync(world.base, savedBase, { recursive: true, preserveTimestamps: true });

    const retireOptions = {
      limit: 64,
      lockWaitMs: 0,
      youngMs: 1_000,
    };

    const oneShot = sweepFallbackEscalations({
      home: world.home,
      roots: [
        { root: world.root, team: world.team },
        { root: root2.root, team: root2.team },
      ],
      now: () => new Date(DUE),
      retire: retireOptions,
    });

    // Restore exact pre-sweep filesystem state at the identical path:
    rmSync(world.base, { recursive: true, force: true });
    cpSync(savedBase, world.base, { recursive: true, preserveTimestamps: true });
    const oldDate = new Date(Date.parse(DUE) - 60_000);
    for (const recipient of [world.recipient, root2.recipient]) {
      const staleLock = episodeLockDir(world, recipient, 'stale-lock-1');
      utimesSync(staleLock, oldDate, oldDate);
    }

    // Fake sliceClock forces a yield at every single work item across validation, escalation, retirement, and reclaim:
    let fakeMs = 0;
    let yields = 0;
    const sliced = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [
        { root: world.root, team: world.team },
        { root: root2.root, team: root2.team },
      ],
      now: () => new Date(DUE),
      retire: retireOptions,
      sliceClock: () => {
        const nowVal = fakeMs;
        fakeMs += 10;
        return nowVal;
      },
      slices: {
        sliceMs: 10,
        stopping: () => false,
        yield: async () => {
          yields += 1;
          return true;
        },
      },
    });

    expect(yields).toBeGreaterThanOrEqual(20);
    expect(sliced).toEqual(oneShot);
    expect(sliced.roots[0]!.report!.escalated).toHaveLength(3);
    expect(sliced.roots[1]!.report!.escalated).toHaveLength(3);
    expect(sliced.roots[0]!.retirement!.retired).toHaveLength(5);
    expect(sliced.roots[1]!.retirement!.retired).toHaveLength(5);
    expect(sliced.roots[0]!.reclaim!.reclaimed).toBe(1);
    expect(sliced.roots[1]!.reclaim!.reclaimed).toBe(1);
  });
});
