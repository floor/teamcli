import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_OWNER_AT_ONCE_KINDS,
  isOwnerAtOnce,
  OWNER_AT_ONCE_SETTING,
} from '../src/bus/kinds.ts';
import {
  checkPrivilegedKindsWrite,
  checkRoutingWrite,
  policyRefusedEvent,
  refusalRecord,
  resolveRouting,
  type RoutingActor,
  type RoutingChain,
  type RoutingWrite,
} from '../src/bus/routing.ts';
import {
  EVENT_KINDS,
  EVENT_ROUTING_DEFAULTS,
  EVENT_THRESHOLDS,
  EVENT_THRESHOLDS_SETTING,
  PRIVILEGED_KINDS,
  growPrivilegedKinds,
  isPrivilegedKind,
  type EventRouting,
} from '../src/policy/events.ts';
import type { PolicyLevel } from '../src/policy/types.ts';

const seat = (registryId: string): RoutingActor => ({ kind: 'seat', seat: registryId, registryId });
const holder = (registryId: string, kinds: readonly string[]): RoutingActor => ({
  kind: 'grant-holder',
  seat: registryId,
  registryId,
  kinds,
});

function write(overrides: Partial<RoutingWrite>): RoutingWrite {
  return {
    level: 'team',
    kind: 'message.delivered',
    change: { add: [{ seat: 'agt_someone' }] },
    actor: { kind: 'owner' },
    inherited: EVENT_ROUTING_DEFAULTS['message.delivered'] ?? [],
    ...overrides,
  };
}

describe('the default routing table', () => {
  test('a refusal reaches the owner only', () => {
    expect(EVENT_ROUTING_DEFAULTS['team.policy-refused']).toEqual(['owner']);
    expect(EVENT_ROUTING_DEFAULTS['team.policy-changed']).toEqual(['lead', 'subject', 'owner']);
  });

  test("the lead's raise reaches the owner and nobody else", () => {
    expect(EVENT_ROUTING_DEFAULTS['release.ready']).toEqual(['owner']);
    expect(EVENT_ROUTING_DEFAULTS['decision.needed']).toEqual(['owner']);
  });

  test('a delivery question reaches the sender, a blocked seat its lead and operator', () => {
    expect(EVENT_ROUTING_DEFAULTS['message.delivered']).toEqual(['sender']);
    expect(EVENT_ROUTING_DEFAULTS['message.held']).toEqual(['sender', 'lead']);
    expect(EVENT_ROUTING_DEFAULTS['seat.blocked']).toEqual(['lead', 'operator']);
  });

  test('seat.working and seat.idle reach nobody until a level adds somebody', () => {
    expect(EVENT_ROUTING_DEFAULTS['seat.working']).toEqual([]);
    expect(EVENT_ROUTING_DEFAULTS['seat.idle']).toEqual([]);
  });

  test('message.arrived is not a routing decision and is not in the table', () => {
    expect(EVENT_ROUTING_DEFAULTS['message.arrived']).toBeUndefined();
    expect(EVENT_KINDS).not.toContain('message.arrived');
  });

  test('every table entry names positions or seats only', () => {
    for (const recipients of Object.values(EVENT_ROUTING_DEFAULTS)) {
      for (const recipient of recipients) {
        if (typeof recipient === 'string') {
          expect(['lead', 'operator', 'sender', 'subject', 'owner']).toContain(recipient);
        } else {
          expect(recipient.seat.startsWith('agt_')).toBe(true);
        }
      }
    }
  });
});

describe('privileged kinds', () => {
  test('the release kinds cover grant and policy records and a seat at a prompt', () => {
    expect(PRIVILEGED_KINDS).toEqual(['team.grant-*', 'team.policy-*', 'seat.at-prompt']);
    expect(isPrivilegedKind('team.grant-issued')).toBe(true);
    expect(isPrivilegedKind('team.policy-changed')).toBe(true);
    expect(isPrivilegedKind('team.policy-refused')).toBe(true);
    expect(isPrivilegedKind('seat.at-prompt')).toBe(true);
    expect(isPrivilegedKind('seat.blocked')).toBe(false);
    expect(isPrivilegedKind('message.delivered')).toBe(false);
  });

  test('a pattern without the star is exact, not a prefix', () => {
    expect(isPrivilegedKind('team.grant-issued', ['team.grant'])).toBe(false);
    expect(isPrivilegedKind('team.grant', ['team.grant'])).toBe(true);
  });

  test('the list grows by the owner and an addition already present is no change', () => {
    const grown = growPrivilegedKinds(PRIVILEGED_KINDS, ['work.gate', 'team.grant-*', 'team.policy-refused']);
    expect(grown).toEqual([...PRIVILEGED_KINDS, 'work.gate']);
    expect(isPrivilegedKind('work.gate', grown)).toBe(true);
  });

  test('growing returns a new list and leaves the release list alone', () => {
    const grown = growPrivilegedKinds(PRIVILEGED_KINDS, ['work.suite']);
    expect(grown).not.toBe(PRIVILEGED_KINDS);
    expect(PRIVILEGED_KINDS).not.toContain('work.suite');
  });
});

