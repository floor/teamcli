# team owner-seat

The owner seat is the human owner's own seat. An agent (the orchestrator) runs this command on the owner's
behalf; the owner never types it. Every step that needs the owner ends in a native prompt on the
owner's own device, Touch ID from the Secure Enclave helper or a passkey on the owner page, and
that signature is the authority, not the caller or a terminal.

See [owner-seat setup](../owner-seat-setup.md) for the morning checklist.

## Synopsis

    team owner-seat [--json]
    team owner-seat status [--json]
    team owner-seat setup --team <team> --signer <name> [--entity <entity>] [--owner-signers <a,b>] [--grant-emission <value>] [--policy-entity <entity>]
    team owner-seat profile <strict|relaxed|dev> [--days <1-30>] [--reason <text>] [--signer <name>]
    team owner-seat serve [--port <port>]
    team owner-seat export --out <file> [--signer <name>] [--json]
    team owner-seat pin --from <file> [--name <machine>] [--json]
    team owner-seat install --account <a,b> [--dry-run] [--json]

- `status` (the default): the seat, its signers and the security-profile line. A relaxed profile
  prints `SECURITY PROFILE: RELAXED: …` in capitals. On a machine whose owner seat is pinned it
  names the pinned seat, its fingerprint and this machine, and says that a terminal here is not
  the owner.
- `setup`: creates the Secure Enclave key, registers the seat and asks for one Touch ID to confirm
  it. The same prompt covers the entity policies named with `--owner-signers` and
  `--grant-emission` (written at `--policy-entity`, default the seat's entity). A cancelled prompt
  registers nothing.
- `profile`: proposes the `security-profile` value with an expiry (default 7 days, at most 30).
  A Secure Enclave signer signs it at once (Touch ID); a passkey signer signs it on the owner page.
  `dev` is an alias of `relaxed`.
- `serve`: the owner page on `http://localhost:<port>/?t=<token>` (default port 7391, bound to
  127.0.0.1, one token per run): add a passkey, sign the waiting profile, answer team requests.
  The page asks `/api/state` every two seconds, so a request recorded while it is open appears
  on that page. A command that records a request does not open a browser. Refused while no
  owner seat is registered. An owner-action or team-create card is drawn from the request record
  itself, never from the inbox copy beside it; a record that cannot be read (its words not
  hashing to its arguments, among others) is shown as such and cannot be answered. The page
  sends the card's parameter hash back with every answer, and a request that no longer has it
  is neither asked for a challenge nor signed.
- `export`: on the machine that holds the signers, writes the seat's public signer records — each
  device key's public key, each passkey's public key, credential id and relying party — and the
  names the `owner-signers` policy accepts, to a new file. No private key is in it. One
  confirmation on the owner's device signs it (by an accepted device key; `--signer` names one
  when there are several), and the card and the output show its fingerprint.
