// The shape of a profile's screen, after the dialect has compiled its patterns.
import type { ScreenProfile } from './screen-profile.ts';
import type { Screen } from './screen.ts';

export type LinePattern = { match: RegExp; except: RegExp[] };

/** One step of a `block` rule: a row the dialog draws (its whole text, after the frame's own
 *  indentation), one blank row of its spacing, the run of rows it fills with its own text, or
 *  the alternatives a form's tail can take — each a list of steps, an empty one for a form
 *  that draws no row there. */
export type BlockStep =
  | { row: string }
  | { blank: true }
  | { list: true }
  | { oneOf: BlockStep[][] };

export type Rule = {
  /** A reason attached to this rate-limit rule when it matches. */
  reason?: string;
  any?: LinePattern[];
  all?: LinePattern[];
  footer?: string;
  /** `any` and `all` are read on the dialog's last line, not on every line. */
  onFooter?: boolean;
  belowLastRule?: RegExp;
  /** The window has no composer rule: the dialog is the pane. */
  withoutRule?: boolean;
  /** `any` and `all` are read on the live region only — the composer's own rows, rules and
   *  footers, and the newest turn of transcript above them — so a sentence the window has
   *  scrolled past is not the dialog. A window whose composer cannot be read keeps the whole
   *  window, as a rule without this field does. */
  live?: true;
  /** `any` and `all` are read only in the block directly above the composer's opening frame:
   *  the blank margin under it is skipped and blanks inside the block are allowed, but every
   *  non-blank row of the block must match one of the rule's patterns and the block must start
   *  at the row adjacent to the frame. One printed value row directly above the frame — a reset
   *  clock wrapped off the sentence's last row, at least one digit and no letter — continues the
   *  block above it. So a notice drawn above the box — one row, a sentence and its reset row, or
   *  a sentence whose value wrapped below it — is the wall, while a quoted sentence with any
   *  later prose between it and the box is not. A window whose composer cannot be read falls
   *  back to the whole window, exactly as a rule without this field reads it: adjacency is a
   *  narrowing, never a new way to let a typed wall through. Never a default: a profile opts in
   *  from a capture or a reported frame that shows where its CLI draws the notice. */
  atComposer?: true;
  noneAfter?: { anchor: LinePattern; patterns: LinePattern[] };
  /** Every non-blank row after the block's last anchor must match one of these: the block's
   *  own tail, with nothing of another dialog's after it. */
  onlyAfter?: { anchor: LinePattern; patterns: LinePattern[] };
  /** The dialog read as one contiguous block of rows, from the last row that matches its first
   *  step to the screen's last non-blank line: every row the block draws, the blanks it draws
   *  and the run of rows it fills with its own text. The rule's only key. */
  block?: BlockStep[];
};

/** The versions a captured record was taken on, as the profile's `tested:` range reads. */
export type VersionRange = { from: string; to: string };

export type Stage = { rules: Rule[]; tested?: VersionRange; reason?: string };

/** Where one dialog's question text sits on the pane. Exactly one anchor is set: `inline` takes
 *  the matched row itself, `after` takes the rows below it, `before` the rows above it. `rows`
 *  is how many rows may be taken — a blank row after the strips ends the walk when the spec
 *  names no end marker — and `strip` removes the frame's own characters from a taken row before
 *  it is trimmed: a box border, the CLI's question counter, the option number. The text the
 *  reader returns is the stripped rows joined by one space; nothing else is added to it.
 *
 *  `until` names the row that ends the block — the dialog's options, or its footer — and is
 *  tested against the raw row, before the strips. A spec that names it is read to that row:
 *  a blank row inside the block is the block's own row and is passed over, and only reaching the
 *  marker reports the block whole (`QuestionReading.complete`). A block still going when `rows`
 *  runs out, or one the window ends before the marker, is reported cut, never answered on part
 *  of its text. A spec that names no marker declares no end: its walk stops at a blank row or at
 *  `rows`, and a cut is not reported. */
export type TextSpec = {
  inline: RegExp | null;
  after: RegExp | null;
  before: RegExp | null;
  until: RegExp | null;
  rows: number;
  strip: RegExp[];
};

/** The question text's place, per screen kind. `any` covers a kind with no entry of its own, so
 *  a profile whose dialogs share one layout writes the anchor once. */
export type QuestionText = {
  any: TextSpec | null;
  question: TextSpec | null;
  'plan approval': TextSpec | null;
  confirmation: TextSpec | null;
};

