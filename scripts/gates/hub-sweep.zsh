#!/bin/zsh
# hub-sweep.zsh — one background run of the test files the hub rule left out of a light check,
# in a heavy machine slot: one run, then exit (never a loop). Queued by light-check.sh, which
# creates the queue directory atomically — an identical sha and file set already queued or running
# makes mkdir fail and the light check skips; this script trashes the directory when it exits.
#     zsh scripts/gates/hub-sweep.zsh <queue-dir>
#
# The queue directory holds: files (one test path per line), hubs (the hub modules that left them
# out), meta (branch=, sha=, top=, created=), pid (this run, written below). A directory whose pid
# names a dead process and which has no matching report is stale: only the taker, the coordinator
# or the owner trashes it.
#
# One heavy slot: first free of heavy-run{,-2,-3}.lock by mkdir, owner lines inside, released right
# after the test loop (before the report and the send) and trashed by the exit trap. When no slot
# frees up within HUB_SLOT_TRIES x 20 s (default 30 min), the run is reported as not run (no RED):
# the hourly suite still covers the files. A slot whose owner pid is gone is reclaimed before it
# is skipped; a live pid's slot is never touched.
#
# Report: hub-sweep/<branch>-<sha>.md (counts, per-file lines, failures by file with the first
# error line) and <branch>-<sha>.log (the raw bun output). A red result writes a marker chosen by
# branch: the integration tip (GATE_INTEGRATION's first entry, default integration/0.5.x) writes the
# shared hourly-suite/RED that stops every merge; any other branch writes hub-sweep/RED-<branch
# with / as _>, which blocks only that branch's merge into the integration branch. A lead clears a
# marker. One line goes to the orchestrator (team send, from REPO), with retries unless the refusal
# is an admission one (unplaced / not admitted), which a retry cannot fix.
#
# Test hooks, never set by a seat's normal run:
#   HUB_SWEEP_NOTES / HUB_SWEEP_REPO / HUB_SWEEP_SLOT_DIR   scratch trees and slot directory
#   HUB_SWEEP_TEST_CMD=<shell words>   run instead of `bun test` (default)
#   HUB_SWEEP_NO_SEND=1                skip the team send
#   HUB_SWEEP_DRY_RUN=1                take the slot, write the report, run no test
#   HUB_SWEEP_SLOT_TRIES=<n>           slot wait in 20 s tries (default 90)
set -u

NOTES=${HUB_SWEEP_NOTES:-$HOME/Code/floor/briefs/teamcli-notes}
REPO=${HUB_SWEEP_REPO:-$HOME/Code/floor/teamcli}
SLOT_DIR=${HUB_SWEEP_SLOT_DIR:-$HOME/Code/floor/briefs}
OUT=$NOTES/hub-sweep
TRIES=${HUB_SWEEP_SLOT_TRIES:-90}
TOKEN="hub-sweep $$ $(date -u +%s)"
test_cmd=(${=HUB_SWEEP_TEST_CMD:-bun test})
int_list=(${=GATE_INTEGRATION:-integration/0.5.x p0b-integrator})
int_tip=$int_list[1]

say() { print -r -- "hub-sweep: $*" }

