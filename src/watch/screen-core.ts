// The screen core. Stage order, dialog primitives, the four composer modes and the
// safety floor live here, never in a profile. A profile is data: it can add a
// pattern, and it cannot move a stage or turn the floor off.
import { allDimAfter, hasSgr, stripSgr } from '../ansi.ts';
import type { Reset, Screen } from './screen.ts';
import type { BlockStep, LinePattern, Rule, ScreenData, Wrap } from './screen-data.ts';

export type { BlockStep, Composer, FallbackRule, LinePattern, Placeholder, PlaceholderStyle, Rule, ScreenData, Stage, Wrap } from './screen-data.ts';
export type { ScreenProfile, ComposerReading } from './screen-profile.ts';
import type { ComposerReading } from './screen-profile.ts';

const BUDGET_MS = 100;

/** Whether a regular expression source is anchored at both ends to match a line whole. */
function anchored(source: string): boolean {
  if (!source.startsWith('^') || !source.endsWith('$')) return false;
  let slashes = 0;
  for (let i = source.length - 2; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
}

// The rule a `below_last_rule` pattern has to sit under. It is the core's, not the profile's.
const RULE_LINE = /^\s*[─━]{8,}\s*$/;

// The safety floor's markers, matched without case: a dialog's wording is not always title-case
// (`Press enter to confirm or esc to cancel`). RFC 0002 § 4.1 permits it.
const FLOOR_PHRASES = ['do you want to', 'esc to cancel', 'enter confirm', 'enter continue', 'esc quit', 'esc skip', '↑/↓'];

export type ReadClock = { now(): number; budgetMs: number };

export type ScreenOptions = {
  cwd?: string | null;
  home?: string;
  clock?: ReadClock;
};

function screenClock(options?: ScreenOptions | ReadClock): ReadClock | undefined {
  if (!options) return undefined;
  if ('now' in options || 'budgetMs' in options) return options as ReadClock;
  return options.clock;
}

function screenExpectedCwd(options?: ScreenOptions | ReadClock): string | null | undefined {
  if (!options || 'now' in options || 'budgetMs' in options) return undefined;
  return options.cwd;
}

function screenHome(options?: ScreenOptions | ReadClock): string | undefined {
  if (!options || 'now' in options || 'budgetMs' in options) return undefined;
  return options.home;
}

/**
 * The furthest the `  →` input row may sit above the status row. Measured over every Cursor
 * fixture that draws a composer — the idle, startup, unsent, working, thinking, queue and typed
 * frames, old and new — the row is three to five lines above the status row (idle three, unsent
 * four, the wrapped and blank-middle boxes five); no captured frame draws more. A row further
 * above is not the input row the frame draws, and the position test fails closed.
 */
const MAX_STATUS_INPUT_GAP = 5;

/** A line matches the composer's status grammar — any of the status line's patterns. */
function statusMatches(composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>, line: string): boolean {
  return composer.statusLine.some((pattern) => pattern.test(line));
}

/**
 * Whether the line at `at` is the composer's status row. Where the profile pins the row's place
 * (`status_below`), a line that carries the grammar is the row only when the line directly under
 * it matches the workspace pattern and is the pane's last non-empty one, and the `  →` input row
 * sits above it within the captured distance. A line matching the field's `except` is read as the
 * profile read it before the field existed — by its grammar, wherever it is. Everywhere else (no
 * `status_below` in the profile) the grammar alone decides, as before.
 */
function statusRowAt(
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  lines: string[],
  at: number,
): boolean {
  const line = lines[at] ?? '';
  if (!statusMatches(composer, line)) return false;
  const below = composer.statusBelow;
  if (!below) return true;
  if (below.except?.test(line)) return true;
  const under = lines[at + 1];
  if (under === undefined || !below.line.test(under)) return false;
  for (let i = at + 2; i < lines.length; i++) if ((lines[i] ?? '').trim()) return false;
  let low = at - 1;
  while (low >= 0 && !composer.prompt.test(lines[low] ?? '')) low--;
  return low >= 0 && at - low <= MAX_STATUS_INPUT_GAP;
}

/**
 * The index of the composer's status line in the window, or -1. A `status-last` composer pins it
 * as the last non-blank line; a `status-then-one` composer allows one chrome line below it, and
 * a composer that declares `chrome` allows only a line matching that vocabulary: the pane's own
 * hint row, never text the seat printed, so a status-shaped line followed by arbitrary output is
 * never read as the row a quota figure comes from. Where the profile pins the row's place, a
 * candidate that is not in its place is ordinary text: the scan skips it (the lines below a
 * lower candidate are then not the frame a place needs, so a higher one fails too). A row the
 * profile exempts from the place test keeps the trailing rule the other profiles read it by.
 * The classification and the quota read both take their line from here, so the two cannot
 * disagree about which line the composer's status line is.
 */
function statusIndex(
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  lines: string[],
  allowOneTrailing: boolean,
  tick: () => boolean,
  expectedCwd?: string | null,
  home?: string,
): number | 'stop' {
  const chrome = composer.mode === 'status-then-one' ? composer.chrome : undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return 'stop';
    if (!statusMatches(composer, lines[i] ?? '')) continue;
    if (composer.statusBelow && !composer.statusBelow.except?.test(lines[i] ?? '')) {
      if (statusRowAt(composer, lines, i)) return i;
      continue;
    }
    const trailing = lines.slice(i + 1).filter((line) => line.trim());
    if (allowOneTrailing) {
      if (trailing.length === 0) return i;
      if (trailing.some((line) => composer.prompt.test(line))) return -1;
      if (trailing.length === 1) {
        if (chrome !== undefined && !chrome.some((pattern) => pattern.test(trailing[0] ?? ''))) return -1;
        return i;
      }
      // Multiple trailing lines: a declared chrome vocabulary names exactly one row, so more
      // than one line below the status row is never the pane's chrome.
      if (chrome !== undefined) return -1;
      // Whole-line grammar matching foreground_cwd
      if (expectedCwd) {
        let joined = trailing.map((l) => l.trim()).join('');
        if (home && (joined === '~' || joined.startsWith('~/'))) {
          joined = home.replace(/\/+$/, '') + joined.slice(1);
        }
        if (joined === expectedCwd) return i;
      }
      return -1;
    } else if (trailing.length > 0) return -1;
    return i;
  }
  return -1;
}

/**
 * The one line a quota figure may be read from: the composer's own status row, or null when the
 * window shows none. A dialog, a transcript line, the input box — anything the seat printed or
 * typed — is never the row. The caller still has to know the screen is a composer screen.
 *
 * A box composer draws its status row under the box's closing rule — the rule the classification
 * itself reads (`boxToRule`'s own last rule row) — so the row is the last line under that rule
 * matching the profile's `status` grammar, and a grammar-less box reads none. The box itself
 * sits above the rule: a line the seat typed cannot be the row, wherever the box's text wraps.
 */
export function statusRowOf(data: ScreenData, lines: string[], options?: ScreenOptions): string | null {
  const composer = data.composer;
  if (composer.mode === 'box-to-rule') {
    if (composer.status.length === 0) return null;
    let close = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (ruleRun(composer, lines[i] ?? '') !== null) {
        close = i;
        break;
      }
    }
    if (close < 0) return null;
    for (let i = lines.length - 1; i > close; i--) {
      if (composer.status.some((pattern) => pattern.test(lines[i] ?? ''))) return lines[i] ?? null;
    }
    return null;
  }
  if (composer.mode !== 'status-last' && composer.mode !== 'status-then-one') return null;
  const at = statusIndex(composer, lines, composer.mode === 'status-then-one', () => false, options?.cwd, options?.home);
  return at === 'stop' || at < 0 ? null : (lines[at] ?? null);
}

export type Fold = { count: number; rows: string[]; width: number };

/** The input box a composer draws for its current text: the first line after the prompt, the
 *  continuation rows under it, the column those rows start at (the prompt's own width plus
 *  the separator the input row draws), and the profile's wrap rule when a capture shows how
 *  the box continues a line onto its next row. */
