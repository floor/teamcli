// Admission follows a seat's place in the chain, never a role's name.
//
// The rule "an assistant seat to its entity's coordinator" admits the seat a team file declares
// as the entity's first assistant — its place in the chain — and never a seat because of the
// word its role happens to carry: a role is each team's own word, in any language. The
// declaration is the one the file writes, projected onto the registry's roster line as the
// `assistant` capability exactly as `leads` carries a team's lead (and, as `orchestrator` sits
// on the record, as the team's own `assistant` slot naming the seat).
//
// The registry's identity, read through admission: a side is judged by (team id, seat) and
// never by the pane — a re-pointed pane moves no verdict, and a seat of the same name in
// another team is another agent — and a record confers no right: the rule decides, and a pair
// judges word for word the same as records or as bare seats.

import { describe, expect, test } from 'bun:test';
import type { Agent } from '../src/registry/agents.ts';
import { admitSend, RULE_SUMMARY, type AdmitTeam, type DeclaredSender, type SendSeat } from '../src/send/admit.ts';

// One agent record, the shape a launch writes: the fixture form of test/send-admit.test.ts.
function agent(id: string, seat: string, team: string, role = 'builder', pane: string | null = 'w1:p1'): Agent {
  return {
    id,
    name: `${seat} of ${team}`,
    signing: { model: 'Claude Sonnet', version: '5.5', role },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy"',
    reach: { team, seat, session: team, pane, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    provenance: { registered_by: 'team up', registered_at: '2026-10-17T10:00:00Z', updated_at: '2026-10-17T10:00:00Z' },
  };
}

/** One roster line, with the capabilities a file's declarations project onto it: `leads` for
 *  the team's lead, and `assistant` for the entity's first assistant. */
type Line = AdmitTeam['roster'][number] & { assistant?: boolean };

/** A team record: the roster above, and the file's assistant slot beside `orchestrator`. */
type Team = Omit<AdmitTeam, 'roster'> & { assistant?: string; roster: Line[] };

function line(agentId: string, seat: string, role: string, caps: { leads?: boolean; assistant?: boolean } = {}): Line {
  return { agent: agentId, seat, role, ...caps };
}

const ORCH = 'agt_000000000001';
const ASSISTANT = 'agt_000000000002';
const BUILDER = 'agt_000000000003';
const ORCH_RADIO = 'agt_000000000004';
const ORCH_LABS = 'agt_000000000005';
const ENVOY = 'agt_000000000006';
const SHOP_ASSISTANT = 'agt_000000000007';

const orch = agent(ORCH, 'orchestrator', 'floor', 'orchestrator');
const assistant = agent(ASSISTANT, 'assistant', 'labs', 'assistant');
const orchRadio = agent(ORCH_RADIO, 'orchestrator', 'radio', 'orchestrator');

const ENTITY = 'floor';

/** The entity's main team: its coordinator is the lead seat by the capability. */
const main: Team = {
  project: ENTITY,
  entity: ENTITY,
  orchestrator: 'orchestrator',
  roster: [
    line(ORCH, 'orchestrator', 'orchestrator', { leads: true }),
    line('', 'builder-1', 'builder'),
  ],
};

/** A sub-team of the entity with a seat whose role word is `assistant` — and no declaration. */
const labsUndeclared: Team = {
  project: 'labs',
  entity: ENTITY,
  orchestrator: 'orchestrator',
  roster: [
    line(ORCH_LABS, 'orchestrator', 'orchestrator', { leads: true }),
    line(ASSISTANT, 'assistant', 'assistant'),
    line(BUILDER, 'builder-1', 'builder'),
  ],
};

/** The same sub-team with the file's declaration: the capability on the roster line, the slot
 *  naming the seat on the record — and a role word that is not `assistant` at all. */
const labsDeclared: Team = {
  project: 'labs',
  entity: ENTITY,
  orchestrator: 'orchestrator',
  assistant: 'assistant',
  roster: [
    line(ORCH_LABS, 'orchestrator', 'orchestrator', { leads: true }),
    line(ASSISTANT, 'assistant', 'deputy', { assistant: true }),
    line(BUILDER, 'builder-1', 'builder'),
  ],
};

/** Another sub-team of the entity, with a seat of the same name and no declaration there. */
const shop: Team = {
  project: 'shop',
  entity: ENTITY,
  orchestrator: 'orchestrator',
  roster: [
    line('', 'orchestrator', 'orchestrator', { leads: true }),
    line(SHOP_ASSISTANT, 'assistant', 'assistant'),
  ],
};

/** Another entity, with a coordinator of its own. */
const radio: Team = {
  project: 'radio',
  entity: 'radio',
  orchestrator: 'orchestrator',
  roster: [line(ORCH_RADIO, 'orchestrator', 'orchestrator', { leads: true })],
};

/** The registry every scene judges over: the four teams, one sub-team under test. */
function registry(labs: Team): Record<string, Team> {
  return { [ENTITY]: main, labs, shop, radio };
}

const ADMITTED = { ok: true, rule: "an assistant seat to its entity's coordinator" } as const;

describe("the entity's first assistant is a place in the chain, never a role word", () => {
  test('the role word alone admits nothing', () => {
    const teams = registry(labsUndeclared);
    const judged = admitSend(assistant, orch, teams);
    expect(judged).toEqual({
      ok: false,
      why: `assistant@labs may not send to orchestrator@floor: no rule admits it (${RULE_SUMMARY})`,
    });
  });

  test("the record's own signing role is a word too: a seat on no roster line is refused", () => {
    // The record's signing role reads 'assistant', but no line of the entity declares this seat:
    // a signing role is a word the record carries, not a place in the chain.
    const envoy = agent(ENVOY, 'envoy', 'labs', 'assistant');
    const teams = registry(labsUndeclared);
    expect(admitSend(envoy, orch, teams).ok).toBe(false);
  });

  test('the declared first assistant is admitted, whatever its role word', () => {
    const teams = registry(labsDeclared);
    expect(admitSend(assistant, orch, teams)).toEqual(ADMITTED);
  });

  test('the declared first assistant with no record yet is admitted the same', () => {
    // The bootstrap loop's sender: herdr placed a seat the live file declares, and no record
    // exists for it. Its place in the chain decides, exactly as the record's does.
    const teams = registry(labsDeclared);
    const declared: DeclaredSender = { seat: 'assistant', team: 'labs', role: 'assistant', declared: true };
    expect(admitSend(declared, orch, teams)).toEqual(ADMITTED);
  });

  test('the word moves, the verdict does not', () => {
    // The declared seat under another role word: still the declared seat.
    const renamed = agent(ASSISTANT, 'assistant', 'labs', 'aide');
    expect(admitSend(renamed, orch, registry(labsDeclared))).toEqual(ADMITTED);
    // The undeclared seat under another role word: still undeclared, still refused.
    const sidelined = agent(ASSISTANT, 'assistant', 'labs', 'aide');
    expect(admitSend(sidelined, orch, registry(labsUndeclared)).ok).toBe(false);
  });

  test('a role word from another language is a word like any other', () => {
    // A team filing its assistant under its own language's word — 'adjoint', a French team's —
    // holds the slot all the same: nothing reads the word.
    const elsewhere = agent(ASSISTANT, 'assistant', 'labs', 'adjoint');
    expect(admitSend(elsewhere, orch, registry(labsDeclared))).toEqual(ADMITTED);
    expect(admitSend(elsewhere, orch, registry(labsUndeclared)).ok).toBe(false);
  });
});

describe("the registry's identity, read through admission", () => {
  test('a side is judged by (team id, seat), never by the pane', () => {
    const teams = registry(labsDeclared);
    // The same record, re-pointed to another pane — and one between runs, with no pane at all:
    // the verdict is word for word the same.
    const repainted = agent(ASSISTANT, 'assistant', 'labs', 'deputy', 'w9:p9');
    expect(admitSend(repainted, orch, teams)).toEqual(admitSend(assistant, orch, teams));
    const paneless = agent(ASSISTANT, 'assistant', 'labs', 'deputy', null);
    expect(admitSend(paneless, orch, teams)).toEqual(ADMITTED);
  });

  test('a seat of the same name in another team is another agent: undeclared there, refused there', () => {
    const shopAssistant = agent(SHOP_ASSISTANT, 'assistant', 'shop', 'assistant');
    expect(admitSend(shopAssistant, orch, registry(labsDeclared)).ok).toBe(false);
    // The declaration of the labs seat never travels with the name.
    expect(admitSend(shopAssistant, orch, registry(labsUndeclared)).ok).toBe(false);
  });

  test('a record confers no right: the same pair judges the same with records as with bare seats', () => {
    const teams = registry(labsUndeclared);
    const asRecords = admitSend(assistant, orch, teams);
    const caller: SendSeat = { seat: 'assistant', team: 'labs', role: 'assistant' };
    const target: SendSeat = { seat: 'orchestrator', team: 'floor', role: 'orchestrator' };
    expect(admitSend(caller, target, teams)).toEqual(asRecords);
    // And the admitting side: the declared pair judges the same as records or as bare seats.
    const declaredTeams = registry(labsDeclared);
    const bareCaller: SendSeat = { seat: 'assistant', team: 'labs', role: 'deputy' };
    expect(admitSend(bareCaller, target, declaredTeams)).toEqual(admitSend(assistant, orch, declaredTeams));
  });
});

describe('the declared assistant reaches the coordinator, and nothing else', () => {
  test("the main team's ordinary seat is not its coordinator", () => {
    const teams = registry(labsDeclared);
    const mainBuilder = { seat: 'builder-1', team: ENTITY, role: 'builder' } as const;
    expect(admitSend(assistant, mainBuilder, teams).ok).toBe(false);
  });

  test("another entity's coordinator is not this entity's", () => {
    const teams = registry(labsDeclared);
    expect(admitSend(assistant, orchRadio, teams).ok).toBe(false);
  });
});
