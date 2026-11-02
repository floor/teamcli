# Muse Code 1.4.14 captures

These three frames are byte-identical copies of the Muse Code 1.4.14 captures kept with the
exit-typing fixtures, SHA256 verified; the Muse exit scenes read them from this folder so they
do not share a folder with another lane's fixtures. Their capture is documented there: a scratch
Muse Code 1.4.14 session (`muse --provider echo --yolo --no-session-log`) read through its
pane's visible screen at 200 lines in ANSI form, the launcher's own shell rows above the banner
left out, every other byte the capture's own.

- `muse-idle-ansi.txt`: the ready box. Reads `idle`. 651 bytes, SHA256
  `01b362f8c59a296cdfe1e7519c6a4e7fd93c02a566c89ddbeb21b93c98c9b310`.
- `muse-unsent-ansi.txt`: the box after `/exit` was typed and the completion row was drawn.
  Reads `unsent`, box exactly `/exit`. 809 bytes, SHA256
  `a55716a00139102a46f9b30034b64e8fdad30bb34cba97605327bb1ffa4133cd`.
- `muse-unsent-newline-ansi.txt`: the box after an Enter pressed before the row settled:
  `/exit` on the input row and one empty row under it. Reads `unsent`; the box does not read
  back as `/exit`. 686 bytes, SHA256
  `435f1e9b097ed8c27ac841a7d8e47fedd783d28c23ee9b4831b31197cb799fa9`.
