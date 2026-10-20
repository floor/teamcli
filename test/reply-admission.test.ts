// The reply rule (`reply-on-open-thread`, draft 3 §7), judged where every other send rule is
// judged: `admitSend`. A reply is a send from the record's addressee back to its sender, so the
// pair keeps every rule it had; the reply rule is asked last, admits a pair no other rule pairs,
// and names itself in the record, the refusal and the docs alike.
//
// Pure decisions over the roster: no file, no clock, no herdr.
import { describe, expect, test } from 'bun:test';
import { admitSend, DECLARED_SEAT_RULE, REPLY_RULE, RULE_SUMMARY, type AdmitContext, type AdmitTeams } from '../src/send/admit.ts';

const TEAM = '1a2b3c4d5e6f';
/** Another entity's team: no send rule pairs it with `TEAM`, so the reply rule is the only rule
 *  that can admit the pair. */
const ELSEWHERE = '9f8e7d6c5b4a';

function teams(): AdmitTeams {
  return {
    [TEAM]: {
      project: 'acme',
      entity: null,
      orchestrator: 'lead',
      operator: null,
      session: 'acme',
      roster: [
        { agent: '', seat: 'lead', role: 'coordinator', leads: true },
        { agent: '', seat: 'worker', role: 'implementer' },
        { agent: '', seat: 'helper', role: 'implementer' },
      ],
    },
    [ELSEWHERE]: {
      project: 'elsewhere',
      entity: 'elsewhere',
      orchestrator: 'lead',
      operator: null,
      session: 'elsewhere',
      roster: [
        { agent: '', seat: 'lead', role: 'coordinator', leads: true },
        { agent: '', seat: 'stranger', role: 'implementer' },
      ],
    },
  };
}

const lead = { seat: 'lead', team: TEAM };
const worker = { seat: 'worker', team: TEAM };
const helper = { seat: 'helper', team: TEAM };
const stranger = { seat: 'stranger', team: ELSEWHERE };

function replying(): AdmitContext {
  return { projects: {}, crossTeams: {}, reply: 'open-thread' };
}

describe('the reply rule admits the pair no other rule pairs', () => {
  test('without the context the pair is refused, and the refusal names the send rules only', () => {
    const verdict = admitSend(helper, stranger, teams(), undefined, { projects: {}, crossTeams: {} });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('no rule admits it');
    expect(verdict.why).toContain(RULE_SUMMARY);
    expect(verdict.why).not.toContain(REPLY_RULE);
  });

  test('with the context the same pair is admitted by the reply rule', () => {
    expect(admitSend(helper, worker, teams(), undefined, replying())).toEqual({ ok: true, rule: REPLY_RULE });
    expect(admitSend(worker, helper, teams(), undefined, replying())).toEqual({ ok: true, rule: REPLY_RULE });
    expect(admitSend(helper, stranger, teams(), undefined, replying())).toEqual({ ok: true, rule: REPLY_RULE });
  });

  test('a send with no context at all keeps the send-rule summary', () => {
    const verdict = admitSend(stranger, helper, teams());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).not.toContain(REPLY_RULE);
  });

  test('a seat of one team admits its fellow declared seats without the reply context', () => {
    expect(admitSend(helper, worker, teams())).toEqual({ ok: true, rule: DECLARED_SEAT_RULE });
  });
});

describe('a rule that already admits the pair keeps its own name', () => {
  test('a lead to its seat stays the orchestrator rule, and a seat to its lead the seat rule', () => {
    expect(admitSend(lead, worker, teams(), undefined, replying())).toEqual({
      ok: true,
      rule: 'an orchestrator or operator to a seat of its own team',
    });
    expect(admitSend(worker, lead, teams(), undefined, replying())).toEqual({
      ok: true,
      rule: "a seat to its own team's orchestrator",
    });
  });

  test('an owner-signed grant keeps its own name', () => {
    expect(admitSend(helper, worker, teams(), { name: 'pair' }, replying())).toEqual({
      ok: true,
      rule: 'an owner-signed grant naming send (pair)',
    });
  });
});

describe('the owner as a receiver', () => {
  test('a seat may not send to the owner, and the refusal names the replies it answers', () => {
    const verdict = admitSend(worker, 'owner', teams());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('may not send to the owner');
    expect(verdict.why).not.toContain(REPLY_RULE);
  });

  test('the reply rule admits the owner as receiver when the caller hands it in', () => {
    expect(admitSend(worker, 'owner', teams(), undefined, replying())).toEqual({ ok: true, rule: REPLY_RULE });
  });

  test('the owner as sender is admitted by the owner rule, ahead of every other', () => {
    expect(admitSend('owner', worker, teams())).toEqual({ ok: true, rule: 'the owner' });
    expect(admitSend('owner', 'owner', teams(), undefined, replying())).toEqual({ ok: true, rule: 'the owner' });
  });
});
