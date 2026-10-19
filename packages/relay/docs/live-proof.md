# Live proof: extraction, correction and host framing

This page records runs against four commits:

- `0635fd0d5313561066034e87adfda1bb239aa92b` — `feat(send): extract the socket and
  durable-copy transport into @teamcli/relay`. Its sections are historical: they keep what that
  commit did, including an existing-file limitation that the correction removed.
- `585791b3ca679b5006754697b3239e09f7f664cd` — `fix(relay): publish the durable copy with
  create-or-match`. Its section records the correction's own runs.
- `651cdb9d6` and `5a525041c` — `feat(relay): extract the machine socket framing host` and
  `feat(relay): hand the raw request line to the framing handler`. Their section records the
  framing host's focused synthetic tests at the second commit.
- `8a3bfcd8f` — `refactor(daemon): frame the machine socket through the relay host`. Its section
  records the machine-socket adapter's focused daemon tests.

This page distinguishes measured results from unproven behavior and from plans for the next
change. Nothing here is a claim about a runtime reading a message, and nothing here validates a
release beyond the runs written down. No run installs or starts the machine's daemon service,
removes a per-root listener, or claims a single endpoint.

## What was run

Three kinds of run, all local and synthetic:

- **Transport runs.** A measuring script built one synthetic scratch folder and one local socket
  peer it created for the test, then called `stage`, `deliver` and `capabilities` from the
  package entry at this commit. No seat pane, no machine daemon, no owner file.
- **Packed-install runs.** The extraction run packed the repository and installed the tarball
  into a fresh scratch prefix. The installed `team` command was run read-only, and the relay files
  in the installed tree and in the tarball were compared by SHA-256 with the commit's files.
- **Focused synthetic tests.** The framing host's tests bind a socket in a fresh temp folder and
  drive it with a client the test creates. The adapter's daemon tests start the daemon in a
  scratch home and a scratch git root, with the machine socket in that home. No installed daemon,
  no live seat, no owner file, no machine service.

## Transport results at the extraction commit (historical)

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

The third row is the extraction's limitation, kept as recorded: a regular file at the name was
reported `existing` without being read, so different bytes were accepted and left in place. The
correction section below records the create-or-match behavior that replaced it.

What the socket row proves is the write: the frame left the client and the peer received those
bytes. It does not prove that a runtime read the record; this build returns no read receipt and
the socket carries no acknowledgement.

One receipt detail belongs with the results: on the socket route the receipt's `copy` names the
copy target the caller declared. The package does not stage it there, so that field is not
evidence the copy exists. `stage` first is the caller's contract.

## Packed install at the extraction commit (historical)

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

## Correction at `585791b3ca679b5006754697b3239e09f7f664cd`

`fix(relay): publish the durable copy with create-or-match`. The correction publishes the copy
through an exclusive hard link, so an existing name is never replaced; a regular file at the name
is read without following a link, identical bytes are `existing`, and different bytes are
refused with the holder untouched.

The package files at this commit have these SHA-256 digests:

```
dbcb2630c40962184e9a3c2a2822046ea3b286eeaac9a247fe35b4aac2398876  index.js
c854be0bbbfb3a4d74f293573cc8ba4c1f951621e6f656d572c20fa1ea7304fd  index.d.ts
1f2aca2e3d717d2447cc018c685a9e615c8e6636e7be31aa1cab6ce3efd76869  package.json
```

`index.d.ts` and `package.json` are byte-identical to the extraction commit's. `index.js` is not:
it is the corrected publisher. This documentation commit adds no package code.

### Copy-collision and identity results

Run: one measuring script against the package entry at this commit, in one synthetic scratch
folder. For the races, two separate operating-system processes each waited on one shared
barrier time and then called `stage` at the same name; the two stages in a round started within
the same millisecond.

| Run | Result |
|---|---|
| `stage`, fresh name | `outcome: 'stored'`, no `existing`; file mode `600` in a folder at mode `700`; file bytes equal the record's |
| `stage`, same record at that name | `outcome: 'stored'`, `existing: true`; the file's inode and mtime are unchanged across the call; bytes still the record's |
| `stage`, different record at that name | `refused`, `a different record already holds that id`, with a receipt naming the copy and the time; the holder's inode, mtime, mode and bytes are unchanged |
| two processes, different records, 3 rounds | each round: one `stored` with no `existing` and one `refused` as above; the final file holds exactly one of the two records, never a mixture or a partial; no temporary file left |
| two processes, same record | both `stored`; exactly one carries `existing: true`; the file bytes are the whole record; no temporary file left |
| symbolic link at the name | `refused`, `a file that is not a record already holds that id`; the name is still a link and the target's bytes are unchanged |
| folder at the name | `refused`, same reason |
| unreadable holder at the name | `refused`, `the file that already holds that id could not be read`; the holder's bytes are unchanged |

What these runs show is the copy rule on this machine: a name is published whole without
replacing a holder, identical bytes match, and conflicting bytes are refused without a write.
They do not show a signature check — the package compares bytes and never checks what the record
means — and they do not show a distributed or durable-storage guarantee beyond the file being
written and read back in these runs.

## Framing host at `5a525041c` and the daemon adapter at `8a3bfcd8f`

