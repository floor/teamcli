// The delivery timing policies: the reviewed attempt budget per route, the main fallback delay,
// the shorten-only chain each is read through, and the two in-force readers B1 and B2 consume.
// The values are the Atlas timing decision of 2026-10-20; the legacy unreachable threshold is
// read beside the main delay as a cap only when a level declares it.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entitiesPath } from '../src/entities.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import {
  DELIVERY_ESCALATION_SECONDS,
  DELIVERY_LEGACY_ESCALATION_DEFAULT_SECONDS,
  DELIVERY_PREPROBE_MS,
  DELIVERY_RECEIPT_SECONDS,
  DELIVERY_TIMEOUT_DEFAULTS,
  deliveryEscalationDelay,
  deliveryTimeoutInForce,
  ENFORCED_POLICY_NAMES,
  getPolicySpec,
  receiptSecondsFor,
  resolvePolicy,
  writePolicySet,
  type Policy,
  type PolicyLevel,
} from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import { deliverBriefs } from './helpers.ts';

const NOW = new Date('2026-10-20T12:00:00Z');

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
  team: TeamFile;
  cleanup: () => void;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delivery-policy-')));
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

  return { home, root, teamId, team: validated.team, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function word(name: string, value: Policy['value'], level: PolicyLevel): Policy[] {
  return [{ name, value, level, setter: 'owner', date: NOW.toISOString(), kind: 'enforced' }];
}

describe('the delivery timing policies', () => {
  test('the reviewed values are the catalogue defaults and only entity, project and team may set them', () => {
    expect(DELIVERY_ESCALATION_SECONDS).toBe(300);
    expect(DELIVERY_TIMEOUT_DEFAULTS).toEqual({ socket: 15, 'mcp-inbox': 15, typed: 15, native: 15 });
    expect(DELIVERY_PREPROBE_MS).toBe(400);
    expect(DELIVERY_RECEIPT_SECONDS).toBe(120);
    expect(DELIVERY_LEGACY_ESCALATION_DEFAULT_SECONDS).toBe(600);

    for (const name of ['delivery-order', 'delivery-timeout', 'delivery-escalation']) {
      expect(ENFORCED_POLICY_NAMES as readonly string[]).toContain(name);
    }
    const timeout = getPolicySpec('delivery-timeout');
    expect(timeout?.levels).toEqual(['entity', 'project', 'team']);
    expect(timeout?.defaultValue).toBe('socket=15,mcp-inbox=15,typed=15,native=15');
    const escalation = getPolicySpec('delivery-escalation');
    expect(escalation?.levels).toEqual(['entity', 'project', 'team']);
    expect(escalation?.defaultValue).toBe(300);
    expect(getPolicySpec('delivery_timeout')?.name).toBe('delivery-timeout');
    expect(getPolicySpec('delivery_escalation')?.name).toBe('delivery-escalation');
  });

  test('a delivery-timeout word names any route and inherits the release default for the rest', () => {
    const result = resolvePolicy('delivery-timeout', word('delivery-timeout', 'typed=5', 'team'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effective.value).toBe('socket=15,mcp-inbox=15,typed=5,native=15');
  });

  test('native is a live route with an attempt budget even without a read acknowledgement', () => {
    const result = resolvePolicy('delivery-timeout', word('delivery-timeout', 'native=20', 'team'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effective.value).toBe('socket=15,mcp-inbox=15,typed=15,native=20');
  });

  test('a route with no live attempt is refused with its reason', () => {
    for (const route of ['durable-copy', 'drop']) {
      const result = resolvePolicy('delivery-timeout', word('delivery-timeout', `${route}=5`, 'team'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusals[0]?.kind).toBe('invalid-policy');
        expect(result.refusals[0]?.message).toContain(`route "${route}" has no live receipt wait and no attempt budget`);
      }
    }
    const accepted = resolvePolicy('delivery-timeout', word('delivery-timeout', 'socket-accepted=5', 'team'));
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.refusals[0]?.message).toContain('socket-accepted is not available in this release');
  });

  test('a malformed, duplicated, unknown or out-of-range route is refused', () => {
    for (const value of ['typed=5,typed=6', 'pigeon=5', 'typed=0', 'typed=90000', 'typed', '=5']) {
      const result = resolvePolicy('delivery-timeout', word('delivery-timeout', value, 'team'));
      expect(result.ok).toBe(false);
    }
  });

  test('a lower level may shorten a route and not lengthen one', () => {
    const shortened = resolvePolicy('delivery-timeout', [
      ...word('delivery-timeout', 'socket=10,mcp-inbox=15,typed=15', 'entity'),
      ...word('delivery-timeout', 'socket=4,mcp-inbox=15,typed=15', 'team'),
    ]);
    expect(shortened.ok).toBe(true);
    if (shortened.ok) expect(shortened.effective.value).toBe('socket=4,mcp-inbox=15,typed=15,native=15');

    const lengthened = resolvePolicy('delivery-timeout', [
      ...word('delivery-timeout', 'socket=10,mcp-inbox=15,typed=15', 'entity'),
      ...word('delivery-timeout', 'socket=20,mcp-inbox=15,typed=15', 'team'),
    ]);
    expect(lengthened.ok).toBe(false);
    if (!lengthened.ok) {
      expect(lengthened.refusals[0]).toMatchObject({
        kind: 'loosening',
        policy: 'delivery-timeout',
        lowerLevel: 'team',
        higherLevel: 'entity',
      });
    }
  });

  test('a sparse lower word inherits the parent budgets it does not name', () => {
    const inherited = resolvePolicy('delivery-timeout', [
      ...word('delivery-timeout', 'socket=5', 'entity'),
      ...word('delivery-timeout', 'typed=4', 'team'),
    ]);
    expect(inherited.ok).toBe(true);
    if (inherited.ok) expect(inherited.effective.value).toBe('socket=5,mcp-inbox=15,typed=4,native=15');

    // Inheriting does not loosen the check: a route the parent tightened stays tightened even
    // when a nearer level names it alone and a middle level is sparse.
    const lengthened = resolvePolicy('delivery-timeout', [
      ...word('delivery-timeout', 'socket=5', 'entity'),
      ...word('delivery-timeout', 'typed=4', 'project'),
      ...word('delivery-timeout', 'socket=7', 'team'),
    ]);
    expect(lengthened.ok).toBe(false);
    if (!lengthened.ok) {
      expect(lengthened.refusals[0]).toMatchObject({
        kind: 'loosening',
        policy: 'delivery-timeout',
        lowerLevel: 'team',
        // The value in force is the project word's merged map, which carries the entity's socket.
        higherLevel: 'project',
        higherValue: 'socket=5,mcp-inbox=15,typed=4,native=15',
      });
    }
  });

  test('delivery-escalation is shorten-only to 300 and may not be set at the seat', () => {
    const fallback = resolvePolicy('delivery-escalation', []);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.effective.value).toBe(300);
      expect(fallback.effective.level).toBe('default');
    }

    const shortened = resolvePolicy('delivery-escalation', word('delivery-escalation', 200, 'team'));
    expect(shortened.ok).toBe(true);
    if (shortened.ok) expect(shortened.effective.value).toBe(200);

    const longer = resolvePolicy('delivery-escalation', word('delivery-escalation', 400, 'team'));
    expect(longer.ok).toBe(false);
    if (!longer.ok) {
      expect(longer.refusals[0]?.kind).toBe('invalid-policy');
      expect(longer.refusals[0]?.message).toContain('may only be shortened');
    }

    const seat = resolvePolicy('delivery-escalation', word('delivery-escalation', 200, 'seat'));
    expect(seat.ok).toBe(false);
    if (!seat.ok) expect(seat.refusals[0]?.message).toContain('may not be set at level seat');
  });

  test('a receipt wait is never shorter than the attempt it follows', () => {
    expect(receiptSecondsFor(15)).toBe(120);
    expect(receiptSecondsFor(300)).toBe(300);
    expect(receiptSecondsFor(15, 5)).toBe(15);
  });
});

