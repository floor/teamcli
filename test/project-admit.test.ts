import { describe, expect, test } from 'bun:test';
import { admitSend, type AdmitContext, type AdmitTeams } from '../src/send/admit.ts';
import type { Agent } from '../src/registry/agents.ts';

// The project level decides a send before the team rules do. The project record names the lead —
// by agent id — and the teams; the `leads` capability decides which seat leads a team, never a
// role's name, which is each team's own word in any language. These scenes pin the three project
// rules, the setting that opens crossing seats and who may open it, and the two states that stay
// refused: a pair whose teams share no project, and a team a second project names.
function agent(id: string, seat: string, team: string): Agent {
  return {
    id,
    name: `${seat} of ${team}`,
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'builder' },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy"',
    reach: { team, seat, session: team, pane: 'w1:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    provenance: { registered_by: 'team up', registered_at: '2026-10-17T00:00:00Z', updated_at: '2026-10-17T00:00:00Z' },
  };
}

const LEAD_A = 'agt_000000030001';
const LEAD_B = 'agt_000000030002';
const LEAD_C = 'agt_000000030003';
const BUILDER_1 = 'agt_000000030004';
const BUILDER_2 = 'agt_000000030005';
const BUILDER_3 = 'agt_000000030006';
const RADIO_LEAD = 'agt_000000030007';
const SOLO_BUILDER = 'agt_000000030008';
const LEGACY_LEAD = 'agt_000000030009';
const ROLE_WORD = 'agt_00000003000a';

const leadA = agent(LEAD_A, 'lead-a', 'cli');
const leadB = agent(LEAD_B, 'lead-b', 'site');
const leadC = agent(LEAD_C, 'lead-c', 'labs');
const builder1 = agent(BUILDER_1, 'builder-1', 'cli');
const builder2 = agent(BUILDER_2, 'builder-2', 'site');
const builder3 = agent(BUILDER_3, 'builder-3', 'radio');
const radioLead = agent(RADIO_LEAD, 'lead', 'radio');
const soloBuilder = agent(SOLO_BUILDER, 'builder-1', 'solo');
const legacyLead = agent(LEGACY_LEAD, 'chief', 'legacy');
const roleWord = agent(ROLE_WORD, 'coordinator', 'legacy');

// Two projects: `teamcli` groups three teams and names lead-a its lead; `radio` is its own
// world and names its lead too. `solo` is named by no project, so it is its own. `legacy` carries
// the one row whose role is the old word and no capability, beside the seat that holds it.
const teams: AdmitTeams = {
  cli: {
    project: 'cli',
    entity: 'teamcli',
    roster: [
      { agent: LEAD_A, seat: 'lead-a', role: 'chief', leads: true },
      { agent: BUILDER_1, seat: 'builder-1', role: 'builder' },
    ],
  },
  site: {
    project: 'site',
    entity: 'teamcli',
    roster: [
      { agent: LEAD_B, seat: 'lead-b', role: 'chief', leads: true },
      { agent: BUILDER_2, seat: 'builder-2', role: 'builder' },
    ],
  },
  labs: {
    project: 'labs',
    entity: 'teamcli',
    roster: [{ agent: LEAD_C, seat: 'lead-c', role: 'chief', leads: true }],
  },
  legacy: {
    project: 'legacy',
    entity: 'teamcli',
    roster: [
      { agent: LEGACY_LEAD, seat: 'chief', role: 'chief', leads: true },
      { agent: ROLE_WORD, seat: 'coordinator', role: 'orchestrator' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: RADIO_LEAD, seat: 'lead', role: 'chief' },
      { agent: BUILDER_3, seat: 'builder-3', role: 'builder' },
    ],
  },
  solo: {
    project: 'solo',
    entity: 'solo',
    roster: [{ agent: SOLO_BUILDER, seat: 'builder-1', role: 'builder' }],
  },
};

const projects = {
  teamcli: { lead: LEAD_A, teams: ['cli', 'site', 'labs', 'legacy'] },
  radio: { lead: RADIO_LEAD, teams: ['radio'] },
};
const context: AdmitContext = { projects };
const crossed: AdmitContext = { ...context, crossTeams: { project: true } };

