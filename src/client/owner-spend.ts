// Spending a carried approval on a machine whose accounts share one owner (Linux: the owner's
// administrator account and one unprivileged account per entity).
//
// The pin and the machine record sit in the system folder, which only the administrator writes,
// and the ledger in a folder only the owner helper's own user writes (src/client/owner-pin-path.ts).
// So an entity account cannot spend an approval itself: it hands the request, the signed answer
// and what it is about to run to the owner helper, a small program the administrator installed
// (`team owner-seat install`), which it may start only through one rule of the system's privilege
// tool, as the helper's user, with nothing on its command line. That tool names the calling
// account to the helper (its real uid, set by the tool itself, never by the caller), so the
// account the helper spends for is the one that called it.
//
// The helper checks everything again, against the system pin, for that account: the record is
// whole and matches its hash; it names this machine and this account; its signed window is open;
// the answer is signed by a pinned, accepted signer over exactly this request and is not a denial
// nor the asker's own; and the action, folder, team, HEAD and argument hash about to run are the
// ones signed. Then it spends `<request>.<action>` once in that account's own ledger folder and
// answers a verdict naming the request, the action and the parameter hash. The account runs the
// record it sent, and only when the verdict names exactly that record.
//
// Why the privilege tool, not a socket service: it needs no long-running process and no reading
// of a socket peer's credentials (which Bun does not offer), and the caller's identity comes from
// the tool, which the caller cannot set. The rule names one program and no arguments: a small
// launcher the administrator owns, which starts Bun in `/` with an environment it writes out in
// full (nothing the caller or the machine's rule keeps reaches Bun) and passes on only the
// caller's identity as the tool gave it.
//
// This file is the helper's side, and the account side's shared formats; the account side's
// call is src/client/owner-spend-client.ts.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
// Only the leaf rules: the helper's program is bundled from this file, and nothing it loads reads
// a file of TeamCLI's own or the caller's at its start.
import { carriedAnswerTimeProblem, carriedBindingProblem, carriedRequestTimeProblem, ownerActionRecordOf, OWNER_ACTION_ID_PATTERN, OWNER_ACTIONS, type OwnerAction, type OwnerActionRecord } from './owner-request-record.ts';
import { CARRIED_FILE_MAX_BYTES, readOwnerPinIn, verifyPinnedOwnerAnswer, type OwnerPin } from './owner-pin-verify.ts';
import { ACCOUNT_NAME_PATTERN, sharedOwnerStateFor, type OwnerStateRead } from './owner-pin-path.ts';
import type { SignedOwnerAnswer } from './owner-signature.ts';

export const OWNER_SPEND_FORMAT = 'team-owner-spend-v1';
export const OWNER_SPEND_VERDICT_FORMAT = 'team-owner-spend-verdict-v1';
/** The helper's user, which owns the ledger. */
export const OWNER_HELPER_USER = 'teamcli-owner';
/** The helper's code: owned by the administrator, read by everyone, written by no one else. */
export const OWNER_HELPER_ROOT = '/usr/local/teamcli-owner';
export const OWNER_HELPER_BUN = `${OWNER_HELPER_ROOT}/bin/bun`;
export const OWNER_HELPER_APP = `${OWNER_HELPER_ROOT}/app/owner-spend.js`;
/** The one program the privilege rule names: it starts Bun with an environment of its own. */
export const OWNER_HELPER_LAUNCHER = `${OWNER_HELPER_ROOT}/bin/owner-spend`;
/** The helper user's own folder: its home, and its temporary and cache folder under it. */
export const OWNER_HELPER_HOME = '/var/lib/teamcli-owner';
export const OWNER_HELPER_TMP = `${OWNER_HELPER_HOME}/tmp`;
export const OWNER_HELPER_SUDO = '/usr/bin/sudo';
/** The most a spend may be: a request, its answer and the ask, all small. */
export const OWNER_SPEND_MAX_BYTES = 2 * CARRIED_FILE_MAX_BYTES;
/** How long the helper waits for its whole input before it refuses. */
export const OWNER_SPEND_INPUT_MS = 5_000;
/** How long the helper tries to hand its verdict over before it exits. */
export const OWNER_SPEND_OUTPUT_MS = 2_000;

