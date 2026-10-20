import { describe, expect, test } from 'bun:test';
import {
  PROJECT_RULE_SUMMARY,
  REPLY_RULE,
  RULE_SUMMARY,
  admitSend,
  type AdmitContext,
  type AdmitTeams,
  type DeclaredSender,
} from '../src/send/admit.ts';
import type { Agent } from '../src/registry/agents.ts';

// The admission coverage matrix: every seat role a team file can hold, as a sender and as a
// receiver, over one team, two teams of one entity, and two entities. Each scene is a decision
// over synthetic registry records — `admitSend` reads no file, no clock and no pane — so the
// table below is the whole contract each role pair is judged by.
//
// The rules are the ones `src/send/admit.ts` names: the owner; a lead to another lead of its
// entity; a lead or the operator place to a seat of its own team; two roster lines whose role
// word is exactly `operator`; the entity's first assistant to its coordinator; any seat to its
// own team's lead; an owner-signed grant; and, last, a reply on an open thread. The project
// rules are asked first when a context is handed in, and an empty project registry adds their
// names to a refusal without changing a verdict: the real project pairs are pinned in
// `test/project-admit.test.ts`.
//
// What this seam does not model, because the command resolves it before admission is asked:
// a nickname is a second address of a seat (`erato` for `writer-06`) and reaches the same
// string the file names; and a declared sender outside its own team is refused by `runSend`
// before `admitSend` runs (`test/cross-team-sends.test.ts` pins that boundary over the command).
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
    provenance: { registered_by: 'team up', registered_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' },
  };
}

const RULE = {
  owner: 'the owner',
  leads: 'an orchestrator to another orchestrator',
  briefs: 'an orchestrator or operator to a seat of its own team',
  operators: 'an operator to another operator of its own team',
  assistant: "an assistant seat to its entity's coordinator",
  seat: "a seat to its own team's orchestrator",
  grant: 'an owner-signed grant naming send',
} as const;

const ID = {
  lead: 'agt_000000050001',
  operatorPlace: 'agt_000000050002',
  operatorWord: 'agt_000000050003',
  architect: 'agt_000000050004',
  writer: 'agt_000000050005',
  erato: 'agt_000000050006',
  builder: 'agt_000000050007',
  tester: 'agt_000000050008',
  reviewer: 'agt_000000050009',
  implementer: 'agt_00000005000a',
  documentarist: 'agt_00000005000b',
  coordinatorWord: 'agt_00000005000c',
  assistant: 'agt_00000005000d',
  assistantWord: 'agt_00000005000e',
  materialCoordinator: 'agt_00000005000f',
  materialLead: 'agt_000000050010',
  cliLead: 'agt_000000050011',
  cliWriter: 'agt_000000050012',
  radioLead: 'agt_000000050013',
  radioWriter: 'agt_000000050014',
  wordLead: 'agt_000000050015',
  wordOrchestrator: 'agt_000000050016',
  wordBuilder: 'agt_000000050017',
  legacyLead: 'agt_000000050018',
  legacyBuilder: 'agt_000000050019',
  stray: 'agt_00000005001a',
} as const;

// The floor team's seats, one per role a live file has shown: the lead place, the operator
// place and the operator role word (two different seats), the plain seats of every kind, a
// coordinator word holding no place, and one assistant with the capability beside one with only
// the word. `operator-3` is the file's `operator:` place; `operator-02` is the second operator
// the owner added, reached by its role word alone.
const floorLead = agent(ID.lead, 'orchestrator', 'floor');
const operatorPlace = agent(ID.operatorPlace, 'operator-3', 'floor');
const operatorWord = agent(ID.operatorWord, 'operator-02', 'floor');
const architect = agent(ID.architect, 'architect', 'floor');
const writer06 = agent(ID.writer, 'writer-06', 'floor');
const erato = agent(ID.erato, 'erato', 'floor');
const builder1 = agent(ID.builder, 'builder-1', 'floor');
const tester1 = agent(ID.tester, 'tester-1', 'floor');
const reviewer1 = agent(ID.reviewer, 'reviewer-1', 'floor');
const implementer1 = agent(ID.implementer, 'implementer-1', 'floor');
const documentarist = agent(ID.documentarist, 'documentarist', 'floor');
const coordinatorWord = agent(ID.coordinatorWord, 'coordinator', 'floor');
const assistantCapability = agent(ID.assistant, 'assistant', 'floor');
const assistantWord = agent(ID.assistantWord, 'assistant-word', 'floor');

