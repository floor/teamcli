// The owner's standing send-grants: signed records in the same grants folder the entity
// create-grants live in (`~/.config/team/grants/`), whose `send` mapping names the pair it admits
// and whose `expires` says when it stops:
//
//   {
//     "send": { "from": "builder-1@labs", "to": "orchestrator@labs" },
//     "expires": "2026-10-17T00:00:00.000Z",
//     "signature": "<hex>"
//   }
//
// The file's stem is the record's name; an older record may carry `name:`, which the signature
// covers. The signature is the owner's approval key over `team-send-grant-v1\n` and
// `{ name, send: { from, to }, expires }` — the fields admission reads and nothing else. A record
// that carries no signature, or one that does not verify, admits nothing; `readSendGrantReads`
// keeps it so a refusal can name it and print the line that re-issues it signed.
//
// Whether a record admits a given pair — the sender's identity, the receiver, the clock — is
// `sendGrantFor`/`unverifiedGrantFor` in `admit.ts`, a decision over records with no reads of its
// own. `team grant --send` (src/permissions/manage.ts) is the only writer.

import type { KeyObject } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { grantsDir, readGrantRecords } from '../grant.ts';
import { RECORD_NAME_PATTERN, readGrants } from '../permissions/grants.ts';
import { isAgentId } from '../registry/agents.ts';
import { keyOf, keyState, signDomain, verifyDomain, type Json } from '../store/keys.ts';
import type { SendGrantRead, SendGrantRecord } from './admit.ts';

/** The domain tag a send-grant signature carries: it verifies as nothing but a send grant. */
export const SEND_GRANT_DOMAIN = 'team-send-grant-v1\n';

/** The longest a send grant may last: one year from the moment it is written. */
export const SEND_GRANT_MAX_DAYS = 365;

/** The send-grants the owner has standing: every record whose signature verifies under the
 *  owner's approval key. A record missing a side or a parseable expiry is not a grant; one that
 *  does not verify admits nothing (`readSendGrantReads` says why). */
export function readSendGrants(home: string = homedir()): SendGrantRecord[] {
  return readSendGrantReads(home)
    .filter((read) => read.state === 'verified')
    .map(({ name, from, to, expires }) => ({ name, from, to, expires }));
}

/**
 * Every send-shaped record in the folder, classified: `verified` when its signature checks out
 * under the owner's approval key, `unsigned` when the file carries none, `bad-signature` when it
 * carries one that does not verify. A key that is missing or unreadable makes every signature
 * unverifiable, so a signed record is `bad-signature` until the key is restored. The folder's own
 * integrity and the file shapes are `readGrantRecords`'; the fields read are the same three the
 * match reads, in the spellings older records wrote.
 */
export function readSendGrantReads(home: string = homedir()): SendGrantRead[] {
  const state = keyState(home);
  const key = state.kind === 'key' ? state.key : null;
  const out: SendGrantRead[] = [];
  for (const { stem, record } of readGrantRecords(home)) {
    const pair = sendPairOf(record);
    if (pair === null) continue;
    const name = effectiveName(stem, record);
    const signature = typeof record.signature === 'string' ? record.signature.trim() : '';
    if (signature === '') {
      out.push({ name, ...pair, state: 'unsigned' });
      continue;
    }
    const verified = key !== null && verifyDomain(SEND_GRANT_DOMAIN, sendPayload(name, pair.from, pair.to, pair.expires), signature, key);
    out.push({ name, ...pair, state: verified ? 'verified' : 'bad-signature' });
  }
  return out;
}

/** The line that recreates an unverified record signed, with the fields the record itself holds.
 *  Quoted so the owner can paste it as one command whatever the record spells. */
export function sendGrantReissueLine(read: SendGrantRecord): string {
  return [
    'team grant --send',
    `--from ${shellWord(read.from)}`,
    `--to ${shellWord(read.to)}`,
    `--expires ${shellWord(read.expires)}`,
    `--name ${shellWord(read.name)}`,
  ].join(' ');
}

