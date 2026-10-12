# `team release check`: rationale and known limits

What moved off [the `team release check` page](../commands/release.md): what the run
reads and writes, the team file's `releases` section and the Linear key's one-time setup, the
checks and what each one passes on, the refusals, and the known limits. The synopsis, the flags,
the caller table and the exit codes stay on the page.

## What the run does: the records, the two pairs, the checks

Checks the public npm and GitHub records of one release: the exact version and its checksums on
npm (with a provenance attestation when the file declares trusted publishing for the package), the
tag and where it points, the GitHub release, and the changelog entry. With the file's Linear pair
it also verifies the project's milestone and a qualifying status update; with the activity pair,
the release marker in the project's public activity file. It is the checklist after a publish: run
it by hand, or let CI run it after it creates a tag.

## What it reads and writes

Reads the team file — by default `.agents/team.yaml` of the repository's main checkout, found
through git's common directory, so a run inside a linked worktree reads the main checkout's file,
not the worktree's; a folder that is not a git repository is read from `.agents/team.yaml` in that
folder only, not from a parent, and a link at `.agents` or at the file is not followed;
`--file <path>` names another file instead, a relative path resolved
against the working directory — then the file's `releases` section, then the public records over HTTPS
only: the npm registry's version and attestation endpoints, and GitHub's repository, tag, compare,
release and contents endpoints — plus, when the file configures them, one read-only GraphQL read
of the Linear project and one contents read of the activity file. Every read is credential-free
except that one Linear request, whose key is read from the macOS Keychain (below); no read uses a
token, a credential helper or a local git fetch. It writes nothing: no state, no baseline, no
cache, no approval — nothing to npm, GitHub, Linear or a file. A timeout, a transport failure, or a
408, 429 or 5xx response is retried exactly once; other failures are not retried. A run makes at
most eleven endpoint reads and twenty-two attempts, or thirteen and twenty-six with both optional
pairs configured.

## Who may run it

Anyone. It needs no herdr session, no terminal, no approval and no login. The Linear check is the
one exception: it reads its key from the macOS Keychain, so it needs macOS, an interactive run
(standard input a terminal), and the one-time setup below — anywhere else that one check is
`unknown` and the others are unaffected.

## The team file's releases section

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

One entry per published package: `package`, its `github` owner/repo, and `trusted_publishing: true`
when npm provenance is required (omit it otherwise). A package the section does not declare cannot
be checked; an invalid section fails `team doctor`, and the command reports it with exit 64.

Two optional pairs each add one check. In a pair, either both keys are present or neither is:

| Pair | Meaning |
| --- | --- |
| `linear_project`, `linear_keychain_service` | the Linear project's stable ID (a lowercase UUID), and the Keychain service name holding the key — a name, never a key |
| `activity_file`, `activity_marker` | the repository-relative path of the public activity file on the default branch, and the line to find in it, with `<package>` and `<version>` replaced by the checked values |

### The Linear key, once

The team file never carries the key. Create a personal API key in Linear's own settings, then store
it in the macOS Keychain under the service name the pair carries — `security` prompts for the value:

```sh
security add-generic-password -a linear -s team.linear.example -w
```

The command reads the key from the Keychain at run time, holds it in memory, and puts it in exactly
one place: the `Authorization` header of the single request to `https://api.linear.app/graphql`. It
is never put in the team file, an argument list, an environment variable, a child process, a file,
a log line, a diagnostic or the output, and a redirect is never followed. The command reads no
proxy setting of its own and always addresses the Linear host over HTTPS; if the runtime it runs on
is configured to use a proxy — the standard proxy environment variables, where the runtime honours
them — the connection is tunnelled through it, and a proxy that inspects TLS with a certificate
this machine trusts can see the request, the header included. Run the check on a network you trust.
The Linear read is read-only: the command never writes to Linear.

## What it finds

Four checks always, in a fixed order; the `linear` and `activity` rows are present exactly when
their pairs are configured, after the four. Each check is `pass`, `missing` (a completed read that
disproves the condition) or `unknown` (a read that failed, or answered something unexpected — never
a pass):

