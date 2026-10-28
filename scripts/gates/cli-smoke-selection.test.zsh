#!/bin/zsh
# cli-smoke-selection.test.zsh — the always-selected CLI smoke:
#   (a) a selection without test/cli-smoke.test.ts leaves it out (the file is not written yet);
#   (b) the same selection with the file on disk carries it, with the reason `always`;
#   (c) a branch that touches it still reads `always`.
# Scratch repo only, no install, no gate run. Run:
#   zsh cli-smoke-selection.test.zsh
set -u
here=${0:A:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/cli-smoke-selection-test.XXXXXX")
trap 'trash "$tmp" 2>/dev/null' EXIT
fail() { print -r -- "FAIL: $*"; exit 1 }
ok() { print -r -- "ok: $*" }

mkdir -p "$tmp/src" "$tmp/test"
cd "$tmp" || fail "cannot enter the scratch repo"
git init -q
git -c user.name=Test -c user.email=test@example.com commit -q --allow-empty -m first
git update-ref refs/remotes/origin/main HEAD
print -r -- 'export const one = 1;' > src/one.ts
print -r -- 'import { one } from "../src/one.ts";' > test/one.test.ts
source "$here/gate-common.sh"

# (a) no smoke file yet: the changed module's test only.
gate_select_tests src/one.ts
(( ${tests[(Ie)test/one.test.ts]} )) || fail "(a) the changed module's test was not selected"
(( ${tests[(Ie)test/cli-smoke.test.ts]} )) && fail "(a) a missing CLI smoke was selected"
ok "(a) a selection without the file leaves it out"

# (b) the file exists: every run carries it, with its own reason.
print -r -- '' > test/cli-smoke.test.ts
gate_select_tests src/one.ts
(( ${tests[(Ie)test/cli-smoke.test.ts]} )) || fail "(b) the CLI smoke was not selected"
[[ ${test_why[test/cli-smoke.test.ts]:-} == always ]] || fail "(b) the CLI smoke's reason reads '${test_why[test/cli-smoke.test.ts]:-}'"
ok "(b) an existing CLI smoke rides every selection as 'always'"

# (c) a branch that touches the file: still selected, still `always`.
gate_select_tests src/one.ts test/cli-smoke.test.ts
[[ ${test_why[test/cli-smoke.test.ts]:-} == always ]] || fail "(c) a touched CLI smoke's reason reads '${test_why[test/cli-smoke.test.ts]:-}'"
ok "(c) a touched CLI smoke keeps 'always'"

print -r -- "PASS: the CLI smoke is selected on every run while it exists"
