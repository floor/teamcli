// The entity's main orchestrator reaches any seat of the entity's teams.
//
// The main orchestrator is the lead of the team whose project is the entity itself — the chain
// place `onMainCoordinator` reads, the `leads` capability on the head team, never a role's word.
// Its reach is the `seats_cross_teams` setting with its own default on: it stops at another
// entity's edge, closes at any level of the asker's own chain, and only the project may reopen
// what an entity closed. A seat reaching the main orchestrator is judged exactly as before.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { admissionOf } from '../src/commands/send.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { upsertTeam } from '../src/registry/teams.ts';
import { admitSend, senderHeader, type AdmitContext, type AdmitTeams, type DeclaredSender } from '../src/send/admit.ts';

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
    expect(admitSend(radioOrch, labsOrch, teams).ok).toBe(false);
    expect(admitSend(floorOrch, radioBuilder, teams).ok).toBe(false);
    expect(admitSend(floorOrch, radioOrch, teams).ok).toBe(false);
    // Only the head team's lead holds the place: a sub-team's lead reaches no other team.
    expect(admitSend(labsOrch, floorBuilder, teams).ok).toBe(false);
  });

  test('a sub-team lead reaches neither the head team plain seats nor another sub-team plain seat', () => {
    const studioOrch = agent('agt_000000060008', 'orchestrator', 'studio', 'orchestrator');
    const studioBuilder = agent('agt_000000060009', 'builder-1', 'studio');
    const withStudio: AdmitTeams = {
      ...teams,
      studio: {
        project: 'studio',
        entity: 'floor',
        roster: [
          { agent: studioOrch.id, seat: 'orchestrator', role: 'orchestrator', leads: true },
          { agent: studioBuilder.id, seat: 'builder-1', role: 'builder' },
        ],
      },
    };
    expect(admitSend(labsOrch, studioBuilder, withStudio).ok).toBe(false);
    expect(admitSend(studioOrch, labsBuilder, withStudio).ok).toBe(false);
    expect(admitSend(studioOrch, floorBuilder, withStudio).ok).toBe(false);
    // Meanwhile the entity's main orchestrator reaches plain seats in both sub-teams, and sub-team leads reach each other.
    expect(admitSend(floorOrch, studioBuilder, withStudio)).toEqual({ ok: true, rule: MAIN_RULE });
    expect(admitSend(labsOrch, studioOrch, withStudio)).toEqual({ ok: true, rule: LEADS_RULE });
  });

  test('a claimed name or role word without the registry lead record is refused', () => {
    // A seat named and roled "orchestrator" or "coordinator" on the head team whose roster line
    // carries no `leads: true` capability (and no `orchestrator` field on the team record).
    const coordWord = agent('agt_00000006000a', 'coordinator', 'floor', 'coordinator');
    const steward = agent('agt_00000006000b', 'steward', 'floor', 'builder');
    const noLeadMarked: AdmitTeams = {
      ...teams,
      floor: {
        project: 'floor',
        entity: 'floor',
        roster: [
          { agent: FLOOR_ORCH, seat: 'orchestrator', role: 'orchestrator' },
          { agent: coordWord.id, seat: 'coordinator', role: 'coordinator' },
          { agent: FLOOR_BUILDER, seat: 'builder-1', role: 'builder' },
        ],
      },
    };
    expect(admitSend(floorOrch, labsBuilder, noLeadMarked).ok).toBe(false);
    expect(admitSend(coordWord, labsBuilder, noLeadMarked).ok).toBe(false);
    const declaredWithoutLead: DeclaredSender = {
      seat: 'orchestrator',
      team: 'floor',
      role: 'orchestrator',
      declared: true,
    };
    expect(admitSend(declaredWithoutLead, labsBuilder, noLeadMarked).ok).toBe(false);

    // When another seat (`steward`) holds the registry lead record on the head team, the seat
    // merely named `orchestrator` is refused while `steward` is admitted by the main-orchestrator rule.
    const stewardLeads: AdmitTeams = {
      ...teams,
      floor: {
        project: 'floor',
        entity: 'floor',
        roster: [
          { agent: steward.id, seat: 'steward', role: 'builder', leads: true },
          { agent: FLOOR_ORCH, seat: 'orchestrator', role: 'orchestrator' },
          { agent: coordWord.id, seat: 'coordinator', role: 'coordinator' },
        ],
      },
    };
    expect(admitSend(floorOrch, labsBuilder, stewardLeads).ok).toBe(false);
    expect(admitSend(coordWord, labsBuilder, stewardLeads).ok).toBe(false);
    expect(admitSend(steward, labsBuilder, stewardLeads)).toEqual({ ok: true, rule: MAIN_RULE });

    // A caller or target whose team has no registry record in `teams` is refused.
    const { floor: _omittedFloor, ...withoutFloor } = teams;
    const { labs: _omittedLabs, ...withoutLabs } = teams;
    expect(admitSend(floorOrch, labsBuilder, withoutFloor).ok).toBe(false);
    expect(admitSend(floorOrch, labsBuilder, withoutLabs).ok).toBe(false);
  });

  test('a caller claiming the main orchestrator name without an agent registry record is refused across teams by admissionOf', () => {
    const home = mkdtempSync(join(tmpdir(), 'team-main-orch-reach-'));
    try {
      const checked = validateTeamFile(`format: 1
project: floor
entity: floor
session: floor
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
    leads: true
  - role: builder
    name: builder-1
    label: builder-1
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
`);
      if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
      const floorFile = checked.team;
      const labsRecord = upsertTeam(home, 'labs', {
        project: 'labs',
        entity: 'floor',
        session: 'labs',
        root: join(home, 'labs-root'),
        lobby: join(home, 'lobby'),
        roster: [{ agent: LABS_BUILDER, seat: 'builder-1', role: 'builder' }],
        lifecycle: 'running',
        by: 'test',
      });
      const now = () => new Date('2026-11-03T12:00:00Z');
      const caller = { kind: 'seat' as const, name: 'orchestrator', pane: 'pane1', session: 'floor' };
      const standing = { session: 'floor', recordedPane: 'pane1', stage: 'launched' as const };

      // Without an agent registry record in `home`, the declared main orchestrator can still brief
      // its own file's seat, but any cross-team send to `labs` is refused before `admitSend`.
      const sameTeam = admissionOf(caller, floorFile, null, 'builder-1', home, 'floor', now, standing);
      expect(sameTeam.ok).toBe(true);
      const crossWithoutRecord = admissionOf(
        caller,
        floorFile,
        { team: labsRecord, agent: labsBuilder },
        'builder-1',
        home,
        'floor',
        now,
        standing,
      );
      expect(crossWithoutRecord.ok).toBe(false);
      if (!crossWithoutRecord.ok) {
        expect(crossWithoutRecord.why).toContain('sender orchestrator has no agent record on this machine');
      }

      // Once the main orchestrator's agent record is registered on `pane1`, a caller claiming the
      // name `orchestrator` from another pane (`pane9`) or another session (`other`) is refused,
      // while the genuine record on `pane1` reaches `labsBuilder` via `MAIN_RULE`.
      registerAgent(home, {
        name: 'orchestrator of floor',
        signing: { model: 'Claude Sonnet', version: '5.5', role: 'orchestrator' },
        lab: 'anthropic',
        cli: 'antigravity',
        launcher: null,
        launch: 'agy',
        reach: { team: 'floor', seat: 'orchestrator', session: 'floor', pane: 'pane1', address: null },
        mcp: [],
        skills: [],
        lifecycle: 'running',
        by: 'test',
      });
      const wrongPane = admissionOf(
        { kind: 'seat', name: 'orchestrator', pane: 'pane9', session: 'floor' },
        floorFile,
        { team: labsRecord, agent: labsBuilder },
        'builder-1',
        home,
        'floor',
        now,
        standing,
      );
      expect(wrongPane.ok).toBe(false);
      if (!wrongPane.ok) {
        expect(wrongPane.why).toContain("a pane renamed to a seat's name is not that seat");
      }

      const genuine = admissionOf(
        caller,
        floorFile,
        { team: labsRecord, agent: labsBuilder },
        'builder-1',
        home,
        'floor',
        now,
        standing,
      );
      expect(genuine.ok).toBe(true);
      if (genuine.ok) {
        expect(genuine.rule).toBe(MAIN_RULE);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  test('only the project may reopen what an entity closed, and a lower level may still close a project-reopened reach', () => {
    expect(admitSend(floorOrch, labsBuilder, teams, undefined, contextOf({ entity: false, project: true }))).toEqual({
      ok: true,
      rule: MAIN_RULE,
    });
    const staysClosed: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>[] = [
      { entity: false, team: true },
      { entity: false, seat: true },
      { entity: false, team: true, seat: true },
      { project: false, team: true },
      { project: false, seat: true },
      { team: false, seat: true },
      { entity: false, project: true, team: false },
      { entity: false, project: true, seat: false },
    ];
    for (const crossTeams of staysClosed) {
      expect({ crossTeams, ok: admitSend(floorOrch, labsBuilder, teams, undefined, contextOf(crossTeams)).ok }).toEqual({
        crossTeams,
        ok: false,
      });
    }
  });
});
