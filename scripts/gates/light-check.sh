#!/bin/zsh
# The light check: typecheck plus the test files your branch's work touches and the tests of every
# module that imports a changed src module, two hops deep — depth 2 only while the selection stays
# under 80 files, a heavy file only when the change touches it, and a hub module (more than
# HUB_IMPORTERS direct test importers) reduced to its own name/path test with the rest queued as
# one background sweep in a heavy slot (gate-common.sh, hub-sweep.zsh) — with
# test/exit-codes.test.ts narrowed to the exit ids the diff touches. It takes
# one of 4 machine-wide light slots (no heavy slot), no push, no stamp: run it while you work, and run it as often as you like. CI runs the full
# suite; the heavy machine slots are for full-suite runs and builds only. A private patterns
# scan warns on a hit (push-gate is the gate that refuses). A slot whose owner pid is gone is
# reclaimed, never waited on; a live pid's is never touched. A hard wall-clock limit
# (LIGHT_CHECK_MAX_MIN, default 10) kills this check's own bun tree at the limit, writes
# `TIMEOUT after <n> min: running <what>`, frees the slot and exits non-zero.
#     zsh $HOME/Code/floor/briefs/teamcli-notes/light-check.sh
set -u
LOBBY=$HOME/Code/floor/briefs/teamcli-notes
source $LOBBY/gate-common.sh

top=$(git rev-parse --show-toplevel 2>/dev/null) || { print -u2 "light-check: not in a git worktree"; exit 2; }
cd $top
branch=$(git branch --show-current); [[ -n $branch ]] || branch="detached@$(git rev-parse --short HEAD)"

# Machine-wide cap (Atlas, 2026-10-17 04:00, load ~90): at most 4 light checks at once, in the
# light slots light-slot-{1..4}.lock (separate from the 3 heavy slots). Wait for a free slot.
# A slot whose owner pid is gone is reclaimed, never waited on (a dead pid held one for four
# hours); a live pid's slot is never touched. reclaim_dead_lock is gate-common.sh's.
# LIGHT_SLOT_DIR overrides the slot directory for the stub test only.
SLOT_DIR=${LIGHT_SLOT_DIR:-$LOBBY}
SLOT=""
while [[ -z $SLOT ]]; do
  for n in 1 2 3 4; do
    s=$SLOT_DIR/light-slot-$n.lock
    if out=$(reclaim_dead_lock $s); then print "light-check: $out"; fi
    if mkdir $s 2>/dev/null; then
      SLOT=$s; print -r -- "$branch $$ $(date +%H:%M:%S)" > $SLOT/owner; break
    fi
  done
  [[ -z $SLOT ]] && { print "light-check: all 4 light slots busy; waiting"; /bin/sleep 20; }