describe('the delivery readers', () => {
  test('the default chain reads 15 seconds per route and the reviewed main delay of 300', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root, team: fx.team, seat: 'worker', now: NOW };
      expect(deliveryTimeoutInForce(base)).toEqual({
        ok: true,
        budgets: { socket: 15, 'mcp-inbox': 15, typed: 15, native: 15 },
        level: 'default',
      });
      expect(deliveryEscalationDelay(base)).toEqual({ ok: true, seconds: 300, source: 'release-default' });
    } finally {
      fx.cleanup();
    }
  });

  test('a written route budget and a shorter main delay are read from the team word', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root, team: fx.team, seat: 'worker', now: NOW };
      const timeout = writePolicySet(
        fx.home,
        { level: 'team', target: fx.teamId, teamRoot: fx.root, name: 'delivery-timeout', value: 'socket=5,typed=10' },
        { now: NOW },
      );
      expect(timeout.ok).toBe(true);
      const escalation = writePolicySet(
        fx.home,
        { level: 'team', target: fx.teamId, teamRoot: fx.root, name: 'delivery-escalation', value: 240 },
        { now: NOW },
      );
      expect(escalation.ok).toBe(true);

      expect(deliveryTimeoutInForce(base)).toEqual({
        ok: true,
        budgets: { socket: 5, 'mcp-inbox': 15, typed: 10, native: 15 },
        level: 'team',
      });
      expect(deliveryEscalationDelay(base)).toEqual({ ok: true, seconds: 240, source: 'delivery-escalation' });
    } finally {
      fx.cleanup();
    }
  });

  test('a sparse child word inherits the parent route budget and a native budget is read back', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root, team: fx.team, seat: 'worker', now: NOW };
      const parent = writePolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'delivery-timeout', value: 'socket=5,native=20' },
        { now: NOW },
      );
      expect(parent.ok).toBe(true);
      const child = writePolicySet(
        fx.home,
        { level: 'team', target: fx.teamId, teamRoot: fx.root, name: 'delivery-timeout', value: 'typed=4' },
        { now: NOW },
      );
      expect(child.ok).toBe(true);

      expect(deliveryTimeoutInForce(base)).toEqual({
        ok: true,
        budgets: { socket: 5, 'mcp-inbox': 15, typed: 4, native: 20 },
        level: 'team',
      });
    } finally {
      fx.cleanup();
    }
  });

  test('an explicit shorter legacy threshold caps the main delay; a longer one never lifts it', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root, team: fx.team, seat: 'worker', now: NOW };
      const shorter = writePolicySet(
        fx.home,
        { level: 'entity', target: 'floor', name: 'event-unreachable-threshold-seconds', value: 150 },
        { now: NOW },
      );
      expect(shorter.ok).toBe(true);
      expect(deliveryEscalationDelay(base)).toEqual({
        ok: true,
        seconds: 150,
        source: 'event-unreachable-threshold-seconds',
      });
    } finally {
      fx.cleanup();
    }

    const longer = makeFixture();
    try {
      const base = { home: longer.home, entity: 'floor', projectId: 'beacon', root: longer.root, team: longer.team, seat: 'worker', now: NOW };
      const wordAgain = writePolicySet(
        longer.home,
        { level: 'entity', target: 'floor', name: 'event-unreachable-threshold-seconds', value: 600 },
        { now: NOW },
      );
      expect(wordAgain.ok).toBe(true);
      // The legacy release default is 600, and even an explicit 600 is longer than the main 300:
      // neither may override the reviewed main delay.
      expect(deliveryEscalationDelay(base)).toEqual({ ok: true, seconds: 300, source: 'release-default' });
    } finally {
      longer.cleanup();
    }
  });

  test('an unreadable policy chain returns the reason and never a release default', () => {
    const fx = makeFixture();
    try {
      const base = { home: fx.home, entity: 'floor', projectId: 'beacon', root: fx.root, team: fx.team, seat: 'worker', now: NOW };
      writeFileSync(entitiesPath(fx.home), 'floor: [unclosed\n');
      const read = deliveryEscalationDelay(base);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.why).toContain('entity: policy source cannot be read or verified');
      const timeout = deliveryTimeoutInForce(base);
      expect(timeout.ok).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});
