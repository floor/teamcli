---
created: 2026-10-19
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Kernel amendment 02 Policies (commitment 2.16), and the Runtime's screens, sections and commands
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: the CLI extension contracts

## 1. Scope

This spec covers the contracts a CLI's screens and the tool's own files are read through: the
screen grammar — the core's stage order, the dialog rule primitives, the four composer modes —
the composer-region safety floor, the restricted portable pattern dialect both engines share, the
staged escape hatch for a CLI the data primitives cannot express, the team file's modular
sections and the plain command shape, and the cross-implementation conformance suite. The state
words a reading yields and the watch checks that consume it are the
[seat-state-and-watch](seat-state-and-watch.md) spec's; the profile file — a CLI's launch
fields, its `tested` ranges, its rules modes, the additive overrides file — is the
[launch](launch.md) spec's §3.4; the policy object whose sources sit in the file's owner
sections is the policies spec's. It says what the code at the tag does, in the code's
words.

## 2. Terms

- **screen**: one reading of a pane's lines — a kind, with what the composer read.
- **stage**: one named step of the reading's fixed order; the caution stages are `unknown`,
  `trust`, `permission`, `exit_question`, `question`, `vendor_notice`, `provider_error`,
  `rate_limit`, `working`, and the composer reads after them all.
- **dialog rule**: the pattern set a stage reads — `any`/`all` line patterns, a `footer`, a
  `below_last_rule` anchor, `none_after`, `only_after`, `live`, `at_composer`, `without_rule`,
  or a `block`.
- **composer**: the pane's input box, read by one of four modes — `box-to-rule`, `status-last`,
  `status-then-one`, `two-rules-footer-below`.
- **composer region**: the rows the composer's own mode reads — its box, rules and footers, and
  the newest turn of transcript above them; the only region a `live` rule sees. An
  `at_composer` rule reads the block of rows directly above the composer instead.
- **safety floor**: the generic dialog markers the core matches itself, without case, so no
  profile carries them and none can turn them off.
- **dialect**: the restricted regular-expression language a profile's patterns are written in,
  compiled by the loader so one pattern means the same under both engines.
- **hatch**: a `ScreenProfile` — staged predicates shipped as package code, for a CLI whose
  screens the data primitives cannot express.
- **section**: one module of the team file — a `Section` interface owning its own schema
  fragment.
- **plain command**: a command written as a function over the parsed file, with no registry of
  command objects between the parse and the call.
- **conformance manifest**: the shared fixture list an implementation is checked against.
- **budget**: the reading's time bound — 100 ms; a reading past it answers `unknown`.
- **window**: the pane's last 20 lines, trimmed of trailing space — the only lines the data
  patterns see.

## 3. Formats

### 3.1 The screen reading (built)

The reading walks the caution stages in the core's fixed order — `unknown`, `trust`,
`permission`, `exit_question`, `question`, `vendor_notice`, `provider_error`, `rate_limit`,
`working` — first match wins, and the composer reads after them all (`classifyLines`,
`src/watch/screen-core.ts`). A profile's `screen:` map holds the stages as named keys; each is
`{ rules: Rule[]; tested?: VersionRange }`, where `tested` is the capture range a vendor notice
carries (`{ from, to }`) and nothing else may carry — the loader's `stageOf` requires it of
`vendor_notice` and admits only `ignore_case` and `rules` in the other stages' maps
(`src/watch/screen-file.ts`; `src/watch/screen-data.ts` holds the `Stage` type, whose `tested?`
is not per-stage). The data patterns see the window — the pane's last 20 lines trimmed; a
profile that loads a `screen_module` (§3.6) sets the reading's `whole_screen` flag (`ScreenData`,
`src/watch/screen-data.ts`; the loader, `src/watch/screen-file.ts`), and the reading then sees
the whole pane, not the window (`src/watch/screen.ts`). The composer reading is
`{ kind, from?, input? }` (`ComposerReading`, `src/watch/screen-profile.ts`): the kind the
composer's box holds, the row its text starts on, the row its input line sits on.

### 3.2 The dialog rule primitives (built)

One rule of a stage (`Rule`, `src/watch/screen-data.ts`):

| Field | Shape | Meaning |
|---|---|---|
| `any` / `all` | `{ match, except[] }` line patterns | one line matching any / every line matching all; `except` takes a matching line back |
| `footer` + `onFooter` | string, boolean | the dialog's last row; with `onFooter` the patterns read on that row only, not every line |
| `below_last_rule` | pattern | matched under the rule line the core owns — a run of eight or more box-drawing dashes |
| `none_after` | `{ anchor, patterns[] }` | after the last anchor row, no row may match |
| `only_after` | `{ anchor, patterns[] }` | every non-blank row after the last anchor row matches one of these — the block's own tail, nothing of another dialog's |
| `live` | `true` | read on the composer region only, so a sentence the window has scrolled past is not the dialog; a window whose composer cannot be read keeps the whole window |
| `at_composer` | `true` | read on the block of rows directly above the composer only: blanks are skipped, every non-blank row of the block must match the rule, and the block ends at the first row that does not or at the profile's `turn_end`; so a sentence quoted inside a turn that goes on after it is not the dialog, while a window whose composer cannot be read keeps the whole window |
| `without_rule` | `true` | the window holds no composer rule: the dialog is the pane |
| `block` | steps | the dialog read as one contiguous block of rows, from the last row matching its first step to the screen's last non-blank line |

