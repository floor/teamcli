import { describe, expect, test } from 'bun:test';
import { admitSend, senderHeader, type AdmitTeams } from '../src/send/admit.ts';
import type { Agent } from '../src/registry/agents.ts';

// The reach every rule is decided over, and nothing else: a send is admitted only by a rule
// that names it, and every other pair is refused.
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
    provenance: { registered_by: 'team up', registered_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z' },
  };
}

const ORCH_CLI = 'agt_000000000001';
const BUILDER_1 = 'agt_000000000002';
const TESTER_1 = 'agt_000000000003';
const ASSISTANT_CLI = 'agt_000000000004';
const ORCH_LABS = 'agt_000000000005';
const BUILDER_LABS = 'agt_000000000006';
const ORCH_RADIO = 'agt_000000000007';
const BUILDER_RADIO = 'agt_000000000008';

const owner = 'owner' as const;
const orchCli = agent(ORCH_CLI, 'orchestrator', 'teamcli');
const builder1 = agent(BUILDER_1, 'builder-1', 'teamcli');
const tester1 = agent(TESTER_1, 'tester-1', 'teamcli');
const assistantCli = agent(ASSISTANT_CLI, 'assistant', 'teamcli');
// A second team of the same entity: its coordinator is the main team's, not its own.
const orchLabs = agent(ORCH_LABS, 'orchestrator', 'labs');
const builderLabs = agent(BUILDER_LABS, 'builder-1', 'labs');
const orchRadio = agent(ORCH_RADIO, 'orchestrator', 'radio');
const builderRadio = agent(BUILDER_RADIO, 'builder-1', 'radio');

// The registry keys its teams by team id, which is what an agent's reach.team carries: readable
// ids stand in for the sha256 the store will use.
const teams: AdmitTeams = {
  teamcli: {
    project: 'teamcli',
    entity: 'teamcli',
    roster: [
      { agent: ORCH_CLI, seat: 'orchestrator', role: 'orchestrator' },
      { agent: BUILDER_1, seat: 'builder-1', role: 'builder' },
      { agent: TESTER_1, seat: 'tester-1', role: 'tester' },
      { agent: ASSISTANT_CLI, seat: 'assistant', role: 'assistant' },
    ],
  },
  labs: {
    project: 'labs',
    entity: 'teamcli',
    roster: [
      { agent: ORCH_LABS, seat: 'orchestrator', role: 'orchestrator' },
      { agent: BUILDER_LABS, seat: 'builder-1', role: 'builder' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: ORCH_RADIO, seat: 'orchestrator', role: 'orchestrator' },
      { agent: BUILDER_RADIO, seat: 'builder-1', role: 'builder' },
    ],
  },
};

