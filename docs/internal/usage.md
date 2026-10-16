# Usage readings and account ownership

`team usage` reads subscriptions and their latest recorded figures. Its default output starts
with the machine account rows, then shows the caller's team and the account each seat draws on.
`--all` includes every team's rows and seat breakdown for the owner. The existing restricted view
still hides other teams' names, paths and seat rows from agents.

## Machine subscriptions

`~/.config/team/accounts.yaml` lists subscriptions once:

```yaml
accounts:
  - openai
  - anthropic
  - xai
  - google-antigravity
  - google-gemini
  - zai
  - deepseek
  - cursor
```

or keys each account by the entity whose subscription it is:

```yaml
accounts:
  northwind: [anthropic, openai]
  garden: [xai]
```

Both forms read the same list of machine accounts; a flat list is one unnamed entity. A map entry
whose value is no list of names keeps the older reading — its key is an account name of the unnamed
entity. Two entities listing one name: the first entry in the file owns it, and a name only the
unnamed entry carries is owned by nobody, so it is never borrowed. The borrowing rule is one
line: a team's seat spends an account, the map gives that account to an entity other than the
team's own `entity:` (a file naming none borrows every keyed account its seats spend), and the
team's row under the account's line ends `  (borrowed from <entity>)`. The same clause rides the
seat's spend-account row. It is display only, in both views: the account is counted once, under
the team that spends it, and the header count is unchanged. Nothing else moves — a borrowed
name prints a fact both the owner and a restricted caller already read, the account from the
machine's own file and the entity from the owner's own config.

These accounts count even if no team has a budgets section, and even if there are no team stores.
A team's approved `budgets.accounts` declaration of the same name supplies that team's account
kind, sources and reserve. Listing a machine account does not authorize a launch or approve a
check. Machine subscription figures are available outside a project; team-only accounts retain
the existing restricted-view boundary.

A seat's explicit `account:` takes precedence. Otherwise the paying account comes from its CLI
and launcher:

| Seat | Account |
| --- | --- |
| Grok | `xai` |
| Antigravity | `google-antigravity` |
| Gemini CLI | `google-gemini` |
| Codex | `openai` |
| Claude Code | `anthropic` |
| Claude Code through `claude-glm.sh` | `zai` |
| Claude Code through `claude-deepseek.sh` | `deepseek` |
| Cursor | `cursor` |

Antigravity seats also carry a model pool: `gemini` or `claude-gpt`. The store keeps pool readings
separate; unknown models have no inferred pool.

## Screen observations

The watch reads only a running CLI's recognized composer status row. Quota-looking text in the
transcript or input box is not a reading. The supported screen grammars are:

- Codex: the existing `weekly N% left` status cell.
- Grok: `Weekly limit left: N%`, including zero.
- Claude Code: an opt-in status line formatted `L: N% (44m) · W: N% (114h4m)`, where L and W
  are subscription percentages used for the session and weekly windows. This is a constructed,
  tested formatter contract, not a claim about the CLI's default status-line configuration.

Antigravity's screen fixtures do not provide a quota percentage. Accounts without a supported
screen grammar or a recorded figure print `not readable from a CLI screen`. Readable accounts
without an observation print `unknown`. The command emits no account-declaration notes.

The watch merges observations into `~/.config/team/usage/readings.json` under a machine lock and
replaces the file atomically. Each record contains account, optional pool, window, left/used
percentages, reset time if known, and observation time. It stores no team name, seat, path or
raw screen text. Different accounts and pools survive concurrent updates. A later observation
refreshes its age even when the percentage stays unchanged.

Machine observations are displayed from first sight. They do not replace the budget gate's
separate confirmation, source-order or reserve rules. Existing team check readings still
participate in the report, and an older machine observation does not replace a newer team
reading. Machine observations older than five minutes or past their reset are marked stale.

## Output and privacy

Text and JSON use the same report. `--json` has format 1, a read timestamp, view, caller project,
counts, account rows grouped by lab, unknown reasons, notes, and `teams` with seat mappings.
Subscription rows carry the window, left/used percentages, reset countdown and reading age;
Antigravity pool rows add `pool`. A machine account counts once even with multiple windows or
pools.

The full view belongs to the owner at a terminal. Every other caller receives the restricted
view: its approved team names and rows, shared machine subscriptions, and anonymized counts or
fixed notes for other teams. Raw state errors and unbound state strings do not cross that
boundary. `--all` does not elevate an agent's permissions.

`usage` itself is read-only: it runs no check, starts no CLI, reads no pane or CLI session file,
and writes no state. Missing project data is a note and exit 0. Invalid arguments or an unreadable
store directory return exit 2. A missing or malformed machine reading cache supplies no figures.
