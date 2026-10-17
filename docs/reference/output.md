# Output contract

Every `team` command has two faces for the same reading or action: plain terminal text and `--json`. Both are rendered from one in-memory reading and return the same exit code. Builders use the shared helpers in `src/output/` so every command follows this contract without inventing its own layout or envelope.

---

## 1. Plain text structure

A team-scoped command prints its plain output in five ordered parts:

1. **Context line**
2. **Tables (with column headers)**
3. **Notes (collapsed when repeated)**
4. **Differences (each with its repair and who may run it)**
5. **One summary line at the end**

Every line written to a terminal is cleaned through `plainLine` before width measurement and before printing: control bytes, escape sequences, and invisible format characters from a file, state record, or pane cannot move the cursor, paint the terminal, or break column alignment.

### 1.1 Context line

- **Team-scoped commands** (`status`, `check`, `seats`, `up`, `down`, `add`, `remove`, `reload`, `restart`, `worktree`, `hold`, `proc`, `messages`, `feed`, `send`, `route`, `answer`, `lock`, `unlock`, `tempo`, `brief`): open with
  ```text
  team <project>, session "<session>"
  ```
- **Project-scoped commands** (`team status --project <name>`): open with
  ```text
  project <name>  <id>  entity <entity>  lead <lead>
  ```
  omitting `entity <entity>` only when `entity` is `null`.
- **Machine-scoped commands** (`team list`, `team projects`, `team doctor`, `team usage --all`, `team release check`, `team grant --list`): open with their scope heading or table header directly when no single team is in scope.

### 1.2 Tables and column headers

- Every table begins with an **uppercase header row** naming every column (`SEAT`, `STATE`, `MODEL`, `PANE`, `REACH`, etc.). No column may be unlabelled.
- In `team status`, the default seat table columns are:
  ```text
    SEAT  STATE  MODEL  PANE  REACH
  ```
  where `REACH` is `socket` (a `claude-code` seat whose pane process tree holds a live session socket) or `typed`.
- Under `--all`, `team status --all` and `team seats --all` render the expanded seat registry columns:
  ```text
    SEAT  ID  ROLE  CLI  MODEL  EFFORT  STATUS  STATE  SOURCE  LAST ACTIVE  PANE
  ```
- Tables nested under a context line or section heading (`budgets:`) are indented by two spaces (`  `). Top-level tables with no context line start at column 0.
- Columns are separated by two spaces (`  `). Each column except the last is right-padded with spaces to the maximum visible width of its cleaned header and cell values; the last column is unpadded and trailing whitespace is trimmed.
- An absent or empty cell renders as `-`.

### 1.3 Differences, repairs, and who may run them

Every disagreement between the team file, the recorded state, and the live session is printed as a three-line block:

```text
difference: <what>
  repair: <repair>
  who: <who>
```

- `<what>` states the disagreement (`claude-keeper is in the file and is not running`).
- `<repair>` gives the exact command or action that fixes it (`team add claude-keeper`, `the owner runs team up`), with `(after: <precondition>)` appended when the repair waits on an earlier difference.
- `<who>` names who may run the repair:
  - `owner` — only the owner from a terminal outside herdr may run or complete the repair (`difference.owner === true`).
  - `owner or lead` — the owner or the team's lead/coordinator seat (or an admitted delegate) may run the repair.
  - `seat` — the affected seat itself may run the repair.

### 1.4 One summary line at the end

Every reading or action closes with a single summary line:

- For `status` and `check` readings:
  - `0 difference(s)` when clean.
  - `<n> difference(s)` when differences exist and none are owner-only.
  - `<n> difference(s), <m> for the owner` when `<m>` of the differences require the owner.
- For action commands: one summary line stating what changed (or what `--dry-run` would do).
- Nothing is printed after the summary line on ordinary commands.

---

## 2. Quiet by default

Commands stay quiet about routine or non-actionable state unless asked:

