// The `owner-reply-to` policy's vocabulary: the qualified `seat@team` address an owner-origin
// message names for the seat that answers it. The policy is entity-level only, and entity
// `floor` ships a default naming its orchestrator; every other entity must declare its own.
// The grammar names both a seat and a team and forbids a colon, so a pane channel can never be
// a value: only a seat can answer the owner, never a human's pane.
//
// This module holds only the vocabulary: the catalogue reads its parser without importing the
// reader back into itself, the same split `sender-line` keeps.

/** The entity whose owner-reply target the release ships. */
export const OWNER_REPLY_FLOOR_ENTITY = 'floor';

/** The floor's shipped target: its orchestrator, addressed by seat and team. */
export const OWNER_REPLY_DEFAULT = 'orchestrator@floor';

/** One seat part and one team part, both starting with a letter or digit; no colon, no space. */
const QUALIFIED = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parses an `owner-reply-to` value into its trimmed `seat@team` form, or null when it is not one. */
export function parseOwnerReplyToValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return QUALIFIED.test(text) ? text : null;
}

/** Why a raw value is not an `owner-reply-to` value, in the words `team policy set` refuses it with. */
export function ownerReplyToValueProblem(raw: unknown): string | null {
  if (parseOwnerReplyToValue(raw) !== null) return null;
  if (typeof raw !== 'string') return 'the owner-reply target must be a qualified seat@team address';
  const text = raw.trim();
  if (text === '') return 'the owner-reply target must not be empty';
  if (text.includes(':')) return 'a pane address is not an owner-reply target: name a seat@team address';
  const at = text.indexOf('@');
  if (at < 0) return 'the owner-reply target must name a team: seat@team, not a bare seat';
  if (at !== text.lastIndexOf('@')) return 'the owner-reply target must name exactly one team: seat@team';
  if (at === 0 || at === text.length - 1) return 'the owner-reply target must name both a seat and a team: seat@team';
  return 'the owner-reply target must be a seat@team address of letters, digits, ".", "_" or "-"';
}
