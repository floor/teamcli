// Kernel amendment 02 & Runtime draft 1 chapter J: Policy object, tighten-only resolver,
// signed source readers/writers, `team policy` view & set/unset, `team check`, and migration.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamCheck } from '../src/check/team.ts';
import { runPolicy } from '../src/commands/policy.ts';
import { entitiesPath } from '../src/entities.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Io } from '../src/io.ts';
import { NOT_PRETENDED } from '../src/permissions/must-not-pretend.ts';
import { buildCommandOutputSchema, POLICY_OUTPUT_SCHEMA } from '../src/output/index.ts';
import {
  DEV_MODE_OPERATIONS,
  loadAndResolvePolicyChain,
  normalizePolicyName,
  planPolicySet,
  POLICY_CATALOGUE,
  POLICY_LEVELS,
  readEntityPolicySource,
  readPolicyChain,
  readProjectPolicySource,
  readSeatPolicySource,
  readTeamPolicySource,
  resolvePolicy,
  resolvePolicyChain,
  writePolicySet,
  writePolicyUnset,
  type Policy,
} from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { projectsFile, upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, deliverBriefs, testIo } from './helpers.ts';
import { assertMatchesOutputSchema, validateAgainstJsonSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

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

const parsedTeam = validateTeamFile(TEAM_YAML);
if (!parsedTeam.ok) throw new Error(JSON.stringify(parsedTeam.errors));
const LEAD_TITLE = workspaceLabel(parsedTeam.team.seats[0]!);
const WORKER_TITLE = workspaceLabel(parsedTeam.team.seats[1]!);

const QUIET_LIVE: Live = {
  running: true,
  agents: [
    { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null },
    { name: 'worker', agent: 'claude', pane: 'w2:p1', workspace: 'w2', status: 'idle', cwd: null },
  ],
  workspaces: [
    { id: 'w1', label: LEAD_TITLE },
    { id: 'w2', label: WORKER_TITLE },
  ],
  screens: { 'w1:p1': CLAUDE_IDLE, 'w2:p1': CLAUDE_IDLE },
};

function makeFixture(yamlText: string = TEAM_YAML): {
  base: string;
  home: string;
  root: string;
  teamId: string;
  agentId: string;
  cleanup: () => void;
} {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-policy-')));
  const home = join(base, 'home');
  const root = join(base, 'beacon');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), yamlText);

  const validated = validateTeamFile(yamlText);
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
  const agent = registerAgent(home, {
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
      { seat: 'worker', agent: agent.id, role: 'implementer' },
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
  // The launch delivered the general brief before it typed: each seat's record and state entry.
  deliverBriefs({
    dir: join(root, '.agents'),
    root,
    session: validated.team.session,
    seats: validated.team.seats.map((seat) => seat.name),
    home,
    at: NOW.toISOString(),
  });

  return {
    base,
    home,
    root,
    teamId,
    agentId: agent.id,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

describe('Policy object and catalogue interface (Kernel amendment 02 §2.1, §2.2, §2.7)', () => {
  test('the four inheritance levels are entity, project, team, seat in outermost-first order', () => {
    expect(POLICY_LEVELS).toEqual(['entity', 'project', 'team', 'seat']);
  });

  test('dev-mode lifts the nine everyday operations (reload and rename included) and is never seat-scoped', () => {
    expect(DEV_MODE_OPERATIONS).toEqual(['up', 'down', 'remove', 'register', 'add', 'restart', 'init', 'reload', 'rename']);
    expect(POLICY_CATALOGUE['dev-mode'].levels).toEqual(['entity', 'project', 'team']);
    expect(POLICY_CATALOGUE['dev-mode'].defaultValue).toBe('off');
    expect(POLICY_CATALOGUE['dev-mode'].gateLifting).toBe(true);
  });

  test('codex-daemon defaults on at every level and a lower level may always switch it off', () => {
    const spec = POLICY_CATALOGUE['codex-daemon'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(spec.defaultValue).toBe('on');
    expect(spec.gateLifting).toBe(false);
    expect(normalizePolicyName('codex_daemon')).toBe('codex-daemon');

    const absent = resolvePolicy('codex-daemon', []);
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.effective.value).toBe('on');
      expect(absent.effective.level).toBe('default');
    }

    const optOut = resolvePolicy('codex-daemon', [
      { name: 'codex-daemon', value: 'on', level: 'entity', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'codex-daemon', value: 'off', level: 'seat', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(optOut.ok).toBe(true);
    if (optOut.ok) {
      expect(optOut.effective.value).toBe('off');
      expect(optOut.effective.level).toBe('seat');
    }

    const backOn = resolvePolicy('codex-daemon', [
      { name: 'codex-daemon', value: 'off', level: 'entity', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'codex-daemon', value: 'on', level: 'team', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(backOn.ok).toBe(false);
    if (!backOn.ok) {
      expect(backOn.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'codex-daemon', higherLevel: 'entity', lowerLevel: 'team' });
    }
  });

  test('idle-threshold takes a duration with its unit, defaults to five minutes and stops at the team', () => {
    const spec = POLICY_CATALOGUE['idle-threshold'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.defaultValue).toBe(300);
    expect(spec.gateLifting).toBe(false);
    expect(normalizePolicyName('idle_threshold')).toBe('idle-threshold');

    for (const [word, seconds] of [['30s', 30], ['5m', 300], ['2h', 7200], ['300', 300], [300, 300], ['1.5m', 90]] as const) {
      expect(spec.parseValue(word)).toBe(seconds);
    }
    for (const word of [0, -5, '0m', '5x', '1.5s', 'nope', '', true]) expect(spec.parseValue(word)).toBeNull();

    const absent = resolvePolicy('idle-threshold', []);
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.effective.value).toBe(300);
      expect(absent.effective.level).toBe('default');
    }

    const tightened = resolvePolicy('idle-threshold', [
      { name: 'idle-threshold', value: '10m', level: 'entity', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'idle-threshold', value: '5m', level: 'team', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(tightened.ok).toBe(true);
    if (tightened.ok) {
      expect(tightened.effective.value).toBe(300);
      expect(tightened.effective.level).toBe('team');
    }

    const loosened = resolvePolicy('idle-threshold', [
      { name: 'idle-threshold', value: '5m', level: 'entity', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'idle-threshold', value: '10m', level: 'team', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(loosened.ok).toBe(false);
    if (!loosened.ok) {
      expect(loosened.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'idle-threshold', higherLevel: 'entity', lowerLevel: 'team' });
    }

    const seatLevel = resolvePolicy('idle-threshold', [
      { name: 'idle-threshold', value: '5m', level: 'seat', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(seatLevel.ok).toBe(false);
    if (!seatLevel.ok) {
      expect(seatLevel.refusals[0]?.message).toContain('allowed: entity, project, team');
    }
  });

  test('daemon.broker is a feature gate above the seat, off by default and switchable only on by an explicit declaration', () => {
    const spec = POLICY_CATALOGUE['daemon.broker'];
    expect(spec.kind).toBe('enforced');
    expect(spec.levels).toEqual(['entity', 'project', 'team']);
    expect(spec.defaultValue).toBe('off');
    expect(spec.gateLifting).toBe(false);
    expect(normalizePolicyName('daemon_broker')).toBe('daemon.broker');
    expect(normalizePolicyName('daemon-broker')).toBe('daemon.broker');
    expect(spec.parseValue('on')).toBe('on');
    expect(spec.parseValue('off')).toBe('off');
    expect(spec.parseValue('auto')).toBeNull();

    const absent = resolvePolicy('daemon.broker', []);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.effective.value).toBe('off');

    const off = resolvePolicy('daemon.broker', [
      { name: 'daemon.broker', value: 'on', level: 'entity', setter: 'owner', date: '2026-10-20T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.broker', value: 'off', level: 'team', setter: 'owner', date: '2026-10-20T11:00:00Z', kind: 'enforced' },
    ]);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.effective.value).toBe('off');

    const backOn = resolvePolicy('daemon.broker', [
      { name: 'daemon.broker', value: 'off', level: 'entity', setter: 'owner', date: '2026-10-20T10:00:00Z', kind: 'enforced' },
      { name: 'daemon.broker', value: 'on', level: 'project', setter: 'owner', date: '2026-10-20T11:00:00Z', kind: 'enforced' },
    ]);
    expect(backOn.ok).toBe(false);
    if (!backOn.ok) {
      expect(backOn.refusals[0]).toMatchObject({ kind: 'loosening', policy: 'daemon.broker', higherLevel: 'entity', lowerLevel: 'project' });
    }

    const seatLevel = resolvePolicy('daemon.broker', [
      { name: 'daemon.broker', value: 'off', level: 'seat', setter: 'owner', date: '2026-10-20T11:00:00Z', kind: 'enforced' },
    ]);
    expect(seatLevel.ok).toBe(false);
    if (!seatLevel.ok) expect(seatLevel.refusals[0]?.message).toContain('allowed: entity, project, team');
  });

  test('absent declarations resolve to the release default, and off for gate-lifting policies', () => {
    const devMode = resolvePolicy('dev-mode', []);
    expect(devMode.ok).toBe(true);
    if (devMode.ok) {
      expect(devMode.effective.value).toBe('off');
      expect(devMode.effective.level).toBe('default');
    }

    const delivery = resolvePolicy('delivery-order', []);
    expect(delivery.ok).toBe(true);
    if (delivery.ok) {
      expect(delivery.effective.value).toEqual(['mcp-inbox', 'typed', 'drop']);
      expect(delivery.effective.level).toBe('default');
    }

    expect(POLICY_CATALOGUE['state-trace-window-seconds'].defaultValue).toBe(120);
    expect(POLICY_CATALOGUE['state-blind-after-seconds'].defaultValue).toBe(300);
    expect(POLICY_CATALOGUE['state-hook-working-seconds'].defaultValue).toBe(120);
    expect(POLICY_CATALOGUE['liveness-idle-lead-seconds'].defaultValue).toBe(300);
    expect(POLICY_CATALOGUE['liveness-idle-owner-seconds'].defaultValue).toBe(900);
  });

  test('delivery-order naming socket-accepted is refused at load with a plain message naming the level', () => {
    const result = resolvePolicy('delivery-order', [
      {
        name: 'delivery-order',
        value: ['socket-accepted', 'typed'],
        level: 'team',
        setter: 'owner',
        date: '2026-10-17T10:00:00Z',
        kind: 'enforced',
      },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]).toMatchObject({
        kind: 'invalid-policy',
        level: 'team',
        policy: 'delivery-order',
        why: 'socket-accepted is not available in this release',
        message: 'team: socket-accepted is not available in this release',
      });
    }
  });

  test('delivery-order accepts headless-resume, a leg a declared word may add and no default names', () => {
    // The headless-resume leg is opt-in: it is in the vocabulary, a word may name it, and the
    // fallback order still names neither it nor any implied default that would insert it.
    expect(POLICY_CATALOGUE['delivery-order'].defaultValue).toEqual(['mcp-inbox', 'typed', 'drop']);
    const narrowed = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: ['native', 'headless-resume', 'typed'], level: 'entity', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'delivery-order', value: ['headless-resume', 'typed'], level: 'seat', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.effective.value).toEqual(['headless-resume', 'typed']);

    const addsUnderTyped = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: ['typed'], level: 'team', setter: 'owner', date: '2026-10-19T10:00:00Z', kind: 'enforced' },
      { name: 'delivery-order', value: ['headless-resume', 'typed'], level: 'seat', setter: 'owner', date: '2026-10-19T11:00:00Z', kind: 'enforced' },
    ]);
    expect(addsUnderTyped.ok).toBe(true);
    if (addsUnderTyped.ok) expect(addsUnderTyped.effective.value).toEqual(['headless-resume', 'typed']);
  });

  test('a loosening is refused at load and names both levels', () => {
    const declarations: Policy[] = [
      { name: 'dev-mode', value: 'off', level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'dev-mode', value: 'on', level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ];
    const result = resolvePolicy('dev-mode', declarations);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]).toMatchObject({
        kind: 'loosening',
        policy: 'dev-mode',
        higherLevel: 'entity',
        lowerLevel: 'team',
      });
      expect(result.refusals[0]?.message).toContain('entity');
      expect(result.refusals[0]?.message).toContain('team');
    }
  });

  test('an unreadable source refuses at load and names its level', () => {
    const chain = resolvePolicyChain({
      entity: { ok: false, level: 'entity', why: 'signature verification failed' },
      project: readProjectPolicySource('/tmp/nonexistent', null),
      team: readTeamPolicySource('/tmp/nonexistent', null),
      seat: readSeatPolicySource('/tmp/nonexistent', null),
    });
    expect(chain.ok).toBe(false);
    if (!chain.ok) {
      expect(chain.refusals[0]).toMatchObject({
        kind: 'unreadable-source',
        level: 'entity',
      });
    }
  });

  test('absent source files return empty verified lists', () => {
    const sources = readPolicyChain({ home: '/tmp/nonexistent', entity: 'acme', projectId: 'proj', teamRoot: '/tmp/team' });
    const resolved = resolvePolicyChain(sources);
    expect(resolved.ok).toBe(true);
    expect(resolved.devModeGoverned).toBe(false);
  });

  // EXPIRY — an expired value counts as UNSET at its level.
  test('expiry: an expired declaration counts as unset at its level so the inherited value or release default applies, never a value no level chose', () => {
    const declarations: Policy[] = [
      {
        name: 'state-blind-after-seconds',
        value: 200,
        level: 'project',
        setter: 'owner',
        date: '2026-10-17T08:00:00Z',
        kind: 'enforced',
      },
      {
        name: 'state-blind-after-seconds',
        value: 60,
        level: 'team',
        setter: 'owner',
        date: '2026-10-17T09:00:00Z',
        expiry: '2026-10-17T10:00:00Z',
        kind: 'enforced',
      },
    ];
    const resolved = resolvePolicy('state-blind-after-seconds', declarations, { now: NOW });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.effective.value).toBe(200);
      expect(resolved.effective.level).toBe('project');
      expect(resolved.expired).toHaveLength(1);
      expect(resolved.expired[0]?.level).toBe('team');
    }
  });

  test('expiry: an expired dev-mode on at team level falls back to project or entity value when set, or off when no higher level set it', () => {
    const inheritedOn = resolvePolicy(
      'dev-mode',
      [
        {
          name: 'dev-mode',
          value: 'on',
          level: 'project',
          setter: 'owner',
          date: '2026-10-17T08:00:00Z',
          expiry: '2026-10-18T00:00:00Z',
          kind: 'enforced',
        },
        {
          name: 'dev-mode',
          value: 'on',
          level: 'team',
          setter: 'owner',
          date: '2026-10-17T09:00:00Z',
          expiry: '2026-10-17T10:00:00Z',
          kind: 'enforced',
        },
      ],
      { now: NOW },
    );
    expect(inheritedOn.ok).toBe(true);
    if (inheritedOn.ok) {
      expect(inheritedOn.effective.value).toBe('on');
      expect(inheritedOn.effective.level).toBe('project');
      expect(inheritedOn.effective.expiry).toBe('2026-10-18T00:00:00Z');
      expect(inheritedOn.expired).toHaveLength(1);
    }

    const fallbackDefault = resolvePolicy(
      'dev-mode',
      [
        {
          name: 'dev-mode',
          value: 'on',
          level: 'team',
          setter: 'owner',
          date: '2026-10-17T09:00:00Z',
          expiry: '2026-10-17T10:00:00Z',
          kind: 'enforced',
        },
      ],
      { now: NOW },
    );
    expect(fallbackDefault.ok).toBe(true);
    if (fallbackDefault.ok) {
      expect(fallbackDefault.effective.value).toBe('off');
      expect(fallbackDefault.effective.level).toBe('default');
      expect(fallbackDefault.expired).toHaveLength(1);
    }
  });

  test('expiry: a nearer expiry on dev-mode is tighter than a later expiry or none, and a later expiry below a nearer one is refused at load naming both levels', () => {
    const tighterExpiry = resolvePolicy(
      'dev-mode',
      [
        {
          name: 'dev-mode',
          value: 'on',
          level: 'project',
          setter: 'owner',
          date: '2026-10-17T08:00:00Z',
          expiry: '2026-10-18T00:00:00Z',
          kind: 'enforced',
        },
        {
          name: 'dev-mode',
          value: 'on',
          level: 'team',
          setter: 'owner',
          date: '2026-10-17T09:00:00Z',
          expiry: '2026-10-17T18:00:00Z',
          kind: 'enforced',
        },
      ],
      { now: NOW },
    );
    expect(tighterExpiry.ok).toBe(true);
    if (tighterExpiry.ok) {
      expect(tighterExpiry.effective.level).toBe('team');
      expect(tighterExpiry.effective.expiry).toBe('2026-10-17T18:00:00Z');
    }

    const looserExpiry = resolvePolicy(
      'dev-mode',
      [
        {
          name: 'dev-mode',
          value: 'on',
          level: 'project',
          setter: 'owner',
          date: '2026-10-17T08:00:00Z',
          expiry: '2026-10-17T18:00:00Z',
          kind: 'enforced',
        },
        {
          name: 'dev-mode',
          value: 'on',
          level: 'team',
          setter: 'owner',
          date: '2026-10-17T09:00:00Z',
          expiry: '2026-10-18T00:00:00Z',
          kind: 'enforced',
        },
      ],
      { now: NOW },
    );
    expect(looserExpiry.ok).toBe(false);
    if (!looserExpiry.ok) {
      expect(looserExpiry.refusals[0]).toMatchObject({
        kind: 'loosening',
        policy: 'dev-mode',
        higherLevel: 'project',
        lowerLevel: 'team',
      });
      expect(looserExpiry.refusals[0]?.message).toContain('project');
      expect(looserExpiry.refusals[0]?.message).toContain('team');
    }
  });

  // MIGRATION — triggered only by a dev-mode value set anywhere in the chain.
  test('migration: setting a non-dev-mode policy (such as a state threshold) leaves devModeGoverned false so dev mode is not switched off for the entity', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'entity',
          target: 'floor',
          name: 'state-blind-after-seconds',
          value: 180,
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const resolved = loadAndResolvePolicyChain(
        { home: fx.home, entity: 'floor', projectId: 'beacon', teamRoot: fx.root },
        { now: NOW },
      );
      expect(resolved.ok).toBe(true);
      expect(resolved.devModeGoverned).toBe(false);
      if (resolved.ok) {
        expect(resolved.policies['state-blind-after-seconds']?.value).toBe(180);
      }
    } finally {
      fx.cleanup();
    }
  });

  test('migration: setting dev-mode (on or off) at entity, project, or team sets devModeGoverned true and ignores TEAMCLI_DEV_MODE', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'entity',
          target: 'floor',
          name: 'dev-mode',
          value: 'off',
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const resolved = loadAndResolvePolicyChain(
        { home: fx.home, entity: 'floor', projectId: 'beacon', teamRoot: fx.root },
        { now: NOW },
      );
      expect(resolved.ok).toBe(true);
      expect(resolved.devModeGoverned).toBe(true);
      if (resolved.ok) {
        expect(resolved.policies['dev-mode']?.value).toBe('off');
        expect(resolved.policies['dev-mode']?.level).toBe('entity');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('migration: before any dev-mode policy is set in the chain, team check emits one notice and TEAMCLI_DEV_MODE=1 keeps today behaviour', () => {
    const fx = makeFixture();
    try {
      let out = '';
      let err = '';
      const io: Io = {
        stdout: (t: string) => void (out += t),
        stderr: (t: string) => void (err += t),
        cwd: fx.root,
        env: { TEAMCLI_DEV_MODE: '1' },
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toContain(
        'note: dev-mode: no policy is set yet for this entity; TEAMCLI_DEV_MODE=1 still applies until the owner sets dev-mode\n',
      );
    } finally {
      fx.cleanup();
    }
  });

  test('migration: once dev-mode policy is off in the chain, TEAMCLI_DEV_MODE=1 is ignored and logged once per command', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'entity',
          target: 'floor',
          name: 'dev-mode',
          value: 'off',
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      let out = '';
      let err = '';
      const io: Io = {
        stdout: (t: string) => void (out += t),
        stderr: (t: string) => void (err += t),
        cwd: fx.root,
        env: { TEAMCLI_DEV_MODE: '1' },
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).not.toContain('no policy is set yet for this entity');
      const log = readFileSync(join(fx.root, '.agents', 'team.log'), 'utf8');
      expect(log).toContain('dev-mode: TEAMCLI_DEV_MODE=1 ignored because dev-mode policy is off');
    } finally {
      fx.cleanup();
    }
  });

  // Source readers & owner-signed writes (Part A fill-in).
  test('sources: readEntityPolicySource reads signed policies from ~/.config/team/entities.yaml and refuses tampered or malformed entries naming entity', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'entity',
          target: 'floor',
          name: 'dev-mode',
          value: 'on',
          expiry: '2026-10-18T12:00:00Z',
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const read = readEntityPolicySource(fx.home, 'floor');
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.policies).toHaveLength(1);
        expect(read.policies[0]).toMatchObject({
          name: 'dev-mode',
          value: 'on',
          level: 'entity',
          setter: 'owner',
          expiry: '2026-10-18T12:00:00Z',
          kind: 'enforced',
        });
      }

      // Tampering with the signed value must fail signature verification and name level entity.
      const path = entitiesPath(fx.home);
      writeFileSync(path, readFileSync(path, 'utf8').replace('value: "on"', 'value: "off"').replace('value: on', 'value: off'));
      const tampered = readEntityPolicySource(fx.home, 'floor');
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) {
        expect(tampered.level).toBe('entity');
        expect(tampered.why).toContain('signature verification failed');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('sources: readProjectPolicySource reads signed policies from ~/.config/team/projects.yaml and refuses tampered or malformed entries naming project', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'project',
          target: 'beacon',
          name: 'seats-cross-teams',
          value: 'on',
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const read = readProjectPolicySource(fx.home, 'beacon');
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.policies).toHaveLength(1);
        expect(read.policies[0]).toMatchObject({
          name: 'seats-cross-teams',
          value: 'on',
          level: 'project',
          setter: 'owner',
          kind: 'enforced',
        });
      }

      const path = projectsFile(fx.home);
      writeFileSync(path, readFileSync(path, 'utf8').replace('value: "on"', 'value: "off"').replace('value: on', 'value: off'));
      const tampered = readProjectPolicySource(fx.home, 'beacon');
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) {
        expect(tampered.level).toBe('project');
        expect(tampered.why).toContain('signature verification failed');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('sources: readTeamPolicySource reads owner policies: section from .agents/team.yaml and refuses tampered or malformed entries naming team', () => {
    const fx = makeFixture();
    try {
      const wrote = writePolicySet(
        fx.home,
        {
          level: 'team',
          target: fx.teamId,
          teamRoot: fx.root,
          name: 'delivery-order',
          value: ['native', 'typed'],
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const read = readTeamPolicySource(fx.home, fx.root);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.policies).toHaveLength(1);
        expect(read.policies[0]).toMatchObject({
          name: 'delivery-order',
          value: ['native', 'typed'],
          level: 'team',
          setter: 'owner',
          kind: 'enforced',
        });
      }

      const teamPath = join(fx.root, '.agents', 'team.yaml');
      writeFileSync(teamPath, readFileSync(teamPath, 'utf8').replace('native', 'mcp-inbox'));
      const tampered = readTeamPolicySource(fx.home, fx.root);
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) {
        expect(tampered.level).toBe('team');
        expect(tampered.why).toContain('signature verification failed');
      }
    } finally {
      fx.cleanup();
    }
  });

  test('sources: readSeatPolicySource reads seat policies from ~/.config/team/agents/<id>.yaml and refuses dev-mode at seat level', () => {
    const fx = makeFixture();
    try {
      const refusedDevMode = writePolicySet(
        fx.home,
        {
          level: 'seat',
          target: fx.agentId,
          name: 'dev-mode',
          value: 'on',
        },
        { now: NOW },
      );
      expect(refusedDevMode.ok).toBe(false);
      if (!refusedDevMode.ok) {
        expect(refusedDevMode.why).toContain('may not be set at level seat');
      }

      const wrote = writePolicySet(
        fx.home,
        {
          level: 'seat',
          target: fx.agentId,
          name: 'state-trace-window-seconds',
          value: 60,
        },
        { now: NOW },
      );
      expect(wrote.ok).toBe(true);

      const read = readSeatPolicySource(fx.home, fx.agentId);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.policies).toHaveLength(1);
        expect(read.policies[0]).toMatchObject({
          name: 'state-trace-window-seconds',
          value: 60,
          level: 'seat',
          setter: 'owner',
          kind: 'enforced',
        });
      }

      const unset = writePolicyUnset(fx.home, {
        level: 'seat',
        target: fx.agentId,
        name: 'state-trace-window-seconds',
      });
      expect(unset.ok).toBe(true);
      const afterUnset = readSeatPolicySource(fx.home, fx.agentId);
      expect(afterUnset.ok).toBe(true);
      if (afterUnset.ok) {
        expect(afterUnset.policies).toHaveLength(0);
      }
    } finally {
      fx.cleanup();
    }
  });

  // CLI: `team policy` view & `team policy set|unset`.
  test('cli: team policy prints effective policies (value, level, setter, expiry, kind) from the gate resolution and supports --json', async () => {
    const fx = makeFixture();
    try {
      writePolicySet(
        fx.home,
        {
          level: 'project',
          target: 'beacon',
          name: 'dev-mode',
          value: 'on',
          expiry: '2026-10-18T12:00:00Z',
        },
        { now: NOW },
      );

      const io = testIo(fx.root, { kind: 'owner' });
      const code = await runPolicy(['--file', '.agents/team.yaml'], io, { home: fx.home, now: () => NOW });
      expect(code).toBe(0);
      expect(io.err).toBe('');
      expect(io.out).toContain('team beacon, session "beacon"');
      expect(io.out).toContain('POLICY');
      expect(io.out).toContain('dev-mode');
      expect(io.out).toContain('project');
      expect(io.out).toContain('2026-10-18T12:00:00Z');

      const jsonIo = testIo(fx.root, { kind: 'owner' });
      const jsonCode = await runPolicy(['--file', '.agents/team.yaml', '--json'], jsonIo, { home: fx.home, now: () => NOW });
      expect(jsonCode).toBe(0);
      const doc = JSON.parse(jsonIo.out) as {
        schema: { name: string; version: number };
        status: string;
        dev_mode_governed: boolean;
        policies: Array<{ name: string; value: unknown; level: string; setter: string | null; expiry: string | null; kind: string }>;
      };
      expect(doc.schema).toEqual({ name: 'team.policy', version: 1 });
      expect(doc.status).toBe('ok');
      expect(doc.dev_mode_governed).toBe(true);
      const devModeRow = doc.policies.find((p) => p.name === 'dev-mode');
      expect(devModeRow).toMatchObject({
        name: 'dev-mode',
        value: 'on',
        level: 'project',
        setter: 'owner',
        expiry: '2026-10-18T12:00:00Z',
        kind: 'enforced',
      });
    } finally {
      fx.cleanup();
    }
  });

  test('cli: team policy set|unset <level> <name> <value> [--until] is owner-only, signs the record like grants, and logs the change to .agents/team.log', async () => {
    const fx = makeFixture();
    try {
      // Non-owner is refused.
      const seatIo = testIo(fx.root, { kind: 'seat', name: 'lead', session: 'beacon', pane: 'w1:p1' });
      const seatCode = await runPolicy(['set', 'team', 'dev-mode', 'on'], seatIo, { home: fx.home, now: () => NOW });
      expect(seatCode).toBe(1);
      expect(seatIo.err).toContain('only the owner runs this, from a terminal outside herdr');

      // Owner sets entity dev-mode off.
      const setEntityIo = testIo(fx.root, { kind: 'owner' });
      const setEntityCode = await runPolicy(
        ['set', 'entity', 'dev-mode', 'off', '--file', '.agents/team.yaml'],
        setEntityIo,
        { home: fx.home, now: () => NOW },
      );
      expect(setEntityCode).toBe(0);
      expect(setEntityIo.out).toContain('policy: set dev-mode=off at entity (floor)');

      // Loosening at team level (dev-mode on below entity dev-mode off) is refused before write.
      const loosenIo = testIo(fx.root, { kind: 'owner' });
      const loosenCode = await runPolicy(
        ['set', 'team', 'dev-mode', 'on', '--file', '.agents/team.yaml'],
        loosenIo,
        { home: fx.home, now: () => NOW },
      );
      expect(loosenCode).toBe(1);
      expect(loosenIo.err).toContain('loosens level entity');

      // Owner unsets entity dev-mode, then sets team dev-mode on with --until.
      const unsetIo = testIo(fx.root, { kind: 'owner' });
      const unsetCode = await runPolicy(
        ['unset', 'entity', 'dev-mode', '--file', '.agents/team.yaml'],
        unsetIo,
        { home: fx.home, now: () => NOW },
      );
      expect(unsetCode).toBe(0);
      expect(unsetIo.out).toContain('policy: unset dev-mode at entity (floor)');

      const setTeamIo = testIo(fx.root, { kind: 'owner' });
      const setTeamCode = await runPolicy(
        ['set', 'team', 'dev-mode', 'on', '--until', '2026-10-19T00:00:00Z', '--file', '.agents/team.yaml'],
        setTeamIo,
        { home: fx.home, now: () => NOW },
      );
      expect(setTeamCode).toBe(0);
      expect(setTeamIo.out).toContain('until 2026-10-19T00:00:00Z');

      const log = readFileSync(join(fx.root, '.agents', 'team.log'), 'utf8');
      expect(log).toContain('level entity (floor) dev-mode: unset -> off (setter: owner)');
      expect(log).toContain('level entity (floor) dev-mode: off -> unset (setter: owner)');
      expect(log).toContain('level team (');
    } finally {
      fx.cleanup();
    }
  });

  // `team check` & `NOT_PRETENDED`.
  test('check: NOT_PRETENDED omits "No policy object yet (amendment 02)" and team check reports policy load refusals as owner differences', () => {
    expect(NOT_PRETENDED.some((line) => line.includes('No policy object yet'))).toBe(false);

    const fx = makeFixture();
    try {
      // Set entity dev-mode off and team dev-mode on (loosening in chain).
      writePolicySet(fx.home, { level: 'entity', target: 'floor', name: 'dev-mode', value: 'off' }, { now: NOW });
      writePolicySet(
        fx.home,
        { level: 'team', target: fx.teamId, teamRoot: fx.root, name: 'dev-mode', value: 'on' },
        { now: NOW },
      );

      const io = testIo(fx.root, { kind: 'owner' });
      const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code).toBe(1);
      expect(io.out).toContain('difference: policy "dev-mode" at level team ("on") loosens level entity ("off")');
      expect(io.out).toContain('  repair: team policy unset team dev-mode');
      expect(io.out).toContain('  who: the owner');
    } finally {
      fx.cleanup();
    }
  });

  test('schema: team policy --json view and action payloads validate against POLICY_OUTPUT_SCHEMA with validateAgainstJsonSchema', async () => {
    const fx = makeFixture();
    try {
      const schema = buildCommandOutputSchema(POLICY_OUTPUT_SCHEMA);

      // Action payload (set --json)
      const setIo = testIo(fx.root, { kind: 'owner' });
      const setCode = await runPolicy(
        ['set', 'project', 'dev-mode', 'on', '--until', '2026-10-18T12:00:00Z', '--file', '.agents/team.yaml', '--json'],
        setIo,
        { home: fx.home, now: () => NOW },
      );
      expect(setCode).toBe(0);
      const setParsed: unknown = JSON.parse(setIo.out);
      expect(validateAgainstJsonSchema(setParsed, schema)).toEqual([]);
      assertMatchesOutputSchema(setIo.out, POLICY_OUTPUT_SCHEMA);

      // View payload (team policy --json)
      const viewIo = testIo(fx.root, { kind: 'owner' });
      const viewCode = await runPolicy(['--file', '.agents/team.yaml', '--json'], viewIo, { home: fx.home, now: () => NOW });
      expect(viewCode).toBe(0);
      const viewParsed: unknown = JSON.parse(viewIo.out);
      expect(validateAgainstJsonSchema(viewParsed, schema)).toEqual([]);
      const viewDoc = assertMatchesOutputSchema<{ status: string }>(viewIo.out, POLICY_OUTPUT_SCHEMA);
      expect(viewDoc.status).toBe('ok');
    } finally {
      fx.cleanup();
    }
  });

  test('gap-3: readTeamPolicySource and readSeatPolicySource read legacy team delivery_order: and seat delivery_order as unsigned declarations at their level', async () => {
    const legacyTeamYaml = `${TEAM_YAML}delivery_order: [mcp-inbox, typed]\n`.replace(
      '    launch: claude --model claude-opus-5-5\n    leads: true',
      '    launch: claude --model claude-opus-5-5\n    leads: true\n    delivery_order: [typed]',
    );
    const fx = makeFixture(legacyTeamYaml);
    try {
      // 1. readTeamPolicySource reads legacy team delivery_order: as unsigned declaration at level team.
      const teamRead = readTeamPolicySource(fx.home, fx.root);
      expect(teamRead.ok).toBe(true);
      if (teamRead.ok) {
        expect(teamRead.policies).toEqual([
          {
            name: 'delivery-order',
            value: ['mcp-inbox', 'typed'],
            level: 'team',
            setter: null,
            date: null,
            expiry: null,
            kind: 'enforced',
            target: fx.teamId,
          },
        ]);
      }

      // 2. readSeatPolicySource reads legacy seat deliveryOrder as unsigned declaration at level seat.
      const validated = validateTeamFile(legacyTeamYaml);
      if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
      const leadSeat = validated.team.seats.find((s) => s.name === 'lead')!;
      const seatRead = readSeatPolicySource(fx.home, null, leadSeat);
      expect(seatRead.ok).toBe(true);
      if (seatRead.ok) {
        expect(seatRead.policies).toEqual([
          {
            name: 'delivery-order',
            value: ['typed'],
            level: 'seat',
            setter: null,
            date: null,
            expiry: null,
            kind: 'enforced',
            target: 'lead',
          },
        ]);
      }

      // 3. CLI view shows team level for legacy delivery_order:, and --seat lead shows seat level.
      const teamViewIo = testIo(fx.root, { kind: 'owner' });
      const teamViewCode = await runPolicy(['--file', '.agents/team.yaml'], teamViewIo, { home: fx.home, now: () => NOW });
      expect(teamViewCode).toBe(0);
      expect(teamViewIo.out).toMatch(/delivery-order\s+mcp-inbox, typed\s+team\s+-\s+-\s+enforced/);

      const seatViewIo = testIo(fx.root, { kind: 'owner' });
      const seatViewCode = await runPolicy(['--seat', 'lead', '--file', '.agents/team.yaml'], seatViewIo, {
        home: fx.home,
        now: () => NOW,
      });
      expect(seatViewCode).toBe(0);
      expect(seatViewIo.out).toMatch(/delivery-order\s+typed\s+seat\s+-\s+-\s+enforced/);
    } finally {
      fx.cleanup();
    }
  });

  test('set-time socket-accepted refusal names the level ("team policy: team: socket-accepted is not available in this release")', async () => {
    const fx = makeFixture();
    try {
      const plan = planPolicySet(
        fx.home,
        {
          level: 'team',
          target: fx.teamId,
          teamRoot: fx.root,
          name: 'delivery-order',
          value: 'socket-accepted,typed',
        },
        { now: NOW },
      );
      expect(plan).toEqual({
        ok: false,
        why: 'team: socket-accepted is not available in this release',
      });

      const io = testIo(fx.root, { kind: 'owner' });
      const code = await runPolicy(
        ['set', 'team', 'delivery-order', 'socket-accepted,typed', '--file', '.agents/team.yaml'],
        io,
        { home: fx.home, now: () => NOW },
      );
      expect(code).toBe(2);
      expect(io.err).toContain('team policy: team: socket-accepted is not available in this release\n');
    } finally {
      fx.cleanup();
    }
  });

  test('expiry reading is worded "<name> at <level> expired at <t>; read as unset", logged at most once per expired entry, and leaves the signed file untouched', async () => {
    const fx = makeFixture();
    try {
      const expiryIso = '2026-10-17T12:00:05Z';
      const setIo = testIo(fx.root, { kind: 'owner' });
      const setCode = await runPolicy(
        ['set', 'team', 'dev-mode', 'on', '--until', expiryIso, '--file', '.agents/team.yaml'],
        setIo,
        { home: fx.home, now: () => NOW },
      );
      expect(setCode).toBe(0);

      const teamYamlPath = join(fx.root, '.agents', 'team.yaml');
      const signedTeamYamlBefore = readFileSync(teamYamlPath, 'utf8');

      // Read twice after expiry:
      const t1 = new Date('2026-10-17T12:00:10Z');
      const t2 = new Date('2026-10-17T12:00:18Z');
      const view1 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], view1, { home: fx.home, now: () => t1 })).toBe(0);

      const view2 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], view2, { home: fx.home, now: () => t2 })).toBe(0);

      // Signed file is untouched on disk.
      expect(readFileSync(teamYamlPath, 'utf8')).toBe(signedTeamYamlBefore);

      // Log line is worded as a reading and written only once across the two reads.
      const logLines = readFileSync(join(fx.root, '.agents', 'team.log'), 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.includes('expired at'));
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toContain(`policy [owner] dev-mode at team expired at ${expiryIso}; read as unset`);

      // Once the expiry has passed, team check shows ONE notice ("dev-mode expired at <t> for <level>; off since") as a note, not a difference.
      const checkIo = testIo(fx.root, { kind: 'owner' });
      const checkCode = runTeamCheck({ file: '.agents/team.yaml' }, checkIo, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => t2,
        home: fx.home,
      });
      expect(checkCode).toBe(0);
      expect(checkIo.out).toContain(`note: dev-mode expired at ${expiryIso} for team; off since\n`);
      expect(checkIo.out).toContain('no differences\n');
    } finally {
      fx.cleanup();
    }
  });

  test('probes: seats-cross-teams tighten/refuse naming both levels; threshold equal/smaller/larger; delivery-order drop/reorder ok and add/duplicate/empty refused; unknown enforced vs advised; development-mode lowerLevelChooses; expired dev-mode still governed', () => {
    // 1. seats-cross-teams: on -> off tightens; off -> on refused naming both levels.
    const sctTight = resolvePolicy('seats-cross-teams', [
      { name: 'seats-cross-teams', value: 'on', level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'seats-cross-teams', value: 'off', level: 'project', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(sctTight.ok).toBe(true);
    if (sctTight.ok) {
      expect(sctTight.effective.value).toBe('off');
      expect(sctTight.effective.level).toBe('project');
    }
    const sctLoose = resolvePolicy('seats-cross-teams', [
      { name: 'seats-cross-teams', value: 'off', level: 'project', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'seats-cross-teams', value: 'on', level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(sctLoose.ok).toBe(false);
    if (!sctLoose.ok) {
      expect(sctLoose.refusals[0]?.message).toContain('project');
      expect(sctLoose.refusals[0]?.message).toContain('team');
    }

    // 2. Threshold equal, smaller, larger.
    const thrEqual = resolvePolicy('state-blind-after-seconds', [
      { name: 'state-blind-after-seconds', value: 240, level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'state-blind-after-seconds', value: 240, level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(thrEqual.ok).toBe(true);
    const thrSmaller = resolvePolicy('state-blind-after-seconds', [
      { name: 'state-blind-after-seconds', value: 240, level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'state-blind-after-seconds', value: 120, level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(thrSmaller.ok).toBe(true);
    if (thrSmaller.ok) expect(thrSmaller.effective.value).toBe(120);
    const thrLarger = resolvePolicy('state-blind-after-seconds', [
      { name: 'state-blind-after-seconds', value: 120, level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'state-blind-after-seconds', value: 240, level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(thrLarger.ok).toBe(false);
    if (!thrLarger.ok) {
      expect(thrLarger.refusals[0]?.message).toContain('entity');
      expect(thrLarger.refusals[0]?.message).toContain('team');
    }

    // 3. delivery-order: drop & reorder accepted; add, duplicate, empty refused.
    const delivDropReorder = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: ['native', 'mcp-inbox', 'typed'], level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'delivery-order', value: ['typed', 'native'], level: 'project', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
      { name: 'delivery-order', value: ['native', 'typed'], level: 'team', setter: 'owner', date: '2026-10-17T11:30:00Z', kind: 'enforced' },
    ]);
    expect(delivDropReorder.ok).toBe(true);
    if (delivDropReorder.ok) expect(delivDropReorder.effective.value).toEqual(['native', 'typed']);

    const delivAdd = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: ['native', 'typed'], level: 'project', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
      { name: 'delivery-order', value: ['native', 'mcp-inbox', 'typed'], level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'enforced' },
    ]);
    expect(delivAdd.ok).toBe(false);
    if (!delivAdd.ok) {
      expect(delivAdd.refusals[0]?.message).toContain('project');
      expect(delivAdd.refusals[0]?.message).toContain('team');
    }

    const delivDup = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: ['typed', 'typed'], level: 'team', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
    ]);
    expect(delivDup.ok).toBe(false);

    const delivEmpty = resolvePolicy('delivery-order', [
      { name: 'delivery-order', value: [], level: 'team', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
    ]);
    expect(delivEmpty.ok).toBe(false);

    // 4. development-mode lowerLevelChooses; custom advised lower-level change refused; unknown enforced refused, unknown advised accepted.
    const devChoice = resolvePolicy('development-mode', [
      { name: 'development-mode', value: 'local-fast', level: 'entity', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'advised' },
      { name: 'development-mode', value: 'pr-per-change', level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'advised' },
    ]);
    expect(devChoice.ok).toBe(true);
    if (devChoice.ok) expect(devChoice.effective.value).toBe('pr-per-change');

    const unknownEnforced = resolvePolicy('made-up-policy', [
      { name: 'made-up-policy', value: 'on', level: 'team', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'enforced' },
    ]);
    expect(unknownEnforced.ok).toBe(false);

    const unknownAdvised = resolvePolicy('custom-house-rule', [
      { name: 'custom-house-rule', value: 'keep PRs small', level: 'project', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'advised' },
    ]);
    expect(unknownAdvised.ok).toBe(true);
    if (unknownAdvised.ok) {
      expect(unknownAdvised.effective.value).toBe('keep PRs small');
      expect(unknownAdvised.effective.kind).toBe('advised');
    }

    const customAdvisedLoosened = resolvePolicy('custom-house-rule', [
      { name: 'custom-house-rule', value: 'keep PRs small', level: 'project', setter: 'owner', date: '2026-10-17T10:00:00Z', kind: 'advised' },
      { name: 'custom-house-rule', value: 'anything goes', level: 'team', setter: 'owner', date: '2026-10-17T11:00:00Z', kind: 'advised' },
    ]);
    expect(customAdvisedLoosened.ok).toBe(false);

    // 5. Expired dev-mode still counts as governed (devModeGoverned: true, value: 'off').
    const expiredDevChain = resolvePolicyChain(
      {
        entity: { ok: true, level: 'entity', target: 'floor', policies: [] },
        project: { ok: true, level: 'project', target: 'beacon', policies: [] },
        team: {
          ok: true,
          level: 'team',
          target: 'tm_1',
          policies: [
            {
              name: 'dev-mode',
              value: 'on',
              level: 'team',
              setter: 'owner',
              date: '2026-10-17T08:00:00Z',
              expiry: '2026-10-17T10:00:00Z',
              kind: 'enforced',
            },
          ],
        },
        seat: { ok: true, level: 'seat', target: null, policies: [] },
      },
      { now: NOW },
    );
    expect(expiredDevChain.ok).toBe(true);
    expect(expiredDevChain.devModeGoverned).toBe(true);
    if (expiredDevChain.ok) {
      expect(expiredDevChain.policies['dev-mode']?.value).toBe('off');
      expect(expiredDevChain.policies['dev-mode']?.level).toBe('default');
    }
  });

  test('scene: unsigned legacy delivery_order that loosens a signed project policy is reported as the team’s difference, pointing the repair at .agents/team.yaml with who: the team’s lead, and a signed entry shadowing a legacy line emits a note', () => {
    const fx = makeFixture();
    try {
      // Signed project policy delivery-order [typed]
      const wroteProject = writePolicySet(
        fx.home,
        {
          level: 'project',
          target: 'beacon',
          name: 'delivery-order',
          value: ['typed'],
        },
        { now: NOW },
      );
      expect(wroteProject.ok).toBe(true);

      // Team file carries legacy delivery_order: [mcp-inbox, typed]
      const teamYamlPath = join(fx.root, '.agents', 'team.yaml');
      const baseYaml = readFileSync(teamYamlPath, 'utf8');
      writeFileSync(teamYamlPath, `${baseYaml.trimEnd()}\ndelivery_order: [mcp-inbox, typed]\n`);

      let out1 = '';
      let err1 = '';
      const io1: Io = {
        stdout: (t: string) => void (out1 += t),
        stderr: (t: string) => void (err1 += t),
        cwd: fx.root,
        env: {},
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const code1 = runTeamCheck({ file: '.agents/team.yaml' }, io1, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code1).toBe(1);
      expect(err1).toBe('');
      // The word adds `mcp-inbox` to the project's typed-only order, which a team level may not
      // do: the policy chain refuses it, and that one difference stands in place of the legacy
      // line taking effect.
      expect(out1).toContain(
        'difference: policy "delivery-order" at level team ("mcp-inbox, typed") loosens level project ("typed")\n' +
          '  repair: remove or narrow delivery_order in .agents/team.yaml\n' +
          "  who: the team's lead\n",
      );
      expect(out1).toContain('1 difference\n');
      expect(out1).not.toContain('for the owner');

      // Apply the printed repair: remove delivery_order from .agents/team.yaml, then check is clean.
      writeFileSync(teamYamlPath, baseYaml);
      let out2 = '';
      const io2: Io = {
        stdout: (t: string) => void (out2 += t),
        stderr: () => {},
        cwd: fx.root,
        env: {},
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const code2 = runTeamCheck({ file: '.agents/team.yaml' }, io2, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code2).toBe(0);
      expect(out2).toContain('no differences\n');

      // When a signed team entry shadows a legacy delivery_order line in the same file, check shows a note naming the shadowed line.
      writeFileSync(teamYamlPath, `${baseYaml.trimEnd()}\ndelivery_order: [native, typed]\n`);
      const wroteTeam = writePolicySet(
        fx.home,
        {
          level: 'team',
          target: fx.teamId,
          teamRoot: fx.root,
          name: 'delivery-order',
          value: ['typed'],
        },
        { now: NOW },
      );
      expect(wroteTeam.ok).toBe(true);

      let out3 = '';
      const io3: Io = {
        stdout: (t: string) => void (out3 += t),
        stderr: () => {},
        cwd: fx.root,
        env: {},
        stdinIsTTY: false,
        caller: { kind: 'owner' },
      };
      const code3 = runTeamCheck({ file: '.agents/team.yaml' }, io3, {
        live: () => QUIET_LIVE,
        branch: () => 'main',
        standing: (at) => approvalStanding(at, fx.home),
        now: () => NOW,
        home: fx.home,
      });
      expect(code3).toBe(0);
      expect(out3).toContain(
        'note: delivery_order [native, typed] in .agents/team.yaml is shadowed by the signed team delivery-order policy; remove delivery_order from .agents/team.yaml so team policy unset does not bring it back\n',
      );
      expect(out3).toContain('no differences\n');
    } finally {
      fx.cleanup();
    }
  });

  test('scene: seat-numbering prints "width 2, separator -" by default and "width auto, separator ..." when set to auto...', async () => {
    const fx = makeFixture();
    try {
      const io1 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], io1, { home: fx.home, now: () => NOW })).toBe(0);
      expect(io1.out).toContain('width 2, separator -');
      expect(io1.out).not.toMatch(/seat-numbering\s+2-\s+/);

      writePolicySet(
        fx.home,
        {
          level: 'team',
          target: fx.teamId,
          teamRoot: fx.root,
          name: 'seat-numbering',
          value: 'auto...',
        },
        { now: NOW },
      );

      const io2 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], io2, { home: fx.home, now: () => NOW })).toBe(0);
      expect(io2.out).toContain('width auto, separator ...');
    } finally {
      fx.cleanup();
    }
  });

  test('scene: unset advised policies (board, review-terms) are left out of the table with footer "not set: board, review-terms" while --json keeps every policy with set: boolean', async () => {
    const fx = makeFixture();
    try {
      const io1 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], io1, { home: fx.home, now: () => NOW })).toBe(0);
      expect(io1.out).not.toMatch(/^\s*board\s+-\s+default/m);
      expect(io1.out).not.toMatch(/^\s*review-terms\s+-\s+default/m);
      expect(io1.out).toContain('  not set: board, review-terms, vault-root\n');

      const jsonIo1 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml', '--json'], jsonIo1, { home: fx.home, now: () => NOW })).toBe(0);
      const doc1 = JSON.parse(jsonIo1.out) as {
        policies: Array<{ name: string; value: unknown; set: boolean }>;
      };
      expect(doc1.policies.find((p) => p.name === 'board')).toMatchObject({ name: 'board', value: '', set: false });
      expect(doc1.policies.find((p) => p.name === 'review-terms')).toMatchObject({ name: 'review-terms', value: '', set: false });
      expect(doc1.policies.find((p) => p.name === 'seat-numbering')).toMatchObject({ name: 'seat-numbering', value: '2-', set: true });

      // Setting board moves it into the table and leaves only review-terms in the footer.
      writePolicySet(
        fx.home,
        {
          level: 'project',
          target: 'beacon',
          name: 'board',
          value: 'https://board.floor/beacon',
        },
        { now: NOW },
      );
      const io2 = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--file', '.agents/team.yaml'], io2, { home: fx.home, now: () => NOW })).toBe(0);
      expect(io2.out).toMatch(/board\s+https:\/\/board\.floor\/beacon\s+project\s+owner\s+-\s+advised/);
      expect(io2.out).toContain('  not set: review-terms, vault-root\n');
    } finally {
      fx.cleanup();
    }
  });

  test('scene: team policy --seat X prints "same as the team" when no policy differs and marks each differing row when overrides exist', async () => {
    const fx = makeFixture();
    try {
      // 1. No seat differences -> prints "same as the team" instead of repeating the team table unchanged.
      const sameIo = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--seat', 'worker', '--file', '.agents/team.yaml'], sameIo, { home: fx.home, now: () => NOW })).toBe(0);
      expect(sameIo.out).toContain('team beacon, session "beacon" · seat worker');
      expect(sameIo.out).toContain('  same as the team\n');
      expect(sameIo.out).not.toContain('POLICY');

      // 2. Seat override that differs from the team's resolution marks the differing row.
      const diffIo = testIo(fx.root, { kind: 'owner' });
      expect(
        await runPolicy(
          ['set', 'seat:worker', 'delivery-order', 'typed', '--file', '.agents/team.yaml'],
          diffIo,
          { home: fx.home, now: () => NOW },
        ),
      ).toBe(0);

      const seatIo = testIo(fx.root, { kind: 'owner' });
      expect(await runPolicy(['--seat', 'worker', '--file', '.agents/team.yaml'], seatIo, { home: fx.home, now: () => NOW })).toBe(0);
      expect(seatIo.out).toContain('team beacon, session "beacon" · seat worker');
      expect(seatIo.out).toMatch(
        /delivery-order\s+typed\s+seat\s+owner\s+-\s+enforced \(differs from team: mcp-inbox, typed, drop\)/,
      );
      expect(seatIo.out).not.toContain('same as the team');
    } finally {
      fx.cleanup();
    }
  });
});

