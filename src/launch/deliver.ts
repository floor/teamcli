import { reportedLiveAgent } from './agent.ts';
import { herdrUnreliable, profileFor } from '../profiles/index.ts';
import type { RulesFileWrite } from './rules-file.ts';
import {
  classifyComposer, readBox, readFoldMark, readScreen, type Box, type Screen, type ScreenOptions,
} from '../watch/screen.ts';

/** Why a delivery stopped. Each one is a reading the owner can act on.
 *  - `file`: the seat's rules file could not be written; nothing was typed.
 *  - `path`: the file's path can't be typed provably; nothing was typed.
 *  - `launch`: the CLI itself never appeared as its pane's foreground process — a wrapper's
 *    shell still in front of it, or a launch line that exited; nothing was typed.
 *  - `screen`: the screen was not the idle prompt; nothing was typed.
 *  - `working`: the seat was mid-turn; nothing was typed.
 *  - `leftover`: the box already held text that is not the rules line; nothing typed.
 *  - `typing`: the pane took no text; nothing was typed.
 *  - `read-back`: the line was typed and never read back as its own rows. A line this run typed,
 *    still sitting unsent on an idle CLI, is cleared with the profile's one key.
 *  - `file-changed`: the line read back, but the file no longer held the hash it names; Enter
 *    was not pressed.
 *  - `ack`: Enter was sent and the seat did not come back to its idle prompt. */
export type Stop = 'file' | 'path' | 'launch' | 'screen' | 'working' | 'leftover' | 'typing' | 'read-back' | 'file-changed' | 'ack';

/** Where a delivery stopped, for the report. `kind` is what the screen read at the stop; `typed`
 *  says the line reached the pane; `sent` says Enter was pressed; `row` is the first row drawn
 *  that was not the line's own, kept out of the log and printed to the terminal alone;
 *  `detail` tells the ways a file can fail to be written: a folder of the ladder, the final
 *  name's place, a read-back that didn't match, or any other fault. */
export type Refusal = {
  stop: Stop;
  typed: boolean;
  sent: boolean;
  kind: Screen['kind'];
  row: string | null;
  /** The profile's one clearing key, spelled as the terminal host spells it, when this CLI
   *  has one: the advice names it. Absent or null: the advice says the owner clears the box,
   *  naming no key. */
  clearKey?: string | null;
  /** The exit text this CLI's profile types, set when the box already holds exactly it — an
   *  earlier stop's leftover — so the report names the text and the one key, and nothing is sent. */
  exitText?: string;
  /** Set when this run sent the profile's clearing key for a line it had just typed.
   *  `yes`: the key restored an idle prompt. `undelivered`: the pane did not take the key.
   *  `stayed`: the key was sent and the screen did not come back idle. */
  cleared?: 'yes' | 'undelivered' | 'stayed';
  detail?: 'not-written' | 'changed' | { at: 'folder' | 'place'; what: string };
};

export interface Delivery {
  screen(): string | undefined;
  status(): string | null;
  type(text: string): boolean;
  enter(): boolean;
  /** The profile's one clearing key, by the name the terminal host spells. Absent: a failed
   *  read-back leaves the line where it was typed. */
  key?(name: string): boolean;
  /** Whether the seat's rules file still holds, read without following a link, the text whose
   *  hash the line carries — the last look, directly before Enter. */
  file(): boolean;
  /** Foreground argv0 names, or null when the pane can't be read. */
  foreground(): string[] | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The caller's own last check, immediately before the one terminal input it gates — the
   *  typed line, then every Enter — for the caller that needs it (`answer`): a refusal sends
   *  nothing, and the caller says why in its own words. */
  beforeInput?(action: 'type' | 'enter'): boolean;
  /** Why a delivery stopped, when the caller wants the detail for its report. */
  report?(why: Refusal): void;
}

/** The key as its pane's own screen spells it, for the advice a report gives the owner. The
 *  spelling each CLI draws was read off the captures; the terminal host's name stays in
 *  `clearKey`. */
