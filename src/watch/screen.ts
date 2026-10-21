// What a pane's visible text shows, read against the shapes of its CLI. A screen that matches no
// shape is "unknown": never ready, never idle, and never grounds for typing anything.
// The text may keep its ANSI styling, as `herdr pane read --format ansi` reads it: matching
// runs on the plain form, and the styling tells a greyed suggestion from typed text.
import { readFileSync } from 'node:fs';
import { stripSgr } from '../ansi.ts';
import { classifyLines, composerBox, composeLines, foldMarked, foldOf, statusRowOf, type Box, type Fold, type ReadClock, type ScreenOptions } from './screen-core.ts';
import type { ScreenData, VersionRange } from './screen-data.ts';
import { loadScreen } from './screen-file.ts';

export type { Box, Fold, ReadClock, ScreenOptions };

/** The reset time a wall names, as the screen prints it: `kind` is the preposition the CLI's own
 *  sentence uses — `at` for a clock time (`11:00`, `2:10 PM GMT+2`), `in` for a span
 *  (`47h31m`) — so a reader never invents the other one. `value` is the displayed text and
 *  nothing more: no instant is parsed from it, and no timezone is assumed for a zone-less clock. */
export type Reset = { kind: 'at' | 'in'; value: string };

export type Screen =
  | { kind: 'idle' }                 // the idle prompt, with an empty input box
  | { kind: 'working' }              // a turn is running: herdr's status would already be stale
  | { kind: 'unsent' }               // text left in the input box
  | { kind: 'permission' }           // a permission dialog: its owner's to answer
  | { kind: 'trust' }                // a workspace trust question: left unanswered
  | { kind: 'question' }             // a question the agent asked: the operator's to act on
  | { kind: 'exit question' }        // the CLI's own question after the exit text was sent — its
                                     // "stop tasks and exit" one: a stop answers it with the
                                     // profile's `exit_confirm`, when the profile names that key
                                     // and this screen; an operator's to act on otherwise
  | { kind: 'vendor notice' }        // the CLI's own notice, an update screen for one: carried
                                     // only by a captured, versioned record, and never answered
  | { kind: 'provider error' }       // the CLI's provider failed mid-response and the prompt is
                                     // back: a transient error, never typed into
  | { kind: 'rate limit'; reset: Reset | null } // a usage limit, with the reset the screen
                                     // names and how it words it, or null when it names none
  | { kind: 'unknown'; matched?: string } // no shape this CLI's profile reads. `matched` is the
                                     // safety floor's own line when one is on the screen — the
                                     // one piece of an unrecognised prompt a reader may quote
                                     // back (the floor's footer or its numbered choice), never a
                                     // guess at what the dialog says

/** What a screen says a seat is doing, in the state words the readers use: an idle table or a
 *  composer holding text is `idle` (the two the CLI takes a line at), a running turn is
 *  `working`, every other screen the profile reads is `blocked` (someone has to act on it), and
 *  one no profile reads is `unknown`. The four words are the ones a herdr status can carry, so a
 *  profile herdr cannot report can be read with them in place of its word. */
export function screenWord(screen: Screen): 'idle' | 'working' | 'blocked' | 'unknown' {
  if (screen.kind === 'idle' || screen.kind === 'unsent') return 'idle';
  if (screen.kind === 'working') return 'working';
  if (screen.kind === 'unknown') return 'unknown';
  return 'blocked';
}

function load(name: string): ScreenData {
  return loadScreen(readFileSync(new URL(`../profiles/${name}.yaml`, import.meta.url), 'utf8'), undefined, `${name}.yaml`);
}

// Every shipped CLI is data. The core owns the order.
const DATA: Record<string, ScreenData> = {
  'claude-code': load('claude-code'),
  codex: load('codex'),
  cursor: load('cursor'),
  antigravity: load('antigravity'),
  grok: load('grok'),
  gemini: load('gemini'),
  muse: load('muse'),
  jules: load('jules'),
};