- `pin`: on a machine that holds no owner signer (a headless server), pins that export. The
  export must verify under a signer it names, and this machine must have no owner seat of its
  own. The first pin is trust on first use: this machine believes the first export its owner
  gives it, from a terminal on this machine outside the terminal host, and it prints the same
  fingerprint so the owner compares the two. It makes this machine's record: a random id and a
  name (`--name`, default this machine's own name). Pinning the same seat again changes nothing;
  a changed seat (a passkey added, a key replaced) is pinned only from a newer export signed by a
  signer already pinned here, whoever runs the command. A pin that cannot be read is never
  replaced by this command. On a shared Linux server the pin is made as the administrator (see
  below).
- `install`: on a shared Linux server, sets up once the owner state every account reads and none
  can change (see [A shared Linux server](#a-shared-linux-server)). `--account` names the entity
  accounts; `--dry-run` prints every step and changes nothing.

## A machine whose owner seat is pinned

- **A terminal there is not the owner**, with a terminal or without one: any agent that opens a
  shell on the account would otherwise count as the owner. No mode, policy or variable changes
  this. Seats in their own panes are placed as before.
- **Nothing else stands in for the owner there.** Dev mode lifts no gate on a pinned machine, for
  any caller — a terminal, an agent outside the terminal host, an unattended run, a placed lead. A
  general grant is refused (`--general`), since it is signed with this account's own key, and the
  owner-authorization fingerprint (`TEAM_OWNER_APPROVAL`) admits nothing, since a fingerprint is
  public.
- **Owner-only actions run on the owner's signed answer.** The command records its request
  (`--request`). The request names this machine, its answer window (made, and expiring at most
  fifteen minutes later) and every action's full argument words, all inside the signed
  parameters, and each action's argument hash must be the hash of the words its card shows. An
  agent carries it to the signer machine and the answer back (`team approvals export`, `sign`,
  `answer`); the command then runs with `--approval <id>`. An answer is checked against the
  pinned keys, is bound to one request of this machine, expires with the signed window, and is
  spent once in this machine's approval ledger. A request that names no machine or another
  machine, carries no signed window or no words, is refused here; the signer machine never runs
  a request that names another machine.
- **Which commands take the answer.** `team import`, `migrate`, `up` (and `init` bundled with
  it), `add`, `send`, `down`, `bus`, `forget`, `approvals revoke`, `batch`, `team config` (a
  team's record, and an entity's own record: `<entity>.root`, `.worktrees`, `.names.unique`,
  `.reminders`, `.rules`, and a project's rules), `team daemon install|uninstall`,
  `team development-mode` and `team client general-grant` read `--request` and
  `--approval <id>`. Each request travels and is signed on its own; signing several carried
  requests with one confirmation is planned.
- **Which commands do not yet.** These stay the owner's at a terminal, so on this machine they
  are refused until they take an answer: `team daemon restart` and `fault-watch`, `team grant`
  (outside its `--client` form), `revoke`,
  `delegate`, `policy set|unset`, `settings set|unset`, `tempo`, `broker`, `start`,
  `swap --now`, `mcp setup`, `approve`, `remove --abandon`, `rename` (a team, `--rekey`),
  `migrate --root`, and `init --approval-mode` and `--revoke-approval` (no `always` rule is kept
  here, so there is none to change). `team owner-seat` (its pins are trust on first use or
  signed exports) and `team setup` (below) never take one.
- **What an answer binds.** The request's action, its argument words as the command read them
  (for the daemon, the resolved home, checkouts, opt-ins and route; for an entity's record, the
  operation, key, value and file), the folder it acts in, its team or entity, HEAD in a
  repository, this machine and, on a shared server, the account. An entity's record and the
  daemon are answered once or denied, never by a standing rule. A file a
  command names is bound by its path, not its contents (as under a general grant); inside a
  repository HEAD binds the repository's own files.
- **No owner signer and no charter are made here.** `team owner-seat setup` and `team setup` are
  refused, and no `always` rule is kept here yet: `always` admits the one request once. The
  machine keeps no charter of its own: a charter is standing consent signed for one machine's
  folders, and every owner-only action here runs on its own answer instead.
- **Where the owner state lives.** The pin, the machine record and the approval ledger are found
  by one rule, which never reads the environment's home: a system folder (`/etc/teamcli`) first,
  when it is present, owned by the system's administrator and writable by no one else, then the
  account's own home from the user database (`~/.config/team`). A machine that holds any of the
  three counts as pinned, and a state that cannot be read or trusted — a missing pin beside a
  machine record, a parent that is not a folder, an unprotected system folder — refuses every
  answer and keeps the terminal from being the owner; it never reads as unpinned.
- **The limit of the account's own folder.** On macOS, in the account's own folder, the owner
  state is as safe as the account's files: a process of the account can replace the pin, copy a
  machine record, or remove a ledger entry. A shared Linux server keeps all three out of the
  agents' reach (below).

## A shared Linux server

A Linux server has one owner and several accounts: the owner's own administrator account, and one
account with no administrator rights per entity, each with its own daemon and seats. The same
pinned owner seat counts for every entity account, and none of them can change it.

- **The owner state is the system's.** On Linux, the pin and the machine record live only in the
  system folder (`/etc/teamcli`), which the administrator alone writes and every account reads.
  The approval ledger lives in a folder of its own (`/var/lib/teamcli-owner/ledger`), written only
  by the owner helper's own user, with one folder per account. An account's own home is never
  read for any of them.
- **Nothing reads as unpinned.** A system folder that is missing, is writable by anyone but the
  administrator, lacks the helper's record or the ledger, or holds no pin yet, refuses every
  answer, and a terminal of an entity account is never the owner there. The refusal names the
  install to run, with this machine's own paths in full.
- **Each answer is for one account.** A request made by an entity account names that account
  beside the machine, inside the signed parameters, and the owner's card shows it
  (`server (account floor)`). An answer for one account is never accepted by another.
- **An approval is spent by the owner helper alone.** When a command runs with `--approval <id>`,
  the account hands the request, the answer and what it is about to run to the owner helper. The
  account can start the helper only through one rule the administrator installed: one launcher,
  with no arguments, as the helper's own user. The launcher starts the helper with an environment
  it writes out in full, so nothing the caller sets reaches it, and the system itself tells the
  helper which account called it; the caller cannot choose. The helper reads at most one small
  input, for a few seconds, and spends one approval at a time: a call that cannot start within
  that time spends nothing. It checks everything again against the system pin, for that account
  — the machine, the account, the signed window, the signer, the parameters and the arguments
  about to run — and spends the approval once in that account's ledger, on disk before it
  answers. The command runs only on a verdict that names exactly the request it sent.
- **Every time is checked against the clock.** A request carried between machines that says it
  was made later than now (beyond a two-minute allowance for clocks that differ) is never shown,
  signed, recorded or run, so its fifteen-minute window cannot be stretched. An answer must say it
  was given inside that window and not later than now.
- **What this protects, and what it does not.** The helper keeps the pin, the machine record and
  the ledger out of every entity account's reach, so an account cannot pin another owner, replay a
  spent approval, or use an answer given for another account. It does not stop an account from
  acting on its own files: an agent in an entity account can change that account's own TeamCLI,
  or do by hand what an owner-only command would do there. The boundary between entities, and
  between an entity and the machine, is the account itself.
- **Set up once, as the administrator.** From the owner's own account:

  ```console
  $ sudo team owner-seat install --account floor,studio --dry-run
  $ sudo team owner-seat install --account floor,studio
  $ sudo team owner-seat pin --from owner-seat-export.json --name server
  ```

  The install makes the helper's user (no login, no home of its own) and records at once that it
  made it, then the system folder, the helper's code folder and launcher (the administrator's),
  the ledger (the helper's), the helper's record, and the rule that lets the named accounts start
  the helper, checked before it is put in place. Each folder and file is created with its owner
  and mode. Before it changes anything, it reads every path it writes and every folder above it:
  a link, or anything someone other than the administrator owns or may write, refuses it. It never
  adopts a user of the helper's name that its record does not name; an install stopped right
  after making the user says so and names the repair. Running it again is safe; to add an entity
  account, run it again naming every account. The pin is then made by the administrator, with the same first-pin and re-pin rules as
  anywhere else; no entity account can pin or re-pin. The administrator's search path is narrower
  than the account's own, so name `team` and Bun by their full paths when it does not find them.
  The helper runs the Bun and the TeamCLI build the install copied: after upgrading either, run
  the install again.
- **macOS is unchanged.** The Mac keeps its own owner signer, and a pinned Mac reads the system
  folder when present, else the account's own folder, as before.

## Flags

| Flag | Value | Effect |
| --- | --- | --- |
| `--team` | name | on `setup`: the owner seat's team |
| `--signer` | name | on `setup`: the first signer's name; on `profile`: which signer signs |
| `--entity` | entity | on `setup`: the seat's entity (default: the team) |
| `--owner-signers` | names | on `setup`: also set the `owner-signers` policy, under the same Touch ID |
| `--grant-emission` | value | on `setup`: also set the `grant-emission` policy, under the same Touch ID |
| `--policy-entity` | entity | on `setup`: the entity those policies are written at |
| `--days` | 1-30 | on `profile`: the expiry, in days |
| `--reason` | text | on `profile`: recorded in the profile and the audit |
| `--port` | port | on `serve`: the local port (0 picks a free one) |
| `--out` | file | on `export`: the new file the export is written to (never over an existing file) |
| `--from` | file | on `pin`: the export to pin |
| `--name` | name | on `pin`: this machine's name on the owner's cards, at the first pin (lower case, digits, dots, dashes) |
| `--account` | names | on `install`: the entity accounts that use this machine's owner, comma-separated |
| `--dry-run` | — | on `install`: print every step, change nothing |
| `--json` | — | on `status`, `export`, `pin` and `install`: one JSON document |
| `--help`, `-h` | — | the usage, and exit 0 |

## What it reads and writes

`~/.config/team/owner-seat.json` (the seat), `~/.config/team-owner-seat/` (the helper and its
Secure Enclave key handles), `~/.config/team/security-profile.json` (the signed profile),
`security-profile.proposal.json` beside it, and the append-only `security-profile.log`. On a
pinned machine, in the owner-state folder (`/etc/teamcli` when it is present and protected, else
the account's own `~/.config/team`): `owner-seat-pin.json` (the pinned export, its fingerprint
and the fingerprint it replaced), `machine.json` (this machine's id and name) and `owner-ledger/`
(one entry per approval spent). On a shared Linux server: `/etc/teamcli/owner-seat-pin.json`,
`/etc/teamcli/machine.json`, `/etc/teamcli/owner-helper.json` (the helper's user and uid) and
`/etc/teamcli/owner-install.json` (the install's record of the user it made), read by every account; the ledger `/var/lib/teamcli-owner/ledger/<account>/`, written by the helper
alone; the helper's code under `/usr/local/teamcli-owner/`; the install's own staging folder,
`/var/lib/teamcli-owner-install/` (the administrator's alone, emptied after each run); and its rule,
`/etc/sudoers.d/teamcli-owner`. The export, the pin and the re-pin are logged in
`security-profile.log`.

## Exit codes

0 when done, 1 when refused (including a cancelled prompt), 2 when the invocation is invalid.

## One-request links

`team grant --request` prints `http://localhost:7392/r/<request-id>#<nonce>`. With the page served
on port 7392, that link shows only that request's card, without the page token. The nonce is
single-use, bound to the request and expires with it; it grants nothing, and an answer from the
card still needs an owner-signer signature. See `docs/commands/grant.md`.

## The later answer

Every card offers **Later**, **Tomorrow** and **Monday** beside its decisions. A later word is
not an approval: it writes one signed deferral beside the request (`<request-id>.later.json`),
bound to the request id and its parameter hash, and approves, denies and spends nothing.

- The card is hidden until the return instant and lists again at it, with one more full answer
  window (fifteen minutes) after that. The request's original window is not otherwise extended.
- `later` returns after four hours; `tomorrow` and a weekday return at 08:00 local time, the next
  one that is still ahead.
- No deferral reaches past the request's creation + 7 days: a return time later than that is
  refused when it is asked for, and a record that names one anyway is honoured only to the cap.
- A deferral that does not verify — an unsigned or forged record, one signed by a signer the
  owner-signers policy does not accept, or one bound to another request or parameter hash — hides
  nothing and extends nothing.
- When the card belongs to a blocked team, that team's lead gets one plain note: it is from the
  owner page, says that the request waits until the return instant, and claims nothing about the
  owner's identity. A team-create card names no team yet, so it leaves no note; a team this build
  cannot resolve keeps the deferral and says that no lead was told.

