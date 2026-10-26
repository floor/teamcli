// Independent coverage of the event thresholds as owner-set policies: the seven catalogue
// entries and the tighten-only chain, the shorten-only delay ceiling at the writer and at load,
// the shorter spellings written back under the canonical name, a signed chain that will not
// load refused by the commands that read it, and the numbers `team bus` and `team reply`
// actually apply.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../src/bus/log.ts';
import { busSocket } from '../src/bus/server.ts';
import { runBus } from '../src/commands/bus.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import {
  EVENT_THRESHOLDS,
  EVENT_THRESHOLD_POLICIES,
  eventThresholdsInForce,
  getPolicySpec,
  normalizePolicyName,
  writePolicySet,
  type EventThresholdField,
} from '../src/policy/index.ts';
import { policySignaturePayload } from '../src/policy/sources.ts';
import { POLICY_DOMAIN, type PolicyLevel } from '../src/policy/types.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { dropMessage } from '../src/send/native.ts';
import { markPending } from '../src/send/pending.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyOf, signDomain } from '../src/store/keys.ts';
import { parseYaml, toValue, type YamlValue } from '../src/yaml.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const SENT = '0f0e0d0c-0b0a-4a4b-8c8d-9e9f0a1b2c3d';
const REPLY = '3a3b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const TEAM_YAML = `format: 1
project: acme
entity: floor
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;

const FIELDS = Object.keys(EVENT_THRESHOLD_POLICIES) as EventThresholdField[];
const DELAYS = [
  'held_threshold_seconds',
  'unreachable_threshold_seconds',
  'idle_threshold_seconds',
] as const satisfies readonly EventThresholdField[];

type Fixture = { base: string; home: string; root: string; teamId: string };

const fixtures: Fixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    rmSync(fixtures.pop()!.base, { recursive: true, force: true });
  }
});

function makeFixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-event-thresholds-cov-')));
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  const fixture = { base, home, root, teamId: teamIdOf(root) };
  fixtures.push(fixture);
  return fixture;
}

function teamOf(fx: Fixture): TeamFile {
  const loaded = loadTeamFile(fx.root, { home: fx.home });
  if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
  return loaded.team;
}