export function keyName(key: string): string {
  if (key === 'ctrl+c') return 'Ctrl-C';
  if (key === 'ctrl+u') return 'Ctrl+U';
  if (key === 'escape') return 'Esc';
  return 'Backspace';
}

/** The refusal for a rules file that could not be written: nothing was typed, nothing sent, and
 *  the detail carries what the writer found — a folder of the ladder, the final name's place, a
 *  read-back mismatch, or any other fault — for the report. */
export function fileRefusalOf(written: Exclude<RulesFileWrite, { ok: true }>): Refusal {
  const detail = 'what' in written ? { at: written.why, what: written.what } : written.why;
  return { stop: 'file', typed: false, sent: false, kind: 'unknown', row: null, clearKey: null, detail };
}

/** Where the text's next row starts after `pos`, or null when `row` is not the text's row there.
 *  A row that is the text's at that very position is always read as such — that normalises
 *  nothing. A `word` boundary may in addition stand for exactly one space, the one the pane
 *  broke at: never a run of them, never a tab or a newline, so a text whose break hides more
 *  than one space is refused. A `hard` boundary — the composer that breaks mid-word — hides
 *  nothing and reads the text's next characters as the row carries them. Every character inside
 *  a row must match the text as it is: only the row break itself may stand for a space. */
function continues(text: string, pos: number, row: string, kind: 'word' | 'hard' | null): number | null {
  if (text.startsWith(row, pos)) return pos + row.length;
  if (kind === 'hard') return null;
  return text[pos] === ' ' && text.startsWith(row, pos + 1) ? pos + 1 + row.length : null;
}

/** How the box reads back against `text`: `row` is the first row drawn that is not the text's
 *  own (an empty string for a blank row, the drawn row otherwise), and `short` says the text has
 *  content after the box's last row. Both null/false is an exact read. The comparison is the one
 *  `holdsBox` has always made: the first line after the prompt and every continuation row at the
 *  box's own column — no more rows, no fewer, none changed. A continuation row that does not
 *  start at that column is not the text's own row, and a blank row never is: the delivery is
 *  one line, and a row break may stand for at most one space, never a newline — a blank row
 *  belongs to no text this version types.
 *  Only the one space a row break itself may stand for is normalised, and inside a row every
 *  character must match, runs of spaces included. Trailing spaces and tabs after the text's last
 *  row are not observable in a box — a pane may not paint the end of a row — so they are not
 *  required to match. */
function readsBack(text: string, box: Box): { row: string | null; short: boolean } {
  const pad = ' '.repeat(box.indent);
  const rows: string[] = [];
  for (const row of box.rows) {
    if (row === '') return { row, short: false };
    if (!row.startsWith(pad)) return { row, short: false };
    rows.push(row.slice(pad.length));
  }
  const kind = box.wrap?.kind ?? null;
  const visual = [box.first, ...rows];
  let at = 0;
  for (let i = 0; i < visual.length; i++) {
    const row = visual[i] ?? '';
    if (i === 0) {
      if (!text.startsWith(row)) return { row, short: false };
      at = row.length;
      continue;
    }
    if (row === '') return { row, short: false };
    const next = continues(text, at, row, kind);
    if (next === null) return { row, short: false };
    at = next;
  }
  return { row: null, short: !/^[ \t]*$/.test(text.slice(at)) };
}

/** Whether the box shows exactly `text`. A box that is not the text waits and is refused at the
 *  deadline, never entered on trust. */
function holdsBox(text: string, box: Box): boolean {
  const read = readsBack(text, box);
  return read.row === null && !read.short;
}

/** What the box holds right now: `ready` to submit, still rendering (`wait`), or a state that is
 *  never the typed text (`no`). An ordinary box is ready only when its rows read back as
 *  exactly the text typed; a box that folded the paste shows a fold marker, never its rows, so
 *  it waits and is refused at the deadline. Anything else waits, and a wait that outlives the
 *  deadline is a refusal, not an Enter. */
function boxState(cli: string, text: string, screen: string | undefined, options?: ScreenOptions): 'ready' | 'wait' | 'no' {
  const kind = readScreen(cli, screen, options).kind;
  if (kind === 'unsent') {
    const box = readBox(cli, screen, options);
    return box !== null && holdsBox(text, box) ? 'ready' : 'wait';
  }
  return kind === 'idle' ? 'wait' : 'no';
}

