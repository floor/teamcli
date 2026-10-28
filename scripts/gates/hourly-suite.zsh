#!/bin/zsh
# hourly-suite.zsh — one full suite on the integration tip, at most once an hour, while a
# round is open (owner-approved structural change, Dr Jones 2026-10-17 ~09:00).
#
# An operator seat runs it in its OWN pane, as a loop — never a detached background loop:
#     zsh scripts/gates/hourly-suite.zsh --loop
#
# One pass:
#   1. reads the integration tip (`git -C <repo> rev-parse integration/0.5.x`; HOURLY_INTEGRATION_REF
#      points it at another ref, and GATE_INTEGRATION's first entry names the tip when set);
#   2. skips when it is the sha the last pass suited (state file), when another hourly
#      pass is held, or when any heavy machine slot (heavy-run{,-2,-3}.lock) is held;
#   3. takes one heavy slot and the hourly lock by mkdir (owner line inside; a trap
#      trashes both, also on failure; a lock whose owner pid is gone is reclaimed first —
#      a live pid's is never touched);
#   4. updates the dedicated worktree to that sha and runs bun install --frozen-lockfile;
#   5. runs bun run ci once, writes hourly-suite/<sha>.md (counts, failures by file and
#      first error line) and sends one line to the orchestrator;
#   6. a red result writes a marker chosen by ref: the integration tip writes the shared
#      hourly-suite/RED (sha, files, "no merges into the integration branch until understood");
#      any other ref writes hourly-suite/RED-<ref with / as _>, which blocks only that branch's
#      merge. The lead clears a marker.
#
# A run that cannot start (no integration tip, worktree update failed, bun install
# failed) is an ERROR, not a red tip: it writes no RED and sends one line saying why.
# The state file records only a completed suite, so the next hour retries the same tip.
#
# A run that ends without its report is never silence: the report says
# `NO REPORT: the run ended at <time> without results (last log line: …)` and the RED
# marker for that ref is written. The EXIT trap does that for a wrapper that exits or is
# killed after its suite started, and the start of every pass reports a previous log that
# still has no report beside it (the wrapper a SIGKILL could not trap).
#
# --loop runs one pass, sleeps HOURLY_INTERVAL seconds (default 3600), repeats.
# Ctrl-C or SIGTERM releases the locks it holds.
#
# Test hooks, never set by the operator:
#   HOURLY_SUITE_DRY_RUN=1   stop after the worktree update: no install, no suite, no
#                            report, no state, no RED, no send
#   HOURLY_CI_CMD=<shell>    run <shell> as the suite instead of `bun run ci`
#   HOURLY_SKIP_INSTALL=1    skip bun install --frozen-lockfile (with a stub suite)
#   HOURLY_NO_SEND=1         skip the team send (scratch trees only)
#   HOURLY_NOTES / HOURLY_REPO / HOURLY_WORKTREE / HOURLY_SLOT_DIR
#                            point the whole pass at a scratch tree
set -u

NOTES=${HOURLY_NOTES:-$HOME/Code/floor/briefs/teamcli-notes}
REPO=${HOURLY_REPO:-$HOME/Code/floor/teamcli}
WT=${HOURLY_WORKTREE:-$HOME/Code/floor/worktrees/team/hourly-suite}
int_list=(${=GATE_INTEGRATION:-integration/0.5.x p0b-integrator})
int_tip=$int_list[1]
REF=${HOURLY_INTEGRATION_REF:-$int_tip}
SLOT_DIR=${HOURLY_SLOT_DIR:-$HOME/Code/floor/briefs}
OUT=$NOTES/hourly-suite
STATE=$NOTES/hourly-suite.last-sha
HLOCK=$NOTES/hourly-suite.lock
SEAT=${HOURLY_SEAT:-hourly-suite}
INTERVAL=${HOURLY_INTERVAL:-3600}
TOKEN="run $$ $(date -u +%s)"

typeset -g heavy_slot="" hourly_lock="" ci_pid=""
typeset -g pending_sha="" pending_log="" pending_subject="" pending_ref="" pending_marker=""
say() { print -r -- "hourly-suite: $*" }

