// Kernel amendment 02 & Runtime draft 1 chapter J: Policy object, tighten-only resolver,
// signed source readers/writers, `team policy` view & set/unset, `team check`, and migration.
import { describe, expect, test } from 'bun:test';
import {
  DEV_MODE_OPERATIONS,
  POLICY_CATALOGUE,
  POLICY_LEVELS,
  readEntityPolicySource,
  readPolicyChain,
  readProjectPolicySource,
  readSeatPolicySource,
  readTeamPolicySource,
  resolvePolicy,
  resolvePolicyChain,
  type Policy,
} from '../src/policy/index.ts';

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

  test('source reader stubs return empty verified lists until filled in', () => {
    const sources = readPolicyChain({ home: '/tmp/nonexistent', entity: 'acme', projectId: 'proj', teamRoot: '/tmp/team' });
    const resolved = resolvePolicyChain(sources);
    expect(resolved.ok).toBe(true);
    expect(resolved.devModeGoverned).toBe(false);
  });

  // Atlas ruling (5): EXPIRY — an expired value counts as UNSET at its level.
  test.todo('expiry: an expired declaration counts as unset at its level so the inherited value or release default applies, never a value no level chose', () => {});
  test.todo('expiry: an expired dev-mode on at team level falls back to project or entity value when set, or off when no higher level set it', () => {});
  test.todo('expiry: a nearer expiry on dev-mode is tighter than a later expiry or none, and a later expiry below a nearer one is refused at load naming both levels', () => {});

  // Atlas ruling (6): MIGRATION — triggered only by a dev-mode value set anywhere in the chain.
  test.todo('migration: setting a non-dev-mode policy (such as a state threshold) leaves devModeGoverned false so dev mode is not switched off for the entity', () => {});
  test.todo('migration: setting dev-mode (on or off) at entity, project, or team sets devModeGoverned true and ignores TEAMCLI_DEV_MODE', () => {});
  test.todo('migration: before any dev-mode policy is set in the chain, team check emits one notice and TEAMCLI_DEV_MODE=1 keeps today behaviour', () => {});
  test.todo('migration: once dev-mode policy is off in the chain, TEAMCLI_DEV_MODE=1 is ignored and logged once per command', () => {});

  // Source readers & owner-signed writes (Part A fill-in).
  test.todo('sources: readEntityPolicySource reads signed policies from ~/.config/team/entities.yaml and refuses tampered or malformed entries naming entity', () => {});
  test.todo('sources: readProjectPolicySource reads signed policies from ~/.config/team/projects.yaml and refuses tampered or malformed entries naming project', () => {});
  test.todo('sources: readTeamPolicySource reads owner policies: section from .agents/team.yaml and refuses tampered or malformed entries naming team', () => {});
  test.todo('sources: readSeatPolicySource reads seat policies from ~/.config/team/agents/<id>.yaml and refuses dev-mode at seat level', () => {});

  // CLI: `team policy` view & `team policy set|unset`.
  test.todo('cli: team policy prints effective policies (value, level, setter, expiry, kind) from the gate resolution and supports --json', () => {});
  test.todo('cli: team policy set|unset <level> <name> <value> [--until] is owner-only, signs the record like grants, and logs the change to .agents/team.log', () => {});

  // `team check` & `NOT_PRETENDED`.
  test.todo('check: NOT_PRETENDED omits "No policy object yet (amendment 02)" and team check reports policy load refusals as owner differences', () => {});
});
