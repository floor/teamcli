# The commands

One page per command `team --help` lists. Each page gives the synopsis, what the command reads and
writes, who may run it, every flag, the refusals with their exact text, the exit codes, and examples.

**Every example on these pages runs in `bun test`** (`test/docs.test.ts`, part of `bun run ci`): the
`console` blocks are extracted, the `team …` lines are run against a fixture project with herdr, the
CLIs, the machine and the clock replaced by fakes, and the output must match the page byte for byte.
A page that drifts from the code fails the build.

The fixture is a project called `beacon` in a temporary folder, a home beside it, and a git
repository with pinned authors and dates. The values the commands print that can't be the same on
every machine are shown as `.` (the fixture project's own path), `~` (the fixture home), `<hash>`
(the end of the record store's folder name, a hash of the project's path) and `<sha>` (a commit
hash).

The fixture's commits are authored by `agent@example.test`, or by `jane@acme.example` with
`email=…`, and every author and commit date is pinned, so a page may print them.

## What the fences mean

| Fence | Meaning |
| --- | --- |
| `console` | a transcript: `$ ` lines are run, the lines under each is its expected output |
| `yaml file=<path>` | a file the fixture gets at that point of the page, read as YAML by the commands. `file=overrides.yaml` is written into the fixture's record store, beside the record |
| `file file=<path>` | the same, for a file that isn't YAML (a log, a PR body); `exec=1` makes it runnable, as a check script has to be |
| `commit` (`email=…`) | one commit of the fixture's history; the block's text is its message |
| `git` | git commands run in the fixture, one per line |
| `fixture` | the world the page's examples run in |

A `console` line may end with `; echo "exit $?"`, which makes the exit code part of the transcript.

A `console` fence may carry:

| Attribute | Meaning |
| --- | --- |
| `caller=<owner\|a seat's name\|agent>` | who runs the block's commands; a `fixture` fence sets it for the whole page |
| `reply="<text>"` | what the seat answers a waited `team send` in this block: with it, the wait prints the reply; without it, the seat stays silent and the wait times out |
| `screens="<seat>=<screen>[,…]"` | what those seats' panes show for this block: `idle`, `working`, `permission`, `trust`, `question`, `unsent`, `unknown` |
| `machine=<calm\|tight\|small-swap>` | the machine's load, free memory, free disk and swap, for this block (`small-swap`: a 1GB swap in total, under the default check) |
| `tools="<cli>=<state>[,…]"` | one CLI's install and login state for this block: `fine`, `missing`, `old`, `logged-out`, `unread` |
| `herdr=<running\|absent\|stopped\|none>` | the session's state in herdr for this block |

The `screens`, `machine`, `tools` and `herdr` overrides last for their block alone: the fixture's own world is
back for the next one. The `fixture` block's keys are documented in `test/docs/spec.ts`; the common ones are
`approved`, `herdr`, `agents`, `screens`, `machine`, `watch`, `tools`, `caller`, `now` and `state`.
