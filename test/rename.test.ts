import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalDifferences, approvalOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runFeed } from '../src/commands/feed.ts';
import { listUnacked, plantMessage, runMessages } from '../src/commands/messages.ts';
import { runRename } from '../src/commands/rename.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { resolveCaller } from '../src/permissions/who.ts';
import { findAgent, getAgent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { getTeam, teamIdOf } from '../src/registry/teams.ts';
import { appendHistory } from '../src/send/history.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import type { TaskRecord } from '../src/tasks/adapter.ts';
import { claimLocal, leasesDir, releaseLocal } from '../src/tasks/lease.ts';
import { newMemory, pass } from '../src/watch/pass.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';
import { intoRegistry, realRegistryTouched, storedTeam, underRegistry } from './helpers/registry-team.ts';

const NOW = new Date('2026-10-17T20:00:00.000Z');
const owner: Caller = { kind: 'owner' };

const BASE_YAML = `format: 1
project: acme
session: acme
coordinator: lead
operator: operator-1
workspace:
  mode: shared
watch:
  nudge: "Check queue/<your seat name>.md and .agents/send-drops/acme/<your seat name>"
seats:
  - role: coordinator
    name: lead
    nickname: maya
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: coordinator
    name: operator-1
    label: operator-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: documentarist
    name: documentarist
    nickname: max
    label: documentarist
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: builder-1
    label: builder-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: tester
    name: tester-1
    label: tester-1
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
# The send scenes here walk the typed trigger: the inbox is tried and skipped for want of a
# listener, then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;

type Fixture = {
  base: string;
  home: string;
  root: string;
  file: string;
  dir: string;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFixture(yamlText = BASE_YAML): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-rename-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const dir = join(root, '.agents');
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: root,
    env: gitEnv(),
  });
  const file = join(dir, 'team.yaml');
  writeFileSync(file, yamlText);

  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(`fixture team file invalid: ${loaded.errors.map((e) => e.message).join('; ')}`);
  writeApproval(
    storePath(loaded.team.project, root, home),
    {
      approval: approvalOf(loaded.team, root, NOW),
      file: yamlText,
    },
    [],
    home,
  );

  updateState(dir, (current) => {
    current.sessions.acme = {
      ...emptySession(),
      seats: {
        lead: { id: 'seat_000000000001', stage: 'ready', pane: 'w1:p1', workspace: 'ws-lead' },
        'operator-1': { id: 'seat_000000000002', stage: 'ready', pane: 'w1:p2', workspace: 'ws-op' },
        documentarist: { id: 'seat_000000000003', stage: 'ready', pane: 'w1:p3', workspace: 'ws-doc' },
        'builder-1': { id: 'seat_000000000004', stage: 'ready', pane: 'w1:p4', workspace: 'ws-b1' },
        'tester-1': { id: 'seat_000000000005', stage: 'ready', pane: 'w1:p5', workspace: 'ws-t1' },
      },
      worktrees: {
        'builder-1-wt': { path: join(base, 'wt-b1'), branch: 'b1', seat: 'builder-1', setup: 'ok' },
      },
    };
  });

  for (const seat of loaded.team.seats) {
    const seatState = readState(dir).sessions.acme?.seats[seat.name];
    registerLaunch(
      { home, team: loaded.team, root, by: 'owner', owner: true },
      seat,
      seatState?.pane ?? 'w1:p9',
      seatState?.id,
    );
  }

  return { base, home, root, file, dir };
}

describe('team rename <seat> <new-seat> and --renumber', () => {
  test('1. grants and leases are kept across a seat rename', async () => {
    const fx = makeFixture();
    const teamId = teamIdOf(fx.root);
    const beforeAgent = findAgent(fx.home, { team: teamId, seat: 'builder-1' });
    expect(beforeAgent).not.toBeNull();
    const agentId = beforeAgent!.id;

    // Grant 'merge' to the team envelope and to builder-1's agent id
    const envGrant = writeGrant(
      fx.home,
      {
        name: 'team-merge-env',
        kind: 'team',
        grantee: teamId,
        capabilities: ['merge'],
        roots: [fx.root],
      },
      { now: NOW },
    );
    expect(envGrant.ok).toBe(true);
    const seatGrant = writeGrant(
      fx.home,
      {
        name: 'builder-merge',
        kind: 'seat',
        grantee: agentId,
        capabilities: ['merge'],
        roots: [fx.root],
      },
      { now: NOW },
    );
    expect(seatGrant.ok).toBe(true);

    // Acquire a task lease for builder-1 on pane w1:p4
    const task: TaskRecord = { id: 'T-101', title: 'Ship rename' };
    const known = new Map([[task.id, task]]);
    const claimed = claimLocal(fx.root, {
      now: NOW.getTime(),
      seat: 'builder-1',
      pane: 'w1:p4',
      known,
      candidates: [task],
    });
    expect(claimed).toEqual({ kind: 'held', record: task });

    // Rename builder-1 -> builder-01
    const io = testIo(fx.root, owner);
    const code = await runRename(['builder-1', 'builder-01'], io, { home: fx.home, now: () => NOW });
    expect(code).toBe(0);
    expect(io.out).toContain('renamed builder-1 -> builder-01');
    expect(io.out).toContain(`agent ${agentId}`);
    expect(io.out).toContain('.agents/leases/T-101.json');

    // Approval standing remains verified without needing re-approval
    const loadedAfter = loadTeamFile(fx.root, { home: fx.home });
    expect(loadedAfter.ok).toBe(true);
    if (!loadedAfter.ok) return;
    const standing = approvalStanding(fx.root, fx.home);
    expect(standing.kind).toBe('verified');

    // Registry agent id is unchanged, reach.seat and name are builder-01, and roster is updated
    const afterAgent = findAgent(fx.home, { team: teamId, seat: 'builder-01' });
    expect(afterAgent?.id).toBe(agentId);
    expect(getAgent(fx.home, agentId)?.name).toBe('builder-01');
    expect(getAgent(fx.home, agentId)?.reach.seat).toBe('builder-01');
    expect(getTeam(fx.home, teamId)?.roster.some((r) => r.seat === 'builder-01' && r.agent === agentId)).toBe(true);
    expect(getTeam(fx.home, teamId)?.roster.some((r) => r.seat === 'builder-1')).toBe(false);

    // Seat grant still covers builder-01
    const decision = resolveCaller(
      { kind: 'seat', name: 'builder-01', pane: 'w1:p4', session: 'acme' },
      { id: teamId, orchestrator: loadedAfter.team.orchestrator, operator: loadedAfter.team.operator, seats: loadedAfter.team.seats },
      fx.root,
      fx.home,
      'merge',
      { session: 'acme', recordedPane: 'w1:p4', stage: 'ready' },
      NOW,
    );
    expect(decision).toMatchObject({ effect: 'allow', rule: 'seat-grant' });

    // Lease file was re-keyed to builder-01, is renewable and releasable under builder-01
    const leaseRaw = JSON.parse(readFileSync(join(leasesDir(fx.root), 'T-101.json'), 'utf8')) as { seat: string };
    expect(leaseRaw.seat).toBe('builder-01');
    const renewed = claimLocal(fx.root, {
      now: NOW.getTime() + 60_000,
      seat: 'builder-01',
      pane: 'w1:p4',
      known,
      candidates: [task],
    });
    expect(renewed).toEqual({ kind: 'held', record: task });
    const released = releaseLocal(fx.root, 'builder-01', 'w1:p4', NOW.getTime() + 120_000);
    expect(released).toEqual({ kind: 'released', id: 'T-101' });
  });

  test('2. message history is kept and visible under team feed --seat <new-seat>', async () => {
    const fx = makeFixture();
    appendHistory('acme', fx.root, fx.home, {
      ts: '2026-10-17T19:50:00.000Z',
      from: 'lead',
      to: 'builder-1',
      body: 'please start slice 1',
      id: 'msg-1',
      outcome: 'delivered',
    });
    appendHistory('acme', fx.root, fx.home, {
      ts: '2026-10-17T19:51:00.000Z',
      from: 'builder-1',
      to: 'lead',
      body: 'ACK slice 1',
      id: 'msg-2',
      outcome: 'delivered',
    });

    const io = testIo(fx.root, owner);
    expect(await runRename(['builder-1', 'builder-01'], io, { home: fx.home, now: () => NOW })).toBe(0);
    expect(io.out).toContain('messages.jsonl (2 entries)');

    const feedIo = testIo(fx.root, owner);
    expect(await runFeed(['--seat', 'builder-01', '--json'], feedIo, { home: fx.home })).toBe(0);
    const parsed = JSON.parse(feedIo.out) as {
      events: Array<{ from: string; to: string; body: string; spec?: string }>;
    };
    const lines = parsed.events;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      from: 'lead',
      to: 'builder-01',
      spec: 'builder-1',
      body: 'please start slice 1',
    });
    expect(lines[1]).toMatchObject({
      from: 'builder-01',
      to: 'lead',
      body: 'ACK slice 1',
    });
  });

  test('3. refused for a non-lead caller, allowed for lead, and lifted by dev-mode', async () => {
    const fx = makeFixture();
    const nonLead: Caller = { kind: 'seat', name: 'tester-1', pane: 'w1:p5', session: 'acme' };
    const refusedIo = testIo(fx.root, nonLead);
    const refusedCode = await runRename(['builder-1', 'builder-01'], refusedIo, { home: fx.home, now: () => NOW });
    expect(refusedCode).toBe(1);
    expect(refusedIo.err).toContain('only the owner or `leads` renames a seat; this call is tester-1');

    // Allowed when called by lead on its recorded pane
    const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
    const leadIo = testIo(fx.root, leadCaller);
    expect(await runRename(['builder-1', 'builder-01'], leadIo, { home: fx.home, now: () => NOW })).toBe(0);

    // Non-lead caller lifted by dev-mode
    const devIo = testIo(fx.root, nonLead);
    devIo.env.TEAMCLI_DEV_MODE = '1';
    const devCode = await runRename(['builder-01', 'builder-02'], devIo, { home: fx.home, now: () => NOW });
    expect(devCode).toBe(0);
    expect(devIo.err).toContain('dev mode continues');
    expect(devIo.out).toContain('renamed builder-01 -> builder-02');
  });

  test('4. existing target seat name is refused', async () => {
    const fx = makeFixture();
    const io = testIo(fx.root, owner);
    const code = await runRename(['builder-1', 'tester-1'], io, { home: fx.home, now: () => NOW });
    expect(code).toBe(1);
    expect(io.err).toContain('seat "tester-1" is already declared in .agents/team.yaml');
  });

  test('5. nickname clash is refused', async () => {
    const fx = makeFixture();
    const io = testIo(fx.root, owner);
    const code = await runRename(['builder-1', 'max'], io, { home: fx.home, now: () => NOW });
    expect(code).toBe(1);
    expect(io.err).toContain('cannot rename "builder-1" to "max"');
    expect(io.err).toContain('nickname');
  });

  test('6. pending drops, mailbox messages, rules and queue files move; send to new name works; watch resolves <your seat name>', async () => {
    const fx = makeFixture();

    // Pending send-drop
    const dropDir = join(fx.root, '.agents', 'send-drops', 'acme', 'builder-1');
    mkdirSync(dropDir, { recursive: true });
    writeFileSync(join(dropDir, 'drop-001'), 'From lead: pending work item\n');

    // Signed mailbox message
    plantMessage(fx.home, fx.root, 'builder-1', 'm-001', {
      kind: 'message',
      id: 'm-001',
      to: 'builder-1',
      root: fx.root,
      session: 'acme',
      at: NOW.toISOString(),
      body: 'hello mailbox',
      from: 'lead',
    });

    // Per-seat rules file in project state folder
    const storeDir = storePath('acme', fx.root, fx.home);
    mkdirSync(join(storeDir, 'rules'), { recursive: true });
    writeFileSync(join(storeDir, 'rules', 'builder-1.md'), '# Rules for builder\n');

    // Queue file in .agents/queue/<seat>.md
    mkdirSync(join(fx.root, '.agents', 'queue'), { recursive: true });
    writeFileSync(join(fx.root, '.agents', 'queue', 'builder-1.md'), '- task 1\n');

    // Rename builder-1 -> builder-01
    let renamedPane = null as { session: string; pane: string; name: string } | null;
    const io = testIo(fx.root, owner);
    const code = await runRename(['builder-1', 'builder-01'], io, {
      home: fx.home,
      now: () => NOW,
      renameAgent: (session, pane, name) => {
        renamedPane = { session, pane, name };
        return true;
      },
    });
    expect(code).toBe(0);
    expect(renamedPane).toEqual({ session: 'acme', pane: 'w1:p4', name: 'builder-01' });

    // Drops, rules, and queue file are now under builder-01
    expect(existsSync(join(fx.root, '.agents', 'send-drops', 'acme', 'builder-1'))).toBe(false);
    expect(readFileSync(join(fx.root, '.agents', 'send-drops', 'acme', 'builder-01', 'drop-001'), 'utf8')).toBe(
      'From lead: pending work item\n',
    );
    expect(existsSync(join(storeDir, 'rules', 'builder-01.md'))).toBe(true);
    expect(existsSync(join(fx.root, '.agents', 'queue', 'builder-01.md'))).toBe(true);

    // Signed mailbox message verifies under builder-01. The session's unacked drops also hold
    // each live seat's general seat brief — the rename's own delivery, and the broadcast of a
    // team whose claims were behind this build — so the mailbox record is the one asserted here.
    expect(listUnacked(fx.root, 'acme', fx.home).filter((drop) => drop.id === 'm-001')).toEqual([
      { id: 'm-001', to: 'builder-01', at: NOW.toISOString() },
    ]);
    const msgIo = testIo(fx.root, owner);
    expect(await runMessages([], msgIo, { home: fx.home, now: () => NOW })).toBe(0);
    expect(msgIo.out).toContain('hello mailbox');

    // Subsequent send to builder-01 works
    const typed: Array<{ pane: string; text: string }> = [];
    let entered = false;
    const host: SendHost = {
      home: fx.home,
      now: () => NOW,
      socketsDir: join(fx.base, 'sockets'),
      agents: () => [
        { name: 'lead', pane: 'w1:p1', cli: 'claude' },
        { name: 'builder-01', pane: 'w1:p4', cli: 'claude' },
      ],
      processInfo: () => null,
      deliver: async () => ({ ok: false, reason: 'no-socket' }),
      native: {
        typeText: (_session, pane, text) => {
          typed.push({ pane, text });
          return true;
        },
        pressEnter: () => {
          entered = true;
          return true;
        },
        status: () => (entered ? 'working' : 'idle'),
        wait: async () => {},
      },
    };
    const sendIo = testIo(fx.root, { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' });
    const sendCode = await runSend(['builder-01', 'follow-up after rename'], sendIo, host);
    expect(sendCode).toBe(0);
    expect(typed).toHaveLength(1);
    expect(typed[0]?.pane).toBe('w1:p4');

    // Watch nudge resolves <your seat name> to builder-01
    const loadedAfter = loadTeamFile(fx.root, { home: fx.home });
    expect(loadedAfter.ok).toBe(true);
    if (!loadedAfter.ok) return;
    const stateAfter = readState(fx.dir).sessions.acme!;
    const mem = newMemory();
    const liveAgent = {
      name: 'builder-01',
      pane: 'w1:p4',
      workspace: 'ws-b1',
      status: 'idle',
      session: 's4',
      agent: 'claude',
      cwd: fx.root,
    };
    // First pass starts idleSince at t=0
    pass({
      team: loadedAfter.team,
      state: stateAfter,
      live: {
        running: true,
        agents: [liveAgent],
        workspaces: [],
        screens: { 'w1:p4': CLAUDE_IDLE },
      },
      machine: { loadPerCore: 0.5, memoryFree: 50, diskFree: 100e9, swapTotal: 8e9, swapFree: 7e9, swapUsed: 1e9 },
      now: 1_000,
      memory: mem,
      approval: [],
      watch: loadedAfter.team.watch,
    });
    // Second pass past idle_first triggers work drop with <your seat name> resolved to builder-01
    const secondPass = pass({
      team: loadedAfter.team,
      state: stateAfter,
      live: {
        running: true,
        agents: [liveAgent],
        workspaces: [],
        screens: { 'w1:p4': CLAUDE_IDLE },
      },
      machine: { loadPerCore: 0.5, memoryFree: 50, diskFree: 100e9, swapTotal: 8e9, swapFree: 7e9, swapUsed: 1e9 },
      now: 1_000 + 600_000,
      memory: mem,
      approval: [],
      watch: loadedAfter.team.watch,
    });
    expect(secondPass.work).toHaveLength(1);
    expect(secondPass.work[0]).toMatchObject({
      seat: 'builder-01',
      pane: 'w1:p4',
      body: 'Check queue/builder-01.md and .agents/send-drops/acme/builder-01',
    });
  });

  test('7. team rename --renumber and --renumber --dry-run renumber numbered seats and leave single seats plain', async () => {
    const fx = makeFixture();
    const beforeYaml = readFileSync(fx.file, 'utf8');

    // Dry run proposes builder-1 -> builder-01, tester-1 -> tester-01, operator-1 -> operator-01
    // and leaves lead and documentarist plain, without modifying .agents/team.yaml
    const dryIo = testIo(fx.root, owner);
    const dryCode = await runRename(['--renumber', '--dry-run'], dryIo, { home: fx.home, now: () => NOW });
    expect(dryCode).toBe(0);
    expect(dryIo.out).toBe(
      [
        'operator-1 -> operator-01 (dry run)',
        'builder-1 -> builder-01 (dry run)',
        'tester-1 -> tester-01 (dry run)',
        '',
      ].join('\n'),
    );
    expect(readFileSync(fx.file, 'utf8')).toBe(beforeYaml);

    // Apply --renumber
    const applyIo = testIo(fx.root, owner);
    const applyCode = await runRename(['--renumber'], applyIo, { home: fx.home, now: () => NOW });
    expect(applyCode).toBe(0);

    const loaded = loadTeamFile(fx.root, { home: fx.home });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.team.seats.map((s) => s.name)).toEqual([
      'lead',
      'operator-01',
      'documentarist',
      'builder-01',
      'tester-01',
    ]);
    expect(loaded.team.operator).toBe('operator-01');
    expect(approvalStanding(fx.root, fx.home).kind).toBe('verified');
    expect(approvalDifferences(loaded.team, fx.root, fx.home)).toEqual([]);
  });

  test('8. rename carries only the approved record', async () => {
    // Clean rename keeps the approval with zero differences
    const cleanFx = makeFixture();
    expect(await runRename(['builder-1', 'builder-01'], testIo(cleanFx.root, owner), { home: cleanFx.home, now: () => NOW })).toBe(0);
    const cleanLoaded = loadTeamFile(cleanFx.root, { home: cleanFx.home });
    expect(cleanLoaded.ok).toBe(true);
    if (cleanLoaded.ok) {
      expect(approvalDifferences(cleanLoaded.team, cleanFx.root, cleanFx.home)).toEqual([]);
    }

    // Rename when a seat was edited since the last approval keeps that seat difference
    const seatFx = makeFixture();
    writeFileSync(
      seatFx.file,
      readFileSync(seatFx.file, 'utf8').replace(
        'name: builder-1\n    label: builder-1\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5',
        'name: builder-1\n    label: builder-1\n    cli: claude-code\n    vendor: anthropic\n    model: Claude Sonnet\n    version: "4.6"\n    launch: claude --model claude-sonnet-4-6',
      ),
    );
    const beforeSeatLoaded = loadTeamFile(seatFx.root, { home: seatFx.home });
    expect(beforeSeatLoaded.ok).toBe(true);
    if (beforeSeatLoaded.ok) {
      expect(approvalDifferences(beforeSeatLoaded.team, seatFx.root, seatFx.home)).toEqual(['seat builder-1 changed']);
    }
    expect(await runRename(['builder-1', 'builder-01'], testIo(seatFx.root, owner), { home: seatFx.home, now: () => NOW })).toBe(0);
    const afterSeatLoaded = loadTeamFile(seatFx.root, { home: seatFx.home });
    expect(afterSeatLoaded.ok).toBe(true);
    if (afterSeatLoaded.ok) {
      expect(approvalDifferences(afterSeatLoaded.team, seatFx.root, seatFx.home)).toEqual([
        'seat builder-01 is not in the last approval',
      ]);
    }
    const seatStanding = approvalStanding(seatFx.root, seatFx.home);
    expect(seatStanding.kind).toBe('verified');
    if (seatStanding.kind === 'verified') {
      expect(seatStanding.record.file).toContain('claude-opus-5-5');
      expect(seatStanding.record.file).not.toContain('claude-sonnet-4-6');
    }

    // Rename when an owner section was edited since the last approval keeps that section difference
    const secFx = makeFixture();
    writeFileSync(
      secFx.file,
      readFileSync(secFx.file, 'utf8').replace('operator: operator-1', 'operator: documentarist\nlimits:\n  seats: 12'),
    );
    const beforeSecLoaded = loadTeamFile(secFx.root, { home: secFx.home });
    expect(beforeSecLoaded.ok).toBe(true);
    if (beforeSecLoaded.ok) {
      expect(approvalDifferences(beforeSecLoaded.team, secFx.root, secFx.home)).toEqual([
        '`limits` changed',
        '`operator` changed',
      ]);
    }
    expect(await runRename(['builder-1', 'builder-01'], testIo(secFx.root, owner), { home: secFx.home, now: () => NOW })).toBe(0);
    const afterSecLoaded = loadTeamFile(secFx.root, { home: secFx.home });
    expect(afterSecLoaded.ok).toBe(true);
    if (afterSecLoaded.ok) {
      expect(approvalDifferences(afterSecLoaded.team, secFx.root, secFx.home)).toEqual([
        '`limits` changed',
        '`operator` changed',
      ]);
    }
    const secStanding = approvalStanding(secFx.root, secFx.home);
    expect(secStanding.kind).toBe('verified');
    if (secStanding.kind === 'verified') {
      expect(secStanding.record.file).toContain('operator: operator-1');
      expect(secStanding.record.file).not.toContain('seats: 12');
    }
  });

  test('9. a seat declared with count > 1 is refused in single rename and skipped in --renumber', async () => {
    const countedYaml = BASE_YAML.replace(
      '  - role: implementer\n    name: builder-1\n    label: builder-1',
      '  - role: implementer\n    name: builder\n    count: 2\n    label: builder',
    );
    const fx = makeFixture(countedYaml);

    const io1 = testIo(fx.root, owner);
    expect(await runRename(['builder', 'builder-01'], io1, { home: fx.home, now: () => NOW })).toBe(1);
    expect(io1.err).toContain('declared under "builder" with count 2 and cannot be renamed partially');

    const io2 = testIo(fx.root, owner);
    expect(await runRename(['builder-2', 'builder-02'], io2, { home: fx.home, now: () => NOW })).toBe(1);
    expect(io2.err).toContain('declared under "builder" with count 2 and cannot be renamed partially');

    const renumIo = testIo(fx.root, owner);
    expect(await runRename(['--renumber', '--dry-run'], renumIo, { home: fx.home, now: () => NOW })).toBe(0);
    expect(renumIo.out).toBe(['operator-1 -> operator-01 (dry run)', 'tester-1 -> tester-01 (dry run)', ''].join('\n'));
  });
});


describe('under the registry source', () => {
  test('a rename edits the registry record and leaves the file as it was', async () => {
    const fx = makeFixture();
    intoRegistry(fx.root, fx.home);
    const io = testIo(fx.root, owner);
    const code = await underRegistry(() => runRename(['builder-1', 'builder-01'], io, { home: fx.home, now: () => NOW }));
    expect(code).toBe(0);
    const record = storedTeam(fx.root, fx.home)!;
    expect(record.edited_by).toBe('rename');
    expect(record.text).toContain('name: builder-01');
    expect(record.text).not.toContain('name: builder-1\n');
    expect(readFileSync(fx.file, 'utf8')).toBe(BASE_YAML);
    expect(realRegistryTouched()).toBe(false);
  });
});