/** What the account is about to run, as the request's own fields name it. */
export type SpendAsk = { action: OwnerAction; root: string; team: string; head: string | null; args_sha256: string };

/** One spend asked of the helper: the request exactly as the account read it, its signed answer, and the ask. */
export type SpendInput = { record: OwnerActionRecord; answer: SignedOwnerAnswer; ask: SpendAsk };

export type SpendVerdict =
  | { ok: true; request_id: string; action: OwnerAction; params_sha256: string; account: string; signer: string }
  | { ok: false; why: string };

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function askOf(raw: unknown): SpendAsk | string {
  if (!plainObject(raw)) return 'the spend names nothing to run';
  if (typeof raw.action !== 'string' || !(OWNER_ACTIONS as readonly string[]).includes(raw.action)) return 'the spend names an action this build does not know';
  if (typeof raw.root !== 'string' || raw.root === '' || typeof raw.team !== 'string' || (raw.head !== null && typeof raw.head !== 'string')) return 'the spend names no folder, team or HEAD';
  if (typeof raw.args_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.args_sha256)) return 'the spend names no argument hash';
  return { action: raw.action as OwnerAction, root: raw.root, team: raw.team, head: raw.head as string | null, args_sha256: raw.args_sha256 };
}

/**
 * The helper's whole check, with no home of the account to read: `raw` is what the account sent,
 * `pin` the system pin, `account` the account the privilege tool named. Null when it may be spent.
 */
export function judgeSpend(raw: unknown, pin: OwnerPin, account: string, now: Date): { ok: true; input: SpendInput; signer: string } | { ok: false; why: string } {
  if (!plainObject(raw) || raw.format !== OWNER_SPEND_FORMAT) return { ok: false, why: `the spend is not a ${OWNER_SPEND_FORMAT} record` };
  if (!plainObject(raw.record) || typeof raw.record.request_id !== 'string' || !OWNER_ACTION_ID_PATTERN.test(raw.record.request_id)) return { ok: false, why: 'the spend carries no owner-seat request' };
  const record = ownerActionRecordOf(raw.record, raw.record.request_id);
  if (typeof record === 'string') return { ok: false, why: record };
  const id = record.request_id;
  const p = record.params;
  const ask = askOf(raw.ask);
  if (typeof ask === 'string') return { ok: false, why: ask };
  if (!plainObject(raw.answer)) return { ok: false, why: 'the spend carries no answer' };
  // This machine and this account: an answer for another machine, or for another account of
  // this one, is never spent here.
  if (p.machine === undefined || p.machine.id !== pin.machine.id) return { ok: false, why: `request ${id} is not for this machine (${pin.machine.name}, ${pin.machine.id})` };
  if (p.account !== account) return { ok: false, why: p.account === undefined ? `request ${id} names no account; on this machine every owner request names the account it was made by` : `request ${id} is for account ${p.account}, not ${account}` };
  const binding = carriedBindingProblem(record);
  if (binding !== null) return { ok: false, why: binding };
  const dated = carriedRequestTimeProblem(record, now);
  if (dated !== null) return { ok: false, why: dated };
  // The signed window alone: a pinned machine keeps no deferral of its own.
  const deadline = Date.parse(p.window!.expires_at!);
  if (!(now.getTime() < deadline)) return { ok: false, why: `request ${id} expired at ${p.window!.expires_at}` };
  // What runs is what was signed.
  if (!p.actions.includes(ask.action)) return { ok: false, why: `request ${id} does not approve ${ask.action} (it names ${p.actions.join(', ')})` };
  if (p.root !== ask.root) return { ok: false, why: `request ${id} is for ${p.root}, not ${ask.root}` };
  if (p.team !== ask.team) return { ok: false, why: `request ${id} is for team "${p.team}", not "${ask.team}"` };
  if (p.head !== null && p.head !== ask.head) return { ok: false, why: `request ${id} was approved at another HEAD` };
  if (p.args[ask.action] !== ask.args_sha256) return { ok: false, why: `request ${id} was approved for other ${ask.action} arguments` };
  const signed = raw.answer as unknown as SignedOwnerAnswer;
  const verified = verifyPinnedOwnerAnswer(pin, signed);
  if (!verified.ok) return verified;
  const a = verified.answer;
  if (a.kind !== 'owner-action' || a.request_id !== id || a.params_sha256 !== record.params_sha256) return { ok: false, why: `the owner-seat answer is not bound to request ${id} and its parameters` };
  const given = carriedAnswerTimeProblem(record, a.at, now);
  if (given !== null) return { ok: false, why: given };
  if (a.choice === 'deny') return { ok: false, why: `the owner seat denied request ${id}` };
  if ((p.requesters ?? [p.requested_by]).includes(verified.signer.name)) return { ok: false, why: `signer "${verified.signer.name}" asked for request ${id}; no principal approves its own request` };
  return { ok: true, input: { record, answer: signed, ask }, signer: verified.signer.name };
}