done
# A hard wall-clock limit for the whole check (Atlas, 2026-10-17): a hung check must never sit
# on a light slot. The setting is the whole check's wall clock, measured from the slot; at the
# limit a watchdog kills this check's own process tree — the bun it started and that bun's
# children, never another process — writes the TIMEOUT line, and the check exits non-zero with
# its slot freed by the EXIT trap. LIGHT_CHECK_MAX_SECONDS overrides the minutes for the stub
# test only.
LIGHT_MAX_MIN=${LIGHT_CHECK_MAX_MIN:-10}
LIGHT_MAX_SECONDS=${LIGHT_CHECK_MAX_SECONDS:-$((LIGHT_MAX_MIN * 60))}
LIGHT_STATE=$(mktemp "${TMPDIR:-/tmp}/light-check.XXXXXX" 2>/dev/null) || LIGHT_STATE=""
# What the watchdog will name, and the one pid it kills: written before and after each bun
# spawn, one field per line so the reader never parses a pid out of prose.
set_phase() {  # $1 phase text, $2 bun pid or empty
  [[ -n $LIGHT_STATE ]] || return 0
  print -r -- "phase=$1" > $LIGHT_STATE
  [[ -n ${2:-} ]] && print -r -- "bun=$2" >> $LIGHT_STATE
  return 0
}
set_phase "nothing started"
# A pid and its descendants only: pgrep -P walks the tree, never a pattern.
kill_tree() {  # $1 pid, $2 signal
  local c
  for c in $(pgrep -P $1 2>/dev/null); do kill_tree $c $2; done
  kill -$2 $1 2>/dev/null
}
# The watchdog reads the state file at fire time: a forked subshell never sees the parent's
# later variable writes. It polls in two-second steps rather than one long sleep, so a check
# that finished can kill it without a stray sleep firing later at a reused pid.
# Free this check's slot if it still holds this check's owner line — `<branch> <pid> <time>`.
# Idempotent: a slot already gone is a no-op, and a slot another check took by now holds that
# check's line and is left alone. main_pid is the parent shell, which the watchdog can outlive.
release_slot() {
  local held_branch held_pid held_rest
  [[ -n ${SLOT:-} && -f $SLOT/owner ]] || return 0
  read -r held_branch held_pid held_rest < $SLOT/owner 2>/dev/null || return 0
  [[ $held_branch == "${branch:-}" && $held_pid == "${main_pid:-}" ]] || return 0
  command rm -f $SLOT/owner
  command rmdir $SLOT 2>/dev/null
  return 0
}
light_watchdog() {
  local deadline now phase bun n label
  deadline=$(( $(date +%s) + LIGHT_MAX_SECONDS ))
  while :; do
    kill -0 $main_pid 2>/dev/null || return 0
    now=$(date +%s)
    (( now >= deadline )) && break
    /bin/sleep 2
  done
  kill -0 $main_pid 2>/dev/null || return 0
  phase=$(sed -n 's/^phase=//p' $LIGHT_STATE 2>/dev/null | tail -1)
  bun=$(sed -n 's/^bun=//p' $LIGHT_STATE 2>/dev/null | tail -1)
  if (( LIGHT_MAX_SECONDS % 60 == 0 )); then
    label="$((LIGHT_MAX_SECONDS / 60)) min"
  else
    label="$LIGHT_MAX_SECONDS s"
  fi
  print -u2 "light-check: TIMEOUT after $label: running ${phase:-nothing}"
  [[ $bun == <-> ]] && kill -0 $bun 2>/dev/null && kill_tree $bun TERM
  kill -TERM $main_pid 2>/dev/null
  for n in 1 2 3 4 5; do kill -0 $main_pid 2>/dev/null || break; /bin/sleep 1; done
  [[ $bun == <-> ]] && kill_tree $bun KILL
  # Free the slot whatever became of main_pid: its own release may have been cut short before
  # the rmdir, and the slot then still holds this check's owner line. A TERM sent while this
  # check was already releasing used to end it before the rmdir, with the watchdog seeing a dead
  # pid and skipping its own cleanup; the guarded release closes that window from both sides.
  release_slot
  kill -KILL $main_pid 2>/dev/null
  return 0
}
main_pid=$$
light_watchdog &
LIGHT_WATCHDOG=$!
# The slot is released on the way out and on a signal: EXIT only releases; INT/TERM/HUP release
# and exit (130/143) instead of letting the check run on with its slot already gone.
slot_release() {
  # Nothing may re-enter this release. The signal traps exit, so a TERM landing in the middle of
  # this function — the watchdog sends one, and it can fire as the check ends — would leave the
  # rmdir unrun. Ignore the three signals from here on, free the slot first, and only then stop
  # the watchdog and drop the state file.
  trap '' INT TERM HUP
  # For the stub test only: hold the release open so it can signal this window.
  [[ -n ${LIGHT_RELEASE_PAUSE:-} ]] && /bin/sleep $LIGHT_RELEASE_PAUSE
  release_slot
  [[ -n ${LIGHT_WATCHDOG:-} ]] && kill -TERM $LIGHT_WATCHDOG 2>/dev/null
  [[ -n ${LIGHT_STATE:-} ]] && command rm -f $LIGHT_STATE
  return 0
}
trap slot_release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
print "light-check: holds $(basename $SLOT)"
start=$SECONDS
git fetch -q origin main
# Fast mode: a branch built on the local integration branch is judged on its own work only,
# against where it left that branch, not on the whole integration delta vs origin/main.
# The integration branches it knows, newest round first; GATE_INTEGRATION overrides the list.
# Of the merge-bases that are not on origin/main, the newest one wins.
GATE_BASE=origin/main
for int in ${=GATE_INTEGRATION:-release/0.5.0 integration/0.5.x p0b-integrator}; do
  git rev-parse -q --verify $int >/dev/null || continue
  mb=$(git merge-base HEAD $int 2>/dev/null) || continue
  git merge-base --is-ancestor $mb origin/main && continue
  if [[ $GATE_BASE == origin/main ]] || git merge-base --is-ancestor $GATE_BASE $mb; then GATE_BASE=$mb; fi
done
export GATE_BASE
# The integration tip: its red stops every merge; any other branch's red blocks only that branch.
int_list=(${=GATE_INTEGRATION:-release/0.5.0 integration/0.5.x p0b-integrator})
int_tip=$int_list[1]
gate_changed
gate_select_tests $changed

print "light-check: '$branch', ${#changed} changed files vs ${GATE_BASE}, ${#tests} test files"
for t in $tests; do print "light-check:   $t (${test_why[$t]:-selected})"; done
for t in $heavy_skipped; do print "light-check:   $t (heavy, ${heavy_tests[$t]}s alone: selected only when touched, left to the hourly suite)"; done
for m in $hub_modules; do
  print "light-check:   $m (hub: ${hub_importers[$m]} direct test importers > $HUB_IMPORTERS; only its name-matched test runs here)"
done
for t in $hub_left_final; do
  print "light-check:   $t (left to the hub sweep: ${hub_left_why[$t]:-hub module})"
