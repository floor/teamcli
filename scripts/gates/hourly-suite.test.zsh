#!/bin/zsh
# hourly-suite.test.zsh — the no-report guarantee, both ways:
#   (a) a wrapper killed after its suite started writes the NO REPORT report and the RED
#       marker for its ref by its EXIT trap, and releases its locks;
#   (b) a log left without a report by a run that could not trap (SIGKILL) is reported the
#       same way at the start of the next pass.
# Scratch trees only (HOURLY_NOTES / HOURLY_REPO / HOURLY_WORKTREE / HOURLY_SLOT_DIR), no
# install, no send. Run: zsh hourly-suite.test.zsh
set -u
here=${0:A:h}
script=$here/hourly-suite.zsh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/hourly-suite-test.XXXXXX")
trap 'trash "$tmp" 2>/dev/null' EXIT
fail() { print -r -- "FAIL: $*"; exit 1 }
ok() { print -r -- "ok: $*" }

notes=$tmp/notes
repo=$tmp/repo
wt=$tmp/wt
slots=$tmp/slots
mkdir -p "$notes" "$slots" "$repo"
git -C "$repo" init -q
git -C "$repo" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m 'test tip'
sha=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" branch -q integration/0.5.x "$sha"

# (a) the wrapper is killed while its suite runs: the trap writes both files. The env goes on
# the zsh command itself, never through a wrapper function: a backgrounded function is its own
# subshell, so `$!` would name the wrapper and a TERM to it would never reach the script that
# holds the trap.
HOURLY_NOTES=$notes HOURLY_REPO=$repo HOURLY_WORKTREE=$wt HOURLY_SLOT_DIR=$slots \
HOURLY_NO_SEND=1 HOURLY_SKIP_INSTALL=1 HOURLY_CI_CMD='sleep 60' \
  zsh "$script" > "$tmp/a.out" 2>&1 &
pid=$!
log=$notes/hourly-suite/$sha.log
for _ in {1..100}; do [[ -e $log ]] && break; sleep 0.2; done
[[ -e $log ]] || { cat "$tmp/a.out"; fail "(a) the suite log was never created"; }
sleep 0.5
kill -TERM $pid 2>/dev/null
wait $pid 2>/dev/null
report=$notes/hourly-suite/$sha.md
[[ -e $report ]] || { cat "$tmp/a.out"; fail "(a) no report written after the kill"; }
grep -q 'NO REPORT: the run ended at ' "$report" || fail "(a) the report does not say NO REPORT"
grep -q 'last log line: ' "$report" || fail "(a) the report names no last log line"
[[ -e $notes/hourly-suite/RED ]] || fail "(a) no RED marker for the integration ref"
grep -qx "$sha" $notes/hourly-suite/RED || fail "(a) the RED marker does not carry the sha"
for lock in heavy-run.lock heavy-run-2.lock heavy-run-3.lock; do
  [[ -d $slots/$lock ]] && fail "(a) the killed run leaked $lock"
done
[[ -d $notes/hourly-suite.lock ]] && fail "(a) the killed run leaked the hourly lock"
ok "(a) a killed run left a NO REPORT report and its RED marker, with no locks"

# (b) a log with no report and no trap alongside it is reported at the start of the next pass.
notes2=$tmp/notes2
slots2=$tmp/slots2
mkdir -p "$notes2/hourly-suite" "$slots2"
stale=deadbeefcafe
log2=$notes2/hourly-suite/$stale.log
print -r -- 'suite started' > "$log2"
print -r -- 'Killed: 9' >> "$log2"
print -r -- 'integration/0.5.x' > "$notes2/hourly-suite/$stale.pending"
print -r -- 'a stale tip' >> "$notes2/hourly-suite/$stale.pending"
HOURLY_NOTES=$notes2 HOURLY_REPO=$repo HOURLY_WORKTREE=$wt HOURLY_SLOT_DIR=$slots2 \
  HOURLY_SUITE_DRY_RUN=1 HOURLY_NO_SEND=1 zsh "$script" > "$tmp/b.out" 2>&1
[[ -e $notes2/hourly-suite/$stale.md ]] || { cat "$tmp/b.out"; fail "(b) the stale log was not reported"; }
grep -q 'NO REPORT: the run ended at ' "$notes2/hourly-suite/$stale.md" || fail "(b) the report does not say NO REPORT"
grep -q 'last log line: Killed: 9' "$notes2/hourly-suite/$stale.md" || fail "(b) the report does not carry the log's last line"
[[ -e $notes2/hourly-suite/RED ]] || fail "(b) no RED marker for the recorded ref"
grep -qx "$stale" $notes2/hourly-suite/RED || fail "(b) the RED marker does not carry the stale sha"
[[ -e $notes2/hourly-suite/$stale.pending ]] && fail "(b) the sidecar was left behind"
[[ -e $notes2/hourly-suite/$sha.md ]] && fail "(b) the dry-run pass wrote a report of its own"
ok "(b) a stale log is reported, with its RED marker, at the start of the next pass"

print -r -- "PASS: both no-report paths"
