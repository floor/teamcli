#!/bin/zsh
# The team's push gate. Run it INSTEAD of `git push`, from inside your worktree:
#     zsh scripts/gates/push-gate.sh [git push arguments]
# It runs typecheck and the test files your branch's work touches, plus the tests of every module
# that imports a changed src module two hops deep (depth 2 only while the selection stays under 80
# files, a heavy file only when the change touches it, a hub module reduced to its own name/path
# test with the rest left to the light check's hub sweep) and the files that enumerate commands or
# read the docs when your diff reaches them, with test/exit-codes.test.ts narrowed to the exit ids
# your diff touches — see gate-common.sh. A private name and phrase scan refuses the push on a
# hit (its location, source, class and ordinal only, never the matched text) and refuses when a
# list is present but unusable. No lock: seats no
# longer queue behind
# each other, and the heavy machine slots are for full-suite runs and builds only. It pushes
# only if all of it passes, and leaves a stamp the orchestrator checks against the pushed commit.
set -u
GATES=${0:A:h}
LOBBY=$HOME/Code/floor/briefs/teamcli-notes
source $GATES/gate-common.sh
GATE=$LOBBY/gate
mkdir -p $GATE

top=$(git rev-parse --show-toplevel 2>/dev/null) || { print -u2 "push-gate: not in a git worktree"; exit 2; }
cd $top
if [[ -n $(git status --porcelain) ]]; then print -u2 "push-gate: uncommitted changes; commit first"; exit 2; fi
branch=$(git branch --show-current)
if [[ -z $branch || $branch == main ]]; then print -u2 "push-gate: refusing on '$branch'"; exit 2; fi
sha=$(git rev-parse HEAD)
start=$SECONDS
git fetch -q origin main
gate_changed
gate_select_tests $changed

log=$GATE/${branch//\//_}-$sha.log
: > $log
print -r -- "push-gate: '$branch' at $sha, ${#changed} changed files vs origin/main, ${#tests} test files" >> $log
for t in $tests; do print -r -- "push-gate:   $t (${test_why[$t]:-selected})" >> $log; done
for t in $heavy_skipped; do print -r -- "push-gate:   $t (heavy, ${heavy_tests[$t]}s alone: selected only when touched, left to the hourly suite)" >> $log; done
for m in $hub_modules; do
  print -r -- "push-gate:   $m (hub: ${hub_importers[$m]} direct test importers > $HUB_IMPORTERS; only its name-matched test runs here)" >> $log
done
for t in $hub_left_final; do
  print -r -- "push-gate:   $t (left to the hub sweep: ${hub_left_why[$t]:-hub module})" >> $log
done
(( ${#hub_left_final} )) && print -r -- "push-gate: the light check queues those in a heavy slot; CI runs the full suite" >> $log
if (( depth2_capped )); then
  print -r -- "push-gate: depth 2 left to the hourly suite: ${depth2_cap_why}" >> $log
fi
if (( exit_full )); then
  print -r -- "push-gate: exit-codes.test.ts runs unfiltered: ${exit_full_why}" >> $log
elif (( ${#exit_ids} )); then
  print -r -- "push-gate: exit ids (${#exit_ids}): ${(j:, :)exit_ids}" >> $log
else
  print -r -- "push-gate: no exit id in the diff; exit-codes.test.ts skipped" >> $log
  print "push-gate: no exit id in the diff; exit-codes.test.ts skipped locally (CI runs it in full)"
fi

# Private name and phrase scan: a hit refuses the push, and so does a list that is present but
# unusable. A default list that is absent, or a checkout that predates the shared check, is a
# visible skip. The scan prints where a hit is and which source, class and ordinal matched,
# never the matched text.
private_out=$(gate_private_scan); private_rc=$?
print -r -- "push-gate: private scan ($private_rc):" >> $log
print -r -- "$private_out" >> $log
if (( private_rc == 1 )); then
  print -r -- "push-gate: private name or phrase hit(s) — the push is refused:"
  print -r -- "$private_out"
  print -u2 "push-gate: FAILED, nothing pushed. Read $log"
  exit 1
elif (( private_rc == 2 )); then
  print -r -- "push-gate: the private scan cannot run — the push is refused:"
  print -r -- "$private_out"
  print -u2 "push-gate: FAILED, nothing pushed. Read $log"
  exit 1
elif (( private_rc == 3 )); then
  print -r -- "$private_out"
fi

fail=0
step=$SECONDS
print -r -- "push-gate: typecheck" >> $log
if bun run typecheck >> $log 2>&1; then
  print -r -- "push-gate: typecheck done in $((SECONDS-step))s" >> $log
else
  print -r -- "push-gate: typecheck FAILED after $((SECONDS-step))s" >> $log
  fail=1
fi

ids=$(gate_exit_ids_env)
if (( ! fail )) && [[ -f .agents/team.yaml ]]; then
  # The commit-signature policy's push gate, in the same predicate the commit-msg hook runs.
  # Only a CLI that reads --point can run it: the shared script must never block a seat on an
  # install that predates this release, so an older CLI says so and the push goes on.
  step=$SECONDS
  if team commits check --help 2>/dev/null | grep -q -- '--point'; then
    print -r -- "push-gate: commit-signature (team commits check origin/main..HEAD --point push_gate)" >> $log
    if team commits check origin/main..HEAD --point push_gate >> $log 2>&1; then
      print -r -- "push-gate: commit-signature ok in $((SECONDS-step))s" >> $log
    else
      print -r -- "push-gate: commit-signature FAILED after $((SECONDS-step))s" >> $log
      fail=1
    fi
  else
    print -r -- "push-gate: commit-signature SKIPPED: the installed CLI does not read --point" >> $log
    print "push-gate: commit-signature SKIPPED (the installed CLI predates --point)"
  fi
fi
if (( ! fail )); then
  if [[ -n $ids ]]; then export TEAM_EXIT_IDS=$ids; fi
  for t in $tests; do
    step=$SECONDS
    if [[ -n ${GATE_ISOLATED_HOME:-} ]]; then
      # an empty HOME, for a file that reads this machine's own team store
      print -r -- "push-gate: bun test $t (isolated HOME)" >> $log
      if ! HOME=$(mktemp -d) bun test $t >> $log 2>&1; then fail=1; fi
    else
      print -r -- "push-gate: bun test $t" >> $log
      if ! bun test $t >> $log 2>&1; then fail=1; fi
    fi
    print -r -- "push-gate: $t done in $((SECONDS-step))s" >> $log
    if (( fail )); then
      print -r -- "push-gate: $t FAILED" >> $log
      break
    fi
  done
fi

if (( fail )); then
  print -u2 "push-gate: FAILED, nothing pushed. Read $log"
  exit 1
fi
print "$sha $branch typecheck ${tests[*]:-no-test-files}" > $GATE/${branch//\//_}-$sha.ok
print "push-gate: passed in $((SECONDS-start))s (${#tests} test files); pushing"
git push "$@"
