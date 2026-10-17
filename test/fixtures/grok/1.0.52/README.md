# Grok (grok) 1.0.52 terminal captures

Captured from the installed macOS grok CLI with herdr 0.7.1, `pane read --source visible`,
in a scratch session created for the purpose and stopped afterwards. `grok --version` printed
`grok 1.0.52 (0920c8169e27) [stable]`. Workspaces were fresh temporary directories
(`<workspace>`). A fresh directory showed no trust dialog.

- `idle.txt`: `grok --permission-mode default`. The closing rule reads `Grok 4.7 (high)`.
- `working.txt`: a `sleep` turn. The spinner row ends in `[stop]` and the footer’s middle
  cell is `Ctrl+c:cancel`.
- `question.txt`: a choice between two names. The widget draws `Waiting on answers`,
  `↑/↓ navigate`, `Enter:submit`, and `Tab:next answer`.
- `permission.txt`: a request to approve writing a file. The same widget, not a separate
  allow/deny screen. Nothing was written.
- `exit-typed.txt`: `/exit` typed, the slash menu open, not sent.
- `exit.txt`: after Enter on `/exit`. `Resume this session with:` and the shell prompt.
  The resume id is `<session-id>`.

The closing rule also draws `Grok 4.7 (high) · always-approve` when the process is started
without `--permission-mode` on a config that already approves. That screen is not a second
fixture; the rule pattern is the two dashes every box rule carries.

## Not produced

- `trust`: not produced, a fresh directory showed no trust dialog on this CLI.
- `unsent`: not produced, the installed binary 1.0.60 is newer than this folder's 1.0.52, so
  a 1.0.52 composer screen cannot be launched on this machine without downgrading. The
  capture waits for a refresh to the installed version, in a new version folder with its own
  `tested.to` bump.
