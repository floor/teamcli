# Cursor Agent 2026.10.19 ready frame

This folder holds one screen, the composer's ready frame at `v2026.10.19-6bbf2c4`. It is a
derivative of the single read-only pane capture the orchestrator made on 2026-10-22 at
02:21:27Z, authorized by Atlas at 02:17:41Z (source visible, text format, exit 0, empty
stderr). It is not the builder's own native capture: the builder neither read a pane nor
reproduced the screen. The raw result is retained privately outside this repository at mode
0600, 1,794 bytes, SHA-256
`0ce553d2de3a7c5ecf155e1f225060d696b6d7aa7645351314633d40b1f00a16`; the retained provenance
record beside it is 1,385 bytes, SHA-256
`32d2208af64b207d30029468de1a898a9402682f6c2aa5e275cde6bd89cbc5c7`. The launch argv it
recorded names `--model gemini-4-argon-high`.

The transformation from the raw screen, recorded here so the derivation can be checked:

- Raw rows 1 and 2, the shell's echo of the launch command and its prompt, are omitted: they
  carry the operator's private launch path. The Cursor screen begins at raw row 3.
- Raw row 14, the workspace line naming the operator's private lobby path, becomes
  `  <workspace>`, the placeholder the other Cursor capture folders use.
- Every other row is copied byte for byte. The trailing newline is kept, and rows 3 through 14
  give the 12-row file here: 1,473 bytes, SHA-256
  `1fd7ec439fff3546d98c7da48b9b0a0fd4e90b1a712b7d3fe8bbe31552806a3c`.

## Captured screen

- `idle.txt`: the `Cursor Agent` and `v2026.10.19-6bbf2c4` header, the `/config` tip, the box's
  two border rows (` ▄` and ` ▀`, 189 characters each: one space and 188 block characters), the
  prompt row `  → Plan, search, build anything`, the 188-character status row
  `  Gemini 4 Argon High` followed by padding and `Run Everything`, and the workspace line.
  It reads as `idle`, and the status row names model `Gemini Argon`, version `4`.

Only the ready frame was captured at this version. The trust, permission, question, working,
unsent and exit shapes keep their `2026.10.16` captures and their readings; this folder makes no
claim about those screens at `2026.10.19`.
