# Muse Code 1.4.14 screens

These frames are real captures of Muse Code 1.4.14 (`Muse Code 1.4.14 (1.4.14-R7309.1)`),
taken 2026-11-02 from a scratch session (`muse --provider echo --yolo --no-session-log`) in a
pane of a scratch terminal-host session with a synthetic home, its working folder
`/private/tmp/muse-exit-fixtures-proj` — a scratch project created for the capture. The frames
were read from the pane's visible screen at 200 lines in ANSI form, with CRLF folded to LF; the
launcher's own shell rows above the banner are left out. Every other byte, SGR included, is the
capture's own — except `hint-grey-synthetic.txt`, which is a synthetic derivative and says so
below. The same bytes are kept with the exit-typing fixtures.

- `idle.txt`: the ready box. Reads `idle`. 651 bytes, SHA256
  `01b362f8c59a296cdfe1e7519c6a4e7fd93c02a566c89ddbeb21b93c98c9b310`.
- `unsent.txt`: the box after `/exit` was typed and the completion row was drawn, the frame the
  production restart found. Reads `unsent`, box exactly `/exit`. 809 bytes, SHA256
  `a55716a00139102a46f9b30034b64e8fdad30bb34cba97605327bb1ffa4133cd`.
- `hint-grey-synthetic.txt`: not a capture — `idle.txt` with its input row replaced by the
  rotating hint a live 1.4.14 pane drew (2026-11-05): the blue prompt (`38;2;90;160;255`) and
  the hint text in grey (`38;2;103;108;116`), no faint attribute. Reads `idle`; the profile
  declares that grey as `placeholder_fg`. 737 bytes, SHA256
  `ede6dbdb28b1981733430776ab46a47bce8a35782df96397be429ff0ccf9ba43`.

## Not produced

- `trust`, `working`, `question`, `permission`, `unknown`: not produced. The session that
  produced the captured frames ran the echo provider and drew no model turn, trust question,
  permission prompt or shell return, so no other screen was captured.
