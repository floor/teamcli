# team gh

Runs the `gh` CLI with the entity's GitHub identity, for a seat that holds no GitHub credential of
its own: opening and commenting on pull requests and issues, reading runs, starting a workflow.
The token is read from the keychain for this one command and handed only to the `gh` process.

Refused before anything runs: `gh auth`, `secret`, `ssh-key`, `gpg-key`, `variable`, `config`,
`alias`, `extension`, `codespace` and `release`; `gh pr merge`; `gh repo delete`, `edit`,
`rename`, `archive`, `create` and `fork`; and `gh api` with any method but GET or with a body
(`-f`, `-F`, `--input`). A merge, a release and a repository change stay with the operator's gate
and the owner.

[`team git`](git.md) does the same for git push, fetch and pull.

    team gh <arguments>

Exits with gh's own code; 1 when the command is refused or the identity cannot be read; 2 when
the invocation can't be read.
