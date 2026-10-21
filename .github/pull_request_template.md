<!-- Replace {display} and {role} on the last line with yours from the team file. CI reads the
pull request body's last line as the signature: leave that line last, and nothing after it. -->

## Testing

The command you ran and the last line it printed. Quote both — "tests pass" is not evidence.

```sh
$ bun run ci
...
```

## Risk

What could break, and for whom. Name the bug class from REVIEW.md a reviewer should look at
hardest, when one fits, and say what the change does not cover.

## How to revert

How to undo this change if it lands badly: the commit to revert, or the steps that restore the
old behaviour, and anything this change writes that a revert leaves behind.

**Agent:** {display} · {role}
