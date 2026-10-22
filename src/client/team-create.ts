// Team creation approved by the owner seat: `team init --request` by a caller that is not the
// owner records a pending request (repository root, team name, HEAD, their hash, fifteen minutes)
// and drops a confirmation in the owner seat inbox. The owner answers from the owner seat
// (`team init --approve-as-owner-seat <id> oui|always|non`), signed by an accepted owner signer
// whose key is confirmed against the credential store. `team init --execute <id>`, run in that
// repository, writes the team file only with that signed answer or a signed `always` rule for
// action kind `team-create` whose scope (the parent folder) holds the repository. Nothing else
// approves: no chat text, no file an agent writes without an owner signer's signature. A rule
// never covers a grant: its signed `kind` is `team-create`.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { answerChoiceOf } from './emission.ts';
import { deliverToOwnerSeat, readOwnerSeat, signOwnerAnswer, verifyOwnerAnswer, type OwnerSeatAnswer, type OwnerSeatKeyStore, type SignedOwnerAnswer } from './owner-seat.ts';

export const TEAM_CREATE_TTL_MS = 15 * 60 * 1000;
export const TEAM_CREATE_ID_PATTERN = /^tc_[0-9a-f]{24}$/;

export type TeamCreateParams = { kind: 'team-create'; root: string; team: string; head: string | null };
export type TeamCreateRecord = { request_id: string; params: TeamCreateParams; params_sha256: string; created: string; expires_at: string };

export function teamCreateHash(p: TeamCreateParams): string {
  return createHash('sha256').update(JSON.stringify({ kind: p.kind, root: p.root, team: p.team, head: p.head }), 'utf8').digest('hex');
}

export function actionRequestsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'action-requests');
}
export function actionApprovalsFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'action-approvals');
}
export function actionAuditFolder(home: string = homedir()): string {
  return join(home, '.config', 'team', 'action-audit');
}

