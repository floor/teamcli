#!/bin/zsh
# Shared by push-gate.sh and light-check.sh: which test files a diff sends to the light check,
# and which exit ids that diff touches. Sourced, never run on its own.
#
# Test selection is dependency-aware: a changed src module sends the test files that import it
# directly, plus the tests of every src module that imports it — a reverse-import graph over
# src/ computed per check, transitive to depth 2. A module's tests are its direct test importers
# and its name/path convention files (src/<dir>/<name>.ts -> test/<dir>/<name>.test.ts and
# test/<name>.test.ts). Every selected file carries a reason, printed by light-check.sh and
# logged by push-gate.sh: `touched`, `imports <module>`, `matches <module>`, `depth 2` (for a
# module two import hops from the change), or `always` (the CLI smoke, below).
#
# test/cli-smoke.test.ts walks every command's `--help` and `--json --help` through the real
# CLI: any change can break it, so it is selected on every run, with the reason `always`, while
# the file exists.
#
# Four rules keep a hub change affordable. A heavy file — one that takes over ~60 s alone, listed
# with its measured time in heavy_tests below — is selected only when the change touches it; the
# hourly suite and CI cover it otherwise. A hub module — one with more than HUB_IMPORTERS direct
# test importers — contributes only its own name/path convention test (plus whatever the change
# touches) to the light check; every other test it would have pulled in is left to the hub sweep,
# the background heavy-slot run light-check.sh queues (hub-sweep.zsh, one run, never a loop). The
# non-hub depth-1 additions are a tail capped at DEPTH1_MAX files; the overflow is left to the hub
# sweep too. And when the dependency selection (the tests the branch's own touch adds aside)
# exceeds `cap` files, depth 2 is dropped and left to the hourly suite: depth 1 only. All of it
# says so in the reasons light-check.sh prints and push-gate.sh logs.
#
# A private patterns scan guards the public repo: private-patterns.txt (outside every repo, never
# committed) holds one extended regex per line. gate_private_scan prints every hit in the diff's
# added lines (vs GATE_BASE) and the branch's commit messages as file:line plus the pattern's line
# number, never the matched text. push-gate.sh refuses on a hit; light-check.sh warns; a missing
# file warns and never fails.
#
# Rule for test/exit-codes.test.ts (the one very large test file): a local run covers only the
# scenes the diff touches. The ids come from the diff against origin/main:
#   - the `//` … `exit: <id>` markers the src/ hunks carry (the changed lines and their context,
#     so a change beside a marker counts), read the way scripts/exit-codes.ts reads them
#     (MARKER = /\/\/\s*exit:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)\s*$/), so `//exit:x` counts too;
#     the whole content of an untracked src file counts, since git diff cannot show it;
#   - the ids of contract/exit-codes.json rows its hunks carry;
#   - the scene names the hunks of test/exit-codes.test.ts carry — their lines and their
#     headings (git prints the enclosing scope as the heading, which for an edit inside a scene
#     body is the scene's own opener line) — so a filtered run keeps the scene an edit lands on.
# The filter is dropped — the file runs whole — when the diff reaches the analyzer itself
# (scripts/exit-codes.ts, scripts/contract.ts), or when a hunk of test/exit-codes.test.ts names
# no scene at all (the imports, the harness): such an edit belongs to no one scene. A diff whose
# hunks carry no id at all skips the file locally and says so. CI runs it in full either way.
set -u

# Hub threshold. A src module with more than this many direct test importers (after the exit-ids
# and heavy rules) contributes only its own name/path test to the light check; the rest of its
# importers are listed as left to the hub sweep, which light-check.sh queues in a heavy slot.
# Default 10, chosen 2026-10-17 by measurement on the three reference changes (the gates README
# has the table). Raise it to expand more modules; a very large value disables the hub rule.
HUB_IMPORTERS=${HUB_IMPORTERS:-10}

# Depth-1 tail cap. The tests a non-hub depth-1 module adds (its importers and its name/path
# test) count toward this; past it, the file is left to the hub sweep instead, with the reason
# "depth-1 tail over DEPTH1_MAX". A very large value disables the cap.
DEPTH1_MAX=${DEPTH1_MAX:-60}

