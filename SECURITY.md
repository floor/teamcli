# Reporting a weakness

A weakness in TeamCLI — the `team` command of this repository — is reported in private,
through this repository's security advisories on GitHub: the repository's Security tab,
"Report a vulnerability", or this direct link:
https://github.com/floor/teamcli/security/advisories/new. Please do not report one in a
public issue, discussion or pull request.

## What to include

- the version you run (`team --version`);
- your operating system;
- what you did, what happened, and what you expected instead;
- the smallest team file or commands that show it.

Please paste no secrets: never a key, a token or a private file.

## What we do

This is our commitment: we answer, we fix, and we say afterwards what it was, in the
release notes of the version that fixes it. We answer as soon as we can, and a report is
never ignored.

## Which versions get fixes

The latest release only.

## What is in scope

Everything this repository ships — the `team` command, its schema and its examples — and
what a run of it does in a project: the team file and the grants it holds, the caller
gate that reads them, the message files and drop files it writes, the local sockets it
binds, and the behaviour its own documentation states.

## A known limit: the owner check

The owner check guards against a mistake: an agent in a herdr pane running the command
that only the owner should run, or a seat acting on a rule it should not. It does not
guard against a determined process running as the same OS user as the owner — a detached
one, for example — and so a process that sets out to look like the owner can pass it.

What contains it today is not the check alone: the writes it admits are signed with the
owner's key, every admission is logged, and grants are scoped to named sessions and
commands. Those bound an abuse and make it visible afterwards; they do not stop one.

Closing this needs containment at the operating system's level, not another check inside
the CLI. That work is planned after 0.5.x.

## What is not a weakness in TeamCLI

- TeamCLI protects against an agent's mistake, not against a hostile program running as
  you: agents run as your user, and what you can read on your machine, they can read. The
  owner check has the same limit, stated above.
- What an agent's own program or its lab does with what it reads; whether a lab's model
  can be trusted; what a page an agent read told it to do.
- Keys and tokens your own shell exports are visible to every agent started from it.
- Several people sharing one machine, and a hosted TeamCLI: neither is supported.
- A weakness in herdr, in a lab's CLI, or in another tool belongs to that project: report
  it there.

A report that shows TeamCLI doing something its own documentation says it does not do is
in scope, whatever the list above says.
