# The team inbox leg: routes, bounds and evidence

`team mcp serve` is the seat-side half of the mcp-inbox delivery leg. The seat's launch line
starts it with the seat's own CLI, the CLI calls `inbox_check` and `inbox_read`, and `inbox_read`
writes the receipt that says the message was read. This page is the runbook: which CLIs carry a
route in this build, what each registration writes, the bounds on every wait, and the evidence
rule behind the status words.

## Per-CLI routes, as measured

Every row was measured on this machine on 2026-10-18 with the binary's own `--version` and
`--help`; no owner config file was opened.

| CLI | Version measured | Route team uses | Written in the seat's folder | Registration surface quoted |
| --- | --- | --- | --- | --- |
| claude-code | 2.1.302 | none — it has the native leg | nothing | `claude mcp add ... -s, --scope <scope> (local, user, or project)` |
| codex | codex-cli 0.161.0 | two `-c` values on the launch line, naming `mcp_servers.team_inbox` | nothing | `-c, --config <key=value>` "Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`" |
| gemini | 0.64.0 | `gemini mcp add -s project team-inbox ...` | `.gemini/settings.json` | `-s, --scope <user\|project> (default: "project")` |
| cursor | 2026.10.14-0f9edde | team merges the entry into `.cursor/mcp.json`; the launch line adds `--approve-mcps` | `.cursor/mcp.json` | `mcp login <identifier>` names ".cursor/mcp.json"; `--approve-mcps` "Automatically approve all MCP servers" |
| grok | 1.0.60 | `grok mcp add -s project team-inbox ...` | `.grok/config.toml` | `-s, --scope <user\|project>`; "project (./.grok/config.toml)" |
| antigravity/agy | 1.4.2 | none — drop and typed legs | nothing | `agy mcp add` has no scope flag and no per-run config route |
| muse | 1.4.10 | none — drop and typed legs | nothing | `muse init` scaffolds `AGENTS.md`; no workspace settings route in `--help` |
| jules | no MCP in `--help` | none — drop and typed legs | nothing | none |

A route the launch line carries writes no file. A route that is a file is written in the seat's
own folder, before the launch command runs, so the client starts with the server in place.

## What launch writes, and where it refuses

codex gets its registration from the launch line itself and nothing is written. gemini and grok
run their own `mcp add -s project` in the seat's folder, and team requires the file the command
claims to write to exist afterwards. cursor's file is written by team: the `team-inbox` entry is
merged into `.cursor/mcp.json`, every other server and key is kept, and the new text is written
beside the file and renamed over it at mode 0600. A file that is a link, not a regular file, not
JSON, not one object, or whose `mcpServers` is not an object is left exactly as it is and the
registration is refused.

The written config names this install's runner — the executable and its entry script — so the
server starts whether or not `team` is on the PATH.

Nothing team writes may land in a file the project tracks. Before writing or running `mcp add`,
team asks git in the seat's folder: a folder that is not a work tree is the seat's own and is
allowed; one inside a work tree must have the target ignored. A target the project does not
ignore is refused, and nothing is written — including a file force-added to the index while
`.gitignore` names its directory, which `git check-ignore` reports as not ignored. A repository
with no work tree is refused the same way.

A refused registration leaves the seat on its drop and typed legs and the seat's line carries the
reason, prefixed `the team inbox was not registered: ` — for example `its project does not ignore
.cursor/mcp.json`, `` `gemini mcp add` exited 1 ``, or `.gemini/settings.json was not written`.
The seat still launches.

## The bounds

Every wait on the leg is bounded.

| Bound | Value | What it does |
| --- | --- | --- |
| listen-or-skip | the `.inbox-listener` marker names a live pid | no live server is a definite failure; the walk moves on and records `mcp-inbox: no live inbox listener` |
| `INBOX_GRACE_MS` | 2000 ms | how long `team send` waits for a receipt after writing the drop |
| `INBOX_FALLBACK_MS` | 10 minutes | how long the watch leaves an unread inbox drop to the seat's own client before typing the drop's trigger |
| `PENDING_MAX_TRIES` | 3 | typed retries once the fall-through starts |
| `PENDING_MAX_AGE_MS` | 30 minutes | the marker's whole life, from the send |

A send with no receipt in the grace prints `sent (unconfirmed)`, keeps the drop and the marker,
and ends the walk there: the message is safe, and the seat's client may still read it. The watch
promotes a receipt to one `delivered (read)` history line and clears the marker, typing nothing.
After `INBOX_FALLBACK_MS` with no receipt the watch's retry pass types the drop's existing
trigger, records `mcp-inbox: no receipt within 10m` in the history line's `failed`, and the typed
leg's own verification decides the outcome. The retry obeys the existing pane rules: a dialog, a
draft that is not the trigger, an unreadable status or a human's own pane is never typed into,
and a drop that runs out of bounds is reported with its path rather than lost.

`team feed` shows one row per message: a later line for the same id — receipt, fall-back or taken
report — replaces the earlier outcome, and a `--follow` pass prints the update when it arrives.

## The evidence rule

The receipt is the only evidence this leg produces, and it is written by `inbox_read` before the
body is returned, once the record's signature has been checked against the checkout's message
key. It is the signed status receipt `team messages` writes — `{payload: {kind, status, id, to,
root, session, at}, signature}` at `<id>.read.json`, signed with the same message key — so one
module answers for the inbox, `team drops`, `team messages` and the watch, and each verifies the
receipt rather than trusting the file's presence. A file that is not a signed record, or whose
signature does not verify, is refused with a tool error and no receipt: a receipt never proves a
read of something the server could not authenticate. It says the seat *read* the message, not
that it acted on it. So:

- a receipt is `delivered (read)`, in the console, the JSON, the history and `team feed`;
- no receipt is `sent (unconfirmed)`, with the drop kept;
- nothing on this leg is ever reported as acted on.

The receipt is the signed status receipt, write-once per status: a signed one is never rewritten,
so a second reader adds nothing and no read moves a status backward, while a file at the name this
key did not sign is replaced by the signed receipt, never trusted and never left to block it. Its
signature is the procedural evidence: a file at that name this key did not sign, or one naming
another message, seat, checkout or session, proves nothing
and leaves the message waiting. Nothing it says is ever derived from pane text or a status.

## Checking a build

The behaviour is pinned by these suites, run with `bun test`:

- `test/mcp-inbox-server.test.ts` — the stdio server: tools, receipts, seat binding, refusals;
- `test/mcp-register.test.ts` — per-CLI routes, exact argv, the git rule, the file merge and its
  refusals;
- `test/launch/inbox-launch.test.ts` — registration happens before the launch command, and a
  refusal is detail under the seat's record;
- `test/send-delivery-order.test.ts` — the walk and its outcomes;
- `test/held-retry.test.ts` — promotion, fall-through and the bounds;
- `test/feed.test.ts` — one row per message.