export type Placeholder = { equals: string } | { prefix: string } | { shape: 'slash-hint' };

/** How a composer continues a line onto its next row, from a capture that shows it: the
 *  continuation starts at the text column (the box's own indent), and the break folds the space
 *  away at a word boundary or falls mid-word (hard). */
export type Wrap = { continuation: 'text-column'; kind: 'word' | 'hard' };

export type FallbackRule = { all: LinePattern[]; kind: Screen['kind'] };

// The composer's greyed suggestions are told by their styling, when the CLI renders them dim
// (`placeholder_style: dim` in the profile). A source without styling falls back to the list.
export type PlaceholderStyle = 'dim';

// Every composer carries `frameRows`: the empty rows a capture shows the pane drawing under
// the text, inside the box's frame (the drop before the status line or the closing rule). The
// box read strips up to that many trailing empty rows as the frame; a box with any row beyond
// them is a box the text does not have, and is refused. Zero where no capture shows the pane
// drawing such a row: don't guess.
type Box = {
  mode: 'box-to-rule';
  prompt: RegExp;
  rule: RegExp;
  /** The frame's own tail on the input row — a box's closing edge, or a hint the pane draws
   *  after the text — dropped before the row is read as the text's own. Null where none is
   *  drawn. */
  stripSuffix?: RegExp | null;
  /**
   * For a scrolled-out box, the non-blank lines under the closing rule must match
   * every pattern, in order, and the counts must be equal.
   */
  footers: RegExp[];
  /** The grammar of the status row a box composer draws under its closing rule — a CLI whose
   *  footer carries a quota figure (grok's `Weekly limit left: 0%`). The quota read takes its
   *  row, and only a row under the closing rule: a line the box holds is typed text, never the
   *  row. Empty where no capture shows the box a status row. */
  status: StatusLine;
  placeholders: Placeholder[];
  placeholderStyle?: PlaceholderStyle;
  /** The foregrounds a CLI draws its rotating hints in, in the pen's own tokens (`90`,
   *  `38:5:244`, `38:2:103:108:116`). An input row matching no listed placeholder whose visible
   *  text past the prompt is one declared colour is the empty box. Only a measured colour is
   *  declared: an undeclared one keeps the row text. */
  placeholderFg?: string[];
  wrap?: Wrap;
  frameRows: number;
  /** Rows the pane draws of its own inside the box — Muse 1.4.14's completion row for the text
   *  being typed — declared only where a capture shows them. A matching row is not text in the
   *  box: the box reads back as the text alone. */
  ownRows?: RegExp[];
};
/** Where a status row must sit, from the composer section. `line` is the line directly under the
 *  row (the workspace line), which must be the pane's last non-empty one; a row matching `except`
 *  is read as it was before this field — by its grammar alone. */
export type StatusBelow = { line: RegExp; except: RegExp | null };

/** The status line's patterns — one, or a list where no single pattern fits the dialect's length
 *  cap. A line is a candidate when it matches any of them. */
export type StatusLine = RegExp[];

/** The box's own border rows, declared only for a CLI whose captures draw them: `top` is the row
 *  directly above the input row, `bottom` the row directly below the input rows and directly
 *  above the status row, both whole rows at one width (the captures draw them at the pane's
 *  width). The bordered frame is read beside the blank one; a frame with only one of the two
 *  rows, a row displaced from the input row or the status row, or a border-shaped row inside
 *  the box is refused. A composer without this field reads only the blank frame. */
export type Border = { top: RegExp; bottom: RegExp };

type StatusLast = { mode: 'status-last'; statusLine: StatusLine; statusBelow?: StatusBelow; prompt: RegExp; placeholders: Placeholder[]; placeholderStyle?: PlaceholderStyle; placeholderFg?: string[]; wrap?: Wrap; frameRows: number; border?: Border };
type StatusThenOne = {
  mode: 'status-then-one';
  statusLine: StatusLine;
  statusBelow?: StatusBelow;
  prompt: RegExp;
  placeholders: Placeholder[];
  placeholderStyle?: PlaceholderStyle;
  placeholderFg?: string[];
  stripSuffix: RegExp | null;
  fallback: FallbackRule[];
  wrap?: Wrap;
  frameRows: number;
  border?: Border;
  /** Rows the pane draws of its own between the input row and the status row, declared
   *  only where a capture shows them. They are not the person's text. */
  ownRows?: RegExp[];
  /** The pane's own chrome row under the status line, declared only where a capture shows it.
   *  When set, a line under the status row is chrome only when it matches; any other line
   *  leaves the status row unread, so text the seat prints can never stand in for the row. */
  chrome?: RegExp[];
};
type TwoRules = {
  mode: 'two-rules-footer-below';
  prompt: RegExp;
  rule: RegExp;
  /** Any line below the closing rule matches any pattern in the list. */
  footers: RegExp[];
  placeholders: Placeholder[];
  /** A row that stands for hidden rows of a folded paste; capture 1 is the hidden count. */
  fold: RegExp | null;
  placeholderStyle?: PlaceholderStyle;
  placeholderFg?: string[];
  wrap?: Wrap;
  frameRows: number;
};

