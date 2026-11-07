// A seat of one project does not reach a seat of another project. The crossing-seats
// setting opens pairs inside one project only. Synthetic registry records.
import { expect, test } from 'bun:test';
import type { Agent } from '../src/registry/agents.ts';
import { admitSend, type AdmitContext, type AdmitTeams } from '../src/send/admit.ts';

function agent(id: string, seat: string, team: string): Agent {
  return {
    id,
    name: `${seat} of ${team}`,
    signing: { model: 'Test', version: '1', role: 'builder' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team, seat, session: team, pane: 'fixture-pane-one', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    provenance: { registered_by: 'team up', registered_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' },
  };
}

const clerk = agent('agt_000000040001', 'clerk', 'oak');
const scribe = agent('agt_000000040002', 'scribe', 'pine');
const keeper = agent('agt_000000040003', 'keeper', 'elm');

const teams: AdmitTeams = {
  oak: {
    project: 'oak',
    entity: 'acme',
    roster: [{ agent: clerk.id, seat: 'clerk', role: 'builder' }],
  },
  pine: {
    project: 'pine',
    entity: 'acme',
    roster: [{ agent: scribe.id, seat: 'scribe', role: 'builder' }],
  },
  elm: {
    project: 'elm',
    entity: 'acme',
    roster: [{ agent: keeper.id, seat: 'keeper', role: 'builder' }],
  },
};

const context: AdmitContext = {
  projects: {
    north: { entity: 'acme', lead: null, teams: ['oak', 'pine'] },
    south: { entity: 'acme', lead: null, teams: ['elm'] },
  },
  crossTeams: { project: true },
};

test('a seat of another project stays refused when crossing seats are open', () => {
  const inside = admitSend(clerk, scribe, teams, undefined, context);
  expect(inside).toEqual({ ok: true, rule: 'seats crossing teams within one project, where the project allows it' });

  const outside = admitSend(clerk, keeper, teams, undefined, context);
  expect(outside.ok).toBe(false);
  if (!outside.ok) {
    expect(outside.why).toContain('clerk@oak may not send to keeper@elm');
  }
});
