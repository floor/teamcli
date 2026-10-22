# RC3 installer post-dispatch regression

Independent tester coverage for the installer's failure reporting after a backend call was
attempted. It is authored from the exact reviewed source `4e50561d46a29e0452908fece2a2573cb8f93124`
(tree `06f22ceddfa91010da83f780f7735620723aac0b`) and does not copy any builder fixture.

Every row runs on a private temporary prefix with a synthetic tarball and an injected backend:

- a pre-dispatch version refusal (control) and a missing-tarball refusal (control);
- a fake `npm` executable placed first on `PATH` for the call, which writes a partial package into
  the prefix and then exits nonzero;
- an injected backend function that leaves the old manifest in place;
- an injected backend that writes the candidate manifest but modifies or removes a preserved
  rollback artifact after dispatch;
- the same rows through the JSON and text CLI output, including the record file.

No real npm, global installation, rollback or provider action is performed. The fake `npm` is a
shell stub in a temporary directory and all frames are synthetic.

The rows pin the agreed failure contract: `phase` (`pre-dispatch` | `post-dispatch`),
`dispatched`, the actual `mutateCalls`, `mutated` as `false | true | null`, `installedState`
(`unchanged` | `changed` | `unknown`), and a measured `postState` object on post-dispatch
failures whose reinspection succeeded (`exists`/`version`/`gitHead`/`matchesCandidate`, plus the
`inspection: 'ok'` marker), while a post-dispatch inspection failure reports `postState: null` and
`installedState: 'unknown'`. A successfully measured absent installation is a `postState` object
with `exists: false` and null observed values, distinct from an inspection failure.
`mutated` is false only for pre-dispatch refusals, true only when the measured post-state
establishes a change, and explicit `null` when the mutation is not established; the attempt itself
is carried by `dispatched` and `mutateCalls`. Post-dispatch failures also write the record when a
record path is given and carry `recordPath` (absolute, null when none was given) and `recordError`
(null on a successful write, the write error otherwise); pre-dispatch refusals write none and
report both null. A failing record write keeps every mutation fact and names the record error in
the message, so the attempt and outcome are not lost to it.