if (( $# < 1 )); then
  print -u2 "hub-sweep: usage: hub-sweep.zsh <queue-dir>"
  exit 2
fi
Q=$1
if [[ ! -d $Q ]]; then
  print -u2 "hub-sweep: no queue directory $Q"
  exit 2
fi
branch=$(sed -n 's/^branch=//p' "$Q/meta" 2>/dev/null)
sha=$(sed -n 's/^sha=//p' "$Q/meta" 2>/dev/null)
top=$(sed -n 's/^top=//p' "$Q/meta" 2>/dev/null)
created=$(sed -n 's/^created=//p' "$Q/meta" 2>/dev/null)
typeset -a files hubs
files=(${(f)"$(<$Q/files 2>/dev/null)"})
files=(${files:#})
hubs=(${(f)"$(<$Q/hubs 2>/dev/null)"})
hubs=(${hubs:#})
print -r -- "$$" > "$Q/pid" 2>/dev/null
branch=${branch:-detached}
sha=${sha:-nogit}
bsan=${branch//\//_}
nfiles=${#files}

typeset -g slot=""
ours() {  # the lock still carries this run's token on line 2
  [[ -f $1/owner && $(sed -n 2p "$1/owner" 2>/dev/null) == "$TOKEN" ]]
}
release_slot() {
  if [[ -n $slot && -d $slot ]] && ours "$slot"; then
    trash "$slot" 2>/dev/null
  fi
  slot=""
}
release() {
  release_slot
  [[ -d $Q ]] && trash "$Q" 2>/dev/null
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# A heavy lock whose owner pid is gone is reclaimed, never waited on (Atlas, 2026-10-17: a light
# slot sat four hours under a dead pid; the same rule here for the heavy slots). The owner's pid
# is the second word of its second line — this script's `hub-sweep <pid> <epoch>` token, the
# hourly suite's `run <pid> <epoch>`, or another writer's `<holder> <pid> <epoch>` — or, failing
# that, of its first line. A lock with no readable pid, or whose pid is alive, is never touched.
reclaim_dead_lock() {  # $1 lock dir
  local dir=$1 line pid owner
  [[ -d $dir && -f $dir/owner ]] || return 1
  owner=$(<"$dir/owner")
  line=$(print -r -- "$owner" | sed -n 2p)
  pid=${${=line}[2]}
  if [[ $pid != <-> ]]; then
    line=$(print -r -- "$owner" | sed -n 1p)
    pid=${${=line}[2]}
  fi
  [[ $pid == <-> ]] || return 1
  kill -0 $pid 2>/dev/null && return 1
  # Identity re-read before the rename: a lock that changed hands under the read carries a live
  # owner's bytes now, and is left alone.
  [[ $(<"$dir/owner") == "$owner" ]] || return 1
  command mv "$dir" "$dir.reclaimed.$$" 2>/dev/null || return 1
  command rm -f "$dir.reclaimed.$$/owner"
  command rmdir "$dir.reclaimed.$$" 2>/dev/null
  say "reclaimed ${dir:t} from dead pid $pid ($line)"
  return 0
}

send_line() {
  local msg=$1 out rc i
  if [[ ${HUB_SWEEP_NO_SEND:-} == 1 ]]; then
    say "send skipped (HUB_SWEEP_NO_SEND=1): $msg"
    return 0
  fi
  for i in 1 2; do
    out=$( cd "$REPO" && team send orchestrator "$msg" 2>&1 ); rc=$?
    if (( rc == 0 )); then say "sent to the orchestrator (attempt $i)"; return 0; fi
    say "send attempt $i failed: $out"
    if [[ $out == *refused:*unplaced* || $out == *"not admitted"* ]]; then
      say "admission refusal: a retry cannot change the caller's identity; not retrying"
      return 1
    fi
    (( i < 2 )) && sleep 20
  done
  say "could not send to the orchestrator after 2 attempts"
  return 1
}

mkdir -p "$OUT" "$NOTES/hourly-suite"

# One heavy slot, first free, or wait a bounded time. A slot whose owner is gone is reclaimed
# first; a live pid's slot is never touched.
for (( try = 1; try <= TRIES; try++ )); do
  for p in "$SLOT_DIR/heavy-run.lock" "$SLOT_DIR/heavy-run-2.lock" "$SLOT_DIR/heavy-run-3.lock"; do
    reclaim_dead_lock "$p"
    if mkdir "$p" 2>/dev/null; then
      slot=$p
      print -r -- "hub-sweep ($bsan)" > "$slot/owner"
      print -r -- "$TOKEN" >> "$slot/owner"
      break 2
    fi
  done
  (( try < TRIES )) && say "all heavy slots busy; waiting (try $try/$TRIES)"
  sleep 20
done

report=$OUT/$bsan-$sha.md
if [[ -z $slot ]]; then
  {
    print -r -- "# Hub sweep — $branch at $sha"
    print -r -- ""
    print -r -- "- Worktree: \`${top:-(unknown)}\`"
    print -r -- "- File set: $nfiles test files, queued by the light check at $created"
    print -r -- "- Verdict: ERROR — no heavy slot free after $((TRIES * 20))s; not run (no RED)"
    print -r -- ""
    print -r -- "The hourly suite and CI still cover these files."
  } > "$report"
  say "no heavy slot free after $((TRIES * 20))s; not run"
  send_line "hub sweep ${bsan} ${sha[1,12]}: not run — no heavy slot free in $((TRIES * 20))s (hourly suite covers it)"
  exit 0
fi
say "holds ${slot:t} for ${bsan} at ${sha[1,12]} ($nfiles test files)"

if [[ ${HUB_SWEEP_DRY_RUN:-} == 1 ]]; then
  {
    print -r -- "# Hub sweep — $branch at $sha"
    print -r -- ""
    print -r -- "- Worktree: \`${top:-(unknown)}\`"
    print -r -- "- File set: $nfiles test files, queued by the light check at $created"
    print -r -- "- Verdict: DRY RUN — the slot was taken and released; no test ran"
    print -r -- ""
    print -r -- "## The files"
    print -r -- ""
    for t in $files; do print -r -- "- $t"; done
  } > "$report"
  say "dry run: $nfiles test files, report $report"
  exit 0
fi

cd "$top" 2>/dev/null || {
  {
    print -r -- "# Hub sweep — $branch at $sha"
    print -r -- ""
    print -r -- "- Worktree: \`${top:-(unknown)}\` (missing — cannot run)"
    print -r -- "- Verdict: ERROR — the worktree is gone; not run (no RED)"
  } > "$report"
  say "worktree $top is gone; not run"
  send_line "hub sweep ${bsan} ${sha[1,12]}: not run — the worktree is gone (no RED)"
  exit 0
}

runlog=$OUT/$bsan-$sha.log
faillog=$OUT/.$bsan-$sha.fail
one=$OUT/.$bsan-$sha.one
: > "$runlog"
: > "$faillog"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
t0=$SECONDS
pass=0 fail=0 skip=0 nerr=0 expc=0 red=0
typeset -a perfile fail_files
perfile=(); fail_files=()
for t in $files; do
  step=$SECONDS
  print -r -- "=== $t ===" >> "$runlog"
  ( "${test_cmd[@]}" "$t" ) > "$one" 2>&1
  rc=$?
  cat "$one" >> "$runlog"
  read -r p f s x e <<< "$(awk '
    /^ *[0-9]+ pass$/ { p = $1 }
    /^ *[0-9]+ fail$/ { f = $1 }
    /^ *[0-9]+ skip$/ { s = $1 }
    /^ *[0-9]+ error$/ { x = $1 }
    /^ *[0-9]+ expect\(\) calls$/ { e = $1 }
    END { printf "%d %d %d %d %d\n", p, f, s, x, e }
  ' "$one")"
  pass=$(( pass + p )); fail=$(( fail + f )); skip=$(( skip + s ))
  nerr=$(( nerr + x )); expc=$(( expc + e ))
  nf=0
  if (( rc != 0 )); then
    red=1
    (( ${fail_files[(Ie)$t]} )) || fail_files+=($t)
    nf=$(awk -v file="$t" '
      /^error: / {
        if (!ne) {
          ne = 1; err = $0
          if ((getline) > 0) {
            while (($0 ~ /^ *$/) && ((getline) > 0)) { }
            err = err "; " $0
            if ((getline) > 0) err = err "; " $0
          }
        }
      }
      /^\(fail\) / {
        scene = $0; sub(/^\(fail\) /, "", scene); sub(/ \[[0-9.]+ms\]$/, "", scene)
        printf "%s\t%s\t%s\n", file, scene, (ne ? err : "(no error line captured)")
      }
    ' "$one" | tee -a "$faillog" | wc -l | tr -d ' ')
    if (( nf == 0 )); then
      first=""
      first=$(grep -E 'error|Error|FAILED|exited with code' "$one" 2>/dev/null | head -1)
      print -r -- "$t	(no bun test failure line; exited $rc)	${first:-(see the log)}" >> "$faillog"
    fi
  fi
  perfile+=("- $t — $p pass, $f fail, $s skip${x:+, $x error} ($(( SECONDS - step ))s)")
done
# The slot is for the tests only: release it before the report and the send, so a slow or
# refused send never holds another seat's heavy slot.
release_slot
say "released the heavy slot; the report and the send follow"
dur=$(( SECONDS - t0 ))
ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
trash "$one" 2>/dev/null

verdict=GREEN
(( red )) && verdict=RED
marker=""
if (( red )); then
  if [[ $branch == "$int_tip" ]]; then marker=$NOTES/hourly-suite/RED; else marker=$OUT/RED-$bsan; fi
fi

{
  print -r -- "# Hub sweep — $branch at $sha"
  print -r -- ""
  print -r -- "- Worktree: \`${top:-(unknown)}\`"
  print -r -- "- Branch: \`$branch\` — HEAD \`$sha\`"
  print -r -- "- File set: $nfiles test files (queued by the light check at $created)"
  print -r -- "- Started: $started — finished $ended (${dur}s)"
  print -r -- "- Verdict: $verdict"
  print -r -- "- Counts: $pass pass, $fail fail, $skip skip, $nerr error, $expc expect() calls across $nfiles files"
  if [[ -n $marker ]]; then
    print -r -- "- Marker: \`$marker\`"
  else
    print -r -- "- Marker: none (GREEN)"
  fi
  print -r -- ""
  print -r -- "## The files"
  print -r -- ""
  for line in "${perfile[@]}"; do print -r -- "$line"; done
  print -r -- ""
  print -r -- "## Left out by"
  print -r -- ""
  if (( ${#hubs} )); then
    for line in "${hubs[@]}"; do print -r -- "- $line"; done
  else
    print -r -- "(not recorded)"
  fi
  print -r -- ""
  print -r -- "## Failures by file"
  print -r -- ""
  if [[ -s $faillog ]]; then
    typeset cur=""
    while IFS=$'\t' read -r f scene err; do
      if [[ $f != "$cur" ]]; then
        print -r -- ""
        print -r -- "### $f"
        cur=$f
      fi
      print -r -- "- $scene — $err"
    done < "$faillog"
  elif (( red )); then
    print -r -- "No bun test failure line; the run stopped early. Read the log."
  else
    print -r -- "None."
  fi
  print -r -- ""
  print -r -- "Evidence: \`$runlog\` (raw output)."
} > "$report"

if (( red )); then
  if [[ $marker == "$NOTES/hourly-suite/RED" ]]; then
    {
      print -r -- "$sha"
      for f in "${fail_files[@]}"; do print -r -- "$f"; done
      print -r -- "no merges into the integration branch until understood"
    } > "$marker"
  else
    {
      print -r -- "branch $branch"
      print -r -- "$sha"
      for f in "${fail_files[@]}"; do print -r -- "$f"; done
      print -r -- "no merge of this branch into the integration branch until understood"
    } > "$marker"
  fi
  say "wrote marker $marker"
fi

typeset files_text=""
if (( ${#fail_files} )); then
  files_text=$(print -r -- "${(j:, :)fail_files[1,6]}")
  (( ${#fail_files} > 6 )) && files_text="$files_text and $(( ${#fail_files} - 6 )) more"
fi
if (( red )); then
  send_line "hub sweep ${bsan} ${sha[1,12]}: RED — $pass pass, $fail fail, $skip skip across $nfiles files in ${dur}s; $files_text; marker $marker"
else
  send_line "hub sweep ${bsan} ${sha[1,12]}: GREEN — $pass pass, $fail fail, $skip skip across $nfiles files in ${dur}s"
fi
say "done: $verdict at ${sha[1,12]} in ${dur}s — report $report"
exit 0
