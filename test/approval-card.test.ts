// The owner's approval card (src/client/approval-card.ts): at most three plain lines — a title, the
// question, and at most one scope line — every word from the message catalog. The record itself
// (request id, arguments, launch command, root, HEAD, hashes) is never on the card: it stays in
// the request file and the audit folder, and `team approvals details` prints it.
//
// The kinds are read from the code, not from a list here: every OWNER_ACTIONS entry and every
// CARD_KINDS entry is rendered, so a kind added without a catalog template fails this file.

import { describe, expect, test } from 'bun:test';
import {
  CARD_KINDS, CARD_MAX_LINES, answerCard, cardLines, cardPrompt, grantCard, ownerActionCard, ownerActionDetails,
  teamCreateCard, teamCreateDetails, type ApprovalCard,
} from '../src/client/approval-card.ts';
import { actionArgsHash, OWNER_ACTIONS, type OwnerAction, type OwnerActionParams } from '../src/client/owner-action.ts';
import { GRANT_PROMPT_MAX } from '../src/client/grant-prompt.ts';
import { teamCreateHash, type TeamCreateParams } from '../src/client/team-create.ts';

const HEAD = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const REQUEST_ID = `oa_${'ab'.repeat(12)}`;
const ROOT = '/synthetic/repo';
const WORDS = ['set', 'seats.lead', '{"role":"builder","cli":"fake"}'];

/** What the card must not carry: ids, hashes, paths, flags or JSON. */
const RECORD_SHAPES = [
  /\b(?:oa|tc|gr|am|gg)_[0-9a-f]{6,}\b/,
  /\b[0-9a-f]{12,}\b/,
  /[{}[\]]/,
  /":/,
  /--/,
  /=/,
  /\//,
];

function ownerParams(action: OwnerAction, over: Partial<OwnerActionParams> = {}): OwnerActionParams {
  return {
    kind: 'owner-action',
    actions: [action],
    root: ROOT,
    team: 'demo',
    head: HEAD,
    args: { [action]: actionArgsHash(action, WORDS) },
    words: { [action]: WORDS },
    requested_by: 'builder-5',
    ...over,
  };
}

function teamParams(): TeamCreateParams {
  return { kind: 'team-create', root: '/synthetic/docs', team: 'docs', head: HEAD };
}

/** The card's own faults, as sentences: a fourth line, an empty or long line, a record shape. */
function cardFaults(card: ApprovalCard): string[] {
  const lines = cardLines(card);
  const faults: string[] = [];
  if (lines.length > CARD_MAX_LINES) faults.push(`${lines.length} lines`);
  for (const line of lines) {
    if (line.trim() === '') faults.push('an empty line');
    if (line.length > 160) faults.push(`a line of ${line.length} characters: ${line}`);
    for (const shape of RECORD_SHAPES) if (shape.test(line)) faults.push(`a record shape ${String(shape)} on: ${line}`);
  }
  return faults;
}