export type Box = { first: string; indent: number; rows: string[]; wrap?: Wrap };

/**
 * The fold-shaped frame a window shows, or null: the marker row and the count it names (any
 * integer, zero included), the tail rows below it, the box's two rules around both, and a footer
 * under the bottom one. The top rule's width is the width the text wrapped at. The shape alone;
 * whether the fold holds the typed text is the caller's to verify.
 */
function foldFrame(data: ScreenData, lines: string[]): Fold | null {
  const composer = data.composer;
  if (composer.mode !== 'two-rules-footer-below' || !composer.fold) return null;
  let marker = -1;
  let found: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const hit = composer.fold.exec(lines[i] ?? '');
    if (hit) { marker = i; found = hit; break; }
  }
  if (marker < 0 || !found) return null;
  // The frame, as the capture draws it (folded-rules.txt): the box's opening rule at the pane's
  // first column — the profile's rule pattern is anchored to it — sits directly above the
  // marker, and the box's closing rule is the window's last rule row, drawn at the opening
  // rule's own width. A rule-looking row between the marker and the closing rule is a tail row
  // then, content that cannot match the typed text's own rows; a rule row where the capture
  // draws none — directly above the opening rule, or at a width the opening rule does not have
  // — leaves the read unable to tell the frame from content, and it fails closed.
  let top = -1;
  for (let i = marker - 1; i >= 0; i--) {
    if (composer.rule.test(lines[i] ?? '')) { top = i; break; }
  }
  if (top < 0) return null;
  if (top > 0 && composer.rule.test(lines[top - 1] ?? '')) return null;
  for (let i = top + 1; i < marker; i++) {
    if ((lines[i] ?? '').trim()) return null;
  }
  let bottom = -1;
  for (let i = lines.length - 1; i > marker; i--) {
    if (composer.rule.test(lines[i] ?? '')) { bottom = i; break; }
  }
  if (bottom < 0) return null;
  const width = (lines[top] ?? '').trim().length;
  if ((lines[bottom] ?? '').trim().length !== width) return null;
  const rows = lines.slice(marker + 1, bottom).filter((line) => line.trim());
  if (rows.length === 0) return null;
  if (!lines.slice(bottom + 1).some((line) => composer.footers.some((pattern) => pattern.test(line)))) return null;
  const count = Number(found[1]);
  if (!Number.isInteger(count)) return null;
  return { count, rows, width };
}

/**
 * The fold a `two-rules-footer-below` composer's window shows, or null. A marker whose count is
 * zero names no hidden rows to compare against, so it is no fold; it is still a marker, and
 * `foldMarked` catches it.
 */
export function foldOf(data: ScreenData, lines: string[]): Fold | null {
  const frame = foldFrame(data, lines);
  if (frame === null || frame.count < 1) return null;
  return frame;
}

/**
 * Whether the window shows a fold marker at all, whatever count it names: a marker claiming zero
 * hidden rows (or a count a fold could not have) is still a box that is not showing the whole
 * text, and it must never be taken for an ordinary unsent box and submitted unverified.
 */
export function foldMarked(data: ScreenData, lines: string[]): boolean {
  return foldFrame(data, lines) !== null;
}

type Hit = { kind: Screen['kind']; from: number; input: number; rows?: string[] } | { kind: 'unknown' } | { kind: 'stop' };

/** `lines` is already the window: the last 20 lines, each keeping any ANSI styling. Matching
 *  runs on each line's plain form, trimmed at the end; the styled form is kept for the one
 *  question styling can answer, whether the composer's input line is all dim. */
function plainLines(lines: string[]): string[] {
  return lines.map((line) => stripSgr(line).trimEnd());
}

const SCREEN_KINDS: ReadonlySet<string> = new Set<Screen['kind']>([
  'idle',
  'working',
  'unsent',
  'permission',
  'trust',
  'question',
  'exit question',
  'vendor notice',
  'provider error',
  'rate limit',
  'unknown',
]);

type PredicateOutcome = 'match' | 'miss' | 'fail';

function getProfileFn(profile: unknown, key: string): ((lines: string[]) => unknown) | undefined | 'fail' {
  if (!profile || (typeof profile !== 'object' && typeof profile !== 'function')) return undefined;
  try {
    const fn = (profile as Record<string, unknown>)[key];
    if (fn === undefined || fn === null) return undefined;
    if (typeof fn !== 'function') return 'fail';
    return fn as (lines: string[]) => unknown;
  } catch {
    return 'fail';
  }
}

function evalPredicate(predicate: unknown, lines: string[]): PredicateOutcome {
  if (predicate === 'fail') return 'fail';
  if (typeof predicate !== 'function') return 'fail';
  try {
    const res = (predicate as Function)(lines);
    if (res && (typeof res === 'object' || typeof res === 'function') && typeof (res as any).catch === 'function') {
      try {
        (res as any).catch(() => {});
      } catch {}
      return 'fail';
    }
    if (res === true) return 'match';
    if (res === false) return 'miss';
    return 'fail';
  } catch {
    return 'fail';
  }
}

function callComposer(composer: unknown, lines: string[]): Hit {
  if (composer === 'fail') return { kind: 'unknown' };
  if (typeof composer !== 'function') return { kind: 'unknown' };
  try {
    const reading = (composer as Function)(lines);
    if (reading && (typeof reading === 'object' || typeof reading === 'function') && typeof (reading as any).catch === 'function') {
      try {
        (reading as any).catch(() => {});
      } catch {}
      return { kind: 'unknown' };
    }
    if (!reading || typeof reading !== 'object') return { kind: 'unknown' };
    let kind: unknown;
    try {
      kind = (reading as any).kind;
    } catch {
      return { kind: 'unknown' };
    }
    if (typeof kind !== 'string' || !SCREEN_KINDS.has(kind)) {
      return { kind: 'unknown' };
    }
    return {
      kind: kind as Screen['kind'],
      from: 0,
      input: -1,
    };
  } catch {
    return { kind: 'unknown' };
  }
}

type StageName = 'unknown' | 'trust' | 'permission' | 'exit_question' | 'question' | 'vendor_notice' | 'provider_error' | 'rate_limit' | 'working';

/** The kind a stage reads as. A stage is named for the profile (vendor_notice); a screen kind is
 *  what the run prints (vendor notice). */
function kindOfStage(name: StageName): Screen['kind'] {
  if (name === 'vendor_notice') return 'vendor notice';
  if (name === 'provider_error') return 'provider error';
  if (name === 'rate_limit') return 'rate limit';
  return name === 'exit_question' ? 'exit question' : name;
}

/** The reset time a rate-limit window names, from the phrase the seat printed, with the
 *  preposition the phrase itself uses. Null when the window matches the limit and does not name
 *  a time. Three phrases are known: Claude Code's `Your limit will reset at 11:00`, Gemini's
 *  `Access resets at 2:10 PM GMT+2.` — its trailing period is the sentence's, not the time's —
 *  and the reported `Resets in 47h31m` form. A dialog draws the sentence inside a box, so the
 *  time stops at the box's closing border. The value stays the printed text: no instant is
 *  parsed and no zone is assumed. */
const RESET_PHRASES: { kind: Reset['kind']; pattern: RegExp }[] = [
  { kind: 'at', pattern: /Your limit will reset at\s+([^│|]+?)\.?\s*(?:[│|]\s*)?$/ },
  { kind: 'at', pattern: /Access resets at\s+([^│|]+?)\.?\s*(?:[│|]\s*)?$/ },
  { kind: 'in', pattern: /Resets in\s+([^│|]+?)\.?\s*(?:[│|]\s*)?$/ },
  // Codex's plan messages end `… or try again at 3:05 PM.` / `Try again at Oct 23rd, 2026
  // 3:05 PM.`; the source formats a local clock, and the value stays that printed text.
  { kind: 'at', pattern: /\b[Tt]ry again at\s+([^│|]+?)\.?\s*(?:[│|]\s*)?$/ },
];

