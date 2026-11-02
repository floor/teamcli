// The owner's card for one request, shown where she answers it: the Touch ID prompt at signing
// (its dialog title is the key helper's name, so the card says what it is) and the owner page.
// A card is at most three lines — a title in plain words, the question in one sentence, and at
// most one scope line — and every word comes from the message catalog (`grant-messages.ts`),
// keyed by a stable id per request kind.
//
// The record is never on the card: the request id, the arguments (a seat record, a launch
// command, a diff), the root, HEAD and the parameter hash stay in the request file and the audit
// folder, and the details functions below render them for `team approvals details` and the owner
// page's folded details. Nothing here decides what is signed or what is admitted.

import { msg, type MessageId } from './grant-messages.ts';
import type { OwnerActionParams } from './owner-action.ts';
import type { TeamCreateParams } from './team-create.ts';

/** A card never carries more than this many lines. */
export const CARD_MAX_LINES = 3;

/** The request kinds that are not owner actions: a team-create request and a grant request. */
export const CARD_KINDS = ['team-create', 'grant'] as const;

export type ApprovalCard = {
  /** The kind in plain words, e.g. `TeamCLI: change the team's record`. */
  title: string;
  /** What the owner is asked, in one sentence: a request ends in `?`, and a grant's question is
   *  the catalog prompt the owner signs, which ends `Expires ….`, as the signing prompt reads it. */
  question: string;
  /** Who asked and what the answer covers, when the kind has that to say. */
  scope?: string;
};

/** The card's lines, top to bottom: at most CARD_MAX_LINES. */
export function cardLines(card: ApprovalCard): string[] {
  return [card.title, card.question, ...(card.scope === undefined ? [] : [card.scope])];
}

/** The card as one line, for a prompt that shows one (the signing reason). */
export function cardPrompt(card: ApprovalCard): string {
  return cardLines(card).join(' — ');
}

/** The three answers, as the signing prompt names the one being signed. */
export type AnswerChoice = 'once' | 'always' | 'deny';

/**
 * The question as recorded, with the scope line naming the answer being signed: `always` is a rule
 * until revoked, not a one-time change. `asker` is passed only when the question does not already
 * name them (a bundled card does, in its question).
 */
export function answerCard(card: ApprovalCard, choice: AnswerChoice, asker?: string): ApprovalCard {
  if (choice === 'once') return card;
  const key = choice === 'always' ? 'card.scope.always' : 'card.scope.deny';
  const asked = `${key}.asked` as MessageId;
  return { ...card, scope: asker === undefined ? msg(key) : msg(asked, { asker }) };
}

/** `a, then b` — the order the request runs its kinds in. */
function inOrder(actions: readonly string[]): string {
  if (actions.length <= 1) return actions[0] ?? '';
  return `${actions.slice(0, -1).join(', ')}, then ${actions[actions.length - 1]!}`;
}

/** The value an action's question names, when it has one: a development-mode request names the
 *  mode it sets, read from the request's own bound words (`set <mode>`). */
function asked(verb: readonly string[] | undefined): string | undefined {
  return verb?.[0] === 'set' ? verb[1] : undefined;
}

/** The title line: the action's own phrase, or the name of a switch whose title is not a phrase. */
function titleOf(action: string, what: string): string {
  if (action === 'development-mode') return msg('card.title.development-mode');
  return msg('card.title', { action: what });
}

/** The question line: one catalog sentence per kind, naming what the request binds. */
function questionOf(action: string, team: string, words: readonly string[] | undefined): string {
  if (action === 'development-mode') {
    const mode = asked(words);
    // A record that carries no bound words says only that there is a request to answer.
    return mode === undefined ? msg('card.question.approval') : msg('card.question.development-mode', { mode });
  }
  return msg(`card.question.${action}` as MessageId, { team });
}

