// One owner-action request record, read on its own: the actions TeamCLI knows, the parameters a
// request signs and their hash, and the checks a record must pass to be whole — its hash, its
// argument words, its signed window and what a request answered across machines must carry. It
// reads no file, and imports nothing of TeamCLI's own but the account-name rule, so the owner
// helper of a machine whose accounts share one owner (src/client/owner-spend.ts) checks a record
// with exactly this rule. src/client/owner-action.ts and src/client/owner-pin.ts re-export it.

import { createHash } from 'node:crypto';
import { ACCOUNT_NAME_PATTERN } from './owner-pin-path.ts';

export const MACHINE_ID_PATTERN = /^m_[0-9a-f]{24}$/;
export const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{0,62}$/;
/** This machine, as a request names it: a random id and a name the owner reads on the card. */
export type MachineBinding = { id: string; name: string };


function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validMachineBinding(raw: unknown): raw is MachineBinding {
  return plainObject(raw)
    && typeof raw.id === 'string' && MACHINE_ID_PATTERN.test(raw.id)
    && typeof raw.name === 'string' && MACHINE_NAME_PATTERN.test(raw.name)
    && Object.keys(raw).every((key) => key === 'id' || key === 'name');
}

export function validAccountBinding(raw: unknown): raw is string {
  return typeof raw === 'string' && ACCOUNT_NAME_PATTERN.test(raw);
}

export const OWNER_ACTIONS = ['team-create', 'team-import', 'team-migrate', 'team-add', 'team-up', 'team-send', 'team-down', 'team-bus', 'team-revoke-approval', 'team-forget', 'team-config', 'team-general-grant', 'development-mode', 'team-entity-config', 'team-daemon'] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];
export const OWNER_ACTION_TTL_MS = 15 * 60 * 1000;
export const OWNER_ACTION_ID_PATTERN = /^oa_[0-9a-f]{24}$/;

export type OwnerActionParams = {
  kind: 'owner-action';
  actions: OwnerAction[];
  root: string;
  team: string;
  head: string | null;
  /** Per action, the hash of the arguments it will run with (`actionArgsHash`). */
  args: Partial<Record<OwnerAction, string>>;
  /** Per action, the arguments that hash names. Present on a request recorded by this build. */
  words?: Partial<Record<OwnerAction, string[]>>;
  /** Why the asker wants it, in their own words. Display only: it is not part of the hash, so a
   *  request still signs the same actions and arguments whether or not it carries a reason. */
  reason?: string;
  /** Who asked: the caller's log label. A signer of that name cannot answer it. */
  requested_by: string;
  /** Every caller folded into one card. Set only when more than one asked, and part of the hash then. */
  requesters?: string[];
  /** The machine the request was made on, when its owner seat is pinned from another machine
   *  (src/client/owner-pin.ts). Part of the hash, so the owner's answer is bound to that machine
   *  and runs nowhere else. A machine with a local owner names none, and hashes as before. */
  machine?: MachineBinding;
  /** The account the request was made by, on a machine whose accounts share one owner
   *  (src/client/owner-pin-path.ts). Part of the hash, so an answer for one account is never
   *  spent by another. Elsewhere none, and the request hashes as before. */
  account?: string;
  /** The answer window, inside the hash: when the request was made and when it stops accepting
   *  an answer (`null`: never, when the charter says so). The record's own `created` and
   *  `expires_at` must equal it. A record written before the field existed carries none; a
   *  machine with a local owner reads it as before, and a pinned machine refuses it. */
  window?: { created: string; expires_at: string | null };
};
export type OwnerActionRecord = {
  request_id: string;
  params: OwnerActionParams;
  params_sha256: string;
  created: string;
  /** `null` when the charter says a request does not expire. */
  expires_at: string | null;
  /** Epoch of the coalesce that wrote this card. A later caller joins only a newer epoch. */
  join?: { epoch: number };
};

export function actionArgsHash(action: OwnerAction, words: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify({ action, words }), 'utf8').digest('hex');
}

