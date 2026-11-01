// The one home of the three dialog kinds a seat may be answered at: a question the agent asked,
// a plan it is waiting to execute, and a confirmation the CLI or the agent raises before acting.
// `team answer` reads a dialog through this module alone, so its two fresh reads compare one
// shape, and the launch profile data naming what each vendor turns off imports the same list.
//
// The screen is a reading the caller already has, never a read made here: the watch's
// `StatusSource` (src/watch/status-events.ts) supplies it through its adapter's one `readPane`
// injection point, a watch pass through `Live.screens`, and the launch through its `Host`. This
// module imports no terminal-host command. A seat-state layer above may report a dialog from a
// structured event without a screen at all; this reader is then the fallback it uses when it has
// one, and a screen no profile reads stays `unknown`, never `idle`.
import type { ScreenData } from './screen-data.ts';
import { classify, questionTextReading, screenData } from './screen.ts';

export const DIALOG_KINDS = ['question', 'plan approval', 'confirmation'] as const;

export type DialogKind = (typeof DIALOG_KINDS)[number];

/** What a fresh read of a pane says about a dialog: none, or the kind, its question text, and
 *  whether that text is the whole block. `complete: false` is a block the profile's supported
 *  rows cut: the text is what was visible of it, and an answerer refuses it rather than acting
 *  on part of the question. `{ dialog: null }` covers both a screen that is no dialog and a
 *  dialog kind whose text could not be read — a reader that cannot quote the question does not
 *  act on it. */
export type DialogReading = { dialog: null } | { dialog: DialogKind; text: string; complete: boolean };

export function isDialogKind(kind: string): kind is DialogKind {
  return (DIALOG_KINDS as readonly string[]).includes(kind);
}

/** One fresh read of a screen: its kind, the question text when the kind is answerable and the
 *  profile can place it, and whether that text reaches the block's end. The screen is read as
 *  the whole string the pane handed over, so the caller's second read is made the same way as
 *  its first. */
export function readDialog(cli: string | ScreenData, screen: string | undefined): DialogReading {
  const none: DialogReading = { dialog: null };
  const data = typeof cli === 'string' ? screenData(cli) : cli;
  if (data === null || screen === undefined) return none;
  const kind = classify(data, screen.split('\n')).kind;
  if (!isDialogKind(kind)) return none;
  const reading = questionTextReading(data, screen);
  if (reading === null || reading.text === '') return none;
  return { dialog: kind, text: reading.text, complete: reading.complete };
}