describe('project admission: the project decides its own pairs', () => {
  test('the project lead reaches the leads of its teams, and they reach it', () => {
    const rule = 'the project lead and the leads of its teams';
    for (const lead of [leadB, leadC, legacyLead]) {
      expect(admitSend(leadA, lead, teams, undefined, context)).toEqual({ ok: true, rule });
    }
    expect(admitSend(leadB, leadA, teams, undefined, context)).toEqual({ ok: true, rule });
    expect(admitSend(leadC, leadA, teams, undefined, context)).toEqual({ ok: true, rule });
    expect(admitSend(legacyLead, leadA, teams, undefined, context)).toEqual({ ok: true, rule });
  });

  test('team leads within one project reach each other', () => {
    const rule = 'team leads within one project to each other';
    expect(admitSend(leadC, leadB, teams, undefined, context)).toEqual({ ok: true, rule });
    expect(admitSend(leadB, leadC, teams, undefined, context)).toEqual({ ok: true, rule });
    expect(admitSend(legacyLead, leadB, teams, undefined, context)).toEqual({ ok: true, rule });
  });

  test('the project lead reaches the leads of its teams, not a plain seat of another', () => {
    // A seat of the lead's own team is the team rules' business, as it was.
    expect(admitSend(leadA, builder1, teams, undefined, context)).toEqual({
      ok: true,
      rule: 'an orchestrator or operator to a seat of its own team',
    });
    // Another team's plain seat is reached through its own lead, not from the top of the project.
    expect(admitSend(leadA, builder2, teams, undefined, context).ok).toBe(false);
    expect(admitSend(leadA, roleWord, teams, undefined, context).ok).toBe(false);
  });

  test('a lead is the `leads` capability, never a role name', () => {
    // The row whose role is the old word does not lead `legacy`; the seat holding the capability
    // does — and the capability reaches the project lead both ways, whatever the role is called.
    const rule = 'the project lead and the leads of its teams';
    expect(admitSend(roleWord, leadA, teams, undefined, context).ok).toBe(false);
    expect(admitSend(legacyLead, leadA, teams, undefined, context)).toEqual({ ok: true, rule });
    expect(admitSend(roleWord, leadB, teams, undefined, context).ok).toBe(false);
    expect(admitSend(legacyLead, leadB, teams, undefined, context)).toEqual({
      ok: true,
      rule: 'team leads within one project to each other',
    });
  });

  test('seats crossing teams stay refused until the project allows it', () => {
    const verdict = admitSend(builder1, builder2, teams, undefined, context);
    expect(verdict.ok).toBe(false);
    expect((verdict as { why: string }).why).toBe(
      'builder-1@cli may not send to builder-2@site: no rule admits it (the project lead and the leads of its teams; ' +
        'team leads within one project to each other; seats crossing teams within one project, where the project allows it; ' +
        "the owner; an orchestrator to another orchestrator; an orchestrator or operator to a seat of its own team; " +
        "an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
    );
  });

  test('the project setting opens crossing seats, and only the project level may open it', () => {
    const rule = 'seats crossing teams within one project, where the project allows it';
    expect(admitSend(builder1, builder2, teams, undefined, crossed)).toEqual({ ok: true, rule });
    expect(admitSend(builder2, builder1, teams, undefined, crossed)).toEqual({ ok: true, rule });
    // Every level below may close it again: the seat that closes it closes it on itself alone.
    expect(admitSend(builder1, builder2, teams, undefined, { ...context, crossTeams: { project: true, team: false } }).ok).toBe(false);
    expect(admitSend(builder1, builder2, teams, undefined, { ...context, crossTeams: { project: true, seat: false } }).ok).toBe(false);
    // An entity's word opens nothing: only the project level may loosen this setting.
    expect(admitSend(builder1, builder2, teams, undefined, { ...context, crossTeams: { entity: true } }).ok).toBe(false);
  });

  test('cross-project stays refused, setting or not', () => {
    expect(admitSend(builder1, builder3, teams, undefined, crossed).ok).toBe(false);
    expect(admitSend(leadA, radioLead, teams, undefined, crossed).ok).toBe(false);
    // `solo` is named by no project, so it is its own: no setting opens a door into it.
    expect(admitSend(builder1, soloBuilder, teams, undefined, crossed).ok).toBe(false);
    expect(admitSend(leadA, soloBuilder, teams, undefined, crossed).ok).toBe(false);
  });

  test('a team named in two projects is refused, naming both', () => {
    const cliTwice: AdmitContext = { projects: { ...projects, pOther: { lead: null, teams: ['cli'] } } };
    expect(admitSend(leadA, leadB, teams, undefined, cliTwice)).toEqual({
      ok: false,
      why: 'lead-a@cli may not send to lead-b@site: team cli is named in 2 projects: pOther, teamcli',
    });
    const radioTwice: AdmitContext = { projects: { ...projects, pOther: { lead: null, teams: ['radio'] } } };
    expect(admitSend(leadA, builder3, teams, undefined, radioTwice)).toEqual({
      ok: false,
      why: 'lead-a@cli may not send to builder-3@radio: team radio is named in 2 projects: pOther, radio',
    });
  });

  test('with no project context the project rules are not in play', () => {
    const verdict = admitSend(builder1, builder2, teams);
    expect(verdict.ok).toBe(false);
    expect((verdict as { why: string }).why).not.toContain('project');
    // The team rules read the same capability: two leads of one entity are the orchestrator pair.
    expect(admitSend(leadC, leadB, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    expect(admitSend(leadA, builder1, teams)).toEqual({ ok: true, rule: 'an orchestrator or operator to a seat of its own team' });
  });
});