/** Whether the pane's box holds exactly `text` right now: an unsent composer, no fold marker, and
 *  rows that read back as the text. The one check the watch's nudge and the exit typing share
 *  with delivery — false for anything not observed, never `true` on trust. A running turn reads
 *  `working` whatever the composer below it holds, so the composer is read on its own there: a
 *  draft typed during a turn is found as the text it is, never missed as an empty box. */
export function boxHoldsText(cli: string, text: string, screen: string | undefined, options?: ScreenOptions): boolean {
  if (readFoldMark(cli, screen)) return false;
  if (screen === undefined) return false;
  const read = readScreen(cli, screen, options);
  const unsent = read.kind === 'unsent'
    || (read.kind === 'working' && classifyComposer(cli, screen.split('\n'), options).kind === 'unsent');
  if (!unsent) return false;
  const box = readBox(cli, screen, options);
  return box !== null && holdsBox(text, box);
}

/** The first row of the box that is not `text`'s own — what the box holds that the text does
 *  not — or null when the box holds exactly `text` or is not readable as a box at all. For the
 *  line that says what is in the box now, with the same row-by-row read the exact check makes. */
export function boxHoldsOther(cli: string, text: string, screen: string | undefined, options?: ScreenOptions): string | null {
  if (readScreen(cli, screen, options).kind !== 'unsent') return null;
  const box = readBox(cli, screen, options);
  if (box === null) return null;
  return holdsBox(text, box) ? null : (readsBack(text, box).row ?? '');
}

/** How long a reading waits for the pane to draw what a send left. `send-text` returns before
 *  the pane renders — a capture taken the instant after a typing still read the idle screen,
 *  and read the text a moment later — so the reading that decides the next key waits, ending
 *  the moment the screen is decisive either way. One length and one wait for the exit typing,
 *  the watch's nudge and delivery alike. */
export const DRAW_WAIT_MS = 5000;

/** The most Enters one rules delivery presses, and how long each one waits for the seat to
 *  show it took the line: 1s, 3s, then 9s. The send leg's own measured bounds (`MAX_TRIES`,
 *  `BACKOFF_MS` in `src/send/deliver.ts`), restated here because that module reads this one. */
export const RULES_ENTER_TRIES = 3;
export const RULES_ENTER_BACKOFF_MS: readonly number[] = [1000, 3000, 9000];

/** The reading that decides a key, waiting out the pane's late drawing: `undrawn` is what the
 *  screen still reads while the send it has not drawn sits behind it — idle after a typing,
 *  unsent after a clearing key. The wait ends the moment the screen is decisive either way,
 *  and at the deadline the screen reads as it reads. A clock that does not advance ends the
 *  wait too: a stuck time must not spin forever on a pane that will never draw. */
export async function settleScreen(
  undrawn: Screen['kind'],
  kindOf: () => Screen['kind'],
  clock: { now(): number; sleep(ms: number): Promise<void> },
): Promise<Screen['kind']> {
  const deadline = clock.now() + DRAW_WAIT_MS;
  for (;;) {
    const kind = kindOf();
    if (kind !== undrawn || clock.now() >= deadline) return kind;
    const before = clock.now();
    await clock.sleep(100);
    if (clock.now() <= before) return kindOf();
  }
}

/** The refusal for a stop at the reading the pane shows now: nothing typed, nothing sent. */
function stopAs(cli: string, stop: Stop, screen: string | undefined): Refusal {
  return { stop, typed: false, sent: false, kind: readScreen(cli, screen).kind, row: null, clearKey: profileFor(cli)?.exitClear ?? null };
}

/** The refusal for a wait that ended with the line typed into the box, whatever the wait: the
 *  first row that did not read back as the line's own. */
function stoppedOn(cli: string, stop: Stop, screen: string | undefined, line: string): Refusal {
  const why = stopAs(cli, stop, screen);
  why.typed = true;
  why.sent = stop === 'ack';
  const box = readBox(cli, screen);
  why.row = box === null ? null : readsBack(line, box).row;
  return why;
}

