# Muse Code (muse) 1.4.9 terminal captures

Taken from the installed macOS build (`muse --version` printed `Muse Code 1.4.9 (1.4.9-R6297.1)`)
with herdr 0.7.1, `pane read --source visible` (muse draws on the alternate screen, so the
default read shows nothing), in a scratch session made for the purpose. The composer's rules are
53 columns wide in the idle and usage captures. These are the operator spike's captures, split
where one file held two screens. The owner's home folder reads `/Users/example`,
the workspace path is `<workspace>`, and a session id is `<session-id>`, padded to the width of
the original so the box stays aligned. The owner's account name and address were in a `/status`
capture that is not kept here.

- `idle.txt`: `muse --no-session-log` in a trusted scratch folder, after the startup banner. The
  composer is the labelled rule `── Voice input (⌥ + v to start) ──…`, the empty input row `❯`, a
  closing rule of the same 53 columns, and the footer `muse-wonder-1.0 · high · …/muse-ws ·
  Auto-review`.
- `idle-footer.txt`: the same footer after scrolled output, the first screen of the spike's
  `model-line` capture.
- `unsent.txt`: text typed into the composer and not sent. The first row carries the prompt and
  the second row continues at column 3 (`  team.log`).
- `working.txt`: a turn in progress, `◇ Thinking (1s · esc to interrupt)` above the composer. The
  turn ran against muse's built-in `echo` provider (`--provider echo --echo-delay-ms 6000`), so
  the footer names `echo` where a real turn names the model. The pane was launched with
  `--trust-workspace`.
- `permission.txt`: an in-session command approval, `Would you like to run the following command?`
  with `⟩ 1. Yes, proceed (y)` in the composer's place and the footer reading `Ask me`. The model
  turn that asked came from a local mock server, so no model tokens were spent.
- `trust.txt`: the startup question without `--trust-workspace` or `--yolo`, `Do you trust this
  workspace?` with `⟩ 1  Trust and continue` and `2  Quit`.
- `model-picker.txt`: the `/model` picker, `Choose model` with the four model ids and `↑↓ move ·
  enter confirm · esc go back`, under the composer's rules.
- `usage.txt`: `/usage` after one short prompt. The box lists `Current` (the 5-hour window) and
  `Weekly`, each `0% used` with its reset.
- `usage-unavailable.txt`: `/usage` before any prompt, `Currently unavailable` under the plan's name.

## Constructed

- `wonder-full-constructed.txt`: `idle.txt` with the footer's model id changed to
  `muse-wonder-full-1.0`. The spike saw the footer print the base model id for every model, so this
  is the shape of that footer; nothing in it was read from a live pane.
- `spark-constructed.txt`: `idle.txt` with the footer's model id changed to `muse-spark-1.3`, built
  the same way and for the same reason.

## Not produced

- `rate limit`: not produced, the Power plan stood at `0% used` on both windows throughout, so no
  limit screen could be provoked. The binary's strings name `model failed: usage limit reached`.
- `unknown`: not produced, the screen after `/exit` was not captured, so the profile declares no
  shell-return screen. No exit-typed capture exists either.
- `question`: not produced, the spike's providers (the built-in echo provider and a local mock
  server) never asked the person a question, and the installed binary is 1.4.10, newer than this
  folder's 1.4.9. The capture waits for a refresh to the installed version with a provider that
  asks one.

Not captured, and so not declared in the profile: the files muse reads from the working folder at
start (`startup_reads`), a question screen from the model asking the person something, and a
trust-answer record. `--yolo` and `--trust-workspace` both skip the trust question.