# A lock whose owner pid is gone is reclaimed, never waited on (Atlas, 2026-10-17: a light slot
# sat four hours under a dead pid). The owner's pid is the second word of its second line — the
# `<holder> <pid> <utc-epoch>` token the heavy and hourly scripts write — or, failing that, of
# its first line (`<branch> <pid> <time>` in a light slot). A lock with no readable pid, or
# whose pid is alive, is never touched: a live pid's lock is a check or a run in progress.
# Prints the reclaim line on success (the caller prefixes it), nothing otherwise.
reclaim_dead_lock() {  # $1 lock dir
  local dir=$1 line pid owner
  [[ -d $dir && -f $dir/owner ]] || return 1
  owner=$(<"$dir/owner")
  # The pid is the first all-digit word of the owner text (line 2 first, then line 1), so a
  # blank branch field (a detached HEAD wrote " <pid> <time>") still names its pid.
  local w
  pid=""
  for line in "$(print -r -- "$owner" | sed -n 2p)" "$(print -r -- "$owner" | sed -n 1p)"; do
    for w in ${=line}; do [[ $w == <-> ]] && { pid=$w; break; }; done
    [[ -n $pid ]] && break
  done
  [[ $pid == <-> ]] || return 1
  kill -0 $pid 2>/dev/null && return 1
  # Identity re-read before the rename: a lock that changed hands under the read carries a live
  # owner's bytes now, and is left alone.
  [[ $(<"$dir/owner") == "$owner" ]] || return 1
  command mv "$dir" "$dir.reclaimed.$$" 2>/dev/null || return 1
  command rm -f "$dir.reclaimed.$$/owner"
  command rmdir "$dir.reclaimed.$$" 2>/dev/null
  print -r -- "reclaimed ${dir:t} from dead pid $pid ($line)"
  return 0
}