export function ownerActionHash(p: OwnerActionParams): string {
  // No prototype on either map: an entry the record names `__proto__` is an ordinary own key
  // and its value is part of the hash. On a plain object the write would replace the map's
  // prototype instead, and two records that differ only in that entry would share one hash.
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(p.args).sort()) args[key] = p.args[key as OwnerAction]!;
  // `words` is part of the hash when the request carries it, so one signature binds each
  // action's argument list. A record written before the field existed hashes as it did then.
  const body: Record<string, unknown> = { kind: p.kind, actions: [...p.actions], root: p.root, team: p.team, head: p.head, args, requested_by: p.requested_by };
  if (p.words !== undefined) {
    const words: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const key of Object.keys(p.words).sort()) words[key] = [...(p.words[key as OwnerAction] ?? [])];
    body.words = words;
  }
  if (p.requesters !== undefined) body.requesters = [...p.requesters].sort();
  if (p.machine !== undefined) body.machine = { id: p.machine.id, name: p.machine.name };
  if (p.account !== undefined) body.account = p.account;
  if (p.window !== undefined) body.window = { created: p.window.created, expires_at: p.window.expires_at };
  // `reason` is not hashed on purpose: the owner's answer signs the actions, arguments, folder,
  // team and HEAD, and the asker's own words about why must not change what that signature covers.
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function isoTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * The arguments a card shows are the arguments the answer admits: when a request carries its
 * words, every action it names carries its own list, and each action's argument hash is the hash
 * of exactly that list. No hash or list names an action the request does not. A record from
 * before words existed carries none, and its card shows no arguments to differ from (a pinned
 * machine refuses it, `ownerActionBindingProblem`).
 */
function argumentWordsProblem(p: OwnerActionParams, id: string): string | null {
  const args: unknown = p.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return `request ${id} carries no argument hashes`;
  const named = new Set<string>(p.actions);
  if (Object.keys(args).some((key) => !named.has(key))) return `request ${id} hashes arguments for an action it does not name`;
  if (p.words === undefined) return null;
  const words: unknown = p.words;
  if (words === null || typeof words !== 'object' || Array.isArray(words)) return `request ${id} carries argument words that cannot be read`;
  if (Object.keys(words).some((key) => !named.has(key))) return `request ${id} carries argument words for an action it does not name`;
  for (const action of p.actions) {
    const list: unknown = (words as Record<string, unknown>)[action];
    if (!Array.isArray(list) || !list.every((word) => typeof word === 'string')) return `request ${id} carries no argument words for ${action}`;
    if ((args as Record<string, unknown>)[action] !== actionArgsHash(action, list as string[])) return `request ${id}'s arguments for ${action} are not the words it shows`;
  }
  return null;
}

/** A signed window, when the request carries one, is whole and is the record's own. */
function windowShapeProblem(record: OwnerActionRecord, id: string): string | null {
  const window: unknown = record.params.window;
  if (window === undefined) return null;
  if (window === null || typeof window !== 'object' || Array.isArray(window)) return `request ${id} carries an answer window that cannot be read`;
  const w = window as Record<string, unknown>;
  if (!isoTime(w.created) || (w.expires_at !== null && !isoTime(w.expires_at)) || Object.keys(w).some((key) => key !== 'created' && key !== 'expires_at')) {
    return `request ${id} carries an answer window that cannot be read`;
  }
  if (record.created !== w.created || record.expires_at !== w.expires_at) return `request ${id}'s answer window is not the one it was signed with`;
  if (w.expires_at !== null && Date.parse(w.expires_at) < Date.parse(w.created)) return `request ${id}'s answer window ends before it begins`;
  return null;
}

/** What any request answered across machines must carry, read from the record alone: the owner
 *  helper asks it with no home of the account to read. */
