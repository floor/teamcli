import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendEvent,
  EVENT_DOMAIN,
  eventLogPath,
  readEvents,
  type SignedEventRecord,
} from '../src/bus/log.ts';
import {
  createReconcileState,
  DEFAULT_RECONCILE_SLICE_MS,
  reconcilePass,
  reconcilePassAsync,
  reconcileSteps,
  type ReconcileResult,
} from '../src/bus/reconcile.ts';
import { plantMessage, receiptFile } from '../src/commands/messages.ts';
import { TEAM_FILE } from '../src/file/load.ts';
import { readTeamConfig, TEAM_CONFIG_SOURCE_ENV } from '../src/file/team-config.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { agentsDir, readAgents } from '../src/registry/agents.ts';
import { entitiesPath } from '../src/entities.ts';
import { grantsDir } from '../src/grant.ts';
import { projectsFile } from '../src/registry/projects.ts';
import { registerDeclaredSeat } from '../src/registry/sync.ts';
import { noteTeam, teamIdOf, teamsFile } from '../src/registry/teams.ts';
import { machineSettingsPath } from '../src/settings/declared.ts';
import { appendHistory } from '../src/send/history.ts';
import { signRecord, type RecordPayload } from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { messageKeyOf, RECEIPT_DOMAIN, signDomain, type Json } from '../src/store/keys.ts';

const TEAM_YAML = `format: 1
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
`;

const TS = '2026-11-05T00:00:00.000Z';
const bases: string[] = [];