describe('the approval card', () => {
  test('every owner action kind renders three plain lines, with the record only in the details', () => {
    for (const action of OWNER_ACTIONS) {
      const params = ownerParams(action);
      const card = ownerActionCard(params);
      expect(cardFaults(card), `${action}: ${cardLines(card).join(' | ')}`).toEqual([]);
      expect(card.title.startsWith('TeamCLI: ')).toBe(true);
      expect(card.question.endsWith('?')).toBe(true);
      expect(card.scope).toBe('One-time change. builder-5 asked.');
      // The same record, off the card: `team approvals details` and the owner page's fold print
      // it, the card never does.
      const details = ownerActionDetails({ request_id: REQUEST_ID, params, params_sha256: HASH }).join('\n');
      expect(details).toContain(REQUEST_ID);
      expect(details).toContain(ROOT);
      expect(details).toContain(HEAD);
      expect(details).toContain(WORDS.join(' '));
      expect(details).toContain(HASH);
      for (const line of cardLines(card)) {
        for (const part of [REQUEST_ID, ROOT, HEAD, HASH, WORDS.join(' ')]) expect(line).not.toContain(part);
      }
    }
  });

  test('the card names the kind, asks the question and says who asked', () => {
    expect(ownerActionCard(ownerParams('team-config'))).toEqual({
      title: "TeamCLI: change the team's record",
      question: 'Change the record of team "demo"?',
      scope: 'One-time change. builder-5 asked.',
    });
    expect(ownerActionCard(ownerParams('team-add'))).toEqual({
      title: 'TeamCLI: add a seat',
      question: 'Add a seat to team "demo"?',
      scope: 'One-time change. builder-5 asked.',
    });
  });

  test('a bundled request joins its kinds and names the asker once', () => {
    const card = ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'] }));
    expect(card).toEqual({
      title: 'TeamCLI: create a team, then start the team',
      question: 'Allow builder-5 to create a team, then start the team for team "demo"?',
      scope: 'One-time change.',
    });
    expect(cardFaults(card), cardLines(card).join(' | ')).toEqual([]);
  });

  test('a team-create request and a grant render as cards too', () => {
    const params = teamParams();
    const card = teamCreateCard(params);
    expect(card).toEqual({
      title: 'TeamCLI: create a team',
      question: 'Create team "docs"?',
      scope: 'One-time change.',
    });
    expect(cardFaults(card)).toEqual([]);
    const details = teamCreateDetails({ request_id: `tc_${'cd'.repeat(12)}`, params, params_sha256: teamCreateHash(params) }).join('\n');
    expect(details).toContain('tc_cdcdcdcdcdcdcdcdcdcdcdcd');
    expect(details).toContain('/synthetic/docs');
    expect(details).toContain(HEAD);

    const grant = grantCard({ prompt: 'Allow Grok Bot on team floor: send to orchestrator. Expires 26 Jan 2027 08:22 (UTC).', master: false });
    expect(grant).toEqual({ title: 'TeamCLI: grant', question: 'Allow Grok Bot on team floor: send to orchestrator. Expires 26 Jan 2027 08:22 (UTC).' });
    expect(cardFaults(grant)).toEqual([]);
    expect(grantCard({ prompt: 'x', master: true }).title).toBe('TeamCLI: master grant');
    expect(grantCard({ prompt: 'x', up: true }).title).toBe('TeamCLI: team grant');
  });

  test('every card kind is covered by this file', () => {
    // The Record type makes a new CARD_KINDS entry a compile error until it has a card here.
    const cards: Record<(typeof CARD_KINDS)[number], ApprovalCard> = {
      'team-create': teamCreateCard(teamParams()),
      grant: grantCard({ prompt: 'Allow Grok Bot on team floor: send to orchestrator.' }),
    };
    for (const kind of CARD_KINDS) {
      expect(cardFaults(cards[kind]), `${kind}: ${cardPrompt(cards[kind])}`).toEqual([]);
      expect(cards[kind].title.startsWith('TeamCLI: ')).toBe(true);
      // The request kinds ask a question; a grant's question is the catalog prompt the owner
      // signs, which ends `Expires ….` and stays exactly as the signing prompt reads it.
      expect(/[.?]$/.test(cards[kind].question)).toBe(true);
    }
  });

  test('the signing prompt is one line inside the prompt budget', () => {
    const cards: ApprovalCard[] = [
      ...OWNER_ACTIONS.map((action) => ownerActionCard(ownerParams(action))),
      ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'] })),
      teamCreateCard(teamParams()),
      grantCard({ prompt: 'Allow Grok Bot on team floor: send to orchestrator. Expires 26 Jan 2027 08:22 (UTC).', master: false }),
    ];
    for (const card of cards) {
      const prompt = cardPrompt(card);
      expect(prompt, prompt).not.toContain('\n');
      expect(prompt.length, prompt).toBeLessThanOrEqual(GRANT_PROMPT_MAX);
    }
  });

  test('the signing prompt names the answer: once, always until revoked, or deny', () => {
    const card = ownerActionCard(ownerParams('team-up'));
    expect(answerCard(card, 'once', 'seat:iris')).toEqual(card);
    expect(answerCard(card, 'always', 'seat:iris').scope).toBe('Always, until revoked. seat:iris asked.');
    expect(answerCard(card, 'deny', 'seat:iris').scope).toBe('Deny. seat:iris asked.');
    const bundled = ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'] }));
    expect(answerCard(bundled, 'always').scope).toBe('Always, until revoked.');
    expect(answerCard(bundled, 'deny').scope).toBe('Deny.');
    for (const answered of [answerCard(card, 'always', 'seat:iris'), answerCard(card, 'deny', 'seat:iris'), answerCard(bundled, 'always')]) {
      expect(cardFaults(answered), cardPrompt(answered)).toEqual([]);
    }
  });

  test('the details carry the timestamp and the hash when the record has them', () => {
    const details = ownerActionDetails({ request_id: REQUEST_ID, params: ownerParams('team-up'), params_sha256: HASH, created: '2026-11-01T00:00:00.000Z', expires_at: null });
    const text = details.join('\n');
    expect(text).toContain('2026-11-01T00:00:00.000Z');
    expect(text).toContain('never');
    expect(text).toContain(HASH);
    expect(text).toContain('team-up: set seats.lead {"role":"builder","cli":"fake"}');
  });
});
