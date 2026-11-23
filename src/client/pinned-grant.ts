// Who signs a general grant on a machine whose accounts share one owner and whose owner seat is
// pinned from another machine. A root signed with the account's own key would let the account
// authorize itself, so it stays refused there. The root read there is the owner's signed answer to
// one carried `team-general-grant` request whose words are the grant's fields, spent once by the
// owner helper. Everything else about a general grant is unchanged (src/client/general-grant.ts).
//
// Every read checks the answer against the system pin, for this machine and account, and honours
// a revocation in a folder only the administrator writes.

import { lstatSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from '../host/guarded-fs.ts';
import { join } from 'node:path';
import type { GeneralGrant } from './general-grant.ts';
import { ownerStateOf, systemOwnerUid, type OwnerStatePlace } from './owner-pin-path.ts';
import { readOwnerPinIn, verifyPinnedOwnerAnswer } from './owner-pin-verify.ts';
import { carriedAnswerTimeProblem, carriedBindingProblem, carriedRequestTimeProblem, OWNER_ACTION_ID_PATTERN, OWNER_CLOCK_SKEW_MS, ownerActionRecordOf, type OwnerActionRecord } from './owner-request-record.ts';
import type { SignedOwnerAnswer } from './owner-signature.ts';
import { parsePinnedGrantWords, type PinnedGrantTerms } from './pinned-grant-words.ts';

/** The team name such a request binds: a general grant is the account's, not one team's. */
export const PINNED_GRANT_TEAM = 'general-grant';
const ACTION = 'team-general-grant';
const DAY_MS = 86_400_000;
const GRANT_ID = /^gg_[0-9a-f]{24}$/;

export type OwnerAnswerProof = { record: OwnerActionRecord; answer: SignedOwnerAnswer };
type SharedPlace = OwnerStatePlace & { shared: NonNullable<OwnerStatePlace['shared']> };

function sharedPlace(home: string): { ok: true; place: SharedPlace } | { ok: false; why: string } {
  const state = ownerStateOf(home);
  if (state.kind === 'refused') return { ok: false, why: state.why };
  if (state.kind !== 'present' || state.place.shared === undefined) return { ok: false, why: 'an owner-signed general grant needs a machine whose accounts share one owner, with the owner helper installed' };
  return { ok: true, place: state.place as SharedPlace };
}

/** Whether this machine can hold an owner-signed grant: the helper's ledger and the system folder. */
export function pinnedGrantProblem(home: string): string | null {
  const at = sharedPlace(home);
  return at.ok ? null : at.why;
}

/** The root grant these signed words and this request make: its id and times come from the signed record. */
export function pinnedRootOf(record: OwnerActionRecord, terms: PinnedGrantTerms): GeneralGrant {
  const issued = record.params.window!.created;
  return {
    grant_id: `gg_${record.request_id.slice(3)}`,
    client_id: terms.to,
    public_key: terms.publicKey,
    entities: terms.entities,
    ops: terms.ops as GeneralGrant['ops'],
    may_issue: terms.mayIssue,
    parent: null,
    issued,
    expires: new Date(Date.parse(issued) + terms.days * DAY_MS).toISOString(),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, at) => value === right[at]);
};

/**
 * Whether the helper's protected ledger entry records the spend of exactly this signed request:
 * its id, action, account, signer and parameter hash, at a time inside its signed window. An
 * entry an interrupted write left empty or partial records nothing.
 */