| Check | Passes when |
| --- | --- |
| `npm` | npm has the exact version with `dist.shasum` and `dist.integrity`, and, with `trusted_publishing`, a provenance attestation for it |
| `tag` | GitHub has `v<version>` and its commit is an ancestor of the default branch |
| `github` | GitHub has a published release for `v<version>` whose `prerelease` flag matches the version |
| `changelog` | `CHANGELOG.md` on the default branch has `## [<version>] - <YYYY-MM-DD>` (or without the brackets) with a real calendar date |
| `linear` | the configured project is active, has exactly one milestone named `<version>` and it is complete, and has a status update dated at or after the changelog release day |
| `activity` | the configured public activity file has the marker line exactly once |

## Refusals

| Message | Exit |
| --- | --- |
| `team release: a subcommand is required: check` | 64 |
| `team release: unknown subcommand "<name>"` | 64 |
| `team release: a <package@version> is required` | 64 |
| `team release: unexpected "<argument>"` | 64 |
| `team release: unknown option --<name>` | 64 |
| `team release: --file needs a value` | 64 |
| `team release: "<argument>" is not <package>@<version>` | 64 |
| `team release: the package "<name>" is not a package name` | 64 |
| `team release: the version "<version>" is not a Semantic Versioning 2.0.0 version` | 64 |
| `team release: <package> is not declared in the team file's releases` | 64 |
| `team release: <path>: no team file at <path>` | 64 |
| `team release: <path>, line <n>: <message>` | 64 |

## Examples, moved here whole

The examples below are the page's own, moved here whole, in the order they stood in. The
first console is also on [the `team release check` page](../commands/release.md); the rest run only
here, and their order and their output matter only here.

The registry says material 3.0.2 is out with its provenance, the release and the changelog are
right, but the tag's commit has not reached the default branch — one check missing, so exit 1:

```console
$ team release check material@3.0.2 ; echo "exit $?"
check      status   detail
npm        pass     exact version, checksums, and provenance found
tag        missing  tag commit is not an ancestor of the default branch
github     pass     published release matches SemVer channel
changelog  pass     changelog entry has a valid release date
exit 1
```

A package with both pairs configured adds their two rows; here the milestone is complete, the
status update is after the release day and the marker line is in place — every check passes:

```console
$ team release check widgets@3.0.2 ; echo "exit $?"
check      status  detail
npm        pass    exact version and checksums found
tag        pass    tag resolves to a commit on the default branch
github     pass    published release matches SemVer channel
changelog  pass    changelog entry has a valid release date
linear     pass    Linear milestone is complete and a qualifying status update exists
activity   pass    public activity marker found
exit 0
```

The same runs as one JSON object, for the checklist that records them:

```console
$ team release check material@3.0.2 --json ; echo "exit $?"
{
  "package": "material",
  "version": "3.0.2",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version, checksums, and provenance found" },
    "tag": { "status": "missing", "detail": "tag commit is not an ancestor of the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" }
  }
}
exit 1
```

```console
$ team release check widgets@3.0.2 --json ; echo "exit $?"
{
  "package": "widgets",
  "version": "3.0.2",
  "checks": {
    "npm": { "status": "pass", "detail": "exact version and checksums found" },
    "tag": { "status": "pass", "detail": "tag resolves to a commit on the default branch" },
    "github": { "status": "pass", "detail": "published release matches SemVer channel" },
    "changelog": { "status": "pass", "detail": "changelog entry has a valid release date" },
    "linear": { "status": "pass", "detail": "Linear milestone is complete and a qualifying status update exists" },
    "activity": { "status": "pass", "detail": "public activity marker found" }
  }
}
exit 0
```

An undeclared package is a usage error, in the same JSON shape when `--json` is given:

```console
$ team release check other@3.0.2 --json ; echo "exit $?"
{"error":{"code":"usage","message":"other is not declared in the team file's releases"}}
exit 64
```

`--file` names the team file to read — here a relative path against the working directory — and a
file that isn't there is the configuration refusal, before any record is read:

```console
$ team release check material@3.0.2 --file policy/team.yaml ; echo "exit $?"
team release: ./policy/team.yaml: no team file at policy/team.yaml
exit 64
```