/** Flushes one folder's entries to disk, so an entry made in it survives a power loss. */
function syncFolder(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * Spends `<id>.<action>` once in one account's ledger folder: created once, never replaced, and
 * on disk — the ledger that holds the account's folder (made now or before), that folder, and the
 * entry — before it answers that it was spent.
 */
export function spendInLedgerFolder(folder: string, id: string, action: OwnerAction, entry: Record<string, unknown>): { ok: true } | { ok: false; why: string } {
  try {
    mkdirSync(folder, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, why: 'the approval ledger cannot be made; nothing was spent' };
  }
  // The account's folder is on disk in the ledger whoever made it: an earlier call may have made
  // it and stopped before it synced the ledger.
  if (!syncFolder(join(folder, '..'))) return { ok: false, why: 'the approval ledger cannot be made durable; nothing was spent' };
  let fd: number;
  try {
    fd = openSync(join(folder, `${id}.${action}`), 'wx', 0o644);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? { ok: false, why: `request ${id} was already used for ${action}: an approval is single-use` }
      : { ok: false, why: 'the approval ledger cannot be written; nothing was spent' };
  }
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } catch {
    // The entry stands (it is created, so the approval is spent), but it was not confirmed on
    // disk: no verdict says spent, so nothing runs on it.
    return { ok: false, why: 'the approval ledger entry could not be written to disk; nothing runs on it' };
  } finally {
    closeSync(fd);
  }
  if (!syncFolder(folder)) return { ok: false, why: 'the approval ledger entry could not be written to disk; nothing runs on it' };
  return { ok: true };
}

/** What the helper process is given: its stdin, the privilege tool's word for its caller, its own uid, the clock, and the user database. */
export type HelperContext = {
  stdin: string;
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  /** The clock, read once the spend lock is held: every time the judgment and the ledger use. */
  clock: () => Date;
  /** The account name of a uid, from the user database (null when it has none). */
  nameOf: (uid: number) => string | null;
  /** The owner state for one account (the system folder, in real use). */
  stateFor?: (account: string) => OwnerStateRead;
  /** Takes the one-spend-at-a-time lock (src/client/owner-spend-lock.ts); `release` gives it up. */
  lock?: () => { ok: true; release: () => void } | { ok: false; why: string };
};

/**
 * The helper's run, as one function: identify the caller, read the system pin for that account,
 * judge, spend, answer. The caller is the uid the privilege tool names (`SUDO_UID`), which must be
 * an account of the user database whose name the tool also gives (`SUDO_USER`), and the helper
 * must be running as the helper's own user: started any other way, it spends nothing (and could
 * not write the ledger).
 */