function spendRecorded(place: SharedPlace, record: OwnerActionRecord, signer: string, answeredAt: string, now: Date): boolean {
  try {
    const path = join(place.ledger, `${record.request_id}.${ACTION}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.uid !== place.shared.helper.uid || (stat.mode & 0o022) !== 0 || stat.size > 4096) return false;
    const entry = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (entry.request_id !== record.request_id || entry.action !== ACTION || entry.account !== place.shared.account || entry.signer !== signer || entry.params_sha256 !== record.params_sha256) return false;
    const spent = typeof entry.at === 'string' && entry.at.length <= 40 ? Date.parse(entry.at) : NaN;
    const window = record.params.window!;
    return Number.isFinite(spent)
      && spent >= Math.max(Date.parse(window.created), Date.parse(answeredAt)) - OWNER_CLOCK_SKEW_MS
      && spent < Date.parse(window.expires_at!)
      && spent <= now.getTime() + OWNER_CLOCK_SKEW_MS;
  } catch {
    return false;
  }
}

/** Why this root grant is not the owner's signed answer for this machine and account, or null. */
export function ownerAnswerRootProblem(home: string, g: GeneralGrant, proof: unknown, now: Date): string | null {
  const at = sharedPlace(home);
  if (!at.ok) return at.why;
  const pin = readOwnerPinIn(ownerStateOf(home));
  if (pin.kind !== 'pinned') return pin.kind === 'refused' ? pin.why : 'no owner seat is pinned on this machine';
  const carried = proof as Partial<OwnerAnswerProof> | null;
  const rawRecord = carried?.record as { request_id?: unknown } | undefined;
  if (typeof rawRecord?.request_id !== 'string' || !OWNER_ACTION_ID_PATTERN.test(rawRecord.request_id)) return `general grant ${g.grant_id} carries no owner-signed request`;
  const record = ownerActionRecordOf(rawRecord, rawRecord.request_id);
  if (typeof record === 'string') return record;
  const id = record.request_id;
  const p = record.params;
  if (p.actions.length !== 1 || p.actions[0] !== ACTION || p.team !== PINNED_GRANT_TEAM) return `request ${id} is not a general grant`;
  if (p.machine === undefined || p.machine.id !== pin.machine.id) return `general grant ${g.grant_id} is not for this machine (${pin.machine.name})`;
  if (p.account !== at.place.shared.account) return `general grant ${g.grant_id} is not for account ${at.place.shared.account}`;
  const shape = carriedBindingProblem(record) ?? carriedRequestTimeProblem(record, now);
  if (shape !== null) return shape;
  const terms = parsePinnedGrantWords(p.words?.[ACTION] ?? []);
  if (typeof terms === 'string') return terms;
  const verified = verifyPinnedOwnerAnswer(pin, carried!.answer as SignedOwnerAnswer);
  if (!verified.ok) return verified.why;
  const a = verified.answer;
  if (a.kind !== 'owner-action' || a.request_id !== id || a.params_sha256 !== record.params_sha256) return `the owner's answer is not bound to general grant ${g.grant_id}`;
  if (a.choice !== 'once') return `general grant ${g.grant_id} carries no approving answer: the owner answers it once`;
  if ((p.requesters ?? [p.requested_by]).includes(verified.signer.name)) return `signer "${verified.signer.name}" asked for general grant ${g.grant_id}`;
  const given = carriedAnswerTimeProblem(record, a.at, now);
  if (given !== null) return given;
  if (!spendRecorded(at.place, record, verified.signer.name, a.at, now)) return `general grant ${g.grant_id} was never spent through the owner helper`;
  const signed = pinnedRootOf(record, terms);
  if (g.grant_id !== signed.grant_id || g.client_id !== signed.client_id || g.public_key !== signed.public_key || g.may_issue !== signed.may_issue || g.parent !== null || g.issued !== signed.issued || g.expires !== signed.expires || !sameList(g.entities, signed.entities) || !sameList(g.ops, signed.ops)) {
    return `general grant ${g.grant_id} is not what the owner signed`;
  }
  return null;
}

/** The owner's revocation of this grant, or why it cannot be read; null when it stands. */
export function pinnedRevocationProblem(home: string, id: string): string | null {
  const at = sharedPlace(home);
  if (!at.ok) return at.why;
  const folder = join(at.place.dir, 'revoked-grants');
  try {
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || stat.uid !== systemOwnerUid() || (stat.mode & 0o022) !== 0) return 'the revocation folder is not one only the administrator can write';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'the revocation folder cannot be read';
  }
  try {
    lstatSync(join(folder, id));
    return `general grant ${id} was revoked by the owner`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'the revocation folder cannot be read';
  }
}

/** The revocation itself, run as the administrator. A revoked root ends every grant under it. */
export function revokePinnedGrant(home: string, id: string, now: Date, uid: number = process.getuid?.() ?? -1): { ok: true; already: boolean } | { ok: false; why: string } {
  if (!GRANT_ID.test(id)) return { ok: false, why: `"${id}" is not a general grant id` };
  if (uid !== systemOwnerUid()) return { ok: false, why: "only the administrator revokes a general grant here: run it with sudo from the owner's own account" };
  const at = sharedPlace(home);
  if (!at.ok) return at;
  const folder = join(at.place.dir, 'revoked-grants');
  try {
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    writeFileSync(join(folder, id), `${now.toISOString()}\n`, { flag: 'wx', mode: 0o644 });
    return { ok: true, already: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: true, already: true };
    return { ok: false, why: `the revocation could not be written in ${folder}` };
  }
}
