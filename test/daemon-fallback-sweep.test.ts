// The daemon fallback sweep's focused fixtures: the heartbeat's one pass fires an episode exactly
// at its durable due instant (never before, never twice), leaves one event and one mailbox, a
// restart resumes from the marker alone, a delivery before the due instant cancels the
// escalation, a root whose team file does not validate is refused and swept nothing, and close
// stops the sweep with the heartbeat. Every home is a synthetic tmp directory.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvents } from '../src/bus/log.ts';
import { messageFile } from '../src/commands/messages.ts';
import { sweepFallbackEscalations } from '../src/daemon/fallback-sweep.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  escalatedRecordId,
  escalationMailboxId,
  markerPathOf,
  noteTransport,
  type CanonicalRecipient,
  type FallbackContext,
  type FallbackMarker,
  type TransportFact,
} from '../src/send/fallback-events.ts';

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
});