/** A line this run just typed, whose read-back failed, is cleared with the profile's one key.
 *  Only an unsent composer on an idle CLI that is still the pane's foreground: a key into a
 *  dialog, a turn, or a shell would answer something this run did not type. No key on the
 *  delivery leaves the refusal as it is. */
async function clearTypedLine(cli: string, why: Refusal, io: Delivery): Promise<Refusal> {
  const key = why.clearKey ?? null;
  if (key === null || !io.key) return why;
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(io.foreground(), names);
  // A CLI whose profile says the terminal host cannot report it: that host's missing or
  // `unknown` word is no reading of the seat, and the unsent composer the caller proved is the
  // reading that stands.
  const wordless = () => {
    const status = io.status();
    return herdrUnreliable(cli) && (status === null || status === 'unknown');
  };
  const resting = () => io.status() === 'idle' || io.status() === 'done' || wordless();
  if (readScreen(cli, io.screen()).kind !== 'unsent' || !resting() || !live()) return why;
  if (!io.key(key)) return { ...why, cleared: 'undelivered' };
  const after = await settleScreen('unsent', () => readScreen(cli, io.screen()).kind, io);
  if (after === 'idle' && resting() && live()) return { ...why, cleared: 'yes' };
  return { ...why, cleared: 'stayed', kind: after };
}

/** What the report says the read-back saw: the reading, and the rows the box drew, when the box
 *  was readable. */
function reading(why: Refusal, rows: number): string {
  const drew = rows > 0 ? `, ${rows} row${rows === 1 ? '' : 's'} seen` : '';
  return `the screen read ${why.kind}${drew}`;
}

/** How the advice says the box is cleared: the profile's one key, pressed as its pane spells
 *  it, or — a CLI with no key established — the owner's own hand, naming no key. */
function clearAdvice(why: Refusal, box = 'its box'): string {
  return why.clearKey ? `clear ${box} (${keyName(why.clearKey)})` : `clear ${box}`;
}

/** What the owner does next, per reading. */
function nextStep(why: Refusal): string {
  switch (why.stop) {
    case 'leftover':
      return `press Enter in its pane to send what is there, or ${clearAdvice(why)}, then run up again`;
    case 'typing':
      return `run up again`;
    default:
      break;
  }
  switch (why.kind) {
    case 'permission':
    case 'trust':
    case 'question':
    case 'exit question':
    case 'vendor notice':
    case 'provider error':
    case 'rate limit':
      return `answer it in its pane, then run up again`;
    case 'working':
      return `wait for its turn to finish, then run up again`;
    case 'unsent':
    case 'idle':
      return `read its box, then run up again`;
    default:
      return `read its pane, then run up again`;
  }
}

/** The line a stopped delivery is reported with, and the line the log keeps: the reading and
 *  what the owner does next. It holds no row of the screen — the caller prints `why.row` to the
 *  terminal alone. A line this run typed, whose read-back failed, is the one box `team` clears,
 *  and only with the profile's one key; every other stop leaves its text in the pane, and the
 *  line says so. */