function resetOf(lines: string[], region?: Set<number>): Reset | null {
  for (const [at, line] of lines.entries()) {
    if (region !== undefined && !region.has(at)) continue;
    for (const phrase of RESET_PHRASES) {
      const found = phrase.pattern.exec(line);
      const value = found?.[1]?.trim();
      if (value) return { kind: phrase.kind, value };
    }
  }
  return null;
}

function asScreen(kind: Screen['kind'], lines: string[], region?: Set<number>): Screen {
  if (kind === 'rate limit') return { kind, reset: resetOf(lines, region) };
  return { kind };
}

/** `lines` is already the window: the last 20 lines, each trimmed at the end. */
export function classifyLines(data: ScreenData, lines: string[], clockOrOptions?: ScreenOptions | ReadClock): Screen {
  try {
    const clock = screenClock(clockOrOptions);
    const expectedCwd = screenExpectedCwd(clockOrOptions);
    const home = screenHome(clockOrOptions);
    const now = clock?.now ?? Date.now;
    const budget = clock?.budgetMs ?? BUDGET_MS;
    const start = now();
    const tick = () => now() - start > budget;
    const plain = plainLines(lines);
    const live = () => liveRegion(data, plain, lines, tick, expectedCwd, home);
    const edge = (patterns: LinePattern[]) => composerEdgeBlock(data, plain, lines, tick, patterns, expectedCwd, home);

    // Rule (a): Every hatch predicate is monotone toward caution: hatch OR data, for working,
    // every dialog (trust, permission, the CLI's own exit question, question, a vendor notice,
    // a provider error, a rate limit) and unknown. The data stage of a
    // profile always runs; a hatch predicate can only add a match. A hatch can only add caution,
    // never remove it.
    // The exit question reads before the ordinary question on purpose: its footer is one an
    // ordinary question carries, so the stage a stop may answer must win over the kind it must
    // never answer. The order is the core's; a profile cannot move it.
    const cautionStages: [StageName, ScreenData['trust']][] = [
      ['unknown', data.unknown],
      ['trust', data.trust],
      ['permission', data.permission],
      ['exit_question', data.exit_question],
      ['question', data.question],
      ['vendor_notice', data.vendor_notice],
      ['provider_error', data.provider_error],
      ['rate_limit', data.rate_limit],
      ['working', data.working],
    ];
    for (const [name, stage] of cautionStages) {
      const kind = kindOfStage(name);
      if (tick()) return { kind: 'unknown' };
      const fn = getProfileFn(data.profile, name);
      if (fn !== undefined) {
        const outcome = evalPredicate(fn, plain);
        if (outcome === 'match') return asScreen(kind, plain);
        if (outcome === 'fail') return { kind: 'unknown' };
      }
      if (stage) {
        for (const rule of stage.rules) {
          const hit = ruleMatches(data, plain, rule, tick, live, edge);
          if (hit === 'stop') return { kind: 'unknown' };
          // An `at_composer` match draws its reset from the same block, so a stale phrase
          // elsewhere on the pane cannot date a wall it does not belong to.
          if (hit) {
            const block = rule.atComposer ? edge([...(rule.any ?? []), ...(rule.all ?? [])]) : null;
            return asScreen(kind, plain, block === null ? undefined : new Set(block));
          }
        }
      }
    }

    // Composer stage: comes from hatch OR from data (refused if both at load).
    const composerFn = getProfileFn(data.profile, 'composer');
    if (composerFn !== undefined) {
      const composed = callComposer(composerFn, plain);
      if (composed.kind === 'stop' || composed.kind === 'unknown') return failedComposer(data, plain, tick);
      const marked = floorHits(plain, 0, -1, data.chrome, tick);
      if (marked) return floorScreen(marked);
      return asScreen(composed.kind, plain);
    }

    const composed = compose(data, plain, lines, tick, expectedCwd, home);
    if (composed.kind === 'stop' || composed.kind === 'unknown') return failedComposer(data, plain, tick);
    if (composed.kind !== 'idle' && composed.kind !== 'unsent') return asScreen(composed.kind, plain);
    const marked = floorHits(plain, composed.from, composed.input, data.chrome, tick);
    if (marked) return floorScreen(marked);
    return asScreen(composed.kind, plain);
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The composer alone, for a turn that is still running. The dialog stages and
 * floor must not be overridden by composer readings returning idle or unsent.
 */
export function composeLines(data: ScreenData, lines: string[], clockOrOptions?: ScreenOptions | ReadClock): Screen {
  try {
    const clock = screenClock(clockOrOptions);
    const expectedCwd = screenExpectedCwd(clockOrOptions);
    const home = screenHome(clockOrOptions);
    const now = clock?.now ?? Date.now;
    const budget = clock?.budgetMs ?? BUDGET_MS;
    const start = now();
    const tick = () => now() - start > budget;
    const plain = plainLines(lines);
    const live = () => liveRegion(data, plain, lines, tick, expectedCwd, home);
    const edge = (patterns: LinePattern[]) => composerEdgeBlock(data, plain, lines, tick, patterns, expectedCwd, home);

    const composerFn = getProfileFn(data.profile, 'composer');
    if (composerFn !== undefined) {
      // Profile has a HATCH composer (no data composer).
      // Check if any caution stage (data or hatch) matches:
      const stages: [StageName, ScreenData['trust']][] = [
        ['unknown', data.unknown],
        ['trust', data.trust],
        ['permission', data.permission],
        ['exit_question', data.exit_question],
        ['question', data.question],
        ['vendor_notice', data.vendor_notice],
        ['provider_error', data.provider_error],
        ['rate_limit', data.rate_limit],
        ['working', data.working],
      ];
      for (const [kind, stage] of stages) {
        if (tick()) return { kind: 'unknown' };
        const fn = getProfileFn(data.profile, kind);
        if (fn !== undefined) {
          const outcome = evalPredicate(fn, plain);
          if (outcome === 'match' || outcome === 'fail') return { kind: 'unknown' };
        }
        if (stage) {
          for (const rule of stage.rules) {
            const hit = ruleMatches(data, plain, rule, tick, live, edge);
            if (hit === 'stop') return { kind: 'unknown' };
            if (hit) return { kind: 'unknown' };
          }
        }
      }
      const composed = callComposer(composerFn, plain);
      if (composed.kind === 'stop' || composed.kind === 'unknown') return failedComposer(data, plain, tick);
      const marked = floorHits(plain, 0, -1, data.chrome, tick);
      if (marked) return floorScreen(marked);
      return asScreen(composed.kind, plain);
    }

    // Profile has a DATA composer.
    // Check hatch dialog predicates:
    const dialogKinds: StageName[] = ['unknown', 'trust', 'permission', 'exit_question', 'question', 'vendor_notice', 'provider_error', 'rate_limit'];
    for (const kind of dialogKinds) {
      if (tick()) return { kind: 'unknown' };
      const fn = getProfileFn(data.profile, kind);
      if (fn !== undefined) {
        const outcome = evalPredicate(fn, plain);
        if (outcome === 'match' || outcome === 'fail') return { kind: 'unknown' };
      }
    }
    // Also if hatch working returns 'fail', fail safe:
    const workingFn = getProfileFn(data.profile, 'working');
    if (workingFn !== undefined) {
      const outcome = evalPredicate(workingFn, plain);
      if (outcome === 'fail') return { kind: 'unknown' };
    }

    if (data.unknown) {
      for (const rule of data.unknown.rules) {
        const hit = ruleMatches(data, plain, rule, tick, live, edge);
        if (hit === 'stop') return { kind: 'unknown' };
        if (hit) return { kind: 'unknown' };
      }
    }
    // A provider error or a rate limit above an idle box is not a free composer: the box read
    // stays unknown, the same as a dialog, so nothing types from the composer alone.
    for (const stage of [data.provider_error, data.rate_limit]) {
      if (!stage) continue;
      for (const rule of stage.rules) {
        const hit = ruleMatches(data, plain, rule, tick, live, edge);
        if (hit === 'stop' || hit) return { kind: 'unknown' };
      }
    }

    const composed = compose(data, plain, lines, tick, expectedCwd, home);
    if (composed.kind === 'stop' || composed.kind === 'unknown') return failedComposer(data, plain, tick);
    if (composed.kind !== 'idle' && composed.kind !== 'unsent') return asScreen(composed.kind, plain);
    const marked = floorHits(plain, composed.from, composed.input, data.chrome, tick);
    if (marked) return floorScreen(marked);
    return asScreen(composed.kind, plain);
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The input box a composer draws for its current text, or null when the composer does not read
 * `unsent`: an idle box holds nothing, and every other shape is not the box. The rows are the
 * ones the mode's own frame delimits — between the prompt row and the box's closing line; the
 * `status-then-one` fallback (the captured completion frame) delimits nothing, so its box is
 * its one input row, the popup rows below it being its filter's to exclude. The caller compares
 * the box to the text it typed; nothing here decides that.
 */
export function composerBox(data: ScreenData, lines: string[], options?: ScreenOptions): Box | null {
  if (!data.composer || data.profile?.composer) return null;
  const plain = plainLines(lines);
  const hit = compose(data, plain, lines, () => false, options?.cwd, options?.home);
  if (hit.kind === 'stop' || hit.kind === 'unknown') return null;
  if (hit.kind !== 'unsent') return null;
  const input = plain[hit.input] ?? '';
  const found = data.composer.prompt.exec(input);
  if (!found) return null;
  let rest = input.slice(found[0].length);
  const suffix: RegExp | null | undefined = 'stripSuffix' in data.composer ? data.composer.stripSuffix : undefined;
  if (suffix) rest = rest.replace(suffix, '');
  const indent = found[0].length + rest.length - rest.trimStart().length;
  const rows = hit.rows ?? [];
  // The pane draws empty rows of its own under the text, inside the box's frame — the drop
  // before the status line, or before the closing rule. The captures name them per profile
  // (`frame_rows`), and only those are stripped: they are the box's frame, not its content.
  // Every row after them stays, so a box that shows an empty row the typed text does not have
  // is not the typed text, and the caller refuses it.
  let frame = data.composer.frameRows;
  while (frame > 0 && rows.length > 0 && rows[rows.length - 1] === '') {
    rows.pop();
    frame -= 1;
  }
  return { first: rest.trimStart(), indent, rows, wrap: 'wrap' in data.composer ? data.composer.wrap : undefined };
}

/**
 * The rows a `live` rule's patterns are read on: the composer's own region — every row from its
 * frame to the window's end, the box's rows, rules and footers among them — and the transcript
 * above it. A profile whose CLI draws a turn-end row closes a turn there: the live transcript is
 * what follows the last turn-end row above the frame, so a sentence a completion already ended
 * is history, while a fresh sentence after the completion is still the live screen. The row is
 * looked for across the whole transcript above the frame, not only its newest block, so a
 * completion followed by the blank margin the captures draw and a right-aligned notice still
 * closes its turn; with no turn-end row above the frame nothing has proved any of that
 * transcript history, and all of it is live — an error with no completion after it is the
 * screen whether or not the margin carries a notice. The turn-end is only looked for above the
 * frame: a box's own rows are typed text, never a completion. A profile that names no turn-end
 * row keeps its newest non-blank block above the frame, as it always has. Null when the composer
 * cannot be read, and the rule then reads the whole window, as a rule without `live` does.
 */
function liveRegion(
  data: ScreenData,
  plain: string[],
  styled: string[],
  tick: () => boolean,
  expectedCwd?: string | null,
  home?: string,
): Set<number> | null {
  const hit = compose(data, plain, styled, tick, expectedCwd, home);
  if (hit.kind === 'stop' || hit.kind === 'unknown') return null;
  const region = new Set<number>();
  for (let i = Math.max(0, hit.from); i < plain.length; i++) region.add(i);
  let hi = hit.from - 1;
  while (hi >= 0 && !(plain[hi] ?? '').trim()) hi--;
  let start = 0;
  if (data.turnEnd === undefined) {
    start = hi;
    while (start >= 0 && (plain[start] ?? '').trim()) start--;
    start++;
  } else {
    for (let i = hi; i >= 0; i--) {
      if (data.turnEnd.test(plain[i] ?? '')) {
        start = i + 1;
        break;
      }
    }
  }
  for (let i = start; i <= hi; i++) region.add(i);
  return region;
}

/**
 * The block an `at_composer` rule's patterns are read on: the rows directly above the composer's
 * frame, read as one contiguous block — the blank margin under it skipped, blanks inside it
 * allowed — walking up from the last non-blank row while every non-blank row matches at least
 * one of the rule's patterns, and stopping at the first row that does not (or at the profile's
 * turn-end row). One printed value row — no letters, at least one digit, the clock Claude Code
 * wraps onto its own row under `Your limit will reset at` — may sit directly above the frame and
 * is kept in the block, though its value is never read as the reset. So a notice drawn in one
 * row, in two rows as a sentence and its reset, or as a sentence whose value wrapped below it, is
 * the wall; a quoted sentence with any later prose between it and the box leaves the adjacent row
 * non-matching and the block empty. Null when the composer cannot be read: adjacency has nothing
 * to anchor on then, and the rule reads the whole window as one without the field does.
 */
function composerEdgeBlock(
  data: ScreenData,
  plain: string[],
  styled: string[],
  tick: () => boolean,
  patterns: LinePattern[],
  expectedCwd?: string | null,
  home?: string,
): number[] | null {
  if (patterns.length === 0) return null;
  const hit = compose(data, plain, styled, tick, expectedCwd, home);
  if (hit.kind === 'stop' || hit.kind === 'unknown') return null;
  const block: number[] = [];
  let at = hit.from - 1;
  while (at >= 0 && !(plain[at] ?? '').trim()) at--;
  let continued = false;
  while (at >= 0) {
    if (tick()) return null;
    const line = plain[at] ?? '';
    if (!line.trim()) {
      at--;
      continue;
    }
    if (data.turnEnd?.test(line)) break;
    const row = patterns.some((pattern) => matches(data, plain, at, pattern, tick, true) === true);
    if (!row) {
      if (continued || block.length > 0 || !printedValueRow(line)) break;
      continued = true;
      block.push(at);
      at--;
      continue;
    }
    block.push(at);
    at--;
  }
  return block;
}

/** A row that prints only a value — at least one digit and no letter — as a reset time wrapped
 *  off the sentence's last row does. Prose always carries a letter, and a second such row does
 *  not continue a notice, so a quote followed by later text still ends the adjacent block. */
function printedValueRow(line: string): boolean {
  return /\d/.test(line) && !/\p{L}/u.test(line);
}

function ruleMatches(data: ScreenData, lines: string[], rule: Rule, tick: () => boolean, live?: () => Set<number> | null, edge?: (patterns: LinePattern[]) => number[] | null): boolean | 'stop' {
  const where = rule.onFooter ? [footerLine(data, lines)] : lines;
  const inWindow = where === lines;
  // A `live` rule's patterns are read on the live region alone, so a sentence the transcript
  // has scrolled past is not the dialog. A region the composer cannot place leaves the whole
  // window, as a rule without the field reads it.
  // An `at_composer` rule reads the block directly above the composer's frame — and only when a
  // composer frame can be read. With no readable frame the adjacency has nothing to anchor on,
  // and the rule reads the whole window as it did before the field existed: a wall that was
  // held is still held, never reclassified as a free prompt.
  let region: Set<number> | null = null;
  if (rule.atComposer && inWindow) {
    const patterns = [...(rule.any ?? []), ...(rule.all ?? [])];
    const block = edge?.(patterns) ?? null;
    if (block !== null) region = new Set(block);
  } else if (rule.live && inWindow) {
    region = live?.() ?? null;
  }
  if (rule.any) {
    const hit = anyLine(data, where, rule.any, tick, inWindow, region ?? undefined);
    if (hit === 'stop') return 'stop';
    if (!hit) return false;
  }
  if (rule.all) {
    for (const pattern of rule.all) {
      const hit = lineSomewhere(data, where, pattern, tick, inWindow, region ?? undefined);
      if (hit === 'stop') return 'stop';
      if (!hit) return false;
    }
  }
  if (rule.footer !== undefined) {
    if (footerLine(data, lines) !== rule.footer) return false;
  }
  if (rule.withoutRule) {
    if (tick()) return 'stop';
    if (findLast(lines, (line) => RULE_LINE.test(line)) >= 0) return false;
  }
  if (rule.belowLastRule) {
    if (tick()) return 'stop';
    // A pattern sits below a composer rule. A window with no rule line is not
    // below one: a dialog that fills the pane says so with `without_rule`.
    const ruleAt = findLast(lines, (line) => RULE_LINE.test(line));
    if (ruleAt < 0) return false;
    const at = findLast(lines, (line) => rule.belowLastRule?.test(line) ?? false);
    if (at < 0 || at <= ruleAt) return false;
  }
  if (rule.noneAfter) {
    const anchor = lastAnchor(data, lines, rule.noneAfter.anchor, tick);
    if (anchor === 'stop') return 'stop';
    if (anchor < 0) return false;
    for (let i = anchor + 1; i < lines.length; i++) {
      for (const pattern of rule.noneAfter.patterns) {
        const later = matches(data, lines, i, pattern, tick, true);
        if (later === 'stop') return 'stop';
        if (later) return false;
      }
    }
  }
  if (rule.onlyAfter) {
    const anchor = lastAnchor(data, lines, rule.onlyAfter.anchor, tick);
    if (anchor === 'stop') return 'stop';
    if (anchor < 0) return false;
    // The block's own tail, and nothing else: the first non-blank row that is not one of
    // the patterns means the screen carries another dialog's rows below this block, so the
    // block is not the live one. Blank rows are the spacing a dialog draws. The patterns are
    // read in their own order — the order the block draws them — so a tail whose named rows
    // are shuffled is not that block's tail either. A block that draws fewer rows than the
    // patterns name (a dialog a short pane clipped) skips one and is still in order.
    let seen = -1;
    for (let i = anchor + 1; i < lines.length; i++) {
      if (!(lines[i] ?? '').trim()) continue;
      let at = -1;
      for (const [p, pattern] of rule.onlyAfter.patterns.entries()) {
        const row = matches(data, lines, i, pattern, tick, true);
        if (row === 'stop') return 'stop';
        if (row) {
          at = p;
          break;
        }
      }
      if (at < 0) return false;
      if (at < seen) return false;
      seen = at;
    }
  }
  if (rule.block) {
    const hit = blockMatches(data, lines, rule.block, tick);
    if (hit === 'stop') return 'stop';
    if (!hit) return false;
  }
  return true;
}

/** The rows a numbered menu draws — a run of rows a block fills with its own text never draws
 *  one, so a choice row the block does not name is not a row of that run. */
const MENU_ROW = /^(?:[❯›>]\s*)?\d+\.\s/;

/**
 * A `block` rule: the dialog read as one contiguous block of rows, from the last row that
 * matches its first step to the screen's last non-blank line. Every row the block draws is
 * compared whole — after the frame's own indentation — against the captured text, so a row
 * with anything on it the capture does not carry is not that row; the blanks are the spacing
 * the block draws; and the `list` run is the rows it fills with its own text, bounded by what
 * the block names: a blank, a row the block draws (in any alternative), a numbered menu row
 * and a row already read are none of them rows of that run. A block whose rows are not the
 * screen's own bottom — one of its rows changed, dropped, doubled or moved, another dialog's
 * row under it, or the same row drawn twice — is not this block, and the screen reads as the
 * ordinary question it then is.
 */
function blockMatches(data: ScreenData, lines: string[], steps: BlockStep[], tick: () => boolean): boolean | 'stop' {
  if (tick()) return 'stop';
  const first = steps[0];
  if (first === undefined || !('row' in first)) return false;
  // The block's first row is the last row that matches it: a transcript above the live dialog
  // may quote the same row, and the dialog that follows it is the one the block reads.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() === first.row) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  const named = new Set<string>();
  blockRows(steps, named);
  const ends = blockEnds(lines, steps, 0, start, new Set(), named, tick);
  if (ends === 'stop') return 'stop';
  for (const end of ends) {
    // The block runs to the screen's last line: only blanks may follow its own last row.
    let open = true;
    for (let i = end.at; i < lines.length; i++) {
      if ((lines[i] ?? '').trim()) {
        open = false;
        break;
      }
    }
    if (open) return true;
  }
  return false;
}

/** Every row the block draws, in any alternative: the rows its `list` run may not hold. */
function blockRows(steps: BlockStep[], into: Set<string>): void {
  for (const step of steps) {
    if ('row' in step) into.add(step.row);
    else if ('oneOf' in step) for (const alt of step.oneOf) blockRows(alt, into);
  }
}

type BlockEnd = { at: number; seen: Set<string> };

/**
 * Where the block's steps can end, read in place: each path carries the rows it has read, so a
 * repeated row fails the path. `si === steps.length` ends at whatever row the steps reached —
 * the caller decides whether that is the screen's bottom. A `list` run is tried one row longer
 * at a time, so a row the steps below it draw is reached rather than swallowed; an alternative
 * is followed by the steps after it, so the row a tail draws is read by the block, not by the
 * run.
 */
function blockEnds(lines: string[], steps: BlockStep[], si: number, li: number, seen: Set<string>, named: Set<string>, tick: () => boolean): BlockEnd[] | 'stop' {
  if (tick()) return 'stop';
  if (si === steps.length) return [{ at: li, seen }];
  const step = steps[si];
  if (step === undefined) return [];
  if ('row' in step) {
    const line = lines[li];
    if (line === undefined) return [];
    const text = line.trim();
    if (text !== step.row || seen.has(text)) return [];
    const next = new Set(seen);
    next.add(text);
    return blockEnds(lines, steps, si + 1, li + 1, next, named, tick);
  }
  if ('blank' in step) {
    const line = lines[li];
    if (line === undefined || line.trim() !== '') return [];
    return blockEnds(lines, steps, si + 1, li + 1, seen, named, tick);
  }
  if ('list' in step) {
    const ends: BlockEnd[] = [];
    const run = new Set(seen);
    for (let at = li; at < lines.length; at++) {
      const text = (lines[at] ?? '').trim();
      if (!text || run.has(text) || MENU_ROW.test(text) || named.has(text)) break;
      run.add(text);
      const rest = blockEnds(lines, steps, si + 1, at + 1, new Set(run), named, tick);
      if (rest === 'stop') return 'stop';
      ends.push(...rest);
    }
    return ends;
  }
  const ends: BlockEnd[] = [];
  for (const alt of step.oneOf) {
    const inner = blockEnds(lines, alt, 0, li, seen, named, tick);
    if (inner === 'stop') return 'stop';
    for (const end of inner) {
      const rest = blockEnds(lines, steps, si + 1, end.at, end.seen, named, tick);
      if (rest === 'stop') return 'stop';
      ends.push(...rest);
    }
  }
  return ends;
}

/** The last row an anchor pattern matches: a block's bottom edge, read from below. */
function lastAnchor(data: ScreenData, lines: string[], anchor: LinePattern, tick: () => boolean): number | 'stop' {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    const hit = matches(data, lines, i, anchor, tick, true);
    if (hit === 'stop') return 'stop';
    if (hit) at = i;
  }
  return at;
}

function anyLine(data: ScreenData, lines: string[], patterns: LinePattern[], tick: () => boolean, inWindow = true, region?: Set<number>): boolean | 'stop' {
  for (const pattern of patterns) {
    const hit = lineSomewhere(data, lines, pattern, tick, inWindow, region);
    if (hit === 'stop') return 'stop';
    if (hit) return true;
  }
  return false;
}

function lineSomewhere(data: ScreenData, lines: string[], pattern: LinePattern, tick: () => boolean, inWindow = true, region?: Set<number>): boolean | 'stop' {
  for (let i = 0; i < lines.length; i++) {
    if (region !== undefined && !region.has(i)) continue;
    const hit = matches(data, lines, i, pattern, tick, inWindow);
    if (hit === 'stop') return 'stop';
    if (hit) return true;
  }
  return false;
}

/**
 * The line a rule's footer must be: the last non-blank one. The composer's own chrome is the one
 * thing allowed below it — a `status-last` mode pins the status line to the pane's last line, and
 * a `status-then-one` mode lets one chrome row stand under the status line, so the status row
 * and that row are both chrome and a dialog drawn above them is still the dialog its footer
 * belongs to. Any other line below the footer means the footer is not the dialog's, and the
 * rule doesn't match.
 */
function footerLine(data: ScreenData, lines: string[]): string {
  const nonBlank = lines.filter((line) => line.trim());
  const last = nonBlank[nonBlank.length - 1] ?? '';
  const composer = data.composer;
  if (composer.mode === 'status-last' && statusMatches(composer, last)) {
    return (nonBlank[nonBlank.length - 2] ?? '').trim();
  }
  if (composer.mode === 'status-then-one') {
    if (statusMatches(composer, last)) return (nonBlank[nonBlank.length - 2] ?? '').trim();
    if (statusMatches(composer, nonBlank[nonBlank.length - 2] ?? '')) {
      return (nonBlank[nonBlank.length - 3] ?? '').trim();
    }
  }
  return last.trim();
}

/** Whether the pattern is one of the composer's status line patterns of a profile that pins the
 *  row's place: such a pattern is read by the row's place, in a rule's patterns and in its
 *  `except` list alike — a grammar-looking line that is not the row is ordinary text. */
function placedStatus(data: ScreenData, pattern: RegExp): boolean {
  const composer = data.composer;
  if (composer.mode !== 'status-last' && composer.mode !== 'status-then-one') return false;
  if (!composer.statusBelow) return false;
  return composer.statusLine.some((re) => re.source === pattern.source && re.flags === pattern.flags);
}

function placedComposer(data: ScreenData): Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }> {
  return data.composer as Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>;
}

function matches(data: ScreenData, lines: string[], at: number, pattern: LinePattern, tick: () => boolean, inWindow: boolean): boolean | 'stop' {
  if (tick()) return 'stop';
  const line = lines[at] ?? '';
  if (inWindow && placedStatus(data, pattern.match)) return statusRowAt(placedComposer(data), lines, at);
  if (!pattern.match.test(line)) return false;
  for (const except of pattern.except) {
    if (tick()) return 'stop';
    if (inWindow && placedStatus(data, except)) {
      if (statusRowAt(placedComposer(data), lines, at)) return false;
    } else if (except.test(line)) return false;
  }
  return true;
}

/** `plain` is the window's plain form; `styled` the window itself, for the input line's dim question. */
function compose(
  data: ScreenData,
  plain: string[],
  styled: string[],
  tick: () => boolean,
  expectedCwd?: string | null,
  home?: string,
): Hit {
  const composer = data.composer;
  if (composer.mode === 'box-to-rule') return boxToRule(plain, styled, composer, tick);
  if (composer.mode === 'status-last') return statusLast(data, plain, styled, composer, tick, false, expectedCwd, home);
  if (composer.mode === 'status-then-one') return statusThenOne(data, plain, styled, composer, tick, expectedCwd, home);
  return twoRules(plain, styled, composer, tick);
}

/** The rule a line carries, or null: the profile's rule pattern anchored to the line's own
 *  first column, as the captures draw the box's rules. */
function ruleRun(composer: { rule: RegExp }, line: string): string | null {
  const hit = composer.rule.exec(line);
  return hit === null ? null : hit[0];
}

/** Two rule rows of one box: the same run, or — for a CLI whose opening rule carries a label in
 *  its run — the same number of columns. */
function sameRuleWidth(top: string | null, bottom: string | null): boolean {
  if (top === null || bottom === null) return false;
  return top === bottom || [...top].length === [...bottom].length;
}

function boxToRule(lines: string[], styled: string[], composer: Extract<ScreenData['composer'], { mode: 'box-to-rule' }>, tick: () => boolean): Hit {
  // The frame first, as the captures draw it (unsent-typed-ansi.txt): a rule is an unbroken run
  // from the pane's first column — the profile's rule pattern is anchored to it — and the box's
  // closing rule is the window's last rule row; nothing rule-shaped sits under the box's
  // footers, and a rule-looking row the box holds is drawn at the content column: content,
  // never the frame.
  let close = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (ruleRun(composer, lines[i] ?? '') !== null) { close = i; break; }
  }
  if (close < 0) return { kind: 'unknown' };
  // The capture draws only the box's own footers under the closing rule. A prompt-looking row
  // there is a row the frame does not draw — leftover-box.txt shows a second, leftover prompt
  // under the box's status — so this pane is not the one box the caller can compare against
  // typed text, and the read fails closed.
  for (let i = close + 1; i < lines.length; i++) {
    if (tick()) return { kind: 'stop' };
    if (composer.prompt.test(lines[i] ?? '')) return { kind: 'unknown' };
  }
  let open = -1;
  for (let i = close - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (ruleRun(composer, lines[i] ?? '') !== null) { open = i; break; }
  }
  let input: number;
  let from: number;
  if (open >= 0) {
    // The two rules of one box are drawn at one width (53 columns in unsent-typed-ansi.txt).
    if (!sameRuleWidth(ruleRun(composer, lines[open] ?? ''), ruleRun(composer, lines[close] ?? ''))) return { kind: 'unknown' };
    // The input row is the box's first row under its opening frame, and it carries the prompt
    // at the capture's own column. A row there that does not is not this box's input — the read
    // fails closed rather than take some later row whose content begins with a prompt glyph,
    // which would drop the rows above it from the box the caller compares.
    input = open + 1;
    if (input >= close || !composer.prompt.test(lines[input] ?? '')) return { kind: 'unknown' };
    from = open;
  } else {
    // The opening rule has scrolled out of the window. The frame is then the ordered footers
    // under the closing rule — every pattern matched in sequence, equal count, as the capture
    // draws them — and the input row is the lowest row above the closing rule carrying the
    // prompt at that column: content is drawn at the text's column, so a row at the prompt's
    // own can only be the box's first. Any non-blank row above it is a row the frame does not
    // explain, and the read fails closed.
    let footer = false;
    const rawFooters: string[] = [];
    for (let j = close + 1; j < lines.length; j++) {
      if (tick()) return { kind: 'stop' };
      const raw = lines[j] ?? '';
      if (raw.trim()) rawFooters.push(raw);
    }
    if (composer.footers.length > 0 && rawFooters.length === composer.footers.length) {
      footer = composer.footers.every((pattern, idx) => pattern.test(rawFooters[idx] ?? ''));
    }
    if (!footer) return { kind: 'unknown' };
    input = -1;
    for (let i = close - 1; i >= 0; i--) {
      if (tick()) return { kind: 'stop' };
      if (composer.prompt.test(lines[i] ?? '')) { input = i; break; }
    }
    if (input < 0) return { kind: 'unknown' };
    for (let i = 0; i < input; i++) {
      if (tick()) return { kind: 'stop' };
      if ((lines[i] ?? '').trim()) return { kind: 'unknown' };
    }
    from = input;
  }
  const rows = lines.slice(input + 1, close);
  if (rows.some((line) => line.trim()) && !rowsAreDim(composer, rows, styled.slice(input + 1, close))) {
    return { kind: 'unsent', from, input, rows };
  }
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from, input, rows };
}

