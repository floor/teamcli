// The daemon fallback sweep's focused fixtures: the heartbeat's one pass fires an episode exactly
// at its durable due instant (never before, never twice), leaves one event and one mailbox, a
// restart resumes from the marker alone, a delivery before the due instant cancels the
// escalation, a root whose team file does not validate is refused and swept nothing, a key lock
// another holder keeps defers the episode to a later tick instead of stalling the heartbeat, and
// close stops the sweep with the heartbeat. Every home is a synthetic tmp directory.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readEvents } from '../src/bus/log.ts';
import { messageFile, recordDir } from '../src/commands/messages.ts';
import { serveChoresChild } from '../src/daemon/chores/child.ts';
import { createFallbackPass } from '../src/daemon/chores/fallback.ts';
import type { ChoresChildMessage } from '../src/daemon/chores/protocol.ts';
import { sweepFallbackEscalations, sweepFallbackEscalationsSliced } from '../src/daemon/fallback-sweep.ts';
import { probeDaemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { daemonLogPath } from '../src/daemon/paths.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  escalatedRecordId,
  escalationMailboxId,
  fallbackKeyOf,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { historyPath } from '../src/send/history.ts';
import { RECORD_KIND, signRecord, writeRecord } from '../src/send/record.ts';
import { LOCK_FILE } from '../src/state.ts';

const TEAM_YAML = `format: 1
entity: floor
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
const DIGEST = 'a'.repeat(64);
const CALLER = { kind: 'seat', name: 'worker-1', pane: 'fixture-pane-1', session: 'acme-dev' } as const;

type World = {
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
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-fallback-sweep-')));
  dirs.push(base);
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'floor',
    entity: 'floor',
    session: 'floor-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });

  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return {
    root,
    entityRoot,
    home,
    team: validated.team,
    ctx: { caller: CALLER, team: validated.team, root, home, now: () => new Date(AT) },
    recipient: { team: 'acme', seat: 'worker-2', toId: 'agt_worker2', session: 'acme-dev', root },
  };
}

function fact(world: World, over: Partial<TransportFact> = {}): TransportFact {
  return {
    recipient: world.recipient,
    messageId: 'm-001',
    recordDigest: DIGEST,
    route: 'socket',
    outcome: 'unreachable',
    at: AT,
    ms: 120,
    reason: 'the socket did not answer',
    liveRoutesRemain: false,
    ...over,
  };
}

function sweepAt(world: World, at: string, roots?: readonly (string | { root: string; team: TeamFile })[]) {
  return sweepFallbackEscalations({
    home: world.home,
    roots: roots ?? [{ root: world.root, team: world.team }],
    now: () => new Date(at),
  }).roots[0]!;
}

function mailboxDir(world: World): string {
  return join(world.entityRoot, '.agents', 'messages', 'entity-lead');
}

/** One more hosted checkout under the same home and base: one beat sweeps every inline root it
 *  hosts, so a scene that measures that beat's own turn needs more than the first world. */
function addRoot(world: World, name: string): { root: string; team: TeamFile } {
  const base = dirname(world.root);
  const root = join(base, name);
  const entityRoot = join(base, `${name}-entity`);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  upsertTeam(world.home, teamIdOf(root), {
    project: 'acme',
    entity: 'floor',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(world.home, teamIdOf(entityRoot), {
    project: 'floor',
    entity: 'floor',
    session: 'floor-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  return { root, team: validated.team };
}

/** Plants `each` already-due transport facts on every checkout: the beat's pass has to walk them
 *  all, and one marker's escalation is the pass's heaviest work item. */
function plantDueBacklog(
  world: World,
  checkouts: ReadonlyArray<{ root: string; team: TeamFile }>,
  each: number,
): void {
  const failedAt = new Date(Date.now() - 301_000).toISOString();
  for (const one of checkouts) {
    const ctx: FallbackContext = {
      caller: CALLER,
      team: one.team,
      root: one.root,
      home: world.home,
      now: () => new Date(failedAt),
    };
    const recipient: CanonicalRecipient = { ...world.recipient, root: one.root };
    for (let index = 0; index < each; index += 1) {
      const noted = noteTransport(ctx, {
        recipient,
        messageId: `backlog-${String(index)}`,
        recordDigest: DIGEST,
        route: 'socket',
        outcome: 'unreachable',
        at: failedAt,
        ms: 120,
        reason: 'the socket did not answer',
        liveRoutesRemain: false,
      });
      if (!noted.ok) throw new Error(noted.reason);
    }
  }
}

function mailboxCount(world: World): number {
  return existsSync(mailboxDir(world)) ? readdirSync(mailboxDir(world)).length : 0;
}

function verifiedEvents(world: World, root = world.root, project = world.team.project) {
  const res = readEvents(project, root, world.home);
  if (!res.ok) throw new Error(res.reason);
  return res.events;
}

function readMarker(world: World, messageId = 'm-001'): FallbackMarker {
  return JSON.parse(readFileSync(markerPathOf(world.recipient, messageId), 'utf8')) as FallbackMarker;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not hold before the deadline');
}

function escalationEvents(world: World, messageId = 'm-001') {
  return verifiedEvents(world).filter((event) => event.payload.record_id === escalatedRecordId(world.recipient, messageId));
}

function daemonLog(world: World): string {
  const path = daemonLogPath(world.home);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The module's key-lock directory for one episode: `fallback-<16 hex of the canonical key>`.
 *  A fixture that holds this lock must hold the same one `escalateDue` takes; if the derivation
 *  drifts the episode escalates while "held" and the test fails loudly. */
function episodeLockDir(world: World, messageId = 'm-001'): string {
  const digest = createHash('sha256').update(fallbackKeyOf(world.recipient, messageId)).digest('hex').slice(0, 16);
  return join(dirname(historyPath(world.team.project, world.root, world.home)), 'locks', `fallback-${digest}`);
}

/** A real second process that takes the episode's key lock and holds it until the fixture says
 *  release. It reports readiness from inside the lock, so the test's first daemon tick always
 *  meets a live holder. */
const HOLDER_SOURCE = (stateModule: string): string => `import { existsSync, writeFileSync } from 'node:fs';
import { withLock } from ${JSON.stringify(stateModule)};

const [lockDir, readyPath, releasePath] = process.argv.slice(2);
withLock(
  lockDir,
  () => {
    writeFileSync(readyPath, 'held\\n');
    const deadline = Date.now() + 10_000;
    while (!existsSync(releasePath) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  },
  { waitMs: 5_000 },
);
`;

function holdEpisodeLock(world: World): { readyPath: string; releasePath: string; exit: Promise<number> } {
  const base = dirname(world.root);
  const scriptPath = join(base, 'hold-fallback-lock.ts');
  const readyPath = join(base, 'holder.ready');
  const releasePath = join(base, 'holder.release');
  writeFileSync(scriptPath, HOLDER_SOURCE(join(import.meta.dir, '..', 'src', 'state.ts')));
  const proc = Bun.spawn([process.execPath, scriptPath, episodeLockDir(world), readyPath, releasePath], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { readyPath, releasePath, exit: proc.exited };
}

describe('the daemon fallback sweep', () => {
  test('fires once at the durable due instant, with one event and one mailbox', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    const early = sweepAt(world, new Date(due - 1).toISOString());
    expect(early.why).toBeNull();
    expect(early.report!.escalated).toHaveLength(0);
    expect(early.report!.scanned).toBe(1);
    expect(mailboxCount(world)).toBe(0);

    const fired = sweepAt(world, new Date(due).toISOString());
    expect(fired.why).toBeNull();
    expect(fired.report!.refused).toHaveLength(0);
    expect(fired.report!.escalated).toHaveLength(1);
    const entry = fired.report!.escalated[0]!;
    expect(entry.event.payload.record_id).toBe(escalatedRecordId(world.recipient, 'm-001'));
    expect(entry.event.payload.to).toBe('entity-lead');
    expect(entry.event.payload.from).toBe('worker-1');
    expect(entry.mailbox).toBe(messageFile(world.entityRoot, 'entity-lead', escalationMailboxId(world.recipient, 'm-001')));
    expect(mailboxCount(world)).toBe(1);
    expect(verifiedEvents(world)).toHaveLength(2);
    expect(readMarker(world).escalatedAt).toBe(new Date(due).toISOString());

    const again = sweepAt(world, new Date(due + 60_000).toISOString());
    expect(again.report!.escalated).toHaveLength(0);
    expect(mailboxCount(world)).toBe(1);
    expect(verifiedEvents(world)).toHaveLength(2);
  });

  test('a restart resumes a due escalation from the marker alone', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    const beforeRestart = sweepAt(world, new Date(due - 1_000).toISOString());
    expect(beforeRestart.report!.escalated).toHaveLength(0);

    // A new process shares nothing with the pass above but the home and the durable marker.
    const restarted = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(due),
    });
    expect(restarted.roots[0]!.report!.escalated).toHaveLength(1);
    expect(restarted.roots[0]!.report!.escalated[0]!.event.payload.record_id).toBe(
      escalatedRecordId(world.recipient, 'm-001'),
    );
    expect(mailboxCount(world)).toBe(1);
  });

  test('a delivery before the due instant cancels the escalation', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = Date.parse(first.dueAt!);

    const delivered = noteTransport(
      world.ctx,
      fact(world, { outcome: 'delivered', route: 'native', at: new Date(due - 1_000).toISOString(), liveRoutesRemain: false }),
    );
    if (!delivered.ok) throw new Error(delivered.reason);
    expect(delivered.state).toBe('delivered');

    const swept = sweepAt(world, new Date(due).toISOString());
    expect(swept.report!.escalated).toHaveLength(0);
    expect(mailboxCount(world)).toBe(0);
    expect(verifiedEvents(world)).toHaveLength(1);
    expect(readMarker(world).status).toBe('delivered');
    expect(readMarker(world).escalatedAt).toBeUndefined();
  });

  test('a root whose team file does not validate is refused and swept nothing', () => {
    const world = makeWorld();
    const bare = join(world.root, '..', 'not-a-team');
    mkdirSync(join(bare, '.agents'), { recursive: true });

    const out = sweepFallbackEscalations({ home: world.home, roots: [bare], now: () => new Date(AT) });
    expect(out.roots[0]!.root).toBe(bare);
    expect(out.roots[0]!.report).toBeNull();
    expect(out.roots[0]!.why).not.toBe('');
    expect(existsSync(mailboxDir(world))).toBe(false);
  });

  test('the heartbeat sweeps due episodes and close stops the sweep', async () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = new Date(Date.parse(first.dueAt!)).toISOString();

    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      version: '0.5.3-fallback-sweep-test',
      heartbeatMs: 10,
      now: () => new Date(due),
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    const escalations = (messageId: string) =>
      verifiedEvents(world).filter((event) => event.payload.record_id === escalatedRecordId(world.recipient, messageId));
    try {
      await waitFor(() => mailboxCount(world) === 1 && escalations('m-001').length === 1, 2_000);
      expect(escalations('m-001')).toHaveLength(1);
      expect(readMarker(world).escalatedAt).toBe(new Date(due).toISOString());
    } finally {
      await started.daemon.close();
    }

    // The interval is gone with the daemon: a second due episode written after close stays
    // un-escalated however long the process outlives the close.
    const second = noteTransport(world.ctx, fact(world, { messageId: 'm-002', at: due }));
    if (!second.ok) throw new Error(second.reason);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mailboxCount(world)).toBe(1);
    expect(escalations('m-002')).toHaveLength(0);
    const marker = readMarker(world, 'm-002');
    expect(marker.dueAt).toBe(new Date(Date.parse(due) + 300_000).toISOString());
    expect(marker.escalatedAt).toBeUndefined();
  });

  test('a key lock another live holder keeps defers the episode, never waits on it', () => {
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const due = new Date(Date.parse(first.dueAt!)).toISOString();

    const lockDir = episodeLockDir(world);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, LOCK_FILE), `${String(process.pid)}\n`);
    const began = Date.now();
    const busy = sweepAt(world, due);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(busy.why).toBeNull();
    expect(busy.report!.deferred).toHaveLength(1);
    expect(busy.report!.deferred[0]!.messageId).toBe('m-001');
    expect(busy.report!.escalated).toHaveLength(0);
    expect(busy.report!.refused).toHaveLength(0);
    expect(mailboxCount(world)).toBe(0);
    expect(readMarker(world).escalatedAt).toBeUndefined();

    // The holder is done: the next pass fires the same episode exactly once.
    unlinkSync(join(lockDir, LOCK_FILE));
    const freed = sweepAt(world, due);
    expect(freed.report!.deferred).toHaveLength(0);
    expect(freed.report!.escalated).toHaveLength(1);
    expect(freed.report!.escalated[0]!.event.payload.record_id).toBe(escalatedRecordId(world.recipient, 'm-001'));
    expect(mailboxCount(world)).toBe(1);
  });

  test('an episode with nothing to do is passed over without taking its key lock', () => {
    // Every heartbeat runs this pass on the daemon's event loop. A settled or not-yet-due episode
    // is read and skipped; it is never locked, so a held lock does not even defer it, and the
    // health probe is not starved by hundreds of settled markers.
    const world = makeWorld();
    const first = noteTransport(world.ctx, fact(world));
    if (!first.ok) throw new Error(first.reason);
    const early = new Date(Date.parse(first.dueAt!) - 1_000).toISOString();
    const lockDir = episodeLockDir(world);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, LOCK_FILE), `${String(process.pid)}\n`);
    const pass = sweepAt(world, early);
    expect(pass.report!.deferred).toHaveLength(0);
    expect(pass.report!.escalated).toHaveLength(0);
    expect(pass.report!.scanned).toBe(1);
    expect(readMarker(world).escalatedAt).toBeUndefined();
    unlinkSync(join(lockDir, LOCK_FILE));
  });

  test('a probe answers within the product budget while the beat sweeps a due backlog on several roots', async () => {
    // A root a chores fleet does not host is swept on the daemon's own beat. A backlog of due
    // episodes over several roots used to run as one synchronous turn: the health probe's own
    // 500 ms timer could not even fire until the pass was over. The pass now walks a slice at a
    // time, so probes land between slices and every one answers at the product's budget.
    const world = makeWorld();
    const checkouts = [
      { root: world.root, team: world.team },
      addRoot(world, 'repo-2'),
      addRoot(world, 'repo-3'),
      addRoot(world, 'repo-4'),
    ];
    plantDueBacklog(world, checkouts, 150);

    const started = await startMachineDaemon({
      home: world.home,
      roots: checkouts.map((one) => one.root),
      version: '0.5.12-beat-slice-test',
      heartbeatMs: 25,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The product's own budget: probeDaemonHealth's default is 500 ms.
      const until = Date.now() + 2_000;
      const missed: string[] = [];
      while (Date.now() < until) {
        const probe = await probeDaemonHealth(started.daemon.socketPath);
        if (probe.kind !== 'answered') missed.push(probe.kind === 'unanswered' ? probe.reason : probe.error.code);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(missed).toEqual([]);
    } finally {
      await started.daemon.close();
    }
  }, 20_000);

  test('a lock held by another process defers the escalation without stalling the heartbeat', async () => {
    const world = makeWorld();
    const failedAt = new Date(Date.now() - 301_000).toISOString();
    const first = noteTransport(world.ctx, fact(world, { at: failedAt }));
    if (!first.ok) throw new Error(first.reason);

    const holder = holdEpisodeLock(world);
    await waitFor(() => existsSync(holder.readyPath), 5_000);

    const started = await startMachineDaemon({
      home: world.home,
      roots: [world.root],
      version: '0.5.3-fallback-sweep-hold-test',
      heartbeatMs: 10,
    });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // Health answers and the heartbeat keeps moving while the message lock is held: with a
      // blocking lock wait this probe would time out behind it.
      const probe = await probeDaemonHealth(started.daemon.socketPath);
      expect(probe.kind).toBe('answered');
      const firstBeat = started.daemon.health().heartbeatAt;
      await waitFor(() => started.daemon.health().heartbeatAt !== firstBeat, 1_000);

      expect(mailboxCount(world)).toBe(0);
      expect(escalationEvents(world)).toHaveLength(0);
      expect(readMarker(world).escalatedAt).toBeUndefined();
      // Ordinary contention is deferred quietly: no refusal and no sweep line.
      expect(daemonLog(world)).not.toContain('fallback sweep');

      // Releasing the lock lets a later existing tick fire the escalation exactly once.
      writeFileSync(holder.releasePath, 'release\n');
      await holder.exit;
      await waitFor(() => mailboxCount(world) === 1, 5_000);
      expect(escalationEvents(world)).toHaveLength(1);
      expect(readMarker(world).escalatedAt).not.toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(mailboxCount(world)).toBe(1);
      expect(escalationEvents(world)).toHaveLength(1);
      expect(countOf(daemonLog(world), 'escalated 1')).toBe(1);
    } finally {
      writeFileSync(holder.releasePath, 'release\n');
      await holder.exit.catch(() => 0);
      await started.daemon.close();
    }
  });

  test('the sliced pass reads its budget and answers what the one-shot pass answers', async () => {
    const world = makeWorld();
    // Settled episodes: the two passes write nothing, so their reports are compared directly.
    for (const id of ['m-101', 'm-102', 'm-103', 'm-104']) {
      const noted = noteTransport(world.ctx, fact(world, { messageId: id, outcome: 'delivered', route: 'native' }));
      if (!noted.ok) throw new Error(noted.reason);
    }
    const input = {
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
    };
    const oneShot = sweepFallbackEscalations(input);
    expect(oneShot.roots[0]!.report!.scanned).toBe(4);

    // The injected clock moves 1000 ms per reading, so the budget passes once per work item and
    // the child's yield lands at the boundary the budget names — the test chooses the instant,
    // never the machine's load.
    const clock = { at: 0 };
    const sliceClock = (): number => {
      const value = clock.at;
      clock.at += 1000;
      return value;
    };
    let yields = 0;
    const sliced = await sweepFallbackEscalationsSliced({
      ...input,
      sliceClock,
      slices: {
        sliceMs: 10,
        stopping: () => false,
        yield: async () => {
          yields += 1;
          return true;
        },
      },
    });
    expect(yields).toBeGreaterThan(0);
    expect(sliced).toEqual(oneShot);

    // The same clock with a budget wider than the whole store: no boundary is reached, and the
    // walk is the one-shot pass again. This is the reading that the budget word is what gates it.
    clock.at = 0;
    let wideYields = 0;
    const wide = await sweepFallbackEscalationsSliced({
      ...input,
      sliceClock,
      slices: {
        sliceMs: 1_000_000_000,
        stopping: () => false,
        yield: async () => {
          wideYields += 1;
          return true;
        },
      },
    });
    expect(wideYields).toBe(0);
    expect(wide).toEqual(oneShot);
  });

  test('a stop at a boundary closes the walk with no report for the root', async () => {
    const world = makeWorld();
    for (const id of ['m-201', 'm-202', 'm-203', 'm-204']) {
      const noted = noteTransport(world.ctx, fact(world, { messageId: id, outcome: 'delivered', route: 'native' }));
      if (!noted.ok) throw new Error(noted.reason);
    }
    const clock = { at: 0 };
    const sliceClock = (): number => {
      const value = clock.at;
      clock.at += 1000;
      return value;
    };
    let yields = 0;
    let stopping = false;
    const sliced = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      sliceClock,
      slices: {
        sliceMs: 10,
        stopping: () => stopping,
        yield: async () => {
          yields += 1;
          stopping = true;
          return false;
        },
      },
    });
    // The first boundary is the stop: the walk leaves there, and the root is reported not at all,
    // because a stopping child writes no frame and the next child resumes from the markers.
    expect(yields).toBe(1);
    expect(sliced.roots).toEqual([]);
    expect(sliced.at).toBe(AT);
  });

  test('a synthetic send-drops store whose drainDeferredNotes step outlasts sliceMs still emits a heartbeat within one beat', async () => {
    const world = makeWorld();
    const dropDir = recordDir(world.root, world.recipient.session, world.recipient.seat);
    mkdirSync(dropDir, { recursive: true });
    const stageNote = (index: number): string => {
      const id = `m-note-${String(index).padStart(4, '0')}`;
      const record = signRecord(
        {
          kind: RECORD_KIND,
          id,
          to: world.recipient.seat,
          to_id: world.recipient.toId,
          root: world.root,
          session: world.recipient.session,
          at: AT,
          body: `from: worker-1\n\nhello ${id}\n`,
          from: 'worker-1',
          from_id: null,
          rule: 'a teammate in the same session',
          thread: id,
        },
        world.home,
      );
      const written = writeRecord(dropDir, record);
      if (!written.ok) throw new Error(written.reason);
      const recordDigest = createHash('sha256').update(readFileSync(written.path)).digest('hex');
      const notePath = join(dropDir, `.fallback-note-${index.toString(16).padStart(16, '0')}.json`);
      writeFileSync(
        notePath,
        `${JSON.stringify({
          format: 1,
          sender: 'seat:worker-1',
          fact: fact(world, { messageId: id, recordDigest }),
        })}\n`,
      );
      return notePath;
    };

    // Seed 64 signed deferred notes plus a wider send-drops directory so one drainDeferredNotes
    // step outlasts both sliceMs and beatMs on a single synchronous turn.
    const notePaths: string[] = [];
    for (let i = 0; i < 64; i += 1) notePaths.push(stageNote(i));
    for (let i = 64; i < 320; i += 1) {
      writeFileSync(join(dropDir, `extra-drop-${String(i).padStart(4, '0')}`), 'noop\n');
    }

    // 1. Chores child heartbeat check: while drainDeferredNotes drains the 64 notes under a 5 ms
    // slice budget and a 10 ms beat, the child yields inside drainDeferredNotes and emits a
    // heartbeat within one beat while deferred notes are still being drained.
    const beatMs = 10;
    const sliceMs = 5;
    const lines: { atMs: number; notesRemaining: number; message: ChoresChildMessage }[] = [];
    const stdout = {
      write(chunk: string) {
        for (const raw of chunk.split('\n')) {
          if (raw.trim() === '') continue;
          const message = JSON.parse(raw) as ChoresChildMessage;
          const notesRemaining =
            message.type === 'heartbeat' && message.busy === 'chores'
              ? notePaths.filter((path) => existsSync(path)).length
              : 0;
          lines.push({ atMs: performance.now(), notesRemaining, message });
        }
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const stdin = new PassThrough();
    const config = {
      version: 1 as const,
      home: world.home,
      beatMs,
      sliceMs,
      since: AT,
      routes: [{ root: world.root, team: 'acme', session: 'acme-dev', teamFile: world.team }],
    };
    const served = serveChoresChild({
      config,
      stdin,
      stdout,
      pass: createFallbackPass(config),
    });
    try {
      const tickAtMs = performance.now();
      stdin.write(`${JSON.stringify({ type: 'tick', id: '1', at: AT })}\n`);
      await waitFor(() => lines.some((entry) => entry.message.type === 'pass'), 5_000);
      const passAtMs = lines.find((entry) => entry.message.type === 'pass')!.atMs;
      const busyBeats = lines.filter(
        (entry) =>
          entry.atMs >= tickAtMs &&
          entry.atMs <= passAtMs &&
          entry.message.type === 'heartbeat' &&
          entry.message.busy === 'chores',
      );
      expect(busyBeats.length).toBeGreaterThanOrEqual(1);
      expect(busyBeats[0]!.notesRemaining).toBeGreaterThan(0);
      expect(notePaths.filter((path) => existsSync(path))).toHaveLength(0);
    } finally {
      stdin.write(`${JSON.stringify({ type: 'stop', why: 'the test is done' })}\n`);
    }
    expect(await served).toBe(0);

    // 2. Deterministic clock-driven check: stopping at an intra-step boundary inside
    // drainDeferredNotes leaves the remaining deferred notes for the next pass.
    const partialWorld = makeWorld();
    const partialDropDir = recordDir(partialWorld.root, partialWorld.recipient.session, partialWorld.recipient.seat);
    mkdirSync(partialDropDir, { recursive: true });
    const partialPaths: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = `m-part-${String(i).padStart(4, '0')}`;
      const record = signRecord(
        {
          kind: RECORD_KIND,
          id,
          to: partialWorld.recipient.seat,
          to_id: partialWorld.recipient.toId,
          root: partialWorld.root,
          session: partialWorld.recipient.session,
          at: AT,
          body: `from: worker-1\n\nhello ${id}\n`,
          from: 'worker-1',
          from_id: null,
          rule: 'a teammate in the same session',
          thread: id,
        },
        partialWorld.home,
      );
      const written = writeRecord(partialDropDir, record);
      if (!written.ok) throw new Error(written.reason);
      const recordDigest = createHash('sha256').update(readFileSync(written.path)).digest('hex');
      const notePath = join(partialDropDir, `.fallback-note-${i.toString(16).padStart(16, '0')}.json`);
      writeFileSync(
        notePath,
        `${JSON.stringify({
          format: 1,
          sender: 'seat:worker-1',
          fact: fact(partialWorld, { messageId: id, recordDigest }),
        })}\n`,
      );
      partialPaths.push(notePath);
    }
    const clock = { at: 0 };
    let partialYields = 0;
    let partialStopping = false;
    await sweepFallbackEscalationsSliced({
      home: partialWorld.home,
      roots: [{ root: partialWorld.root, team: partialWorld.team }],
      now: () => new Date(AT),
      sliceClock: () => {
        const value = clock.at;
        clock.at += 10;
        return value;
      },
      slices: {
        sliceMs: 10,
        stopping: () => partialStopping,
        yield: async () => {
          partialYields += 1;
          if (partialYields >= 4) {
            partialStopping = true;
            return false;
          }
          return true;
        },
      },
    });
    const remainingPartialNotes = partialPaths.filter((path) => existsSync(path)).length;
    expect(remainingPartialNotes).toBeGreaterThan(0);
    expect(remainingPartialNotes).toBeLessThan(partialPaths.length);
  });

  test('notesUnder, markersUnder and retirement check the slice budget inside a step', async () => {
    const world = makeWorld();
    for (let i = 0; i < 140; i += 1) {
      const id = `m-ret-${String(i).padStart(4, '0')}`;
      const noted = noteTransport(world.ctx, fact(world, { messageId: id, outcome: 'delivered', route: 'native' }));
      if (!noted.ok) throw new Error(noted.reason);
    }

    // With 140 settled markers (> 64 entries per chunk), markersUnder and planRetirement yield
    // inside their own loops. Stopping on the second boundary aborts inside the scan before any
    // marker is escalated or retired.
    const scanClock = { at: 0 };
    let scanYields = 0;
    let scanStopping = false;
    const abortedScan = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      retire: { limit: 64, lockWaitMs: 0 },
      sliceClock: () => {
        const value = scanClock.at;
        scanClock.at += 10;
        return value;
      },
      slices: {
        sliceMs: 10,
        stopping: () => scanStopping,
        yield: async () => {
          scanYields += 1;
          if (scanYields >= 2) {
            scanStopping = true;
            return false;
          }
          return true;
        },
      },
    });
    expect(scanYields).toBe(2);
    expect(abortedScan.roots).toEqual([]);
    expect(existsSync(markerPathOf(world.recipient, 'm-ret-0000'))).toBe(true);

    // Running past escalationSteps into retirementSteps: planRetirement itself yields every 64
    // markers before retiring a single episode, so stopping inside planRetirement retires nothing.
    const retireClock = { at: 0 };
    let retireYields = 0;
    let retireStopping = false;
    // Allow sweepRootSteps start (1) + notesUnder chunks + markersUnder chunks + 140 escalation
    // marker steps + the first intra-step yield inside planRetirement, then stop before any
    // marker is retired.
    await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(AT),
      retire: { limit: 64, lockWaitMs: 0 },
      sliceClock: () => {
        const value = retireClock.at;
        retireClock.at += 10;
        return value;
      },
      slices: {
        sliceMs: 10,
        stopping: () => retireStopping,
        yield: async () => {
          retireYields += 1;
          if (retireYields === 148) {
            retireStopping = true;
            return false;
          }
          return true;
        },
      },
    });
    expect(existsSync(markerPathOf(world.recipient, 'm-ret-0000'))).toBe(true);
  });
});