const materialCoordinator = agent(ID.materialCoordinator, 'coordinator', 'material');
const materialLead = agent(ID.materialLead, 'orchestrator', 'material');
const cliLead = agent(ID.cliLead, 'orchestrator', 'teamcli');
const cliWriter = agent(ID.cliWriter, 'writer-06', 'teamcli');
const radioLead = agent(ID.radioLead, 'orchestrator', 'radio');
const radioWriter = agent(ID.radioWriter, 'writer-06', 'radio');
const wordLead = agent(ID.wordLead, 'coord', 'word');
const wordOrchestrator = agent(ID.wordOrchestrator, 'orchestrator', 'word');
const wordBuilder = agent(ID.wordBuilder, 'builder-1', 'word');
const legacyLead = agent(ID.legacyLead, 'coord', 'legacy');
const legacyBuilder = agent(ID.legacyBuilder, 'builder-1', 'legacy');
const stray = agent(ID.stray, 'builder-1', 'nowhere');

// Two entities: floor owns floor, teamcli and material; radio is its own. `word` and `legacy`
// hold the shapes a role word or a legacy lead key gets wrong; neither names an entity, so no
// lead pair leaves them.
const teams: AdmitTeams = {
  floor: {
    project: 'floor',
    entity: 'floor',
    operator: 'operator-3',
    roster: [
      { agent: ID.lead, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: ID.operatorPlace, seat: 'operator-3', role: 'operator' },
      { agent: ID.operatorWord, seat: 'operator-02', role: 'operator' },
      { agent: ID.architect, seat: 'architect', role: 'architect' },
      { agent: ID.writer, seat: 'writer-06', role: 'writer' },
      { agent: ID.erato, seat: 'erato', role: 'writer' },
      { agent: ID.builder, seat: 'builder-1', role: 'builder' },
      { agent: ID.tester, seat: 'tester-1', role: 'tester' },
      { agent: ID.reviewer, seat: 'reviewer-1', role: 'reviewer' },
      { agent: ID.implementer, seat: 'implementer-1', role: 'implementer' },
      { agent: ID.documentarist, seat: 'documentarist', role: 'documentarist' },
      { agent: ID.coordinatorWord, seat: 'coordinator', role: 'coordinator' },
      { agent: ID.assistant, seat: 'assistant', role: 'assistant', assistant: true },
      { agent: ID.assistantWord, seat: 'assistant-word', role: 'assistant' },
    ],
  },
  teamcli: {
    project: 'teamcli',
    entity: 'floor',
    roster: [
      { agent: ID.cliLead, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: ID.cliWriter, seat: 'writer-06', role: 'writer' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: ID.radioLead, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: ID.radioWriter, seat: 'writer-06', role: 'writer' },
    ],
  },
  word: {
    project: 'word',
    entity: 'word',
    roster: [
      { agent: ID.wordLead, seat: 'coord', role: 'coordinator', leads: true },
      { agent: ID.wordOrchestrator, seat: 'orchestrator', role: 'orchestrator' },
      { agent: ID.wordBuilder, seat: 'builder-1', role: 'builder' },
    ],
  },
  legacy: {
    project: 'legacy',
    entity: null,
    orchestrator: 'coord',
    roster: [
      { agent: ID.legacyLead, seat: 'coord', role: 'coordinator' },
      { agent: ID.legacyBuilder, seat: 'builder-1', role: 'builder' },
    ],
  },
};

/** The refusal a pair gets, with the rules a send is judged by: the team rules alone when no
 *  context is handed in, the project rules ahead of them when one is, and the reply rule last
 *  when the context carries it. */
function refusalWhy(from: string, to: string, context?: AdmitContext): string {
  const summary = context === undefined ? RULE_SUMMARY : `${PROJECT_RULE_SUMMARY}; ${RULE_SUMMARY}`;
  const listed = context?.reply === undefined ? summary : `${summary}; ${REPLY_RULE}`;
  return `${from} may not send to ${to}: no rule admits it (${listed})`;
}

const at = (side: Agent): string => `${side.reach.seat}@${side.reach.team}`;

