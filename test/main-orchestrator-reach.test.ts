// The entity's main orchestrator reaches any seat of the entity's teams (OD-20261103-02).
//
// The main orchestrator is the lead of the team whose project is the entity itself — the chain
// place `onMainCoordinator` reads, the `leads` capability on the head team, never a role's word.
// Its reach is the `seats_cross_teams` setting with its own default on: it stops at another
// entity's edge, closes at any level of the asker's own chain, and only the project may reopen
// what an entity closed. A seat reaching the main orchestrator is judged exactly as before.

import { describe, expect, test } from 'bun:test';
import type { Agent } from '../src/registry/agents.ts';
import { admitSend, senderHeader, type AdmitContext, type AdmitTeams } from '../src/send/admit.ts';

const MAIN_RULE = "the entity's main orchestrator to any seat of the entity's teams";
const SEAT_RULE = "a seat to its own team's orchestrator";
const LEADS_RULE = 'an orchestrator to another orchestrator';

function agent(id: string, seat: string, team: string, role = 'builder'): Agent {
  return {
    id,
    name: `${seat} of ${team}`,
    signing: { model: 'Claude Sonnet', version: '5.5', role },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy"',
    reach: { team, seat, session: team, pane: 'pane1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    provenance: { registered_by: 'team up', registered_at: '2026-11-03T10:00:00Z', updated_at: '2026-11-03T10:00:00Z' },
  };
}

const FLOOR_ORCH = 'agt_000000060001';
const FLOOR_BUILDER = 'agt_000000060002';
const LABS_ORCH = 'agt_000000060003';
const LABS_BUILDER = 'agt_000000060004';
const RADIO_ORCH = 'agt_000000060005';
const RADIO_BUILDER = 'agt_000000060006';
const LEGACY_BUILDER = 'agt_000000060007';

// The entity's head team (its project is the entity itself) and two teams below it: one of the
// entity, one of another entity. `legacy` names no entity, so no reach may leave it.
const floorOrch = agent(FLOOR_ORCH, 'orchestrator', 'floor', 'orchestrator');
const floorBuilder = agent(FLOOR_BUILDER, 'builder-1', 'floor');
const labsOrch = agent(LABS_ORCH, 'orchestrator', 'labs', 'orchestrator');
const labsBuilder = agent(LABS_BUILDER, 'builder-1', 'labs');
const radioOrch = agent(RADIO_ORCH, 'orchestrator', 'radio', 'orchestrator');
const radioBuilder = agent(RADIO_BUILDER, 'builder-1', 'radio');
const legacyBuilder = agent(LEGACY_BUILDER, 'builder-1', 'legacy');

const teams: AdmitTeams = {
  floor: {
    project: 'floor',
    entity: 'floor',
    roster: [
      { agent: FLOOR_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: FLOOR_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  labs: {
    project: 'labs',
    entity: 'floor',
    roster: [
      { agent: LABS_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: LABS_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: RADIO_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: RADIO_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  legacy: {
    project: 'legacy',
    entity: null,
    roster: [{ agent: LEGACY_BUILDER, seat: 'builder-1', role: 'builder' }],
  },
};

describe("the entity's main orchestrator reaches any seat of the entity's teams", () => {
  test("the main orchestrator reaches another team's plain seat, and the rule names itself", () => {
    expect(admitSend(floorOrch, labsBuilder, teams)).toEqual({ ok: true, rule: MAIN_RULE });
    // The drop header carries the rule's own name.
    expect(senderHeader(floorOrch, MAIN_RULE)).toContain(`admitted by: ${MAIN_RULE}`);
    // Asked behind the lead pair: two leads keep the rule that answered them before.
    expect(admitSend(floorOrch, labsOrch, teams)).toEqual({ ok: true, rule: LEADS_RULE });
  });

  test("the main orchestrator of another entity is refused", () => {
    expect(admitSend(radioOrch, labsBuilder, teams).ok).toBe(false);
    expect(admitSend(radioOrch, floorBuilder, teams).ok).toBe(false);
    // Only the head team's lead holds the place: a sub-team's lead reaches no other team.
    expect(admitSend(labsOrch, floorBuilder, teams).ok).toBe(false);
  });

  test('a seat reaching the main orchestrator is judged exactly as before', () => {
    expect(admitSend(floorBuilder, floorOrch, teams)).toEqual({ ok: true, rule: SEAT_RULE });
    expect(admitSend(labsBuilder, floorOrch, teams).ok).toBe(false);
    expect(admitSend(labsOrch, floorOrch, teams)).toEqual({ ok: true, rule: LEADS_RULE });
    expect(admitSend(radioOrch, floorOrch, teams).ok).toBe(false);
  });

  test('a team that names no entity is not reached, in either direction', () => {
    expect(admitSend(floorOrch, legacyBuilder, teams).ok).toBe(false);
    expect(admitSend(legacyBuilder, floorOrch, teams).ok).toBe(false);
  });
});

describe('the reach is a setting, default on', () => {
  const contextOf = (crossTeams?: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>): AdmitContext => ({ projects: {}, crossTeams });

  test('on with no word: another seat of the entity is reached', () => {
    expect(admitSend(floorOrch, labsBuilder, teams, undefined, contextOf()).ok).toBe(true);
    expect(admitSend(floorOrch, labsBuilder, teams, undefined, contextOf({ project: true })).ok).toBe(true);
  });

  test("a word at any level of the asker's chain closes it", () => {
    const closed: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>[] = [
      { entity: false }, { project: false }, { team: false }, { seat: false },
    ];
    for (const crossTeams of closed) {
      expect({ crossTeams, ok: admitSend(floorOrch, labsBuilder, teams, undefined, contextOf(crossTeams)).ok }).toEqual({ crossTeams, ok: false });
    }
  });

  test('only the project may reopen what an entity closed', () => {
    expect(admitSend(floorOrch, labsBuilder, teams, undefined, contextOf({ entity: false, project: true })).ok).toBe(true);
    expect(admitSend(floorOrch, labsBuilder, teams, undefined, contextOf({ entity: false, team: true })).ok).toBe(false);
  });
});
