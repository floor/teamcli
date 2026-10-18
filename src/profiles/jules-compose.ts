// Jules's typed delivery: the brief is the task description of a new remote session, so the
// module walks the TUI's own screens — the session table, `/`, the repo list, the task box,
// the create confirmation — and returns the line the CLI printed once the session exists.
// The drop-file trigger every other native seat takes has nowhere to land here: `jules` reads
// no local file, and its work order is created only by that confirm.
//
// Captured from jules 0.1.42 (herdr 0.7.1, a 54x23 pane, 2026-10-17), step by step:
//   * the table's input line is ` > Search sessions or type / to use` at 54 columns and
//     ` > Search sessions or type / to use commands` at 148, and `/` then Enter opens
//     the new-session form, whose repo list is taller than the pane (its head, and its marker
//     when the marker is above the pane's window, are not in `pane read --visible`).
//   * `jules remote list --repo` printed 38 repos, `floor/agents` first and `floor/welcome`
//     last, and the chooser's order is that order: with the list's selection moved to the top
//     first, N Down presses then Enter chose `floor/agents` at N=0, `floor/liquidglass` at N=8,
//     nothing (the `<add a new repo>` row) at N=9, `floor/material` at N=10, `floor/md3.io`
//     at N=12. So a repo at index r sits at row r + floor(r / 9): an `<add a new repo>` row
//     follows every ninth repo. Up does not wrap at the top (50 Ups from the middle ended on
//     the first repo), so a bound of one press per row above the target reaches the top.
//   * Enter on a repo collapses the list to ` Choose a repo` / ` floor/<repo>` and puts the
//     cursor in the task box: ` Type the task description`, a bordered box whose placeholder
//     is `What do you want Jules to work on?`, and the footer
//     `enter: create the session | esc: go back`. Text typed there wraps and the box shows its
//     tail: a 1643-character line ended with `TAILMARK777` visible in the box's last row.
//   * Enter submits the box and draws the confirmation
//     `Create a new remote session based on the description a` (clipped at this width), with
//     `> yes` marked, `  no` under it, and `↑/↓: up/down | enter to select`.
//   * Enter on `yes` creates the session and ends on
//     `Session created: https://jules.google.com/session/<id>` /
//     `Press any key to go back to the session table`.
//   * Escape walks back one screen at a time: confirmation → task box → repo list → table.
//     At the table, `ctrl+c: quit` and no escape is ever pressed there.
//   * at 148 columns the CLI's banner and `Welcome to Jules CLI!` stay on screen above a
//     logged-in table (a 148x39 capture), so the banner marks no state; the table is the
//     footer's, and the login refusal is the failed list's.
//   * logged out, the table is replaced by
//     `Failed to list tasks: ... (did you forget to login?)` /
//     `Jules authentication is required. Please use the /log...`.
import { ComposeError, type ComposeIo, type ComposeProfile } from './compose.ts';

/** How often a wait re-reads the pane. */
const POLL_MS = 250;

/** The gap between navigation keys: slow enough that each press is drawn before the next. */
const KEY_GAP_MS = 120;

/** How long a screen is given to settle after Enter (the collapse, the confirmation). */
const SETTLE_MS = 500;

/** The table's footer, the one mark of "the input is waiting". */
const TABLE_FOOTER = /ctrl\+c: quit/;

/** The expanded repo list's footer. */
const LIST_FOOTER = /enter: select repo/;

/** The collapsed form's header and chosen-repo row: ` Choose a repo` / ` floor/teamcli`. */
const CHOSEN_HEADER = /^ Choose a repo$/;
const CHOSEN_ROW = /^ ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/;

/** The table's input line, ` > <text>` (the placeholder when empty). The placeholder line is
 *  clipped by the pane: 54 columns draw `Search sessions or type / to use`, 148 draw
 *  `Search sessions or type / to use commands`, so its start is what is matched. */
const INPUT_LINE = /^ > (.*)$/;
const INPUT_PLACEHOLDER = /^Search sessions or type \/ to use/;

