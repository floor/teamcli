# team git

Runs `git push`, `git fetch` or `git pull` against GitHub with the entity's GitHub identity, for a
seat that holds no GitHub credential of its own. A seat on a shipped launcher starts with
`GH_TOKEN` and `GITHUB_TOKEN` empty, an empty `gh` config and no git credential helper, so plain
`git push` cannot act as the owner's login; `team git` is the one way it reaches GitHub.

The identity is `~/.config/team/entities/<entity>/identity.yaml` (account, author name and email,
and the keychain item that holds the token). The token is read for this one command and handed
only to the git process it starts; it never reaches the seat, its records or its logs. Commits the
command pushes carry the entity's author and committer.

Refused before anything runs: any git command other than push, fetch and pull; a force push
(`--force`, `-f`, `--force-with-lease`, a `+` refspec); a push to `main` or `master`; a push that
deletes a branch (`--delete`, `:<branch>`), mirrors or pushes `--all`.

[`team gh`](gh.md) does the same for the `gh` CLI.

    team git <arguments>

Exits with git's own code; 1 when the command is refused or the identity cannot be read; 2 when
the invocation can't be read.
