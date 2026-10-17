// The Jules TUI, read by a screen module instead of data patterns. Its session table puts the
// input line at the very top of the pane and the table under it, so the composer row sits
// outside the last-20-line window every stage reads: what the window does hold is the table's
// own footer, and that footer is drawn only while the table — and its input — is on screen.
//
// Captured from jules 0.1.42 (herdr 0.7.1, a 54x23 pane):
//   * the table's footer wraps at this width as
//       ` enter: select session | ctrl+r: refresh |` / `ctrl+d: delete | ctrl+c: quit`
//   * its input line reads ` > Search sessions or type / to use` when empty, and
//       ` > unsent probe text` once text is typed — the line the window cannot see.
//   * a row of the session list at 120 columns (a wider pane, captured locally) ends in its
//     status cell: `...  4m45s ago                             │` for no status, and
//       `...  7m16s ago        Awaiting User Feed   │`, `...  18h4m46s ago     Completed            │`.
//     At 54 columns the status cell is drawn blank, so the list itself reads no status there.
//   * the detail card of a running session draws `│floor/agents  26s ago  Planning             │`;
//     the card of a finished one draws `Completed` in the same cell.
//   * the repo chooser's footer reads `↑/↓: up/down | enter: select repo | /:` / `filter | esc: go back`,
//     the task box's `enter: create the session | esc: go back`, the confirm dialog's
//     `↑/↓: up/down | enter to select`, and the created screen prints
//     `Session created: https://jules.google.com/session/<id>` /
//     `Press any key to go back to the session table`.
//   * logged out, the table is replaced by `Failed to list tasks: Trying to make a GET` /
//     `request without a valid client (did you` / `forget to login?)` and the bottom line
//     `Jules authentication is required. Please use the /log`.
import type { ComposerReading, ScreenProfile } from '../watch/screen-profile.ts';

/** The session table's footer. Drawn only on the table screen, below the list and above the
 *  `Working in:` line, so it is the one stable mark of "the input is waiting". */
const TABLE_FOOTER = /ctrl\+c: quit/;

/** A list row or the detail card's body row: a box side, then anything but the table's own
 *  borders. The table's column-header border (`│╭─────╮…`) and its labels (`││ ID  │…`) are
 *  written with a doubled side and read as neither. */
const ROW = /^│[^│╭╰─]/;

/** The list's repo separator, `│          # floor/agents                           │`. */
const SEPARATOR = /#\s+[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/;

/** The remote session states a run saw while the session was not over: `Planning`, and
 *  `Awaiting User Feedback`, which at 54 columns wraps as `Awaiting User` / `Feedback` on the
 *  card's next line. `Completed` is the finished one and is not in this set. The status sits
 *  after the age cell and is separated from it by two spaces, so a description that happens to
 *  carry one of these words — it is drawn on the card's first row, never after two spaces —
 *  never decides. */
const WORKING_CELL = /(?:\s{2}Planning|\s{2}Awaiting User(?: Feed(?:back)?)?|^│Feedback)\s*│\s*$/;

/** Screens the compose module walks, and the logged-out table. None of them is a prompt: a
 *  brief typed here would land in whatever the CLI draws next, so each reads unknown. The
 *  markers are the screens' own footers and banners, all inside the last-20-line window. */
const TRANSITIONAL: readonly RegExp[] = [
  /enter: select repo/, // the repo chooser
  /enter: create the session/, // the task box
  /enter to select/, // the create-session confirmation
  /Session created: https:\/\/jules\.google\.com\/session\//,
  /Press any key to go back to the session table/,
  /Failed to list tasks/,
  /forget to login\?/,
  /Jules authentication is required/,
  /Welcome to Jules CLI!/,
];

export const profile: ScreenProfile = {
  unknown(lines: string[]): boolean {
    return TRANSITIONAL.some((pattern) => lines.some((line) => pattern.test(line)));
  },

  /**
   * The seat works while the session the operator has opened is still running, and reads idle
   * on a `Completed` one. Only the detail card decides, never the list: the list groups sessions
   * by repo for the whole account, and a run left a `Planning` row and an `Awaiting User F…` row
   * standing for hours after their sessions had stopped moving — a list row does not say which
   * session is this seat's. The card holds exactly one session, opened with `enter` on the list.
   */
  working(lines: string[]): boolean {
    if (lines.some((line) => TABLE_FOOTER.test(line))) return false;
    return lines.some((line) => ROW.test(line) && !SEPARATOR.test(line) && WORKING_CELL.test(line));
  },

  /**
   * The table's input is ready when the table is. Its input line is the pane's first line and
   * `classifyLines` sees the last 20, so the footer is the reading: the TUI draws it only on
   * the table, and the table takes a brief only while its input has the focus. A typed line in
   * that input cannot be told from the empty one at this window; the compose module reads the
   * whole screen and refuses a line it finds there.
   */
  composer(lines: string[]): ComposerReading {
    return lines.some((line) => TABLE_FOOTER.test(line)) ? { kind: 'idle' } : { kind: 'unknown' };
  },
};

export default profile;
