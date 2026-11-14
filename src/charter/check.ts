// The charter checker. Absent: the command keeps its old gate. Invalid: fail closed. Inside the
// charter: admit, with no prompt. Outside: a seat is refused, and the refusal names
// `team setup --edit`. The owner is never refused: one warning names the charter and the repair,
// and the same words are the audit line.

import { realpathSync } from 'node:fs';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { logLine } from '../log.ts';
import { boundRoot, pathInsideRoot, type CharterLifetimes, type CharterOp } from './body.ts';
import { readCharter } from './store.ts';

export type CharterAsk = {
  operation: CharterOp;
  cwd: string;
  /** A path that must sit in the charter roots. Defaults to `cwd`. */
  path?: string;
  vendor?: string;
  renewal?: boolean;
};

export type CharterGate =
  | { kind: 'absent' }
  | { kind: 'admit'; signer: string }
  | { kind: 'block'; message: string };

const EDIT = 'team setup --edit';

function located(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether a signed root covers `path`: only while the root still resolves to what was signed
 *  (`boundRoot`). A root a link has moved since, or one that is gone, covers nothing. */
function covers(root: string, path: string): boolean {
  const bound = boundRoot(root);
  return bound !== null && pathInsideRoot(bound, path);
}

/** Whether `folder` sits under a verified charter root. No charter, or one that does not verify, is false. */
export function charterCoversFolder(home: string, folder: string, store?: OwnerSeatKeyStore): boolean {
  const read = readCharter(home, store ?? systemOwnerSeatKeyStore());
  if (read.kind !== 'ok') return false;
  const at = located(folder);
  return read.charter.body.roots.some((root) => covers(root, at));
}

/** One lifetime from a verified charter. Absent and invalid stay distinct so a caller can fail closed. */
export function charterLifetime(
  home: string,
  which: keyof CharterLifetimes,
  store?: OwnerSeatKeyStore,
): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'set'; ms: number | null } {
  const read = readCharter(home, store ?? systemOwnerSeatKeyStore());
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'invalid') return { kind: 'invalid' };
  return { kind: 'set', ms: read.charter.body.lifetimes[which] };
}

/**
 * The gate every routine command asks. `block` is a refusal that names `team setup --edit`:
 * the charter is missing a signature, or this run sits outside it. No request is raised.
 */
export function charterGate(home: string, ask: CharterAsk, store?: OwnerSeatKeyStore): CharterGate {
  const read = readCharter(home, store ?? systemOwnerSeatKeyStore());
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'invalid') {
    return { kind: 'block', message: `the owner charter does not verify (${read.why}); nothing runs until the owner signs again with ${EDIT}` };
  }
  const body = read.charter.body;
  if (body.expires_at !== null && Date.parse(body.expires_at) <= Date.now()) {
    return { kind: 'block', message: `the owner charter expired at ${body.expires_at}; the owner signs again with ${EDIT}` };
  }
  if (!body.operations.includes(ask.operation)) {
    return { kind: 'block', message: `the owner charter does not cover ${ask.operation}; the owner widens it with ${EDIT}` };
  }
  if (ask.operation === 'init' && !body.team_creation) {
    return { kind: 'block', message: `the owner charter does not cover creating a team; the owner widens it with ${EDIT}` };
  }
  if (ask.operation === 'grant' && !body.grants) {
    return { kind: 'block', message: `the owner charter does not cover grants; the owner widens it with ${EDIT}` };
  }
  if (ask.renewal === true && !body.renewals) {
    return { kind: 'block', message: `the owner charter does not cover renewals; the owner widens it with ${EDIT}` };
  }
  if (ask.vendor !== undefined && body.vendors !== 'all' && !body.vendors.includes(ask.vendor)) {
    return { kind: 'block', message: `the owner charter does not allow vendor ${ask.vendor}; the owner widens it with ${EDIT}` };
  }
  const path = located(ask.path ?? ask.cwd);
  const inside = body.roots.some((root) => covers(root, path));
  if (!inside) {
    return { kind: 'block', message: `this is outside the owner charter (${path} is not under a charter root); the owner widens it with ${EDIT}` };
  }
  return { kind: 'admit', signer: read.charter.signer };
}

/**
 * The folder half of the charter, for a write the operation list does not name. Absent stays
 * absent. Invalid, expired, and a folder outside the roots block, with the same repair.
 */
export function charterRootsGate(home: string, folder: string, store?: OwnerSeatKeyStore): CharterGate {
  const read = readCharter(home, store ?? systemOwnerSeatKeyStore());
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'invalid') {
    return { kind: 'block', message: `the owner charter does not verify (${read.why}); nothing runs until the owner signs again with ${EDIT}` };
  }
  const body = read.charter.body;
  if (body.expires_at !== null && Date.parse(body.expires_at) <= Date.now()) {
    return { kind: 'block', message: `the owner charter expired at ${body.expires_at}; the owner signs again with ${EDIT}` };
  }
  const path = located(folder);
  const inside = body.roots.some((root) => covers(root, path));
  if (!inside) {
    return { kind: 'block', message: `this is outside the owner charter (${path} is not under a charter root); the owner widens it with ${EDIT}` };
  }
  return { kind: 'admit', signer: read.charter.signer };
}

/** The owner passes a blocking charter. One warning names the charter and the repair, and the
 *  same words are written to the team log. */
export function passCharterOwner(
  io: { stderr: (text: string) => void },
  message: string,
  audit: { dir: string; command: string; caller: string; now?: Date },
): void {
  const line = `warning: ${message}`;
  io.stderr(`${line}\n`);
  logLine(audit.dir, audit.command, audit.caller, line, audit.now);
}

/** A standing grant that would reach past the charter, or null when no charter is in force. */
export function charterGrantBound(
  home: string,
  request: { capabilities: readonly string[]; roots: readonly string[]; scope?: readonly string[]; expires?: string | null },
  store?: OwnerSeatKeyStore,
): string | null {
  const read = readCharter(home, store ?? systemOwnerSeatKeyStore());
  if (read.kind === 'absent') return null;
  if (read.kind === 'invalid') return `the owner charter does not verify (${read.why}); nothing is granted until the owner signs again with ${EDIT}`;
  const body = read.charter.body;
  if (!body.grants) return `the owner charter does not cover grants; the owner widens it with ${EDIT}`;
  const forbidden = ['grant', 'create', 'agree', 'leads'];
  for (const capability of request.capabilities) {
    if (forbidden.includes(capability)) return `a grant cannot carry \`${capability}\``;
  }
  const places = [...request.roots, ...(request.scope ?? [])];
  for (const place of places) {
    const at = located(place);
    if (!body.roots.some((root) => covers(root, at))) {
      return `the grant path ${at} is outside the owner charter; the owner widens it with ${EDIT}`;
    }
  }
  const cap = body.lifetimes.grant;
  if (cap !== null) {
    if (request.expires === null || request.expires === undefined) return `a grant under this charter ends within ${cap} ms; the owner widens it with ${EDIT}`;
    const at = Date.parse(request.expires);
    if (!Number.isFinite(at) || at > Date.now() + cap) return `the grant's expiry is longer than the owner charter allows; the owner widens it with ${EDIT}`;
  }
  return null;
}
