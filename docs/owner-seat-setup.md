# Owner seat: the morning setup

You never open a terminal. Iris (the orchestrator agent) runs every command; your only acts are
native prompts on your own devices: Touch ID on the Mac, or a tap on your iPhone for a passkey.
That signature from your device is the authority; nothing else (no TTY, no chat click) is.

## Paths with no Touch ID and no code

What policy can decide, it decides; the only owner act that never goes away is a signature from
your own device when a rule is first set. Listed from fewest to more prompts:

| Situation | How it passes with no prompt | The one-time owner act |
| --- | --- | --- |
| renewing the grok-bot grants every week | the `always` answer is a standing, owner-signed rule; a matching request is admitted at once (`approved by: standing rule`) | the Touch ID of each first answer (steps 2 and 3 below) |
| creating another team under `~/Code/floor` | an `always` answer to one team request covers every sibling folder of its parent | the Touch ID of that first answer |
| creating any team, any folder | the `relaxed` security profile relaxes `team-create.owner-answer` | one Touch ID to sign the profile, renewed at most every 30 days |
| an agent running owner-only `team init` | `relaxed` relaxes `gate.owner-terminal` | the same profile signature |
| numeric codes | never needed on these paths: the owner seat replaces them | none |

What stays a prompt, whatever the profile says (the self-grant invariant): writing the policy
store or the profile itself, registering the owner seat, adding a signer. No agent can grant,
widen or renew its own authority: a standing rule only re-admits exactly what you signed, and an
agent cannot sign. Grants are not auto-approved by `relaxed` (`grant.owner-answer.low-risk` is
registered but not wired): a request carries no proof of who asks, so "low risk" could not tell
a grant for another principal from a self-grant. Decision taken tonight; the standing `always`
rule already gives the no-prompt renewal.

The profile is also the autonomy axis: `strict` = agents ask, `relaxed` = agents act inside what
the signed profile lists, until its expiry.

## Morning checklist (three Touch IDs, nothing to type)

