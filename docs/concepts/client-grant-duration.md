# How long a client grant lasts

How long a **new** client grant may last is a policy the owner sets, `client-grant-max-duration`,
not a constant of TeamCLI. Unset, it is exactly what TeamCLI always did. Set to `none`, it allows a
client grant with **no end date**, which stays valid until the owner revokes it.

Nothing here lets a principal widen its own authority. The policy is signed by the owner like every
enforced policy; a client grant is signed by the owner (Touch ID on the owner seat, or the owner at
a terminal); a request can ask for no end date, it cannot answer for it.

## The setting

| | |
| --- | --- |
| Name | `client-grant-max-duration` (also written `client_grant_max_duration`) |
| Levels | `entity` and `project`. Not `team` or `seat`. |
| Value | A number of days (`7d`, `30d`, `90d`) or `none` (no end date is allowed), for every kind of grant at once, or per kind: `send=30d;up=90d;bundle=none` |
| Kinds | `send`: send, inbox and master grants (`team grant --client`). `up`: up, down and up-and-down grants (`--up`, `--down`). `bundle`: bundle grants (`--bundle observer\|operator`). |
| Default (unset) | `send=7d;up=90d;bundle=90d`: the hard-coded limits it replaces. Nothing changes until the owner sets it. |
| Range | `1d` to `3650d`, or `none` |

One bare value names every kind: `30d` is `send=30d;up=30d;bundle=30d`, so it also *lowers* `up` and
`bundle` from ninety days. To raise one kind and leave the others, name it: `send=30d`. A kind a
value leaves out keeps the release default, or, below the entity, the value in force above it.

### What a cap is

A cap bounds a request. It never lengthens one.

- `--expires <ISO>` must be in the future and inside the cap, or the request is refused.
- No `--expires`: the grant lasts the shorter of the kind's default length (7 days for a send grant,
  90 for the others, a bundle's own days from `client-bundles`) and the cap. Raising the cap to `30d`
  leaves an unnamed expiry at seven days; lowering it to `3d` makes it three.
- `--expires never`: a grant with no end date. Allowed only when the cap in force for that kind is
  `none`. `none` lifts the ceiling; it is never what an unnamed `--expires` means.

### Narrowing

Like every enforced policy, a lower level can only narrow:

- A project may shorten what the entity allows (`none` is the loosest, so `none` under `30d` is a
  loosening). A project that names `send=7d` under an entity's `send=30d;up=none` keeps `up=none`.
- A level that loosens the one above refuses **the whole policy chain** at load, naming both levels.
- A chain that cannot be read or verified (an edited, unsigned or unreadable policy file) refuses a
  new grant: `the policy chain cannot be verified (…), so how long a client grant may last (client-grant-max-duration) is unknown; nothing was signed`. It never falls back to the
  release default, which may be looser than a cap the owner lowered.
- A policy set with `--until` that has expired counts as unset: the release defaults return.

### Where the owner sets it

With the existing command, from the owner's terminal outside the multiplexer (owner-only, signed,
logged). Nothing in this change sets it for you.

    team policy set entity client-grant-max-duration send=30d --entity floor
    team policy set entity client-grant-max-duration send=none --entity floor     # the cron job
    team policy set project client-grant-max-duration up=30d --project <project-id>
    team policy unset entity client-grant-max-duration --entity floor

The entity value lives in `~/.config/team/entities.yaml` under `<entity>.policies`, the project value
in `~/.config/team/projects.yaml`; both are written signed by `team policy set`, never edited by hand
(an edit breaks the signature and refuses the chain). See [`team policy`](../commands/policy.md) and
[policies](../specs/policies.md).

A refusal for duration names the policy, the level it was read at, what it allows and the command
that changes it:

> the expiry 2026-12-01T00:00:00.000Z is more than 7 days away: no client-grant-max-duration policy
> is set, so the release default allows at most 7 days for a send grant; the owner can raise it with
> `team policy set entity client-grant-max-duration send=30d --entity floor`, or allow no end date
> with `team policy set entity client-grant-max-duration send=none --entity floor`

> --expires never is refused: a send grant with no end date needs the policy to say none: the policy
> client-grant-max-duration at entity floor allows at most 30 days for a send grant; the owner can
> raise it with …

## A grant with no end date

For a send-only grant for a cron job to `orchestrator@teamcli`:

    team policy set entity client-grant-max-duration send=none --entity floor     # owner, once
    team grant --client grok-bot --entity floor --public-key <file> --team teamcli \
      --seat orchestrator --expires never --request

The request needs the entity's `grant-emission` to be `conversational`, like any request; the owner
seat answers it with one signature and the owner runs `team grant --execute <request-id>`.

**The owner card says it.** The request summary, the confirmation line, the notification and the
owner-seat signature prompt all read:

> Grant for grok-bot: send to orchestrator@teamcli (entity floor) until revoked (no end date). NO END
> DATE: it stays valid until you end it with team revoke.

A bundle's card reads "…, for team docs until revoked (no end date): …". Output after signing says
`expires: never (until revoked; no end date)`.

What it is **not**:

- never approved `always`: a standing rule would renew the largest grant unasked, so `always` is
  refused for it;
- never a master grant (`--allow-grant`) or a sub-grant (`--client-request`): both always carry an end
  date, and a sub-grant never outlives its master;
- never silent: a policy that is not `none` refuses `--expires never`, and a request that was fine
  when it was answered is refused at `--execute` (and not spent) if the policy was lowered since.

### The record

The signed record carries `"expires": null`: the field is present and the JSON `null`, never absent.
The vocabulary does not change (1 to 5 mean what they meant). Every decoder accepts exactly an ISO
time after `issued`, or `null`; any other value, or a missing field, is not a grant.

There is no ceiling in the decoder any more: the cap is the policy's word at *issuance*, and a grant
already signed keeps the end it was signed with. Lowering the policy later does not shorten existing
grants; the owner ends them with `team revoke`.

### Verification and revocation

Every verifier treats `null` as not expired, at any date: `team send --client`, `team messages --client`
and its ack, `team status --client`, `team up --client`, `team down --client`, and every bundle op.
They still require the canonical record, the client's own key, the one team and folder, and no
revocation. [`team revoke <cg_id>`](../commands/revoke.md) ends it at once, exactly as for a dated
grant: the next run is refused with `was revoked at …`. Revocation is the only way a no-expiry grant
ends, so the owner should know the ids (`team grant --client …` prints it as `client grant: cg_…`).

`team up|down|status --client` print `client grant <id>: … until revoked (no end date)` on stderr.

### Older builds

An older build refuses a grant with no end date **whole**. Its decoders read `expires` as a string
and cap it at its own constant from `issued`, so `null` is not a grant: the send, up/down and bundle
readers all answer "not a verified owner-signed client grant". It is never treated as valid forever
and never crashes. The same holds for a grant longer than that build's own limit (a 30-day send
grant, say): an older build refuses it. An older build also cannot append a revocation for such a
grant (it does not know the grant); revoke it with a build that does. No vocabulary number was bumped
for this: a bump would only change the wording of the refusal, and the refusal already happens.

## Risks the owner should weigh

- `none` makes the client key a standing credential. The key is a file readable by every process of
  the owner's user (`key isolation: enforced against team panes (key file still readable by same-user processes)`), so a no-end-date grant is as
  strong as that file's secrecy forever. Rotate the client key (a new `team client keygen`, a new
  grant, `team revoke` of the old one) on a schedule you choose; TeamCLI does not do it for you.
- A policy can be `none` for one kind only: `send=none` leaves `up` and `bundle` at ninety days.
- Lowering the policy does not end grants already signed with no end date.
