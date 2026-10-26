# Quickstart for agents

You are an AI session (Iris, Claude, Gemini or another) and the owner said: "install TeamCLI and
create a team to solve this problem". This page is what you run, in order, and what you must hand
back to the owner instead of trying to work around it.

## 1. Install

```sh
npm install -g team        # or, from a branch build: npm install -g ./team-<version>.tgz
team --version
```

No terminal, no Touch ID, no code.

## 2. Create the team: ask, never force

You have no terminal of the owner's, so plain `team init` refuses you
("only the owner runs this, from a terminal outside herdr"). That is by design. Use the grant flow:

```sh
cd <the repository the team works in>
team init --request --json        # prints a request id (tc_...)
team init --execute <request-id>  # writes the team into the registry once approved
```

`--execute` succeeds when one of these holds, checked in this order:

1. the owner answered this request (`team init --approve-as-owner-seat <id> oui`);
2. the owner answered an earlier request `always`, which covers sibling repositories;
3. the owner signed the approval mode `none` for a folder that holds this repository
   (`team init --approval-mode none --scope <folder>`): no answer is needed per team.

If it refuses, tell the owner the request id and the exact command from the refusal; do not retry
in a loop and do not look for another route.

## 3. What the owner does once (not you)

| Step | Who | Terminal | Touch ID | Code |
|------|-----|----------|----------|------|
| `team grant --add-owner-seat --team <team> --signer <name>` | owner | yes | yes (key creation) | no |
| `team init --approval-mode none --scope <folder>` | owner | no | yes, once | no |
| every later `team init --request` / `--execute` | you | no | no | no |

With the approval mode in place, a lambda user sees zero prompts at team-creation time.

## 4. Start the team

`team up` is still the owner's (or a leading seat's) from a terminal. Show the owner
`team up --dry-run` and ask them to run `team up`.

## 5. Talk to the team as a client

With a client grant that carries the inbox op (`team grant --client <id> ... --inbox`, issued by the
owner):

```sh
team send --client <grant-file> --key <key-file> orchestrator@<entity> "message"
team messages --client <grant-file> --key <key-file> --json        # read the orchestrator's replies
team messages --client <grant-file> --key <key-file> --ack <reply-id>
```

A send-only grant still sends, but its threads cannot be answered: ask the owner for a grant with
`--inbox`.
