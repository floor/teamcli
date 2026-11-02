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

/** The reason is one short clause: the signing prompt is truncated past about this much. */
export const REASON_MAX = 60;

/** The request kinds that are not owner actions: a team-create request and a grant request. */
export const CARD_KINDS = ['team-create', 'grant'] as const;

/**
 * One card, as the owner reads it: at most three plain lines, with no extra context needed.
 *
 * - The title is an action verb and its object, in plain words: `Add a seat`.
 * - The question is who wants it and why, ending `OK?`:
 *   `The orchestrator wants to restart two writers for the release. OK?`. A request that carries
 *   no reason asks `The orchestrator wants to restart two writers. OK?`.
 * - The scope names the team and either `no permission change` or what changes:
 *   `Team demo · no permission change`.
 *
 * The card never carries a raw key, a path, a flag, `once`, or the credential store's name.
 */
export type ApprovalCard = {
  title: string;
  question: string;
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
 * The question with the scope line naming the answer being signed: `always` is a rule until
 * revoked, and a denial changes nothing. The scope's first part — the team and what it covers —
 * stays, so the answer line still names the team.
 */
export function answerCard(card: ApprovalCard, choice: AnswerChoice): ApprovalCard {
  if (choice === 'once') return card;
  const base = scopeBase(card.scope);
  const key = choice === 'always' ? 'card.scope.always' : 'card.scope.deny';
  return { ...card, scope: base === '' ? msg(key) : msg(`${key}.base` as MessageId, { base }) };
}

/** `a, then b` — the order the request runs its kinds in. */
function inOrder(actions: readonly string[]): string {
  if (actions.length <= 1) return actions[0] ?? '';
  return `${actions.slice(0, -1).join(', ')}, then ${actions[actions.length - 1]!}`;
}

/** The scope's first part: the team (or the machine) and nothing after it. */
function scopeBase(scope: string | undefined): string {
  if (scope === undefined) return '';
  const at = scope.indexOf(' · ');
  return at < 0 ? scope : scope.slice(0, at);
}

/** `add a seat` → `Add a seat`: the title starts a sentence with its verb. */
function sentence(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1);
}

/**
 * The asker in plain words: the seat's own name, never a pane, a session or a path. A pane caller's
 * log label is `session/pane`, and an owner label is `owner`.
 */
function plainAsker(label: string): string {
  const afterSlash = label.split('/').pop() ?? label;
  return (afterSlash.split(':').pop() ?? afterSlash).trim();
}

/** Who wants it: one name, or `a and b` when an overlapping request folded two askers together. */
function askers(params: Pick<OwnerActionParams, 'requested_by' | 'requesters'>): string[] {
  return (params.requesters ?? [params.requested_by]).map(plainAsker);
}

/** Terminal escape sequences and any other control character a caller types: never on a card. */
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A word that names a place on the machine: it carries a separator, a home marker or a drive. */
function pathLike(word: string): boolean {
  return word.includes('/') || word.includes('\\') || word.startsWith('~') || /^[A-Za-z]:$/.test(word);
}

/**
 * A path-like word reduced to the last thing it names: `/synthetic/private/project` → `project`,
 * `~/Code/x` → `x`, `C:\x\y` → `y`. A word that is only separators or a drive (`/`, `~`, `C:`)
 * names nothing and is dropped. Surrounding punctuation goes with the path.
 */
function lastSegment(word: string): string | undefined {
  const parts = word
    .replace(/^~[\\/]?/, '')
    .split(/[\\/]+/)
    .filter((part) => part !== '' && part !== '.' && part !== '..' && !/^[A-Za-z]:$/.test(part));
  const last = parts[parts.length - 1];
  if (last === undefined) return undefined;
  const named = last.replace(/^[^\p{L}\p{N}_]+/u, '').replace(/[^\p{L}\p{N}_]+$/u, '');
  return named === '' ? undefined : named;
}

/**
 * The reason as one short clause: escape sequences and control characters (a line break among
 * them) are stripped, whitespace is folded, every path is cut to the last thing it names with a
 * word that is only a path dropped, and the clause is cut at a word boundary within REASON_MAX,
 * `…` when cut. A caller's reason cannot put a machine path, a control sequence or a line of its
 * own on the card.
 */
function shortReason(reason: string): string {
  const why = reason
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (pathLike(word) ? lastSegment(word) : word))
    .filter((word): word is string => word !== undefined && word !== '')
    .join(' ');
  if (why.length <= REASON_MAX) return why;
  const at = why.lastIndexOf(' ', REASON_MAX);
  return `${why.slice(0, at > 0 ? at : REASON_MAX).replace(/[,;:.\s]+$/, '')}…`;
}