describe('send admission: the rules that admit', () => {
  test('the owner sends to anyone', () => {
    for (const target of [orchCli, builder1, builderLabs, builderRadio]) {
      expect(admitSend(owner, target, teams)).toEqual({ ok: true, rule: 'the owner' });
    }
  });

  test('an orchestrator reaches an orchestrator of another team, and its own', () => {
    expect(admitSend(orchCli, orchRadio, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    expect(admitSend(orchCli, orchLabs, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    // Its own team's lead is admitted as a seat of that team; only another team's is the pair.
    expect(admitSend(orchCli, orchCli, teams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
  });

  test('an assistant reaches the coordinator of its entity, in the main team', () => {
    // The assistant sits in a sub-team of the entity: the coordinator is the main team's lead.
    const assistantLabs = agent('agt_000000000009', 'assistant', 'labs');
    const withAssistant: AdmitTeams = {
      ...teams,
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: assistantLabs.id, seat: 'assistant', role: 'assistant' }] },
    };
    expect(admitSend(assistantLabs, orchCli, withAssistant)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    // The same rule in the entity's own team: the coordinator is its own team's lead.
    expect(admitSend(assistantCli, orchCli, teams)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
  });

  test('an orchestrator reaches any seat of its own team, and no other team\'s', () => {
    expect(admitSend(orchCli, builder1, teams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
    expect(admitSend(orchCli, tester1, teams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
    expect(admitSend(orchCli, assistantCli, teams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
    expect(admitSend(orchRadio, builderRadio, teams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
    // Another team's seats are reached through that team's orchestrator, not directly.
    expect(admitSend(orchCli, builderLabs, teams).ok).toBe(false);
    expect(admitSend(orchCli, builderRadio, teams).ok).toBe(false);
  });

  test('any seat reaches its own team\'s orchestrator', () => {
    expect(admitSend(builder1, orchCli, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(tester1, orchCli, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(builderLabs, orchLabs, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(builderRadio, orchRadio, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    // An orchestrator to its own team's lead is a seat to that lead like any other.
    expect(admitSend(orchLabs, orchLabs, teams).ok).toBe(true);
  });

  test('an owner-signed grant naming send admits the pair it was verified for', () => {
    expect(admitSend(builderRadio, builder1, teams, { name: 'send to the teamcli builders' })).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (send to the teamcli builders)',
    });
  });
});

// The shapes `up` and `add` register: a team record whose lead seat carries the file's own role
// word — `coordinator` — and no lead field of its own. The roster is what names the team's lead,
// and the acceptance scenes send over exactly these records.
describe('send admission: the lead seat a file names itself', () => {
  const fileTeams: AdmitTeams = {
    aaa111aaa111: {
      project: 'floor',
      entity: 'floor',
      roster: [
        { agent: 'agt_00000000000a', seat: 'main-coordinator', role: 'coordinator' },
        { agent: 'agt_00000000000b', seat: 'agy-seat', role: 'implementer' },
        { agent: 'agt_00000000000e', seat: 'second-seat', role: 'implementer' },
      ],
    },
    bbb222bbb222: {
      project: 'alpha',
      entity: 'alpha-ent',
      roster: [{ agent: 'agt_00000000000c', seat: 'lead', role: 'coordinator' }],
    },
    ccc333ccc333: {
      project: 'beta',
      entity: 'beta-ent',
      roster: [{ agent: 'agt_00000000000d', seat: 'lead', role: 'coordinator' }],
    },
  };
  const agy = agent('agt_00000000000b', 'agy-seat', 'aaa111aaa111');
  const second = agent('agt_00000000000e', 'second-seat', 'aaa111aaa111');
  const coordinator = agent('agt_00000000000a', 'main-coordinator', 'aaa111aaa111');
  const alphaLead = agent('agt_00000000000c', 'lead', 'bbb222bbb222');
  const betaLead = agent('agt_00000000000d', 'lead', 'ccc333ccc333');

  test('a seat reaches the coordinator its roster names, with no lead field to read', () => {
    expect(admitSend(agy, coordinator, fileTeams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    // The coordinator's own reach is the lead's: any seat of its team, and no other team's.
    expect(admitSend(coordinator, second, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator to a seat of its own team' });
    expect(admitSend(coordinator, betaLead, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('two coordinators of different teams are orchestrators to each other', () => {
    expect(admitSend(alphaLead, betaLead, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('the file word names only the lead: seat to seat still has no rule', () => {
    expect(admitSend(agy, second, fileTeams)).toEqual({
      ok: false,
      why: "agy-seat@aaa111aaa111 may not send to second-seat@aaa111aaa111: no rule admits it (the owner; an orchestrator to a seat of its own team; an orchestrator to another orchestrator; an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
    });
  });

  test('a roster naming both lead words keeps the registry\'s own first', () => {
    const both: AdmitTeams = {
      ddd444ddd444: {
        project: 'both',
        entity: 'both',
        roster: [
          { agent: 'agt_000000000011', seat: 'coord', role: 'coordinator' },
          { agent: 'agt_000000000012', seat: 'orch', role: 'orchestrator' },
          { agent: 'agt_000000000013', seat: 'worker', role: 'builder' },
        ],
      },
    };
    const worker = agent('agt_000000000013', 'worker', 'ddd444ddd444');
    const orch = agent('agt_000000000012', 'orch', 'ddd444ddd444');
    const coord = agent('agt_000000000011', 'coord', 'ddd444ddd444');
    expect(admitSend(worker, orch, both)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(worker, coord, both).ok).toBe(false);
  });
});

describe('send admission: default deny', () => {
  const everyone: { name: string; caller: Agent | 'owner' }[] = [
    { name: 'owner', caller: owner },
    { name: 'orchestrator@teamcli', caller: orchCli },
    { name: 'orchestrator@labs', caller: orchLabs },
    { name: 'orchestrator@radio', caller: orchRadio },
    { name: 'assistant@teamcli', caller: assistantCli },
    { name: 'builder-1@teamcli', caller: builder1 },
    { name: 'tester-1@teamcli', caller: tester1 },
    { name: 'builder-1@labs', caller: builderLabs },
    { name: 'builder-1@radio', caller: builderRadio },
  ];
  // The pairs the rules above list, as caller to target. Everything else in the matrix is refused.
  const admitted = new Set([
    ...everyone.map((one) => `owner -> ${one.name}`),
    'orchestrator@teamcli -> orchestrator@labs',
    'orchestrator@teamcli -> orchestrator@radio',
    'orchestrator@teamcli -> orchestrator@teamcli',
    'orchestrator@teamcli -> builder-1@teamcli',
    'orchestrator@teamcli -> tester-1@teamcli',
    'orchestrator@teamcli -> assistant@teamcli',
    'orchestrator@labs -> orchestrator@teamcli',
    'orchestrator@labs -> orchestrator@radio',
    'orchestrator@labs -> orchestrator@labs',
    'orchestrator@labs -> builder-1@labs',
    'orchestrator@radio -> orchestrator@teamcli',
    'orchestrator@radio -> orchestrator@labs',
    'orchestrator@radio -> orchestrator@radio',
    'orchestrator@radio -> builder-1@radio',
    "assistant@teamcli -> orchestrator@teamcli",
    'builder-1@teamcli -> orchestrator@teamcli',
    'tester-1@teamcli -> orchestrator@teamcli',
    'builder-1@labs -> orchestrator@labs',
    'builder-1@radio -> orchestrator@radio',
  ]);

  test('every pair the rules do not list is refused', () => {
    for (const from of everyone) {
      // The owner has no drop folder: the owner sends, and is never sent to.
      for (const to of everyone.filter((one) => one.caller !== 'owner')) {
        const pair = `${from.name} -> ${to.name}`;
        const verdict = admitSend(from.caller, to.caller as Agent, teams);
        if (admitted.has(pair)) {
          expect({ pair, ok: verdict.ok }).toEqual({ pair, ok: true });
        } else {
          expect({ pair, ...verdict }).toEqual({
            pair,
            ok: false,
            why: `${from.name} may not send to ${to.name}: no rule admits it (` +
              'the owner; an orchestrator to a seat of its own team; an orchestrator to another orchestrator; ' +
              'an assistant seat to its entity\'s coordinator; ' +
              "a seat to its own team's orchestrator; an owner-signed grant naming send)",
          });
        }
      }
    }
  });

  test('a worker reaches no worker, in its own team or another', () => {
    expect(admitSend(builder1, tester1, teams).ok).toBe(false);
    expect(admitSend(builder1, builderLabs, teams).ok).toBe(false);
    expect(admitSend(builder1, builderRadio, teams).ok).toBe(false);
    expect(admitSend(tester1, builder1, teams).ok).toBe(false);
  });

  test('a seat reaches no other team\'s orchestrator', () => {
    expect(admitSend(builder1, orchRadio, teams).ok).toBe(false);
    expect(admitSend(builderLabs, orchCli, teams).ok).toBe(false);
  });

  test('an orchestrator reaches no worker seat of another team', () => {
    expect(admitSend(orchCli, builderLabs, teams).ok).toBe(false);
    expect(admitSend(orchRadio, builderLabs, teams).ok).toBe(false);
  });

  test('an assistant reaches the entity\'s coordinator and nothing else', () => {
    // Another entity's coordinator is not this entity's.
    expect(admitSend(assistantCli, orchRadio, teams).ok).toBe(false);
    expect(admitSend(assistantCli, builder1, teams).ok).toBe(false);
    // A seat of the main team that is not its lead is not the coordinator.
    const cliWithSecondBuilder = agent('agt_00000000000a', 'builder-2', 'teamcli');
    expect(admitSend(assistantCli, cliWithSecondBuilder, teams).ok).toBe(false);
  });

  test('without a verified grant, a grant-admitted pair is refused', () => {
    // The refusal text carries the five rules, so a reader sees what would have admitted it.
    expect(admitSend(builderRadio, builder1, teams)).toEqual({
      ok: false,
      why: 'builder-1@radio may not send to builder-1@teamcli: no rule admits it (the owner; an orchestrator to a seat of its own team; ' +
        'an orchestrator to another orchestrator; ' +
        "an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
    });
  });

  test('an agent the team registry does not place is refused', () => {
    const stray = agent('agt_00000000000b', 'builder-1', 'nowhere');
    expect(admitSend(stray, orchCli, teams).ok).toBe(false);
    expect(admitSend(builder1, stray, teams).ok).toBe(false);
  });

  test('a team record with no roster lead is read by its seat named for the lead', () => {
      const sparse: AdmitTeams = { teamcli: { project: 'teamcli', entity: 'teamcli', roster: [{ agent: ORCH_CLI, seat: 'orchestrator', role: 'lead' }] } };
    expect(admitSend(builder1, orchCli, sparse)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
      const byField: AdmitTeams = { teamcli: { project: 'teamcli', entity: 'teamcli', orchestrator: 'orchestrator', roster: [{ agent: ORCH_CLI, seat: 'orchestrator', role: 'lead' }] } };
    expect(admitSend(builder1, orchCli, byField)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
  });
});

describe('the drop file header', () => {
  test('an agent\'s header carries its id, its seat and the admitting rule', () => {
    expect(senderHeader(builder1, "a seat to its own team's orchestrator")).toBe(
      `from ${BUILDER_1} (builder-1 of teamcli, builder-1@teamcli) — admitted by: a seat to its own team's orchestrator\n`,
    );
  });

  test('the owner\'s header names the owner, and a grant is named as the grant', () => {
    expect(senderHeader(owner, 'the owner')).toBe('from the owner — admitted by: the owner\n');
    expect(senderHeader(builderRadio, 'an owner-signed grant naming send (labs to teamcli)')).toBe(
      `from ${BUILDER_RADIO} (builder-1 of radio, builder-1@radio) — admitted by: an owner-signed grant naming send (labs to teamcli)\n`,
    );
  });

  test('the header is the rule the verdict returned, so the two cannot drift', () => {
    const verdict = admitSend(builder1, orchCli, teams);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(senderHeader(builder1, verdict.rule)).toContain(verdict.rule);
  });
});
