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
  | { kind: 'rate limit'; reset: string | null } // a usage limit, with the reset time the
                                     // screen names, or null when it names none
  | { kind: 'unknown' };

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

// The window every pattern sees: the pane's last 20 lines. Styled lines are trimmed only past
// their last escape; the core trims each line's plain form for matching.
function windowOf(lines: string[]): string[] {
  return lines.map((line) => line.trimEnd()).slice(-20);
}

/** The same classification `classify` runs, against a screen that may carry added patterns. */
export function classifyData(data: ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  return classifyLines(data, windowOf(lines), options);
}

/** Every stage, in the core's order. The first one that matches wins. */
export function classify(cli: string | ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (!data) return { kind: 'unknown' };
  return classifyLines(data, windowOf(lines), options);
}

/** The composer alone. A running turn would otherwise hide an empty input box. */
export function classifyComposer(cli: string | ScreenData, lines: string[], options?: ScreenOptions | ReadClock): Screen {
  const data = typeof cli === 'string' ? DATA[cli] : cli;
  if (!data) return { kind: 'unknown' };
  return composeLines(data, windowOf(lines), options);
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