A `block` step is a `row` the dialog draws, a `blank` it spaces, the `list` run it fills with
its own text, or `oneOf` alternatives — each a list of steps, an empty one for a form that
draws no row there. A pattern may carry its own `ignore_case`; the flag is the entry's, read
with the stage's, so `except` sees the same lines `match` sees. Both anchors read the last row
that matches them, and a window that holds no anchor row fails the rule (`lastAnchor`,
`src/watch/screen-core.ts`).

### 3.3 The composer modes (built)

Four modes, each a variant of `Composer` (`src/watch/screen-data.ts`):

- **box-to-rule** — the composer is its box: the rows the frame draws, from the opening rule to
  the closing rule. `border` is not this mode's: the framed rows a capture shows beside the
  blank frame belong to `status-last` and `status-then-one` (`Border`, `src/watch/screen-data.ts`).
- **status-last** — a status line the CLI draws (`statusLine`), what sits below it
  (`statusBelow`), the prompt, the placeholders, the wrap of continued rows, the frame rows and
  the border.
- **status-then-one** — a status line, then one input row the prompt names; when `statusLast`
  finds no status line in the window, the mode's `fallback: FallbackRule[]` decides — each rule
  `{ all: LinePattern[]; kind }`, every pattern matched somewhere in the window, anything they
  do not name `unknown` (`statusThenOne`, `src/watch/screen-core.ts`).
- **two-rules-footer-below** — the composer between two rule lines, its footer below the second.

Placeholders are `{ equals }` or `{ prefix }`; the greyed suggestions are told by their styling
when the CLI renders them dim (`placeholder_style: dim`), else by the list. Every composer
carries `frameRows` — the empty rows a capture shows the pane drawing under the text, inside the
frame. A wrap is `{ continuation: 'text-column', kind: 'word' | 'hard' }`: the continuation
starts at the text column, and the break folds the space at a word boundary or falls mid-word.

### 3.4 The safety floor and the dialog chrome (built)

The floor's markers are the core's own list, matched without case — a dialog's wording is not
always title-case — and only in the composer region, so a transcript line that quotes a dialog
is not one (`FLOOR_PHRASES`, `src/watch/screen-core.ts`):

    do you want to · esc to cancel · enter confirm · enter continue · esc quit · esc skip · ↑/↓

A numbered choice is a marker too, and it is matched before the phrases: a row opening on `❯`,
`›` or `>` then `1.`, counted only with a later `2.` row below it and never on the input row
(`choiceLine`, `twoLine`, `floorHits`, `src/watch/screen-core.ts`) — RFC 0002 §4.1 lists this
marker first. The composer region is the floor's bound for a data composer — from the
composer's top boundary to the end of the window, the input row skipped — while a hatch
composer's floor reads the whole pane (§3.6).

The rule line a `below_last_rule` pattern sits under is the core's too — a run of eight or more
box-drawing dashes — not a profile's. The dialog **chrome** is a shipped profile's own ignore
list for floor rows — whole lines, anchored at both ends — and the floor skips a row one of its
patterns matches; a pattern that would match a numbered choice is refused at load, so a
numbered choice can never be chrome. The whole-pane reach is not the chrome's: it belongs to
the `screen_module` hatch (`whole_screen`, §3.1). An override file only adds dialog patterns
to a shipped profile; the additive limit is the [launch](launch.md) spec's §3.4.

### 3.5 The pattern dialect (built)

One dialect, both engines (`src/watch/dialect.ts`). The loader rewrites the shorthand classes
before compiling, so a pattern means the same under JavaScript's `u` flag and under Rust's
Unicode mode: `\d` becomes the digit class, `\w` the word class, `\s` a whitespace set fixed in
code — the codepoints JavaScript's own `\s` has matched since ES2019, no more — and `\b`
carries its fixed meaning, the ASCII word boundary; so the rewrite never depends on the host's
flag. A pattern is at most 200 characters and a quantifier at most 1000. The character-code
escapes `\u`, `\U` and `\x` are refused, and so are backreferences `\1`–`\9` and any escape
the parser does not model; the control escapes `\n \r \t \f \v`, the word boundary `\b` and
the shorthand classes are accepted — a pattern's text is otherwise literal, non-ASCII
included, and what it says travels with it. The parser rebuilds the pattern from its own node
shapes and accepts only what it models whole: lookarounds, backreferences, named groups and
inline flags are refused, and so are the repetition shapes that could run without bound — a
repeated alternation opens every branch on a single unquantified literal character, and a
repeated group whose body is one branch opens on no optional or repeated atom
(`checkRepeatedGroup`). `ignore_case` is the stage's flag, never an
inline one: an ASCII fold written into the pattern's own text — each ASCII letter becomes its
two-letter class — so the other engine compiles the same source, and the engine's wider Unicode
folding never applies. Every refusal is a `DialectError` at load, in words that name the
pattern's fault; nothing is half-read.

