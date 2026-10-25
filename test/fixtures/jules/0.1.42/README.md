# Jules (jules) 0.1.42 terminal captures

Captured from the installed google/jules CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards, at a 54x23 pane and, for
`wide.txt`, at a 148x39 one (a client attached at 196x40). `jules version` printed
`Version: v0.1.42`; `jules --version` answered `Error: unknown flag: --version` and exited 1.
Workspaces were scratch checkouts (`<workspace>`, `<ws>`). Session ids, descriptions, repo
names, ages and branches are placeholders at the same widths. The rows keep the pane's
trailing padding as the read drew it, and each file ends with the pane read's one newline.

- `idle.txt`: `jules` at its session table. The input line is the pane's first line,
  ` > Search sessions or type / to use`; the footer wraps as
  ` enter: select session | ctrl+r: refresh |` / `ctrl+d: delete | ctrl+c: quit`. The list
  groups sessions by repo (`# <owner>/<repo>`), and its status column draws blank at this
  width. The `Working in:` line under the table names the scratch folder.
- `working.txt`: the detail card of a running session, opened with `enter` on the table. The
  card is 46 columns wide and draws at the top of the pane above blank rows; its status cell
  reads `Awaiting User` / `Feedback` on the card's next line, and its footer reads
  ` enter: select action | esc: go back`.
- `done.txt`: the detail card of a completed session — the same card with `Completed` in the
  status cell. The profile reads it idle, so the next send walks back to the table before it
  types.
- `wide.txt`: the session table at 148x39. The table scrolls the banner's top rows off but
  keeps `Welcome to Jules CLI!` on screen above it, so the banner is drawn in the ready screen
  and marks neither a leaving screen nor a logged-out one. The input line reads
  ` > Search sessions or type / to use commands`, the footer stays on one line
  (` enter: select session | ctrl+r: refresh | ctrl+d: delete | ctrl+c: quit`), the status
  column is drawn (`Completed` on ten of eleven rows, blank on one), the repo group lines read
  `# <repo>` at the group name's own width, and eight trailing list rows are blank. The
  `Working in:` row shares its line with herdr's two status words.

## Not produced

- `unsent`: not produced. The table's input is a session search/filter and not a composer:
  text typed there filters the list and is never submitted as a brief.
- `permission`: not produced. The TUI asks for no permission. A session's tool approvals
  happen on the remote service, not in this pane.
- `question`: not produced. A session waiting for an answer draws `Awaiting User Feedback` on
  its card and is classified working. Nothing is answered in the TUI.
- `trust`: not produced. No folder-trust screen was drawn in the scratch workspace.
- `exit question`: not produced. One ctrl+c at the table returns the shell without a question.
  After the shell returns, herdr's visible rows still hold the TUI frame, so a later read is
  the same idle screen and there is no separate capture to take.
- `unknown`: not produced. There is no exit screen to capture: one ctrl+c at the table returns
  the shell, and herdr's visible rows still hold the idle table (see `exit question`).
- `vendor notice`, `provider error`, `rate limit`: not produced. The TUI draws none of these;
  a failed remote session is a row or card state, and the one screen the CLI does draw for a
  failure is the logged-out table.