ours() {  # the lock still carries this run's token on line 2
  [[ -f $1/owner && $(sed -n 2p "$1/owner" 2>/dev/null) == "$TOKEN" ]]
}
release_locks() {
  if [[ -n $heavy_slot && -d $heavy_slot ]] && ours "$heavy_slot"; then
    trash "$heavy_slot" 2>/dev/null
  fi
  if [[ -n $hourly_lock && -d $hourly_lock ]] && ours "$hourly_lock"; then
    trash "$hourly_lock" 2>/dev/null
  fi
  heavy_slot=""; hourly_lock=""
}
# A lock whose owner pid is gone is reclaimed, never waited on (Atlas, 2026-10-17: a light slot
# sat four hours under a dead pid; the same rule here for the hourly lock and the heavy slots).
# The owner's pid is the second word of its second line — this script's `run <pid> <epoch>`
# token, or another writer's `<holder> <pid> <epoch>` — or, failing that, of its first line. A
# lock with no readable pid, or whose pid is alive, is never touched.
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
# The way out of a run that started its suite and did not write the report: the report says
# NO REPORT and the marker for its ref is written. Both are the run's own — the report the
# normal path writes means this is a no-op.
no_report() {
  [[ -n $pending_sha ]] || return 0
  [[ -e $OUT/$pending_sha.md ]] && return 0
  write_no_report "$pending_sha" "$pending_log" "$pending_subject" "$pending_ref" "$pending_marker"
}
write_no_report() {
  local sha=$1 log=$2 subject=$3 ref=$4 marker=$5 stamp last
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  last=$(tail -n 1 "$log" 2>/dev/null | tr -d '\r')
  {
    print -r -- "# Hourly suite — $sha"
    print -r -- ""
    if [[ -n $subject ]]; then
      print -r -- "- Integration tip: \`$sha\` — $subject"
    else
      print -r -- "- Integration tip: \`$sha\`"
    fi
    print -r -- "- NO REPORT: the run ended at $stamp without results (last log line: ${last:-(none)})."
    print -r -- "- Marker: \`$marker\`"
    print -r -- ""
    print -r -- "The suite process ended or was killed before the report was written; the log is the only evidence:"
    print -r -- "\`$log\`."
  } > "$OUT/$sha.md"
  {
    [[ $marker == "$OUT/RED" ]] || print -r -- "branch $ref"
    print -r -- "$sha"
    print -r -- "no report: the run ended at $stamp without results"
    if [[ $marker == "$OUT/RED" ]]; then
      print -r -- "no merges into the integration branch until understood"
    else
      print -r -- "no merge of this branch into the integration branch until understood"
    fi
  } > "$marker"
  rm -f "$OUT/$sha.pending"
  say "NO REPORT: wrote $OUT/$sha.md and marker $marker"
}
# At the start of a pass: a previous log still without its report beside it — a wrapper a
# SIGKILL left no chance to trap — is reported now, with the marker of the ref it recorded.
sweep_no_report() {
  local log sha ref subject marker
  [[ -d $OUT ]] || return 0
  for log in "$OUT"/*.log(N); do
    [[ ${log:t} == *.install.log ]] && continue
    sha=${log:t:r}
    [[ -e $OUT/$sha.md ]] && continue
    ref=$(sed -n 1p "$OUT/$sha.pending" 2>/dev/null)
    subject=$(sed -n 2p "$OUT/$sha.pending" 2>/dev/null)
    if [[ -n $ref ]]; then
      if [[ $ref == "$int_tip" ]]; then marker=$OUT/RED; else marker=$OUT/RED-${ref//\//_}; fi
    else
      ref="(not recorded)"
      subject=""
      marker=$OUT/RED
    fi
    write_no_report "$sha" "$log" "$subject" "$ref" "$marker"
  done
}
trap 'no_report; release_locks' EXIT
trap '[[ -n $ci_pid ]] && kill -TERM $ci_pid 2>/dev/null; exit 130' INT
trap '[[ -n $ci_pid ]] && kill -TERM $ci_pid 2>/dev/null; exit 143' TERM HUP

send_line() {
  local msg=$1 out rc i
  if [[ ${HOURLY_NO_SEND:-} == 1 ]]; then
    say "send skipped (HOURLY_NO_SEND=1): $msg"
    return 0
  fi
  for i in 1 2 3; do
    out=$( cd "$REPO" && team send orchestrator "$msg" 2>&1 ); rc=$?
    if (( rc == 0 )); then say "sent to the orchestrator (attempt $i)"; return 0; fi
    say "send attempt $i failed: $out"
    if [[ $out == *refused:*unplaced* || $out == *"not admitted"* ]]; then
      say "admission refusal: a retry cannot change the caller's identity; not retrying"
      return 1
    fi
    (( i < 3 )) && sleep 20
  done
  say "could not send to the orchestrator after 3 attempts"
  return 1
}

pass() {
  local sha last subject started ended t0 code dur log parse line step marker ref_name
  local -a fail_files fail_scenes fail_errs listed strays
  local summary_pass="" summary_fail="" summary_skip="" summary_expect="" summary_ran=""

  # Before anything else: a previous run that left its log without a report is reported now.
  sweep_no_report
  if ! sha=$(git -C "$REPO" rev-parse --verify "$REF^{commit}" 2>/dev/null); then
    say "no integration tip '$REF' in $REPO; skipping"
    return 0
  fi
  subject=$(git -C "$REPO" log -1 --format='%s' "$sha" 2>/dev/null)
  last=""
  [[ -f $STATE ]] && last=$(head -1 "$STATE" 2>/dev/null | tr -d '[:space:]')
  if [[ $last == $sha ]]; then
    say "tip ${sha[1,12]} already suited (state $STATE); skipping"
    return 0
  fi

  # One hourly pass at a time, then the heavy-slot rule: any slot held -> skip this hour. A lock
  # whose owner is gone is reclaimed first; a live pid's lock is never touched.
  reclaim_dead_lock "$HLOCK"
  if ! mkdir "$HLOCK" 2>/dev/null; then
    say "another hourly pass holds $HLOCK; skipping"
    return 0
  fi
  hourly_lock=$HLOCK
  print -r -- "$SEAT (hourly-suite)" > "$hourly_lock/owner"
  print -r -- "$TOKEN" >> "$hourly_lock/owner"
  local p
  for p in "$SLOT_DIR/heavy-run.lock" "$SLOT_DIR/heavy-run-2.lock" "$SLOT_DIR/heavy-run-3.lock"; do
    reclaim_dead_lock "$p"
    if [[ -d $p ]]; then
      say "heavy slot $p is held; skipping"
      release_locks
      return 0
    fi
  done
  for p in "$SLOT_DIR/heavy-run.lock" "$SLOT_DIR/heavy-run-2.lock" "$SLOT_DIR/heavy-run-3.lock"; do
    if mkdir "$p" 2>/dev/null; then
      heavy_slot=$p
      print -r -- "$SEAT (hourly-suite)" > "$heavy_slot/owner"
      print -r -- "$TOKEN" >> "$heavy_slot/owner"
      break
    fi
  done
  if [[ -z $heavy_slot ]]; then
    say "all heavy slots were taken by another run; skipping"
    release_locks
    return 0
  fi
  say "holds ${heavy_slot:t} and ${hourly_lock:t} for ${sha[1,12]} ($subject)"

  # The dedicated worktree follows the integration tip.
  if [[ ! -d $WT ]]; then
    mkdir -p "${WT:h}"
    if ! git -C "$REPO" worktree add --detach -q "$WT" "$sha" 2>/dev/null; then
      say "cannot create worktree $WT; no suite run"
      release_locks
      send_line "hourly suite ${sha[1,12]}: ERROR — cannot create worktree $WT; no suite run"
      return 0
    fi
  else
    git -C "$WT" clean -qfd 2>/dev/null
    if ! git -C "$WT" checkout -q -f --detach "$sha" 2>/dev/null; then
      say "cannot update worktree $WT to ${sha[1,12]}; no suite run"
      release_locks
      send_line "hourly suite ${sha[1,12]}: ERROR — cannot update worktree; no suite run"
      return 0
    fi
  fi

  if [[ ${HOURLY_SUITE_DRY_RUN:-} == 1 ]]; then
    say "dry run: $WT is at ${sha[1,12]}; would run bun install --frozen-lockfile then: ${HOURLY_CI_CMD:-bun run ci}"
    release_locks
    return 0
  fi

  mkdir -p "$OUT"
  if [[ ${HOURLY_SKIP_INSTALL:-} != 1 ]]; then
    if ! ( cd "$WT" && bun install --frozen-lockfile ) > "$OUT/$sha.install.log" 2>&1; then
      say "bun install --frozen-lockfile failed; no suite run (log $OUT/$sha.install.log)"
      {
        print -r -- "# Hourly suite — $sha"
        print -r -- ""
        print -r -- "- Integration tip: $sha $subject"
        print -r -- "- Verdict: ERROR — bun install --frozen-lockfile failed; no suite result"
        print -r -- "- Log: $OUT/$sha.install.log"
        print -r -- ""
        print -r -- "The first error lines:"
        print -r -- '```'
        grep -E 'error|Error|FAILED' "$OUT/$sha.install.log" 2>/dev/null | head -10
        print -r -- '```'
      } > "$OUT/$sha.md"
      release_locks
      send_line "hourly suite ${sha[1,12]}: ERROR — bun install failed; no suite result (no RED)"
      return 0
    fi
  fi

  log=$OUT/$sha.log
  # From here a kill must not be silence: the EXIT trap writes this run's NO REPORT report
  # and marker, and the sidecar tells a later pass the ref a log with no report belongs to.
  ref_name=${REF#origin/}
  if [[ $ref_name == "$int_tip" ]]; then pending_marker=$OUT/RED; else pending_marker=$OUT/RED-${ref_name//\//_}; fi
  pending_sha=$sha; pending_log=$log; pending_subject=$subject; pending_ref=$ref_name
  {
    print -r -- "$ref_name"
    print -r -- "$subject"
  } > "$OUT/$sha.pending"
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  t0=$SECONDS
  if [[ -n ${HOURLY_CI_CMD:-} ]]; then
    ( cd "$WT" && exec zsh -c "$HOURLY_CI_CMD" ) > "$log" 2>&1 &
  else
    ( cd "$WT" && exec bun run ci ) > "$log" 2>&1 &
  fi
  ci_pid=$!
  wait $ci_pid
  code=$?
  ci_pid=""
  dur=$((SECONDS - t0))
  ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  parse=$OUT/$sha.parse
  awk '
    BEGIN { pass="0"; fail="0"; skip="0"; expc="0" }
    /^test\/.*\.test\.ts:$/ { f=$0; sub(/:$/,"",f); next }
    # bun ends with one compact "N tests failed:" list: those (fail) lines echo a file output
    # section and stand outside every file, so they get no attribution here.
    /^[0-9]+ tests failed:$/ { f=""; next }
    /^\(fail\) / {
      if (f == "") next
      scene=$0; sub(/^\(fail\) /,"",scene); sub(/ \[[0-9.]+ms\]$/,"",scene)
      n++; ff[n]=f; fs[n]=scene; fe[n]=""; pend[n]=1
      next
    }
    pend[n] {
      if ($0 ~ /^ *[0-9]+ \|/) next
      if ($0 ~ /^ *\^ *$/) next
      if ($0 ~ /^ *$/) next
      fe[n]=$0; pend[n]=0
      next
    }
    /^ *[0-9]+ pass$/ { pass=$1 }
    /^ *[0-9]+ fail$/ { fail=$1 }
    /^ *[0-9]+ skip$/ { skip=$1 }
    /^ *[0-9]+ expect\(\) calls$/ { expc=$1 }
    /^Ran [0-9]+ tests across / { ran=$0 }
    /^\$ / { st=$0; sub(/^\$ /,"",st) }
    END {
      printf "SUMMARY\t%s\t%s\t%s\t%s\t%s\n", pass, fail, skip, expc, (ran==""?"(no bun test summary)":ran)
      printf "STEP\t%s\n", (st==""?"(none)":st)
      for (i=1;i<=n;i++) printf "FAIL\t%s\t%s\t%s\n", ff[i], fs[i], (fe[i]==""?"(no error line captured)":fe[i])
    }
  ' "$log" > "$parse"

  fail_files=(); fail_scenes=(); fail_errs=(); listed=(); strays=()
  # SUMMARY carries five fields: pass fail skip expect ran.
  while IFS=$'\t' read -r kind a b c d e; do
    case $kind in
      SUMMARY)
        summary_pass=$a; summary_fail=$b; summary_skip=$c; summary_expect=$d; summary_ran=$e ;;
      STEP) step=$a ;;
      FAIL) fail_files+=("$a"); fail_scenes+=("$b"); fail_errs+=("$c") ;;
    esac
  done < "$parse"
  step=${step:-(none)}
  if (( $(grep -c '^SUMMARY' "$parse" 2>/dev/null) == 0 )); then
    summary_ran="(the parser produced no SUMMARY line; read $parse)"
  fi

  local i f verdict
  for (( i = 1; i <= ${#fail_files}; i++ )); do
    f=${fail_files[$i]}
    (( ${listed[(I)$f]} == 0 )) && listed+=("$f")
  done
  if (( code == 0 )); then
    verdict=GREEN
  else
    verdict=RED
  fi
  marker=""
  if (( code != 0 )); then
    ref_name=${REF#origin/}
    if [[ $ref_name == "$int_tip" ]]; then marker=$OUT/RED; else marker=$OUT/RED-${ref_name//\//_}; fi
  fi
  local file_word="files"
  (( ${#listed} == 1 )) && file_word="file"

  if (( code != 0 )) && (( ${#fail_files} == 0 )); then
    while IFS= read -r line; do
      [[ -n $line ]] && strays+=("$line")
    done < <(grep -E 'error|Error|FAILED|exited with code' "$log" 2>/dev/null | head -10)
  fi

  {
    print -r -- "# Hourly suite — $sha"
    print -r -- ""
    print -r -- "- Integration tip: \`$sha\` — $subject"
    print -r -- "- Started: $started — finished $ended (${dur}s)"
    print -r -- "- Exit: $code — $verdict"
    if [[ -n $marker ]]; then
      print -r -- "- Marker: \`$marker\`"
    else
      print -r -- "- Marker: none (GREEN)"
    fi
    if (( code == 0 )); then
      print -r -- "- Last step: $step"
    else
      print -r -- "- Failed at: $step"
    fi
    if [[ $summary_ran == "(no bun test summary)" ]]; then
      print -r -- "- Counts: no bun test summary (the run stopped before or outside bun test)"
    else
      print -r -- "- Counts: $summary_pass pass, $summary_fail fail, $summary_skip skip, $summary_expect expect() calls; $summary_ran"
    fi
    print -r -- ""
    if (( ${#fail_files} )); then
      print -r -- "## Failures by file (${#listed} $file_word)"
      local g
      for g in "${listed[@]}"; do
        print -r -- ""
        print -r -- "### $g"
        for (( i = 1; i <= ${#fail_files}; i++ )); do
          [[ ${fail_files[$i]} == "$g" ]] || continue
          print -r -- "- ${fail_scenes[$i]} — ${fail_errs[$i]}"
        done
      done
    elif (( code == 0 )); then
      print -r -- "## Failures"
      print -r -- ""
      print -r -- "None."
    else
      print -r -- "## The run stopped at: $step"
      print -r -- ""
      print -r -- "No bun test failure line; first error lines from the log:"
      print -r -- ""
      print -r -- '```'
      if (( ${#strays} )); then
        for line in "${strays[@]}"; do print -r -- "$line"; done
      else
        print -r -- "(none matched error/FAILED; see $log)"
      fi
      print -r -- '```'
    fi
    print -r -- ""
    print -r -- "Evidence: \`$log\` (raw output), \`$parse\` (parsed lines)."
  } > "$OUT/$sha.md"
  pending_sha=""
  rm -f "$OUT/$sha.pending"

  if (( code != 0 )); then
    {
      [[ $marker == "$OUT/RED" ]] || print -r -- "branch $ref_name"
      print -r -- "$sha"
      if (( ${#listed} )); then
        for f in "${listed[@]}"; do print -r -- "$f"; done
      else
        print -r -- "stopped at: $step"
      fi
      if [[ $marker == "$OUT/RED" ]]; then
        print -r -- "no merges into the integration branch until understood"
      else
        print -r -- "no merge of this branch into the integration branch until understood"
      fi
    } > "$marker"
    say "wrote marker $marker"
  fi

  print -r -- "$sha" > "$STATE"

  local files_text
  if (( ${#listed} )); then
    files_text="${(j:, :)listed}"
  else
    files_text="stopped at $step"
  fi
  local counts_text
  if [[ $summary_ran == "(no bun test summary)" ]]; then
    counts_text="no bun test summary"
  else
    counts_text="$summary_pass pass, $summary_fail fail, $summary_skip skip ($summary_ran)"
  fi
  if (( code == 0 )); then
    send_line "hourly suite ${sha[1,12]}: GREEN — $counts_text, ${dur}s"
  elif (( ${#listed} )); then
    send_line "hourly suite ${sha[1,12]}: RED — $counts_text, ${#listed} $file_word: $files_text; marker $marker"
  else
    send_line "hourly suite ${sha[1,12]}: RED — $counts_text; $files_text; marker $marker"
  fi
  say "done: $verdict at ${sha[1,12]} in ${dur}s — report $OUT/$sha.md"

  release_locks
  return 0
}

if [[ ${1:-} == --loop ]]; then
  say "loop mode: one pass, then ${INTERVAL}s between passes — run this in your own pane, never detached"
  while :; do
    pass
    sleep "$INTERVAL"
  done
else
  pass
fi
exit 0
