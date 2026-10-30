// A profile file, in team's YAML subset, checked as it is loaded. The JSON Schema
// next to the profiles describes the same shape; this is what actually refuses a file,
// because the package does not carry a schema validator.
import { DialectError, compilePattern } from './dialect.ts';
import { loadProfileModule } from '../profiles/module-loader.ts';
import type { BlockStep, Border, Composer, FallbackRule, LinePattern, Placeholder, Rule, ScreenData, Stage, StatusBelow, VersionRange, Wrap } from './screen-data.ts';
import type { ScreenProfile } from './screen-profile.ts';
import type { Screen } from './screen.ts';
import { YamlError, parseYaml, type YamlEntry, type YamlNode } from '../yaml.ts';

const STAGES = ['unknown', 'trust', 'permission', 'exit_question', 'question', 'vendor_notice', 'provider_error', 'rate_limit', 'working'] as const;
const KINDS = ['idle', 'working', 'unsent', 'permission', 'trust', 'question', 'vendor notice', 'provider error', 'rate limit', 'unknown'] as const;
// The lines a dialog draws for its choices, built from their parts: the mark on the choice
// the cursor is on (claude-code ❯, codex ›, antigravity >) or the indent of the others, the
// number, and the labels the profiles' rules and fixtures show, run-on forms included — the
// trust dialog's "Yes, I trust this folder" and "No, exit", the permission dialog's "No, and
// tell Claude what to do differently" (escape hint and all), codex's "Yes, proceed (y)" and
// its own long No. The safety floor reads the first two numbered lines (screen-core's
// choiceLine and twoLine), so chrome must match none of them.
const CHOICE_MARKS = ['❯ ', '› ', '> ', '  '];
const CHOICE_TAILS = [
  '',
  ' Yes',
  ' No',
  ' Yes, I trust this folder',
  ' No, exit',
  ' No, and tell Claude what to do differently',
  ' No, and tell Claude what to do differently (esc)',
  ' Yes, proceed (y)',
  ' No, and tell Codex what to do differently (esc)',
];
const CHOICE_SAMPLES = CHOICE_MARKS.flatMap((mark) =>
  ['1', '2'].flatMap((number) => CHOICE_TAILS.map((tail) => `${mark}${number}.${tail}`)),
);

const DEFAULT_COMPOSER: Composer = {
  mode: 'box-to-rule',
  prompt: /(?!)/,
  rule: /(?!)/,
  footers: [],
  status: [],
  placeholders: [],
  frameRows: 0,
};