function statusLast(
  data: ScreenData,
  lines: string[],
  styled: string[],
  composer: Extract<ScreenData['composer'], { mode: 'status-last' | 'status-then-one' }>,
  tick: () => boolean,
  allowOneTrailing: boolean,
  expectedCwd?: string | null,
  home?: string,
): Hit {
  const status = statusIndex(composer, lines, allowOneTrailing, tick, expectedCwd, home);
  if (status === 'stop') return { kind: 'stop' };
  if (status < 0) return { kind: 'unknown' };
  // The input row is the lowest prompt row above the status line, and the box's top frame is
  // the blank run directly above it: every capture draws one — one to two rows in Codex's
  // (idle.txt's rows 13-14 above the placeholder, exit-typed.txt's row 20 above `› /exit`),
  // two to four in Cursor's — and no capture draws a non-blank row against the prompt from
  // above.
  //
  // Above the gap sits the transcript's last row, whatever it is. When that row is
  // prompt-shaped it is the pane's echo of the person's own sent message, not a row of the
  // box: a box draws every row after its first indented (Codex's wrapped continuations at
  // column two in unsent.txt and exit-typed.txt, Cursor's at column four —
  // typed-blank-middle.txt draws a person's blank-middle third line at the content column
  // four, never the prompt column two), while a sent-message echo carries the glyph at the
  // prompt column (Codex's working.txt `› Rules for this session, from the team file:`,
  // Cursor's follow-up-queue-typed.txt queued text). Reading the echo as a live row made
  // every post-send idle seat `unknown` — a seat that could then never be dispatched to or
  // nudged — so the empty input row under its frame reads `idle`, exactly as main reads it.
  // Codex's typed-newline captures (typed-two-lines.txt, pasted-two-lines.txt,
  // second-line-glyph.txt, second-line-gt.txt, wrapped-line.txt, blank-middle.txt) draw
  // every later line of a person's text at the continuation column, two: typed, pasted,
  // wrapped, after a blank line, or beginning with the prompt glyph. None is drawn at the
  // prompt column.
  //
  // A window that starts at or inside the box, or a visible continuation or prompt row
  // pressed against the prompt from above, is not the frame the captures draw, and the rows
  // above it cannot be shown to be outside the box: fail closed rather than take the lowest
  // prompt row for an input row.
  let low = status - 1;
  while (low >= 0 && !composer.prompt.test(lines[low] ?? '')) low--;
  if (low < 0) return { kind: 'unknown' };
  const input = low;
  // The frame above the input row. Every 2026-10-01 capture draws blank rows there — four in
  // idle.txt (rows 5-8 above the input at 9), one to four in the others — and a non-blank row
  // against the prompt from above is a shape no capture draws. A composer that declares its
  // `border` (the CLI's own frame, as the captures of 2026-10-05 draw the box: a ` ▄…`
  // row above the input row and a ` ▀…` row under the input rows) reads the row directly
  // above the input row as the frame's top instead, beside the blank frame. The frame's place
  // is the captures' own and is pinned here, not by the patterns: the bottom row must sit
  // directly under the input rows (a blank row between it and the text fails closed) and
  // directly above the status row, both border rows must be whole rows at one width, and the
  // top row stands alone — a bottom row under a blank frame (top missing) or a top row
  // without its bottom is not the frame. A border row anywhere the frame does not draw it —
  // inside the box, where only the person's indented text may sit — fails closed too. The
  // border never moves a reading toward idle or unsent by itself.
  const border = composer.border;
  // A border-shaped row anywhere above the input row's frame is a row no capture draws: the
  // border runs around the box and nowhere else, and the rows a capture shows above it are
  // transcript (idle.txt's tip, rules-accepted.txt's reply, the 2026-10-05 captures' text
  // scrolled above the ` ▄` row). A `▄` or `▀` run above the frame is either a frame the
  // window cut through — which the read cannot place — or a shape no capture explains; the
  // read fails closed rather than take the rows under it for a box.
  if (border) {
    for (let i = 0; i < input - 1; i++) {
      if (border.top.test(lines[i] ?? '') || border.bottom.test(lines[i] ?? '')) return { kind: 'unknown' };
    }
  }
  const above = lines[input - 1] ?? '';
  let end = status;
  if (border && input > 0 && border.top.test(above)) {
    if (status - 1 <= input) return { kind: 'unknown' };
    const under = lines[status - 1] ?? '';
    if (!border.bottom.test(under) || under.length !== above.length) return { kind: 'unknown' };
    if ((lines[status - 2] ?? '').trim() === '') return { kind: 'unknown' };
    const statusLine = lines[status] ?? '';
    if (under.length !== statusLine.length + 1) return { kind: 'unknown' };
    if (!composer.statusLine.some((re) => anchored(re.source) && re.test(statusLine))) {
      return { kind: 'unknown' };
    }
    const workspace = lines[status + 1];
    if (!composer.statusBelow || workspace === undefined || !composer.statusBelow.line.test(workspace)) return { kind: 'unknown' };
    for (let i = status + 2; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() !== '') return { kind: 'unknown' };
    }
    end = status - 1;
  } else if (input === 0 || above.trim() !== '') {
    return { kind: 'unknown' };
  }
  // The lowest prompt row above the status line is the input row when it holds text: the
  // exit-typed capture draws its menu row `› /exit  exit Codex` above the gap and `/exit` on
  // the input row itself. When it holds none, the row above the gap is the transcript, read
  // as nothing — the echo of the person's own sent message is the routine post-send layout,
  // not a second row of the box.
  // Every capture draws every row of typed text below the input row indented (Codex's
  // continuations at column two, Cursor's at four), so a prompt row after the input, inside
  // the box, is a shape the captures do not show. Fail closed on it rather than leave a
  // person's own text above it unread. A border-shaped row inside the box is a row the
  // frame does not draw there either: the box holds the person's text, nothing else.
  for (let i = input + 1; i < end; i++) {
    if (composer.prompt.test(lines[i] ?? '')) return { kind: 'unknown' };
    if (border && (border.top.test(lines[i] ?? '') || border.bottom.test(lines[i] ?? ''))) return { kind: 'unknown' };
  }
  // A row the pane draws of its own — Cursor's background-task count, captured between
  // the empty placeholder and the status row — is not text in the box. Any other
  // non-blank row there is.
  const own = 'ownRows' in composer ? composer.ownRows ?? [] : [];
  const rows: string[] = [];
  const styledRows: (string | undefined)[] = [];
  for (let i = input + 1; i < end; i++) {
    const line = lines[i] ?? '';
    if (own.some((pattern) => pattern.test(line))) continue;
    rows.push(line);
    styledRows.push(styled[i]);
  }
  if (rows.some((line) => line.trim()) && !rowsAreDim(composer, rows, styledRows)) {
    return { kind: 'unsent', from: input, input, rows };
  }
  return { kind: placeholder(stripTyped(lines[input] ?? '', composer), composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from: input, input, rows };
}