### 3.6 The staged escape hatch (built)

A CLI whose screens the data primitives cannot express ships a `ScreenProfile`
(`src/watch/screen-profile.ts`): optional predicates `unknown`, `trust`, `permission`,
`question`, `working`, and a `composer` reading. Every hatch predicate is monotone toward
caution, running alongside its data stage — hatch or data — so a hatch can only add a match,
never remove one; a hatch predicate that itself fails answers `unknown`. A composer comes from
data or from the hatch, never both: a profile with a data composer while its module exports one
is refused at load (`src/watch/screen-file.ts`). A vendor notice is not among the hatch's
stages: it exists only as a data stage carrying the `tested` range it was captured on — no
record, no vendor notice. A hatch is trusted package code, not a sandbox.

### 3.7 The modular file sections (built)

The team file parses and writes one section at a time: each section is a module — the
`Section` interface, no type parameter, each section owning its own schema fragment's type
(`src/file/sections/section.ts`) — with the cross-section checks held by the core, not
repeated per section. Twenty-nine sections stand at the tag, from
`format` and `trust` through `seats`, `policies`, `delegates`, `grant`, `tasks` and `tempo`.
The owner sections' names are generated from the section list — `SECTIONS` filtered by
`section.owner`, in `src/approve/fingerprint.ts` — never a hand-kept list; a new owner section
appears in `OWNER_SECTIONS` by its own `owner: true`, and nothing else changes. The tool's
commands stay plain functions over the parsed file; no registry of command objects sits between
the parse and the call.

### 3.8 The conformance manifest (built)

The manifest (`test/fixtures/conformance.json`) holds two lists: `screens` — one entry per
fixture `{ file, cli, classify, composer, provenance }`, `provenance` saying whether the entry
is a `capture` or a `constructed` case, the kinds an implementation must read from
it — and `yaml` — one entry per profile fragment `{ file, ok }`, the acceptance or refusal an
implementation must reproduce. Non-ASCII captures are among them. The runner
(`scripts/conformance.ts`) starts an implementation as a command, feeds it one JSON request per
line on stdin and reads one JSON answer per line, so any engine that can read a line can be
checked; `bun run conformance` runs it against the TypeScript adapter.

## 4. Commands and options

The conformance suite is a repository script, not a `team` command:

```text
bun scripts/conformance.ts --impl "<command>"
bun run conformance          # the TypeScript adapter
```

This spec contributes no `team` command and no exit code row.

## 5. Rules

1. **Stage order and the floor are the core's own.** A profile is data: it MAY add a pattern,
   and it MUST NOT move a stage, reorder the reading or turn the floor off. *Source:*
   `src/watch/screen-core.ts`. *Proof:* `test/screen-core.test.ts`.
2. **The exit question reads before the ordinary question.** Its footer is one an ordinary
   question carries, so the stage a stop may answer MUST win over the kind it must never
   answer; the order is the core's. *Source:* `classifyLines`, `src/watch/screen-core.ts`.
   *Proof:* `test/screen-core.test.ts`.
3. **The reading is bounded.** The clock is checked between stages; past the 100 ms budget the
   reading answers `unknown` and nothing else. *Source:* `BUDGET_MS`, `tick`,
   `src/watch/screen-core.ts`. *Proof:* `test/screen-core.test.ts`.
4. **The floor matches only in the composer region, without case.** The markers are the core's
   own list (§3.4) — the numbered-choice pair first, then the phrases; a profile never carries
   them, and a transcript line that quotes a dialog is not one. For a data composer the region
   runs from the composer's top boundary to the end of the window, the input row skipped; for
   a hatch composer the floor reads the whole pane. *Source:* `FLOOR_PHRASES`, `choiceLine`,
   `twoLine`, `floorHits`, `src/watch/screen-core.ts`. *Proof:* `test/screen-core.test.ts`,
   `test/screen-hatch.test.ts`.
