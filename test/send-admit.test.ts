import { describe, expect, test } from 'bun:test';
import { admitSend, sendGrantFor, senderHeader, type AdmitTeams, type DeclaredSender, type SendGrant, type SendGrantRecord } from '../src/send/admit.ts';
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

  test('an orchestrator reaches an orchestrator of another team, and its own', () => {
    expect(admitSend(orchCli, orchRadio, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
    expect(admitSend(orchCli, orchLabs, teams)).toEqual({ ok: true, rule: 'an orchestrator to another orchestrator' });
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
    // The main team's own assistant holds the place, whatever a sub-team marks beside it.
    const headAndSub: AdmitTeams = { ...teams, labs: markedLabs };
    expect(admitSend(assistantCli, orchCli, headAndSub)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    expect(admitSend(assistantLabs, orchCli, headAndSub).ok).toBe(false);
    // With the main team marking none, the first of the entity's teams by team id holds it.
    const archivist = agent('agt_00000000000b', 'assistant', 'archive');
    const subs: AdmitTeams = {
      ...headless(),
      archive: { project: 'archive', entity: 'teamcli', roster: [{ agent: archivist.id, seat: 'assistant', role: 'assistant', assistant: true }] },
      labs: markedLabs,
    };
    expect(admitSend(archivist, orchCli, subs)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
    expect(admitSend(assistantLabs, orchCli, subs).ok).toBe(false);
  });

  test('the role word "assistant" is not the capability: the file\'s mark decides', () => {
    // A seat named and roled the word, with no mark on its line, is admitted by nothing.
    const byWord = agent('agt_00000000000c', 'assistant', 'labs');
    const withWord: AdmitTeams = {
      ...headless(),
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: byWord.id, seat: 'assistant', role: 'assistant' }] },
    };
    expect(admitSend(byWord, orchCli, withWord).ok).toBe(false);
    // And the mark on a seat called anything else is what admits it.
    const marked = agent('agt_00000000000d', 'scribe', 'labs');
    const withMark: AdmitTeams = {
      ...headless(),
      labs: { ...teams.labs!, roster: [...teams.labs!.roster, { agent: marked.id, seat: 'scribe', role: 'builder', assistant: true }] },
    };
    expect(admitSend(marked, orchCli, withMark)).toEqual({ ok: true, rule: "an assistant seat to its entity's coordinator" });
  });

  test('an orchestrator reaches every seat of its own team, and no seat of another', () => {
    // The team's lead briefs its own seats; this is the command it does it with.
    const own = { ok: true, rule: 'an orchestrator or operator to a seat of its own team' } as const;
    expect(admitSend(orchCli, builder1, teams)).toEqual(own);
    expect(admitSend(orchCli, tester1, teams)).toEqual(own);
    expect(admitSend(orchCli, assistantCli, teams)).toEqual(own);
    expect(admitSend(orchRadio, builderRadio, teams)).toEqual(own);
    // Another team's seats are reached through that team's orchestrator, not directly.
    expect(admitSend(orchCli, builderLabs, teams).ok).toBe(false);
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

  test('the operator is the place the file declares, never the role word', () => {
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
    expect(admitSend(byWord, builder1, declared).ok).toBe(false);
    expect(admitSend(byWord, builder1, base).ok).toBe(false);
    // The place is the team's own: it reaches that team's seats and no other team's.
    expect(admitSend(ops, builderLabs, declared).ok).toBe(false);
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
      entity: 'alpha-ent',
      roster: [{ agent: 'agt_00000000000c', seat: 'lead', role: 'coordinator', leads: true }],
    },
    ccc333ccc333: {
      project: 'beta',
      entity: 'beta-ent',
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

  test('the capability names the lead: seat to seat still has no rule', () => {
    expect(admitSend(agy, second, fileTeams)).toEqual({
      ok: false,
      why: "agy-seat@aaa111aaa111 may not send to second-seat@aaa111aaa111: no rule admits it (the owner; an orchestrator to another orchestrator; an orchestrator or operator to a seat of its own team; an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
    });
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
    expect(admitSend(bau, koordinator, byGerman).ok).toBe(false);
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
    expect(admitSend(englishBuilder, englishOrch, byEnglish).ok).toBe(false);
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
    'orchestrator@labs -> orchestrator@teamcli',
    'orchestrator@labs -> orchestrator@radio',
    'orchestrator@labs -> orchestrator@labs',
    'orchestrator@radio -> orchestrator@teamcli',
    'orchestrator@radio -> orchestrator@labs',
    'orchestrator@radio -> orchestrator@radio',
    "assistant@teamcli -> orchestrator@teamcli",
    'builder-1@teamcli -> orchestrator@teamcli',
    'tester-1@teamcli -> orchestrator@teamcli',
    'builder-1@labs -> orchestrator@labs',
    'builder-1@radio -> orchestrator@radio',
    'orchestrator@teamcli -> assistant@teamcli',
    'orchestrator@teamcli -> builder-1@teamcli',
    'orchestrator@teamcli -> tester-1@teamcli',
    'orchestrator@labs -> builder-1@labs',
    'orchestrator@radio -> builder-1@radio',
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
              'the owner; an orchestrator to another orchestrator; ' +
              'an orchestrator or operator to a seat of its own team; ' +
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
    // The refusal text carries the five rules, so a reader sees what would have admitted it.
    expect(admitSend(builderRadio, builder1, teams)).toEqual({
      ok: false,
      why: 'builder-1@radio may not send to builder-1@teamcli: no rule admits it (the owner; ' +
        'an orchestrator to another orchestrator; an orchestrator or operator to a seat of its own team; ' +
        "an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
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
    // Neither the field nor the mark: the seat named for a lead is no lead, whatever its role word.
    const noLead: AdmitTeams = { teamcli: { project: 'teamcli', entity: 'teamcli', roster: [{ agent: ORCH_CLI, seat: 'orchestrator', role: 'lead' }] } };
    expect(admitSend(builder1, orchCli, noLead).ok).toBe(false);
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
      `from ${BUILDER_RADIO} (builder-1 of radio, builder-1@radio) — admitted by: an owner-signed grant naming send (labs to teamcli)\n`,
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
      why: 'builder-1@radio may not send to builder-1@teamcli: no rule admits it (the owner; ' +
        'an orchestrator to another orchestrator; an orchestrator or operator to a seat of its own team; ' +
        "an assistant seat to its entity's coordinator; a seat to its own team's orchestrator; an owner-signed grant naming send)",
    });
  });
});

describe('the drop file header', () => {
  test('an agent\'s header carries its id, its seat and the admitting rule', () => {
    expect(senderHeader(builder1, "a seat to its own team's orchestrator")).toBe(
      `from ${BUILDER_1} (builder-1 of teamcli, builder-1@teamcli) — admitted by: a seat to its own team's orchestrator\n`,
    );
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
      `from ${BUILDER_RADIO} (builder-1 of radio, builder-1@radio) — admitted by: an owner-signed grant naming send (labs to teamcli)\n`,
    );
  });

  test('the header is the rule the verdict returned, so the two cannot drift', () => {
    const verdict = admitSend(builder1, orchCli, teams);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(senderHeader(builder1, verdict.rule)).toContain(verdict.rule);
  });
});
