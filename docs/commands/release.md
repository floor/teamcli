# team release check

Checks the public npm and GitHub records of one release: the exact version and its checksums on npm
— with a provenance attestation when the file declares trusted publishing for the package — the tag
and where it points, the GitHub release, and the changelog entry. With the file's Linear pair it
also verifies the project's milestone and a qualifying status update; with the activity pair, the
release marker in the project's public activity file. Beside those checks it reads npm's `dist-tags`
document: when `next` points at a version older than `latest`, the run warns and prints the exact
`npm dist-tag add` command that would catch the tag up — and never runs it. Run it by hand after a
publish, or let CI run it after it creates a tag.

## Synopsis

    team release check <package@version> [--json] [--file <path>]

`<package@version>` is the package as the team file's `releases` declares it and its Semantic
Versioning 2.0.0 version, joined by `@` — no leading `v`; the tag carries that. A scoped package
splits at the final `@`: `@scope/name@1.2.3`.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--json` | — | print the result as one JSON object on standard output, and nothing else |
| `--file <path>` | a team file | deprecated: a legacy team file to read instead of the team's registry record |
| `--help`, `-h` | — | the usage, and exit 0 |

`--file` takes its value even when the value looks like another option: `--file --json` names a
file called `--json`, and only a `--json` that is not some option's value selects the JSON output.
`--help` and `-h` are not part of that rule: they are answered before the arguments are parsed,
wherever they appear, so `--file --help` prints the usage and exits 0.

## Who may run it

| Caller | May |
| --- | --- |
| anyone, from any folder | run it: it needs no herdr session, no terminal and no login |
| the Linear check alone | read its key from the macOS Keychain, so that one check needs macOS, an interactive run and the one-time setup; anywhere else it is `unknown` and the others are unaffected |

## Output and exit codes

| Outcome | What is printed | Exit |
| --- | --- | --- |
| every check passed | `package <name>, version <ver>`, the `CHECK  STATE  DETAIL` table, and the `<n> check` / `<n> checks, <m> missing` summary — or the `team.release` v1 JSON document (`schema/release.schema.json`) with `--json` | 0 |
| no check is unknown, but one or more are missing | the same table, the failing rows' detail under `missing`, and the summary line | 1 |
| at least one check is unknown | the same table, the failed reads' detail under `unknown`, and the summary line | 2 |
| a bad invocation, an invalid team file, or a package the file does not declare | `team release: <reason>`; with `--json`, a `team.error` v1 JSON document instead (`release.usage` for the arguments and an undeclared package, `release.configuration` for the file) | 64 |

A timeout, a transport failure, or a 408, 429 or 5xx response is retried exactly once; other failures are not retried.

A run whose npm `dist-tags` document shows `next` behind `latest` prints one `warn  <reason>` line
between the table and the summary line, or a `"warning"` member after `checks` with `--json`. The warning is a hint, not a
check: it changes no row, no status and no exit code, and a document that is absent or unreadable,
or whose tags are not versions, prints nothing.

## Example

The team file declares the package the run checks:

```yaml file=.agents/team.yaml
format: 1
project: beacon
coordinator: codex-keeper
operator: codex-keeper

trust:
  - ~/.config/team/lobby
  - ~/Code/beacon

workspace:
  mode: shared

releases:
  - package: material
    github: floor/material
    trusted_publishing: true
  - package: widgets
    github: floor/widgets
    linear_project: 01234567-89ab-cdef-0123-456789abcdef
    linear_keychain_service: team.linear.example
    activity_file: activity/2026/widgets.md
    activity_marker: "release: <package>@<version>"

seats:
  - role: coordinator
    name: codex-keeper
    label: coordinator
    cli: codex
    vendor: openai
    model: GPT Compass
    version: "2"
    launch: codex -m gpt-compass-2
```

The registry says material 3.0.2 is out with its provenance, the release and the changelog are
right, but the tag's commit has not reached the default branch and npm's `next` tag still points at
3.0.1 — one check missing, one warning, so exit 1:

```console
$ team release check material@3.0.2 ; echo "exit $?"
package material, version 3.0.2
  CHECK      STATE    DETAIL
  npm        pass     exact version, checksums, and provenance found
  tag        missing  tag commit is not an ancestor of the default branch
  github     pass     published release matches SemVer channel
  changelog  pass     changelog entry has a valid release date
warn  npm's next dist-tag points at 3.0.1, older than latest 3.0.2: run npm dist-tag add material@3.0.2 next
4 checks, 1 missing
exit 1
```

Rationale, behaviour, refusals and known limits: [docs/internal/release.md](../internal/release.md).