1. **Stopped seats hidden unless `--all`**:
   - A seat declared `stopped: true` in the team file that is not running in herdr (row state `stopped`) is omitted from default seat tables (`team status`, `team seats`).
   - Passing `--all` includes stopped seats in the table.
   - If a seat declared `stopped: true` is actually running in herdr, it is not in state `stopped` — it is shown and raises its difference as usual.
2. **Repeated notes collapsed with a count**:
   - Identical notes, or per-seat notes sharing the same `<seat>: <reason>` suffix across multiple seats (such as `<seat>: version unread`), are collapsed in plain output so the same diagnostic is not repeated line after line:
     - Identical note text repeated $n > 1$ times renders once as `note: <text> (x<n>)`.
     - Per-seat `<seat>: <reason>` notes sharing the same `<reason>` across $n > 1$ seats render once as `note: <seat-1>, <seat-2>: <reason> (<n> seats)`.
   - `--json` preserves the full `notes` array for scripts.
3. **`what 0.5.0 must not pretend` block only in `team doctor` and `team --about`**:
   - The `what 0.5.0 must not pretend:` block (and its `Integrity, not authority: ...` line) is printed only by `team doctor` and `team --about`.
   - It is never printed at the bottom of `team status`, `team check`, or other operational commands.
4. **Deprecation warnings only in `team check`, with the command that fixes them**:
   - Team-file deprecation warnings (such as `` `coordinator:` is now `leads: true` on the lead's seat ``) are reported only in `team check`, paired with the repair command or edit that fixes them.
   - Other commands (`status`, `seats`, `list`, `send`, etc.) read deprecated spellings silently without emitting stderr warning noise on every call.

---

## 3. Colour only on a TTY

- ANSI colour sequences are emitted **only** when the target stream is an interactive terminal (`io.stdoutIsTTY === true` for stdout, `io.stderrIsTTY === true` for stderr), `--json` is not set, and `NO_COLOR` is not set (or is empty) in `io.env`.
- Non-TTY runs (pipes, subshells, CI, test harnesses with `stdoutIsTTY` unset or `false`) emit zero ANSI escape sequences.
- Semantic styles provided by `src/output/`:
  - **Headers**: bold (`\x1b[1m...\x1b[22m`)
  - **Good / active states** (`working`, `idle`, `done`, `ok`): green (`\x1b[32m...\x1b[39m`)
  - **Warnings / held / parked / waiting**: yellow (`\x1b[33m...\x1b[39m`)
  - **Differences / missing / errors / `miss`**: red (`\x1b[31m...\x1b[39m`)
  - **Dim / secondary metadata** (`stopped`, `-`, context punctuation): dim (`\x1b[2m...\x1b[22m`)
- Column padding is always calculated on the uncoloured `plainLine` text before wrapping cells in ANSI codes, so alignment never shifts on a TTY.

---

## 4. Exit codes

Exit codes are unchanged by `--json` or `--all` and are documented on every command page and in [`docs/reference/exit-codes.md`](exit-codes.md):

| Exit | Meaning |
| --- | --- |
| `0` | The command succeeded, or the reading found no differences / findings. |
| `1` | The command was refused by a policy or caller gate, an action step failed, or the reading found at least one difference / finding. |
| `2` | The invocation or flags could not be parsed, the team file or required daemon (`herdr`) could not be read, or the caller is not admitted to read the team. |

---

## 5. JSON contract (`--json`)

Every command accepts `--json` and writes a single pretty-printed JSON document (`JSON.stringify(doc, null, 2) + '\n'`) to stdout.

### 5.1 Envelope and schema identifier

Every `--json` response carries a top-level `schema` object naming the document's schema and integer version:

```json
{
  "schema": {
    "name": "team.<command>",
    "version": 1
  }
}
```

- Sub-modes with a distinct shape use a dotted name (`"team.status.project"`, `"team.brief.list"`, `"team.error"`).
- Commands that previously published `"format": 1` retain `"format": 1` alongside `"schema"` so existing callers keep working.
- Field names are stable `snake_case` identifiers (`project`, `session`, `rows`, `notes`, `differences`, `summary`, `seat_state`, `seat_state_source`, `last_active`, `launch_line`, `start_cwd`).
- JSON values contain the raw strings as read (escaped by JSON serialization, not stripped by `plainLine`).

### 5.2 Differences and summary in JSON

In reading commands (`status`, `check`), `differences` carries the same three fields as the plain text:

```json
"differences": [
  {
    "what": "claude-keeper is in the file and is not running",
    "repair": "team add claude-keeper",
    "who": "owner or lead"
  }
],
"summary": {
  "differences": 1,
  "owner_differences": 0
}
```

### 5.3 Error envelope under `--json`

When `--json` is passed and a command fails or refuses (exit `1` or `2`), it writes a structured error document with `schema.name = "team.error"`:

```json
{
  "schema": {
    "name": "team.error",
    "version": 1
  },
  "error": {
    "id": "status.herdr",
    "message": "herdr doesn't answer; is it installed and running?",
    "repair": "start herdr, then re-run team status"
  }
}
```

- `error.id`: the command's exit contract identifier (`<command>.<row>`) from `contract/exit-codes.json`.
- `error.message`: the human-readable refusal or problem message (without the leading `team <command>: ` prefix).
- `error.repair`: the command or action that resolves the error, or `null` when none applies (for example on a read-gate refusal that discloses nothing).

### 5.4 Action commands and `--dry-run`

- On a normal run with `--json`, an action command reports the outcome (`project`, `session`, `status`, and the affected seat/resource fields).
- With `--dry-run --json`, an action command that passes its pre-flight gates exits `0` and reports the plan without mutating state:
  ```json
  {
    "schema": {
      "name": "team.<command>",
      "version": 1
    },
    "project": "beacon",
    "session": "beacon",
    "dry_run": true,
    "plan": [
      {
        "step": "launch",
        "seat": "claude-beacon",
        "detail": "claude --model claude-opus-5-5"
      }
    ],
    "summary": "would launch 1 seat(s)"
  }
  ```

### 5.5 Published JSON Schemas under `schema/`

Each command's JSON output schema is published under `schema/<command>.schema.json` (Draft 2020-12, `https://json-schema.org/draft/2020-12/schema`) using the shared builder in `src/output/schema.ts` and checked by `bun scripts/schema.ts`.

---

## 6. Shared module (`src/output/`)

Builders must use `src/output/` rather than hand-formatting output:

- `contextLine(project, session, opts?)` / `projectContextLine(project)` — formats the opening context line.
- `renderTable({ headers, rows, indent?, tty? })` — cleans cells via `plainLine`, computes column widths on uncoloured text, aligns headers and rows with 2-space separation, and applies optional TTY styling.
- `collapseNotes(notes)` / `renderNotes(notes, opts?)` — collapses repeated identical notes (`(x<n>)`) and repeated per-seat `<seat>: <reason>` notes (`<s1>, <s2>: <reason> (<n> seats)`).
- `whoOfDifference(diff)` / `renderDifference(diff, opts?)` / `renderDifferences(diffs, opts?)` — derives `who` (`owner` vs `owner or lead` / explicit `who`) and renders `difference:`, `  repair:`, and `  who:`.
- `renderSummary(diffs, opts?)` / `summaryCounts(diffs)` — formats the closing summary line (`<n> difference(s)` / `<n> difference(s), <m> for the owner`) and JSON summary object.
- `ttyStyle(io)` — returns ANSI styling helpers bound to `Boolean(io.stdoutIsTTY) && !io.env.NO_COLOR`.
- `jsonEnvelope(schemaName, payload, version?)` / `writeJson(io, schemaName, payload, version?)` — builds and writes the `--json` document with `schema: { name, version }`.
- `jsonError(id, message, repair?)` / `writeJsonError(io, id, message, repair?)` — builds and writes the `--json` error envelope.
- `buildCommandOutputSchema(spec)` — builds the Draft 2020-12 JSON Schema for `schema/<command>.schema.json`.
- Test helpers in `test/helpers/output.ts`: golden-text assertion helpers and JSON schema conformance helpers.