1. **Iris starts the setup** (`scripts/morning-owner-setup.sh`). The owner-seat helper needs no
   step of its own (see [The helper prepares itself](#the-helper-prepares-itself)). The script installs this branch as `~/.local/bin/team-branch` next to the global `team` (the global one is
   left alone), registers your owner seat with a Secure Enclave key, and writes `owner-signers=mac`
   and `grant-emission=conversational` for the entities `floor` (Atlas's grant, Floor Docs) and `teamcli` (Agamemnon's grant).
   **You approve with Touch ID** once. The prompt reads:
   *"Create the TeamCLI owner seat for floor and set owner-signers=mac, grant-emission=conversational for entities floor, teamcli"*.
2. **Iris requests the grok-bot grant to Atlas** (send + messages to `orchestrator@floor`, 7 days)
   and answers it `always`. **You approve with Touch ID**. The prompt reads:
   *"TeamCLI: always for Grant for grok-bot: send + messages to orchestrator@floor (entity floor) until …"*.
3. **Iris requests the grok-bot grant to Agamemnon** (send + messages to `orchestrator@teamcli`)
   the same way. **You approve with Touch ID**:
   *"TeamCLI: always for Grant for grok-bot: send + messages to orchestrator@teamcli (entity teamcli) until …"*.
   Iris runs `--execute` after each answer and the grants are written. With "messages" Iris can
   read the orchestrators' `team reply` answers. Next week Iris re-runs the script: both standing
   rules renew the grants with no prompt.

   Why two: a grant binds exactly one entity and one team, so one grant cannot reach both
   orchestrators. Widening the grant format to several targets was rejected: it would make one
   Touch ID authorise sends into two entities, which is harder to read on the prompt.
4. *(Optional)* **Iris proposes the relaxed security profile** for a week of frictionless
   development; **you approve with Touch ID**: *"Set the TeamCLI security profile to relaxed until …"*.
   Then Floor Docs (below) needs no prompt at all.

There is no keychain "Allow" dialog by default: the helper is ad-hoc signed and keeps its key
through CryptoKit, which needs no entitlement (see [Why no codesigning](#why-no-codesigning)). If
you ever want the codesigned build, Iris runs the script with `--identity`: you then see one macOS
dialog *"codesign wants to sign using key … in your keychain"* and click **Allow**.

If you cancel a prompt nothing is written; Iris simply runs the script again (each step is skipped
when already done). Before running it, Iris can show you the exact prompts with `--dry-run`.

## Creating "Floor Docs" (`~/Code/floor/docs`)

1. Iris runs `team init --request` in `~/Code/floor/docs`. The request lands in your owner-seat inbox.
2. Iris runs `team init --approve-as-owner-seat <id> oui` (or `always`, to cover every sibling
   folder of `~/Code/floor` from now on). **You approve with Touch ID**:
   *"TeamCLI: once for Create team "docs" in …/floor/docs …"*.
   From the phone instead: Iris starts `team owner-seat serve`, opens the link on the Mac, and you
   tap **Oui** / **Toujours** and confirm with your passkey (the browser offers the iPhone QR code).
3. Iris runs `team init --execute <id>`; the team file is written.

Under the relaxed profile step 2 disappears: Iris runs `--request` then `--execute`, and the audit
records `via: security-profile`.

## A test team, created and started with one answer (no terminal)

What Iris runs, in the new repository (say `~/Code/floor/demo`):

1. `team owner-seat serve` (if the page is not already up) and sends you its link.
2. `team init --request --then-up` — one request for "create the team, then start the team".
3. Waits for your answer, then `team init --execute <id>` and `team up --approval <id>`.

What you see, and all you do: the owner page shows one card,
*"Request oa_…: seat:iris asks to create the team, then start the team — team "demo" in
/Users/…/floor/demo (HEAD …). Authorized? oui, always, or non."*, with **Oui**, **Toujours** and
**Non**. You tap **Oui** and confirm with Touch ID on the Mac, or with your iPhone (the browser's
QR code for the passkey). The card disappears. Nothing else: no terminal, no code, no question in
a pane — the seats' folder-trust questions for the lobby and the project are pre-accepted at
launch, and a file without absolute `trust:` no longer stops `up`.

`team import --request`, `team add <name> --request` and `team up --request` work the same way for
an existing team ([team up](commands/up.md#owner-seat-approval-no-owner-terminal)). **Toujours**
covers every sibling repository of the parent folder for that action from then on.

## Security profile

`security-profile` is a policy with two values, `strict` (default) and `relaxed` (alias `dev`).
Each relaxable rule has an id; the code only asks "is rule X relaxed here?":

| rule id | strict | relaxed |
| --- | --- | --- |
| `team-create.owner-answer` | `team init --execute` needs your per-request answer | admitted without it |
| `grant.owner-answer.low-risk` | a low-risk grant needs your per-request answer | registered, not wired yet |
| `approval.standing-auto` | standing (always) approvals confirmed | applies automatically |
| `gate.owner-terminal` | owner-only steps want an owner terminal | an agent may run them (`team init` wired) |
| `signer.presence-per-action` | each action gets its own Touch ID | covered by the profile signature |

What is never relaxable: the profile record itself. It is signed by your owner seat (Touch ID or
passkey), carries an expiry of 1 to 30 days, and every set, refusal and relaxed use is appended to
`~/.config/team/security-profile.log`. An edited, unsigned, expired or foreign-signed record reads
as strict. `team status` and `team owner-seat status` print
`SECURITY PROFILE: RELAXED: … until …` whenever it is active.

The one line Iris runs to switch to relaxed (you approve with Touch ID):

```sh
team owner-seat profile relaxed --days 7 --reason "beta 0.5 development"
```

Back to strict: `team owner-seat profile strict`. Letting it expire also restores strict.

Policy writes (`team policy set|unset`) follow the same rule: run by an agent, they ask your owner
seat for a Touch ID showing the exact write (`TeamCLI: policy set entity owner-signers mac`).

## The iPhone passkey (optional)

`team owner-seat serve` serves a page on `http://localhost:7391/?t=<token>` (127.0.0.1 only; the
token is per run). Iris opens it on the Mac. There you can:

- **add a passkey**: the browser creates it (iCloud Keychain on the Mac, or the iPhone through
  the QR code); the Mac's Secure Enclave signer confirms it with one Touch ID;
- **approve the waiting security profile** with that passkey;
- **answer team requests** (Oui / Toujours / Non) with that passkey.

The relying party is `localhost`, which browsers treat as a secure context, so no certificate is
needed. The phone cannot open `localhost` itself: the approval goes through the Mac browser's
"use a phone or tablet" QR code (hybrid transport, Bluetooth proximity).

## The helper prepares itself

Nobody builds, signs or installs the owner-seat helper by hand. The first TeamCLI command that needs
the owner seat (`team owner-seat setup`, a policy write, an owner answer, `team status`) compiles the
helper source shipped in the package (`helpers/owner-seat-keystore.swift`), ad-hoc signs it
(`codesign --sign -`: no identity, no keychain dialog), self-tests it and places it in
`~/.config/team-owner-seat/` (0700). Everything is at user level: no `/usr/local`, no `sudo`.
A stamp (`owner-seat-keystore.stamp.json`) records the source hash, so an upgrade that changes the
helper rebuilds it silently on next use. A helper you installed yourself without that stamp (the
codesigned `--identity` build) is never replaced. The only prerequisite is the Xcode Command Line
Tools (`swiftc`); `TEAMCLI_NO_HELPER_AUTOBUILD=1` turns the automatic build off.

## Why no codesigning

A Secure Enclave key stored as a *Keychain item* needs the data-protection keychain, hence a
`keychain-access-groups` / `application-identifier` entitlement. Those are restricted entitlements:
macOS honours them only with a matching provisioning profile, and a bare CLI binary cannot carry
one, so it must be wrapped in an `.app` bundle with `Contents/embedded.provisionprofile` (Apple
Development or Developer ID, App ID `TEAMID.com.teamcli.owner-seat-keystore`). An ad-hoc swiftc
build gets `errSecMissingEntitlement` (-34018), which is last night's failure.

The helper now avoids the Keychain item: CryptoKit's `SecureEnclave.P256.Signing.PrivateKey`
creates the key inside the Secure Enclave with the same user-presence access control, and only its
`dataRepresentation` is kept in `~/.config/team-owner-seat/keys/<label>.se` (0600). That blob is
wrapped by this Mac's Secure Enclave: it is not the private key and is useless on another machine.
Every signature still asks for Touch ID or your login password. The keychain backend is still tried
first, so a codesigned, provisioned build (`scripts/build-owner-seat-helper.sh --identity … --team-id … --profile …`,
entitlements in `helpers/owner-seat-keystore.entitlements`) keeps working.

## Files

- `helpers/owner-seat-keystore.swift`: the helper (`create`, `public`, `sign`, `pin-set`, `pin-get`, `selftest`).
- `scripts/build-owner-seat-helper.sh`: build, optional codesign/bundle, install, self-test.
- `scripts/morning-owner-setup.sh`: the whole morning, `--dry-run` lists the prompts.
- `src/security/profile.ts`: the security profile and the owner-device consent.
- `src/security/owner-page.ts`, `src/commands/owner-seat.ts`: the owner page and `team owner-seat`.