describe('the event thresholds', () => {
  test('are named constants with the direction the amendment fixes', () => {
    expect(EVENT_THRESHOLDS.held_threshold_seconds).toBe(600);
    expect(EVENT_THRESHOLDS.unreachable_threshold_seconds).toBe(600);
    expect(EVENT_THRESHOLDS.idle_threshold_seconds).toBe(300);
    expect(EVENT_THRESHOLDS.reconcile_interval_seconds).toBe(120);
    expect(EVENT_THRESHOLDS.thread_ttl_seconds).toBe(72 * 60 * 60);
    expect(EVENT_THRESHOLDS.thread_cap).toBe(50);
    expect(EVENT_THRESHOLDS.retention_days).toBe(30);
  });

  test("carry a descriptor, the numbers staying the owner's to set", () => {
    expect(EVENT_THRESHOLDS_SETTING.name).toBe('event-thresholds');
    expect(EVENT_THRESHOLDS_SETTING.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(EVENT_THRESHOLDS_SETTING.ownerSovereign).toBe(true);
    expect(EVENT_THRESHOLDS_SETTING.defaults).toBe(EVENT_THRESHOLDS);
    expect(EVENT_THRESHOLDS_SETTING.shortenOnly).toEqual([
      'held_threshold_seconds',
      'unreachable_threshold_seconds',
      'idle_threshold_seconds',
    ]);
  });
});

describe("the owner's immediacy list (Amendment 01 §10)", () => {
  test('is a setting: named, at every level, owner-sovereign, with the reviewed release default', () => {
    expect(OWNER_AT_ONCE_SETTING.name).toBe('owner-at-once');
    expect(OWNER_AT_ONCE_SETTING.levels).toEqual(['entity', 'project', 'team', 'seat']);
    expect(OWNER_AT_ONCE_SETTING.ownerSovereign).toBe(true);
    expect(OWNER_AT_ONCE_SETTING.defaults).toBe(DEFAULT_OWNER_AT_ONCE_KINDS);
  });

  test('holds the kinds the amendment fixes, and its prompt and lead conditions narrow them', () => {
    expect([...DEFAULT_OWNER_AT_ONCE_KINDS]).toEqual([
      'seat.at-prompt',
      'seat.unreachable',
      'seat.done',
      'team.seat-added',
      'team.seat-removed',
      'team.seat-reloaded',
      'team.grant-issued',
      'team.grant-revoked',
      'team.grant-expired',
      'team.policy-changed',
      'team.policy-refused',
      'release.ready',
      'decision.needed',
    ]);

    // The owner's prompt kinds ring; a prompt that is not one waits for the digest.
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'permission' })).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'rate limit' })).toBe(true);
    expect(isOwnerAtOnce('seat.at-prompt', { prompt: 'question' })).toBe(false);

    // Only a lead's seat becoming unreachable or done rings.
    const leads = new Set(['clerk']);
    expect(isOwnerAtOnce('seat.done', { seat: 'clerk', leadSeats: leads })).toBe(true);
    expect(isOwnerAtOnce('seat.done', { seat: 'worker-1', leadSeats: leads })).toBe(false);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'clerk', leadSeats: leads })).toBe(true);
    expect(isOwnerAtOnce('seat.unreachable', { seat: 'worker-1', leadSeats: leads })).toBe(false);

    // The lead's raise is a decision moment: it rings, not batches.
    expect(isOwnerAtOnce('release.ready')).toBe(true);
    expect(isOwnerAtOnce('decision.needed')).toBe(true);

    // Everything else in the policy's owner traffic is routine.
    expect(isOwnerAtOnce('seat.blocked')).toBe(false);
    expect(isOwnerAtOnce('seat.working')).toBe(false);

    // A supplied list replaces the default rather than extending it.
    expect(isOwnerAtOnce('seat.blocked', {}, ['seat.blocked'])).toBe(true);
    expect(isOwnerAtOnce('team.policy-refused', {}, ['seat.blocked'])).toBe(false);
  });
});

