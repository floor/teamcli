// A send's quota preflight: a pane whose screen the receiving CLI reads as a usage wall holds
// the send before any drop file, socket frame or typed key, so nothing lands on a dead turn.
// The wall is the CLI's own screen, so the read is the watch's classifier: only a positively
// classified rate limit holds. A pane that cannot be read, or a CLI with no profile, decides
// nothing here — the send keeps its existing delivery-time cautions — and that gap is named,
// never called safe. The host's own status word is not consulted: a wall the screen proves is a
// wall while the terminal host still calls the seat working.
//
// A limit line above a readable current prompt is history, and that decision belongs to the
// screen reader. The reader clears it only when a prompt it can read sits under the line and
// every window on the status row shows quota left. Any window with none left, a missing row,
// or a prompt the composer cannot read leaves the wall. This preflight does not read the
// status row on its own: a row with quota left and no current prompt is still the wall the
// reader named.
import { TOKEN_SKIP } from '../quota/token-fallback.ts';
import { readScreen, type Reset } from '../watch/screen.ts';

/** The wall a pane's text shows. `reset` is the displayed text with the preposition the CLI's
 *  own sentence uses, or null when the screen names no time. */
export type QuotaOut = { reset: Reset | null; outOfTokens?: true };

/** The wall a pane's text shows, or null. `text` is the pane as the terminal host reads it;
 *  undefined or null is no read at all, and never a wall. A rate-limit reading stands. The
 *  screen reader has already dropped a limit line it can place above a readable prompt whose
 *  status row shows quota left in every window; this function does not drop one the reader
 *  kept. */
export function quotaOutOf(cli: string, text: string | null | undefined): QuotaOut | null {
  if (text === null || text === undefined || text === '') return null;
  const screen = readScreen(cli, text);
  if (screen.kind !== 'rate limit') return null;
  if (screen.reason === 'out of tokens') return { reset: null, outOfTokens: true };
  return { reset: screen.reset };
}

/** The refusal's detail: the account the seat spends when the file names one (its own
 *  `account:` or a vendor), the reset exactly as the screen words it — `at` a clock, `in` a
 *  span — or an explicit "names no reset time", and the fact that nothing was sent, so a
 *  refused send never reads as one. */
export function quotaOutDetail(seat: { account?: string | null; vendor?: string | null } | undefined, quota: QuotaOut): string {
  if (quota.outOfTokens === true) return TOKEN_SKIP;
  const account = seat?.account ?? seat?.vendor ?? '';
  const on = account === '' ? '' : ` on ${account}`;
  if (quota.reset === null) return `quota out${on}; the screen names no reset time; nothing was sent`;
  return `quota out${on}, resets ${quota.reset.kind} ${quota.reset.value}; nothing was sent`;
}
