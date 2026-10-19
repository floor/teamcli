---
created: 2026-10-18
updated: 2026-10-19
kind: spec-draft
status: draft
read-at: v0.5.0 (52db9b75)
for: Communication (module 002, v2 draft)
public: not yet; staged in the private docs; ported after review with no private link
---

# Spec: messaging

## 1. Scope

This spec covers how one seat's message reaches another: the records a send writes (the drop file,
the history line, the route record), the signed message record and receipt the receive side reads,
the commands that move them, and the rules that decide an address, an admission and a delivery
order. It does not cover the event bus or message statuses (the events spec), the seat state the
watch keeps (the seat-state spec), or who may instruct whom (the Kernel's instruction boundary).

## 2. Terms

- **seat** — one agent's place in a team, named in the team file.
- **agent id** — the registry's id for a seat's agent: `agt_` and twelve hex characters, assigned
  once, immutable, never reused.
- **nickname** — the name humans use for a seat; unique within its team; two teams may share one.
- **drop file** — the file a send writes into the recipient's drop folder, read by nobody else.
- **wake line** — the one short, fixed line typed into a seat's pane to wake it.
- **history line** — one JSON line appended to the project's message history per settled send.
- **message record** — the signed JSON document the receive side reads, one per message.
- **receipt** — the signed JSON record written once a record's body has been displayed.
- **route record** — the bookkeeping of one address handed out for the native channel.
- **leg** — one way of delivering; the delivery order is the list of legs tried in turn.
- **outcome** — the word a send ends in, matched by the process exit code.

## 3. Formats

### The drop file

Lives at `.agents/send-drops/<session>/<seat>/<id>` inside the checkout; written by the sender's
`team send`; mode 0600, written whole by a temporary file renamed into place; the `send-drops`
folder, the session folder and the seat folder are each mode 0700. A per-seat lock serialises
writes to one seat. The first line names the sender the tool saw and the rule that admitted it:

```
from <agent id> (<name>, <seat>@<team>) — admitted by: <rule>
from the owner — admitted by: <rule>
from the file's seat <seat> (no registry record yet) — admitted by: <rule>
```

The rest of the file is the body, whole, never split, never typed as a trigger line.

### The history line

One JSON line per settled send in `<project state folder>/messages.jsonl`
(`<home>/.config/team/<project>-<hash>/messages.jsonl`), written by `team send`; the file rotates at
1 MB keeping three (`messages.jsonl`, `.1`, `.2`). `refused`, `--list` and `--dry-run` write
nothing. Fields (`src/send/history.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `ts` | string (ISO-8601) | yes | — | 0.4.x | when the line was written |
| `from` | string | yes | — | 0.4.x | the sender, as the log names it |
| `to` | string | yes | — | 0.4.x | the recipient seat |
| `body` | string | yes | — | 0.4.x | the message body, whole |
| `id` | string | yes | — | 0.4.x | the drop's id |
| `outcome` | string | yes | — | 0.4.x | one of `delivered`, `held`, `not-submitted`, `unreachable`, `answered`, `timeout` |
| `spec` | string | no | absent | 0.5.0 | the address the caller wrote, when not the resolved seat's own name |
| `resolved` | string | no | absent | 0.5.0 | the agent id the spec resolved to, written with `spec` |
| `ms` | number | no | absent | 0.5.0 | send to outcome in whole milliseconds, when measured |
| `via` | string | no | absent | 0.5.0 | the path the message travelled: `typed` or `socket` |
| `failed` | string[] | no | absent | 0.5.0 | the legs that did not take the send, each `<leg>: <reason>`, in the order tried |
| `note` | string | no | absent | 0.5.0 | a qualifier the outcome cannot carry: `taken, not yet confirmed`, `taken but never acted on` |

### The message record

Lives at `.agents/messages/<seat>/<id>.json` inside the checkout, one folder per recipient seat;
the filename is the id. Signed with the checkout's message key under the message domain, bound to
the checkout (`root`) and to the team file's `session`: a copy under another id, in another seat's
directory, or bound elsewhere does not verify. `team init` keeps `.agents/messages/` out of git.
Fields (`src/commands/messages.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `kind` | `'message'` | yes | — | ≤0.4 | the record's kind |
| `id` | string | yes | — | ≤0.4 | the message id; the file's name |
| `to` | string | yes | — | ≤0.4 | the recipient seat |
| `root` | string | yes | — | ≤0.4 | the checkout the record is bound to |
| `session` | string | yes | — | ≤0.4 | the team file's session the record is bound to |
| `at` | string | yes | — | ≤0.4 | when the record was written |
| `body` | string | yes | — | ≤0.4 | the message body |
| `from` | string | yes | — | ≤0.4 | the sender named on the record |
| `from_id` | string \| null | no | `null` | 0.5.0 | the sender's registry agent id (`agt_`), or null for the owner and the launch |
| `to_id` | string \| null | no | `null` | 0.5.0 | the recipient's registry agent id (`agt_`), never the state's `seat_` handle; null when the registry holds no record for the seat |
| `rule` | string | yes | — | ≤0.4 | the admission rule the send judged |
| `thread` | string | yes | — | ≤0.4 | the thread's first message id; a first message is its own thread |
| `brief_sha256` | string | no | absent | 0.5.1 | a general-seat-brief delivery's canonical brief hash |
| `incarnation` | string | no | absent | 0.5.1 | the delivery lifetime the brief record belongs to |

Nothing at the tag writes this record.

A general seat brief's delivery is this envelope with its own sender and id. Its `from` is
`the launch`, its `from_id` null, and its `rule` names the launch's admission; `thread` is its own
id, and `brief_sha256` and `incarnation` bind it to the delivered text and to the delivery
lifetime. Its `to_id` is the recipient's `agt_` id when the registry has one — never the state's
`seat_` handle — and null otherwise. Its id is not minted at random: it is the delivery lifetime
and the delivered body read as a lowercase UUID (`sha256(incarnation "\n" attempt "\n" body)`,
with the attempt omitted at zero), so one lifetime delivered again keeps the id and a reworded
brief is a new message under the same lifetime. The record is written by the launch paths and by
`team brief rollout --apply`, beside the claim in the session's state that names its expected id,
the brief's sha256, the incarnation, the runtime epoch, the attempt and the stage.

### The receipt

Lives beside the record at `.agents/messages/<seat>/<id>.read.json`, written by `team messages`
only once the body has been displayed; signed under the receipt domain with the same message key,
never the approval key. A record that does not verify shows nothing and writes nothing. Fields
(`src/commands/messages.ts`):

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `kind` | `'receipt'` | yes | — | ≤0.4 | the record's kind |
| `id` | string | yes | — | ≤0.4 | the message id it receipts |
| `to` | string | yes | — | ≤0.4 | the recipient seat |
| `root` | string | yes | — | ≤0.4 | the checkout binding |
| `session` | string | yes | — | ≤0.4 | the session binding |
| `at` | string | yes | — | ≤0.4 | when the receipt was written |
| `brief_sha256` | string | no | absent | 0.5.1 | a general-seat-brief read's binding: the claim's brief hash |
| `incarnation` | string | no | absent | 0.5.1 | the claim's delivery lifetime |
| `brief_epoch` | string | no | absent | 0.5.1 | the runtime epoch the reading process was started under |
| `brief_seat_handle` | string | no | absent | 0.5.1 | the seat's `seat_` handle as the read copied it from the state |
| `brief_pane_root_pid` | number | no | absent | 0.5.1 | the pane's root process as the read copied it from the state |

A brief read's binding is all three of `brief_sha256`, `incarnation` and `brief_epoch`, or none:
the receipt an `inbox_read` or a `team drops --read` writes for the general seat brief carries
them, and no ordinary receipt does. The three must still be the claim's when the receipt is read —
the epoch ties the receipt to the runtime process that wrote it, so a receipt an earlier process,
an earlier text or an earlier delivery left does not count for the current claim.

### The route record

One JSON line per address handed out for the native channel, in
`<project state folder>/routes.jsonl`, written by `team route` and by `team send --record`'s
bookkeeping; same store ladder, mode 0600, 1 MB rotation as the history. A route moves no text, so
it is not written into `messages.jsonl`. The record is written before the address is answered: a
record that cannot be written is a refusal, never a silent route. Fields (`src/send/routes.ts`):
`ts`, `from`, `from_id` (null for a declared seat the registry holds no record for), `to`, `to_id`,
`team`, `session`, `pane`, the address handed out or null, and its state — `live` (the recorded
address's process still runs in the pane), `stale`, `pane` (none recorded, one found on the pane),
`none`, `unread` (the pane could not be read). A recorded native delivery whose text never passed
through the CLI is written to the history with the body marker
`(native delivery; the text did not pass through the team CLI)`, outcome `delivered`, `via`
`native`.

### The envelope (planned; OD-20261019-14)

One message model for every channel: whatever the channel, a message becomes one envelope. Nothing
at the tag writes or reads one. Fields:

| Field | Type | Required | Default | Since | Meaning |
|---|---|---|---|---|---|
| `id` | string | yes | — | planned | the message's id |
| `thread` | string | yes | — | planned | the thread it belongs to; a thread may cross channels |
| `channel` | string | yes | — | planned | the channel the message came by, or goes back on |
| `from` | string | yes | — | planned | the sender's identity, mapped from the channel's own authentication |
| `at` | object | yes | — | planned | one timestamp per stage |
| `priority` | string | yes | — | planned | the message's priority |

*Source:* OD-20261019-14. *Proof:* none at the tag.

## 4. Commands and options

Synopses as the commands print them at the tag; exit codes by their ids (the exit-codes registry).

### `team send`

```
team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
team send <seat> --file <path> [--wait] [--timeout <s>] [--json] [--dry-run]
team send --record <seat> --channel <native> --ms <N> [<message>] [--json] [--dry-run]
team send --record <seat> --channel <native> --ms <N> --file <path> [--json] [--dry-run]
team send --list [--json]
```

- `--file <path>` reads the body from a file instead of the one `<message>` argument; the two
  cannot both be given.
- `--wait` asks and waits for the reply. **Refused for every seat at the tag** (`send.refused`):
  the frame it rides is a socket write this build does not make; a Claude Code seat's refusal names
  the native leg (`team route` and the caller's own cross-session tool) that will carry a waited
  send once it ships. `--timeout <s>` sets the wait window, a whole number of seconds, and is only
  meaningful with `--wait`.
- `--json` prints one document: `{format, dry_run, status, action_summary, project, session, seat,
  channel, ids, reply?, plan?}`; `--list` prints its own: `{format, project, session, seats,
  summary}`. A run that exits 1 or 2 writes the structured error.
- `--dry-run` resolves the seat and shows what would be sent, and sends nothing.
- `--list` shows the seats a message could reach; it sends nothing and needs no caller check.
- `--record` writes no drop file, sends no frame and touches no pane: the sender writes down a
  delivery it made itself — one history line, outcome `delivered`, `via` `native`, with `--ms`.
  `--channel` takes `native`, the one channel this half exists for, and is required beside
  `--record`; `--wait` and `--timeout` are refused there.

Broadcast is not in this build.

**Outcomes and exit codes** (contract/exit-codes.json): `delivered` (`send.delivered`, 0),
`answered` (`send.answered`, 0), `listed` (`send.listed`, 0), `recorded` (`send.recorded`, 0),
`held` (`send.held`, 1), `not-submitted` (`send.not-submitted`, 1), `timeout` (`send.timeout`, 1),
`unreachable` (`send.unreachable`, 1), `refused` (`send.refused`, 1); `send.detached` (1) and
`send.stopped` (1) beside them; usage and configuration errors exit 2 (`send.usage`,
`send.configuration`). Dry runs exit 0 as `send.dry-run` / `send.record-dry-run`.

### `team messages`

```
team messages [--json]
```

Shows a message that is already waiting and writes the receipt that says it was shown. Exits 0 when
the inbox is read (`messages.shown`, or `messages.none` when empty), 1 when the caller, team file,
or message record is refused (`messages.file`, `.id`, `.key`, `.root`, `.seat`, `.session`,
`.shape`, `.signature`), 2 when the invocation cannot be read or this folder is not a git
repository (`messages.invocation`, `messages.not-a-repo`). A seat name matches
`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$`.

### `team feed`

```
team feed [--seat <name>] [--limit <n>] [--all] [--audit <path>] [--briefs <dir>] [--follow] [--json]
```

Reads the project's message history, together with any brief files and audit lines when present;
each event is one row: when it was written, its kind (the send outcome), who sent it to whom, and
its body folded to one line. `--seat` filters to messages sent by or to a seat; `--limit` caps the
entries (default 50); `--all` reads across all project state folders on the machine; `--follow`
keeps reading; `--json` prints one machine-readable document. Exits `feed.ok` (0),
`feed.unreadable` (1), `feed.configuration` / `feed.usage` (2).

### `team route`

```
team route <seat> [--json] [--dry-run]
```

Answers one seat's address for the native channel: the recipient's agent id, session, CLI and pane,
and the socket path its session listens on — the recorded address while its process still runs in
the pane, else the socket the pane carries now. The recipient is resolved live; a seat that does
not resolve is refused, and no address is answered. Access is decided exactly as a send's is,
default deny: only an admitted pair is answered, and the rule that admitted it is named. A seat the
registry holds no record for is refused. Exits `route.routed` (0), `route.dry-run` (0),
`route.refused` / `route.unrecorded` / `route.detached` (1), `route.configuration` /
`route.usage` (2).

## 5. Rules

### The address grammar

1. A bare `<seat>` or `<nickname>` names a seat of the caller's team. `<seat>@<team>` names a seat
   of a team by the position's name; `<nickname>@<team>` the same seat by the name humans use.
   `@<nickname>` names the seat with that nickname, looked up in the caller's team first, then
   across the entity: one match is sent; several are refused listing them; none is refused pointing
   at `team send --list`. `lead@<team>` names the team's lead — the seat whose role holds `leads`,
   else the owner. The agent id (`agt_` and twelve hex) is the canonical form records and scripts
   use. (Proof: the resolve tests at the tag.)
2. The forms with a team and the id work from any folder.
3. `lead` is reserved as a seat name and as a nickname, so `@x` always names a nickname. No role
   addresses: nothing resolves by a role's name.
4. Every form resolves to one seat's agent id before any rule runs; a spec that matches both a seat
   and a nickname is refused naming both, and the collision is prevented where names are written.
   The history keeps what was addressed (`spec`) beside who it resolved to (`resolved`).
5. The address is not an authorization: admission judges the resolved pair, and a nickname confers
   nothing.

### Addressing a seat (planned; OD-20261019-19, OD-20261019-23)

| Rule | At v0.5.0 | Meaning |
|---|---|---|
| A name is unique within its team, not across the entity | yes (rule 1, and the terms) | two teams may share one name; `@<nickname>` still refuses when the entity holds several |
| A seat is addressed `name@team` across the entity | yes: `<seat>@<team>` and `<nickname>@<team>` resolve from any folder (rule 2) | the address names one seat and resolves to its agent id |
| The address is the seat (the normal team address); an agent may also be addressed directly | not built at v0.5.0 | a message to a seat goes to the agent on watch when it is delivered — a reattribution changes the watch, never the address; an agent may also be addressed directly under the same admission and authority rules, for example about its own watch after it was relieved (OD-20261019-23) |
| The address resolves through the registry at delivery | not built at v0.5.0: it is resolved when the message is sent | delivery resolves the address again, to the seat attributed at that moment |

*Source:* OD-20261019-19, OD-20261019-23. *Proof:* the resolve tests at the tag cover the forms;
none at the tag covers resolution at delivery.

### The admission rules

Default deny. A send is admitted only by one of these rules, and each names itself in the verdict
so the drop file's first line can carry both the sender's agent id and the rule that let it
through (`src/send/admit.ts`; proof: the admit tests at the tag):

1. the owner;
2. the project lead and the leads of its teams (either direction);
3. team leads within one project to each other;
4. seats crossing teams within one project, where the project allows it — the `seats_cross_teams`
   declaration, entity → project → team → seat, default off, never across projects;
5. an orchestrator to another orchestrator;
6. an orchestrator or operator to a seat of its own team;
7. an assistant seat to its entity's coordinator;
8. a seat to its own team's orchestrator;
9. an owner-signed grant naming `send`, which spells a team by its registry team id or a seat by
   its agent id, never a runner or process name.

The project rules are asked first and are decided by the project record and the `leads`
capability, never by a role's word; a pair whose teams share no project keeps the team rules.
"Orchestrator" and "operator" are places in the team file's chain, read from the roster's
capabilities and the file's own keys, never role words. A record confers no right: registration, a
lifecycle, a signing role — none admits anything by itself. A sender the registry holds no record
for is judged from the team file's own declaration, so the rules that stay inside that team reach
it, and the header says the record is missing; it is never granted. Every other pair is refused
(`send.refused`, exit 1) and names its reason.

### The delivery order

1. The legs are `native` (the sender is a session of the recipient's own kind and sends over its
   own channel with its own attestation; the tool supplies the address from the registry, checks
   admission and records the send), `mcp-inbox` (not in this build), and `typed` (the drop file and
   the wake line). (`src/settings/inherit.ts`, `DELIVERY_LEGS`.)
2. The order is the `delivery-order` policy of the receiving seat's chain — entity, project, team,
   seat — because the order says how that seat's messages may travel. The fallback is `native`,
   `mcp-inbox`, `typed`. A level drops or reorders the legs, never adds one.
3. The legs are tried in order until one confirms; a leg that does not exist for this sender or
   receiver is skipped and recorded `unavailable`; a send falls through to the next leg only on a
   definite failure before the send went through (no session, refused, a timeout before the send),
   never on a missing acknowledgement after a send that went through — or the seat gets the message
   twice. Every attempt is recorded with the leg and the failure (the history's `failed` field).
4. The tool never attests a permission mode on a seat's behalf: a CLI process cannot truthfully say
   which mode it runs in, and attesting anyway would be a false statement to another tool's gate.

### What `delivered` means

`delivered` means the line left the seat's input box after that one line and Enter — the pane's
status reported the seat working (or done or blocked, and not the status read before Enter), or
the transcript shows the drop being read — not that its agent read the message
(`src/send/deliver.ts`). A line that left the box with no status or transcript evidence inside the
window is reported `taken, not yet confirmed`. A seat whose CLI builds its own work item from its
screens gets the drop file but the body typed through those screens; `delivered` there means the
CLI printed the line that creates the item. A hold on the receiver's side — a message that reached
a session but sits in a dialog the sender cannot see — is `held`, with the side named, never
`delivered`. At most three Enters are pressed, each try waited on 1 s, 3 s, then 9 s, with a
further window for a cleared box to show the seat took the line. The whole verify window is
bounded at 20 seconds (`VERIFY_TOTAL_MS`, `src/send/deliver.ts`): the three waits and the further
window all fall inside it. The tag's measurements — about six seconds from send to a working
seat, one millisecond to write the record — are measured, not promised.

### Typing into a pane

1. The only text typed into another seat's pane is the wake line, and it is measured: a trigger
   longer than the measured line is refused, never cut.
2. A pane whose composer already holds unsent text is never typed into: the send is `held`, said,
   and the message stays on disk until a person clears the box. A greyed suggestion or placeholder
   is faint and counts as an empty box, never text to wait for or to clear.
3. `team send` is the only path by which one agent types into another seat's pane.
4. The pane policies (`pane-authority` enforced, `pane-conduct` advised) govern any key sent into
   another agent's pane; raw keys are a logged fallback at the end of the delivery order, never a
   path of their own.

## 6. Registries

- **delivery-legs** (registries/delivery-legs.md):
  `native` | the sender's own cross-session channel, recorded through the route record | 0.5.0 | `src/settings/inherit.ts` (`DELIVERY_LEGS`) | the only leg that is the sender's own tool
  `mcp-inbox` | delivery into a seat session's MCP inbox | 0.5.0 (named) | `src/settings/inherit.ts` | not built at the tag; skipped and recorded `unavailable`
  `typed` | the drop file and the wake line | 0.5.0 | `src/settings/inherit.ts` | the fallback
- **exit-codes** (registries/exit-codes.json's rows): the `send.*` (15 rows), `messages.*` (10),
  `feed.*` (4) and `route.*` (6) rows listed in §4, read at the tag.
- **policy-names** (registries/policy-names.md): `delivery-order` (enforced, the leg order),
  `pane-authority` (enforced, who may answer a pane's prompt), `pane-conduct` (advised, how a key
  is sent).

## 7. Open points

- Nothing at the tag writes the signed message record: the send side writes the unsigned drop file
  and the history line; the two stores are not yet one.
- Read and answered are not receipts: a delivery outcome says the seat's program took the line,
  never that its agent acted.
- Who may talk to whom is a fixed list in the code, not a per-team setting; nothing yet marks a
  delivered message as material rather than an instruction.
- The history rotates at 1 MB keeping three files; a retention setting is owed and does not exist.
- The per-project send daemon is written but no shipped command starts it; sends take the direct
  path.

## Revision log

- **Draft** (the writer, 2026-10-18): lifted from the Communication v2 draft; read at the tag.
- **Fold before the round** (the writer, 2026-10-19): the envelope's fields added to §3 and the
  address rows to §5 as planned, from OD-20261019-14, -19 and -23; the rest read at the tag.
- **Fold after the pre-round reviews** (the writer, 2026-10-19): §5's address row keeps the
  explicit direct-agent address beside the seat address, both under the same admission and
  authority rules (OD-20261019-23).