/** Why a send through an unverified record refuses, with the record named and the exact line that
 *  recreates it signed. The sentence is the same one a dry run prints: admission runs first. */
export function unverifiedSendGrantRefusal(read: SendGrantRead, home: string = homedir()): string {
  const where = `"${read.name}" in ${grantsDir(home)}`;
  const what = read.state === 'unsigned'
    ? 'is unsigned'
    : "does not verify with the owner's approval key";
  return `a send-grant record naming this pair is not signed by the owner: ${where} ${what}. Re-issue it signed from the owner's side:\n${sendGrantReissueLine(read)}`;
}

/** A send grant to write: the pair, its expiry, and the file stem the record is named. */
export type SendGrantRequest = { name: string; from: string; to: string; expires: string };

/** A validated send grant, not yet signed or written. */
export type SendGrantPlan = { ok: true; record: SendGrantRecord } | { ok: false; why: string };

/**
 * Validates one send grant and builds the record a write would sign, nothing written: a stem that
 * is one safe file name, a `from` that names an identity (never a bare word: it names nobody), a
 * `to` in any of the receiver spellings, and an expiry in the future and at most a year ahead.
 * A name already held by a standing grant or a revocation is refused; so is a same-stem file that
 * is not itself a send record. A same-stem send record is the re-issue path and is written over.
 */
export function planSendGrant(
  home: string,
  request: SendGrantRequest,
  options: { now?: Date } = {},
): SendGrantPlan {
  const now = options.now ?? new Date();
  if (!RECORD_NAME_PATTERN.test(request.name)) {
    return { ok: false, why: `"${request.name}" is not a record name: one file name of at most 64 characters, letters, digits, dot, dash and underscore, not starting with a dot` };
  }
  const fromProblem = sideProblem(request.from, 'from', false);
  if (fromProblem !== null) return { ok: false, why: fromProblem };
  const toProblem = sideProblem(request.to, 'to', true);
  if (toProblem !== null) return { ok: false, why: toProblem };
  const expires = request.expires.trim();
  const expMs = Date.parse(expires);
  if (!Number.isFinite(expMs)) {
    return { ok: false, why: `--expires "${request.expires}" is not a timestamp: an ISO date, such as ${new Date(now.getTime() + SEND_GRANT_MAX_DAYS * 86_400_000).toISOString()}` };
  }
  if (expMs <= now.getTime()) {
    return { ok: false, why: `--expires "${expires}" is not in the future: a send grant stops when it is written, so it would admit nothing` };
  }
  if (expMs > now.getTime() + SEND_GRANT_MAX_DAYS * 86_400_000) {
    return { ok: false, why: `--expires "${expires}" is more than a year ahead: a send grant lasts at most ${SEND_GRANT_MAX_DAYS} days` };
  }
  const { grants, revocations } = readGrants(home);
  if (grants.some((grant) => grant.name === request.name) || revocations.some((record) => record.name === request.name)) {
    return { ok: false, why: `"${request.name}" is a standing grant's or a revocation's name in ${grantsDir(home)}: a send grant is a separate record and never writes over one` };
  }
  const foreign = foreignSameStem(home, request.name);
  if (foreign !== null) {
    return { ok: false, why: `${foreign} is not a send record: a send grant never writes over a record of another kind` };
  }
  return { ok: true, record: { name: request.name, from: request.from.trim(), to: request.to.trim(), expires } };
}

/**
 * Writes one owner-signed send record. Everything {@link planSendGrant} refuses is refused here
 * too, nothing written; the record is signed with the owner's approval key and written whole
 * through a temporary file of mode 0600 and a rename.
 */
