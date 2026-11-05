# Grok Build 1.0.70 welcome frame

The frame is the provided capture `idle.txt`, sanitized: the folder line is `~/work/demo`.
Trailing spaces after the box edge were dropped so the input row ends on its right border.
`seq-02.txt` through `seq-12.txt` are one identical tail of this welcome, the same empty
composer. `seq-01.txt` is a shell line, not a composer frame, and is not stored here.

A run of the screen grammar on this file printed `kind=idle`. The same run printed
`kind=unsent` and `boxHoldsText` true for the line `Read /t/mail/abc and do that.` drawn
into the input row. The shipped `1.0.52/working.txt` printed `kind=working`, and
`1.0.52/question.txt` printed `kind=question`.

The banner in the capture reads `Grok Build  1.0.70`. The profile's tested range is
unchanged: this folder is the frame the typed wake reads, not a new tested ceiling.

- `idle.txt`: the welcome frame described above, the provided capture, sanitized. It reads as
  `idle`.

## Not produced

- `trust`: not produced, the capture came from a folder the CLI already trusted, so no trust
  question was drawn.
- `unsent`: not produced, no live unsent frame is stored; the grammar check above drew a line
  into the input row of this frame rather than capturing a typed box.
- `working`: not produced, the welcome frame is a ready box; no turn was run in this folder.
- `question`: not produced, no question dialog was drawn in this folder.
- `permission`: not produced, no permission dialog was drawn in this folder.
- `unknown`: not produced, the folder holds no shell-return frame.
