// One alias ask: a signed drop through the command's send, that send's own wake, a wait, and
// a verify before anything is returned. This module holds no key and types nothing. The send
// seam is admitted as the asking principal. A provided type writer is never called.
import {
  mailboxRouterPolicyProblem,
  type MailboxRouterPolicy,
} from './policy.ts';

/** A bridge call's synchronous wait. Past this the caller hears "not answered yet" and the
 *  reply can still land in the mailbox before the record bound. */
export const BRIDGE_WAIT_MS = 120_000;

/** How often a wait looks for the reply. Tests advance their own clock by this step. */
const POLL_MS = 1_000;

export type MailboxAskCaller = 'bridge' | 'client';

/** What one send reported. `woken` false is a definite miss: the drop was written and no leg
 *  took it. A refusal wrote no drop and is not a miss. */
export type MailboxSendResult =
  | { ok: true; messageId: string; woken: boolean }
  | { ok: false; why: string };

export type MailboxReplyRead =
  | { verified: true; bytes: string }
  | { verified: false }
  | null;

/** The line the asker is shown. A verified reply has bytes and no line. */
export type MailboxAskSync =
  | { kind: 'reply'; bytes: string; messageId: string }
  | { kind: 'not-woken'; messageId: string; line: 'queued, not woken' }
  | { kind: 'not-yet'; messageId: string; line: 'not answered yet' }
  | { kind: 'unanswered'; messageId: string }
  | { kind: 'refused'; why: string };

export type MailboxAskResult = {
  /** The seat the drop was addressed to. The fallback's seat, when that send was the one kept. */
  seat: string | null;
  wakeTaken: boolean;
  replyVerified: boolean;
  sync: MailboxAskSync;
  /** The signed record placed in the asker's mailbox, when a reply verified. */
  mailbox: { messageId: string; bytes: string } | null;
};

export type MailboxAskInput = {
  askId: string;
  alias: string;
  body: string;
  /** The asking principal. The send is admitted as this identity, never as the daemon. */
  principal: string;
  caller: MailboxAskCaller;
  policy: MailboxRouterPolicy;
  /** The seat's unread window, in seconds. Twice this is the bound when the policy sets none. */
  unreadWindowSeconds: number;
  now(): number;
  sleep(ms: number): Promise<void>;
  send(input: { principal: string; to: string; body: string }): Promise<MailboxSendResult>;
  readReply(messageId: string): MailboxReplyRead;
  writeMailbox(input: { principal: string; messageId: string; bytes: string }): void;
  /** Called once, when the synchronous answer is known. A bridge call hears it at 120s, while
   *  the record wait continues to the bound. */
  onSync?(sync: MailboxAskSync): void;
  /** Present so a scene can prove this module never types. It is not called. */
  typeText?: (pane: string, text: string) => boolean;
};

/** One child's ask ids. A second call with the same id returns the first result and does not
 *  send again. */
export type MailboxAskLedger = Map<string, Promise<MailboxAskResult>>;

function boundMs(policy: MailboxRouterPolicy, unreadWindowSeconds: number): number {
  const seconds = policy.replyBoundSeconds ?? unreadWindowSeconds * 2;
  return seconds * 1_000;
}

function deskSeat(address: string): boolean {
  return address.startsWith('desk@');
}

function refused(why: string): MailboxAskResult {
  return {
    seat: null,
    wakeTaken: false,
    replyVerified: false,
    sync: { kind: 'refused', why },
    mailbox: null,
  };
}

function notWoken(messageId: string, seat: string, wakeTaken: boolean): MailboxAskResult {
  return {
    seat,
    wakeTaken,
    replyVerified: false,
    sync: { kind: 'not-woken', messageId, line: 'queued, not woken' },
    mailbox: null,
  };
}

