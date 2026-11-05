// The daemon loop's heartbeat as a catalogue policy (`daemon.heartbeat`, ADR D6): the name, its
// `daemon-heartbeat-seconds` alias, the 1-to-60 bounds, the tighten-only chain, the daemon's
// per-root read where the shortest word any hosted root declares wins, the start-time resolution
// into the state record and the health answer, and `team daemon status` printing the beat it runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemon } from '../src/commands/daemon.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { daemonHeartbeatSeconds, createHeartbeatPolicy } from '../src/daemon/heartbeat.ts';
import { daemonHealth } from '../src/daemon/health.ts';
import { startMachineDaemon } from '../src/daemon/host.ts';
import { readDaemonState } from '../src/daemon/state.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import {
  DAEMON_HEARTBEAT_SECONDS,
  POLICY_CATALOGUE,
  normalizePolicyName,
  resolvePolicy,
  writePolicySet,
} from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

const NOW = new Date('2026-11-03T12:00:00Z');

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
    leads: true
  - name: worker-1
    role: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

type World = { root: string; home: string; team: TeamFile };

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeWorld(): World {
  return makeRoots(1).worlds[0]!;
}

/** One home's registry holding every root: the shape a daemon reads, where all hosted checkouts
 *  sign their words under the same home. */
function makeRoots(count: number): { home: string; worlds: World[] } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-daemon-heartbeat-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const worlds: World[] = [];
  for (let index = 0; index < count; index++) {
    const root = join(base, `repo${String(index)}`);
    mkdirSync(join(root, '.agents'), { recursive: true });
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

    const validated = validateTeamFile(TEAM_YAML);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    worlds.push({ root, home, team: validated.team });
  }
  return { home, worlds };
}

describe('the daemon.heartbeat catalogue entry', () => {
  test('carries the release default, its bounds, its aliases and the tighten-only chain', () => {
    const spec = POLICY_CATALOGUE['daemon.heartbeat'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.defaultValue).toBe(5);
    expect(spec.gateLifting).toBe(false);
    // The orchestrator's spelling and the field spellings normalize to the canonical name.
    expect(normalizePolicyName('daemon-heartbeat-seconds')).toBe('daemon.heartbeat');
    expect(normalizePolicyName('daemon_heartbeat_seconds')).toBe('daemon.heartbeat');
    expect(normalizePolicyName('daemon-heartbeat')).toBe('daemon.heartbeat');
    expect(normalizePolicyName('heartbeat-seconds')).toBe('daemon.heartbeat');
    for (const word of ['5', 5, 1, 60, '60s', '3s']) expect(spec.parseValue(word)).not.toBeNull();
    for (const word of [0, '0', 61, '61', -1, '2.5', 2.5, 'nope', '', true, null]) {
      expect(spec.parseValue(word)).toBeNull();
    }
    expect(spec.valueProblem?.(61)).toContain('from 1 to 60');

    const absent = resolvePolicy('daemon.heartbeat', []);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.effective.value).toBe(5);

    // A shorter beat is the tighter word; a longer word at a lower level is a loosening.
    const tightened = resolvePolicy('daemon.heartbeat', [
      { name: 'daemon.heartbeat', value: 10, level: 'entity', setter: 'owner', date: '2026-11-03T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.heartbeat', value: 3, level: 'team', setter: 'owner', date: '2026-11-03T11:00:00Z', kind: 'enforced' },
    ]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) expect(tightened.effective.value).toBe(3);
    const loosened = resolvePolicy('daemon.heartbeat', [
      { name: 'daemon.heartbeat', value: 3, level: 'entity', setter: 'owner', date: '2026-11-03T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.heartbeat', value: 10, level: 'team', setter: 'owner', date: '2026-11-03T11:00:00Z', kind: 'enforced' },
    ]);
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) expect(loosened.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'daemon.heartbeat' });

    // A seat never sets a machine-wide beat.
    const seatLevel = resolvePolicy('daemon.heartbeat', [
      { name: 'daemon.heartbeat', value: 3, level: 'seat', setter: 'owner', date: '2026-11-03T11:00:00Z', kind: 'enforced' },
    ]);
    expect(seatLevel.ok).toBe(false);
    if (!seatLevel.ok) expect(seatLevel.refusals[0]?.message).toContain('allowed: entity, project, team');
  });

  test('team policy set daemon-heartbeat-seconds writes the canonical name and refuses a word out of bounds', async () => {
    const world = makeWorld();
    const owner = testIo(world.root, { kind: 'owner' });

    const refused = await runPolicy(
      ['set', 'team', 'daemon-heartbeat-seconds', '61', '--file', '.agents/team.yaml'],
      testIo(world.root, { kind: 'owner' }),
      { home: world.home, now: () => NOW },
    );
    expect(refused).toBe(2);

    const code = await runPolicy(
      ['set', 'team', 'daemon-heartbeat-seconds', '3', '--file', '.agents/team.yaml'],
      owner,
      { home: world.home, now: () => NOW },
    );
    expect(code).toBe(0);
    expect(owner.out).toContain('policy: set daemon.heartbeat=3 at team');
    expect(daemonHeartbeatSeconds([{ root: world.root, team: world.team }], world.home, NOW)).toEqual({ seconds: 3, unknown: null });
  });
});

