import { describe, expect, test } from 'bun:test';
import { admitSend, ENTITY_RULE, RULE_SUMMARY, SAME_TEAM_RULE, sendGrantFor, senderHeader, type AdmitContext, type AdmitTeams, type DeclaredSender, type SendGrant, type SendGrantRecord } from '../src/send/admit.ts';
import type { Agent } from '../src/registry/agents.ts';

// The reach every rule is decided over, and nothing else: a send is admitted only by a rule
// that names it. A team's own seats write to each other, and any seat of one team writes to a
// seat of another team of its entity; every pair outside both stays refused.
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
      { agent: ORCH_CLI, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: BUILDER_1, seat: 'builder-1', role: 'builder' },
      { agent: TESTER_1, seat: 'tester-1', role: 'tester' },
      { agent: ASSISTANT_CLI, seat: 'assistant', role: 'assistant', assistant: true },
    ],
  },
  labs: {
    project: 'labs',
    entity: 'teamcli',
    roster: [
      { agent: ORCH_LABS, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: BUILDER_LABS, seat: 'builder-1', role: 'builder' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: ORCH_RADIO, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: BUILDER_RADIO, seat: 'builder-1', role: 'builder' },
    ],
  },
};

/** The fixture's own team as a file that marks no assistant: its lines without the capability,
 *  so the entity's first assistant is whichever seat a scene marks below it. */
function headless(source: AdmitTeams = teams): AdmitTeams {
  const main = source.teamcli!;
  return { ...source, teamcli: { ...main, roster: main.roster.map(({ assistant: _stale, ...line }) => line) } };
}

// The clock every grant test is judged at, and one record as the owner's folder returns them.
const NOW = new Date('2026-10-16T12:00:00.000Z');
function grantRecords(from: string, to: string, expires = '2026-11-16T00:00:00.000Z'): SendGrantRecord[] {
  return [{ name: 'labs to teamcli', from, to, expires }];
}