function makeWorld(project = 'acme'): { base: string; root: string; home: string } {
  const short = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
  const base = realpathSync(mkdtempSync(join(short, 'team-ll4-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(
    join(root, '.agents', 'team.yaml'),
    TEAM_YAML.replaceAll('project: acme', `project: ${project}`).replaceAll('session: acme', `session: ${project}`),
  );
  messageKeyOf(home);
  return { base, root, home };
}

afterEach(() => {
  for (const base of bases.splice(0)) {
    rmSync(base, { recursive: true, force: true });
  }
});

function writeSignedDrop(
  root: string,
  home: string,
  session: string,
  seat: string,
  id: string,
  from = 'clerk',
  at = TS,
): void {
  const dir = join(root, '.agents', 'send-drops', session, seat);
  mkdirSync(dir, { recursive: true });
  const payload: RecordPayload = {
    kind: 'message',
    id,
    to: seat,
    to_id: null,
    root,
    session,
    at,
    body: `message ${id}`,
    from,
    from_id: null,
    rule: 'synthetic admission',
    thread: id,
  };
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(signRecord(payload, home))}\n`);
}

function raisedSummary(res: ReconcileResult): string[] {
  if (!res.ok) throw new Error(res.reason);
  return res.raised.map(
    (r: SignedEventRecord) =>
      `${r.payload.kind}:${r.payload.record_id}:${r.payload.from ?? ''}:${r.payload.to ?? ''}:${r.payload.seat ?? ''}`,
  );
}

describe('LL4 bus reconcile bounded slices', () => {
  test('DEFAULT_RECONCILE_SLICE_MS is bounded for low-latency main-loop sharing', () => {
    expect(DEFAULT_RECONCILE_SLICE_MS).toBeLessThanOrEqual(4);
  });

  test('reconcileSteps yields across side-file runs, pending scans, non-receipt runs, history reads, and refused pruning', () => {
    const { root, home } = makeWorld();
    const dropDir = join(root, '.agents', 'send-drops', 'acme', 'op-1');
    mkdirSync(dropDir, { recursive: true });

    // 1. Seed 1,200 event lines so log hydration and dedupe-set construction must yield in chunks.
    const key = messageKeyOf(home);
    const first = appendEvent('acme', root, home, {
      ts: TS,
      kind: 'message.arrived',
      session: 'acme',
      record_id: 'seed-0000',
      from: 'clerk',
      to: 'op-1',
    });
    if (!first.ok) throw new Error(first.reason);
    const eventLines: string[] = [];
    for (let i = 1; i < 1200; i += 1) {
      const payload = {
        v: 1,
        seq: i + 1,
        ts: TS,
        kind: 'message.arrived',
        session: 'acme',
        record_id: `seed-${String(i).padStart(4, '0')}`,
        from: 'clerk',
        to: 'op-1',
      };
      const signature = signDomain(EVENT_DOMAIN, payload as unknown as Json, key);
      eventLines.push(JSON.stringify({ payload, signature }));
    }
    appendFileSync(first.path, `${eventLines.join('\n')}\n`);

    // 2. Seed 600 non-receipt drop files (refused) + 600 side files (.wake) + 200 .pending markers.
    for (let i = 0; i < 600; i += 1) {
      const id = `drop-${String(i).padStart(4, '0')}`;
      writeFileSync(join(dropDir, `${id}.json`), `{"id":"${id}","body":"unsigned"}\n`);
      writeFileSync(join(dropDir, `${id}.wake`), '1');
    }
    for (let i = 0; i < 200; i += 1) {
      const id = `pend-${String(i).padStart(4, '0')}`;
      writeFileSync(
        join(dropDir, `${id}.pending`),
        JSON.stringify({ id, from: 'clerk', to: 'op-1', body: 'held', ts: TS, tries: 1 }),
      );
    }

    // 3. Seed 600 history lines in messages.jsonl.
    const historyLog = join(dirname(eventLogPath('acme', root, home)), 'messages.jsonl');
    const historyLines: string[] = [];
    for (let i = 0; i < 600; i += 1) {
      const id = `seed-${String(i).padStart(4, '0')}`;
      historyLines.push(
        JSON.stringify({ ts: TS, from: 'clerk', to: 'op-1', body: 'ok', id, outcome: 'sent (unconfirmed)' }),
      );
    }
    writeFileSync(historyLog, `${historyLines.join('\n')}\n`, { mode: 0o600 });

    const state = createReconcileState();
    const pass1Gen = reconcileSteps({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      appendWaitMs: 0,
      maxBytes: 8_000_000,
      kept: 13,
      retentionSeconds: 30 * 86400,
    });
    let pass1Steps = 0;
    for (;;) {
      const next = pass1Gen.next();
      pass1Steps += 1;
      if (next.done) {
        expect(next.value.ok).toBe(true);
        break;
      }
    }
    // 600 drop files + 200 pending markers alone is 800 steps; with chunked yields across
    // 1,200 log entries, 600 side files, 1,400 pending/receipt scan entries, 600 history lines,
    // and 600 refused-cache prune entries, pass1Steps must exceed 900.
    expect(pass1Steps).toBeGreaterThanOrEqual(900);

    // Warm pass 2: no single step may stall on synchronous subprocesses or un-sliced scans.
    const pass2Gen = reconcileSteps({
      project: 'acme',
      root,
      session: 'acme',
      home,
      state,
      appendWaitMs: 0,
      maxBytes: 8_000_000,
      kept: 13,
      retentionSeconds: 30 * 86400,
    });
    let maxWarmStepMs = 0;
    let pass2Steps = 0;
    for (;;) {
      const t0 = performance.now();
      const next = pass2Gen.next();
      const dt = performance.now() - t0;
      if (dt > maxWarmStepMs) maxWarmStepMs = dt;
      pass2Steps += 1;
      if (next.done) {
        expect(next.value.ok).toBe(true);
        break;
      }
    }
    expect(pass2Steps).toBeGreaterThanOrEqual(850);
    expect(maxWarmStepMs).toBeLessThan(15);
  });

  test('three concurrent reconcilePassAsync stores share the slice budget without stacking turn lag', async () => {
    const stores = [0, 1, 2].map(( idx) => {
      const project = `lag${idx}`;
      const { root, home } = makeWorld(project);
      const seatDir = join(root, '.agents', 'send-drops', project, 'op-1');
      mkdirSync(seatDir, { recursive: true });
      for (let i = 0; i < 2000; i += 1) {
        writeFileSync(join(seatDir, `drop-${i}.json`), `{"id":"m${i}","seat":"op-1","body":"x"}\n`);
      }
      const state = createReconcileState();
      return { project, root, home, state };
    });

    // Warm the caches once, as after initial startup.
    await Promise.all(
      stores.map((s) =>
        reconcilePassAsync({
          project: s.project,
          root: s.root,
          session: s.project,
          home: s.home,
          state: s.state,
          maxBytes: 8_000_000,
          kept: 13,
          retentionSeconds: 30 * 86400,
        }),
      ),
    );

    const lags: number[] = [];
    let expected = performance.now() + 10;
    const timer = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + 10;
    }, 10);

    try {
      await Promise.all(
        stores.map((s) =>
          reconcilePassAsync({
            project: s.project,
            root: s.root,
            session: s.project,
            home: s.home,
            state: s.state,
            maxBytes: 8_000_000,
            kept: 13,
            retentionSeconds: 30 * 86400,
          }),
        ),
      );
    } finally {
      clearInterval(timer);
    }

    lags.sort((a, b) => a - b);
    const p95 = lags[Math.floor(lags.length * 0.95)] ?? 0;
    const max = lags[lags.length - 1] ?? 0;
    expect(p95).toBeLessThan(20);
    expect(max).toBeLessThan(30);
  });

  test('reconcilePassAsync produces identical results and stats to reconcilePass across all record types', async () => {
    const syncWorld = makeWorld('parity');
    const asyncWorld = makeWorld('parity');

    for (const w of [syncWorld, asyncWorld]) {
      // 1. Signed drops and receipts.
      writeSignedDrop(w.root, w.home, 'parity', 'op-1', 'msg-1', 'clerk', '2026-11-05T00:01:00.000Z');
      writeSignedDrop(w.root, w.home, 'parity', 'op-1', 'msg-2', 'clerk', '2026-11-05T00:02:00.000Z');
      const dropDir = join(w.root, '.agents', 'send-drops', 'parity', 'op-1');
      writeFileSync(join(dropDir, 'msg-1.delivered.json'), '{"ok":true}');
      writeFileSync(join(dropDir, 'msg-1.read.json'), '{"ok":true}');
      writeFileSync(
        join(dropDir, 'msg-2.pending'),
        JSON.stringify({
          id: 'msg-2',
          from: 'clerk',
          to: 'op-1',
          body: 'message msg-2',
          ts: '2026-11-05T00:02:00.000Z',
          tries: 2,
          leg: 'drop',
        }),
      );
      // Refused unsigned drop.
      writeFileSync(join(dropDir, 'bad-drop.json'), '{"not":"signed"}');

      // 2. Signed mailbox message + read receipt.
      plantMessage(w.home, w.root, 'op-1', 'mbox-1', {
        kind: 'message',
        id: 'mbox-1',
        from: 'clerk',
        to: 'op-1',
        root: w.root,
        session: 'parity',
        at: '2026-11-05T00:03:00.000Z',
        body: 'mailbox message',
      });
      const receiptPayload = {
        kind: 'receipt' as const,
        id: 'mbox-1',
        to: 'op-1',
        root: w.root,
        session: 'parity',
        at: '2026-11-05T00:04:00.000Z',
      };
      writeFileSync(
        receiptFile(w.root, 'op-1', 'mbox-1'),
        JSON.stringify({
          payload: receiptPayload,
          signature: signDomain(RECEIPT_DOMAIN, receiptPayload, messageKeyOf(w.home)),
        }),
      );

      // 3. History entry with answered outcome for msg-1.
      appendHistory('parity', w.root, w.home, {
        ts: '2026-11-05T00:05:00.000Z',
        from: 'clerk',
        to: 'op-1',
        body: 'message msg-1',
        id: 'msg-1',
        outcome: 'answered',
      });

      // 4. Seat state transition in team.state.json.
      updateState(join(w.root, '.agents'), (state) => {
        (state.sessions.parity ??= emptySession()).seats['op-1'] = {
          stage: 'ready',
          last_active: '2026-11-05T00:06:00.000Z',
        };
      });
    }

    const now = new Date('2026-11-05T01:00:00.000Z');
    const syncState = createReconcileState();
    const asyncState = createReconcileState();
    const syncRefused: string[] = [];
    const asyncRefused: string[] = [];

    const syncRes1 = reconcilePass({
      project: 'parity',
      root: syncWorld.root,
      session: 'parity',
      home: syncWorld.home,
      now,
      state: syncState,
      onRefused: (r) => syncRefused.push(`${r.where}:${r.reason}`),
    });
    const asyncRes1 = await reconcilePassAsync({
      project: 'parity',
      root: asyncWorld.root,
      session: 'parity',
      home: asyncWorld.home,
      now,
      state: asyncState,
      sliceMs: 0,
      onRefused: (r) => asyncRefused.push(`${r.where}:${r.reason}`),
    });

    expect(raisedSummary(asyncRes1)).toEqual(raisedSummary(syncRes1));
    expect(asyncRefused).toEqual(syncRefused);
    expect(asyncState.stats.filesRead).toBe(syncState.stats.filesRead);
    expect(asyncState.stats.verifies).toBe(syncState.stats.verifies);

    // Second pass (warm cache) parity.
    const syncRes2 = reconcilePass({
      project: 'parity',
      root: syncWorld.root,
      session: 'parity',
      home: syncWorld.home,
      now,
      state: syncState,
    });
    const asyncRes2 = await reconcilePassAsync({
      project: 'parity',
      root: asyncWorld.root,
      session: 'parity',
      home: asyncWorld.home,
      now,
      state: asyncState,
      sliceMs: 2,
    });

    expect(raisedSummary(asyncRes2)).toEqual(raisedSummary(syncRes2));
    expect(asyncState.stats.filesRead).toBe(0);
    expect(asyncState.stats.filesReused).toBe(syncState.stats.filesReused);

    const syncEvents = readEvents('parity', syncWorld.root, syncWorld.home);
    const asyncEvents = readEvents('parity', asyncWorld.root, asyncWorld.home);
    expect(syncEvents.ok && asyncEvents.ok).toBe(true);
    if (syncEvents.ok && asyncEvents.ok) {
      expect(asyncEvents.events.map((e) => `${e.payload.kind}:${e.payload.record_id}`)).toEqual(
        syncEvents.events.map((e) => `${e.payload.kind}:${e.payload.record_id}`),
      );
    }
  });

  test('markOrphanedSeats re-runs when the registry team-config record removes a seat between two passes', () => {
    const { home, root } = makeWorld('acme');
    const prevEnv = process.env[TEAM_CONFIG_SOURCE_ENV];
    delete process.env[TEAM_CONFIG_SOURCE_ENV];

    try {
      const teamFile = join(root, TEAM_FILE);
      const wrote1 = writeTeamText(teamFile, TEAM_YAML, {
        home,
        source: 'registry',
        command: 'init',
        create: true,
      });
      expect(wrote1).toEqual({ ok: true, target: 'registry' });
      const loaded1 = readTeamConfig(root, { home });
      expect(loaded1.ok).toBe(true);
      if (!loaded1.ok) return;

      for (const seat of loaded1.team.seats) {
        registerDeclaredSeat({ home, team: loaded1.team, root, by: 'owner' }, seat);
      }

      const state = createReconcileState();
      const res1 = reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:00:00.000Z'),
        state,
      });
      expect(res1.ok).toBe(true);
      expect(readAgents(home).find((a) => a.reach.seat === 'op-1')?.orphaned_at ?? null).toBeNull();

      // Remove op-1 from the registry declaration (writes only team-config/<id>.json).
      const clerkOnlyYaml = `format: 1
project: acme
coordinator: clerk
operator: clerk
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
`;
      const wrote2 = writeTeamText(teamFile, clerkOnlyYaml, { home, source: 'registry', command: 'edit' });
      expect(wrote2).toEqual({ ok: true, target: 'registry' });

      const res2 = reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:02:00.000Z'),
        state,
      });
      expect(res2.ok).toBe(true);
      const agentsAfter = readAgents(home);
      expect(agentsAfter.find((a) => a.reach.seat === 'clerk')?.orphaned_at ?? null).toBeNull();
      expect(agentsAfter.find((a) => a.reach.seat === 'op-1')?.orphaned_at).toBe('2026-11-05T12:02:00.000Z');
    } finally {
      if (prevEnv === undefined) delete process.env[TEAM_CONFIG_SOURCE_ENV];
      else process.env[TEAM_CONFIG_SOURCE_ENV] = prevEnv;
    }
  });

  test('markOrphanedSeats re-runs across team.yaml, agentsDir, teams.yaml, settings.yaml, TEAM_CONFIG_SOURCE, and policy inputs between passes', () => {
    const { home, root } = makeWorld('acme');
    const prevEnv = process.env[TEAM_CONFIG_SOURCE_ENV];

    try {
      process.env[TEAM_CONFIG_SOURCE_ENV] = 'file';
      const teamFile = join(root, TEAM_FILE);
      const loaded1 = readTeamConfig(root, { home });
      expect(loaded1.ok).toBe(true);
      if (!loaded1.ok) return;

      for (const seat of loaded1.team.seats) {
        registerDeclaredSeat({ home, team: loaded1.team, root, by: 'owner' }, seat);
      }

      const state = createReconcileState();
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:00:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-1')?.orphaned_at ?? null).toBeNull();

      // 1. Registering a new undeclared seat in agentsDir(home) while team.yaml is unchanged marks it on the next pass.
      registerDeclaredSeat(
        { home, team: loaded1.team, root, by: 'owner' },
        { ...loaded1.team.seats[1]!, name: 'ghost-seat' },
      );
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:01:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'ghost-seat')?.orphaned_at).toBe(
        '2026-11-05T12:01:00.000Z',
      );

      // 2. Editing an agent record in-place inside agentsDir(home) (clearing orphaned_at without adding/removing a file) re-runs orphan marking.
      const ghostAgent = readAgents(home).find((a) => a.reach.seat === 'ghost-seat')!;
      const ghostFile = join(agentsDir(home), `${ghostAgent.id}.yaml`);
      const rawGhost = require('node:fs').readFileSync(ghostFile, 'utf8') as string;
      writeFileSync(ghostFile, rawGhost.replace(/orphaned_at: .*\n/, ''));
      expect(readAgents(home).find((a) => a.reach.seat === 'ghost-seat')?.orphaned_at ?? null).toBeNull();
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:01:30.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'ghost-seat')?.orphaned_at).toBe(
        '2026-11-05T12:01:30.000Z',
      );

      // 3. Editing .agents/team.yaml to drop op-1 marks op-1 orphaned on the next pass.
      const clerkOnlyYaml = `format: 1
project: acme
coordinator: clerk
operator: clerk
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
`;
      writeFileSync(teamFile, clerkOnlyYaml);
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:02:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-1')?.orphaned_at).toBe(
        '2026-11-05T12:02:00.000Z',
      );

      // 4. Switching machineSettingsPath(home) (team-config.source) between registry and file re-runs orphan marking.
      delete process.env[TEAM_CONFIG_SOURCE_ENV];
      const withOp2AndOp3Yaml = `${TEAM_YAML}  - role: worker
    name: op-2
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
  - role: worker
    name: op-3
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;
      const wroteRegistry = writeTeamText(teamFile, withOp2AndOp3Yaml, {
        home,
        source: 'registry',
        command: 'init',
        create: true,
      });
      expect(wroteRegistry).toEqual({ ok: true, target: 'registry' });
      registerDeclaredSeat(
        { home, team: loaded1.team, root, by: 'owner' },
        { ...loaded1.team.seats[1]!, name: 'op-2' },
      );
      const settingsFile = machineSettingsPath(home);
      mkdirSync(dirname(settingsFile), { recursive: true });
      writeFileSync(settingsFile, 'team-config:\n  source: registry\n');
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:03:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-2')?.orphaned_at ?? null).toBeNull();

      // Switch settings.yaml to file source (where teamFile only has clerk).
      writeFileSync(settingsFile, 'team-config:\n  source: file\n');
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:04:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-2')?.orphaned_at).toBe(
        '2026-11-05T12:04:00.000Z',
      );

      // 5. Switching TEAM_CONFIG_SOURCE environment variable re-runs orphan marking.
      writeFileSync(settingsFile, 'team-config:\n  source: registry\n');
      registerDeclaredSeat(
        { home, team: loaded1.team, root, by: 'owner' },
        { ...loaded1.team.seats[1]!, name: 'op-3' },
      );
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:05:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-3')?.orphaned_at ?? null).toBeNull();

      process.env[TEAM_CONFIG_SOURCE_ENV] = 'file';
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:06:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-3')?.orphaned_at).toBe(
        '2026-11-05T12:06:00.000Z',
      );

      // 6. Changing teamsFile(home) (teams.yaml) re-runs markOrphanedSeats when recorded lobby resolution depends on teams.yaml.
      delete process.env[TEAM_CONFIG_SOURCE_ENV];
      const migratedTrustClerkYaml = `${clerkOnlyYaml}trust:
  - ${root}
`;
      const wroteMigratedTrust = writeTeamText(teamFile, migratedTrustClerkYaml, {
        home,
        source: 'registry',
        command: 'edit',
      });
      expect(wroteMigratedTrust).toEqual({ ok: true, target: 'registry' });
      registerDeclaredSeat(
        { home, team: loaded1.team, root, by: 'owner' },
        { ...loaded1.team.seats[1]!, name: 'op-4' },
      );
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:06:30.000Z'),
        state,
      });
      // Without teams.yaml recording lobby=root, lobbyOf defaults to ~/.config/team/lobbies (absent/untrusted), so readTeamConfig fails and op-4 stays un-orphaned.
      expect(readAgents(home).find((a) => a.reach.seat === 'op-4')?.orphaned_at ?? null).toBeNull();

      // Recording the team's lobby in teams.yaml (changing only teamsFile(home)) invalidates orphanStamp and orphans op-4 on the next pass.
      noteTeam(
        home,
        root,
        { project: 'acme', entity: null, session: 'acme', lobby: root, inProject: null },
        'running',
        'owner',
      );
      reconcilePass({
        project: 'acme',
        root,
        session: 'acme',
        home,
        now: new Date('2026-11-05T12:07:00.000Z'),
        state,
      });
      expect(readAgents(home).find((a) => a.reach.seat === 'op-4')?.orphaned_at).toBe(
        '2026-11-05T12:07:00.000Z',
      );

      // 7. Changing projectsFile(home), entitiesPath(home), and grantsDir(home) invalidates the stamp.
      for (const mutate of [
        () => {
          mkdirSync(dirname(projectsFile(home)), { recursive: true });
          writeFileSync(projectsFile(home), 'format: 1\nprojects: {}\n');
        },
        () => {
          mkdirSync(dirname(entitiesPath(home)), { recursive: true });
          writeFileSync(entitiesPath(home), 'format: 1\nentities: {}\n');
        },
        () => {
          mkdirSync(grantsDir(home), { recursive: true });
          writeFileSync(join(grantsDir(home), 'grt_000000000001.yaml'), 'id: grt_000000000001\n');
        },
      ]) {
        const before = state.orphanStamp;
        mutate();
        reconcilePass({
          project: 'acme',
          root,
          session: 'acme',
          home,
          now: new Date('2026-11-05T12:07:30.000Z'),
          state,
        });
        expect(state.orphanStamp).not.toBe(before);
      }
      expect(teamIdOf(root)).toHaveLength(12);
    } finally {
      if (prevEnv === undefined) delete process.env[TEAM_CONFIG_SOURCE_ENV];
      else process.env[TEAM_CONFIG_SOURCE_ENV] = prevEnv;
    }
  });
});