describe('the privileged self-subscription refusal', () => {
  test('a seat may not add itself as a recipient of a privileged kind', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat1' }] },
        inherited: EVENT_ROUTING_DEFAULTS['team.grant-issued'] ?? [],
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-self-subscription');
    expect(decision.requester).toBe('agt_seat1');
    expect(decision.kind).toBe('team.grant-issued');
    expect(decision.level).toBe('team');
    expect(decision.detail).toContain('privileged kind');
    expect(decision.detail).toContain('agt_seat1');
  });

  test('the plain name is matched too, so neither form can self-add', () => {
    const named: RoutingActor = { kind: 'seat', seat: 'worker', registryId: 'agt_seat1' };
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: named,
        change: { add: [{ seat: 'worker' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-self-subscription');
  });

  test('the refusal holds at the seat level, where a writer would naturally sit', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'seat.at-prompt',
        level: 'seat',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat1' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-self-subscription');
  });

  test('a grant that names the kind still does not let its holder add itself', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.policy-changed',
        actor: holder('agt_seat1', ['team.policy-*']),
        change: { add: [{ seat: 'agt_seat1' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-self-subscription');
  });

  test('a seat adding another seat is refused under the owner-only rule, not the self rule', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat2' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-owner-only');
  });
});

describe('who may route a privileged kind', () => {
  test('the owner may', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: { kind: 'owner' },
        change: { add: [{ seat: 'agt_seat2' }], remove: [] },
      }),
    );
    expect(decision).toEqual({ ok: true, added: [{ seat: 'agt_seat2' }], removed: [] });
  });

  test('a grant holder whose grant names the kind may', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: holder('agt_operator', ['team.grant-*']),
        change: { add: [{ seat: 'agt_seat2' }] },
      }),
    );
    expect(decision.ok).toBe(true);
  });

  test('a grant holder whose grant names another kind may not', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.grant-issued',
        actor: holder('agt_operator', ['team.policy-*']),
        change: { add: [{ seat: 'agt_seat2' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-owner-only');
    expect(decision.detail).toContain('grant');
  });

  test('a plain seat may not route a privileged kind at all', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'team.policy-changed',
        actor: seat('agt_seat1'),
        change: {},
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-owner-only');
  });

  test('a kind the owner added to the list is guarded like the release kinds', () => {
    const privileged = growPrivilegedKinds(PRIVILEGED_KINDS, ['work.gate']);
    const decision = checkRoutingWrite(
      write({
        kind: 'work.gate',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat1' }] },
        privileged,
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-self-subscription');
  });
});

describe("the privileged-kinds list is the owner's", () => {
  test('the owner may grow it at any scope', () => {
    expect(checkPrivilegedKindsWrite({ actor: { kind: 'owner' }, level: 'seat' })).toEqual({ ok: true });
    expect(checkPrivilegedKindsWrite({ actor: { kind: 'owner' }, level: 'entity' })).toEqual({ ok: true });
  });

  test('a seat may not add to it or change it', () => {
    const decision = checkPrivilegedKindsWrite({ actor: seat('agt_seat1'), level: 'team' });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-kinds-owner-only');
    expect(decision.requester).toBe('agt_seat1');
    expect(decision.kind).toBe('privileged-kinds');
    expect(decision.level).toBe('team');
    expect(decision.detail).toContain('owner');
  });

  test('a grant holder may not, whatever its grant names', () => {
    const decision = checkPrivilegedKindsWrite({
      actor: holder('agt_operator', ['team.grant-*', 'team.policy-*']),
      level: 'project',
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('privileged-kinds-owner-only');
  });

  test('its refusal is the same shape, carried by the same record and event', () => {
    const decision = checkPrivilegedKindsWrite({ actor: seat('agt_seat1'), level: 'seat' });
    if (decision.ok) throw new Error('unreachable');
    const at = new Date('2026-10-18T12:00:00.000Z');
    expect(refusalRecord(decision, at).kind).toBe('privileged-kinds');
    expect(policyRefusedEvent(decision, at).recipients).toEqual(['owner']);
  });
});

describe("a grant holder's ordinary routing writes sit at project or team", () => {
  const nonPrivileged = (level: PolicyLevel) =>
    write({
      level,
      kind: 'work.gate',
      actor: holder('agt_operator', ['team.grant-*']),
      change: { add: [{ seat: 'agt_seat2' }] },
      inherited: ['lead'],
    });

  test('the entity level is outside the grant', () => {
    const decision = checkRoutingWrite(nonPrivileged('entity'));
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('grant-holder-scope');
    expect(decision.level).toBe('entity');
    expect(decision.detail).toContain('project or team');
  });

  test('the seat level is outside the grant', () => {
    const decision = checkRoutingWrite(nonPrivileged('seat'));
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('grant-holder-scope');
  });

  test('the project level is allowed', () => {
    expect(checkRoutingWrite(nonPrivileged('project')).ok).toBe(true);
  });

  test('the team level is allowed', () => {
    expect(checkRoutingWrite(nonPrivileged('team')).ok).toBe(true);
  });
});

describe('an ordinary seat writes only itself, at its own level', () => {
  test('a seat adding itself at the seat level is approved', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'work.gate',
        level: 'seat',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat1' }] },
        inherited: ['lead'],
      }),
    );
    expect(decision.ok).toBe(true);
  });

  test('a seat adding another seat is refused', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'work.gate',
        level: 'seat',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat2' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('seat-adds-itself-only');
  });

  test('a seat adding itself under its plain name is approved', () => {
    const named: RoutingActor = { kind: 'seat', seat: 'worker', registryId: 'agt_seat1' };
    const decision = checkRoutingWrite(
      write({ kind: 'work.gate', level: 'seat', actor: named, change: { add: [{ seat: 'worker' }] } }),
    );
    expect(decision.ok).toBe(true);
  });

  test('a seat adding a position is not adding itself either', () => {
    const decision = checkRoutingWrite(
      write({ level: 'seat', actor: seat('agt_seat1'), change: { add: ['lead'] } }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('seat-adds-itself-only');
  });

  test('a seat may not write at another level', () => {
    const decision = checkRoutingWrite(
      write({
        kind: 'work.gate',
        level: 'project',
        actor: seat('agt_seat1'),
        change: { add: [{ seat: 'agt_seat1' }] },
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('seat-adds-itself-only');
  });
});

describe('the chain grows and nothing standing above a level is removed', () => {
  test('a level may not remove what a higher level set', () => {
    const decision = checkRoutingWrite(
      write({
        level: 'team',
        kind: 'message.held',
        actor: { kind: 'owner' },
        change: { remove: ['lead'] },
        inherited: EVENT_ROUTING_DEFAULTS['message.held'] ?? [],
      }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.rule).toBe('routing-removes-inherited');
    expect(decision.detail).toContain('lead');
  });

  test('a privileged kind keeps its default recipients whatever a level says', () => {
    const outcome = checkRoutingWrite(
      write({
        level: 'team',
        kind: 'team.policy-refused',
        actor: { kind: 'owner' },
        change: { remove: ['owner'] },
        inherited: EVENT_ROUTING_DEFAULTS['team.policy-refused'] ?? [],
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.rule).toBe('privileged-default-stands');
  });

  test('a removal of what no level above set is approved', () => {
    const decision = checkRoutingWrite(
      write({
        level: 'team',
        kind: 'work.gate',
        actor: { kind: 'owner' },
        change: { add: [{ seat: 'agt_seat1' }], remove: [{ seat: 'agt_seat2' }] },
        inherited: ['lead'],
      }),
    );
    expect(decision).toEqual({
      ok: true,
      added: [{ seat: 'agt_seat1' }],
      removed: [{ seat: 'agt_seat2' }],
    });
  });

  test('the owner may remove a recipient that stands below the write', () => {
    const decision = checkRoutingWrite(
      write({
        level: 'project',
        kind: 'message.held',
        actor: { kind: 'owner' },
        change: { remove: [{ seat: 'agt_seat1' }] },
        inherited: ['sender', 'lead'],
      }),
    );
    expect(decision.ok).toBe(true);
  });

  test('the check reads the default table the caller will fold with', () => {
    const defaults: EventRouting = { 'team.policy-refused': ['operator'] };
    const stands = checkRoutingWrite(
      write({
        kind: 'team.policy-refused',
        actor: { kind: 'owner' },
        change: { remove: ['operator'] },
        inherited: ['operator'],
        defaults,
      }),
    );
    expect(stands.ok).toBe(false);
    if (stands.ok) throw new Error('unreachable');
    expect(stands.rule).toBe('privileged-default-stands');

    const aboveOnly = checkRoutingWrite(
      write({
        kind: 'team.policy-refused',
        actor: { kind: 'owner' },
        change: { remove: ['owner'] },
        inherited: ['owner', 'operator'],
        defaults,
      }),
    );
    expect(aboveOnly.ok).toBe(false);
    if (aboveOnly.ok) throw new Error('unreachable');
    expect(aboveOnly.rule).toBe('routing-removes-inherited');
  });
});

describe('the routing fold', () => {
  test('with no word, the defaults stand', () => {
    expect(resolveRouting('message.held', [])).toEqual(['sender', 'lead']);
    expect(resolveRouting('seat.working', [])).toEqual([]);
  });

  test('the fold reads the default table it is handed', () => {
    const defaults: EventRouting = { 'team.policy-refused': ['operator'] };
    expect(resolveRouting('team.policy-refused', [], { defaults })).toEqual(['operator']);
  });

  test('a level adds beside the defaults and the levels nest', () => {
    const chain: RoutingChain = [
      { level: 'team', word: { 'message.held': { add: [{ seat: 'agt_team1' }] } } },
      { level: 'seat', word: { 'message.held': { add: [{ seat: 'agt_seat1' }] } } },
    ];
    expect(resolveRouting('message.held', chain)).toEqual(['sender', 'lead', { seat: 'agt_team1' }, { seat: 'agt_seat1' }]);
  });

  test('the chain decides, not the order the words are listed in', () => {
    const chain: RoutingChain = [
      { level: 'seat', word: { 'work.gate': { add: [{ seat: 'agt_seat1' }] } } },
      { level: 'entity', word: { 'work.gate': { add: [{ seat: 'agt_entity1' }] } } },
    ];
    expect(resolveRouting('work.gate', chain)).toEqual(['lead', { seat: 'agt_entity1' }, { seat: 'agt_seat1' }]);
  });

  test('a recipient named twice is held once', () => {
    const chain: RoutingChain = [
      { level: 'team', word: { 'work.gate': { add: [{ seat: 'agt_same' }] } } },
      { level: 'seat', word: { 'work.gate': { add: [{ seat: 'agt_same' }] } } },
    ];
    expect(resolveRouting('work.gate', chain)).toEqual(['lead', { seat: 'agt_same' }]);
  });

  test('a word may take back what that same word added', () => {
    const chain: RoutingChain = [
      { level: 'team', word: { 'work.gate': { add: [{ seat: 'agt_team1' }], remove: [{ seat: 'agt_team1' }] } } },
    ];
    expect(resolveRouting('work.gate', chain)).toEqual(['lead']);
  });

  test('a removal of an inherited recipient changes nothing', () => {
    const chain: RoutingChain = [{ level: 'team', word: { 'message.held': { remove: ['lead'] } } }];
    expect(resolveRouting('message.held', chain)).toEqual(['sender', 'lead']);
  });

  test('a privileged default is restored even from a hand-built chain', () => {
    const chain: RoutingChain = [{ level: 'team', word: { 'team.policy-refused': { remove: ['owner'] } } }];
    expect(resolveRouting('team.policy-refused', chain)).toEqual(['owner']);
  });

  test('a kind outside the table routes to its additions alone', () => {
    const chain: RoutingChain = [{ level: 'team', word: { 'custom.kind': { add: [{ seat: 'agt_team1' }] } } }];
    expect(resolveRouting('custom.kind', chain)).toEqual([{ seat: 'agt_team1' }]);
    expect(resolveRouting('custom.other', [])).toEqual([]);
  });

  test('a custom privileged list guards the kinds it names', () => {
    const chain: RoutingChain = [{ level: 'team', word: { 'work.gate': { remove: ['lead'] } } }];
    expect(resolveRouting('work.gate', chain, { privileged: [...PRIVILEGED_KINDS, 'work.gate'] })).toEqual(['lead']);
  });
});

describe('the visible refusal', () => {
  const refusal = {
    ok: false as const,
    rule: 'privileged-self-subscription' as const,
    requester: 'agt_seat1',
    kind: 'team.policy-changed',
    level: 'seat' as PolicyLevel,
    detail: 'team.policy-changed is a privileged kind: agt_seat1 may not add itself as a recipient',
  };

  test('the record carries the rule, the requester and the kind', () => {
    const record = refusalRecord(refusal, new Date('2026-10-18T12:00:00.000Z'));
    expect(record).toEqual({
      v: 1,
      at: '2026-10-18T12:00:00.000Z',
      rule: 'privileged-self-subscription',
      requester: 'agt_seat1',
      kind: 'team.policy-changed',
      level: 'seat',
      detail: refusal.detail,
    });
  });

  test('the raised event is team.policy-refused and goes to the owner only', () => {
    const event = policyRefusedEvent(refusal, new Date('2026-10-18T12:00:00.000Z'));
    expect(event.kind).toBe('team.policy-refused');
    expect(event.recipients).toEqual(['owner']);
    expect(event.rule).toBe('privileged-self-subscription');
    expect(event.requester).toBe('agt_seat1');
    expect(event.refusedKind).toBe('team.policy-changed');
    expect(event.level).toBe('seat');
    expect(event.at).toBe('2026-10-18T12:00:00.000Z');
  });
});