function writeExclusive(path: string, text: string): 'written' | 'exists' | 'failed' {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'exists' : 'failed';
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return 'written';
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function teamCreateSummary(p: TeamCreateParams): string {
  return `Create team "${p.team}" in ${p.root}${p.head ? ` (HEAD ${p.head.slice(0, 12)})` : ''}.`;
}

/** Records one request and delivers its confirmation to the owner seat. Refused with no owner seat. */
export function createTeamCreateRequest(home: string, root: string, head: string | null, now: Date = new Date()): { ok: true; record: TeamCreateRecord; inbox: string | null; text: string } | { ok: false; why: string } {
  if (readOwnerSeat(home) === null) return { ok: false, why: 'no owner seat is registered, so no owner-seat approval is possible; the owner registers one (team grant --add-owner-seat) or runs team init from a terminal' };
  const params: TeamCreateParams = { kind: 'team-create', root: canonicalRoot(root), team: basename(canonicalRoot(root)), head };
  const record: TeamCreateRecord = {
    request_id: `tc_${randomBytes(12).toString('hex')}`,
    params,
    params_sha256: teamCreateHash(params),
    created: now.toISOString(),
    expires_at: new Date(now.getTime() + TEAM_CREATE_TTL_MS).toISOString(),
  };
  mkdirSync(actionRequestsFolder(home), { recursive: true, mode: 0o700 });
  if (writeExclusive(join(actionRequestsFolder(home), `${record.request_id}.json`), `${JSON.stringify(record, null, 2)}\n`) !== 'written') {
    return { ok: false, why: 'the request could not be recorded' };
  }
  const text = `Team request ${record.request_id}: ${teamCreateSummary(params)} Authorized? reply oui/approved, always, or non/deny (team init --approve-as-owner-seat ${record.request_id} <oui|always|non>)`;
  const inbox = deliverToOwnerSeat(home, { kind: 'team-create-confirmation', request_id: record.request_id, params_sha256: record.params_sha256, text, summary: params, at: now.toISOString() });
  return { ok: true, record, inbox, text };
}

function readRecord(home: string, id: string): TeamCreateRecord | string {
  if (!TEAM_CREATE_ID_PATTERN.test(id)) return `"${id}" is not a team request id`;
  try {
    const path = join(actionRequestsFolder(home), `${id}.json`);
    if (!lstatSync(path).isFile()) return `request ${id} is not a plain file`;
    const record = JSON.parse(readFileSync(path, 'utf8')) as TeamCreateRecord;
    if (record.request_id !== id || record.params?.kind !== 'team-create') return `request ${id} is not a team request`;
    if (teamCreateHash(record.params) !== record.params_sha256) return `request ${id}'s parameters do not match its hash`;
    return record;
  } catch {
    return `no team request ${id} can be read`;
  }
}

/** The owner seat answers one team request; `always` signs the scope (the parent folder). */
export function approveTeamCreate(
  home: string,
  id: string,
  word: string,
  store: OwnerSeatKeyStore,
  now: Date = new Date(),
  via: { signer?: string; assertion?: { authenticator_data: string; client_data_json: string; signature: string } } = {},
): { ok: true; choice: 'once' | 'always' | 'deny'; ruleId?: string } | { ok: false; why: string } {
  const choice = answerChoiceOf(word);
  if (choice === null) return { ok: false, why: `"${word}" is not an answer: oui/approved/yes, always, or non/deny` };
  const record = readRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  const seat = readOwnerSeat(home);
  if (seat === null) return { ok: false, why: 'no owner seat is registered' };
  const answer: OwnerSeatAnswer = {
    kind: 'team-create', request_id: id, params_sha256: record.params_sha256, choice, team: seat.team, seat: 'owner', at: now.toISOString(),
    ...(choice === 'always' ? { scope: dirname(record.params.root) } : {}),
  };
  const signed = signOwnerAnswer(home, answer, via.signer, store, `TeamCLI: ${choice} for ${teamCreateSummary(record.params)}`, via.assertion);
  if (!signed.ok) return signed;
  const text = `${JSON.stringify(signed.signed, null, 2)}\n`;
  const written = writeExclusive(join(actionRequestsFolder(home), `${id}.seat-answer.json`), text);
  if (written !== 'written') return { ok: false, why: written === 'exists' ? `request ${id} was already answered` : 'the answer could not be written' };
  if (choice === 'always') {
    mkdirSync(actionApprovalsFolder(home), { recursive: true, mode: 0o700 });
    writeExclusive(join(actionApprovalsFolder(home), `${id}.json`), text);
    return { ok: true, choice, ruleId: id };
  }
  return { ok: true, choice };
}

export type TeamCreateRule = { rule_id: string; kind: 'team-create'; scope: string; signer: string; created: string };

/** Every `team-create` rule whose owner-signer signature verifies now; others are ignored. */
export function listTeamCreateRules(home: string, store: OwnerSeatKeyStore, now: Date = new Date()): { rules: TeamCreateRule[]; ignored: string[] } {
  let names: string[];
  try {
    names = readdirSync(actionApprovalsFolder(home)).filter((n) => /^tc_[0-9a-f]{24}\.json$/.test(n)).sort();
  } catch {
    return { rules: [], ignored: [] };
  }
  const rules: TeamCreateRule[] = [];
  const ignored: string[] = [];
  for (const name of names) {
    const id = name.slice(0, -5);
    try {
      const signed = JSON.parse(readFileSync(join(actionApprovalsFolder(home), name), 'utf8')) as SignedOwnerAnswer;
      const verified = verifyOwnerAnswer(home, signed, store, now);
      const a = signed.owner_seat_answer;
      if (!verified.ok || a.kind !== 'team-create' || a.choice !== 'always' || typeof a.scope !== 'string' || a.request_id !== id) throw new Error('rule');
      rules.push({ rule_id: id, kind: 'team-create', scope: a.scope, signer: signed.signer, created: a.at });
    } catch {
      ignored.push(id);
    }
  }
  return { rules, ignored };
}

export function revokeTeamCreateRule(home: string, ruleId: string): { ok: true } | { ok: false; why: string } {
  if (!TEAM_CREATE_ID_PATTERN.test(ruleId)) return { ok: false, why: `"${ruleId}" is not a rule id` };
  try {
    unlinkSync(join(actionApprovalsFolder(home), `${ruleId}.json`));
    return { ok: true };
  } catch {
    return { ok: false, why: `no team-create rule ${ruleId}` };
  }
}

/**
 * Admits one `--execute`: the request is whole, for this repository, unexpired, and approved by a
 * verified owner-seat answer for exactly this id and hash, or by a verified `always` rule whose
 * scope holds the repository. Claims the request single-use and writes an audit entry.
 */
export function admitTeamCreate(home: string, id: string, root: string, store: OwnerSeatKeyStore, now: Date = new Date()): { ok: true; via: 'owner-seat' | 'rule'; ruleId?: string; signer: string } | { ok: false; why: string } {
  const record = readRecord(home, id);
  if (typeof record === 'string') return { ok: false, why: record };
  if (record.params.root !== canonicalRoot(root)) return { ok: false, why: `request ${id} is for ${record.params.root}, not this repository` };
  if (Date.parse(record.expires_at) <= now.getTime()) return { ok: false, why: `request ${id} expired at ${record.expires_at}` };
  let via: 'owner-seat' | 'rule' | null = null;
  let ruleId: string | undefined;
  let signer = '';
  let answerText: string | null = null;
  try {
    answerText = readFileSync(join(actionRequestsFolder(home), `${id}.seat-answer.json`), 'utf8');
  } catch {}
  if (answerText !== null) {
    let signed: SignedOwnerAnswer;
    try {
      signed = JSON.parse(answerText);
    } catch {
      return { ok: false, why: `the owner-seat answer to ${id} is not whole JSON` };
    }
    const verified = verifyOwnerAnswer(home, signed, store, now);
    if (!verified.ok) return verified;
    const a = verified.answer;
    if (a.kind !== 'team-create' || a.request_id !== id || a.params_sha256 !== record.params_sha256) return { ok: false, why: `the owner-seat answer is not bound to request ${id} and its parameters` };
    if (!(Date.parse(a.at) <= Date.parse(record.expires_at))) return { ok: false, why: `the owner-seat answer to ${id} was given after the request expired` };
    if (a.choice === 'deny') return { ok: false, why: `the owner seat denied request ${id}` };
    via = 'owner-seat';
    signer = verified.signer.name;
  } else {
    const rule = listTeamCreateRules(home, store, now).rules.find((r) => dirname(record.params.root) === r.scope);
    if (rule === undefined) return { ok: false, why: `request ${id} has no verified owner-seat answer and no always rule covers it; the owner answers with team init --approve-as-owner-seat ${id} oui` };
    via = 'rule';
    ruleId = rule.rule_id;
    signer = rule.signer;
  }
  const used = writeExclusive(join(actionRequestsFolder(home), `${id}.used`), `${now.toISOString()}\n`);
  if (used !== 'written') return { ok: false, why: used === 'exists' ? `request ${id} was already used: an approval is single-use` : `request ${id} could not be claimed` };
  mkdirSync(actionAuditFolder(home), { recursive: true, mode: 0o700 });
  writeExclusive(join(actionAuditFolder(home), `${id}.json`), `${JSON.stringify({ request_id: id, kind: 'team-create', params: record.params, params_sha256: record.params_sha256, via, signer, ...(ruleId !== undefined ? { rule_id: ruleId } : {}), at: now.toISOString() }, null, 2)}\n`);
  return { ok: true, via, signer, ...(ruleId !== undefined ? { ruleId } : {}) };
}
