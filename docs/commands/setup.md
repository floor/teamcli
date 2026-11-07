# team setup

`team setup` is the one owner signature. An agent may start it. Nothing is written until the owner signs.

```
team setup --signer touch-id
team setup --signer passkey --public-key <hex> --signature <hex> --credential-id <id>
team setup --edit --signer touch-id
```

`--signer touch-id` (or `mac`) creates the owner seat's Secure Enclave key when there is none, then asks for Touch ID once, over the charter. `--signer passkey` (or `iphone`) checks one signature over that same charter and records the passkey. It does not create a Mac key. Omitting `--signer` does not sign.

The charter names the project roots (the project directories under the home, or `~/Code`, unless `--roots` says otherwise), every vendor, and the routine operations. It does not expire unless a lifetime is set (`--request-expiry`, `--rule-lifetime`, `--grant-duration`, each a duration or `never`). It never carries the right to grant.

A later command runs with no prompt when every folder it changes sits inside the charter. The caller's own folder is not that test. A caller who is not the owner is refused outside it, and the refusal names `team setup --edit`. The owner at a terminal is never refused by the charter. `--request` records a card and does not run the command in that same invocation. A grant is not admitted by the charter. While a charter is on disk, TeamCLI does not raise a prompt of its own.