export function writeSendGrant(
  home: string,
  request: SendGrantRequest,
  options: { now?: Date; key?: KeyObject } = {},
): SendGrantPlan {
  const plan = planSendGrant(home, request, options);
  if (!plan.ok) return plan;
  const folder = grantsDir(home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const key = options.key ?? keyOf(home);
  const record = plan.record;
  const signature = signDomain(SEND_GRANT_DOMAIN, sendPayload(record.name, record.from, record.to, record.expires), key);
  const file = join(folder, `${record.name}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ send: { from: record.from, to: record.to }, expires: record.expires, signature }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
  return plan;
}

/** The pair a send-shaped record names, or null: `send` is a mapping whose `from` and `to` are
 *  non-empty strings, and an expiry field parses. The aliases are the ones the reader has always
 *  accepted; the writer writes `expires`. */
function sendPairOf(record: Record<string, unknown>): { from: string; to: string; expires: string } | null {
  const send = record.send;
  if (send === null || typeof send !== 'object' || Array.isArray(send)) return null;
  const pair = send as Record<string, unknown>;
  const from = typeof pair.from === 'string' ? pair.from.trim() : '';
  const to = typeof pair.to === 'string' ? pair.to.trim() : '';
  if (from === '' || to === '') return null;
  const rawExpires = record.expires ?? record.expiry ?? record.expires_at ?? record.expiresAt;
  if (typeof rawExpires !== 'string' || rawExpires.trim() === '') return null;
  const expires = rawExpires.trim();
  if (!Number.isFinite(Date.parse(expires))) return null;
  return { from, to, expires };
}

/** The record's name: the `name:` field it carries (trimmed), else the file's stem. */
function effectiveName(stem: string, record: Record<string, unknown>): string {
  return typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : stem;
}

/** The bytes a send-grant signature covers: the name and the three fields admission reads. */
function sendPayload(name: string, from: string, to: string, expires: string): Json {
  return { name, send: { from, to }, expires };
}

/** A same-stem file in the grants folder that is not a send record, named for the refusal; null
 *  when every same-stem file is a send record (the re-issue path) or there is none. A symbolic
 *  link is not read by `readGrantRecords`, so it counts as foreign here too. */
function foreignSameStem(home: string, name: string): string | null {
  const folder = grantsDir(home);
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return null;
  }
  const sameStem = entries.filter((entry) => /\.(?:yaml|yml|json)$/.test(entry) && entry.replace(/\.(?:yaml|yml|json)$/, '') === name);
  if (sameStem.length === 0) return null;
  const records = readGrantRecords(home).filter((record) => record.stem === name);
  if (records.length === sameStem.length && records.every((record) => sendPairOf(record.record) !== null)) return null;
  return join(folder, sameStem[0] ?? name);
}

/** Why a side spelling names no identity, or null when it does: an agent id, `seat@team`,
 *  `session/seat`, or — for `to` alone — a bare seat, which the caller's own team makes
 *  unambiguous. A bare `from` names nobody (`grantFromNames`), so the writer refuses it. */
function sideProblem(value: string, field: 'from' | 'to', bareSeat: boolean): string | null {
  const side = value.trim();
  if (side === '') return `--${field} is empty`;
  if (/\s/.test(side)) return `--${field} "${value}" contains whitespace: a side is an agent id, seat@team or session/seat, with no spaces`;
  if (isAgentId(side as unknown)) return null;
  const at = side.indexOf('@');
  if (at >= 0) {
    if (at === 0 || at === side.length - 1 || side.includes('/') || side.indexOf('@', at + 1) >= 0) {
      return `--${field} "${value}" is not a seat@team spelling`;
    }
    return null;
  }
  const slash = side.indexOf('/');
  if (slash >= 0) {
    if (slash === 0 || slash === side.length - 1 || side.indexOf('/', slash + 1) >= 0) {
      return `--${field} "${value}" is not a session/seat spelling`;
    }
    return null;
  }
  if (bareSeat) return null;
  return `--${field} "${value}" names no identity: a bare from is ambiguous between teams and matches nobody; spell it seat@team or session/seat`;
}

/** One shell word, single-quoted, for the re-issue line. */
function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