export function runOwnerSpend(ctx: HelperContext): SpendVerdict {
  if (ctx.stdin.length > 2 * CARRIED_FILE_MAX_BYTES) return { ok: false, why: 'the spend is larger than one can be' };
  const stateFor = ctx.stateFor ?? ((account: string) => sharedOwnerStateFor(account));
  const callerUid = /^[0-9]{1,10}$/.test(ctx.env.SUDO_UID ?? '') ? Number(ctx.env.SUDO_UID) : null;
  if (callerUid === null) return { ok: false, why: 'the owner helper was not started for an account; nothing was spent' };
  const account = ctx.nameOf(callerUid);
  if (account === null || !ACCOUNT_NAME_PATTERN.test(account) || ctx.env.SUDO_USER !== account) return { ok: false, why: 'the calling account cannot be read from the user database; nothing was spent' };
  const state = stateFor(account);
  // The helper's own user, from the system folder's record. Started any other way than as that
  // user, the caller's word for its account would be its own: nothing is spent.
  const helper = state.kind === 'present' ? state.place.shared?.helper : state.kind === 'refused' ? state.setup?.shared?.helper : undefined;
  if (helper === undefined) return { ok: false, why: state.kind === 'refused' ? `${state.why}; nothing was spent` : "this machine's owner state is not shared by its accounts; nothing was spent" };
  if (ctx.uid !== helper.uid) return { ok: false, why: `the owner helper runs as ${helper.user}, started through the system's privilege rule; nothing was spent` };
  if (callerUid === helper.uid) return { ok: false, why: 'the owner helper spends for an account, not for itself; nothing was spent' };
  // One spend at a time, from the pin's read to the ledger's write, and no longer: the lock is
  // given up before the verdict is written, so a caller that never reads its output holds no one
  // else up.
  let release = (): void => {};
  if (ctx.lock !== undefined) {
    const locked = ctx.lock();
    if (!locked.ok) return locked;
    release = locked.release;
  }
  try {
    // The clock is read with the lock held: a request that expired while this call waited is not spent.
    return judgeAndSpend(ctx, state, account, ctx.clock());
  } finally {
    release();
  }
}

function judgeAndSpend(ctx: HelperContext, state: OwnerStateRead, account: string, now: Date): SpendVerdict {
  const pin = readOwnerPinIn(state);
  if (pin.kind !== 'pinned') return { ok: false, why: pin.kind === 'refused' ? `${pin.why}; nothing was spent` : 'no owner seat is pinned on this machine; nothing was spent' };
  let raw: unknown;
  try {
    raw = JSON.parse(ctx.stdin);
  } catch {
    return { ok: false, why: 'the spend is not whole JSON' };
  }
  const judged = judgeSpend(raw, pin, account, now);
  if (!judged.ok) return judged;
  const { record, ask } = judged.input;
  if (state.kind !== 'present' || state.place.shared === undefined) return { ok: false, why: "this account's approval ledger cannot be read; nothing was spent" };
  const spent = spendInLedgerFolder(state.place.ledger, record.request_id, ask.action, {
    request_id: record.request_id, action: ask.action, params_sha256: record.params_sha256, account, signer: judged.signer, at: now.toISOString(),
  });
  if (!spent.ok) return spent;
  return { ok: true, request_id: record.request_id, action: ask.action, params_sha256: record.params_sha256, account, signer: judged.signer };
}

/** The account name of a uid, from the system's user list. */
export function passwdNameOf(uid: number, file = '/etc/passwd'): string | null {
  let text: string;
  try {
    if (statSync(file).size > 4 * 1024 * 1024) return null;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const names = text.split('\n').map((line) => line.split(':')).filter((fields) => fields.length >= 7 && fields[2] === String(uid)).map((fields) => fields[0]!);
  return names.length === 1 ? names[0]! : null;
}

/** The helper's stdout: one verdict line. */
export function verdictLine(verdict: SpendVerdict): string {
  return `${JSON.stringify({ format: OWNER_SPEND_VERDICT_FORMAT, ...verdict })}\n`;
}

/**
 * Reads the helper's whole input from `stream`, at most `max` bytes and within `ms`: one byte
 * more, or a stream still open at the deadline, refuses at once, so no caller holds the helper
 * or fills its memory.
 */
export async function readCappedInput(stream: ReadableStream<Uint8Array>, max: number = OWNER_SPEND_MAX_BYTES, ms: number = OWNER_SPEND_INPUT_MS): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), ms); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'late') return { ok: false, why: 'the spend did not arrive in time; nothing was spent' };
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) return { ok: false, why: 'the spend is larger than one can be; nothing was spent' };
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, why: 'the spend cannot be read; nothing was spent' };
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