describe('the daemon heartbeat read', () => {
  test('the release default with no word, the team word, and the shortest of two roots', () => {
    const { home, worlds } = makeRoots(2);
    const [one, two] = worlds as [World, World];
    // No word anywhere: the release default the daemon ran hard-coded before the policy.
    expect(daemonHeartbeatSeconds([{ root: one.root, team: one.team }], home, NOW)).toEqual({ seconds: 5, unknown: null });
    // A bare path is validated the way the daemon's own roots loop validates one.
    expect(daemonHeartbeatSeconds([one.root], home, NOW)).toEqual({ seconds: 5, unknown: null });

    expect(writePolicySet(home, { level: 'team', target: one.root, teamRoot: one.root, name: 'daemon.heartbeat', value: 10 }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(home, { level: 'team', target: two.root, teamRoot: two.root, name: 'daemon.heartbeat', value: 2 }, { now: NOW }).ok).toBe(true);

    expect(daemonHeartbeatSeconds([{ root: one.root, team: one.team }], home, NOW)).toEqual({ seconds: 10, unknown: null });
    // One daemon hosting both checkouts runs the shortest word among them: no hosted team
    // loosens another's beat.
    expect(daemonHeartbeatSeconds(
      [
        { root: one.root, team: one.team },
        { root: two.root, team: two.team },
      ],
      home,
      NOW,
    )).toEqual({ seconds: 2, unknown: null });
  });

  test('a root whose chain cannot be read keeps the release default as its word and says why', () => {
    const world = makeWorld();
    // A lower level that loosens makes the whole chain refuse: the daemon cannot act on a word
    // from a chain that does not verify, so that root keeps the release default.
    expect(writePolicySet(world.home, { level: 'entity', target: 'floor', name: 'daemon.heartbeat', value: 3 }, { now: NOW }).ok).toBe(true);
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.heartbeat', value: 10 }, { now: NOW }).ok).toBe(true);
    const word = daemonHeartbeatSeconds([{ root: world.root, team: world.team }], world.home, NOW);
    expect(word.seconds).toBe(DAEMON_HEARTBEAT_SECONDS.release);
    expect(word.unknown).toContain('loosen');
  });

  test('the policy reader resolves at start, follows the seam when one owns the beat, and re-reads on refresh', () => {
    const world = makeWorld();
    const lines: string[] = [];
    const policy = createHeartbeatPolicy({
      seamMs: null,
      initialRoots: [world.root],
      roots: () => [{ root: world.root, team: world.team }],
      home: world.home,
      now: () => NOW,
      log: (text) => lines.push(text),
    });
    expect(policy.ms()).toBe(5_000);
    expect(policy.seconds()).toBe(5);

    // The word lands; the housekeeping refresh picks it up and says so.
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.heartbeat', value: 1 }, { now: NOW }).ok).toBe(true);
    policy.refresh();
    expect(policy.ms()).toBe(1_000);
    expect(policy.seconds()).toBe(1);
    expect(lines).toEqual(['daemon heartbeat: 1s (was 5s)']);

    // A refresh that finds the same word says nothing.
    policy.refresh();
    expect(lines).toHaveLength(1);

    // The seam owns the beat whole: no policy read, no word reported, no refresh.
    const seam = createHeartbeatPolicy({
      seamMs: 25,
      initialRoots: [world.root],
      roots: () => [{ root: world.root, team: world.team }],
      home: world.home,
      now: () => NOW,
      log: (text) => lines.push(text),
    });
    expect(seam.ms()).toBe(25);
    expect(seam.seconds()).toBeNull();
    seam.refresh();
    expect(seam.ms()).toBe(25);
    expect(lines).toHaveLength(1);
  });
});

describe('a running daemon with a heartbeat word', () => {
  test('records the word it runs, answers it to the probe and prints it in team daemon status', async () => {
    const world = makeWorld();
    expect(writePolicySet(world.home, { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.heartbeat', value: 3 }, { now: NOW }).ok).toBe(true);

    const started = await startMachineDaemon({ home: world.home, roots: [world.root], startedBy: 'manual', version: 'test' });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      // The start resolution is in the first state record, before any beat.
      const record = readDaemonState(world.home);
      expect(record.kind).toBe('ok');
      if (record.kind === 'ok') expect(record.state.heartbeatSeconds).toBe(3);

      const health = await daemonHealth(world.home);
      expect(health.state).toBe('running');
      expect(health.heartbeatSeconds).toBe(3);

      const io = testIo(world.home, { kind: 'owner' });
      expect(await runDaemon(['status'], io, { home: world.home, version: 'test' })).toBe(0);
      expect(io.out).toContain('heartbeat ');
      expect(io.out).toContain(' (every 3s)');
    } finally {
      await started.daemon.close();
    }
  });

  test('an injected seam owns the beat and the record carries no word', async () => {
    const world = makeWorld();
    const started = await startMachineDaemon({ home: world.home, roots: [world.root], startedBy: 'manual', version: 'test', heartbeatMs: 25 });
    expect(started.kind).toBe('serving');
    if (started.kind !== 'serving') return;
    try {
      const record = readDaemonState(world.home);
      expect(record.kind).toBe('ok');
      if (record.kind === 'ok') expect(record.state.heartbeatSeconds).toBeNull();

      const io = testIo(world.home, { kind: 'owner' });
      expect(await runDaemon(['status'], io, { home: world.home, version: 'test' })).toBe(0);
      expect(io.out).toContain('heartbeat ');
      expect(io.out).not.toContain('(every ');
    } finally {
      await started.daemon.close();
    }
  });
});