type GridRow = { id: string; side: Agent };
const grid: GridRow[] = [
  { id: 'lead', side: floorLead },
  { id: 'operator-place', side: operatorPlace },
  { id: 'operator-word', side: operatorWord },
  { id: 'architect', side: architect },
  { id: 'writer', side: writer06 },
  { id: 'erato', side: erato },
  { id: 'builder', side: builder1 },
  { id: 'tester', side: tester1 },
  { id: 'reviewer', side: reviewer1 },
  { id: 'implementer', side: implementer1 },
  { id: 'documentarist', side: documentarist },
  { id: 'coordinator-word', side: coordinatorWord },
  { id: 'assistant-capability', side: assistantCapability },
  { id: 'assistant-word', side: assistantWord },
];

// The pairs the same-team rules admit, and the rule that answers each. Every pair not written
// here is refused: the table is exhaustive over the grid, both as caller and as receiver.
const admittedSameTeam: Record<string, Partial<Record<string, string>>> = {
  lead: Object.fromEntries(grid.map((row) => [row.id, row.id === 'lead' ? RULE.leads : RULE.briefs])),
  'operator-place': Object.fromEntries(grid.map((row) => [row.id, RULE.briefs])),
  'operator-word': { lead: RULE.seat, 'operator-place': RULE.operators, 'operator-word': RULE.operators },
  architect: { lead: RULE.seat },
  writer: { lead: RULE.seat },
  erato: { lead: RULE.seat },
  builder: { lead: RULE.seat },
  tester: { lead: RULE.seat },
  reviewer: { lead: RULE.seat },
  implementer: { lead: RULE.seat },
  documentarist: { lead: RULE.seat },
  'coordinator-word': { lead: RULE.seat },
  'assistant-capability': { lead: RULE.assistant },
  'assistant-word': { lead: RULE.seat },
};

function judgeSameTeam(context: AdmitContext | undefined, label: string): void {
  for (const caller of grid) {
    for (const target of grid) {
      const pair = `${caller.id} -> ${target.id} (${label})`;
      const rule = admittedSameTeam[caller.id]?.[target.id];
      const verdict = admitSend(caller.side, target.side, teams, undefined, context);
      const expected = rule === undefined
        ? ({ pair, ok: false, why: refusalWhy(at(caller.side), at(target.side), context) } as const)
        : ({ pair, ok: true, rule } as const);
      expect({ pair, ...verdict }).toEqual(expected);
    }
  }
}

describe('the same-team role matrix', () => {
  test('every role pair, decided with no project context', () => {
    judgeSameTeam(undefined, 'no context');
  });

  test('the same verdicts with an empty project registry: the project rules add names, not rules', () => {
    judgeSameTeam({ projects: {} }, 'empty projects');
  });

  test('every role has an admitted pair and a refused pair', () => {
    for (const caller of grid) {
      const sameTeam = grid.map((target) => admitSend(caller.side, target.side, teams));
      expect({ role: caller.id, admitted: sameTeam.some((verdict) => verdict.ok) }).toEqual({ role: caller.id, admitted: true });
      const crossing = admitSend(caller.side, cliWriter, teams);
      expect({ role: caller.id, refused: crossing.ok }).toEqual({ role: caller.id, refused: false });
    }
  });
});