export function carriedBindingProblem(record: OwnerActionRecord): string | null {
  const p = record.params;
  const id = record.request_id;
  if (p.window === undefined) return `request ${id} carries no signed answer window; record it again with --request`;
  if (p.window.expires_at === null) return `request ${id} never expires; a request answered from another machine must`;
  const life = Date.parse(p.window.expires_at) - Date.parse(p.window.created);
  if (!(life > 0 && life <= OWNER_ACTION_TTL_MS)) return `request ${id}'s answer window is longer than a request's ${OWNER_ACTION_TTL_MS / 60_000} minutes`;
  if (p.words === undefined) return `request ${id} carries no argument words; record it again with --request`;
  return null;
}

/** How far ahead of a reader's clock a request may say it was made, or an answer that it was
 *  given: two machines' clocks differ a little, never by more. */
export const OWNER_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * A request answered across machines, by the reader's own clock: it was made no later than now
 * (within the skew). A request dated ahead would keep a fifteen-minute window open for as long
 * as it likes, so it is never shown, signed, recorded or spent. Asked after
 * `carriedBindingProblem`, which makes sure the window is whole.
 */
export function carriedRequestTimeProblem(record: OwnerActionRecord, now: Date): string | null {
  const created = Date.parse(record.params.window?.created ?? record.created);
  if (!Number.isFinite(created)) return `request ${record.request_id} carries no time it was made`;
  if (created > now.getTime() + OWNER_CLOCK_SKEW_MS) return `request ${record.request_id} says it was made at ${record.params.window?.created ?? record.created}, ahead of this machine's clock; it is not answered or run`;
  return null;
}

/**
 * The time a signed answer to a request answered across machines says it was given: inside the
 * request's signed window (from when it was made, within the skew, to when it expires) and not
 * ahead of the reader's clock. Null when it may stand.
 */
export function carriedAnswerTimeProblem(record: OwnerActionRecord, at: unknown, now: Date): string | null {
  const id = record.request_id;
  const given = typeof at === 'string' && at.length <= 40 ? Date.parse(at) : NaN;
  if (!Number.isFinite(given)) return `the answer to ${id} carries no time it was given`;
  if (given > now.getTime() + OWNER_CLOCK_SKEW_MS) return `the answer to ${id} says it was given at ${at}, ahead of this machine's clock`;
  const window = record.params.window;
  const created = Date.parse(window?.created ?? record.created);
  if (!(given >= created - OWNER_CLOCK_SKEW_MS)) return `the answer to ${id} says it was given before the request was made`;
  const expires = window?.expires_at === null || window === undefined ? Infinity : Date.parse(window.expires_at);
  if (!(given <= expires)) return `the answer to ${id} was given after the request expired`;
  return null;
}

/** One owner-action record read from anywhere — the requests folder, or a file carried from
 *  another machine — whole and bound to its own hash, or why not. */
export function ownerActionRecordOf(raw: unknown, id: string): OwnerActionRecord | string {
  if (!OWNER_ACTION_ID_PATTERN.test(id)) return `"${id}" is not an owner-seat request id`;
  try {
    const record = raw as OwnerActionRecord;
    if (record === null || typeof record !== 'object' || record.request_id !== id || record.params?.kind !== 'owner-action') return `request ${id} is not an owner-seat request`;
    const actions: unknown = record.params.actions;
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every((action) => typeof action === 'string' && (OWNER_ACTIONS as readonly string[]).includes(action))) {
      return `request ${id} names an action this build does not know`;
    }
    if (record.params.machine !== undefined && !validMachineBinding(record.params.machine)) return `request ${id} names a machine this build cannot read`;
    if (record.params.account !== undefined && !validAccountBinding(record.params.account)) return `request ${id} names an account this build cannot read`;
    if (ownerActionHash(record.params) !== record.params_sha256) return `request ${id}'s parameters do not match its hash`;
    // A record edited and hashed again still has to say what it admits: the words it shows hash
    // to the arguments it runs, and its window is the one it was signed with.
    const words = argumentWordsProblem(record.params, id);
    if (words !== null) return words;
    const window = windowShapeProblem(record, id);
    if (window !== null) return window;
    return record;
  } catch {
    return `no owner-seat request ${id} can be read`;
  }
}
