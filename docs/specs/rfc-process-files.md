---
created: 2026-10-18
updated: 2026-10-18
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Consensus (module 006, v2 draft)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: RFC process files

## 1. Scope

This spec covers the file formats a review round of an RFC text produces and reads: the round
brief, the verdict file, the `frozen-at` field that binds both to one state, and the decision
records a round or an acceptance leaves behind. It does not cover the tool's own records (the
message, the event, the approval record — those have their own specs), nor who reviews what, which
is the Consensus text's.

## 2. Terms

- **round** — one review pass over a text frozen at a commit; numbered `1, 2, …` per unit.
- **brief** — the file that opens a round: scope, questions, rules, and the verdict file's shape.
- **verdict file** — the one file a reviewer writes in a round, blind to the other verdicts.
- **frozen-at** — the commit a round is frozen at; an answer on any other commit does not count.
- **decision record** — the file that keeps a round's rulings or an acceptance's vote.
- **unit** — the series root, a tier, a module or an amendment: the thing a text belongs to.

## 3. Formats

All paths below are relative to the series' folder. All files are Markdown with YAML front matter;
names are lowercase with hyphens; English only.

### The brief — `reviews/round-<N>/brief.md`

Lives in the unit's `reviews/round-<N>/` (a series-wide round: the series root's `reviews/`
folder). Written by the round's organiser when the text is frozen. Front matter:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `created` | date | yes | — | when the brief was written |
| `kind` | `review` | yes | — | the page kind |
| `status` | `record` | yes | — | a brief is a record once written |
| `round` | number | yes | — | the round's number |
| `frozen-at` | commit sha | yes | — | the commit the round reads |
| `note` | string | no | — | one line on what the round covers |

The body carries: the frozen scope (the folder and the commit, with the rule that any edit to an
in-scope file voids the round and a new round starts with a new commit); the in-scope paths; the
questions the round answers, verbatim where they were given; the rules (blind — write the verdict
before reading any other; read-only — write only the verdict file; cite file and line for every
finding; sign with the model actually run); and the verdict file's required shape, restated as
below.

### The verdict file — `review-<seat>-r<N>.md`

Lives beside the brief in `reviews/round-<N>/`. Written by one reviewer, exactly one file per
reviewer per round, blind to the other verdicts. Front matter:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `created` | date | yes | — | when the verdict was written |
| `kind` | `review` | yes | — | the page kind |
| `status` | `record` | yes | — | |
| `verdict` | `PASS` \| `ACCEPT-WITH-CHANGES` \| `NO` | yes | — | the verdict word |
| `round` | number | yes | — | the round's number |
| `frozen-at` | commit sha | yes | — | the commit read; a verdict on any other commit does not count |
| `reviewer` | string | yes | — | the seat and the model as run |

The body's first line is `VERDICT: PASS`, or `VERDICT: ACCEPT-WITH-CHANGES` followed by the exact
changes needed, or `VERDICT: NO` followed by the blocker. Every finding is cited to a file and a
line or section. The body names the commit read. A self-review by the author's lab is not a verdict
file; it is a work file.

### `frozen-at`

A full commit sha, carried in the brief and in every verdict of the round. The text is frozen for
the round: if any in-scope file changes mid-round, the round is void and a new round starts with a
new commit. The changes between rounds are listed in the next round's brief.

### The decision records — `decisions/`

Live in the unit's `decisions/` folder. Three name shapes: `round-<N>.md` (the decider's rulings on
a round's points), `acceptance-<date>.md` (the board's vote accepting a text), `decided-<topic>-<date>.md`
(a decision outside a round). Front matter:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `created` | date | yes | — | |
| `kind` | `decision` | yes | — | the page kind |
| `status` | `record` | yes | — | |
| `decides` | string | yes | — | what the record decides |
| `decided-by` | string | yes | — | who decided, by position |
| `links` | list | no | — | the decision ids it cites |

The acceptance record is written in the same commit that moves the text's header to `accepted`,
with the text's `accepted: <date>` line. A round's rulings decide each raised point with its
reason; a point once decided is reopened only if a new state contradicts it or the decision.

## 4. Commands and options

None. These files are read and written by the round's participants; the tool reads none of them at
the tag.

## 5. Rules

1. **A round has exactly one frozen state.** The brief names it in `frozen-at`; every verdict names
   the commit it read; an answer on any other commit is kept and not counted. (Proof: the series'
   lint and the organiser's discipline; no tool gate at the tag.)
2. **A verdict is written blind.** Each reviewer writes only its own verdict file, before reading
   the others; a self-review by the author's lab is a work file, not a verdict.
3. **A verdict names its seat and its model as run**, and signs with the model it actually runs.
4. **Nothing in `reviews/` is edited after the round closes**; a closed round's files move to the
   unit's history keeping their names when the text is accepted.
5. **The changes between rounds are listed in the next brief.**

## 6. Registries

None contributed.

## 7. Open points

- The tool reads none of these files at the tag: a verdict file is a practice, kept by the
  organiser's discipline and the series' lint, not by any gate. Whether the store should hold a
  `review` record for a text verdict (the Kernel's `review` shape extended beyond a change) is the
  Consensus text's open question 3.
- The front-matter fields above are those the process page declares; individual rounds' files may
  carry extra keys (`note`, and the docs schema's `updated`), which this spec does not forbid.

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from the Consensus v2 draft and the series' process page;
  the formats read from a round-1 brief and verdict, generalised with placeholders.
