# Contributing to team

`team` is a TypeScript command-line tool with no runtime dependencies. This page is for people
changing it.

## Getting started

```sh
git clone https://github.com/floor/teamcli.git
cd teamcli
bun install
bun test
```

Run the command from the tree with `bun src/cli.ts <command>`. Bun builds and tests the sources;
`bun run build` writes `dist/`, which Node 22 or later runs.

## Project layout

| Folder | What is there |
| --- | --- |
| `src/` | the command's sources; imports use `.ts` extensions, and only erasable syntax |
| `test/` | `bun test`: unit, boundary and acceptance tests, and the docs examples |
| `docs/` | the command reference, the team file's format and internal notes |
| `schema/` | the team-file JSON Schema the build generates |
| `contract/` | the output, CLI and exit-code contracts the checks hold the build to |
| `scripts/` | the build, the checks, the end-to-end run and the fake seat |

## Making a change

Work on a branch. `main` is the trunk, and every change is a pull request into it.
Write the tests with the code, not after it. Commit in conventional commits, one idea per
commit. Update the docs with the behaviour: a changed flag, refusal or output reaches its page in
`docs/commands/` too.

Before a push, run `bun run typecheck`, `bun test` and `bun run ci` — typecheck, tests, build, the
built command, conformance, and the schema, contract, coverage, exit-code and readme checks.
`bun run e2e` drives the real commands against fake seats in a herdr session of its own; it needs
herdr, and CI does not run it.

## Review and CI

Hosted CI runs the commit and pull request checks and the sharded test job on every pull request.
On every push to `main`, nightly, and on demand, the static job runs the build and every check
once per hosted system, then the whole suite runs as four shards per system; a red run on `main`
is fixed before anything else.

The full suite's split is checked in at `scripts/ci-shard-assignment.json`. A new test file joins
the lightest shard and moves nothing already placed, so a shard's test set stays stable between
runs; a deleted file's unit is dropped. `bun run ci:shard:check` (run by CI) fails when a tracked
test file belongs to no shard. To run one shard locally, `bun run ci:shard 0/4` — the same unit
list CI runs for that shard.

The estimates come from the recorded durations in `scripts/ci-test-timings.json`. After a sharded
full run, `bun scripts/ci-shard-tests.ts --record <log>...` with that run's shard logs of one
system rewrites them, and `--rebalance` re-splits the suite by the new times. Each shard log
carries its units' measured times as `##[unit]<unit> <ms>` lines, printed from the run's JUnit
report; until a unit has a recorded time the assignment weighs it at the measured average of the
units that had none when the suite was measured, not at its size alone.

Before a merge, the author quotes their own full `bun run ci` on the exact head in the pull
request. At least one reviewer who is not the author runs `bun run ci` on macOS on the exact
head and quotes its exit status and final line in their review. A review without that quote is
not an approval. A reviewer in a sandbox quotes what failed there and why; the unsandboxed run
carries the evidence.

## Releasing (maintainers)

A tag push publishes through the release workflow with trusted publishing: push `v<version>`, and
nothing is published by hand. The workflow refuses a tag that is not `package.json`'s version or
a commit that is not on `main`, runs `bun run ci`, publishes to npm with provenance, and creates
the GitHub release from the `CHANGELOG.md` section. A hyphenated version goes under the `next`
dist-tag; if the GitHub release step fails after npm has the version, re-run only the failed
jobs, because a full re-run goes back through `npm publish`. The one-time trusted-publisher
binding and the tag ruleset are described in `.github/workflows/release.yml`.

For a local release candidate — packing a source-stamped tarball and installing it forward into an
existing prefix before any tag exists — see
[packing and installing a local release candidate](docs/internal/rc-pack-install.md). That is
maintainer tooling; publishing still happens only through a tag push.

## Reporting a weakness

Report a weakness in private, never in a public issue or pull request: see
[SECURITY.md](SECURITY.md).
