# grok 1.0.77 (50ca579fa996)

Captured from the installed Grok Build CLI on 2026-11-11 with `herdr pane read`.

- `trust.txt`: the folder trust dialog a fresh start drew when the launch line carried no
  `--trust` (the folder path is replaced by a synthetic one). The dialog takes one key: `y`
  proceeds, `n` quits. With `--trust` on the line the same fresh folder opened straight on the
  prompt.
- `permission.txt`: the command approval a seat drew on 2026-11-14 for a compound shell command
  its allow rules did not cover (a `cd … && for … do team drops …; done` loop). Paths, ids and
  names are replaced by synthetic ones. Three numbered choices under the command, and the
  footer `1/3:select │ Tab:next option │ … │ Ctrl+c:cancel`. Nothing was answered.
- `permission-narrow.txt`: the same approval in a narrower pane on 2026-11-15, for a
  `cd … && team ack …; echo …` command: the option rows keep the `┃` gutter, and the footer
  ends at `Ctrl+c:cancel` without the `Esc:scrollback` cell. Paths, ids and names are
  replaced. Nothing was answered.
- `welcome.txt`: the fresh start a restored seat showed on 2026-11-16 (the welcome card, a
  `Tip:` row, then the empty box). Rebuilt from that day's `herdr pane read` rows on the
  1.0.70 frame's geometry, with the folder line `~/work/demo` and the footer
  `Grok 4.7 (high) · auto`. It reads as `idle`; the same frame with a line drawn in the box
  reads as `unsent`.

## Not produced

This folder holds the screens measured on 1.0.77: the trust dialog, the command approval and
the welcome frame.
The other screens of the profile stay measured on the earlier version folders.

- `idle`: `welcome.txt` above is the fresh-start idle frame; the in-session idle prompt is
  measured in the earlier version folders.
- `unsent`: not produced in this folder; the box with typed text is measured in the earlier
  version folders (and its wrapped rows live on 1.0.77, 2026-11-12, by the typed-wake probe).
- `working`: not produced in this folder; measured in the earlier version folders.
- `question`: not produced in this folder; measured in the earlier version folders.
- `unknown`: not produced in this folder; the exit screen is measured in the earlier version folders.