The framing host module is `packages/relay/host/server.js` with `server.d.ts`; the daemon adapter
is the accept, frame, bind and close section of `src/daemon/host.ts`. Both changes are local to
this repository: the module is not a package export in this build, and the daemon still hosts
each checkout's existing send and bus listeners, so N checkouts mean 2N+1 endpoints in one
process. Nothing in these runs removes a per-root listener or installs or starts the daemon
service.

### What the framing host tests show

Run at `5a525041c` in the repository:

```
$ bun test test/relay-host-server.test.ts
 12 pass
 0 fail
 37 expect() calls
Ran 12 tests across 1 file.
$ bun run typecheck
$ tsc --noEmit
```

The tests use one synthetic socket in a fresh temp folder per case. They show:

- one complete newline-terminated line is decoded and handed to the handler as untrusted data,
  with its exact stripped line; a second line in the same write produces no second answer;
- a line that is not JSON is refused before the handler sees it;
- the frame limit counts the newline: with a limit of 8, seven characters plus the newline are
  accepted and eight characters plus the newline are refused, never truncated;
- with the default deadline off, a silent connection stays open; an explicit deadline answers
  `deadline` for a frame that never arrives, while a handler that outlasts the deadline still
  answers and is not refused;
- a multi-byte character split across separate writes is decoded to one character before the
  line is parsed;
- a thrown or rejected handler is refused as `handler-error`; an asynchronous handler answers,
  and concurrent connections keep their own inputs;
- close destroys open connections and stops accepting; a bind error at an occupied path is
  reported rather than repaired;
- an unknown file at the socket path is reported as `EADDRINUSE` and left untouched, never
  unlinked or repaired.

### What the daemon adapter tests show

Run at `8a3bfcd8f` in the repository:

```
$ bun test test/daemon-machine.test.ts test/daemon-health.test.ts \
    test/send-daemon-boundaries.test.ts test/send-daemon.test.ts \
    test/relay-host-server.test.ts
 63 pass
 0 fail
 354 expect() calls
Ran 63 tests across 5 files.
$ bun run typecheck
$ tsc --noEmit
```

The daemon runs in a scratch home with a scratch git root. The adapter tests show:

- the machine socket still answers health, and the daemon's state, startedBy and features still
  match the existing expectations;
- the `send` op still answers `daemon.auth-unsupported`;
- a malformed line, a JSON value that is not an object, and a frame past the limit keep the
  protocol's refusal bytes: `daemon.bad-frame` with `the request line is not JSON`, `the request
  is not a JSON object`, and `the request line exceeds the frame limit` respectively;
- a request carrying a `caller` or `scope` field does not get that field trusted or echoed: the
  health answer contains no such value;
- close destroys an idle connection;
- the machine socket keeps mode 0600 in a 0700 folder.

These runs do not show an installed daemon or a machine service start, one endpoint, a verified
principal, or any read or effect beyond the answers named above. The queue module
(`host/queue.js`) is not exercised by these runs; its contract is described in the README and is
not measured on this page.

## Fixed invariants and this version's scope

The policies are configurable: delivery order, a delivery timeout per route, and
delivery-escalation delays. The fixed invariants are: a signed durable copy before any attempt; a
route that would hold or block is never chosen; one message ID with de-duplication at the
receiver; every attempt recorded.

This version makes the copy-before-attempt rule the caller's contract and performs one attempt
without falling back. Receiver de-duplication, the attempt record, escalation and fallback are
the next change. The package starts no live server, listener or delivery queue: the framing host
binds only when its caller calls `listen`, inside the caller's process, and the queue opens no
socket. The daemon still hosts the per-root send and bus listeners, so N checkouts mean 2N+1
endpoints in one process.

## Reviewed next behavior (not in this build, not measured)

The timing values reviewed for the next change, kept under the three policy names
`delivery-order`, `delivery-timeout` and `delivery-escalation`. They are recorded here as
direction only: nothing on this page measures them, and no code in this version implements them.

- attempt: 15s per route, until the receiver takes it;
- post-submit READ receipt: 120s, never shorter than the attempt;
- preprobe: 400ms;
- held reminder: 600s;
- MAIN escalation: 300s; an immediate sender-and-lead all-live-failed event at 0;
- escalation levels: entity, project, team — a lower level shortens only;
- tombstones live while any copy or retry is replayable.

A read receipt is not transport: an ordinary dial is not turned into a synchronous 120s wait.

## Not measured, and not claimed

- A runtime reading a delivered frame. No read receipt is returned by this build.
- Any wake, read or delivery of a durable copy.
- Receiver de-duplication, attempt recording, fallback or escalation — none is active here.
- Any server, listener or queue started by this package outside a caller's own process; the
  framing host and adapter runs above use a synthetic socket in a temp folder.
- A single endpoint: the daemon still hosts 2N+1 endpoints for N checkouts.
- A verified principal or auth binding: mutating daemon requests still answer
  `daemon.auth-unsupported`.
- The queued host's verdicts: its contract is described in the README, not measured on this page.
- Exactly-once delivery, or any timing value in the reviewed-next section above.
- Any behavior beyond the commits and runs written down on this page.

Plans for the next change — a route that is held continuing to the next allowed route,
cross-route de-duplication, an attempt record, an ambiguous-receipt case and escalation — are
plans, not measurements. They are not validated by anything on this page.