function setPolicy(fx: Fixture, level: PolicyLevel, name: string, value: number, target?: string): void {
  const written = writePolicySet(
    fx.home,
    {
      level,
      target: target ?? (level === 'team' ? fx.teamId : 'floor'),
      ...(level === 'team' ? { teamRoot: fx.root } : {}),
      name,
      value,
    },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

function chainAt(fx: Fixture, upToLevel: PolicyLevel, seat?: { agentId: string; seat: Seat }) {
  const team = teamOf(fx);
  return eventThresholdsInForce({
    home: fx.home,
    entity: team.entity,
    root: fx.root,
    team,
    upToLevel,
    now: NOW,
    ...(seat === undefined ? {} : { agentId: seat.agentId, seat: seat.seat }),
  });
}

function registerWorker(fx: Fixture): string {
  const agent = registerAgent(fx.home, {
    name: 'worker',
    signing: { model: 'Claude Opus', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: fx.teamId, seat: 'worker', session: 'acme', pane: 'w2:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'owner',
  });
  return agent.id;
}

function placeSeat(fx: Fixture, name: string, pane: string): void {
  updateState(join(fx.root, '.agents'), (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats[name] = { stage: 'ready', pane };
  });
}

function workerSeat(fx: Fixture): Seat {
  const seat = teamOf(fx).seats.find((entry) => entry.name === 'worker');
  if (seat === undefined) throw new Error('the fixture has no worker seat');
  return seat;
}

/** A value a higher level may hold: above the release default where the field allows it. */
function higherValue(field: EventThresholdField): number {
  return (DELAYS as readonly EventThresholdField[]).includes(field)
    ? Math.floor(EVENT_THRESHOLDS[field] / 2)
    : EVENT_THRESHOLDS[field] * 2;
}

/** A value tighter than {@link higherValue} for the same field. */
function tighterValue(field: EventThresholdField): number {
  return (DELAYS as readonly EventThresholdField[]).includes(field)
    ? Math.floor(EVENT_THRESHOLDS[field] / 4)
    : EVENT_THRESHOLDS[field];
}

/** A value looser than {@link higherValue} while still inside the field's parse range. */
function looserValue(field: EventThresholdField): number {
  return (DELAYS as readonly EventThresholdField[]).includes(field)
    ? EVENT_THRESHOLDS[field]
    : EVENT_THRESHOLDS[field] * 3;
}

/** A value tighter than {@link tighterValue}, at the seat level. */
function seatValue(field: EventThresholdField): number {
  return (DELAYS as readonly EventThresholdField[]).includes(field)
    ? Math.floor(EVENT_THRESHOLDS[field] / 8)
    : Math.floor(EVENT_THRESHOLDS[field] / 2);
}

/**
 * Rewrites one signed policy entry's value and signs it again with the owner key. This is the
 * shape a source written by an older build has: a genuine owner signature over a value the
 * current catalogue refuses, which only the load-time reads can catch.
 */
function reSignEntry(fx: Fixture, level: 'team' | 'seat', canonical: string, value: number, agentId?: string): void {
  const path =
    level === 'team'
      ? join(fx.root, '.agents', 'team.yaml')
      : join(agentsDir(fx.home), `${agentId ?? ''}.yaml`);
  const text = readFileSync(path, 'utf8');
  const root = toValue(parseYaml(text));
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error(`${path} is not a map`);
  const policies = (root as Record<string, YamlValue>).policies;
  if (typeof policies !== 'object' || policies === null || Array.isArray(policies)) throw new Error(`${path} carries no policies`);
  const entry = (policies as Record<string, YamlValue>)[canonical];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${path} carries no "${canonical}" entry`);
  const fields = entry as Record<string, YamlValue>;
  if (
    typeof fields.value !== 'number'
    || typeof fields.signature !== 'string'
    || typeof fields.target !== 'string'
    || typeof fields.date !== 'string'
    || typeof fields.generation !== 'number'
    || typeof fields.kind !== 'string'
  ) {
    throw new Error(`${path}: "${canonical}" is not the entry shape this fixture re-signs`);
  }
  const payload = policySignaturePayload({
    name: canonical,
    value,
    level,
    target: fields.target,
    setter: 'owner',
    date: fields.date,
    expiry: typeof fields.expiry === 'string' ? fields.expiry : null,
    kind: fields.kind as 'enforced' | 'advised',
    generation: fields.generation,
  });
  const signature = signDomain(POLICY_DOMAIN, payload, keyOf(fx.home));
  const valueLine = `    value: ${String(fields.value)}`;
  const signatureLine = `    signature: "${fields.signature}"`;
  if (text.split(valueLine).length !== 2 || text.split(signatureLine).length !== 2) {
    throw new Error(`${path}: the entry is not written the way this fixture edits it`);
  }
  writeFileSync(path, text.replace(valueLine, `    value: ${String(value)}`).replace(signatureLine, `    signature: ${signature}`));
}

function readPolicies(fx: Fixture): Record<string, Record<string, YamlValue>> {
  const root = toValue(parseYaml(readFileSync(join(fx.root, '.agents', 'team.yaml'), 'utf8')));
  const policies = typeof root === 'object' && root !== null && !Array.isArray(root) ? root.policies : undefined;
  if (typeof policies !== 'object' || policies === null || Array.isArray(policies)) return {};
  return policies as Record<string, Record<string, YamlValue>>;
}

describe('the seven event thresholds tighten down the chain', () => {
  test('every field takes an equal or tighter word at the next level and refuses a looser one', () => {
    for (const field of FIELDS) {
      const name = EVENT_THRESHOLD_POLICIES[field];

      const equal = makeFixture();
      setPolicy(equal, 'entity', name, higherValue(field));
      setPolicy(equal, 'team', name, higherValue(field));
      const equalRead = chainAt(equal, 'team');
      expect(equalRead.ok).toBe(true);
      if (equalRead.ok) expect(equalRead.thresholds[field]).toBe(higherValue(field));

      const tighter = makeFixture();
      setPolicy(tighter, 'entity', name, higherValue(field));
      setPolicy(tighter, 'team', name, tighterValue(field));
      const tighterRead = chainAt(tighter, 'team');
      expect(tighterRead.ok).toBe(true);
      if (tighterRead.ok) expect(tighterRead.thresholds[field]).toBe(tighterValue(field));

      const looser = makeFixture();
      setPolicy(looser, 'entity', name, higherValue(field));
      setPolicy(looser, 'team', name, looserValue(field));
      const looserRead = chainAt(looser, 'team');
      expect(looserRead.ok).toBe(false);
      if (!looserRead.ok) {
        expect(looserRead.refusals[0]?.kind).toBe('loosening');
        expect(looserRead.refusals[0]?.message).toBe(
          `policy "${name}" at level team ("${String(looserValue(field))}") loosens level entity ("${String(higherValue(field))}")`,
        );
      }
    }
  });

  test('a seat word tightens every field over the team and is read only at the seat level', () => {
    for (const field of FIELDS) {
      const name = EVENT_THRESHOLD_POLICIES[field];
      const fx = makeFixture();
      const agentId = registerWorker(fx);
      setPolicy(fx, 'entity', name, higherValue(field));
      setPolicy(fx, 'team', name, tighterValue(field));
      setPolicy(fx, 'seat', name, seatValue(field), agentId);

      const atSeat = chainAt(fx, 'seat', { agentId, seat: workerSeat(fx) });
      expect(atSeat.ok).toBe(true);
      if (atSeat.ok) expect(atSeat.thresholds[field]).toBe(seatValue(field));

      const atTeam = chainAt(fx, 'team');
      expect(atTeam.ok).toBe(true);
      if (atTeam.ok) expect(atTeam.thresholds[field]).toBe(tighterValue(field));
    }
  });
});

describe('the delay thresholds carry the release default as a parse ceiling', () => {
  test('a signed word above the ceiling is refused when the chain loads', () => {
    for (const field of DELAYS) {
      const name = EVENT_THRESHOLD_POLICIES[field];
      const ceiling = EVENT_THRESHOLDS[field];
      const fx = makeFixture();

      setPolicy(fx, 'team', name, ceiling);
      const atCeiling = chainAt(fx, 'team');
      expect(atCeiling.ok).toBe(true);
      if (atCeiling.ok) expect(atCeiling.thresholds[field]).toBe(ceiling);

      reSignEntry(fx, 'team', name, ceiling + 1);
      const above = chainAt(fx, 'team');
      expect(above.ok).toBe(false);
      if (!above.ok) {
        expect(above.refusals[0]?.kind).toBe('invalid-policy');
        expect(above.refusals[0]?.message).toBe(
          `team: policy "${name}" may only be shortened: ${String(ceiling + 1)}s exceeds the release default ${String(ceiling)}s`,
        );
      }
    }
  });

  test('a delay alias accepts the release default and refuses one second above it before signing', async () => {
    for (const alias of ['held', 'unreachable', 'idle']) {
      const canonical = getPolicySpec(alias)?.name;
      expect(canonical).toBeDefined();
      const field = FIELDS.find((candidate) => EVENT_THRESHOLD_POLICIES[candidate] === canonical);
      if (field === undefined) throw new Error(`no field for ${alias}`);
      const ceiling = EVENT_THRESHOLDS[field];
      const fx = makeFixture();

      const accepted = testIo(fx.root, { kind: 'owner' });
      const acceptedCode = await runPolicy(
        ['set', 'team', alias, String(ceiling), '--file', '.agents/team.yaml'],
        accepted,
        { home: fx.home, now: NOW },
      );
      expect(acceptedCode).toBe(0);
      expect(accepted.out).toBe(`policy: set ${canonical}=${String(ceiling)} at team (${fx.teamId})\n`);
      expect(readPolicies(fx)[canonical!]?.value).toBe(ceiling);

      const refused = testIo(fx.root, { kind: 'owner' });
      const refusedCode = await runPolicy(
        ['set', 'team', alias, String(ceiling + 1), '--file', '.agents/team.yaml'],
        refused,
        { home: fx.home, now: NOW },
      );
      expect(refusedCode).toBe(2);
      expect(refused.out).toBe('');
      expect(refused.err).toBe(
        `team policy: team: policy "${canonical}" may only be shortened: ${String(ceiling + 1)}s exceeds the release default ${String(ceiling)}s\n`,
      );
      // The refused word was never signed: the accepted one is what the source holds.
      expect(readPolicies(fx)[canonical!]?.value).toBe(ceiling);
    }
  });
});

describe('the shorter spellings resolve and are written back canonically', () => {
  const ALIASES: Record<EventThresholdField, readonly string[]> = {
    thread_ttl_seconds: ['thread-ttl', 'thread_ttl', 'thread_ttl_seconds', 'event_thread_ttl_seconds'],
    thread_cap: ['thread-cap', 'thread_cap', 'event_thread_cap'],
    retention_days: ['retention', 'retention_days', 'event_retention_days'],
    held_threshold_seconds: ['held', 'held_threshold_seconds', 'event_held_threshold_seconds'],
    unreachable_threshold_seconds: ['unreachable', 'unreachable_threshold_seconds', 'event_unreachable_threshold_seconds'],
    idle_threshold_seconds: ['idle', 'idle_threshold_seconds', 'event_idle_threshold_seconds'],
    reconcile_interval_seconds: ['reconcile', 'reconcile_interval_seconds', 'event_reconcile_interval_seconds'],
  };

  const VALUE: Record<EventThresholdField, number> = {
    thread_ttl_seconds: 3_600,
    thread_cap: 7,
    retention_days: 7,
    held_threshold_seconds: 60,
    unreachable_threshold_seconds: 60,
    idle_threshold_seconds: 60,
    reconcile_interval_seconds: 30,
  };

  test('every spelling normalizes to its canonical policy and the canonical name is what is written', async () => {
    for (const field of FIELDS) {
      const canonical = EVENT_THRESHOLD_POLICIES[field];
      for (const alias of ALIASES[field]) {
        expect(normalizePolicyName(alias)).toBe(canonical);
        expect(getPolicySpec(alias)?.name).toBe(canonical);

        const fx = makeFixture();
        const io = testIo(fx.root, { kind: 'owner' });
        const code = await runPolicy(
          ['set', 'team', alias, String(VALUE[field]), '--file', '.agents/team.yaml'],
          io,
          { home: fx.home, now: NOW },
        );
        expect(code).toBe(0);
        expect(io.err).toBe('');
        expect(io.out).toBe(`policy: set ${canonical}=${String(VALUE[field])} at team (${fx.teamId})\n`);
        expect(Object.keys(readPolicies(fx))).toEqual([canonical]);
        expect(readPolicies(fx)[canonical]?.value).toBe(VALUE[field]);
      }
    }
  });
});

describe('a chain that will not load is refused, never guessed at', () => {
  function breakEntitySource(fx: Fixture): string {
    const path = join(fx.home, '.config', 'team', 'entities.yaml');
    mkdirSync(join(fx.home, '.config', 'team'), { recursive: true });
    writeFileSync(path, 'entities:\n  floor: [\n');
    return path;
  }

  function stopNextTick(): (end: () => void) => () => void {
    return (end) => {
      setTimeout(end, 0);
      return () => {};
    };
  }

  function plantOwnerRecord(fx: Fixture): void {
    plantRecord(fx.home, fx.root, 'acme', 'owner', SENT, 'from the worker — admitted by: a seat to its own team\'s orchestrator\n\nquestion', {
      from: 'worker',
      at: NOW.toISOString(),
    });
  }

  test('an unreadable entity source stops team bus and team reply before either acts', async () => {
    const fx = makeFixture();
    const source = breakEntitySource(fx);

    const read = chainAt(fx, 'team');
    expect(read.ok).toBe(false);
    if (!read.ok) {
      const refusal = read.refusals[0];
      expect(refusal?.kind).toBe('unreadable-source');
      if (refusal?.kind === 'unreadable-source') {
        expect(refusal.level).toBe('entity');
        expect(refusal.message.startsWith('entity: policy source cannot be read or verified (')).toBe(true);
      }
      expect(source.endsWith('entities.yaml')).toBe(true);
    }

    const busIo = testIo(fx.root, { kind: 'owner' });
    const busCode = await runBus([], busIo, { home: fx.home, stop: stopNextTick() });
    expect(busCode).toBe(2);
    expect(busIo.err.startsWith('team bus: entity: policy source cannot be read or verified (')).toBe(true);
    expect(existsSync(busSocket(fx.root))).toBe(false);

    plantOwnerRecord(fx);
    const replyIo = testIo(fx.root, { kind: 'owner' });
    const replyCode = await runReply([SENT, '--close'], replyIo, { home: fx.home, now: () => NOW });
    expect(replyCode).toBe(2);
    expect(replyIo.err.startsWith('team reply: entity: policy source cannot be read or verified (')).toBe(true);
    expect(existsSync(join(recordDir(fx.root, 'acme', 'owner'), `${SENT}.closed.json`))).toBe(false);
  });

  test('a signed word above the delay ceiling stops team bus and team reply', async () => {
    const fx = makeFixture();
    setPolicy(fx, 'team', 'event-held-threshold-seconds', EVENT_THRESHOLDS.held_threshold_seconds);
    reSignEntry(fx, 'team', 'event-held-threshold-seconds', EVENT_THRESHOLDS.held_threshold_seconds + 1);
    const problem = `team: policy "event-held-threshold-seconds" may only be shortened: ${String(EVENT_THRESHOLDS.held_threshold_seconds + 1)}s exceeds the release default ${String(EVENT_THRESHOLDS.held_threshold_seconds)}s`;

    const busIo = testIo(fx.root, { kind: 'owner' });
    const busCode = await runBus([], busIo, { home: fx.home, stop: stopNextTick() });
    expect(busCode).toBe(2);
    expect(busIo.err).toBe(`team bus: ${problem}\n`);
    expect(existsSync(busSocket(fx.root))).toBe(false);

    plantOwnerRecord(fx);
    const replyIo = testIo(fx.root, { kind: 'owner' });
    const replyCode = await runReply([SENT, '--close'], replyIo, { home: fx.home, now: () => NOW });
    expect(replyCode).toBe(2);
    expect(replyIo.err).toBe(`team reply: ${problem}\n`);
    expect(existsSync(join(recordDir(fx.root, 'acme', 'owner'), `${SENT}.closed.json`))).toBe(false);
  });

  test('a signed loosening between levels stops team bus and, at the seat, team reply', async () => {
    const fx = makeFixture();
    setPolicy(fx, 'entity', 'event-held-threshold-seconds', 300);
    setPolicy(fx, 'team', 'event-held-threshold-seconds', 120);
    reSignEntry(fx, 'team', 'event-held-threshold-seconds', 400);
    const teamProblem = 'policy "event-held-threshold-seconds" at level team ("400") loosens level entity ("300")';

    const busIo = testIo(fx.root, { kind: 'owner' });
    const busCode = await runBus([], busIo, { home: fx.home, stop: stopNextTick() });
    expect(busCode).toBe(2);
    expect(busIo.err).toBe(`team bus: ${teamProblem}\n`);
    expect(existsSync(busSocket(fx.root))).toBe(false);

    const seatFx = makeFixture();
    const agentId = registerWorker(seatFx);
    setPolicy(seatFx, 'team', 'event-held-threshold-seconds', 300);
    setPolicy(seatFx, 'seat', 'event-held-threshold-seconds', 120, agentId);
    reSignEntry(seatFx, 'seat', 'event-held-threshold-seconds', 400, agentId);

    placeSeat(seatFx, 'worker', 'w2:p1');
    plantRecord(seatFx.home, seatFx.root, 'acme', 'worker', SENT, 'question', { from: 'lead', at: NOW.toISOString() });
    const replyIo = testIo(seatFx.root, { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    const replyCode = await runReply([SENT, '--close'], replyIo, { home: seatFx.home, now: () => NOW });
    expect(replyCode).toBe(2);
    expect(replyIo.err).toBe('team reply: policy "event-held-threshold-seconds" at level seat ("400") loosens level team ("300")\n');
    expect(existsSync(join(recordDir(seatFx.root, 'acme', 'worker'), `${SENT}.closed.json`))).toBe(false);
  });
});

describe('the bus serves on the numbers the chain resolves', () => {
  function stopNextTick(): (end: () => void) => () => void {
    return (end) => {
      setTimeout(end, 0);
      return () => {};
    };
  }

  function heldDrops(fx: Fixture): void {
    const seatDir = join(fx.root, '.agents', 'send-drops', 'acme', 'worker');
    const body = 'from the owner — admitted by: the owner\n\nheld';
    dropMessage(seatDir, 'held-1', body);
    markPending(seatDir, {
      id: 'held-1',
      from: 'owner',
      to: 'worker',
      body,
      ts: new Date(Date.now() - 120_000).toISOString(),
    });
  }

  function eventTags(fx: Fixture): string[] {
    const read = readEvents('acme', fx.root, fx.home);
    if (!read.ok) throw new Error(read.reason);
    return read.events.map((entry) => `${entry.payload.kind}:${entry.payload.record_id}`);
  }

  test('a shortened held threshold lets the starting bus raise message.held for a two-minute-old drop', async () => {
    const shortened = makeFixture();
    setPolicy(shortened, 'team', 'event-held-threshold-seconds', 60);
    heldDrops(shortened);
    const shortenedIo = testIo(shortened.root, { kind: 'owner' });
    expect(await runBus([], shortenedIo, { home: shortened.home, stop: stopNextTick() })).toBe(0);
    expect(eventTags(shortened)).toContain('message.held:held-1:held');

    const byDefault = makeFixture();
    heldDrops(byDefault);
    const defaultIo = testIo(byDefault.root, { kind: 'owner' });
    expect(await runBus([], defaultIo, { home: byDefault.home, stop: stopNextTick() })).toBe(0);
    expect(eventTags(byDefault)).toContain('message.arrived:held-1');
    expect(eventTags(byDefault)).not.toContain('message.held:held-1:held');
  });

  test('a shortened retention window lets the starting bus drop an old segment and declare it', async () => {
    const old = new Date(Date.now() - 3 * 86_400_000);
    function plantOldEvent(fx: Fixture): void {
      const appended = appendEvent(
        'acme',
        fx.root,
        fx.home,
        {
          ts: old.toISOString(),
          kind: 'message.arrived',
          session: 'acme',
          record_id: 'old-1',
          from: 'worker',
          to: 'lead',
        },
        { retain: false },
      );
      if (!appended.ok) throw new Error(appended.reason);
      utimesSync(appended.path, old.getTime() / 1_000, old.getTime() / 1_000);
    }

    const shortened = makeFixture();
    plantOldEvent(shortened);
    setPolicy(shortened, 'team', 'event-retention-days', 1);
    const shortenedIo = testIo(shortened.root, { kind: 'owner' });
    expect(await runBus([], shortenedIo, { home: shortened.home, stop: stopNextTick() })).toBe(0);
    const dropped = eventTags(shortened);
    expect(dropped).not.toContain('message.arrived:old-1');
    expect(dropped.some((tag) => tag.startsWith('team.event-log-dropped:'))).toBe(true);

    const byDefault = makeFixture();
    plantOldEvent(byDefault);
    const defaultIo = testIo(byDefault.root, { kind: 'owner' });
    expect(await runBus([], defaultIo, { home: byDefault.home, stop: stopNextTick() })).toBe(0);
    expect(eventTags(byDefault)).toContain('message.arrived:old-1');
  });

  test('the bus hands the team-level reconcile, retention and held numbers to the server', () => {
    const proc = Bun.spawnSync(['bun', join(import.meta.dir, 'event-thresholds-bus-run.ts')], {
      cwd: join(import.meta.dir, '..'),
      // The harness is a plain script, outside the suite preload: it keeps the file source here.
      env: { ...process.env, TEAM_CONFIG_SOURCE: 'file' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = proc.stderr.toString();
    if (proc.exitCode !== 0) throw new Error(`the bus input harness failed: ${stderr}`);
    const result = JSON.parse(proc.stdout.toString()) as {
      wired: {
        code: number;
        starts: number;
        captured: { reconcileIntervalMs: number; retentionSeconds: number; heldThresholdSeconds: number } | null;
      };
      broken: { code: number; starts: number; captured: unknown };
    };
    expect(result.wired.code).toBe(0);
    expect(result.wired.starts).toBe(1);
    expect(result.wired.captured).toEqual({
      reconcileIntervalMs: 7_000,
      retentionSeconds: 2 * 86_400,
      heldThresholdSeconds: 90,
    });
    expect(result.broken.code).toBe(2);
    expect(result.broken.starts).toBe(0);
    expect(result.broken.captured).toBeNull();
  });
});

describe('team reply reads the thread life and cap from the caller chain', () => {
  function threadRecords(fx: Fixture, seat: string, thread: string, count: number, at: string): void {
    for (let index = 0; index < count; index += 1) {
      plantRecord(fx.home, fx.root, 'acme', seat, `${thread}-${String(index).padStart(2, '0')}`, 'question', {
        from: 'lead',
        at,
        thread,
      });
    }
  }

  function host(fx: Fixture, newId?: () => string): ReplyHost {
    return { home: fx.home, now: () => NOW, ...(newId === undefined ? {} : { newId }) };
  }

  async function replyOn(
    fx: Fixture,
    argv: string[],
    caller: { kind: 'owner' } | { kind: 'seat'; name: string; pane: string; session: string },
    newId?: () => string,
  ): Promise<{ code: number; out: string; err: string }> {
    const io = testIo(fx.root, caller);
    const code = await runReply(argv, io, host(fx, newId));
    return { code, out: io.out, err: io.err };
  }

  test('a team thread life closes the thread at its boundary and names the life from the chain', async () => {
    const fx = makeFixture();
    setPolicy(fx, 'team', 'event-thread-ttl-seconds', 7_200);
    plantRecord(fx.home, fx.root, 'acme', 'owner', SENT, 'question', {
      from: 'worker',
      at: new Date(NOW.getTime() - 7_200_000).toISOString(),
    });

    const closed = await replyOn(fx, [SENT, '--close'], { kind: 'owner' });
    expect(closed.code).toBe(1);
    expect(closed.err).toBe(`team reply: the thread ${SENT} ended: no record on it for 2h; nothing was written\n`);

    const opened = await replyOn(fx, [SENT, 'still here'], { kind: 'owner' }, () => REPLY);
    expect(opened.code).toBe(0);
    expect(recordAt(join(recordDir(fx.root, 'acme', 'worker'), REPLY)).payload.thread).toBe(REPLY);

    const inside = makeFixture();
    setPolicy(inside, 'team', 'event-thread-ttl-seconds', 7_200);
    plantRecord(inside.home, inside.root, 'acme', 'owner', SENT, 'question', {
      from: 'worker',
      at: new Date(NOW.getTime() - 7_199_000).toISOString(),
    });
    expect((await replyOn(inside, [SENT, '--close'], { kind: 'owner' })).code).toBe(0);
  });

  test('a seat word shortens the life for that seat and leaves the team word for the owner', async () => {
    const seatSide = makeFixture();
    const agentId = registerWorker(seatSide);
    setPolicy(seatSide, 'team', 'event-thread-ttl-seconds', 7_200);
    setPolicy(seatSide, 'seat', 'event-thread-ttl-seconds', 3_600, agentId);
    placeSeat(seatSide, 'worker', 'w2:p1');
    plantRecord(seatSide.home, seatSide.root, 'acme', 'worker', SENT, 'question', {
      from: 'lead',
      at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    });
    const fromSeat = await replyOn(seatSide, [SENT, '--close'], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    expect(fromSeat.code).toBe(1);
    expect(fromSeat.err).toBe(`team reply: the thread ${SENT} ended: no record on it for 1h; nothing was written\n`);

    const ownerSide = makeFixture();
    const ownerAgentId = registerWorker(ownerSide);
    setPolicy(ownerSide, 'team', 'event-thread-ttl-seconds', 7_200);
    setPolicy(ownerSide, 'seat', 'event-thread-ttl-seconds', 3_600, ownerAgentId);
    plantRecord(ownerSide.home, ownerSide.root, 'acme', 'owner', SENT, 'question', {
      from: 'worker',
      at: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(),
    });
    const fromOwner = await replyOn(ownerSide, [SENT, '--close'], { kind: 'owner' });
    expect(fromOwner.code).toBe(1);
    expect(fromOwner.err).toBe(`team reply: the thread ${SENT} ended: no record on it for 2h; nothing was written\n`);
  });

  test('a seat cap over the team cap ends the thread for that seat and not for the owner', async () => {
    const seatSide = makeFixture();
    const agentId = registerWorker(seatSide);
    setPolicy(seatSide, 'team', 'event-thread-cap', 5);
    setPolicy(seatSide, 'seat', 'event-thread-cap', 3, agentId);
    placeSeat(seatSide, 'worker', 'w2:p1');
    threadRecords(seatSide, 'worker', 'cap-a', 3, NOW.toISOString());
    const fromSeat = await replyOn(seatSide, ['cap-a-00', '--close'], { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' });
    expect(fromSeat.code).toBe(1);
    expect(fromSeat.err).toBe('team reply: the thread cap-a ended at its 3-record cap; nothing was written\n');

    const ownerSide = makeFixture();
    const ownerAgentId = registerWorker(ownerSide);
    setPolicy(ownerSide, 'team', 'event-thread-cap', 5);
    setPolicy(ownerSide, 'seat', 'event-thread-cap', 3, ownerAgentId);
    threadRecords(ownerSide, 'owner', 'cap-b', 3, NOW.toISOString());
    // The owner reads the team word: three records are inside a five-record cap.
    expect((await replyOn(ownerSide, ['cap-b-00', '--close'], { kind: 'owner' })).code).toBe(0);

    const boundary = makeFixture();
    setPolicy(boundary, 'team', 'event-thread-cap', 5);
    threadRecords(boundary, 'owner', 'cap-c', 5, NOW.toISOString());
    const atCap = await replyOn(boundary, ['cap-c-00', '--close'], { kind: 'owner' });
    expect(atCap.code).toBe(1);
    expect(atCap.err).toBe('team reply: the thread cap-c ended at its 5-record cap; nothing was written\n');
  });

  test('the ended-thread refusal names the life in the --json message too', async () => {
    const fx = makeFixture();
    setPolicy(fx, 'team', 'event-thread-ttl-seconds', 7_200);
    plantRecord(fx.home, fx.root, 'acme', 'owner', SENT, 'question', {
      from: 'worker',
      at: new Date(NOW.getTime() - 8 * 3_600_000).toISOString(),
    });
    const io = testIo(fx.root, { kind: 'owner' });
    const code = await runReply([SENT, '--close', '--json'], io, host(fx));
    expect(code).toBe(1);
    const doc = JSON.parse(io.out) as { error: { id: string; message: string } };
    expect(doc.error.id).toBe('reply.refused');
    expect(doc.error.message).toContain('no record on it for 2h');
  });
});