/** One owner-action request, as the owner reads it before answering. */
export function ownerActionCard(params: Pick<OwnerActionParams, 'actions' | 'team' | 'requested_by' | 'words'>): ApprovalCard {
  const words = params.actions.map((action) => msg(`card.what.${action}` as MessageId));
  if (params.actions.length === 1) {
    const action = params.actions[0]!;
    return {
      title: titleOf(action, words[0]!),
      question: questionOf(action, params.team, params.words?.[action]),
      scope: msg('card.scope.asked', { asker: params.requested_by }),
    };
  }
  return {
    title: msg('card.title.several', { actions: inOrder(words) }),
    question: msg('card.question.several', { asker: params.requested_by, actions: inOrder(words), team: params.team }),
    scope: msg('card.scope.once'),
  };
}

/** A team-create request: the repository is a record detail, so the card names only the team. */
export function teamCreateCard(params: Pick<TeamCreateParams, 'team'>): ApprovalCard {
  return {
    title: msg('card.title', { action: msg('card.what.team-create') }),
    question: msg('card.question.team-create', { team: params.team }),
    scope: msg('card.scope.once'),
  };
}

/** A grant request: its prompt is already one catalog line, and it stays the question as it is. */
export function grantCard(input: { prompt: string; master?: boolean; up?: boolean }): ApprovalCard {
  const title = input.master === true ? msg('card.grant.title.master') : input.up === true ? msg('card.grant.title.team') : msg('card.grant.title.grant');
  return { title, question: input.prompt };
}

/** The fields of a record the details render; the page has some, `team approvals details` all. */
export type OwnerActionRecordish = {
  request_id: string;
  params: OwnerActionParams;
  params_sha256?: string;
  created?: string;
  expires_at?: string | null;
};

export type TeamCreateRecordish = {
  request_id: string;
  params: TeamCreateParams;
  params_sha256?: string;
  created?: string;
  expires_at?: string | null;
};

function recordLines(id: string, team: string, root: string, head: string | null, paramsSha256: string | undefined, created: string | undefined, expires: string | null | undefined): string[] {
  const lines = [
    msg('card.details.request', { id }),
    msg('card.details.team', { team }),
    msg('card.details.root', { root }),
    msg('card.details.head', { head: head ?? msg('card.details.no_head') }),
  ];
  if (created !== undefined) lines.push(msg('card.details.created', { at: created }));
  if (expires !== undefined) lines.push(msg('card.details.expires', { at: expires ?? msg('card.details.never') }));
  if (paramsSha256 !== undefined) lines.push(msg('card.details.hash', { hash: paramsSha256 }));
  return lines;
}

/**
 * One owner-action request's full record, off the card: who asked, the repository and HEAD it is
 * bound to, every action's bound arguments (the launch command or the value a record change
 * carries), and the parameter hash when the reader has it.
 */
export function ownerActionDetails(record: OwnerActionRecordish): string[] {
  const p = record.params;
  const lines = [msg('card.details.request', { id: record.request_id }), msg('card.details.asked_by', { asker: p.requested_by }), msg('card.details.team', { team: p.team }), msg('card.details.root', { root: p.root }), msg('card.details.head', { head: p.head ?? msg('card.details.no_head') })];
  if (record.created !== undefined) lines.push(msg('card.details.created', { at: record.created }));
  if (record.expires_at !== undefined) lines.push(msg('card.details.expires', { at: record.expires_at ?? msg('card.details.never') }));
  for (const action of p.actions) {
    const words = p.words?.[action] ?? [];
    lines.push(words.length > 0 ? msg('card.details.action', { action, words: words.join(' ') }) : msg('card.details.action_none', { action }));
  }
  if (record.params_sha256 !== undefined) lines.push(msg('card.details.hash', { hash: record.params_sha256 }));
  return lines;
}

/** One team-create request's full record, off the card. */
export function teamCreateDetails(record: TeamCreateRecordish): string[] {
  const p = record.params;
  return recordLines(record.request_id, p.team, p.root, p.head, record.params_sha256, record.created, record.expires_at);
}
