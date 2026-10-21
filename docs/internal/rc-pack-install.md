# Packing and installing a local release candidate

A local release candidate is packed from a clean, versioned source commit and installed forward
into an existing prefix. This page covers the two scripts that do that and the evidence they leave;
it does not cover tagging, publishing, the changelog or starting the team.

## What the candidate must be

The version is already committed at HEAD. `bun run pack` refuses a changed working tree, a version
edited but not committed, and an unpinned compressor or tar builder; it packs from a temporary
staging copy, so a crash cannot leave the tracked manifest altered.

The archive names its source. The script reads the full HEAD commit from git — never from a caller —
writes it as `gitHead` into the staged manifest, and verifies every tarball member against the
staged HEAD sources. It then rewrites only the gzip frame with the pinned compressor, so the same
commit packs to the same compressed bytes on every supported machine.

## Pack and check

```console
$ bun run pack --pack-destination <artifact-dir>
$ bun scripts/check-pack.ts <artifact-dir>/team-<version>.tgz <source-sha>
```

`pack` writes `<artifact-dir>/team-<version>.tgz` and `<tarball>.stamp.json` beside it. The stamp
records the tarball's `sha256` and `bytes`, the `version`, the full `gitHead`, the uncompressed tar
`sha256`, the compressor identity, `builtAt` and the branch.

`check-pack` reads every member. An internal ticket reference fails it, and so does a missing or
mismatched source stamp; a hit names the file, never the reference. Pass the source commit as the
second argument (with none it expects `GITHUB_SHA`). Exit 1 is a failed check and exit 2 an
unreadable tarball, never a clean one.

Keep the artifact directory outside the repository. The stamp is the artifact's identity; quote it
rather than restating its numbers.

## Keep the accepted stable artifact

Before the install, copy the currently accepted stable tarball and its stamp into the external
artifact directory and keep their `sha256` and `bytes` with them. That copy is the rollback source
and the comparison point.

`--rollback-dir <artifact-dir>` names the preserved artifacts: an install verifies that the files it
finds there are unchanged before it mutates the prefix. `--preserve-to-rollback-dir` copies the
candidate and its stamp there as well, and refuses rather than overwriting a different file of the
same name.

## Guarded dry run, then install

Run the guards against the actual prefix that holds the old version. An empty prefix, or a copy of
one, does not show the real version ordering the guard is there to enforce.

```console
$ bun scripts/install.ts <artifact-dir>/team-<version>.tgz \
    --prefix <prefix> --expected-sha <source-sha> --dry-run --json
```

`--expected-sha` must equal the candidate's `gitHead`, which the pack read from the source commit.
`--dry-run` runs every provenance and version guard and mutates nothing: exit 0 allows the install,
exit 1 refuses it before mutation, and exit 2 reports a bad argument or an unreadable file.

```console
$ bun scripts/install.ts <artifact-dir>/team-<version>.tgz \
    --prefix <prefix> --expected-sha <source-sha> --record <install-record.json>
```

A forward or equal version installs. An older version is refused before any installed file is
touched unless a rollback is declared (below). The candidate must carry a valid 40-hex `gitHead` in
its manifest and a matching sidecar; `--no-stamp-sidecar` verifies the inner manifest alone. The
record names the `status`, the decision, the previous and new `version` and `gitHead`, the
tarball's `sha256` and `bytes`, the `prefix`, `installedAt`, the rollback declaration and the
preserved artifacts.

## Rollback

A rollback is an explicit install of an older tarball, not an automatic undo:

```console
$ bun scripts/install.ts <artifact-dir>/team-<version>.tgz \
    --prefix <prefix> --rollback --from <installed-version> --to <target-version> \
    --reason <why> --rollback-dir <artifact-dir> --record <rollback-record.json>
```

`--from` is the actual installed version and `--to` the version the target tarball carries; both
must match or the guard refuses before touching the prefix, and `--reason` is a non-empty reason.
Preserved rollback artifacts are verified and never overwritten. `--allow-unstamped-rollback` is
only for a legacy artifact that carries no source stamp.

## Evidence, and its limits

Keep the stamp, the check result, the dry-run JSON, the install or rollback record and the
preserved artifacts together. Quote each as its producer reported it: a stamp proves what was
packed, not that the prefix works; a dry run proves the guards pass, not an install; an install
record proves the prefix changed, not that the team starts or that any acceptance probe passed.

This tooling does not tag or publish, does not edit the changelog, and does not install, start or
activate a service. Starting the team, the installed acceptance probes and the soak remain separate
steps with their own records.
