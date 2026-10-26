# The command page template

A public command page, `docs/commands/<command>.md`, is for a person deciding how to use the
command. It is short, and every part of it is plain:

````markdown
# team <command>

<One line: what the command is for.>

## Usage

    team <command> <the common forms, one per line>

## What it does

<Three to six plain sentences: what happens, what it changes, what to do next.>

## Examples

<A line that says what the example shows.>

```console
$ team <command> … ; echo "exit $?"
<brief output>
exit 0
```

<Two or three examples. A `console` example runs in `bun test`; an `sh` example shows commands
whose output the page does not pin. A hidden team the examples run against is a
`yaml file=.agents/team.yaml hidden=1` fence: the tests write it, and the site does not show it.>

## Options

| Option | Meaning |
| --- | --- |
| `--flag <value>` | <one line> |

## Who can run it

<One line.>

## See also

[team <other>](<other>.md) · …
````

Everything else (each refusal with its exact text, every outcome and exit code, the JSON
documents, the edge cases) goes in the full reference, `docs/internal/commands/<command>.md`.
That page keeps the old exhaustive form, and its examples run in `bun test` like the public
page's. The public site never shows or links it.

`test/docs/human-command-pages.test.ts` holds a rewritten page to this shape. Add a command to
its list when its page is rewritten.
