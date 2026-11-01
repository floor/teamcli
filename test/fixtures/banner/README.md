# Wrapper banner screens

Constructed, not captures. The welcome box in each is the measured shape from the retained
Claude Code captures (`test/fixtures/claude-code/2.1.289/`, `2.1.302/`) and the retained wrapper
pane (`test/fixtures/exit-typing/claude-code-idle-ansi.txt`): a blank line, the version line
` ▐▛███▛█   Claude Code v<version>`, the model line `▝▜██████▀  <model> · <billing>`, and the
workspace line ` ▝▝   ▝▝   <workspace>`. Only the model line's words are constructed.

- `current.txt`: one box whose model line is a provider wrapper's id (`glm-5.3 · API Usage
  Billing`) above an ordinary composer. The pane's one header, and the id the reader should take.
- `quoted.txt`: the transcript above the box quotes an older id (`Example from an old transcript:
  glm-5.2 · API Usage Billing`). The quote is prose; the header under it is the current model.
- `stale.txt`: two boxes, an older one above the current one, as a pane that restarted the CLI
  without clearing its scrollback shows. The pane cannot say which conversation is current, so
  no model is read.
