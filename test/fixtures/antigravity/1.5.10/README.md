# Antigravity (agy) 1.5.10 screens

Synthetic, derived from `../1.4.12/idle.txt`: the empty composer row replaced by the permission
mode hint agy 1.5.10 draws there after shift+tab (seen live on 2026-11-17), and the footer's
right side as 1.5.10 draws it. `unsent-after-mode.txt` is the same box with more text after the
hint, which stays unsent.

`idle-auto-mode-ansi.txt` and `draft-equal-ansi.txt` are real captures (`herdr pane read --format ansi`)
from a scratch agy 1.5.10 pane on 2026-11-17, cut to the composer rows. The hint is drawn after a
blue prompt glyph (38;5;12) in grey 38;5;8; a typed draft of exactly the same words is drawn in the
default pen with no SGR. Since RFC event-comms E1 the styled read decides: the plain synthetic
`idle-auto-mode.txt` above reads `unsent` (the hint words alone never authorise typing).