export function refusalReport(why: Refusal): string {
  switch (why.stop) {
    case 'file':
      if (typeof why.detail === 'object' && why.detail.at === 'folder') {
        return `rules not typed: the folder that would hold its rules file is ${why.detail.what}; `
          + `the owner removes or repairs it, then runs up again`;
      }
      if (typeof why.detail === 'object' && why.detail.at === 'place') {
        return `rules not typed: its rules file's place holds ${why.detail.what}; the owner removes it, then runs up again`;
      }
      if (why.detail === 'changed') {
        return `rules not typed: its rules file did not read back as written; check the project state folder, then run up again`;
      }
      return `rules not typed: its rules file could not be written; check the project state folder, then run up again`;
    case 'path':
      return `rules not typed: its rules file's path can't be typed safely: the read-back can't prove a path outside `
        + `letters, digits and . _ / @ + -; rename the seat or move the project, then run up again`;
    case 'launch':
      return `rules not typed: the CLI never appeared as its pane's foreground process (${reading(why, 0)}); `
        + `check the seat's launch line — the wrapper it starts through, or the command itself — then run up again`;
    case 'working':
      return why.typed
        ? `rules typed, not sent: the seat was busy with a turn until the deadline; the line sits in its box, unsent: run up again when it is idle (up sends the line it finds there), or press Enter in its pane once the turn ends`
        : `rules not confirmed: the seat is working; run up again when it is idle`;
    case 'screen':
      return `rules not typed: ${reading(why, 0)}; ${nextStep(why)}`;
    case 'leftover':
      if (why.exitText !== undefined) {
        // The box holds exactly the exit text an earlier stop typed and never confirmed. `up`
        // sends nothing to it: Enter would send the exit, and a clearing key here is the owner's
        // press, not this run's — the line names the text and the one key.
        return why.clearKey
          ? `rules not typed: its box already holds this CLI's exit text (${why.exitText}), unsent from an earlier stop; `
            + `press ${keyName(why.clearKey)} in its pane to clear it, then run up again`
          : `rules not typed: its box already holds this CLI's exit text (${why.exitText}), unsent from an earlier stop; `
            + `clear its box in its pane, then run up again`;
      }
      return `rules not typed: its box already holds text that is not the rules line; ${nextStep(why)}`;
    case 'typing':
      return `rules not typed: the pane took no text (${reading(why, 0)}); ${nextStep(why)}`;
    case 'read-back': {
      const named = why.clearKey ? keyName(why.clearKey) : '';
      const sits = `the line sits in its box, unsent: press Enter in its pane to send it, or ${clearAdvice(why, 'the box')}, then run up again`;
      if (why.cleared === 'yes' && named) {
        return `rules typed, not sent: the read-back didn't match; the line team typed was cleared (${named}); run up again`;
      }
      if (why.cleared === 'undelivered' && named) {
        return `rules typed, not sent: the read-back didn't match; the clearing key (${named}) was not delivered; ${sits}`;
      }
      if (why.cleared === 'stayed' && named) {
        return `rules typed, not sent: the read-back didn't match; the clearing key (${named}) left the screen reading ${why.kind}; ${sits}`;
      }
      return `rules typed, not sent: the read-back didn't match; ${sits}`;
    }
    case 'file-changed':
      return `rules typed, not sent: the rules file changed after it was written`;
    case 'ack':
      // A box that still reads back as exactly the line after Enter never took the key: it sits
      // unsent, and the report says so rather than claiming a send. A box that reads unsent and
      // holds something else is reported as the reading it is: `row` names the first row that is
      // not the line's own.
      return why.typed && why.kind === 'unsent' && why.row === null
        ? `rules typed, not sent: its box still holds the line after Enter; `
          + `press Enter in its pane to send it, or ${clearAdvice(why, 'the box')}, then run up again`
        : `the seat did not come back to its idle prompt (${why.kind}); ${nextStep(why)}`;
  }
}

/** One line is accepted only after working is observed with the composer empty again. The line
 *  is typed once, at an empty idle prompt, read back row by row — every visible character in
 *  order, at most one space hidden at a row break — and Enter is pressed after a re-read, up to
 *  the bounded number of tries while the box still reads back as the line. A box that already
 *  holds exactly today's line is verified and sent, never typed onto again; a box holding
 *  anything else is left alone, and a seat mid-turn is reported as such. A line this run typed
 *  whose rows do not read back is cleared with the profile's one key when the box is still the
 *  unsent composer. */
/** Screens a typed line is never waited past: each asks the seat something, and Enter would answer it. */
const DIALOGS: ReadonlySet<string> = new Set(['trust', 'permission', 'question', 'exit question', 'vendor notice', 'provider error', 'rate limit']);

