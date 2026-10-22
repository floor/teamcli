# RC4 installer backend-exception regression

Independent tester coverage for what the installer reports when the prefix's `bin/team`
cannot be replaced, or when a dispatched backend throws. It is authored from exact main
`ddf96e80bb1466b0e8ba9022f6ddbd4afccca2fa` (tree
`7e7ee177476b811ef5e0da594f3c591e8b534b38`) and copies no builder fixture.

Every scene runs on a private temporary prefix with a synthetic tarball, its stamp sidecar,
and an injected backend. No real npm, global installation, rollback, provider action or
real prefix is touched.

The contract pinned here:

- A prefix whose `bin/team` is a directory cannot take the symlink. The public installer
  CLI refuses before dispatch with decision `refuse-installed-bin-not-file` (code 2):
  `phase: 'pre-dispatch'`, `dispatched: false`, `mutateCalls: 0`, `mutated: false`,
  `installedState: 'unchanged'`, `postState: null`, both `recordPath` and `recordError`
  null, no record file, and the prefix measured unchanged (same file digests, `bin/team`
  still a directory, and no uncaught `EEXIST`).
- A backend that was dispatched, changed the prefix and then threw is reported as a
  measured post-dispatch failure with decision `refuse-installer-failed` (code 2), never
  as an uncaught exception: `dispatched: true`, `mutateCalls: 1`, `mutated: true`,
  `installedState: 'changed'`, `postState` with `inspection: 'ok'` and the measured
  `exists`/`version`/`gitHead`/`matchesCandidate`, the requested record written with the
  same facts, the thrown text in the message, and no message claiming a rollback.
- A dispatched backend that throws without changing the prefix reports the same
  post-dispatch shape with `installedState: 'unknown'` and `mutated: null` (the effect is
  not established), with `postState` measured and the prefix unchanged.

Controls: a dispatched backend that writes the candidate and returns is a successful
install, and a normal seeded prefix with a `bin/team` symlink still installs through the
public CLI.
