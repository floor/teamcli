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
import { readEvents } from '../src/bus/log.ts';
import { messageFile } from '../src/commands/messages.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
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
const CALLER = { kind: 'seat', name: 'worker-1', pane: 'w1:p1', session: 'acme-dev' } as const;

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
});