function statusThenOne(
  data: ScreenData,
  lines: string[],
  styled: string[],
  composer: Extract<ScreenData['composer'], { mode: 'status-then-one' }>,
  tick: () => boolean,
  expectedCwd?: string | null,
  home?: string,
): Hit {
  const found = statusLast(data, lines, styled, composer, tick, true, expectedCwd, home);
  if (found.kind !== 'unknown') return found;
  // No status line: the fallback rules decide. Anything they don't name is unknown. A line
  // carrying the grammar but not in its place is text like any other here: it fails the read
  // closed, it does not open the fallback, and it is never one of the fallback's own patterns.
  const hasStatus = lines.some((line) => statusMatches(composer, line));
  if (hasStatus) return { kind: 'unknown' };
  for (const rule of composer.fallback) {
    let ok = true;
    for (const pattern of rule.all) {
      const hit = lineSomewhere(data, lines, pattern, tick);
      if (hit === 'stop') return { kind: 'stop' };
      if (!hit) { ok = false; break; }
    }
    if (ok) {
      // The floor's region starts at the prompt, the composer's top boundary.
      // A phrase in the transcript above it is not the floor's to read.
      const input = lines.findIndex((line) => composer.prompt.test(line));
      return { kind: rule.kind, from: input < 0 ? 0 : input, input };
    }
  }
  return { kind: 'unknown' };
}

