# Claude Code 2.1.303 terminal captures

## Captured

- `unsent-multiline-ansi.txt`: Claude Code 2.1.303 on herdr 0.7.1, with four composer rows typed line by line, including one blank row. The existing send-delivery regression records this provenance. The drawing cannot distinguish explicit newlines from a soft wrap, so delivery holds the draft without changing it.

## Not produced

This folder holds one regression capture, not a baseline set; the baseline screens of this
build were not taken.

- `idle`, `unsent`, `working`, `question`, `permission`, `trust`, `unknown`: not produced. Only
  the multi-line draft above was captured at 2.1.303; a refresh with `scripts/capture-cli.ts`
  takes the baseline set.
