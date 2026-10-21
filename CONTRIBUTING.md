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

Hosted CI runs the Linux test job and the commit and pull request checks on every pull request.
The hosted macOS job runs on every push to `main`, nightly, and on demand; a red macOS run on
`main` is fixed before anything else.

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

## Reporting a weakness

Report a weakness in private, never in a public issue or pull request: see
[SECURITY.md](SECURITY.md).
