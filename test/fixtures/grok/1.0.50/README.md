# Grok (grok) 1.0.50 terminal captures

Captured from the installed macOS grok CLI on 2026-10-09 with herdr 0.7.1,
`herdr --session sandbox-grok pane read --source visible --lines 40`, in a scratch session
created for the purpose (stopped and deleted afterwards; the owner's default session was not
touched). There was at most one grok seat. `grok --version` printed
`grok 1.0.50 (c58f321264ba) [stable]`. The pane was launched with the launch line itself,
`AGENT_UNATTENDED=1 <grok-path> --always-approve` — the binary's path, the owner's install,
reads `<grok-path>` in these captures. The workspaces were fresh temporary directories (`<workspace>`); a fresh
directory showed no trust prompt, and both directories were left empty — the CLI wrote no file
into either — so the profile names no `lobby_files`. The config's hash is not the pre-round one:
the compact-mode probe set `compact_mode` on and it was set back off; whether the pinned
`permission_mode = "always-approve"` line stood there before the round could not be established.
The auth file's hash is unchanged.

- `idle.txt`: the fresh welcome screen, composer idle.
- `idle-ansi.txt`: the same screen with the pane's ANSI styling.
- `unsent.txt`: `RULES_RECEIVED` typed, never sent; one box row, the footer changed to the
  send keys (`Enter:send  │  Shift+Enter/Opt+Enter:newline`).
- `unsent-wrap.txt`: the 52-character line `Team watch: reports are waiting in .agents/team.log`
  — the text the watch types — typed and never sent: the box wraps it at its edge into two rows,
  the second drawn with the left border kept (`  │   team.log`).
- `working-start.txt`, `working-tool.txt`: a shell task running — the early
  `⠴ Waiting for response…       2.0s ⇣1.32k [stop]` row, and mid-tool
  `⠋ Sleep 20 seconds then …   10s ⇣21.0k [↓][stop]` with the transcript's scrollbar `█` column;
  the footer's middle cell is `Ctrl+c:cancel` in both.
- `after-turn.txt`: the turn ended (`Worked for 13s`); the footer is back to
  `Shift+Tab:mode  │  Ctrl+.:shortcuts`.
- `exit-typed.txt`, `slash-exit.txt`: `/exit` typed at idle; the slash menu opened above the
  box in both. The box's closing rule carried 6 dashes under `Grok 4.7 Fast (xhigh)` and 11
  under `Grok 4.7 (xhigh)` — the title moves the dashes around it — which is why the profile's
  composer rule is the two dashes every rule of the box carries.
- `slash-menu.txt`: the general slash menu (`/effort`, `/new`, `/resume`, `/mcps`) open over a
  box holding `/`; the menu's own full-width rules sit above the box's opening rule.
- `exit.txt`: after Enter on `/exit`: the CLI left, `Resume this session with:` and
  `grok --resume <session-id>` under its work line, the shell prompt below.
- `compact-mode.txt`: the compact UI (`Ctrl+.`) — a frame drawn at another width that the
  composer read cannot name: unknown, and nothing is typed into it.

Two probes are not kept as fixtures: with `LEFTOVER_TEXT` standing in the box, the ctrl+u key
left the box empty again (the profile's `exit_clear`), and `/exit` followed by one Enter left
the CLI for its shell with no question asked — no `exit_confirm` is declared.

Sanitised: the two temporary workspace paths are `<workspace>`; the binary path is `<grok-path>`;
the resume id is `<session-id>`. All other visible text is retained, including the box borders,
prompts, and the footer titles. Unknown screens permit no input.