/** The shipped screen for a CLI, or null when this version has none. */
export function screenData(cli: string): ScreenData | null {
  return DATA[cli] ?? null;
}

/** The version range a vendor notice's record was captured on, or null when this CLI has none.
 *  A vendor notice exists only as such a record: no record, no vendor notice. */
export function vendorNoticeRange(cli: string): VersionRange | null {
  return DATA[cli]?.vendor_notice?.tested ?? null;
}

// The window the data patterns see: the pane's last 20 lines. Styled lines are trimmed only
// past their last escape; the core trims each line's plain form for matching.
function windowOf(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).slice(-20);
}

// The whole visible screen, for a CLI read by a screen module. Such a CLI draws where it likes,
// and jules draws its session card at the very top of the pane, above eighteen blank rows: the
// last-20 window never holds the card's status. The read ends its last row with a newline, and
// that newline is not a row, so it is dropped. The module owns the reading and the core still
// owns the stage order and the floor, which can only add caution.
function wholeOf(lines: string[]): string[] {
  const trimmed = lines.map((line) => line.trimEnd());
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

// What a profile's reading may see: the whole screen for a CLI whose reading is a module, the
// window for data.
function linesFor(data: ScreenData, lines: string[]): string[] {
  return data.whole_screen === true ? wholeOf(lines) : windowOf(lines);
}

/** The same classification `classify` runs, against a screen that may carry added patterns. */
export function classifyData(data: ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  return classifyLines(data, linesFor(data, lines), options);
}

/** Every stage, in the core's order. The first one that matches wins. */
export function classify(cli: string | ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (!data) return { kind: 'unknown' };
  return classifyLines(data, linesFor(data, lines), options);
}

/** The composer alone. A running turn would otherwise hide an empty input box. */
export function classifyComposer(cli: string | ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (!data) return { kind: 'unknown' };
  return composeLines(data, linesFor(data, lines), options);
}

export function readScreen(cli: string | ScreenData, screen: string | undefined, options?: ScreenOptions | ReadClock): Screen {
  if (screen === undefined) return { kind: 'unknown' };
  return classify(cli, screen.split('\n'), options);
}

/** The folded form of a paste the pane's composer shows, or null. The shape only; the caller
 *  verifies it holds the text it typed before trusting it. */
export function readFold(cli: string | ScreenData, screen: string | undefined): Fold | null {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (data === undefined || screen === undefined) return null;
  return foldOf(data, windowOf(screen.split('\n')));
}

/** Whether the pane shows a fold marker at all, whatever count it names. The case `readFold`
 *  cannot report — a marker claiming zero hidden rows — must still keep an Enter from taking the
 *  box for an ordinary unsent one. */
export function readFoldMark(cli: string, screen: string | undefined): boolean {
  const data = DATA[cli];
  if (data === undefined || screen === undefined) return false;
  return foldMarked(data, windowOf(screen.split('\n')));
}

/** The input box the composer draws for its current text, or null when it does not read `unsent`.
 *  The box's rows are the rows the pane drew for the text; the caller compares them to the text
 *  it typed before any Enter. */
export function readBox(cli: string, screen: string | undefined, options?: ScreenOptions): Box | null {
  const data = DATA[cli];
  if (data === undefined || screen === undefined) return null;
  return composerBox(data, windowOf(screen.split('\n')), options);
}

/** The one line a quota figure may come from: the composer's own status row, in the pane's last
 * 20 lines, read plain — a figure is never styled. Null for a CLI with no status line, and for
 * a window that shows no status row — a dialog, a question, a trust screen, a shell or an
 * unknown one reads no figures. */
export function statusRow(cli: string | ScreenData, screen: string | undefined, options?: ScreenOptions): string | null {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (data === undefined || screen === undefined) return null;
  return statusRowOf(data, windowOf(stripSgr(screen).split('\n')), options);
}
