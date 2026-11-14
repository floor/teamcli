// The account's side of a spend on a machine whose accounts share one owner: hand the request,
// its signed answer and what is about to run to the owner helper (src/client/owner-spend.ts), and
// act only on a verdict that names exactly what was sent.
import { ownerInstallCommand, ownerStateOf } from './owner-pin-path.ts';
import { OWNER_SPEND_FORMAT, OWNER_SPEND_VERDICT_FORMAT, type SpendInput } from './owner-spend.ts';
import { execOwnerHelper } from './owner-spend-exec.ts';

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether approvals here are spent through the owner helper: a machine whose accounts share one owner, pinned. */
export function ownerSpendShared(home: string): boolean {
  const state = ownerStateOf(home);
  return state.kind === 'present' && state.place.shared !== undefined;
}

/**
 * Asks the helper to spend one approval and reads its verdict. The verdict must name exactly the
 * request id, action and parameter hash sent; anything else spends nothing the account acts on.
 */
export function spendThroughHelper(input: SpendInput): { ok: true; signer: string } | { ok: false; why: string } {
  const sent = JSON.stringify({ format: OWNER_SPEND_FORMAT, record: input.record, answer: input.answer, ask: input.ask });
  let out: { status: number | null; stdout: string };
  try {
    out = execOwnerHelper(sent);
  } catch {
    return { ok: false, why: 'the owner helper cannot be started; nothing was spent' };
  }
  let verdict: unknown;
  try {
    verdict = JSON.parse(out.stdout);
  } catch {
    return { ok: false, why: `the owner helper gave no verdict; if it is not installed, the owner runs, from the administrator's own account: ${ownerInstallCommand()}; nothing was spent` };
  }
  if (!plainObject(verdict) || verdict.format !== OWNER_SPEND_VERDICT_FORMAT) return { ok: false, why: 'the owner helper gave no verdict this build reads; nothing was spent' };
  if (verdict.ok !== true) return { ok: false, why: typeof verdict.why === 'string' ? verdict.why : 'the owner helper refused the spend' };
  if (out.status !== 0 || verdict.request_id !== input.record.request_id || verdict.action !== input.ask.action || verdict.params_sha256 !== input.record.params_sha256 || typeof verdict.signer !== 'string') {
    return { ok: false, why: `the owner helper's verdict does not name request ${input.record.request_id} as it was sent; it does not run` };
  }
  return { ok: true, signer: verdict.signer };
}
