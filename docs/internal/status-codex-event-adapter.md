# Pure Codex app-server frame parser

This module turns one in-memory app-server frame into at most one native observation.
It does not open a socket, launch a process, read a transcript, or write presence.
A passing test is not a deployed adapter and not proof that a process exited.

Official schema research accessed 2026-11-06: [app-server reference](https://learn.chatgpt.com/docs/app-server)
(the public `/codex/app-server` URL redirects there). The page has no runtime version.
Generated schemas match only the CLI that produced them. Local measured history is the
comment in `test/codex-presence-source.test.ts` (2026-10-20, codex-cli 0.161.0, app-server
0.163.0): idle and empty-flag active `thread/status/changed`, plus `thread/started` and
`thread/name/updated`. That comment says turn events and waiting flags were not observed.
No original captured payload is in `test/fixtures/status-codex-events/`. Provenance marks
every file as measured-history or a documentation example, and `acceptanceComplete` is false.

`adaptCodexFrame(frame, envelope)` accepts JSON text or one plain object, up to 65536 UTF-8
bytes. Duplicate top-level keys, non-finite or oversized numbers, and accessors refuse with a
fixed reason and no thrown text. Inputs are left unchanged. Requests, notifications, responses,
and errors stay distinct. An unknown method is unsupported. A request is never read as the
notification of the same method name.

The envelope supplies reducer-safe seat, incarnation, main turn, lane, and sequence, plus the
expected provider thread id. Turn, item, and request ids, and any tool, gate, or binding, are
optional and have no defaults. Provider ids are compared literally. They are not copied into
seat, incarnation, main turn, or sequence. A reducer token that fails its 1–64 ASCII contract
is unsupported. The reducer is not changed.

| Frame | Result |
| --- | --- |
| `thread/status/changed` idle | Main quiet. An open gate stays |
| `thread/status/changed` active, empty flags | Main working advisory. Not a turn and not a gate |
| `thread/status/changed` active, any flag | Correlation-unproven. A waiting flag is not a gate |
| `notLoaded` or `systemError` | Ignored. Unload is not session-end |
| `turn/started` | Main turn-start when the caller expected that turn id. No gate fields |
| `turn/completed` | Main turn-end with no gate, tool, or binding copied |
| `item/started` command or file item | Main tool-start when the caller expected that item and supplied a token tool id |
| `item/completed` for those items | Main tool-end only with matching item id and caller tool, gate, and binding. Item status is not a permission grant |
| Approval server request | Main permission-gate only with matching thread, turn, item, request id, and caller gate binding |
| `serverRequest/resolved` | Correlation-unproven even when the request id matches. Cleanup and acceptance share this notification |
| `thread/closed` | Main session-end. Process confirmation remains needed |
| Subagent lane | `subagent` only, after the same identity checks. It cannot clear or confirm the main candidate |
| Other known noise, responses, errors, unrelated requests | Ignored |

The caller establishes correlation outside this parser. Equality checks consistency only.
Missing evidence stays unsupported or unproven and never fills a field.
