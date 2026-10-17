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
import {
  DEV_MODE_OPERATIONS,
  loadAndResolvePolicyChain,
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
import { CLAUDE_IDLE, testIo } from './helpers.ts';

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

  test('dev-mode lifts the eight everyday operations (reload included) and is never seat-scoped', () => {
    expect(DEV_MODE_OPERATIONS).toEqual(['up', 'down', 'remove', 'register', 'add', 'restart', 'init', 'reload']);
    expect(POLICY_CATALOGUE['dev-mode'].levels).toEqual(['entity', 'project', 'team']);
    expect(POLICY_CATALOGUE['dev-mode'].defaultValue).toBe('off');
    expect(POLICY_CATALOGUE['dev-mode'].gateLifting).toBe(true);
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
      expect(delivery.effective.value).toEqual(['native', 'mcp-inbox', 'typed']);
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

  // Atlas ruling (5): EXPIRY — an expired value counts as UNSET at its level.
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

  // Atlas ruling (6): MIGRATION — triggered only by a dev-mode value set anywhere in the chain.
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
});