/** The confirmation screen and its marked choice. */
const CONFIRM_MARK = /enter to select/;
const MARKED_YES = '> yes';
const MARKED_NO = '> no';

/** The created-session proof, and the card's footer (used to leave a card the Enter opened). */
const CREATED = /Session created: (https:\/\/jules\.google\.com\/session\/\S+)/;
const CARD_FOOTER = /enter: select action/;

/** The logged-out screen: the failed task list and its login lines. The CLI's banner is not
 *  one of them — it stays on screen above the table at wide widths, so it proves nothing. */
const LOGGED_OUT: readonly RegExp[] = [
  /Jules authentication is required/,
  /Failed to list tasks/,
  /forget to login\?/,
];

const REPAIR = 'read the pane: leave the CLI at its session table and retry';

function linesOf(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd());
}

function some(lines: readonly string[], pattern: RegExp): boolean {
  return lines.some((line) => pattern.test(line));
}

function anyOf(lines: readonly string[], patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => some(lines, pattern));
}

/** The pane's visible lines, or a ComposeError when it cannot be read. */
function read(io: ComposeIo, typed: boolean): string[] {
  const text = io.text();
  if (text === null) throw new ComposeError('its screen could not be read', REPAIR, typed);
  return linesOf(text);
}

/** The login refusal when the screen is the logged-out one, else null. */
function loggedOut(lines: readonly string[]): ComposeError | null {
  if (!anyOf(lines, LOGGED_OUT)) return null;
  return new ComposeError('its CLI is logged out, and nothing was sent', 'run jules login in its pane, then retry');
}

/**
 * Waits for a screen that `fits`, and hands back its lines. The screen is re-read every
 * `POLL_MS`; the wait is named in the refusal, so a time-out says which screen never came.
 * A logged-out screen at any point is its own refusal.
 */
async function until(
  io: ComposeIo,
  what: string,
  fits: (lines: string[]) => boolean,
  typed: boolean,
  seconds?: number,
): Promise<string[]> {
  const limit = Math.max(1, Math.ceil(((seconds ?? io.idleTimeout) * 1000) / POLL_MS));
  const wait = seconds ?? io.idleTimeout;
  for (let poll = 0; poll < limit; poll++) {
    const text = io.text();
    if (text !== null) {
      const lines = linesOf(text);
      if (fits(lines)) return lines;
      const login = loggedOut(lines);
      if (login !== null) throw new ComposeError(login.message, login.repair, typed);
    }
    await io.wait(POLL_MS);
  }
  throw new ComposeError(`its screen did not show ${what} within ${String(wait)}s`, REPAIR, typed);
}

/** Presses one key, or refuses: a key the pane did not take would silently skip a screen. */
function press(io: ComposeIo, key: string, typed = false): void {
  if (!io.key(key)) throw new ComposeError(`its ${key} key was not taken`, REPAIR, typed);
}

/**
 * Leaves whatever screen the CLI is on and returns its session table. Escape walks back one
 * screen at a time (confirmation → task box → repo list → table), so six presses cover every
 * screen this module can leave; at the table it stops pressing.
 */
async function backToTable(io: ComposeIo): Promise<string[]> {
  for (let attempt = 0; attempt <= 6; attempt++) {
    const text = io.text();
    if (text !== null) {
      const lines = linesOf(text);
      const login = loggedOut(lines);
      if (login !== null) throw login;
      if (some(lines, TABLE_FOOTER)) return lines;
    }
    if (attempt === 6) break;
    press(io, 'escape');
    await io.wait(KEY_GAP_MS * 3);
  }
  throw new ComposeError('its session table did not show', REPAIR);
}

/** The draft the table's input holds, or null. The input line is the pane's first line and
 *  every screen read here keeps it, so a draft is read before anything is typed over it. */