describe('team relations: what crosses an edge', () => {
  const crossRows: GridRow[] = [
    { id: 'entity-lead', side: cliLead },
    { id: 'entity-writer', side: cliWriter },
    { id: 'other-entity-lead', side: radioLead },
    { id: 'other-entity-writer', side: radioWriter },
    { id: 'unregistered', side: stray },
  ];
  // One crossing pair, the lead pair of one entity. Every other role pair crossing a team edge
  // is refused, same entity or not.
  const admittedCrossing: Record<string, Partial<Record<string, string>>> = {
    lead: { 'entity-lead': RULE.leads },
  };

  test('a role crosses only as a lead of the entity, and only to the entity\'s lead', () => {
    for (const caller of grid) {
      for (const target of crossRows) {
        const pair = `${caller.id} -> ${target.id}`;
        const rule = admittedCrossing[caller.id]?.[target.id];
        const verdict = admitSend(caller.side, target.side, teams);
        const expected = rule === undefined
          ? ({ pair, ok: false, why: refusalWhy(at(caller.side), at(target.side)) } as const)
          : ({ pair, ok: true, rule } as const);
        expect({ pair, ...verdict }).toEqual(expected);
      }
    }
  });

  test('the lead pair is symmetric inside one entity and stops at its edge', () => {
    expect(admitSend(floorLead, cliLead, teams)).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(cliLead, floorLead, teams)).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(cliLead, radioLead, teams).ok).toBe(false);
    expect(admitSend(radioLead, cliLead, teams).ok).toBe(false);
    // A lead reaches no other team's plain seat, and a plain seat no other team's lead.
    expect(admitSend(cliLead, architect, teams).ok).toBe(false);
    expect(admitSend(cliLead, operatorPlace, teams).ok).toBe(false);
    expect(admitSend(cliWriter, floorLead, teams).ok).toBe(false);
    expect(admitSend(architect, cliLead, teams).ok).toBe(false);
  });

  test('a seat the registry does not place is refused either way', () => {
    expect(admitSend(stray, floorLead, teams).ok).toBe(false);
    expect(admitSend(stray, cliLead, teams).ok).toBe(false);
    expect(admitSend(floorLead, stray, teams).ok).toBe(false);
    expect(admitSend(cliLead, stray, teams).ok).toBe(false);
  });
});

describe('the three refused role cases of 2026-10-18 and 2026-10-19', () => {
  test('A: the architect reaches its own lead, and not the operator place', () => {
    // The logged refusal targets the floor operator place, not the floor orchestrator; the
    // seat-to-own-lead pair below is the rule that was already there.
    expect(admitSend(architect, operatorPlace, teams)).toEqual({
      ok: false,
      why: refusalWhy('architect@floor', 'operator-3@floor'),
    });
    // The live line printed the project rules ahead of the team rules: same verdict, longer list.
    expect(admitSend(architect, operatorPlace, teams, undefined, { projects: {} })).toEqual({
      ok: false,
      why: refusalWhy('architect@floor', 'operator-3@floor', { projects: {} }),
    });
    expect(admitSend(architect, floorLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    // The place is reached by the lead and by the operator place itself.
    expect(admitSend(floorLead, operatorPlace, teams)).toEqual({ ok: true, rule: RULE.briefs });
    expect(admitSend(operatorPlace, floorLead, teams)).toEqual({ ok: true, rule: RULE.briefs });
    // A plain seat reaches it only through a verified grant or a reply on an open thread.
    expect(admitSend(architect, operatorPlace, teams, { name: 'architect to the operators' })).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (architect to the operators)',
    });
    expect(admitSend(architect, operatorPlace, teams, undefined, { projects: {}, reply: 'open-thread' })).toEqual({
      ok: true,
      rule: REPLY_RULE,
    });
  });

  test('B: a seat reaches no other seat of its team, by seat name or by nickname', () => {
    const refusal = { projects: {} };
    expect(admitSend(operatorWord, writer06, teams, undefined, refusal)).toEqual({
      ok: false,
      why: refusalWhy('operator-02@floor', 'writer-06@floor', refusal),
    });
    // `erato` is the nickname of the same writer: admission judges the string the command
    // resolved, and the refusal is the same.
    expect(admitSend(operatorWord, erato, teams, undefined, refusal)).toEqual({
      ok: false,
      why: refusalWhy('operator-02@floor', 'erato@floor', refusal),
    });
    // Plain seat to plain seat has no rule in either direction.
    expect(admitSend(writer06, erato, teams).ok).toBe(false);
    expect(admitSend(erato, writer06, teams).ok).toBe(false);
    // The operator word reaches its own pair and its own team's lead, and nothing else.
    expect(admitSend(operatorWord, operatorPlace, teams)).toEqual({ ok: true, rule: RULE.operators });
    expect(admitSend(operatorWord, floorLead, teams)).toEqual({ ok: true, rule: RULE.seat });
  });

  test('C: the entity and the lead place, before and after the rename', () => {
    // The material team before the fix: a legacy lead key, and no `entity:` in its file.
    const before: AdmitTeams = {
      ...teams,
      material: {
        project: 'material',
        entity: null,
        orchestrator: 'coordinator',
        roster: [{ agent: ID.materialCoordinator, seat: 'coordinator', role: 'coordinator' }],
      },
    };
    expect(admitSend(floorLead, materialCoordinator, before, undefined, { projects: {} })).toEqual({
      ok: false,
      why: refusalWhy('orchestrator@floor', 'coordinator@material', { projects: {} }),
    });

    // The entity written, the lead place not yet moved: the old seat still names the pair.
    const stale: AdmitTeams = {
      ...teams,
      material: {
        project: 'material',
        entity: 'floor',
        orchestrator: 'coordinator',
        roster: [
          { agent: ID.materialCoordinator, seat: 'coordinator', role: 'coordinator' },
          { agent: ID.materialLead, seat: 'orchestrator', role: 'orchestrator', leads: true },
        ],
      },
    };
    expect(admitSend(floorLead, materialCoordinator, stale, undefined, { projects: {} })).toEqual({ ok: true, rule: RULE.leads });
    // The renamed seat is not the lead place yet, so the pair is refused at the lead test.
    expect(admitSend(floorLead, materialLead, stale, undefined, { projects: {} })).toEqual({
      ok: false,
      why: refusalWhy('orchestrator@floor', 'orchestrator@material', { projects: {} }),
    });

    // The file's mark on the renamed seat and the shared entity: the lead pair both ways.
    const after: AdmitTeams = {
      ...teams,
      material: {
        project: 'material',
        entity: 'floor',
        roster: [{ agent: ID.materialLead, seat: 'orchestrator', role: 'orchestrator', leads: true }],
      },
    };
    expect(admitSend(floorLead, materialLead, after)).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(materialLead, floorLead, after)).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(cliLead, materialLead, after)).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(radioLead, materialLead, after).ok).toBe(false);
  });
});