5. **One dialect, both engines.** A pattern MUST compile under the shared dialect before it is
   read; the rewrites and refusals are §3.5's, and a refusal at load — a pattern past 200
   characters, a `\u`/`\U`/`\x` escape, a backreference, an unsupported escape, an inline
   flag, a shape the parser does not model — is a
   `DialectError`, never a half-read. *Source:* `compilePattern`, `src/watch/dialect.ts`.
   *Proof:* `test/profile-schema.test.ts`, `test/conformance.test.ts`.
6. **The hatch can only add caution.** A hatch predicate runs alongside its data stage; a
   composer from both data and hatch MUST be refused at load; a vendor notice is a data stage
   carrying its `tested` range, never a module export. *Source:* `src/watch/screen-profile.ts`,
   `src/watch/screen-core.ts`, `src/watch/screen-file.ts`. *Proof:* `test/screen-hatch.test.ts`.
7. **The file is sectioned and the owner sections are generated.** The team file MUST parse and
   write one section at a time, each section owning its schema fragment, the cross-section
   checks held by the core; the owner sections' names MUST be generated from the section list,
   never hand-kept. *Source:* `src/file/sections/`, `src/approve/fingerprint.ts`. *Proof:*
   `test/file-sections.test.ts`.
8. **Commands stay plain functions.** A command is a function over the parsed file; no registry
   of command objects sits between the parse and the call. *Source:* `src/commands/`. *Proof:*
   none at the tag — a structural reading of the commands, whose every file exports plain
   functions.
9. **An implementation conforms when the manifest passes.** Every screen case MUST return its
   expected `classify` and `composer` kinds and every YAML case its expected acceptance or
   refusal, under the implementation's own engine; the manifest is shared, the adapter is the
   implementation's. *Source:* `scripts/conformance.ts`, `test/fixtures/conformance.json`.
   *Proof:* `test/conformance.test.ts`.

## 6. Registries

None. This spec adds no registry row: the profiles are data files (the [launch](launch.md)
spec's §3.4), the policy names whose sources sit in the owner sections are the policies
spec's, and the conformance suite is a repository script.

## 7. Open points

1. **The floor's case-insensitive matching.** The code matches the floor's markers without
   case — its own comment says a dialog's wording is not always title-case
   (`src/watch/screen-core.ts`) — and this departs from the archived feature note this spec
   lifts, which says the markers are matched case-sensitively (RFC 0002 §4.1, and its change
   log R1). The round is asked to confirm the departure at the port.
2. **The profiles' own pattern content.** A CLI's patterns are data, versioned by its `tested`
   ranges; a CLI whose screens change re-captures and re-ranges, and this spec does not track
   them.
3. **A second engine's adapter.** The port reads the same manifest through its own adapter
   command; the adapter is the port's work, and the manifest grows with it.

## Revision log

- **Draft** (the writer, 2026-10-19): lifted from the archived feature note's contract as
  shipped at the tag — the screen grammar (the core's stage order, the dialog primitives, the
  four composer modes), the composer-region safety floor, the restricted portable patterns, the
  staged escape hatch, the modular file sections and the plain commands, the cross-implementation
  conformance suite (package S4 of tonight's plan). The state words link to
  [seat-state-and-watch.md](seat-state-and-watch.md) and the profile file to
  [launch.md](launch.md) §3.4, nothing copied; the Kernel amendment's carry is its commitment
  2.16 and its §12 link.
- **Phase A review fold** (the writer, 2026-10-19): all four independent reviews folded, each
  PASS WITH CHANGES and each correction verified at the tag. The owner-section list's source is
  `src/approve/fingerprint.ts`, not `src/file/fingerprint.ts` (§3.7, rule 7); `whole_screen` is
  the reading's own `ScreenData` flag, set only when a profile loads a `screen_module` (§3.1);
  the `fallback: FallbackRule[]` rules moved to `status-then-one`, where they run after
  `statusLast` finds no status line (§3.3); the `tested` restriction cites the loader's
  `stageOf` (§3.1); `none_after` and `only_after` read the last anchor row and fail a window
  with no anchor (§3.2); box-to-rule ends at the closing rule, `border` being the two status
  modes' (§3.3); the numbered-choice marker joined the floor before the phrases and the chrome
  clause rewritten as the floor's whole-line anchored ignore list, refusing a numbered choice
  (§3.4, rule 4); the hatch composer's floor reads the whole pane, the data composer's from its
  top boundary skipping the input row (§3.4, rule 4); the refused escapes narrowed to
  `\u`/`\U`/`\x`, backreferences and unsupported escapes, `\b` named with the fixed-meaning
  classes, the second repeated-group refusal added (§3.5, rule 5); the `Section` interface
  carries no type parameter (§2, §3.7); the manifest entry carries `provenance`, capture or
  constructed (§3.8); the case-insensitive floor stated as a departure from RFC 0002's
  case-sensitive wording, not a reading of it (§7); seat-state-and-watch.md and launch.md
  linked at their prose mentions (§1, §3.4, §6).
