// The event thresholds as owner-set policies: the seven catalogued names, their release
// defaults, the shorten-only ceiling on the three delay thresholds, the tighten-only chain, the
// `team policy view` rows, and the resolved set the bus and `team reply` read.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPolicy } from '../src/commands/policy.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  ENFORCED_POLICY_NAMES,
  EVENT_THRESHOLDS,
  EVENT_THRESHOLD_POLICIES,
  eventThresholdsInForce,
  getPolicySpec,
  resolvePolicy,
  writePolicySet,
  type EventThresholdField,
  type Policy,
} from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { deliverBriefs, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T12:00:00Z');

const TEAM_YAML = `format: 1
project: beacon
entity: floor
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function makeFixture(): {
  home: string;
  root: string;
  teamId: string;
  leadAgentId: string;
  cleanup: () => void;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-event-thresholds-')));
  const home = join(base, 'home');
  const root = join(base, 'beacon');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);

  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const teamId = teamIdOf(root);
  const leadAgent = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'lead', session: 'beacon', pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  const workerAgent = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: teamId, seat: 'worker', session: 'beacon', pane: 'w2:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  upsertTeam(home, teamId, {
    project: validated.team.project,
    session: validated.team.session,
    root,
    roster: [
      { seat: 'lead', agent: leadAgent.id, role: 'coordinator', leads: true },
      { seat: 'worker', agent: workerAgent.id, role: 'implementer' },
    ],
    at: NOW.toISOString(),
  });
  upsertProject(home, 'beacon', {
    name: 'beacon',
    entity: validated.team.entity,
    teams: [teamId],
    at: NOW.toISOString(),
  });
  updateState(join(root, '.agents'), (state) => {
    const session = (state.sessions[validated.team.session] ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats.lead = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
    session.seats.worker = { stage: 'ready', pane: 'w2:p1', workspace: 'w2' };
  });
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: validated.team.session,
    seats: validated.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });

  return { home, root, teamId, leadAgentId: leadAgent.id, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function declaration(name: string, value: number, level: Policy['level']): Policy {
  return { name, value, level, setter: 'owner', date: NOW.toISOString(), kind: 'enforced' };
}

const FIELDS = Object.keys(EVENT_THRESHOLD_POLICIES) as EventThresholdField[];

describe('the event thresholds as owner-set policies', () => {
  test('the seven fields are enforced catalogue policies at every level, their defaults the release numbers', () => {
    expect(FIELDS).toEqual([
      'thread_ttl_seconds',
      'thread_cap',
      'retention_days',
      'held_threshold_seconds',
      'unreachable_threshold_seconds',
      'idle_threshold_seconds',
      'reconcile_interval_seconds',
    ]);
    for (const field of FIELDS) {
      const name = EVENT_THRESHOLD_POLICIES[field];
      expect(ENFORCED_POLICY_NAMES).toContain(name);
      const spec = getPolicySpec(name);
      expect(spec).not.toBeNull();
      expect(spec?.kind).toBe('enforced');
      expect(spec?.levels).toEqual(['entity', 'project', 'team', 'seat']);
      expect(spec?.defaultValue).toBe(EVENT_THRESHOLDS[field]);
    }
  });

  test('the three delay thresholds may be shortened but never lengthened past the release default', () => {
    for (const field of ['held_threshold_seconds', 'unreachable_threshold_seconds', 'idle_threshold_seconds'] as const) {
      const name = EVENT_THRESHOLD_POLICIES[field];
      const ceiling = EVENT_THRESHOLDS[field];

      const equal = resolvePolicy(name, [declaration(name, ceiling, 'entity')]);
      expect(equal.ok).toBe(true);
      if (equal.ok) expect(equal.effective.value).toBe(ceiling);

      const shorter = resolvePolicy(name, [declaration(name, ceiling - 1, 'entity')]);
      expect(shorter.ok).toBe(true);

      const longer = resolvePolicy(name, [declaration(name, ceiling + 1, 'entity')]);
      expect(longer.ok).toBe(false);
      if (!longer.ok) {
        expect(longer.refusals[0]?.kind).toBe('invalid-policy');
        expect(longer.refusals[0]?.message).toContain('may only be shortened');
        expect(longer.refusals[0]?.message).toContain(`${String(ceiling)}s`);
      }
    }
  });

  test('the thread, cap, retention and reconcile numbers may be lengthened, and every field still tightens down the chain', () => {
    for (const field of ['thread_ttl_seconds', 'thread_cap', 'retention_days', 'reconcile_interval_seconds'] as const) {
      const name = EVENT_THRESHOLD_POLICIES[field];
      const longer = resolvePolicy(name, [declaration(name, EVENT_THRESHOLDS[field] * 2, 'entity')]);
      expect(longer.ok).toBe(true);
    }

    const held = EVENT_THRESHOLD_POLICIES.held_threshold_seconds;
    const tightened = resolvePolicy(held, [
      declaration(held, 300, 'entity'),
      declaration(held, 120, 'team'),
    ]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) expect(tightened.effective.value).toBe(120);

    const loosened = resolvePolicy(held, [
      declaration(held, 300, 'entity'),
      declaration(held, 400, 'team'),
    ]);
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) expect(loosened.refusals[0]?.kind).toBe('loosening');
  });

  test('the names the brief uses and the group spellings resolve to the canonical policies', () => {
    expect(getPolicySpec('held')?.name).toBe('event-held-threshold-seconds');
    expect(getPolicySpec('held_threshold_seconds')?.name).toBe('event-held-threshold-seconds');
    expect(getPolicySpec('thread-ttl')?.name).toBe('event-thread-ttl-seconds');
    expect(getPolicySpec('thread_cap')?.name).toBe('event-thread-cap');
    expect(getPolicySpec('retention')?.name).toBe('event-retention-days');
    expect(getPolicySpec('unreachable')?.name).toBe('event-unreachable-threshold-seconds');
    expect(getPolicySpec('idle')?.name).toBe('event-idle-threshold-seconds');
    expect(getPolicySpec('reconcile')?.name).toBe('event-reconcile-interval-seconds');
  });

  test('team policy set refuses a delay above the default before writing, and writes a shorter one', async () => {
    const fx = makeFixture();
    try {
      const refusedIo = testIo(fx.root, { kind: 'owner' });
      const refusedCode = await runPolicy(
        ['set', 'team', 'held', '900', '--file', '.agents/team.yaml'],
        refusedIo,
        { home: fx.home, now: () => NOW },
      );
      expect(refusedCode).toBe(2);
      expect(refusedIo.err).toContain('may only be shortened');

      const setIo = testIo(fx.root, { kind: 'owner' });
      const setCode = await runPolicy(
        ['set', 'team', 'held', '120', '--file', '.agents/team.yaml'],
        setIo,
        { home: fx.home, now: () => NOW },
      );
      expect(setCode).toBe(0);
      expect(setIo.out).toContain('policy: set event-held-threshold-seconds=120 at team');

      const capIo = testIo(fx.root, { kind: 'owner' });
      const capCode = await runPolicy(
        ['set', 'team', 'thread-cap', '10', '--file', '.agents/team.yaml'],
        capIo,
        { home: fx.home, now: () => NOW },
      );
      expect(capCode).toBe(0);
      expect(capIo.out).toContain('policy: set event-thread-cap=10 at team');
    } finally {
      fx.cleanup();
    }
  });

  test('team policy view lists all seven with the release defaults', async () => {
    const fx = makeFixture();
    try {
      const io = testIo(fx.root, { kind: 'owner' });
      const code = await runPolicy(['--json', '--file', '.agents/team.yaml'], io, { home: fx.home, now: () => NOW });
      expect(code).toBe(0);
      const doc = JSON.parse(io.out) as { policies: { name: string; value: number; level: string }[] };
      for (const field of FIELDS) {
        const name = EVENT_THRESHOLD_POLICIES[field];
        const row = doc.policies.find((item) => item.name === name);
        expect(row).toBeDefined();
        expect(row?.value).toBe(EVENT_THRESHOLDS[field]);
        expect(row?.level).toBe('default');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('eventThresholdsInForce reads the chain, including a seat word over the team word', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root };
      const defaults = eventThresholdsInForce({ ...base, upToLevel: 'team', now: NOW });
      expect(defaults.ok).toBe(true);
      if (defaults.ok) {
        expect(defaults.thresholds.held_threshold_seconds).toBe(EVENT_THRESHOLDS.held_threshold_seconds);
        expect(defaults.thresholds.thread_ttl_seconds).toBe(EVENT_THRESHOLDS.thread_ttl_seconds);
      }

      const entityWrite = writePolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'event-held-threshold-seconds', value: '120s' },
        { now: NOW },
      );
      expect(entityWrite.ok).toBe(true);
      const teamWrite = writePolicySet(
        fx.home,
        { level: 'team', target: fx.teamId, teamRoot: fx.root, name: 'event-thread-cap', value: 10 },
        { now: NOW },
      );
      expect(teamWrite.ok).toBe(true);
      const seatWrite = writePolicySet(
        fx.home,
        { level: 'seat', target: fx.leadAgentId, name: 'event-thread-ttl-seconds', value: 3_600 },
        { now: NOW },
      );
      expect(seatWrite.ok).toBe(true);

      const teamRead = eventThresholdsInForce({ ...base, upToLevel: 'team', now: NOW });
      expect(teamRead.ok).toBe(true);
      if (teamRead.ok) {
        expect(teamRead.thresholds.held_threshold_seconds).toBe(120);
        expect(teamRead.thresholds.thread_cap).toBe(10);
        expect(teamRead.thresholds.thread_ttl_seconds).toBe(EVENT_THRESHOLDS.thread_ttl_seconds);
      }

      const seatRead = eventThresholdsInForce({
        ...base,
        agentId: fx.leadAgentId,
        upToLevel: 'seat',
        now: NOW,
      });
      expect(seatRead.ok).toBe(true);
      if (seatRead.ok) expect(seatRead.thresholds.thread_ttl_seconds).toBe(3_600);
    } finally {
      fx.cleanup();
    }
  });
});
