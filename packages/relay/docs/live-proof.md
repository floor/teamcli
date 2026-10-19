# Live proof at the extraction commit

Commit: `0635fd0d5313561066034e87adfda1bb239aa92b` — `feat(send): extract the socket and
durable-copy transport into @teamcli/relay`.

This page records what was run against this commit and what those runs showed. It distinguishes
measured results from unproven behavior and from plans for the next change. Nothing here is a
claim about a runtime reading a message, and nothing here validates a release beyond the runs
written down.

## What was run

Two kinds of run, both local and synthetic:

- **Transport runs.** A measuring script built one synthetic scratch folder and one local socket
  peer it created for the test, then called `stage`, `deliver` and `capabilities` from the
  package entry at this commit. No seat pane, no machine daemon, no owner file.
- **Packed-install runs.** The extraction run packed the repository and installed the tarball
  into a fresh scratch prefix. The installed `team` command was run read-only, and the relay files
  in the installed tree and in the tarball were compared by SHA-256 with the commit's files.

## Transport results

| Run | Result |
|---|---|
| `capabilities('claude-code')` | `routes: ['socket','durable-copy']`; `socket: {runtime:'claude-code', supported:true, frameLimit:1048576, timeoutMs:5000, ack:false}`; `durableCopy.supported: true` |
| `capabilities('codex')` | Same routes and limits; `socket.supported: false` |
| `stage`, fresh name | `outcome: 'stored'`; file mode `600`; folder mode `700`; file bytes equal the record's |
| `stage`, same name again | `outcome: 'stored'`, `existing: true`; the file is unchanged |
| `stage`, different record at that name | `existing: true`; the existing file is left unchanged — the package does not read or compare it |
| `stage` at a symbolic link | `refused`, `a file that is not a record already holds that id` |
| `stage` at a folder | `refused`, same reason |
| `stage` with a separator in the name | `refused`, `the record id cannot be a file name` |
| `deliver`, durable-copy route | `outcome: 'held'`, `the durable copy is stored; no live route delivered it`; the copy is on disk |
| `deliver`, socket route, fixture peer | `outcome: 'delivered'`, `bytes: 34`; the peer received exactly the frame line, trailing newline included |
| `deliver`, missing socket | `refused`, `nothing is listening there (the socket is gone)` |
| `deliver`, runtime without a socket | `refused`, `codex sessions have no cross-session socket` |
| `deliver`, frame past the limit | `refused` before any connection, `the frame is 1048578 characters, past the socket's measured limit of 1048576` |
| `deliver`, no frame | `refused`, `the socket frame is missing` |
| `stage`, injected clock | the receipt carries the injected time |
| `deliver`, injected dial | the injected dial is called once; its `ok: true` yields `delivered` |

What the socket row proves is the write: the frame left the client and the peer received those
bytes. It does not prove that a runtime read the record; this build returns no read receipt and
the socket carries no acknowledgement.

One receipt detail belongs with the results: on the socket route the receipt's `copy` names the
copy target the caller declared. The package does not stage it there, so that field is not
evidence the copy exists. `stage` first is the caller's contract.

## Packed install

The extraction run's tarball contains `package/packages/relay/` with `README.md`, `index.d.ts`,
`index.js` and `package.json`. In a fresh scratch prefix, the installed `team` command answered:

```
$ team --version
0.5.3-hotfix.10

$ team send --help
Usage: team send <seat> <message> [--wait] [--timeout <s>] [--json] [--dry-run]
```

(`send --help` exited `0`.)

The four relay files at the extraction commit have these SHA-256 digests:

```
a75b41ba1e3bbfd8cd4a77eb68840248990e902f59a0a325be29d596408fc0ce  index.js
c854be0bbbfb3a4d74f293573cc8ba4c1f951621e6f656d572c20fa1ea7304fd  index.d.ts
1f2aca2e3d717d2447cc018c685a9e615c8e6636e7be31aa1cab6ce3efd76869  package.json
1dc63d3015ecdf584791ab00c3e9db474a32999ac61d2aa8a752bbe83e1470d9  README.md
```

Before the documentation followup, the installed tree's copies and the tarball's copies matched
these digests byte for byte. The followup changes this page and the package README; it does not
touch `index.js`, `index.d.ts` or `package.json`.

## Fixed invariants and this version's scope

The policies are configurable: delivery order, a delivery timeout per route, and
delivery-escalation delays. The fixed invariants are: a signed durable copy before any attempt; a
route that would hold or block is never chosen; one message ID with de-duplication at the
receiver; every attempt recorded.

This version makes the copy-before-attempt rule the caller's contract and performs one attempt
without falling back. Receiver de-duplication, the attempt record, escalation and fallback are
the next change. No server, listener or delivery queue exists in this version.

## Not measured, and not claimed

- A runtime reading a delivered frame. No read receipt is returned by this build.
- Any wake, read or delivery of a durable copy.
- Receiver de-duplication, attempt recording, fallback or escalation — none is active here.
- Any server, listener or queue.
- Any behavior at a commit other than the extraction commit above.

Plans for the next change — a route that is held continuing to the next allowed route,
cross-route de-duplication, an attempt record, an ambiguous-receipt case and escalation — are
plans, not measurements. They are not validated by anything on this page.