async function waitForReply(
  input: MailboxAskInput,
  sent: { messageId: string; seat: string },
  started: number,
  limit: number,
  tell: (sync: MailboxAskSync) => void,
): Promise<MailboxAskResult> {
  let announced: MailboxAskSync | null = null;
  for (;;) {
    const reply = input.readReply(sent.messageId);
    if (reply !== null && reply.verified === false) {
      const sync: MailboxAskSync = { kind: 'unanswered', messageId: sent.messageId };
      tell(sync);
      return {
        seat: sent.seat,
        wakeTaken: true,
        replyVerified: false,
        sync,
        mailbox: null,
      };
    }
    if (reply !== null && reply.verified) {
      input.writeMailbox({
        principal: input.principal,
        messageId: sent.messageId,
        bytes: reply.bytes,
      });
      const sync = announced ?? { kind: 'reply' as const, bytes: reply.bytes, messageId: sent.messageId };
      tell(sync);
      return {
        seat: sent.seat,
        wakeTaken: true,
        replyVerified: true,
        sync,
        mailbox: { messageId: sent.messageId, bytes: reply.bytes },
      };
    }
    const elapsed = input.now() - started;
    if (elapsed >= limit) break;
    if (announced === null && input.caller === 'bridge' && elapsed >= BRIDGE_WAIT_MS) {
      announced = { kind: 'not-yet', messageId: sent.messageId, line: 'not answered yet' };
      tell(announced);
    }
    await input.sleep(Math.min(POLL_MS, limit - elapsed));
  }
  const sync = announced ?? { kind: 'not-woken' as const, messageId: sent.messageId, line: 'queued, not woken' as const };
  tell(sync);
  return {
    seat: sent.seat,
    wakeTaken: true,
    replyVerified: false,
    sync,
    mailbox: null,
  };
}

async function runOnce(input: MailboxAskInput): Promise<MailboxAskResult> {
  let told = false;
  const tell = (sync: MailboxAskSync): void => {
    if (told) return;
    told = true;
    input.onSync?.(sync);
  };
  const problem = mailboxRouterPolicyProblem(input.policy);
  if (problem !== null) {
    const result = refused(problem);
    tell(result.sync);
    return result;
  }
  const route = input.policy.routes.find((candidate) => candidate.alias === input.alias);
  if (route === undefined) {
    const result = refused(`there is no route for ${input.alias}`);
    tell(result.sync);
    return result;
  }
  if (deskSeat(route.address) || (route.fallback !== null && deskSeat(route.fallback))) {
    const result = refused(`${input.alias} names the desk seat, which is not a route`);
    tell(result.sync);
    return result;
  }
  const first = await input.send({
    principal: input.principal,
    to: route.address,
    body: input.body,
  });
  if (!first.ok) {
    const result = refused(first.why);
    tell(result.sync);
    return result;
  }
  if (first.woken) {
    return waitForReply(input, { messageId: first.messageId, seat: route.address }, input.now(), boundMs(input.policy, input.unreadWindowSeconds), tell);
  }
  if (route.fallback === null) {
    const result = notWoken(first.messageId, route.address, false);
    tell(result.sync);
    return result;
  }
  const second = await input.send({
    principal: input.principal,
    to: route.fallback,
    body: input.body,
  });
  if (!second.ok) {
    const result = refused(second.why);
    tell(result.sync);
    return result;
  }
  if (!second.woken) {
    const result = notWoken(second.messageId, route.fallback, false);
    tell(result.sync);
    return result;
  }
  return waitForReply(
    input,
    { messageId: second.messageId, seat: route.fallback },
    input.now(),
    boundMs(input.policy, input.unreadWindowSeconds),
    tell,
  );
}

/** Runs one ask. The same id returns the first run's result and does not send again. */
export function askMailbox(ledger: MailboxAskLedger, input: MailboxAskInput): Promise<MailboxAskResult> {
  const existing = ledger.get(input.askId);
  if (existing !== undefined) return existing;
  const run = runOnce(input);
  ledger.set(input.askId, run);
  return run;
}
