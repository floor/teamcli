# Grok Build 1.0.88 screens

Real captures (`herdr pane read --source visible --format ansi`), 2026-11-17, cut to the composer
rows (from the box's opening rule down). No names or paths remain.

- `idle-hint-ansi.txt`: a live test seat's idle, unfocused pane. The empty box draws the hint
  `Build anything` in 38;2;78;78;78 with no faint attribute; the prompt glyph is 38;2;65;65;65 and
  the row's padding carries the text pen 38;2;155;155;155.
- `draft-equal-ansi.txt`: a scratch 1.0.88 pane with the words `Build anything` typed (not sent).
  The typed text is drawn in the text pen 38;2;225;225;225 (the same, focused or unfocused). The
  capture held the words twice (typed twice); the row was collapsed to one copy, the styling bytes
  untouched.

## Not produced

This folder pins the composer's hint and draft styling only; the other screens stay measured in the earlier version folders.

- `trust`: not produced in this folder, which pins the frames listed above only.
- `idle`: not produced as `idle.txt`, the real idle frame here is `idle-hint-ansi.txt`.
- `unsent`: not produced as `unsent.txt`, the real draft here is `draft-equal-ansi.txt`.
- `working`: not produced in this folder, which pins the frames listed above only.
- `question`: not produced in this folder, which pins the frames listed above only.
- `permission`: not produced in this folder, which pins the frames listed above only.
- `unknown` (exit): not produced in this folder, which pins the frames listed above only.
