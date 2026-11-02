// The owner's approval card (src/client/approval-card.ts): at most three plain lines, and the
// owner's rule for every one — a title that is an action verb and its object, a question that
// names who wants it and why and ends `OK?`, and a scope that names the team and says whether a
// permission changes. A card never carries a raw key, a path, a flag, `once` or the credential
// store's name; the record (request id, arguments, root, HEAD, hashes) stays in the request file
// and the audit folder, and `team approvals details` prints it.
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

/** The first word of every title: an action verb, in plain words. */
const VERBS = ['Add', 'Approve', 'Change', 'Create', 'Forget', 'Import', 'Issue', 'Migrate', 'Revoke', 'Send', 'Set', 'Start', 'Stop', 'Turn', 'Use'];

/** The kinds whose answer changes more than the team's own running state. */
const CHANGING = new Set(['team-create', 'team-import', 'team-migrate', 'team-config', 'team-revoke-approval', 'team-general-grant']);

/** What no card line may ever carry, and the words for why it is refused. */
const BANNED: ReadonlyArray<readonly [RegExp | string, string]> = [
  [/\b(?:oa|tc|gr|am|gg)_[0-9a-f]{6,}\b/, 'a request id'],
  [/\b[0-9a-f]{12,}\b/, 'a hash or HEAD'],
  [/[{}[\]]/, 'a JSON shape'],
  [/":/, 'a JSON pair'],
  [/--/, 'a flag'],
  [/=/, 'a flag or assignment'],
  ['/', 'a path'],
  [/\b[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]/i, 'a raw key'],
  [/\bonce\b/i, 'the word once'],
  [/system-credential-store|keystore|keychain/i, "the credential store's name"],
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

/** The card's own faults, as sentences: a fourth line, an empty or long line, a banned word. */
function cardFaults(card: ApprovalCard): string[] {
  const lines = cardLines(card);
  const faults: string[] = [];
  if (lines.length > CARD_MAX_LINES) faults.push(`${lines.length} lines`);
  for (const line of lines) {
    if (line.trim() === '') faults.push('an empty line');
    if (line.length > 160) faults.push(`a line of ${line.length} characters: ${line}`);
    for (const [shape, what] of BANNED) if (typeof shape === 'string' ? line.includes(shape) : shape.test(line)) faults.push(`${what} on: ${line}`);
  }
  return faults;
}

describe('the approval card', () => {
  test('every owner action kind follows the rule, with the record only in the details', () => {
    for (const action of OWNER_ACTIONS) {
      const params = ownerParams(action);
      const card = ownerActionCard(params);
      expect(cardFaults(card), `${action}: ${cardLines(card).join(' | ')}`).toEqual([]);
      expect(VERBS, action).toContain(card.title.split(' ')[0]!);
      expect(card.question.endsWith('OK?'), `${action}: ${card.question}`).toBe(true);
      const scope = card.scope ?? '';
      if (action === 'development-mode') {
        // The one switch that is the machine's, not a team's: fixed words, no team.
        expect(scope).toBe('This Mac · all teams');
      } else {
        expect(scope.startsWith('Team demo · '), `${action}: ${scope}`).toBe(true);
        expect(scope === 'Team demo · no permission change', `${action}: ${scope}`).toBe(!CHANGING.has(action));
      }
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

  test('the card says who wants it, why, and what changes', () => {
    expect(ownerActionCard(ownerParams('team-add'))).toEqual({
      title: 'Add a seat',
      question: 'builder-5 wants to add a seat. OK?',
      scope: 'Team demo · no permission change',
    });
    expect(ownerActionCard(ownerParams('team-add', { reason: 'the release review' }))).toEqual({
      title: 'Add a seat',
      question: 'builder-5 wants to add a seat for the release review. OK?',
      scope: 'Team demo · no permission change',
    });
    expect(ownerActionCard(ownerParams('team-config'))).toEqual({
      title: "Change the team's record",
      question: "builder-5 wants to change the team's record. OK?",
      scope: 'Team demo · changes the team file',
    });
    // A pane caller's label is `session/pane`: the card names the pane, never the path-shaped label.
    expect(ownerActionCard(ownerParams('team-up', { requested_by: 'teamcli/pane-2' })).question).toBe('pane-2 wants to start the team. OK?');
    // Two askers an overlapping request folded together are both named, in plain words.
    expect(ownerActionCard(ownerParams('team-up', { requested_by: 'builder-5, iris', requesters: ['builder-5', 'iris'] })).question).toBe('builder-5 and iris want to start the team. OK?');
  });

  test('the development-mode card says the exact words the owner fixed', () => {
    const card = (mode: string) => ownerActionCard(ownerParams('development-mode', { words: { 'development-mode': ['set', mode] } }));
    expect(card('local-fast')).toEqual({
      title: 'Turn on fast local development',
      question: 'Stop asking Touch ID for routine team changes on this Mac. OK?',
      scope: 'This Mac · all teams',
    });
    expect(card('pr-per-change')).toEqual({
      title: 'Use a pull request for every change',
      question: 'Ask for a pull request for every team change on this Mac. OK?',
      scope: 'This Mac · all teams',
    });
    expect(card('off')).toEqual({
      title: 'Turn off fast local development',
      question: 'Ask Touch ID again for routine team changes on this Mac. OK?',
      scope: 'This Mac · all teams',
    });
    for (const mode of ['local-fast', 'pr-per-change', 'off']) {
      expect(cardFaults(card(mode)), mode).toEqual([]);
    }
  });

  test('a bundled request joins its kinds in one card and names what changes', () => {
    const card = ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'] }));
    expect(card).toEqual({
      title: 'Create a team, then start the team',
      question: 'builder-5 wants to create a team, then start the team. OK?',
      scope: 'Team demo · creates the team file',
    });
    expect(cardFaults(card), cardLines(card).join(' | ')).toEqual([]);
  });

  test('a team-create request and a grant render as cards too', () => {
    const params = teamParams();
    expect(teamCreateCard(params)).toEqual({
      title: 'Create a team',
      question: 'Create a team. OK?',
      scope: 'Team docs · creates the team file',
    });
    expect(teamCreateCard({ ...params, requested_by: 'builder-5', reason: 'the docs rewrite' })).toEqual({
      title: 'Create a team',
      question: 'builder-5 wants to create a team for the docs rewrite. OK?',
      scope: 'Team docs · creates the team file',
    });
    const details = teamCreateDetails({ request_id: `tc_${'cd'.repeat(12)}`, params, params_sha256: teamCreateHash(params) }).join('\n');
    expect(details).toContain('tc_cdcdcdcdcdcdcdcdcdcdcdcd');
    expect(details).toContain('/synthetic/docs');
    expect(details).toContain(HEAD);

    // A grant's question is the grant's own signing prompt — who, on which team, doing what,
    // for how long — and the card adds the answer's `OK?`. The prompt may name operations as
    // the grant does (`start/stop`), so it is not held to the card templates' no-slash rule.
    const grant = grantCard({ prompt: 'Allow Grok Bot on team floor: send to orchestrator. Expires 26 Jan 2027 08:22 (UTC).', master: false });
    expect(grant).toEqual({
      title: 'Issue a grant',
      question: 'Allow Grok Bot on team floor: send to orchestrator. Expires 26 Jan 2027 08:22 (UTC). OK?',
    });
    expect(grantCard({ prompt: 'x', master: true }).title).toBe('Issue a master grant');
    expect(grantCard({ prompt: 'x', up: true }).title).toBe('Issue a team grant');
    expect(grantCard({ prompt: 'x' })).toEqual({ title: 'Issue a grant', question: 'x. OK?' });
  });

  test('a reason is one short clause: folded, cut at a word, never a second line', () => {
    const long = 'the migration of every team record into the registry before the release candidate ships to the floor';
    const card = ownerActionCard(ownerParams('team-migrate', { reason: long }));
    expect(card.question).toBe('builder-5 wants to migrate the team for the migration of every team record into the registry before… OK?');
    // The long reason is one cut clause, not a paragraph: the line stays short.
    expect(card.question.length).toBeLessThan(140);
    expect(card.question).toContain('…');
    // Whitespace, newlines and an empty or blank reason never make a second line or a stray space.
    expect(ownerActionCard(ownerParams('team-up', { reason: '  the\n\nlaunch  ' })).question).toBe('builder-5 wants to start the team for the launch. OK?');
    expect(ownerActionCard(ownerParams('team-up', { reason: '   ' })).question).toBe('builder-5 wants to start the team. OK?');
    expect(cardFaults(card), cardPrompt(card)).toEqual([]);
  });

  test('every card kind is covered by this file', () => {
    // The Record type makes a new CARD_KINDS entry a compile error until it has a card here.
    const cards: Record<(typeof CARD_KINDS)[number], ApprovalCard> = {
      'team-create': teamCreateCard(teamParams()),
      grant: grantCard({ prompt: 'Allow Grok Bot on team floor: send to orchestrator.' }),
    };
    for (const kind of CARD_KINDS) {
      expect(cardFaults(cards[kind]), `${kind}: ${cardPrompt(cards[kind])}`).toEqual([]);
      expect(VERBS).toContain(cards[kind].title.split(' ')[0]!);
      expect(cards[kind].question.endsWith('OK?')).toBe(true);
    }
  });

  test('the signing prompt is one line inside the prompt budget', () => {
    const cards: ApprovalCard[] = [
      ...OWNER_ACTIONS.map((action) => ownerActionCard(ownerParams(action, { reason: 'the release review' }))),
      ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'], reason: 'the release review' })),
      teamCreateCard({ ...teamParams(), requested_by: 'builder-5', reason: 'the release review' }),
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
    expect(answerCard(card, 'once')).toEqual(card);
    expect(answerCard(card, 'always').scope).toBe('Team demo · always allows this, until revoked');
    expect(answerCard(card, 'deny').scope).toBe('Team demo · refused, nothing changes');
    const bundled = ownerActionCard(ownerParams('team-create', { actions: ['team-create', 'team-up'] }));
    expect(answerCard(bundled, 'always').scope).toBe('Team demo · always allows this, until revoked');
    expect(answerCard(bundled, 'deny').scope).toBe('Team demo · refused, nothing changes');
    for (const answered of [answerCard(card, 'always'), answerCard(card, 'deny'), answerCard(bundled, 'always')]) {
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