export function loadScreen(text: string, baseDir?: string, profileFile?: string): ScreenData {
  const root = parseYaml(text);
  const entries = mapping(root, 'a profile');
  // Launch keys are read by profile.ts. A screen-only snippet, as in the tests, omits them.
  only(entries, ['format', 'cli', 'screen', 'screen_module', 'quota', 'trust_answer', 'binary', 'process_names', 'tested', 'unattended', 'rules', 'standing_rules', 'herdr_status', 'login', 'exit', 'exit_keys', 'compose_module', 'exit_clear', 'exit_confirm', 'input', 'lobby_files', 'startup_reads', 'mcp_inbox', 'timeouts', 'models', 'status_model', 'last_used_model', 'unread_model', 'not_started', 'abandon_answers']);
  const format = required(entries, 'format', root.line);
  if (format.value.kind !== 'scalar' || format.value.value !== 1) fail(format.line, '"format" must be 1');
  const cli = required(entries, 'cli', root.line);
  if (!stringOf(cli.value)) fail(cli.line, '"cli" must be a string');
  const topScreenModule = optional(entries, 'screen_module');
  const screen = required(entries, 'screen', root.line);
  return deepFreeze(screenOf(screen.value, topScreenModule, baseDir, profileFile));
}

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || obj instanceof RegExp) return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object' && !(val instanceof RegExp)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function loadScreenModule(specifier: string, baseDir: string | undefined, line: number, profileFile?: string): ScreenProfile {
  const label = profileFile ? `profile "${profileFile}"` : 'profile';
  const mod: any = loadProfileModule(specifier, baseDir, line, profileFile, 'screen_module');

  try {
    const defaultExport =
      (typeof mod === 'object' && mod !== null) || typeof mod === 'function'
        ? mod.default
        : undefined;
    const candidate =
      defaultExport && (typeof defaultExport === 'object' || typeof defaultExport === 'function')
        ? defaultExport
        : mod;

    const readExport = (key: string): ((...args: any[]) => any) | undefined => {
      let val = candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')
        ? (candidate as any)[key]
        : undefined;
      if (val === undefined && mod !== candidate && mod !== null && (typeof mod === 'object' || typeof mod === 'function')) {
        val = (mod as any)[key];
      }
      return typeof val === 'function' ? val : undefined;
    };

    // `vendor_notice` is deliberately not read from a module: a vendor notice is never a reading
    // without a record, and an export carries no `tested` range. No record, no vendor notice.
    const snapshot: ScreenProfile = Object.freeze({
      unknown: readExport('unknown'),
      trust: readExport('trust'),
      permission: readExport('permission'),
      question: readExport('question'),
      working: readExport('working'),
      composer: readExport('composer'),
    });
    return snapshot;
  } catch (error) {
    fail(line, `${label}: cannot load "screen_module": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function screenOf(node: YamlNode, topScreenModule?: YamlEntry, baseDir?: string, profileFile?: string): ScreenData {
  const entries = mapping(node, 'screen');
  only(entries, ['chrome', 'turn_end', 'composer', 'screen_module', ...STAGES]);
  const chrome = optional(entries, 'chrome');
  const screenScreenModule = optional(entries, 'screen_module');
  const moduleEntry = screenScreenModule ?? topScreenModule;
  const composer = optional(entries, 'composer');
  const label = profileFile ? `profile "${profileFile}"` : 'profile';

  let profile: ScreenProfile | undefined;
  if (moduleEntry) {
    const specifier = stringOf(moduleEntry.value);
    if (specifier === null) fail(moduleEntry.line, '"screen_module" must be a string');
    profile = loadScreenModule(specifier, baseDir, moduleEntry.line, profileFile);
  }

  // Rule (b): A composer comes from data or from the hatch, never both; the load refuses both.
  if (composer && typeof profile?.composer === 'function') {
    fail(moduleEntry!.line, `${label}: profile has a data composer and screen_module exports a composer: a composer comes from data or from the hatch, never both`);
  }
  if (!composer && typeof profile?.composer !== 'function') {
    fail(node.line, `${label}: missing "composer"`);
  }

  const data: ScreenData = {
    chrome: chrome ? chromeOf(chrome.value) : [],
    composer: composer ? composerOf(composer.value) : DEFAULT_COMPOSER,
  };
  const turnEnd = optional(entries, 'turn_end');
  if (turnEnd) {
    const text = stringOf(turnEnd.value);
    if (text === null) fail(turnEnd.line, '"turn_end" must be a string');
    if (!anchored(text)) fail(turnEnd.line, 'a turn_end pattern must match the whole line: "^…$"');
    data.turnEnd = patternOf(text, false, turnEnd.line);
  }
  if (profile) {
    data.profile = profile;
    data.whole_screen = true;
  }

  for (const name of STAGES) {
    const entry = optional(entries, name);
    if (entry) data[name] = stageOf(entry.value, name);
  }
  return data;
}

/**
 * Rules an override adds to one dialog stage. The stage is a list of patterns:
 * a map would be a case flag or a renamed stage, and neither is an added pattern.
 */
export function addedRules(node: YamlNode): Rule[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, 'an override adds a non-empty list of patterns');
  // A shipped profile may set a pattern's own case. An override may not: the flag would
  // loosen a match the shipped patterns made case-sensitively.
  return node.items.map((item) => ruleOf(item, false, false));
}

function stageOf(node: YamlNode, name: (typeof STAGES)[number]): Stage {
  // A vendor notice is never a reading without a record: its map carries the `tested` range it
  // was captured on, and nothing else may. The list form, which carries no range, is refused
  // here rather than read as a stage a version could not be checked against.
  if (name === 'vendor_notice') {
    const entries = mapping(node, 'a "vendor_notice" stage');
    only(entries, ['ignore_case', 'rules', 'tested']);
    const flag = optional(entries, 'ignore_case');
    const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
    const rules = required(entries, 'rules', node.line);
    if (rules.value.kind !== 'seq') fail(rules.line, '"rules" must be a list');
    return {
      rules: rules.value.items.map((item) => ruleOf(item, ignoreCase)),
      tested: testedOf(required(entries, 'tested', node.line)),
    };
  }
  if (node.kind === 'seq') return { rules: node.items.map((item) => ruleOf(item, false)) };
  const entries = mapping(node, 'a stage');
  only(entries, ['ignore_case', 'rules']);
  const flag = optional(entries, 'ignore_case');
  const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
  const rules = required(entries, 'rules', node.line);
  if (rules.value.kind !== 'seq') fail(rules.line, '"rules" must be a list');
  return { rules: rules.value.items.map((item) => ruleOf(item, ignoreCase)) };
}

/** The `tested:` range of a vendor notice: `from` and `to`, both required. */
function testedOf(entry: YamlEntry): VersionRange {
  const entries = mapping(entry.value, 'tested');
  only(entries, ['from', 'to']);
  const from = required(entries, 'from', entry.line);
  const to = required(entries, 'to', entry.line);
  const a = stringOf(from.value);
  const b = stringOf(to.value);
  if (a === null) fail(from.line, '"from" must be a string');
  if (b === null) fail(to.line, '"to" must be a string');
  return { from: a, to: b };
}

function ruleOf(node: YamlNode, ignoreCase: boolean, allowCase = true): Rule {
  const entries = mapping(node, 'a rule');
  only(entries, ['any', 'all', 'footer', 'on_footer', 'below_last_rule', 'without_rule', 'none_after', 'only_after', 'block', 'live', 'at_composer']);
  if (entries.length === 0) fail(node.line, 'a rule has no primitive');
  const block = optional(entries, 'block');
  // A block spells the rows it draws, the footer among them, so it stands alone: a rule that
  // also carried another primitive would read that one on the screen the block rejects.
  if (block) {
    if (entries.length !== 1) fail(block.line, '"block" is the rule\'s only key');
    return { block: blockOf(block.value) };
  }
  const rule: Rule = {};
  const any = optional(entries, 'any');
  const all = optional(entries, 'all');
  const footer = optional(entries, 'footer');
  const onFooter = optional(entries, 'on_footer');
  const below = optional(entries, 'below_last_rule');
  const withoutRule = optional(entries, 'without_rule');
  const noneAfter = optional(entries, 'none_after');
  const onlyAfter = optional(entries, 'only_after');
  if (any) rule.any = patternsOf(any.value, 'any', ignoreCase, allowCase);
  if (all) rule.all = patternsOf(all.value, 'all', ignoreCase, allowCase);
  if (footer) rule.footer = stringOf(footer.value) ?? fail(footer.line, '"footer" must be a string');
  if (onFooter) rule.onFooter = boolOf(onFooter.value, 'on_footer');
  if (below) rule.belowLastRule = patternOf(stringOf(below.value) ?? fail(below.line, '"below_last_rule" must be a string'), ignoreCase, below.line);
  if (withoutRule) rule.withoutRule = boolOf(withoutRule.value, 'without_rule');
  if (noneAfter) rule.noneAfter = afterOf(noneAfter.value, 'none_after', ignoreCase, allowCase);
  if (onlyAfter) rule.onlyAfter = afterOf(onlyAfter.value, 'only_after', ignoreCase, allowCase);
  // `live` narrows the lines `any` and `all` are read on, and nothing else: the other primitives
  // place their own rows, and a rule that pairs it with one of them would be read as neither.
  const live = optional(entries, 'live');
  if (live) {
    const narrowed = boolOf(live.value, 'live');
    if (narrowed && !any && !all) fail(live.line, '"live" narrows "any" or "all": it needs one of them');
    if (narrowed && (footer || onFooter || below || withoutRule || noneAfter || onlyAfter)) {
      fail(live.line, '"live" reads with "any" or "all" alone, never beside another primitive');
    }
    if (narrowed) rule.live = true;
  }
  // `at_composer` narrows `any` and `all` to the block directly above the composer, and nothing
  // else. It carries `live`'s history boundary too, so the two may be written together; a
  // composer that cannot be read leaves the whole window, never a free prompt.
  const atComposer = optional(entries, 'at_composer');
  if (atComposer) {
    const on = boolOf(atComposer.value, 'at_composer');
    if (on && !any && !all) fail(atComposer.line, '"at_composer" narrows "any" or "all": it needs one of them');
    if (on && (footer || onFooter || below || withoutRule || noneAfter || onlyAfter)) {
      fail(atComposer.line, '"at_composer" reads with "any" or "all" alone, never beside another primitive');
    }
    if (on) rule.atComposer = true;
  }
  return rule;
}

// `none_after` and `only_after` read the same shape: an anchor whose last row the window
// goes by, and the rows after it. They differ in what the rows after must be — none of
// the patterns, or only the patterns — so one parser reads both.
function afterOf(node: YamlNode, key: string, ignoreCase: boolean, allowCase = true): NonNullable<Rule['noneAfter']> {
  const entries = mapping(node, key);
  only(entries, ['anchor', 'patterns']);
  const anchor = required(entries, 'anchor', node.line);
  const patterns = required(entries, 'patterns', node.line);
  return {
    anchor: linePattern(anchor.value, ignoreCase, allowCase),
    patterns: patternsOf(patterns.value, 'patterns', ignoreCase, allowCase),
  };
}

// A block reads a dialog as one run of rows, top to bottom. A string is a row the block draws —
// an empty string is one blank row of its spacing, the only way to write one — `list: true` is
// the run of rows it fills with its own text, and `one_of` holds the alternatives a form's tail
// can take, each a list of the same steps (an empty list for a form that draws no row there).
function blockOf(node: YamlNode): BlockStep[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"block" must be a non-empty list of rows');
  const steps = node.items.map((item) => blockStep(item));
  const first = steps[0];
  if (first === undefined || !('row' in first)) fail(node.line, 'a block starts with the row it first draws');
  return steps;
}

function blockStep(node: YamlNode): BlockStep {
  if (node.kind === 'scalar') {
    const text = stringOf(node);
    if (text === null) fail(node.line, 'a block row must be a string');
    if (text === '') return { blank: true };
    return { row: text };
  }
  const entries = mapping(node, 'a block step');
  only(entries, ['list', 'one_of']);
  const list = optional(entries, 'list');
  if (list) {
    if (entries.length !== 1) fail(list.line, '"list" stands alone');
    if (boolOf(list.value, 'list') !== true) fail(list.line, '"list" must be true');
    return { list: true };
  }
  const oneOf = required(entries, 'one_of', node.line);
  if (oneOf.value.kind !== 'seq' || oneOf.value.items.length === 0) {
    fail(oneOf.line, '"one_of" must name at least one alternative');
  }
  return {
    oneOf: oneOf.value.items.map((alt) => {
      if (alt.kind !== 'seq') fail(alt.line, 'an alternative is a list of the rows it draws');
      return alt.items.map((item) => blockStep(item));
    }),
  };
}

function patternsOf(node: YamlNode, key: string, ignoreCase: boolean, allowCase = true): LinePattern[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, `"${key}" must be a non-empty list`);
  return node.items.map((item) => linePattern(item, ignoreCase, allowCase));
}

// A pattern is a string, or a mapping with `match`, its optional `except` list and its
// own `ignore_case`. The pattern's flag is read with the stage's: a screen whose own
// case varies carries the flag beside the pattern, where a stage-wide flag would reach
// every rule. The flag is the entry's, so `except` is read on the same lines `match` is.
function linePattern(node: YamlNode, ignoreCase: boolean, allowCase = true): LinePattern {
  if (node.kind === 'scalar') {
    const text = stringOf(node);
    if (text === null) fail(node.line, 'a pattern must be a string');
    return { match: patternOf(text, ignoreCase, node.line), except: [] };
  }
  const entries = mapping(node, 'a pattern');
  only(entries, ['match', 'except', 'ignore_case']);
  const match = required(entries, 'match', node.line);
  const text = stringOf(match.value);
  if (text === null) fail(match.line, '"match" must be a string');
  const flag = optional(entries, 'ignore_case');
  if (flag && !allowCase) fail(flag.line, 'unknown key "ignore_case"');
  const own = flag ? boolOf(flag.value, 'ignore_case') : false;
  const except = optional(entries, 'except');
  return { match: patternOf(text, ignoreCase || own, match.line), except: except ? exceptOf(except.value, ignoreCase || own) : [] };
}

function exceptOf(node: YamlNode, ignoreCase: boolean): RegExp[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"except" must be a non-empty list');
  return node.items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"except" entries must be strings');
    return patternOf(text, ignoreCase, item.line);
  });
}

function composerOf(node: YamlNode): Composer {
  const entries = mapping(node, 'composer');
  const mode = required(entries, 'mode', node.line);
  const name = stringOf(mode.value);
  // How the CLI renders its greyed suggestions, read off the input line's styling. Optional:
  // a composer whose suggestions plain text already names needs none of it.
  const style = optional(entries, 'placeholder_style');
  const placeholderStyle = style ? placeholderStyleOf(style) : undefined;
  // How the box continues a line onto its next row, declared only where a capture showed the
  // wrap. A composer without one is read by tiling the typed text's own runs.
  const wrapEntry = optional(entries, 'wrap');
  const wrap = wrapEntry ? wrapOf(wrapEntry) : undefined;
  // The empty rows a capture shows the pane drawing under the text, inside the box's frame —
  // the drop before the status line, or the closing rule. Counted from the captures; a
  // composer whose captures show none declares none, and the box read then keeps every
  // trailing empty row and refuses one the typed text does not have. Don't guess.
  const frameEntry = optional(entries, 'frame_rows');
  const frameRows = frameEntry ? frameRowsOf(frameEntry) : 0;
  if (name === 'box-to-rule') {
    only(entries, ['mode', 'prompt', 'rule', 'footers', 'status', 'placeholders', 'placeholder_style', 'strip_suffix', 'wrap', 'frame_rows']);
    // For a scrolled-out box, the non-blank lines under the closing rule must match
    // every pattern, in order, and the counts must be equal.
    const footers = optional(entries, 'footers');
    const suffix = optional(entries, 'strip_suffix');
    return {
      mode: name,
      prompt: regexField(entries, 'prompt', node.line),
      rule: regexField(entries, 'rule', node.line),
      stripSuffix: suffix ? composerString(suffix.value, 'strip_suffix', suffix.line) : null,
      footers: footers ? footersOf(footers, false) : [],
      status: statusFieldOf(entries),
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      placeholderStyle,
      wrap,
      frameRows,
    };
  }
  if (name === 'status-last') {
    only(entries, ['mode', 'status_line', 'status_below', 'prompt', 'placeholders', 'placeholder_style', 'wrap', 'frame_rows', 'border']);
    const below = optional(entries, 'status_below');
    const border = optional(entries, 'border');
    return { mode: name, statusLine: statusLineField(entries, node.line), ...(below ? { statusBelow: statusBelowOf(below) } : {}), prompt: regexField(entries, 'prompt', node.line), placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value), placeholderStyle, wrap, frameRows, ...(border ? { border: borderOf(border) } : {}) };
  }
  if (name === 'status-then-one') {
    only(entries, ['mode', 'status_line', 'status_below', 'prompt', 'placeholders', 'placeholder_style', 'strip_suffix', 'fallback', 'wrap', 'frame_rows', 'border', 'own_rows', 'chrome']);
    const suffix = optional(entries, 'strip_suffix');
    const fallback = required(entries, 'fallback', node.line);
    const below = optional(entries, 'status_below');
    const border = optional(entries, 'border');
    const own = optional(entries, 'own_rows');
    const chrome = chromeRowsField(entries);
    return {
      mode: name,
      statusLine: statusLineField(entries, node.line),
      ...(below ? { statusBelow: statusBelowOf(below) } : {}),
      prompt: regexField(entries, 'prompt', node.line),
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      placeholderStyle,
      stripSuffix: suffix ? composerString(suffix.value, 'strip_suffix', suffix.line) : null,
      fallback: fallbackOf(fallback.value),
      wrap,
      frameRows,
      ...(border ? { border: borderOf(border) } : {}),
      ...(own ? { ownRows: ownRowsOf(own.value) } : {}),
      ...(chrome ? { chrome } : {}),
    };
  }
  if (name === 'two-rules-footer-below') {
    only(entries, ['mode', 'ignore_case', 'prompt', 'rule', 'footers', 'placeholders', 'fold', 'placeholder_style', 'wrap', 'frame_rows']);
    const flag = optional(entries, 'ignore_case');
    const ignoreCase = flag ? boolOf(flag.value, 'ignore_case') : false;
    // Any line below the closing rule matches any pattern in the list.
    const footers = required(entries, 'footers', node.line);
    const fold = optional(entries, 'fold');
    return {
      mode: name,
      prompt: regexField(entries, 'prompt', node.line, ignoreCase),
      rule: regexField(entries, 'rule', node.line, ignoreCase),
      footers: footersOf(footers, ignoreCase),
      placeholders: placeholdersOf(required(entries, 'placeholders', node.line).value),
      fold: fold ? patternOf(stringOf(fold.value) ?? fail(fold.line, '"fold" must be a string'), ignoreCase, fold.line) : null,
      placeholderStyle,
      wrap,
      frameRows,
    };
  }
  fail(mode.line, `"mode" must be box-to-rule, status-last, status-then-one or two-rules-footer-below`);
}

// The composer's wrap rule: the continuation starts at the text column and the break is at a
// word boundary or hard. Either alone does not join a wrapped box — where it starts and where
// it breaks are both needed — so both keys are required and nothing else is read.
function wrapOf(entry: YamlEntry): Wrap {
  const entries = mapping(entry.value, 'wrap');
  only(entries, ['continuation', 'kind']);
  const continuation = required(entries, 'continuation', entry.line);
  const where = stringOf(continuation.value);
  if (where !== 'text-column') fail(continuation.line, '"continuation" must be text-column');
  const kind = required(entries, 'kind', entry.line);
  const shape = stringOf(kind.value);
  if (shape !== 'word' && shape !== 'hard') fail(kind.line, '"kind" must be word or hard');
  return { continuation: where, kind: shape };
}

// The pane's own empty rows inside a box's frame, as a capture shows them: a whole number,
// zero or more. Omitting the key is how a composer whose captures show no such row declares
// zero — the box read then keeps every trailing empty row.
function frameRowsOf(entry: YamlEntry): number {
  const value = entry.value;
  if (value.kind !== 'scalar' || typeof value.value !== 'number' || !Number.isInteger(value.value) || value.value < 0) {
    fail(entry.line, '"frame_rows" must be a whole number of rows, zero or more');
  }
  return value.value;
}

// The box's own border rows, for a CLI whose captures draw them: the row directly above the
// input row and the row directly below the input rows. Both sides are required — a border with
// one row is not a frame a capture draws — and the core fixes their place (the captures pin
// both against the input row and the status row); the patterns name the rows' shape only.
function borderOf(entry: YamlEntry): Border {
  const entries = mapping(entry.value, 'border');
  only(entries, ['top', 'bottom']);
  return {
    top: composerString(required(entries, 'top', entry.line).value, 'border', entry.line),
    bottom: composerString(required(entries, 'bottom', entry.line).value, 'border', entry.line),
  };
}

function footersOf(entry: YamlEntry, ignoreCase: boolean): RegExp[] {
  if (entry.value.kind !== 'seq' || entry.value.items.length === 0) fail(entry.line, '"footers" must be a non-empty list');
  return entry.value.items.map((item) => composerString(item, 'footers', item.line, ignoreCase));
}

function placeholderStyleOf(entry: YamlEntry): 'dim' {
  const text = stringOf(entry.value);
  if (text !== 'dim') fail(entry.line, '"placeholder_style" must be dim');
  return text;
}

function fallbackOf(node: YamlNode): FallbackRule[] {
  if (node.kind !== 'seq') fail(node.line, '"fallback" must be a list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a fallback rule');
    only(entries, ['all', 'kind']);
    const kind = required(entries, 'kind', item.line);
    const name = stringOf(kind.value);
    if (!name || !(KINDS as readonly string[]).includes(name)) {
      // The CLI's own exit question is a screen kind but never a fallback reading: it comes from
      // its stage's patterns, and only a stop answers it. A composer shape that matched it would
      // hand a reading a stop acts on to a profile's loosest rule.
      fail(kind.line, name === 'exit question' ? '"kind" cannot be the exit question: it is read from its stage and answered by a stop alone' : '"kind" is not a screen kind');
    }
    return { all: patternsOf(required(entries, 'all', item.line).value, 'all', false), kind: name as Screen['kind'] };
  });
}

function placeholdersOf(node: YamlNode): Placeholder[] {
  if (node.kind !== 'seq') fail(node.line, '"placeholders" must be a list');
  return node.items.map((item) => {
    const entries = mapping(item, 'a placeholder');
    only(entries, ['equals', 'prefix']);
    const equals = optional(entries, 'equals');
    const prefix = optional(entries, 'prefix');
    if (equals && prefix) fail(item.line, 'a placeholder is "equals" or "prefix", not both');
    if (equals) {
      const text = stringOf(equals.value);
      if (text === null) fail(equals.line, '"equals" must be a string');
      return { equals: text };
    }
    if (prefix) {
      const text = stringOf(prefix.value);
      if (!text) fail(prefix.line, '"prefix" must be a non-empty string');
      return { prefix: text };
    }
    fail(item.line, 'a placeholder needs "equals" or "prefix"');
  });
}

function ownRowsOf(node: YamlNode): RegExp[] {
  if (node.kind !== 'seq' || node.items.length === 0) fail(node.line, '"own_rows" must be a non-empty list');
  return node.items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"own_rows" entries must be strings');
    if (!anchored(text)) fail(item.line, 'an own_rows pattern must match the whole line: "^…$"');
    const compiled = patternOf(text, false, item.line);
    if (CHOICE_SAMPLES.some((sample) => compiled.test(sample))) {
      fail(item.line, 'an own_rows pattern would match a numbered choice line');
    }
    return compiled;
  });
}

// The pane's own chrome row under the status line: one string, or a non-empty list read as the
// union, each anchored to the whole line — the row is the pane's, so a pattern that would match
// only part of it would let anything ride along. A composer that declares none keeps the
// trailing rule it had (see the core's statusIndex).
function chromeRowsField(entries: YamlEntry[]): RegExp[] | undefined {
  const entry = optional(entries, 'chrome');
  if (entry === undefined) return undefined;
  const items = entry.value.kind === 'seq' ? entry.value.items : [entry.value];
  if (items.length === 0) fail(entry.line, '"chrome" must be a string or a non-empty list of strings');
  return items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"chrome" entries must be strings');
    if (!anchored(text)) fail(item.line, 'a chrome pattern must match the whole line: "^…$"');
    const compiled = patternOf(text, false, item.line);
    if (CHOICE_SAMPLES.some((sample) => compiled.test(sample))) {
      fail(item.line, 'a chrome pattern would match a numbered choice line');
    }
    return compiled;
  });
}

function chromeOf(node: YamlNode): RegExp[] {
  if (node.kind !== 'seq') fail(node.line, '"chrome" must be a list');
  return node.items.map((item) => {
    const text = stringOf(item);
    if (text === null) fail(item.line, '"chrome" entries must be strings');
    if (!anchored(text)) fail(item.line, 'a chrome pattern must match the whole line: "^…$"');
    const compiled = patternOf(text, false, item.line);
    if (CHOICE_SAMPLES.some((sample) => compiled.test(sample))) {
      fail(item.line, 'a chrome pattern would match a numbered choice line');
    }
    return compiled;
  });
}

function regexField(entries: YamlEntry[], key: string, line: number, ignoreCase = false): RegExp {
  const entry = required(entries, key, line);
  return composerString(entry.value, key, entry.line, ignoreCase);
}

// The status line's patterns: one string, or a list when one pattern would not fit the dialect's
// length cap. The list is read as the union — a line is a candidate when it matches any of it —
// and the core, not the profile, decides what a candidate still needs to be the row. A mapping
// is still read as a single pattern (via composerString), so the refusal for a map with a flag
// names the key, as it always did.
function statusLineField(entries: YamlEntry[], line: number): RegExp[] {
  const entry = required(entries, 'status_line', line);
  if (entry.value.kind === 'seq') {
    if (entry.value.items.length === 0) fail(entry.line, '"status_line" must be a string or a non-empty list of strings');
    return entry.value.items.map((item) => composerString(item, 'status_line', item.line));
  }
  return [composerString(entry.value, 'status_line', entry.line)];
}

/** A box composer's `status` grammar: the same shape `status_line` takes — one pattern, or a
 *  non-empty list — but optional, and absent means no row under the closing rule is a status
 *  row (the box carries no quota figure to read). */
function statusFieldOf(entries: YamlEntry[]): RegExp[] {
  const entry = optional(entries, 'status');
  if (entry === undefined) return [];
  if (entry.value.kind === 'seq') {
    if (entry.value.items.length === 0) fail(entry.line, '"status" must be a string or a non-empty list of strings');
    return entry.value.items.map((item) => composerString(item, 'status', item.line));
  }
  return [composerString(entry.value, 'status', entry.line)];
}

// Where the status row must sit. A bare pattern is the line directly under the row — the
// workspace line — which must then be the pane's last non-empty one. A map names that line with
// `line` and may exempt rows with `except`: a row matching it keeps its grammar-only reading.
function statusBelowOf(entry: YamlEntry): StatusBelow {
  const node = entry.value;
  if (node.kind === 'scalar') return { line: composerString(node, 'status_below', entry.line), except: null };
  const entries = mapping(node, 'status_below');
  only(entries, ['line', 'except']);
  const except = optional(entries, 'except');
  return {
    line: composerString(required(entries, 'line', node.line).value, 'status_below', node.line),
    except: except ? composerString(except.value, 'status_below', except.line) : null,
  };
}

// A composer key that reads a pattern string. The dialog shape aims its flag at the one
// line it sits on; a composer's own patterns — its prompt, rule, footers, status line,
// suffix — are strings, and the flag among them is refused in words that name the key.
function composerString(node: YamlNode, key: string, line: number, ignoreCase = false): RegExp {
  if (node.kind === 'map' && node.entries.some((item) => item.key === 'ignore_case')) {
    fail(line, `"${key}" cannot ignore case: only a dialog pattern may`);
  }
  const text = stringOf(node);
  if (text === null) fail(line, `"${key}" must be a string`);
  return patternOf(text, ignoreCase, line);
}

function patternOf(text: string, ignoreCase: boolean, line: number): RegExp {
  try {
    return compilePattern(text, ignoreCase);
  } catch (error) {
    if (error instanceof DialectError) fail(line, error.message);
    throw error;
  }
}

function anchored(text: string): boolean {
  if (!text.startsWith('^') || !text.endsWith('$')) return false;
  let slashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
}

function mapping(node: YamlNode, what: string): YamlEntry[] {
  if (node.kind !== 'map') fail(node.line, `${what} must be a map`);
  return node.entries;
}

function only(entries: YamlEntry[], allowed: readonly string[]): void {
  for (const entry of entries) if (!allowed.includes(entry.key)) fail(entry.line, `unknown key "${entry.key}"`);
}

function required(entries: YamlEntry[], key: string, line: number): YamlEntry {
  return optional(entries, key) ?? fail(line, `missing "${key}"`);
}

function optional(entries: YamlEntry[], key: string): YamlEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

function stringOf(node: YamlNode): string | null {
  if (node.kind !== 'scalar' || typeof node.value !== 'string') return null;
  return node.value;
}

function boolOf(node: YamlNode, key: string): boolean {
  if (node.kind !== 'scalar' || typeof node.value !== 'boolean') fail(node.line, `"${key}" must be true or false`);
  return node.value;
}

function fail(line: number, message: string): never {
  throw new YamlError(line, message);
}