function draftOf(lines: readonly string[]): string | null {
  for (const line of lines) {
    const match = INPUT_LINE.exec(line);
    if (match === null) continue;
    const rest = match[1]!.trim();
    return rest === '' || INPUT_PLACEHOLDER.test(rest) ? null : rest;
  }
  return null;
}

/** The row a repo sits on: one `<add a new repo>` row follows every ninth repo. */
function slotOf(index: number): number {
  return index + Math.floor(index / 9);
}

/** The chosen repo on the collapsed form, or null when the screen is not that form. */
async function chosenRepo(io: ComposeIo): Promise<string | null> {
  const text = io.text();
  if (text === null) return null;
  const lines = linesOf(text);
  const header = lines.findIndex((line) => CHOSEN_HEADER.test(line));
  if (header < 0) return null;
  for (let at = header + 1; at < lines.length; at++) {
    if (lines[at]!.trim() === '') continue;
    const match = CHOSEN_ROW.exec(lines[at]!);
    return match === null ? null : match[1]!;
  }
  return null;
}

/** Moves the selection to the top of the list, then down to the target slot, and presses Enter.
 *  `bound` is one press per row above the target, so it reaches the top from anywhere below. */
async function moveToSlot(io: ComposeIo, bound: number, slot: number): Promise<void> {
  for (let i = 0; i < bound; i++) {
    press(io, 'up');
    await io.wait(KEY_GAP_MS);
  }
  for (let i = 0; i < slot; i++) {
    press(io, 'down');
    await io.wait(KEY_GAP_MS);
  }
  press(io, 'enter');
  await io.wait(SETTLE_MS);
}

/**
 * Selects `repo` in the repo list and proves it on the collapsed form. The list is taller
 * than the pane — its marker can sit above the visible window — so the walk is counted from
 * the top rather than read, and the collapse's ` floor/<repo>` row is the proof. One
 * correction is tried: the list may change under the run (`remote list` and the open form
 * are two reads), and the delta between the chosen repo's slot and the target's is walked.
 */
async function chooseRepo(io: ComposeIo, repo: string, repos: readonly string[]): Promise<void> {
  const target = repos.indexOf(repo);
  const bound = repos.length + Math.ceil(repos.length / 9) + 2;
  await moveToSlot(io, bound, slotOf(target));
  let chosen = await chosenRepo(io);
  if (chosen === repo) return;
  // The collapse did not take, or it took on another row: get back to the list.
  const screen = read(io, false);
  if (!some(screen, LIST_FOOTER)) {
    press(io, 'escape');
    await until(io, 'its repo list', (lines) => some(lines, LIST_FOOTER), false, 15);
  }
  const at = chosen === null ? -1 : repos.indexOf(chosen);
  if (at < 0) {
    await moveToSlot(io, bound, slotOf(target));
  } else {
    const delta = slotOf(target) - slotOf(at);
    for (let i = 0; i < Math.abs(delta); i++) {
      press(io, delta > 0 ? 'down' : 'up');
      await io.wait(KEY_GAP_MS);
    }
    press(io, 'enter');
    await io.wait(SETTLE_MS);
  }
  chosen = await chosenRepo(io);
  if (chosen !== repo) {
    throw new ComposeError(
      `its repo list chose ${chosen === null ? 'no repo' : chosen} instead of ${repo}`,
      `check that ${repo} is still listed by jules remote list --repo, then retry`,
    );
  }
}