describe('send admission: the rules that admit', () => {
  test('the owner sends to anyone', () => {
    for (const target of [orchCli, builder1, builderLabs, builderRadio]) {
      expect(admitSend(owner, target, teams)).toEqual({ ok: true, rule: 'the owner' });
    }
  });

  test('an orchestrator reaches an orchestrator of its entity, and its own', () => {
    // Two teams of one entity write to each other's lead; another entity's lead is not reached.
    expect(admitSend(orchCli, orchLabs, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    expect(admitSend(orchLabs, orchCli, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    expect(admitSend(orchCli, orchRadio, teams).ok).toBe(false);
    expect(admitSend(orchLabs, orchRadio, teams).ok).toBe(false);
    // A lead to itself is the orchestrator pair; there is no wider own-team reach.
    expect(admitSend(orchCli, orchCli, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('an assistant reaches the coordinator of its entity, in the main team', () => {
    // The fixture's own team marks nothing: the entity's first assistant by its place in the
    // chain is the sub-team's seat, and the coordinator is the main team's lead.
    const assistantLabs = agent('agt_000000000009', 'assistant', 'labs');
    const withAssistant: AdmitTeams = {
      ...headless(),
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: assistantLabs.id, seat: 'assistant', role: 'assistant', assistant: true }] },
    };
    expect(admitSend(assistantLabs, orchCli, withAssistant)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    // The same capability in the entity's own team: the coordinator is its own team's lead.
    expect(admitSend(assistantCli, orchCli, teams)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
  });

  test('the chain decides which assistant is the entity\'s: the head of the chain wins', () => {
    const assistantLabs = agent('agt_000000000009', 'assistant', 'labs');
    const markedLabs = { ...teams.labs!, roster: [...teams.labs!.roster, { agent: assistantLabs.id, seat: 'assistant', role: 'assistant', assistant: true }] };
    // The main team's own assistant holds the place, whatever a sub-team marks beside it. The
    // sub-team's mark is still a seat of the entity, so the entity's seat rule admits its writes.
    const headAndSub: AdmitTeams = { ...teams, labs: markedLabs };
    expect(admitSend(assistantCli, orchCli, headAndSub)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    expect(admitSend(assistantLabs, orchCli, headAndSub)).toEqual({ ok: true, rule: ENTITY_RULE });
    // With the main team marking none, the first of the entity's teams by team id holds it.
    const archivist = agent('agt_00000000000b', 'assistant', 'archive');
    const subs: AdmitTeams = {
      ...headless(),
      archive: { project: 'archive', entity: 'teamcli', roster: [{ agent: archivist.id, seat: 'assistant', role: 'assistant', assistant: true }] },
      labs: markedLabs,
    };
    expect(admitSend(archivist, orchCli, subs)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    expect(admitSend(assistantLabs, orchCli, subs)).toEqual({ ok: true, rule: ENTITY_RULE });
    // Outside the entity the assistant place reaches nothing at all.
    expect(admitSend(assistantLabs, orchRadio, subs).ok).toBe(false);
  });

  test('the role word "assistant" is not the capability: the file\'s mark decides', () => {
    // A seat named and roled the word, with no mark on its line, is no assistant: the assistant
    // rule never fires. It is still a seat of the entity, reached by the entity's seat rule.
    const byWord = agent('agt_00000000000c', 'assistant', 'labs');
    const withWord: AdmitTeams = {
      ...headless(),
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: byWord.id, seat: 'assistant', role: 'assistant' }] },
    };
    expect(admitSend(byWord, orchCli, withWord)).toEqual({ ok: true, rule: ENTITY_RULE });
    // And the mark on a seat called anything else is what admits it.
    const marked = agent('agt_00000000000d', 'scribe', 'labs');
    const withMark: AdmitTeams = {
      ...headless(),
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: marked.id, seat: 'scribe', role: 'builder', assistant: true }] },
    };
    expect(admitSend(marked, orchCli, withMark)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
  });

  test('an orchestrator reaches every seat of its own team; another team of its entity is the seat rule', () => {
    // The team's lead briefs its own seats; this is the command it does it with.
    const own = { ok: true, rule: 'an orchestrator or operator to a seat of its own team' } as const;
    expect(admitSend(orchCli, builder1, teams)).toEqual(own);
    expect(admitSend(orchCli, tester1, teams)).toEqual(own);
    expect(admitSend(orchCli, assistantCli, teams)).toEqual(own);
    expect(admitSend(orchRadio, builderRadio, teams)).toEqual(own);
    // Another team's seats are reached across the entity by the seat rule, in its own name...
    expect(admitSend(orchCli, builderLabs, teams)).toEqual({ ok: true, rule: ENTITY_RULE });
    // ...and no seat of another entity is reached at all.
    expect(admitSend(orchCli, builderRadio, teams).ok).toBe(false);
  });

  test('any seat reaches its own team\'s orchestrator', () => {
    expect(admitSend(builder1, orchCli, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(tester1, orchCli, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(builderLabs, orchLabs, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(builderRadio, orchRadio, teams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    // A lead to itself is the orchestrator pair of the rule above, and nothing wider.
    expect(admitSend(orchLabs, orchLabs, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('the operator place reaches every seat; a role word alone reaches neither a place nor a team', () => {
    // The file marks its operator by name: a seat written `role: implementer` there reaches
    // every seat of its own team, and a seat merely holding the role word `operator` does not.
    const ops = agent('agt_00000000000f', 'ops', 'teamcli');
    const byWord = agent('agt_000000000010', 'wordsmith', 'teamcli');
    const base = headless();
    const declared: AdmitTeams = {
      ...base,
      teamcli: {
        ...base.teamcli!,
        operator: 'ops',
        roster: [
          ...base.teamcli!.roster,
          { agent: ops.id, seat: 'ops', role: 'implementer' },
          { agent: byWord.id, seat: 'wordsmith', role: 'operator' },
        ],
      },
    };
    expect(admitSend(ops, builder1, declared)).toEqual({ ok: true, rule: 'an orchestrator or operator to a seat of its own team' });
    // The word is no place: its pair is admitted by its team's own seat rule, and names it.
    expect(admitSend(byWord, builder1, declared)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    expect(admitSend(byWord, builder1, base)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    // The place is the team's own: another team of the entity is the seat rule, and another
    // entity's seat is reached by nothing.
    expect(admitSend(ops, builderLabs, declared)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(byWord, builderRadio, declared).ok).toBe(false);
  });

  test('two lines writing role operator reach each other, and the word never crosses teams', () => {
    // The one rule a role's own word decides: two seats of one team whose lines both write
    // `operator`. Every other reach keeps reading the capability and the place, never a word.
    const operatorA = agent('agt_000000000016', 'operator-a', 'teamcli');
    const operatorB = agent('agt_000000000017', 'operator-b', 'teamcli');
    const plain = agent('agt_000000000018', 'builder-2', 'teamcli');
    const labOperator = agent('agt_000000000019', 'operator-a', 'labs');
    const radioOperator = agent('agt_00000000001a', 'operator-a', 'radio');
    const base = headless();
    const withOperators: AdmitTeams = {
      ...base,
      teamcli: {
        ...base.teamcli!,
        roster: [
          ...base.teamcli!.roster,
          { agent: operatorA.id, seat: 'operator-a', role: 'operator' },
          { agent: operatorB.id, seat: 'operator-b', role: 'operator' },
          { agent: plain.id, seat: 'builder-2', role: 'builder' },
        ],
      },
      labs: { ...base.labs!, roster: [...base.labs!.roster, { agent: labOperator.id, seat: 'operator-a', role: 'operator' }] },
      radio: { ...base.radio!, roster: [...base.radio!.roster, { agent: radioOperator.id, seat: 'operator-a', role: 'operator' }] },
    };
    const rule = { ok: true, rule: 'an operator to another operator of its own team' } as const;
    expect(admitSend(operatorA, operatorB, withOperators)).toEqual(rule);
    expect(admitSend(operatorB, operatorA, withOperators)).toEqual(rule);
    // The roster line is the word admission reads, not the role the record was signed under.
    expect(operatorA.signing.role).toBe('builder');
    // One line with the word is no pair: the other side needs it too — the pair is then its
    // team's own seat rule, never the operator rule.
    expect(admitSend(operatorA, plain, withOperators)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    expect(admitSend(plain, operatorA, withOperators)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    // The word's rule never crosses teams: the same pair across the entity is the seat rule,
    // and across entities it is refused.
    expect(admitSend(operatorA, labOperator, withOperators)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(labOperator, operatorA, withOperators)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(operatorA, radioOperator, withOperators).ok).toBe(false);
    expect(admitSend(radioOperator, operatorA, withOperators).ok).toBe(false);
    // A caller a command already placed carries its role on the side admission receives.
    const placed: DeclaredSender = { seat: 'operator-a', team: 'teamcli', role: 'operator', declared: true };
    expect(admitSend(placed, operatorB, withOperators)).toEqual(rule);
  });

  test('an owner-signed grant naming send admits the pair it was verified for', () => {
    expect(admitSend(builderRadio, builder1, teams, { name: 'send to the teamcli builders' })).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (send to the teamcli builders)',
    });
  });
});

// The shapes `up` and `add` register: a team record whose lead seat carries the file's own role
// word — `coordinator` — and the `leads` capability beside it, with no lead field of its own. The
// capability is what names the team's lead, and the acceptance scenes send over exactly these
// records.
describe('send admission: the lead seat the roster capability names', () => {
  const fileTeams: AdmitTeams = {
    aaa111aaa111: {
      project: 'floor',
      entity: 'floor',
      roster: [
        { agent: 'agt_00000000000a', seat: 'main-coordinator', role: 'coordinator', leads: true },
        { agent: 'agt_00000000000b', seat: 'agy-seat', role: 'implementer' },
        { agent: 'agt_00000000000e', seat: 'second-seat', role: 'implementer' },
      ],
    },
    bbb222bbb222: {
      project: 'alpha',
      // The main team's entity: its lead is reached as the entity's other team leads are.
      entity: 'floor',
      roster: [{ agent: 'agt_00000000000c', seat: 'lead', role: 'coordinator', leads: true }],
    },
    ccc333ccc333: {
      project: 'beta',
      entity: 'floor',
      roster: [{ agent: 'agt_00000000000d', seat: 'lead', role: 'coordinator', leads: true }],
    },
  };
  const agy = agent('agt_00000000000b', 'agy-seat', 'aaa111aaa111');
  const second = agent('agt_00000000000e', 'second-seat', 'aaa111aaa111');
  const coordinator = agent('agt_00000000000a', 'main-coordinator', 'aaa111aaa111');
  const alphaLead = agent('agt_00000000000c', 'lead', 'bbb222bbb222');
  const betaLead = agent('agt_00000000000d', 'lead', 'ccc333ccc333');

  test('a seat reaches the lead its roster marks, with no record field to read', () => {
    expect(admitSend(agy, coordinator, fileTeams)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    // The coordinator briefs a seat of its own team, and reaches the other orchestrators.
    expect(admitSend(coordinator, second, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator or operator to a seat of its own team' });
    expect(admitSend(coordinator, betaLead, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('two coordinators of different teams are orchestrators to each other', () => {
    expect(admitSend(alphaLead, betaLead, fileTeams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
  });

  test('the capability names the lead: a seat to its fellow seat is the team rule, never the lead rule', () => {
    expect(admitSend(agy, second, fileTeams)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
  });

  test('the lead is the capability, in whatever language the file names the role', () => {
    const koordinator = agent('agt_000000000014', 'koordinator', 'eee555eee555');
    const bau = agent('agt_000000000015', 'bau-1', 'eee555eee555');
    const marked: AdmitTeams = {
      eee555eee555: {
        project: 'sprache',
        entity: 'sprache',
        roster: [
          { agent: koordinator.id, seat: 'koordinator', role: 'koordinator', leads: true },
          { agent: bau.id, seat: 'bau-1', role: 'implementer' },
        ],
      },
    };
    // A role word the reach never learned costs the lead nothing: the mark is what is read.
    expect(admitSend(bau, koordinator, marked)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    expect(admitSend(koordinator, bau, marked)).toEqual({ ok: true, rule: 'an orchestrator or operator to a seat of its own team' });
    // The word alone is no lead, in German or in English: the same rosters with no mark on them.
    // The seats are still one team's, so their pair is that team's own, and the lead's rules
    // never name it.
    const byGerman: AdmitTeams = {
      eee555eee555: {
        project: 'sprache',
        entity: 'sprache',
        roster: [
          { agent: koordinator.id, seat: 'koordinator', role: 'koordinator' },
          { agent: bau.id, seat: 'bau-1', role: 'implementer' },
        ],
      },
    };
    expect(admitSend(bau, koordinator, byGerman)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    expect(admitSend(koordinator, bau, byGerman)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    const byEnglish: AdmitTeams = {
      fff666fff666: {
        project: 'sprache',
        entity: 'sprache',
        roster: [
          { agent: 'agt_000000000014', seat: 'orchestrator', role: 'orchestrator' },
          { agent: 'agt_000000000015', seat: 'builder-1', role: 'builder' },
        ],
      },
    };
    const englishOrch = agent('agt_000000000014', 'orchestrator', 'fff666fff666');
    const englishBuilder = agent('agt_000000000015', 'builder-1', 'fff666fff666');
    expect(admitSend(englishBuilder, englishOrch, byEnglish)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
  });
});

// The live floor entity: floor's own lead is its coordinator, and teamcli and teamcli.io carry
// `entity: floor` beside their own projects — the team file's `entity:` key, which the registry's
// record writes as its `entity`. The entity's leads write to each other in every direction, every
// seat of the entity reaches every other team's seats, and an entity's edge refuses every pair
// outside it.
describe('send admission: the entity its team records name', () => {
  const floorTeams: AdmitTeams = {
    floor: {
      project: 'floor',
      entity: 'floor',
      roster: [
        { agent: 'agt_000000000020', seat: 'coordinator', role: 'coordinator', leads: true },
        { agent: 'agt_000000000021', seat: 'builder-1', role: 'builder' },
      ],
    },
    teamcli: {
      project: 'teamcli',
      entity: 'floor',
      roster: [
        { agent: 'agt_000000000022', seat: 'orchestrator', role: 'orchestrator', leads: true },
        { agent: 'agt_000000000023', seat: 'builder-1', role: 'builder' },
      ],
    },
    'teamcli.io': {
      project: 'teamcli.io',
      entity: 'floor',
      roster: [
        { agent: 'agt_000000000024', seat: 'orchestrator', role: 'orchestrator', leads: true },
        { agent: 'agt_000000000025', seat: 'builder-1', role: 'builder' },
      ],
    },
    'other-v4': {
      project: 'other-v4',
      entity: 'other-org',
      roster: [
        { agent: 'agt_000000000026', seat: 'orchestrator', role: 'orchestrator', leads: true },
        { agent: 'agt_000000000027', seat: 'builder-1', role: 'builder' },
      ],
    },
  };
  const coordinator = agent('agt_000000000020', 'coordinator', 'floor');
  const floorBuilder = agent('agt_000000000021', 'builder-1', 'floor');
  const cliLead = agent('agt_000000000022', 'orchestrator', 'teamcli');
  const cliBuilder = agent('agt_000000000023', 'builder-1', 'teamcli');
  const ioLead = agent('agt_000000000024', 'orchestrator', 'teamcli.io');
  const otherLead = agent('agt_000000000026', 'orchestrator', 'other-v4');
  const reach = { ok: true, rule: 'an orchestrator to another orchestrator' } as const;

  test('(1) two teams of one entity: their leads write to each other, both ways', () => {
    expect(admitSend(cliLead, ioLead, floorTeams)).toEqual(reach);
    expect(admitSend(ioLead, cliLead, floorTeams)).toEqual(reach);
  });

  test('(2) the entity\'s coordinator and every team lead, both ways', () => {
    // floor leads the entity: its lead reaches teamcli's and teamcli.io's, and they reach it.
    expect(admitSend(coordinator, cliLead, floorTeams)).toEqual(reach);
    expect(admitSend(cliLead, coordinator, floorTeams)).toEqual(reach);
    expect(admitSend(coordinator, ioLead, floorTeams)).toEqual(reach);
    expect(admitSend(ioLead, coordinator, floorTeams)).toEqual(reach);
  });

  test('a plain seat reaches every team of its entity, never a seat outside it', () => {
    // The seat rule is the entity's own: it pairs plain seats, both ways.
    expect(admitSend(cliBuilder, floorBuilder, floorTeams)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(floorBuilder, cliBuilder, floorTeams)).toEqual({ ok: true, rule: ENTITY_RULE });
    // To another team's lead, and to the entity's coordinator: the same seat rule, in its own name.
    expect(admitSend(cliBuilder, coordinator, floorTeams)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(cliBuilder, ioLead, floorTeams)).toEqual({ ok: true, rule: ENTITY_RULE });
    // Another entity's seat is reached by no rule at all.
    const otherBuilder = agent('agt_000000000027', 'builder-1', 'other-v4');
    expect(admitSend(cliBuilder, otherBuilder, floorTeams).ok).toBe(false);
    expect(admitSend(otherBuilder, cliBuilder, floorTeams).ok).toBe(false);
  });

  test('across entities no lead pair is admitted, in either direction', () => {
    // other-org is another entity's: every lead's reach stops at its own entity's edge.
    expect(admitSend(coordinator, otherLead, floorTeams).ok).toBe(false);
    expect(admitSend(otherLead, coordinator, floorTeams).ok).toBe(false);
    expect(admitSend(cliLead, otherLead, floorTeams).ok).toBe(false);
    expect(admitSend(otherLead, cliLead, floorTeams).ok).toBe(false);
  });

  test('two teams that name no entity are not one entity\'s, and their leads are refused', () => {
    const leadOne = agent('agt_000000000028', 'lead', 'one');
    const leadTwo = agent('agt_000000000029', 'lead', 'two');
    const noEntity: AdmitTeams = {
      one: { project: 'one', entity: null, roster: [{ agent: leadOne.id, seat: 'lead', role: 'coordinator', leads: true }] },
      two: { project: 'two', entity: null, roster: [{ agent: leadTwo.id, seat: 'lead', role: 'coordinator', leads: true }] },
    };
    expect(admitSend(leadOne, leadTwo, noEntity).ok).toBe(false);
    expect(admitSend(leadTwo, leadOne, noEntity).ok).toBe(false);
  });

  test('the asker\'s own chain may close the reach; with no word it stands', () => {
    const contextOf = (crossTeams?: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>): AdmitContext => ({ projects: {}, crossTeams });
    // No word at all, or the project's own permissive word: the entity's reach stands.
    expect(admitSend(cliLead, ioLead, floorTeams, undefined, contextOf()).ok).toBe(true);
    expect(admitSend(cliLead, ioLead, floorTeams, undefined, contextOf({ project: true })).ok).toBe(true);
    // Closed at any level of the asker's own chain, the lead pair is refused.
    const closed: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>[] = [
      { entity: false }, { project: false }, { team: false }, { seat: false },
    ];
    for (const crossTeams of closed) {
      expect(admitSend(cliLead, ioLead, floorTeams, undefined, contextOf(crossTeams)).ok).toBe(false);
    }
    // Only the project level may open it again after an entity closed it.
    expect(admitSend(cliLead, ioLead, floorTeams, undefined, contextOf({ entity: false, project: true })).ok).toBe(true);
    expect(admitSend(cliLead, ioLead, floorTeams, undefined, contextOf({ entity: false, team: true })).ok).toBe(false);
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
  // A team's own seats are all its seat rule's; the fixture's two teams of one entity — teamcli
  // and labs — are all the entity rule's; radio is another entity's, so every pair it makes with
  // either of them is refused.
  const teamOf = (name: string): string => name.slice(name.indexOf('@') + 1);
  const entityOf = (name: string): string => (teamOf(name) === 'radio' ? 'radio' : 'teamcli');
  const admitted = new Set<string>();
  for (const to of everyone) admitted.add(`owner -> ${to.name}`);
  for (const from of everyone.filter((one) => one.caller !== 'owner')) {
    for (const to of everyone.filter((one) => one.caller !== 'owner')) {
      if (entityOf(from.name) === entityOf(to.name)) admitted.add(`${from.name} -> ${to.name}`);
    }
  }

  test('every pair outside one team or entity is refused', () => {
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
            why: `${from.name} may not send to ${to.name}: no rule admits it (${RULE_SUMMARY})`,
          });
        }
      }
    }
  });

  test('a worker reaches a worker of its own team or entity, and no other entity\'s', () => {
    expect(admitSend(builder1, tester1, teams)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    expect(admitSend(builder1, builderLabs, teams)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(builder1, builderRadio, teams).ok).toBe(false);
    expect(admitSend(tester1, builder1, teams)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
  });

  test('a seat reaches no other entity\'s orchestrator', () => {
    expect(admitSend(builder1, orchRadio, teams).ok).toBe(false);
    // A team of its own entity is the seat rule, in its own name.
    expect(admitSend(builderLabs, orchCli, teams)).toEqual({ ok: true, rule: ENTITY_RULE });
  });

  test('an orchestrator reaches no worker seat of another entity', () => {
    expect(admitSend(orchCli, builderLabs, teams)).toEqual({ ok: true, rule: ENTITY_RULE });
    expect(admitSend(orchRadio, builderLabs, teams).ok).toBe(false);
  });

  test('an assistant reaches the entity\'s coordinator, and its entity; another entity is refused', () => {
    // Another entity's coordinator is not this entity's.
    expect(admitSend(assistantCli, orchRadio, teams).ok).toBe(false);
    // Its own team is its seat rule's pair, and the verdict names that rule, not the assistant one.
    expect(admitSend(assistantCli, builder1, teams)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
    // A seat of the main team that is not its lead is not the coordinator.
    const cliWithSecondBuilder = agent('agt_00000000000a', 'builder-2', 'teamcli');
    expect(admitSend(assistantCli, cliWithSecondBuilder, teams)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
  });

  test('a worker reaches another team\'s worker only through a verified grant', () => {
    // The pair the whole grant machinery exists for: refused bare, admitted with the record.
    expect(admitSend(builderRadio, builder1, teams).ok).toBe(false);
    const grant = sendGrantFor(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1@teamcli'), teams, NOW);
    expect(grant).toEqual({ name: 'labs to teamcli' });
    expect(admitSend(builderRadio, builder1, teams, grant)).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (labs to teamcli)',
    });
  });

  test('without a verified grant, a grant-admitted pair is refused', () => {
    // The refusal text carries every rule, so a reader sees what would have admitted it.
    expect(admitSend(builderRadio, builder1, teams)).toEqual({
      ok: false,
      why: `builder-1@radio may not send to builder-1@teamcli: no rule admits it (${RULE_SUMMARY})`,
    });
  });

  test('an agent the team registry does not place is refused', () => {
    const stray = agent('agt_00000000000b', 'builder-1', 'nowhere');
    expect(admitSend(stray, orchCli, teams).ok).toBe(false);
    expect(admitSend(builder1, stray, teams).ok).toBe(false);
  });

  test('a record with no capability names its lead by its own field, and one that says neither has none', () => {
    const byField: AdmitTeams = { teamcli: { project: 'teamcli', entity: 'teamcli', orchestrator: 'orchestrator', roster: [{ agent: ORCH_CLI, seat: 'orchestrator', role: 'lead' }] } };
    expect(admitSend(builder1, orchCli, byField)).toEqual({ ok: true, rule: "a seat to its own team's orchestrator" });
    // Neither the field nor the mark: the seat named for a lead is no lead, whatever its role
    // word — the pair is its team's seat rule, and never the lead rule.
    const noLead: AdmitTeams = { teamcli: { project: 'teamcli', entity: 'teamcli', roster: [{ agent: ORCH_CLI, seat: 'orchestrator', role: 'lead' }] } };
    expect(admitSend(builder1, orchCli, noLead)).toEqual({ ok: true, rule: SAME_TEAM_RULE });
  });
});

// The owner's grants folder hands admission records, never a decision: `sendGrantFor` is the
// check that the record names this caller's own identity and this receiver, and the clock. A
// record that fails it is not passed to `admitSend` at all, so the pair is refused as if the
// folder held nothing — a forged or stale record cannot widen the reach by existing.
describe('send admission: the owner-signed grant, verified pair by pair', () => {
  const grantOf = (caller: Agent, target: Agent, grants: SendGrantRecord[]): SendGrant | undefined =>
    sendGrantFor(caller, target, grants, teams, NOW);

  test('a record naming the pair by agent id admits exactly that pair', () => {
    const grant = grantOf(builderRadio, builder1, grantRecords(BUILDER_RADIO, BUILDER_1));
    expect(grant).toEqual({ name: 'labs to teamcli' });
    // The header names the record, so the receiver reads which grant was the reason.
    expect(senderHeader(builderRadio, `an owner-signed grant naming send (${grant?.name ?? ''})`)).toBe(
      'from builder-1 — admitted by: an owner-signed grant naming send (labs to teamcli)\n',
    );
  });

  test('the pair may be spelled seat@team or session/seat', () => {
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1@teamcli'))).toEqual({ name: 'labs to teamcli' });
    expect(grantOf(builderRadio, builder1, grantRecords('radio/builder-1', 'teamcli/builder-1'))).toEqual({ name: 'labs to teamcli' });
  });

  test('a bare seat names the receiver only in the caller\'s own team', () => {
    // The sender is always spelled with its team or session: a bare `from` names no team.
    expect(grantOf(builder1, tester1, grantRecords('builder-1', 'tester-1'))).toBeUndefined();
    // A bare `to` is the caller's own team's seat, and unambiguous nowhere else.
    expect(grantOf(builder1, tester1, grantRecords('builder-1@teamcli', 'tester-1'))).toEqual({ name: 'labs to teamcli' });
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1'))).toBeUndefined();
  });

  test('a forged sender id is refused, however the record spells the identity', () => {
    // Each record names somebody else: builderLabs' id, builderLabs' seat@team, orchRadio's id.
    expect(grantOf(builderRadio, builder1, grantRecords(BUILDER_LABS, BUILDER_1))).toBeUndefined();
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@labs', 'builder-1@teamcli'))).toBeUndefined();
    expect(grantOf(builderRadio, builder1, grantRecords(ORCH_RADIO, BUILDER_1))).toBeUndefined();
    // The caller's own spellings in another session's record are not its own either.
    expect(grantOf(builderRadio, builder1, grantRecords('teamcli/builder-1', 'builder-1@teamcli'))).toBeUndefined();
  });

  test('an expired record admits nothing, to the millisecond', () => {
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1@teamcli', '2026-10-16T11:59:59.999Z'))).toBeUndefined();
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1@teamcli', NOW.toISOString()))).toBeUndefined();
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'builder-1@teamcli', '2026-10-16T12:00:00.001Z'))).toEqual({ name: 'labs to teamcli' });
  });

  test('a record naming another receiver admits nothing', () => {
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', 'tester-1@teamcli'))).toBeUndefined();
    expect(grantOf(builderRadio, builder1, grantRecords('builder-1@radio', ORCH_CLI))).toBeUndefined();
  });

  test('the first record naming the pair is the one admitted, and the pair still needs no rule', () => {
    const two: SendGrantRecord[] = [
      { name: 'someone else', from: 'tester-1@teamcli', to: 'builder-1@teamcli', expires: '2026-11-16T00:00:00.000Z' },
      ...grantRecords('builder-1@radio', 'builder-1@teamcli'),
    ];
    expect(grantOf(builderRadio, builder1, two)).toEqual({ name: 'labs to teamcli' });
    // And with no record the same pair is refused, grant or no grant folder.
    expect(admitSend(builderRadio, builder1, teams, grantOf(builderRadio, builder1, []))).toEqual({
      ok: false,
      why: `builder-1@radio may not send to builder-1@teamcli: no rule admits it (${RULE_SUMMARY})`,
    });
  });
});

describe('the drop file header', () => {
  test('an agent\'s header carries its readable name and the admitting rule, and never its registry id', () => {
    const header = senderHeader(builder1, "a seat to its own team's orchestrator");
    expect(header).toBe('from builder-1 — admitted by: a seat to its own team\'s orchestrator\n');
    expect(header).not.toContain(BUILDER_1);
  });

  test('a sender the registry holds no record for is spelled as the file\'s seat, and says the record is missing', () => {
    // The bootstrap sender: no id the registry wrote, so the header names the seat the live file
    // declares and says outright that no record exists yet — a receiver reads why the id is absent.
    const declared: DeclaredSender = { seat: 'helper', team: 'teamcli', role: 'implementer', declared: true };
    expect(senderHeader(declared, "a seat to its own team's orchestrator")).toBe(
      "from the file's seat helper (no registry record yet) — admitted by: a seat to its own team's orchestrator\n",
    );
  });

  test('the owner\'s header names the owner, and a grant is named as the grant', () => {
    expect(senderHeader(owner, 'the owner')).toBe('from the owner — admitted by: the owner\n');
    expect(senderHeader(builderRadio, 'an owner-signed grant naming send (labs to teamcli)')).toBe(
      'from builder-1 — admitted by: an owner-signed grant naming send (labs to teamcli)\n',
    );
  });

  test('the header is the rule the verdict returned, so the two cannot drift', () => {
    const verdict = admitSend(builder1, orchCli, teams);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(senderHeader(builder1, verdict.rule)).toContain(verdict.rule);
  });
});