function sameRulePair(top: string | null, bottom: string | null): boolean {
  if (top === null || bottom === null) return false;
  if (top === bottom) return true;
  return top.length === bottom.length && /^▄+$/.test(top) && /^▀+$/.test(bottom);
}

function twoRules(lines: string[], styled: string[], composer: Extract<ScreenData['composer'], { mode: 'two-rules-footer-below' }>, tick: () => boolean): Hit {
  // The frame first: the box's bottom rule is the window's last rule row, and its top rule is
  // the nearest rule row above it — the captures draw exactly two rules around the box, both
  // unbroken runs from the pane's first column (unsent.txt draws them at rows 7 and 12). A
  // rule-looking row the box holds is drawn at the content column and is content, never frame.
  let bottom = -1;
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (tick()) return { kind: 'stop' };
    if (composer.rule.test(lines[i] ?? '')) {
      if (bottom === -1) bottom = i;
      else { top = i; break; }
    }
  }
  if (top < 0 || bottom < 0) return { kind: 'unknown' };
  // The two rules of one box are drawn at one width (53 columns in unsent.txt, 54 in
  // folded-rules.txt), either as the same rule line or as an upper-and-lower half-block pair
  // (▄… above, ▀… below). A window whose rules differ is not that frame — the box the caller
  // compares against typed text cannot be established — and the read fails closed.
  if (!sameRulePair(ruleRun(composer, lines[top] ?? ''), ruleRun(composer, lines[bottom] ?? ''))) return { kind: 'unknown' };
  // The input row is the box's first row under its opening frame, and it carries the prompt at
  // the capture's own column. A row there that does not — a folded box's marker row
  // (folded-rules.txt) — is not this box's input, and the read fails closed rather than take
  // some later row whose content begins with a prompt glyph.
  const input = top + 1;
  if (input >= bottom || !composer.prompt.test(lines[input] ?? '')) return { kind: 'unknown' };
  let footer = false;
  for (let i = bottom + 1; i < lines.length; i++) {
    if (tick()) return { kind: 'stop' };
    if (composer.footers.some((pattern) => pattern.test(lines[i] ?? ''))) footer = true;
  }
  if (!footer) return { kind: 'unknown' };
  const rows = lines.slice(input + 1, bottom);
  if (rows.some((line) => line.trim()) && !rowsAreDim(composer, rows, styled.slice(input + 1, bottom))) {
    return { kind: 'unsent', from: top, input, rows };
  }
  const typed = (lines[input] ?? '').replace(composer.prompt, '').trim();
  return { kind: placeholder(typed, composer, lines[input] ?? '', styled[input]) ? 'idle' : 'unsent', from: top, input, rows };
}