/** The message as one line: the box takes a description, and a newline would submit the box. */
function flatten(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/** Letters and digits only, lowercased: the screen's box borders and wrapping fall away. */
function squashed(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Types the brief into the task box and proves the box holds its tail. */
async function typeBrief(io: ComposeIo, flat: string): Promise<void> {
  if (!io.type(flat)) throw new ComposeError('its task box did not take the text', REPAIR, true);
  await io.wait(SETTLE_MS);
  const tail = squashed(flat).slice(-40);
  if (tail.length < 8) return; // too short to tell apart from the screen's own words
  await until(io, 'the brief in its task box', (lines) => squashed(lines.join('\n')).includes(tail), true, 15);
}

/** Presses Enter in the task box, confirms `yes`, and returns the CLI's proof line. */
async function confirmAndCreate(io: ComposeIo, repo: string): Promise<string> {
  press(io, 'enter', true);
  const confirm = await until(io, 'its create-session confirmation', (lines) => some(lines, CONFIRM_MARK), true, 20);
  if (some(confirm, CARD_FOOTER) || some(confirm, TABLE_FOOTER)) {
    throw new ComposeError('its task box was submitted without a confirmation', REPAIR, true);
  }
  const marked = confirm.map((line) => line.trim()).find((line) => line === MARKED_YES || line === MARKED_NO);
  if (marked === undefined) throw new ComposeError('its confirmation marks no choice', REPAIR, true);
  if (marked === MARKED_NO) {
    press(io, 'up', true);
    await io.wait(KEY_GAP_MS);
  }
  press(io, 'enter', true);
  const created = await until(io, `the proof that ${repo} took the brief`, (lines) => some(lines, CREATED), true);
  const proof = created.map((line) => line.trim()).find((line) => CREATED.test(line));
  if (proof === undefined) throw new ComposeError('its created-session line could not be read', REPAIR, true);
  return proof;
}

/** Leaves the pane at the table when it can: the created screen takes any key, and a card the
 *  Enter opened is escaped once. Best effort — the session exists either way. */
async function backToTableQuietly(io: ComposeIo): Promise<void> {
  press(io, 'enter', true);
  for (let poll = 0; poll < 8; poll++) {
    await io.wait(POLL_MS);
    const text = io.text();
    if (text === null) continue;
    const lines = linesOf(text);
    if (some(lines, TABLE_FOOTER)) return;
    if (some(lines, CARD_FOOTER)) {
      if (!io.key('escape')) return;
      await io.wait(KEY_GAP_MS * 3);
    }
  }
}

/**
 * Walks the TUI to a created session and returns its proof line:
 * `Session created: https://jules.google.com/session/<id>`.
 */
export async function compose(io: ComposeIo, message: string): Promise<string> {
  const table = await backToTable(io);
  const draft = draftOf(table);
  if (draft !== null) {
    throw new ComposeError(
      `its table's input holds ${JSON.stringify(draft)}`,
      'clear that line (ctrl+u) or send it in its pane, then retry',
    );
  }
  const { repo, repos } = io.seat;
  if (repo === null) {
    throw new ComposeError(
      "the seat's folder has no git origin to name a Jules repo by",
      'add one (git remote add origin git@github.com:owner/repo.git), then retry',
    );
  }
  if (repos === null) {
    throw new ComposeError('its CLI could not list its repos', 'run jules remote list --repo in its pane, then retry');
  }
  if (!repos.includes(repo)) {
    throw new ComposeError(
      `its repo list does not hold ${repo}`,
      `add ${repo} to the Jules account, then retry`,
    );
  }
  if (!io.type('/')) throw new ComposeError('its input did not take the command', REPAIR);
  await io.wait(KEY_GAP_MS * 2);
  press(io, 'enter');
  await until(io, 'its repo list', (lines) => some(lines, LIST_FOOTER), false, 20);
  await chooseRepo(io, repo, repos);
  const flat = flatten(message);
  if (flat === '') throw new ComposeError('the brief is empty after flattening', REPAIR);
  await typeBrief(io, flat);
  const proof = await confirmAndCreate(io, repo);
  await backToTableQuietly(io);
  return proof;
}

/** How the caller lists the account's repos: `jules remote list --repo` printed one
 *  `owner/repo` per line, alphabetically, `floor/agents` first (38 lines on the account this
 *  was captured from), and the chooser's order was that order. */
export const reposArgs: readonly string[] = ['remote', 'list', '--repo'];

export const profile: ComposeProfile = { module: 'jules-compose.ts', compose, repos: reposArgs };
export default profile;