describe('role words that name no place', () => {
  test('a seat named and roled orchestrator is no lead: the capability is', () => {
    expect(admitSend(wordOrchestrator, wordLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(wordOrchestrator, wordBuilder, teams).ok).toBe(false);
    // The word on the receiver names nothing either: a lead writes to it as to any seat.
    expect(admitSend(wordLead, wordBuilder, teams)).toEqual({ ok: true, rule: RULE.briefs });
    expect(admitSend(wordLead, wordOrchestrator, teams)).toEqual({ ok: true, rule: RULE.briefs });
    expect(admitSend(wordOrchestrator, floorLead, teams).ok).toBe(false);
    expect(admitSend(wordLead, floorLead, teams).ok).toBe(false);
  });

  test('a coordinator word with no mark is no lead, and reaches only its own lead', () => {
    expect(admitSend(coordinatorWord, floorLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(coordinatorWord, writer06, teams).ok).toBe(false);
    expect(admitSend(floorLead, coordinatorWord, teams)).toEqual({ ok: true, rule: RULE.briefs });
  });

  test('the record\'s lead field names the lead when no roster line carries the mark', () => {
    expect(admitSend(legacyBuilder, legacyLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(legacyLead, legacyBuilder, teams)).toEqual({ ok: true, rule: RULE.briefs });
    // No entity on the record: the lead pair stops at the team edge.
    expect(admitSend(floorLead, legacyLead, teams).ok).toBe(false);
    expect(admitSend(legacyLead, floorLead, teams).ok).toBe(false);
  });

  test('the assistant capability, not its word, reaches the coordinator', () => {
    expect(admitSend(assistantCapability, floorLead, teams)).toEqual({ ok: true, rule: RULE.assistant });
    expect(admitSend(assistantWord, floorLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(assistantWord, cliLead, teams).ok).toBe(false);
    expect(admitSend(assistantCapability, cliLead, teams).ok).toBe(false);
    expect(admitSend(assistantCapability, writer06, teams).ok).toBe(false);
  });
});

describe('a declared sender: judged by its file seat, inside its own team', () => {
  const declaredArchitect: DeclaredSender = { seat: 'architect', team: 'floor', role: 'architect', declared: true };
  const declaredOperator: DeclaredSender = { seat: 'operator-02', team: 'floor', role: 'operator', declared: true };
  const declaredLead: DeclaredSender = { seat: 'orchestrator', team: 'floor', role: 'coordinator', declared: true };

  test('a declared plain seat reaches its own lead and no other seat', () => {
    expect(admitSend(declaredArchitect, floorLead, teams)).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(declaredArchitect, operatorPlace, teams)).toEqual({
      ok: false,
      why: refusalWhy('architect@floor', 'operator-3@floor'),
    });
  });

  test('the operator word decides the declared pair as the roster word does', () => {
    expect(admitSend(declaredOperator, operatorPlace, teams)).toEqual({ ok: true, rule: RULE.operators });
    expect(admitSend(declaredOperator, writer06, teams).ok).toBe(false);
  });

  test('a declared seat named as the file\'s lead is the place the file names', () => {
    expect(admitSend(declaredLead, writer06, teams)).toEqual({ ok: true, rule: RULE.briefs });
  });
});

describe('the rules are asked in order: the grant and the reply come last', () => {
  test('a rule answers before a grant naming the same pair', () => {
    expect(admitSend(writer06, floorLead, teams, { name: 'unused' })).toEqual({ ok: true, rule: RULE.seat });
    expect(admitSend(floorLead, cliLead, teams, { name: 'unused' })).toEqual({ ok: true, rule: RULE.leads });
  });

  test('a grant admits the pair no rule does, and the verdict names the grant', () => {
    expect(admitSend(writer06, erato, teams, { name: 'the floor writers' })).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (the floor writers)',
    });
    expect(admitSend(writer06, erato, teams).ok).toBe(false);
  });

  test('the owner is reached by the reply rule alone, and the owner reaches everyone', () => {
    expect(admitSend(writer06, 'owner', teams)).toEqual({
      ok: false,
      why: `writer-06@floor may not send to the owner: no rule admits it (${RULE_SUMMARY})`,
    });
    expect(admitSend(writer06, 'owner', teams, undefined, { projects: {}, reply: 'open-thread' })).toEqual({
      ok: true,
      rule: REPLY_RULE,
    });
    for (const target of [floorLead, operatorPlace, cliLead, radioLead]) {
      expect(admitSend('owner', target, teams)).toEqual({ ok: true, rule: RULE.owner });
    }
  });

  test('a reply admits the pair every rule left unadmitted, and its refusal lists the reply rule', () => {
    expect(admitSend(writer06, erato, teams, undefined, { projects: {}, reply: 'open-thread' })).toEqual({
      ok: true,
      rule: REPLY_RULE,
    });
    expect(admitSend(writer06, erato, teams, undefined, { projects: {}, reply: undefined })).toEqual({
      ok: false,
      why: refusalWhy('writer-06@floor', 'erato@floor', { projects: {} }),
    });
    expect(admitSend(writer06, erato, teams, undefined, { projects: {}, reply: 'open-thread' })).toEqual({
      ok: true,
      rule: REPLY_RULE,
    });
    // The summary names the reply rule only when the context carried it.
    expect(admitSend(writer06, erato, teams, undefined, { projects: {} })).toEqual({
      ok: false,
      why: refusalWhy('writer-06@floor', 'erato@floor', { projects: {} }),
    });
  });
});

describe('the context: the entity reach and the project summary', () => {
  test('an empty project registry changes no verdict and names the project rules in a refusal', () => {
    expect(admitSend(floorLead, cliLead, teams, undefined, { projects: {} })).toEqual({ ok: true, rule: RULE.leads });
    expect(admitSend(writer06, erato, teams, undefined, { projects: {} })).toEqual({
      ok: false,
      why: refusalWhy('writer-06@floor', 'erato@floor', { projects: {} }),
    });
  });

  test('the entity reach closes at any level of the asker\'s chain; only the project may reopen it', () => {
    expect(admitSend(floorLead, cliLead, teams, undefined, { projects: {} })).toEqual({ ok: true, rule: RULE.leads });
    for (const crossTeams of [{ entity: false }, { project: false }, { team: false }, { seat: false }]) {
      expect(admitSend(floorLead, cliLead, teams, undefined, { projects: {}, crossTeams }).ok).toBe(false);
    }
    expect(admitSend(floorLead, cliLead, teams, undefined, { projects: {}, crossTeams: { entity: false, project: true } })).toEqual({
      ok: true,
      rule: RULE.leads,
    });
    expect(admitSend(floorLead, cliLead, teams, undefined, { projects: {}, crossTeams: { entity: false, team: true } }).ok).toBe(false);
  });
});