function stripTyped(line: string, composer: { prompt: RegExp; stripSuffix?: RegExp | null }): string {
  const stripped = composer.stripSuffix ? line.replace(composer.prompt, '').replace(composer.stripSuffix, '') : line.replace(composer.prompt, '');
  return stripped.trim();
}

// A placeholder, not text. When the composer says its suggestions render dim and the input
// line carries any styling at all, the styling decides alone: all faint past the prompt is a
// greyed suggestion, anything else is text — the list is not asked, so no suggestion's
// styling can lend its words to typed characters after it. A line without styling (a plain
// read, an old herdr) leaves the list to decide, as does a composer without the style.
function placeholder(
  typed: string,
  composer: { prompt: RegExp; placeholders: ScreenData['composer']['placeholders']; placeholderStyle?: ScreenData['composer']['placeholderStyle'] },
  plainLine: string,
  styledLine: string | undefined,
): boolean {
  if (composer.placeholderStyle === 'dim' && styledLine !== undefined && hasSgr(styledLine)) {
    const hit = composer.prompt.exec(plainLine);
    const skip = hit === null ? 0 : plainLine.slice(0, hit.index + hit[0].length).replace(/\s/g, '').length;
    return allDimAfter(styledLine, skip);
  }
  return composer.placeholders.some((entry) => ('equals' in entry ? typed === entry.equals : typed.startsWith(entry.prefix)));
}

