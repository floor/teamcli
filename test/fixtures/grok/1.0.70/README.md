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
