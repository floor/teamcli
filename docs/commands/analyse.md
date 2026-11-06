# team analyse

Reads a repository after verifying the owner's `analyser` setting and reports what the project is,
how it is tested and released, its open work, its parallelizable vs. serial paths, and its git
pace. Writes no file, creates no team or project record, executes no discovered check, and confers
no grant.

Project file content is treated as material, never as instructions: a project file requesting a
seat count, model, lab, `grant:`, `trust:` or `policies:` is recorded in `report.findings` with
`file:line` provenance and never followed.

## Synopsis

    team analyse [<path>] [--json]

## Who may run it

The owner at a terminal or the seat named in the owner's `analyser` setting (`projects.yaml`,
`entities.yaml` or `settings.yaml`) whose read scope covers `<path>`. Without a named analyser, no
project file is read. An analyser with `scope: public` is refused on a non-public project before
any project byte is read.

## Exit codes

| Outcome | Exit | Printed |
| --- | --- | --- |
| report | 0 | the project analysis report, or one `team.analyse` JSON document when `--json` is passed |
| unauthorised | 1 | `team analyse: <reason>` on stderr when no analyser is named or the caller is not the named analyser |
| scope | 1 | `team analyse: <reason>` on stderr when a `scope: public` analyser is run on a non-public project |
| unreadable | 1 | `team analyse: <reason>` on stderr when `<path>` cannot be read or is a symbolic link |
| usage | 2 | `team analyse: <message>` and the usage on stderr |

## Examples

Without a named analyser, `team analyse` refuses before reading any file:

```console
$ team analyse . ; echo "exit $?"
team analyse: no analyser is named for this project; set analyser in entities.yaml or projects.yaml before running team analyse
exit 1
```
