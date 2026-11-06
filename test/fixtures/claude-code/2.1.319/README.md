# Claude Code 2.1.319 terminal captures

The splash in the capture reads `Claude Code v2.1.319`. The profile's tested range is
unchanged: this folder pins one idle frame, not a new tested ceiling.

## Captured

- `idle.txt`: a visible pane read of an idle composer. The input row is
  `Try "how do I log an error?"` after the prompt, the opening rule carries a seat label,
  and the quota row names the model `k3-256k`. The folder line is `~/work/demo`. A run of
  the screen grammar on this file printed `kind=idle`. The same rows with the opening rule
  scrolled off printed `kind=idle` once the quota row accepts that model token; before that
  change the scrolled frame printed `kind=unknown`.

## Not produced

This folder holds one idle frame, not a baseline set.

- `unsent`, `working`, `question`, `permission`, `trust`, `unknown`: not produced. Only the
  idle composer above was captured at 2.1.319.