done
if (( depth2_capped )); then
  print "light-check:   depth 2 not selected: ${depth2_cap_why}"
fi
if (( exit_full )); then
  print "light-check: exit-codes.test.ts runs unfiltered: ${exit_full_why}"
elif (( ${#exit_ids} )); then
  print "light-check: exit ids (${#exit_ids}): ${(j:, :)exit_ids}"
else
  print "light-check: no exit id in the diff; exit-codes.test.ts skipped (CI runs it in full)"
fi

# Private name and phrase scan: a hit warns here (push-gate refuses the push), and a list that
# is present but unusable also warns. The matched text is never printed, only the location and
# the source, class and ordinal.
private_out=$(gate_private_scan); private_rc=$?
if (( private_rc == 1 )); then
  print "light-check: warning: private name or phrase hit(s) — push-gate will refuse this branch:"
  print -r -- "$private_out"
elif (( private_rc == 2 || private_rc == 3 )); then
  print -r -- "$private_out"
fi

# The hub rule left tests out; queue exactly those as ONE background sweep in a heavy slot. The
# queue directory is the marker: a second light check with the same sha and file set finds it and
# skips, and hub-sweep.zsh removes it when it exits. One run, never a loop.
if (( ${#hub_left_final} )); then
  if [[ -f $LOBBY/hub-sweep.zsh ]]; then
    hs=$LOBBY/hub-sweep
    mkdir -p $hs/queue $hs/log
    head_sha=$(git rev-parse HEAD 2>/dev/null || print -r -- nogit)
    set_hash=$(print -rl -- $hub_left_final | shasum | cut -c1-12)
    bsan=${branch:-detached}
    bsan=${bsan//\//_}
    key="${branch:-detached}"-${head_sha[1,12]}-$set_hash
    key=${key//\//_}
    q=$hs/queue/$key
    if [[ ${LIGHT_NO_HUB_SWEEP:-} == 1 ]]; then
      print "light-check: hub sweep not queued (LIGHT_NO_HUB_SWEEP=1): ${#hub_left_final} test files"
    elif mkdir $q 2>/dev/null; then
      print -rl -- $hub_left_final > $q/files
      for m in $hub_modules; do print -r -- "$m (${hub_importers[$m]} direct test importers)"; done > $q/hubs
      {
        print -r -- "branch=${branch:-detached}"
        print -r -- "sha=$head_sha"
        print -r -- "top=$top"
        print -r -- "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      } > $q/meta
      nohup zsh $LOBBY/hub-sweep.zsh $q </dev/null >>$hs/log/$key.log 2>&1 &!
      print "light-check: queued a hub sweep of ${#hub_left_final} test files in a heavy slot ($hs)"
      print "light-check: the sweep writes its report to $hs/$bsan-$head_sha.md"
      if [[ ${branch:-detached} == "$int_tip" ]]; then
        print "light-check: a red sweep writes the shared $LOBBY/hourly-suite/RED (stops every merge)"
      else
        print "light-check: a red sweep writes $hs/RED-$bsan (blocks only this branch)"
      fi
    else
      print "light-check: hub sweep already queued or running for ${head_sha[1,12]} and this file set; not queued again"
      print "light-check: its report lands at $hs/$bsan-$head_sha.md"
    fi
  else
    print -u2 "light-check: $LOBBY/hub-sweep.zsh is missing; ${#hub_left_final} test files left out and NOT queued"
  fi
fi

step=$SECONDS
# The executable the check runs (words, so the stub test can point it at a sleeper). Normal
# runs never set it; LIGHT_BUN=bun.
LIGHT_BUN=${LIGHT_BUN:-bun}
print "light-check: typecheck"
set_phase typecheck
${=LIGHT_BUN} run typecheck &
bun_pid=$!
set_phase typecheck $bun_pid
wait $bun_pid
if (( $? != 0 )); then
  print -u2 "light-check: typecheck FAILED"
  exit 1
fi
print "light-check: typecheck done in $((SECONDS-step))s"

if [[ -n $(gate_exit_ids_env) ]]; then
  export TEAM_EXIT_IDS=$(gate_exit_ids_env)
fi
fail=0
for t in $tests; do
  step=$SECONDS
  print "light-check: bun test $t"
  set_phase "bun test $t"
  if [[ -n ${GATE_ISOLATED_HOME:-} ]]; then
    # an empty HOME, for a file that reads this machine's own team store
    HOME=$(mktemp -d) ${=LIGHT_BUN} test $t &
  else
    ${=LIGHT_BUN} test $t &
  fi
  bun_pid=$!
  set_phase "bun test $t" $bun_pid
  wait $bun_pid
  (( $? != 0 )) && fail=1
  print "light-check: $t done in $((SECONDS-step))s"
  (( fail )) && break
done
set_phase done
if (( fail )); then
  print -u2 "light-check: FAILED after $((SECONDS-start))s"
  exit 1
fi
print "light-check: passed in $((SECONDS-start))s"
exit 0