/** The value a development-mode request names: the mode it sets, read from its own bound words. */
function askedMode(verb: readonly string[] | undefined): string | undefined {
  const mode = verb?.[0] === 'set' ? verb[1] : undefined;
  return mode === 'local-fast' || mode === 'pr-per-change' || mode === 'off' ? mode : undefined;
}

/** The title line: a plain verb and its object, or the name of a switch whose title is not a phrase. */
function titleOf(action: string, what: string, words: readonly string[] | undefined): string {
  if (action === 'development-mode') {
    const mode = askedMode(words);
    return mode === undefined ? msg('card.title.development-mode') : msg(`card.title.development-mode.${mode}` as MessageId);
  }
  return msg('card.title', { action: sentence(what) });
}

/** The question line: who wants it and why, ending `OK?`. A fixed switch keeps its own sentence. */
function questionOf(action: string, who: readonly string[], what: string, reason: string | undefined, words: readonly string[] | undefined): string {
  if (action === 'development-mode') {
    const mode = askedMode(words);
    return mode === undefined ? msg('card.question.approval') : msg(`card.question.development-mode.${mode}` as MessageId);
  }
  const named = who.filter((name) => name !== '');
  if (named.length === 0) return msg('card.question.anon', { what: sentence(what) });
  const plural = named.length > 1;
  const base = plural
    ? msg('card.question.base.they', { askers: `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`, what })
    : msg('card.question.base', { asker: named[0]!, what });
  const why = reason === undefined ? '' : shortReason(reason);
  if (why === '') return msg('card.question.ok', { base });
  // A cut reason already ends with `…`: the sentence closes after it, with no second full stop.
  return msg(why.endsWith('…') ? 'card.question.ok.for.cut' : 'card.question.ok.for', { base, reason: why });
}

/** The scope line: the team plus what changes, or that no permission changes. A bundled request
 *  names every change it carries; the machine-wide development-mode switch names the machine. */
function scopeOf(actions: readonly string[], team: string): string {
  if (actions.length === 1 && actions[0] === 'development-mode') return msg('card.scope.development-mode');
  const changes = [...new Set(actions.filter((action) => CHANGED.has(action)).map((action) => msg(`card.change.${action}` as MessageId)))];
  if (changes.length === 0) return msg('card.scope.team', { team });
  return msg('card.scope.changes.many', { team, changes: changes.join('; ') });
}

/** The kinds whose answer changes something beyond the team's own running state. */
const CHANGED: ReadonlySet<string> = new Set(['team-create', 'team-import', 'team-migrate', 'team-config', 'team-revoke-approval', 'team-general-grant']);

/** One owner-action request, as the owner reads it before answering. */
export function ownerActionCard(params: Pick<OwnerActionParams, 'actions' | 'team' | 'requested_by' | 'requesters' | 'reason' | 'words'>): ApprovalCard {
  const what = params.actions.map((action) => msg(`card.what.${action}` as MessageId));
  const who = askers(params);
  if (params.actions.length === 1) {
    const action = params.actions[0]!;
    return {
      title: titleOf(action, what[0]!, params.words?.[action]),
      question: questionOf(action, who, what[0]!, params.reason, params.words?.[action]),
      scope: scopeOf(params.actions, params.team),
    };
  }
  return {
    title: msg('card.title.several', { actions: sentence(inOrder(what)) }),
    question: questionOf('several', who, inOrder(what), params.reason, undefined),
    scope: scopeOf(params.actions, params.team),
  };
}

/** A team-create request: the repository is a record detail, so the card names only the team. */
export function teamCreateCard(params: Pick<TeamCreateParams, 'team' | 'requested_by' | 'reason'>): ApprovalCard {
  const who = params.requested_by === undefined ? [] : [plainAsker(params.requested_by)];
  return {
    title: msg('card.title', { action: sentence(msg('card.what.team-create')) }),
    question: questionOf('team-create', who, msg('card.what.team-create'), params.reason, undefined),
    scope: scopeOf(['team-create'], params.team),
  };
}

/** A grant request: the grant's own prompt is the question, and the owner reads it as it is. */
export function grantCard(input: { prompt: string; master?: boolean; up?: boolean }): ApprovalCard {
  const title = input.master === true ? msg('card.grant.title.master') : input.up === true ? msg('card.grant.title.team') : msg('card.grant.title.grant');
  return { title, question: msg('card.question.ok', { base: input.prompt.replace(/\.\s*$/, '') }) };
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
