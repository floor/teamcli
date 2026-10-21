// A send's quota preflight: a pane whose screen the receiving CLI reads as a usage wall holds
// the send before any drop file, socket frame or typed key, so nothing lands on a dead turn.
// The wall is the CLI's own screen, so the read is the watch's classifier: only a positively
// classified rate limit holds. A pane that cannot be read, or a CLI with no profile, decides
// nothing here — the send keeps its existing delivery-time cautions — and that gap is named,
// never called safe. The host's own status is not consulted: a wall the screen proves is a
// wall while the terminal host still calls the seat working.
import { readScreen, type Reset } from '../watch/screen.ts';

/** The wall a pane's text shows. `reset` is the displayed text with the preposition the CLI's
 *  own sentence uses, or null when the screen names no time. */
export type QuotaOut = { reset: Reset | null };

/** The wall a pane's text shows, or null. `text` is the pane as the terminal host reads it;
 *  undefined or null is no read at all, and never a wall. */
export function quotaOutOf(cli: string, text: string | null | undefined): QuotaOut | null {
  if (text === null || text === undefined || text === '') return null;
  const screen = readScreen(cli, text);
  return screen.kind === 'rate limit' ? { reset: screen.reset } : null;
}

/** The refusal's detail: the account the seat spends when the file names one (its own
 *  `account:` or a vendor), the reset exactly as the screen words it — `at` a clock, `in` a
 *  span — or an explicit "names no reset time", and the fact that nothing was sent, so a
 *  refused send never reads as one. */
export function quotaOutDetail(seat: { account?: string | null; vendor?: string | null } | undefined, quota: QuotaOut): string {
  const account = seat?.account ?? seat?.vendor ?? '';
  const on = account === '' ? '' : ` on ${account}`;
  if (quota.reset === null) return `quota out${on}; the screen names no reset time; nothing was sent`;
  return `quota out${on}, resets ${quota.reset.kind} ${quota.reset.value}; nothing was sent`;
}
