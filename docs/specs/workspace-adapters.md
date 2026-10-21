---
created: 2026-10-18
updated: 2026-10-18
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75) for what the core does today through herdr; herdr and tmux behaviour as documented by their own help on 2026-10-18
for: Runtime (the workspace, seat persistence, the seat state, the watch); the design note 2-runtime/work/workspace-adapters-2026-10-18.md (OD-20261018-09)
public: staged for review; contains no private links
---

# Spec: workspace adapters

## 1. Scope

The contract between TeamCLI's core and a **workspace adapter**: `headless` (built in, the default; seats are turn runners), or `herdr` / `tmux` (optional; they keep seats alive in panes for live viewing). It also covers how each plugin implements each operation, and how a plugin's
states map onto TeamCLI's seat states.

## 2. Terms

- **workspace adapter:** an implementation of §3. `headless` is built in; herdr and tmux are optional.
- **turn runner:** in headless, one non-interactive turn of a seat's CLI on its saved conversation, per message.
- **pane:** where one seat's CLI runs and shows its screen.
- **status source:** the part of an adapter that reports a seat's state.
- **headless:** the default adapter. No pane; seats run turn by turn.

## 3. Formats: the contract

| Operation | Purpose | Required |
|---|---|---|
| `session.ensure(name)` | create or reuse the team's session | yes (except headless) |
| `pane.create(seat, cwd, label)` | a pane for a seat, with its label | yes (except headless) |
| `pane.run(pane, command, env)` | start the seat's CLI in the pane | yes (pane adapters) |
| `turn.run(seat, message, conversationId)` | headless: run one non-interactive turn on the saved conversation, return the reply, the outcome and the new id | yes (headless) |
| `pane.read(pane, lines)` | the visible screen, for the screen module | optional (headless: none) |
| `pane.label(pane, label)` | set the seat's label (nickname · role) | optional |
| `pane.type(pane, line)` | the typed leg: bracketed paste preferred, refused for `human: true` | optional |
| `pane.close(pane)` | close a seat's pane | yes (except headless) |
| `status.wait(seat, {not: s} or {is: s}, timeout)` | block until the seat's state changes or reaches `s` | optional (a fallback is the screen module, or the CLI's hooks) |
| `status.stream()` | push every state change of every pane | optional |
| `prompt.kind(seat)` | name the prompt a blocked seat shows | optional |
| `notify(title, body, sound)` | a desktop notification | optional |

### Mapping per adapter

| Operation | herdr (optional) | tmux (optional) |
|---|---|---|
| session.ensure | `herdr session …` | `tmux new-session -d -s <name>` (or `has-session`) |
| pane.create | `herdr workspace create --cwd … --label …` | `tmux new-window -t <session> -c <cwd> -n <label>` |
| pane.run | `herdr pane run <pane> '<cmd>'` | `tmux respawn-pane -k -t <pane> '<cmd>'` |
| pane.read | `herdr pane read <pane>` | `tmux capture-pane -p -t <pane> -S -<lines>` |
| pane.label | `herdr workspace rename` / `agent rename` | `tmux rename-window`, `select-pane -T` |
| pane.type | `herdr pane send-text` (+ Enter) | `tmux load-buffer -` then `paste-buffer -p -t <pane>` (bracketed), then `send-keys Enter` |
| pane.close | `herdr pane close <pane>` | `tmux kill-pane -t <pane>` |
| status.wait | `herdr wait agent-status <pane> --status <s> [--timeout]` | no agent awareness: the screen module, the CLI's hooks, `monitor-silence` / `alert-silence` for idle |
| status.stream | none | control mode `tmux -C` (`%output`, `%pane-mode-changed`, …) |
| prompt.kind | the screen module | the screen module |
| notify | `herdr notification show <title> --body … --sound …` | `tmux display-message`, or a system notification |


### Turn runner flags per profile (verified from each CLI's help, 2026-10-18)

| Profile | One turn | Resume | Id |
|---|---|---|---|
| claude-code | `claude -p`, `--output-format` | `--resume <id>` | `--session-id <uuid>` (pre-set) |
| codex | `codex exec`, `--json`, `-o <file>` | `codex exec resume <id>` | from the first run |
| grok | `grok -p` (`--single`), `--output-format` | `-r <id or title>` | from the first run |
| cursor | `cursor-agent -p`, `--output-format` | `--resume <chatId>` | `cursor-agent create-chat` |
| antigravity | `agy -p`, `--output-format`, `--print-timeout` | `--conversation <id>` | from the first run |
| jules | `jules new --repo <r>` (cloud) | by session id | from `new` |
| muse | to verify | `muse resume <ref>` | to verify |

## 4. Commands and options

Choosing an adapter is a setting at entity or project level (registry, OD-20261018-08):
`workspace: headless | herdr | tmux` (default `headless` from step 3 of the plan; `herdr` until then).
`team doctor` reports the adapter in use, its version, and which optional operations it lacks.
`team attach <seat>` (pane adapters only) opens the seat's pane.

## 5. Rules

1. The core calls only the contract, never a backend's command directly.
2. States map onto `working`, `idle`, `done`, `blocked`, `unknown`. An adapter that can't tell `done` from `idle` reports `idle` for both and says so in `team doctor`. The headless turn runner knows all five exactly.
3. A `human: true` pane is never typed into and never waited on, whatever the adapter.
4. One status event per transition. Polling never produces repeated events.
5. An adapter missing `pane.read` has no typed leg. Delivery uses drop, the MCP inbox, native, or (headless) the next turn.
6. Persistence never depends on a live process: the conversation id, the messages and the event log are the state.

## 6. Registries

- `workspace-adapters` (proposed): adapter | backend | version tested | optional operations it supports | note.
  - `headless | none | — | turn.run, exact status | the default from plan step 3`
  - `herdr | herdr | as of 2026-10-18 | status.wait, prompt via screen, notify | the source of 0.5.x behaviour`
  - `tmux | tmux | to test | status.stream (control mode), notify | no agent awareness`
- `seat-states`: `working`, `idle`, `done`, `blocked`, `unknown` (shared with the events registry).

## 7. Open points

See the design note's §8: herdr's wait semantics, `status.stream`, the idle threshold, `seat.done`
noise, the waiter count on a loaded machine, headless hooks, turn-runner limits and caching, Muse, and adapter packaging.

## Revision log

- 2026-10-18: draft 1 (the orchestrator), from the owner's directions that evening; same night: renamed from workspace-plugins, headless and the turn runner added (OD-20261018-09).