export type Composer = Box | StatusLast | StatusThenOne | TwoRules;

export type ScreenData = {
  chrome: RegExp[];
  /** The row that ends a turn, when the CLI draws one: a `live` rule's newest-turn region starts
   *  after the last such row above the composer, so a sentence a completion already ended is
   *  history. Absent, the whole paragraph above the composer is the newest turn. */
  turnEnd?: RegExp;
  unknown?: Stage;
  trust?: Stage;
  /** A plan the agent wrote and is waiting to execute: read before `permission`, whose generic
   *  numbered choice would otherwise take it. Answerable by the answer layer, never by a stop. */
  plan_approval?: Stage;
  /** A confirmation the CLI or the agent raises before acting — a mode switch, an unsent
   *  comment, a held message. Read before `permission` for the same reason. */
  confirmation?: Stage;
  permission?: Stage;
  /** The CLI's own login screen: never answered, and read after `permission` so a shipped
   *  permission pattern keeps the reading it always took. */
  login?: Stage;
  /** The CLI's own question after the exit text was sent — its "stop tasks and exit" one, drawn
   *  in place of the composer. Read before `question` (its footer is an ordinary question's);
   *  the one screen a stop may answer, and only with the profile's `exit_confirm` key. */
  exit_question?: Stage;
  question?: Stage;
  /** A vendor's own notice — an update screen, for one: never answered, and it carries the
   *  version range it was captured on. A stage without `tested` cannot exist: the loader
   *  requires the range, so a screen is never called a vendor notice without a record. */
  vendor_notice?: Stage;
  /** The CLI's provider failed and the prompt is back. Read before `working` and the composer,
   *  so an idle box under the error is not a free prompt. */
  provider_error?: Stage;
  /** A usage limit, with a reset time somewhere in the window. Same place in the order as
   *  `provider_error`: the box under it is not a free prompt. */
  rate_limit?: Stage;
  working?: Stage;
  /** The layouts a pane scrolled back over its transcript draws, and the key that returns to the
   *  prompt. Read only where the composer cannot be read, after every caution stage, so a screen
   *  that is working, unsent or a dialog never reads as one of these. Absent: a footer-shaped row
   *  is no reading at all.
   *
   *  - `footer`: the composer is hidden and the CLI's footer stands on the pane's last non-blank
   *    row, in the composer's place.
   *  - `marker` with `statusFooter`: the composer stays drawn, the CLI's marker row is the nearest
   *    non-blank row above it, and its status footer is the pane's last non-blank row. Read
   *    because that footer leaves the row above the composer unread, so the composer alone is
   *    `unknown` while the pane is still behind the scroll.
   *
   *  A profile declares one layout or both; the loader refuses half of the marker one. */
  scrollBack?: { footer?: RegExp; marker?: RegExp; statusFooter?: RegExp; returnKey: string };
  /** A post-turn feedback survey drawn at the bottom of the pane in the composer's place: two
   *  contiguous whole rows (`prompt` immediately above `choices`), with at most the CLI's own
   *  `statusFooter` row beneath them, and the single Skip key (`'0'`) the typed wake sends at
   *  most once before re-reading for an empty idle prompt. */
  feedbackSurvey?: { prompt: RegExp; choices: RegExp; statusFooter?: RegExp; skipKey: string };
  /** Where the question text of a dialog sits, for the three kinds that carry one. Absent: the
   *  reader returns null and the report names the dialog without quoting it. */
  questionText?: QuestionText;
  composer: Composer;
  profile?: ScreenProfile;
  /** Set by the loader when the reading comes from a `screen_module`: the module reads the
   *  whole visible screen, where the data patterns read the pane's last 20 lines. */
  whole_screen?: true;
};