# Sets `changed`: every path this branch's work touches — the diff against origin/main
# (committed and working tree) plus untracked files, so the light check is honest mid-edit.
gate_changed() {
  typeset -g -a changed
  changed=("${(@f)$(git diff --name-only ${GATE_BASE:-origin/main}; git ls-files --others --exclude-standard)}")
  changed=(${changed:#})
}

# Sets `folded` from $1, with `.`, `//` and `..` folded and no leading slash. App-relative by
# contract: every path fed to it is relative to the worktree root. Sets a variable rather than
# printing so the graph scan, thousands of edges, spends no subshell per edge.
gate_fold() {
  local p=$1 part
  local -a parts out
  parts=(${(@s:/:)p})
  out=()
  for part in $parts; do
    case $part in
      ''|.) ;;
      ..) (( ${#out} )) && out=(${out[1,-2]}) ;;
      *) out+=($part) ;;
    esac
  done
  folded="${(j:/:)out}"
}

# Builds `src_importers` and `test_importers`: for each src module, the src files that import it
# and the test files that import it, from one recursive grep each. Only relative specifiers that
# land on a src/*.ts module are edges. Every form counts — `from '…'`, `import '…'`, `import('…')`,
# `require('…')`, single- or double-quoted, with or without spaces — and a `.js` specifier names
# its `.ts` source (NodeNext's rewriteRelativeImportExtensions). A specifier inside a comment or a
# string only over-selects, never under-selects.
gate_build_graph() {
  typeset -g -A src_importers test_importers
  src_importers=()
  test_importers=()
  local line from match spec
  while IFS= read -r line; do
    from=${line%%:*}
    match=${line#*:*:}
    if [[ $match == *\'* ]]; then
      spec=${match#*\'}
      spec=${spec%%\'*}
    elif [[ $match == *\"* ]]; then
      spec=${match#*\"}
      spec=${spec%%\"*}
    else
      continue
    fi
    [[ $spec == .* ]] || continue
    gate_fold "${from:h}/$spec"
    [[ $folded == src/*.js ]] && folded=${folded%.js}.ts
    [[ $folded == src/*.ts ]] || continue
    src_importers[$folded]+=" $from"
  done < <(grep -rnoE -H "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" --include='*.ts' src)
  while IFS= read -r line; do
    from=${line%%:*}
    match=${line#*:*:}
    if [[ $match == *\'* ]]; then
      spec=${match#*\'}
      spec=${spec%%\'*}
    elif [[ $match == *\"* ]]; then
      spec=${match#*\"}
      spec=${spec%%\"*}
    else
      continue
    fi
    [[ $spec == .* ]] || continue
    gate_fold "${from:h}/$spec"
    [[ $folded == src/*.js ]] && folded=${folded%.js}.ts
    [[ $folded == src/*.ts ]] || continue
    test_importers[$folded]+=" $from"
  done < <(grep -rnoE -H "(from|import|require)[[:space:]]*\(?[[:space:]]*['\"][^'\"]+['\"]" --include='*.test.ts' test)
}

# Heavy test files, as DATA: each with the wall time it takes ALONE on this machine (one
# `bun test <file>`), measured on the shared box on 17 Oct and rounded to the second — start
# overhead included, so it is a lower bound of what the file costs inside the light check. The
# graph and the name conventions never pull one in; only a change that touches it does. The
# hourly suite and CI run them otherwise. Add a line once a file measures over ~60 s alone.
# (The sweep of all test files alone found exactly one other: test/exit-codes.test.ts, 153 s
# unfiltered — the exit-ids rule's own, never selected here without its filter.)
typeset -A heavy_tests=(
  test/broker.test.ts 963   # sized claim-lane stress (~2.5k real spawns): ~16 min alone
)

# Adds a test file to `tests` once, with its selection reason in `test_why`; the first reason
# wins, so a touched test reads `touched` however else the graph reaches it (the CLI smoke is
# added before the touched files, so it keeps `always`). The one very large
# test file is the exit-ids rule's (or the branch's own touch) alone: the graph never adds it
# unfiltered. A heavy file (heavy_tests above) enters only when the change touches it; every
# other path that reaches it records the skip in `heavy_skipped` for the scripts' reasons.
gate_add_test() {
  local t=$1 why=$2
  [[ $t == test/exit-codes.test.ts && $why != "exit ids" && $why != touched ]] && return 0
  if [[ -n ${heavy_tests[$t]:-} && $why != touched ]]; then
    (( ${heavy_skipped[(Ie)$t]} )) || heavy_skipped+=($t)
    return 0
  fi
  (( ${tests[(Ie)$t]} )) && return 0
  tests+=($t)
  test_why[$t]=$why
}

# The direct test importers the graph would add for module $1: unique, minus the two classes it
# never adds unfiltered (the exit-ids file, a heavy file). Sets `hub_it` (the array) and `hub_n`
# (its count) — variables rather than stdout, so counting thousands of edges spends no subshell.
gate_hub_importers() {
  local t
  hub_it=()
  for t in ${(u)${=test_importers[$1]:-}}; do
    [[ $t == test/exit-codes.test.ts ]] && continue
    [[ -n ${heavy_tests[$t]:-} ]] && continue
    hub_it+=($t)
  done
  hub_n=${#hub_it}
}

# Records a test the hub rule would have selected but leaves out, once, with the reason it would
# have carried; the final list (after every other rule) becomes `hub_left_final`, the sweep's set.
# The exit-ids file and heavy files keep their own accounting and are never sweep candidates.
gate_hub_leave() {
  local t=$1 why=$2
  [[ $t == test/exit-codes.test.ts ]] && return 0
  [[ -n ${heavy_tests[$t]:-} ]] && return 0
  (( ${hub_left[(Ie)$t]} )) || hub_left+=($t)
  [[ -n ${hub_left_why[$t]:-} ]] || hub_left_why[$t]=$why
}

# Adds a non-hub depth-1 test while the tail has room (DEPTH1_MAX, counted in the caller's
# d1_tail_n); past it the file goes to the sweep's list instead, with the cap as its reason.
gate_add_tail() {
  local t=$1 why=$2 was=0
  (( ${tests[(Ie)$t]} )) && was=1
  if (( was )) || (( d1_tail_n < DEPTH1_MAX )); then
    gate_add_test $t $why
    if (( ! was )) && (( ${tests[(Ie)$t]} )); then (( d1_tail_n++ )); fi
  else
    gate_hub_leave $t "depth-1 tail over $DEPTH1_MAX"
  fi
}

# Appends to exit_ids every id the marker lines on stdin name. Feed it the grep -oE matches of
# //[[:space:]]*exit:[[:space:]]*[A-Za-z0-9._-]+ — the analyzer's marker regex with a loose id.
# A marker line with no id after it is ignored.
gate_marker_ids() {
  local m id
  while IFS= read -r m; do
    id=${m##*exit:}
    id=${id//[[:space:]]/}
    id=${id%%[^A-Za-z0-9._-]*}
    [[ -n $id ]] && exit_ids+=($id)
  done
}

# Sets `exit_ids` (the touched ids, possibly empty), `exit_full` (1 when the filter must not be
# used) and `exit_full_why` (the reason, for the scripts' prints). Reads the changed-file list
# from "$@".
gate_exit_ids() {
  typeset -g -aU exit_ids
  typeset -g exit_full=0 exit_full_why=""
  exit_ids=()
  local f line id exit_file=0
  for f in "$@"; do
    case $f in
      scripts/exit-codes.ts|scripts/contract.ts)
        exit_full=1; exit_full_why="the analyzer itself changed" ;;
      test/exit-codes.test.ts) exit_file=1 ;;
    esac
  done
  gate_marker_ids < <(git diff -U3 ${GATE_BASE:-origin/main} -- src | grep -vE '^(\+\+\+|---)' | grep -oE '//[[:space:]]*exit:[[:space:]]*[A-Za-z0-9._-]+')
  while IFS= read -r f; do
    [[ -n $f ]] && gate_marker_ids < <(grep -oE '//[[:space:]]*exit:[[:space:]]*[A-Za-z0-9._-]+' -- "$f")
  done < <(git ls-files --others --exclude-standard -- src)
  while IFS= read -r line; do
    id=${line#*'"id": "'}
    [[ $id == $line ]] && continue
    id=${id%%'"'*}
    [[ -n $id ]] && exit_ids+=($id)
  done < <(git diff -U3 ${GATE_BASE:-origin/main} -- contract/exit-codes.json | grep -vE '^(\+\+\+|---)' | grep -F '"id": "')
  if (( exit_file )); then
    local seen=0 cur_has=0 naked=0
    while IFS= read -r line; do
      case $line in
        '@@'*)
          # a new hunk: the one before it must have named a scene
          if (( seen )) && (( ! cur_has )); then naked=1; fi
          seen=1; cur_has=0 ;;
        '+++'*|'---'*) continue ;;
      esac
      if [[ $line == *"scene('"* ]]; then
        cur_has=1
        id=${line#*scene\(}
        id=${id#"'"}; id=${id%%"'"*}
        id=${id%%[^A-Za-z0-9._-]*}
        [[ -n $id ]] && exit_ids+=($id)
      fi
    done < <(git diff -U3 ${GATE_BASE:-origin/main} -- test/exit-codes.test.ts)
    if (( seen )) && (( ! cur_has )); then naked=1; fi
    if (( naked )) && (( ! exit_full )); then
      exit_full=1
      exit_full_why="a hunk of test/exit-codes.test.ts names no scene (the imports, the harness)"
    fi
  fi
}

# Sets `tests` (unique, in order) and `test_why` from the changed-file list in "$@", and with
# them `exit_ids`, `exit_full` and `exit_full_why`. What lands:
#   - the test files the change touches;
#   - for every changed src module: its direct test importers, its name/path files, and the same
#     for every src module that imports it (depth 1) and every module that imports one of those
#     (depth 2) — the reverse-import graph, computed per check; depth 2 only while the dependency
#     selection stays at or under `cap` files, else `depth2_capped` is set for the scripts' print;
#   - the docs rule: a docs page, the READMEs or a src/commands change sends docs.test.ts,
#     next.test.ts and every docs boundary test;
#   - test/exit-codes.test.ts under the exit-ids rule above.
gate_select_tests() {
  typeset -g -aU tests
  typeset -g -A test_why
  typeset -g -aU heavy_skipped
  typeset -g -aU hub_modules hub_left hub_left_final
  typeset -g -A hub_importers hub_left_why
  typeset -g depth2_capped=0 depth2_cap_why=""
  tests=()
  test_why=()
  heavy_skipped=()
  hub_modules=(); hub_left=(); hub_left_final=(); hub_importers=()
  hub_left_why=()
  local f d m i t rel hub_n
  local -a frontier conv hub_it
  local touched_n n1 d1_tail_n=0
  local cap=80
  typeset -A affected hop
  affected=()
  hop=()
  # 0. the CLI smoke, while it exists: every command's `--help` and `--json --help` through the
  # real CLI, so any change can break it. Added before the touched files so its reason reads
  # `always` on every run; a missing file (not written yet) is simply skipped.
  [[ -f test/cli-smoke.test.ts ]] && gate_add_test test/cli-smoke.test.ts always
  # 1. the test files the branch touches
  for f in "$@"; do
    [[ $f == test/*.test.ts || $f == test/**/*.test.ts ]] && [[ -f $f ]] || continue
    gate_add_test $f touched
  done
  touched_n=${#tests}
  # 2. the reverse-import closure over src/, depth 2, and every affected module's tests
  gate_build_graph
  for f in "$@"; do
    case $f in
      # a deleted module still seeds: the files that import it are exactly what should run
      src/*.ts) affected[$f]=1; hop[$f]=0 ;;
    esac
  done
  if (( ${#affected} )); then
    frontier=(${(k)affected})
    for m in $frontier; do
      (( ${hop[$m]:-0} == 0 )) || continue
      for i in ${=src_importers[$m]:-}; do
        [[ -n ${affected[$i]:-} ]] && continue
        affected[$i]=1; hop[$i]=1
      done
    done
    frontier=(${(k)affected})
    for m in $frontier; do
      (( ${hop[$m]:-0} == 1 )) || continue
      for i in ${=src_importers[$m]:-}; do
        [[ -n ${affected[$i]:-} ]] && continue
        affected[$i]=1; hop[$i]=2
      done
    done
    # depth 1 first: the change and its direct importers, with each module's tests. A hub module
    # contributes only its own name/path test; its other importers go to the sweep's list. The
    # non-hub additions are the tail DEPTH1_MAX caps; past it they join the sweep's list too.
    # Sorted module order makes the capped set the same on every run.
    for m in ${(ok)affected}; do
      (( ${hop[$m]:-0} == 2 )) && continue
      rel=${m#src/}
      conv=(test/${rel:r}.test.ts test/${rel:t:r}.test.ts)
      gate_hub_importers $m
      if (( hub_n > HUB_IMPORTERS )); then
        (( ${hub_modules[(Ie)$m]} )) || hub_modules+=($m)
        hub_importers[$m]=$hub_n
        for t in $hub_it; do gate_hub_leave $t "imports $m"; done
        for t in $conv; do
          [[ -f $t ]] && gate_add_test $t "matches $m"
        done
      else
        for t in $hub_it; do gate_add_tail $t "imports $m"; done
        for t in $conv; do
          [[ -f $t ]] && gate_add_tail $t "matches $m"
        done
      fi
    done
    # depth 2 second, and only while the dependency selection stays at or under the cap; above
    # it the depth-2 files are dropped again and left to the hourly suite (`depth 2` reasons).
    n1=${#tests}
    for m in ${(ok)affected}; do
      (( ${hop[$m]:-0} == 2 )) || continue
      rel=${m#src/}
      conv=(test/${rel:r}.test.ts test/${rel:t:r}.test.ts)
      gate_hub_importers $m
      if (( hub_n > HUB_IMPORTERS )); then
        (( ${hub_modules[(Ie)$m]} )) || hub_modules+=($m)
        hub_importers[$m]=$hub_n
        for t in $hub_it; do gate_hub_leave $t "imports $m (depth 2)"; done
      else
        for t in $hub_it; do gate_add_test $t "depth 2"; done
      fi
      for t in $conv; do
        [[ -f $t ]] && gate_add_test $t "matches $m (depth 2)"
      done
    done
    if (( ${#tests} - touched_n > cap )); then
      depth2_capped=1
      depth2_cap_why="the dependency selection is $(( ${#tests} - touched_n )) test files, over the $cap cap; depth 2 left to the hourly suite ($(( n1 - touched_n )) depth-1 files kept)"
      for (( i = n1 + 1; i <= ${#tests}; i++ )); do
        unset "test_why[${tests[i]}]"
      done
      tests=(${tests[1,$n1]})
    fi
  fi
  # 3. the docs rule
  for f in "$@"; do
    case $f in
      docs/*|README.md|npm-readme.md|src/commands/*)
        gate_add_test test/docs.test.ts docs
        [[ -f test/next.test.ts ]] && gate_add_test test/next.test.ts docs
        for d in test/docs/*.test.ts(N); do gate_add_test $d docs; done ;;
    esac
  done
  gate_exit_ids "$@"
  if (( exit_full )) || (( ${#exit_ids} )); then
    gate_add_test test/exit-codes.test.ts "exit ids"
  fi
  # The sweep's set: every hub candidate and every depth-1 tail overflow no other rule selected (a
  # touched file, the hub's own name-matched test, the docs or exit-ids rule). A file the depth-2
  # cap dropped stays here too — the background sweep covering it is never worse than the hourly
  # suite alone.
  hub_left_final=()
  for t in $hub_left; do
    (( ${tests[(Ie)$t]} )) && continue
    hub_left_final+=($t)
  done
}

# The TEAM_EXIT_IDS value for the selected work, or empty when the file runs unfiltered (or is
# not selected at all).
gate_exit_ids_env() {
  if (( ! exit_full )) && (( ${#exit_ids} )); then
    print -r -- "${(j:,:)exit_ids}"
  fi
}

# Private name and phrase scan. The sources are the two external lists outside every repo
# (`private-names.txt` and `private-phrases-prepush.txt`, never committed); the semantics, the
# strict POSIX ERE subset, the scope headers, the non-comment prepush-only marker and the
# cross-source dedupe all live in the repository's shared modules, not here. This wrapper calls
# `scripts/check-private-diff.ts`, which reads every added line of the diff against GATE_BASE
# and every line of every commit message on GATE_BASE..HEAD through `git grep -E` with the
# pattern list on standard input. A hit prints its location, source, class and ordinal, never
# the matched text.
#
# Returns 0 clean or default lists absent (a visible skip is printed), 1 hits, 2 the scan could
# not run (an explicitly named list is missing, or a list is unreadable, group-readable, empty
# or invalid: the push is refused), 3 this checkout predates the shared check (a visible skip;
# an old branch must not be blocked by a file it cannot have). GATE_PRIVATE_NAMES and
# GATE_PRIVATE_PHRASES point the scan at other files (tests use neutral temporary ones).
gate_private_scan() {
  local top base script out rc
  top=$(git rev-parse --show-toplevel 2>/dev/null)
  base=${GATE_BASE:-origin/main}
  script=$top/scripts/check-private-diff.ts
  if [[ -z $top || ! -f $script ]]; then
    print -r -- "private-diff: skipped: the checked-out commit has no shared private diff check"
    return 3
  fi
  local -a args
  args=(--root "$top" --base "$base")
  [[ -n ${GATE_PRIVATE_NAMES:-} ]] && args+=(--private-names "$GATE_PRIVATE_NAMES")
  [[ -n ${GATE_PRIVATE_PHRASES:-} ]] && args+=(--private-phrases "$GATE_PRIVATE_PHRASES")
  out=$(cd "$top" && bun "$script" "${args[@]}" 2>&1); rc=$?
  print -r -- "$out"
  return $rc
}