export async function deliverRules(cli: string, line: string, seconds: number, io: Delivery): Promise<boolean | 'no-agent'> {
  const names = profileFor(cli)?.processNames ?? [];
  const live = () => reportedLiveAgent(io.foreground(), names);
  // The terminal host's word for a CLI its profile reports faithfully. For a CLI the profile
  // says the terminal host cannot report (`herdr_status: unreliable`), a missing or `unknown`
  // status is no reading of the seat at all: the profile's own recognised screen is the reading
  // there, exactly as the watch and status read such a seat. A status the terminal host can
  // give — idle, done, working, blocked — is still its word.
  const wordless = () => {
    const status = io.status();
    return herdrUnreliable(cli) && (status === null || status === 'unknown');
  };
  const free = () => ['idle', 'done'].includes(io.status() ?? '') || wordless();
  const report = (why: Refusal): false => { io.report?.(why); return false; };
  // The CLI may start through a wrapper: a shell runs in the pane first, and the CLI draws
  // behind it. Nothing is typed until the CLI itself is the pane's foreground process and its
  // idle box is up — a line typed into the wrapper's shell would run as a command, not arrive
  // as a message. A dialog at the CLI's first frame, or a seat already mid-turn, is refused at
  // once; anything else is waited out, and a wait that outlives the deadline gives up saying
  // which of the two never came: the CLI itself, or its box.
  const untilUp = io.now() + seconds * 1000;
  let seenLive = false;
  let start: Screen['kind'];
  for (;;) {
    if (live()) {
      seenLive = true;
      const status = io.status();
      start = readScreen(cli, io.screen()).kind;
      if (status === 'working' || start === 'working') {
        return report({ stop: 'working', typed: false, sent: false, kind: 'working', row: null });
      }
      if (start === 'trust' || start === 'permission' || start === 'question' || start === 'exit question' || start === 'vendor notice' || start === 'provider error' || start === 'rate limit') {
        return report(stopAs(cli, 'screen', io.screen()));
      }
      if ((status === 'idle' || status === 'done' || wordless()) && (start === 'idle' || start === 'unsent')) break;
    }
    if (io.now() >= untilUp) {
      return report(seenLive ? stopAs(cli, 'screen', io.screen()) : stopAs(cli, 'launch', io.screen()));
    }
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) {
      return report(seenLive ? stopAs(cli, 'screen', io.screen()) : stopAs(cli, 'launch', io.screen()));
    }
  }
  // The resumed delivery: a box that already holds exactly today's line — the same path, the
  // same hash, the line `team` would type now — is verified and sent. A box holding anything
  // else is left alone: `team` never types a second line onto the first, and never clears a
  // box it did not itself type into this run.
  const resumed = start === 'unsent' && boxState(cli, line, io.screen()) === 'ready';
  // A failed read-back of a line this run typed. A box that already held the line when this
  // run started is not that line: the key stays unsent, and the report says the line sits.
  const readBackStop = async (): Promise<false> => {
    const why = stoppedOn(cli, 'read-back', io.screen(), line);
    if (resumed) return report(why);
    return report(await clearTypedLine(cli, why, io));
  };
  if (!resumed) {
    if (start !== 'idle') {
      // A box holding exactly this CLI's exit text is an earlier stop's leftover, not the
      // owner's half-written line: the report names the text and the one key, and nothing is sent.
      const exitText = profileFor(cli)?.exit;
      if (exitText != null && boxHoldsText(cli, exitText, io.screen())) {
        return report({ ...stopAs(cli, 'leftover', io.screen()), exitText });
      }
      return report(stopAs(cli, 'leftover', io.screen()));
    }
    // The caller's own last check, immediately before the text: a refusal types nothing.
    if (io.beforeInput && !io.beforeInput('type')) return false;
    if (!io.type(line)) return report(stopAs(cli, 'typing', io.screen()));
  }
  const deadline = io.now() + seconds * 1000;
  // Terminal rendering can lag send-text. Never press Enter until the box is verified to hold
  // the line: an ordinary box reads `unsent` and every row of it reads back as the line.
  // A seat that is busy — a turn started under the typed line (a resumed Codex seat working
  // through its queued drops does exactly this), or a status the terminal host could not give —
  // is not a mismatch: the line sits in the composer below the running turn, and Enter there does
  // not submit it. The wait goes on until the seat is free again and the box reads back, and a
  // seat still busy at the deadline is reported as busy with the line left in its box, never
  // cleared: the next `up` finds it there and sends it.
  const busyStop = (): false => report({ ...stoppedOn(cli, 'working', io.screen(), line), typed: true, sent: false });
  for (;;) {
    const busy = !free();
    // One screen read per look: the busy reading and the box are the same frame.
    const screen = busy ? undefined : io.screen();
    const working = !busy && readScreen(cli, screen).kind === 'working';
    const state = busy || working ? 'wait' : boxState(cli, line, screen);
    if (state === 'ready') break;
    // A dialog is never waited past. Any other screen that is not the box yet — a frame the CLI
    // is still drawing (Codex's MCP start-up row on a narrow pane), a reading the grammar does
    // not know — is waited out to the deadline like a box still rendering.
    if (state === 'no' && DIALOGS.has(readScreen(cli, screen).kind)) return readBackStop();
    if (io.now() >= deadline) return busy || working ? busyStop() : readBackStop();
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return busy || working ? busyStop() : readBackStop();
  }
  // Re-read immediately before Enter. The agent is asked again: it may have exited since the
  // line was typed, and a dialog that appeared gets no key; a box that no longer holds the line
  // gets none either. And the file is checked once more, directly before the key: the screen
  // proved the line, so the file must still hold the text whose hash the line names — a file
  // that changed after it was written gets no Enter, whatever now sits at its path.
  if (!live()) return 'no-agent';
  if (!free() || boxState(cli, line, io.screen()) !== 'ready') {
    return readBackStop();
  }
  if (!io.file()) {
    return report({ stop: 'file-changed', typed: true, sent: false, kind: readScreen(cli, io.screen()).kind, row: null });
  }
  // The caller's own last check, immediately before the key: a refusal sends nothing.
  if (io.beforeInput && !io.beforeInput('enter')) return false;
  if (!io.enter()) {
    return readBackStop();
  }
  // A submit the CLI did not take is retried, never typed again: at most RULES_ENTER_TRIES
  // Enters, each after the send leg's own wait, and each gated on the checks the first one
  // passed — the launched CLI still the pane's foreground, the seat free, the box still reading
  // back as exactly the line, the rules file still holding the text its hash names, and the
  // caller's own check. A dialog, a busy seat, a box that changed or a file that moved ends the
  // retries, and the delivery then waits for the acknowledgement it already asked for.
  let enters = 1;
  let retryAt = io.now() + (RULES_ENTER_BACKOFF_MS[0] ?? 1000);
  let retry = true;
  for (;;) {
    const status = io.status();
    const screen = io.screen();
    const composer = screen === undefined ? { kind: 'unknown' as const } : classifyComposer(cli, screen.split('\n'));
    if (status === 'working' && composer.kind === 'idle') return true;
    // The line was submitted and no ready prompt was seen. Nothing about it is confirmed: the
    // box is read as the screen shows it.
    const kind = readScreen(cli, io.screen()).kind;
    // A CLI the terminal host cannot report: its own recognised working screen is the
    // acknowledgement the terminal host's `working` status would have given. The composer must be
    // back to its empty idle row — a box still holding the line is not a submission.
    if (herdrUnreliable(cli) && kind === 'working' && composer.kind === 'idle') return true;
    if (kind === 'trust' || kind === 'permission' || kind === 'question' || kind === 'exit question' || kind === 'vendor notice' || kind === 'provider error' || kind === 'rate limit' || io.now() >= deadline) {
      return report(stoppedOn(cli, 'ack', io.screen(), line));
    }
    if (retry && enters < RULES_ENTER_TRIES && io.now() >= retryAt) {
      if (!live()) return 'no-agent';
      if (!free() || !io.file() || boxState(cli, line, io.screen()) !== 'ready') {
        retry = false;
      } else if (io.beforeInput && !io.beforeInput('enter')) {
        return false;
      } else if (!io.enter()) {
        return readBackStop();
      } else {
        enters += 1;
        retryAt = io.now() + (RULES_ENTER_BACKOFF_MS[enters - 1] ?? 9000);
      }
    }
    const before = io.now();
    await io.sleep(100);
    if (io.now() <= before) return report(stoppedOn(cli, 'ack', io.screen(), line));
  }
}