// Rows under the input row that hold only a greyed suggestion: a suggestion longer than the box is
// wide wraps onto them, in the same faint style as the input row. Every non-blank row must be
// styled and all faint; one plain character on any of them is text. A composer without the dim
// style, and a read without styling, say no — the rows then are text, as they always were.
function rowsAreDim(
  composer: { placeholderStyle?: ScreenData['composer']['placeholderStyle'] },
  rows: string[],
  styledRows: (string | undefined)[],
): boolean {
  if (composer.placeholderStyle !== 'dim') return false;
  for (let i = 0; i < rows.length; i++) {
    if (!(rows[i] ?? '').trim()) continue;
    const styled = styledRows[i];
    if (styled === undefined || !hasSgr(styled) || !allDimAfter(styled, 0)) return false;
  }
  return true;
}

/** One line's floor hit, as the line's plain text trimmed — the only part of an unrecognised
 *  screen a reader may quote — or null. The chrome vocabulary is skipped, the input row is not a
 *  numbered choice (its text was typed), and a numbered choice needs its second row below it. */
function floorLine(lines: string[], i: number, input: number, chrome: RegExp[]): string | null {
  const line = lines[i] ?? '';
  if (chrome.some((pattern) => pattern.test(line))) return null;
  if (i !== input && choiceLine(line) && lines.slice(i + 1).some((later) => twoLine(later))) return line.trim();
  const lower = line.toLowerCase();
  if (FLOOR_PHRASES.some((phrase) => lower.includes(phrase))) return line.trim();
  return null;
}

/** The safety floor's verdict: no hit, a hit on the first matching line from `from` (the line's
 *  plain text, trimmed), or `'stop'` when the budget ran out. `'stop'` is a hit a reader may not
 *  act on; a string hit is the floor's own row. */
function floorHits(lines: string[], from: number, input: number, chrome: RegExp[], tick: () => boolean): false | 'stop' | string {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    if (tick()) return 'stop';
    const hit = floorLine(lines, i, input, chrome);
    if (hit !== null) return hit;
  }
  return false;
}

/** The floor's nearest matching line reading up from the bottom of the live screen, or null.
 *  Asked only when a composer read failed — the screen is unknown whatever the answer — for the
 *  row a reader may quote. Only what lies below the composer's last rule line is read: a row above
 *  it is transcript the pane has scrolled past, whatever its words, and never the dialog that
 *  stopped the read. A window with no rule line is a dialog that fills the pane, and all of it is
 *  live. */
function floorLast(lines: string[], chrome: RegExp[], tick: () => boolean): false | 'stop' | string {
  const rule = findLast(lines, (line) => RULE_LINE.test(line));
  for (let i = lines.length - 1; i > rule; i--) {
    if (tick()) return 'stop';
    const hit = floorLine(lines, i, -1, chrome);
    if (hit !== null) return hit;
  }
  return false;
}

/** The unknown screen a floor hit leaves. A budget stop carries no line: nothing was read to
 *  quote, and the screen is unknown all the same. */
function floorScreen(marked: false | 'stop' | string): Screen {
  return typeof marked === 'string' && marked !== 'stop' ? { kind: 'unknown', matched: marked } : { kind: 'unknown' };
}

/** A composer read that failed is unknown whatever the floor says. The floor is asked only for
 *  the row it matched, so a reader can quote the prompt-like line it saw — never to change the
 *  kind, never to type, and never to move a stage: an unknown screen is one nothing is typed
 *  into. */
function failedComposer(data: ScreenData, plain: string[], tick: () => boolean): Screen {
  return floorScreen(floorLast(plain, data.chrome, tick));
}

function choiceLine(line: string): boolean {
  return /^\s*[❯›>]\s*1\.\s/.test(line);
}

function twoLine(line: string): boolean {
  return /^\s*[❯›>]?\s*2\.\s/.test(line);
}

function findLast(lines: string[], test: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i] ?? '')) return i;
  return -1;
}
