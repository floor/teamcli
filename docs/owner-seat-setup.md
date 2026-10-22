# Owner seat: the morning setup

You never open a terminal. Iris (the orchestrator agent) runs every command; your only acts are
native prompts on your own devices: Touch ID on the Mac, or a tap on your iPhone for a passkey.
That signature from your device is the authority; nothing else (no TTY, no chat click) is.

## Morning checklist (two Touch IDs)

1. **Iris starts the setup** (`scripts/morning-owner-setup.sh`). It builds the owner-seat helper,
   installs this branch as `~/.local/bin/team-branch` next to the global `team` (the global one is
   left alone), registers your owner seat with a Secure Enclave key, and writes the `teamcli`
   entity policies `owner-signers=mac` and `grant-emission=conversational`.
   **You approve with Touch ID** once. The prompt reads:
   *"Create the TeamCLI owner seat for floor and set owner-signers=mac, grant-emission=conversational for entity teamcli"*.
2. **Iris requests the grok-bot grant** (send + messages to `orchestrator@teamcli`, 7 days).
   **You approve with Touch ID**. The prompt reads:
   *"TeamCLI: once for Grant for grok-bot: send + messages to orchestrator@teamcli (entity teamcli) until …"*.
   Iris then runs `--execute` and the grant is written.
3. *(Optional, once)* **Iris proposes the relaxed security profile** for a week of frictionless
   development; **you approve with Touch ID**: *"Set the TeamCLI security profile to relaxed until …"*.

There is no keychain "Allow" dialog by default: the helper is ad-hoc signed and keeps its key
through CryptoKit, which needs no entitlement (see [Why no codesigning](#why-no-codesigning)). If
you ever want the codesigned build, Iris runs the script with `--identity`: you then see one macOS
dialog *"codesign wants to sign using key … in your keychain"* and click **Allow**.

If you cancel a prompt nothing is written; Iris simply runs the script again (each step is skipped
when already done).

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
