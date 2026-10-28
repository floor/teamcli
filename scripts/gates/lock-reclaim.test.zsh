#!/bin/zsh
# lock-reclaim.test.zsh — the stale-lock rule, dead against live:
#   (a) gate-common.sh's reclaim_dead_lock reclaims a lock whose owner pid is gone and never
#       touches one whose pid is alive (or one with no pid to read);
#   (b) the hourly suite's own copy, wired to its hourly lock and its heavy slots: a dead
#       heavy-run.lock is reclaimed and the pass proceeds, a live one stops the pass untouched;
#   (c) hub-sweep's copy: a dead heavy-run.lock is reclaimed before it takes a slot.
# Scratch trees only (HOURLY_* / HUB_SWEEP_* hooks), no install, no send. Run:
#   zsh lock-reclaim.test.zsh
set -u
here=${0:A:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/lock-reclaim-test.XXXXXX")
trap 'trash "$tmp" 2>/dev/null' EXIT
fail() { print -r -- "FAIL: $*"; exit 1 }
ok() { print -r -- "ok: $*" }

# A pid that is certainly gone: a child spawned and reaped.
(exit 0) & deadpid=$!
wait $deadpid 2>/dev/null

# (a) the shared function, dead against live against no-pid.
source "$here/gate-common.sh"
slots=$tmp/slots-a
mkdir -p "$slots"
mkdir "$slots/heavy-run.lock"
print -r -- "builder (test)" > "$slots/heavy-run.lock/owner"
print -r -- "run $deadpid 1700000000" >> "$slots/heavy-run.lock/owner"
out=$(reclaim_dead_lock "$slots/heavy-run.lock") || fail "(a) the dead-pid lock was not reclaimed"
[[ $out == "reclaimed heavy-run.lock from dead pid $deadpid (run $deadpid 1700000000)" ]] || fail "(a) the reclaim line reads '$out'"
[[ -e $slots/heavy-run.lock ]] && fail "(a) the dead-pid lock is still there"
mkdir "$slots/heavy-run-2.lock"
print -r -- "builder (test)" > "$slots/heavy-run-2.lock/owner"
print -r -- "run $$ 1700000000" >> "$slots/heavy-run-2.lock/owner"
out=$(reclaim_dead_lock "$slots/heavy-run-2.lock") && fail "(a) a live pid's lock was reclaimed: $out"
[[ -d $slots/heavy-run-2.lock && -f $slots/heavy-run-2.lock/owner ]] || fail "(a) the live lock was altered"
mkdir "$slots/heavy-run-3.lock"
print -r -- "coordinator" > "$slots/heavy-run-3.lock/owner"
out=$(reclaim_dead_lock "$slots/heavy-run-3.lock") && fail "(a) a lock with no pid was reclaimed: $out"
[[ -d $slots/heavy-run-3.lock ]] || fail "(a) the no-pid lock was removed"
ok "(a) a dead-pid lock is reclaimed, a live one and a pid-less one are not"

# (b) the hourly suite: its own copy takes the dead heavy slot; a live slot stops it.
mkdir -p "$tmp/repo-b" "$tmp/slots-b" "$tmp/notes-b"
git -C "$tmp/repo-b" init -q
git -C "$tmp/repo-b" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m 'test tip'
sha=$(git -C "$tmp/repo-b" rev-parse HEAD)
git -C "$tmp/repo-b" branch -q integration/0.5.x "$sha"
mkdir "$tmp/slots-b/heavy-run.lock"
print -r -- "builder (test)" > "$tmp/slots-b/heavy-run.lock/owner"
print -r -- "run $deadpid 1700000000" >> "$tmp/slots-b/heavy-run.lock/owner"
HOURLY_NOTES=$tmp/notes-b HOURLY_REPO=$tmp/repo-b HOURLY_WORKTREE=$tmp/wt-b \
HOURLY_SLOT_DIR=$tmp/slots-b HOURLY_SUITE_DRY_RUN=1 HOURLY_NO_SEND=1 \
  zsh "$here/hourly-suite.zsh" > "$tmp/b1.out" 2>&1
grep -q "reclaimed heavy-run.lock from dead pid $deadpid" "$tmp/b1.out" || { cat "$tmp/b1.out"; fail "(b) the dead heavy slot was not reclaimed"; }
grep -q 'dry run: ' "$tmp/b1.out" || { cat "$tmp/b1.out"; fail "(b) the pass did not proceed after the reclaim"; }
for lock in heavy-run.lock heavy-run-2.lock heavy-run-3.lock; do
  [[ -d $tmp/slots-b/$lock ]] && fail "(b) the run leaked $lock"
done
[[ -d $tmp/notes-b/hourly-suite.lock ]] && fail "(b) the run leaked the hourly lock"
mkdir -p "$tmp/notes-c" "$tmp/slots-c"
for lock in heavy-run.lock heavy-run-2.lock heavy-run-3.lock; do
  mkdir "$tmp/slots-c/$lock"
  print -r -- "builder (test)" > "$tmp/slots-c/$lock/owner"
  print -r -- "run $$ 1700000000" >> "$tmp/slots-c/$lock/owner"
done
HOURLY_NOTES=$tmp/notes-c HOURLY_REPO=$tmp/repo-b HOURLY_WORKTREE=$tmp/wt-c \
HOURLY_SLOT_DIR=$tmp/slots-c HOURLY_SUITE_DRY_RUN=1 HOURLY_NO_SEND=1 \
  zsh "$here/hourly-suite.zsh" > "$tmp/b2.out" 2>&1
grep -q 'reclaimed' "$tmp/b2.out" && { cat "$tmp/b2.out"; fail "(b) a live heavy slot was reclaimed"; }
grep -q 'heavy slot .* is held; skipping' "$tmp/b2.out" || { cat "$tmp/b2.out"; fail "(b) the live heavy slot did not stop the pass"; }
for lock in heavy-run.lock heavy-run-2.lock heavy-run-3.lock; do
  [[ -d $tmp/slots-c/$lock ]] || fail "(b) a live lock was removed: $lock"
done
ok "(b) the hourly suite reclaims a dead heavy slot and leaves a live one alone"

# (c) hub-sweep: a dead heavy slot is reclaimed before it takes one.
mkdir -p "$tmp/sweep/queue" "$tmp/notes-d" "$tmp/slots-d" "$tmp/top-d"
q=$tmp/sweep/queue/k1
mkdir "$q"
print -r -- "branch=test/reclaim" > "$q/meta"
print -r -- "sha=deadbeefcafe" >> "$q/meta"
print -r -- "top=$tmp/top-d" >> "$q/meta"
print -r -- "created=2026-10-17T00:00:00Z" >> "$q/meta"
print -r -- "test/fake.test.ts" > "$q/files"
print -r -- "src/fake.ts (1 direct test importers)" > "$q/hubs"
mkdir "$tmp/slots-d/heavy-run.lock"
print -r -- "builder (test)" > "$tmp/slots-d/heavy-run.lock/owner"
print -r -- "run $deadpid 1700000000" >> "$tmp/slots-d/heavy-run.lock/owner"
HUB_SWEEP_NOTES=$tmp/notes-d HUB_SWEEP_REPO=$tmp/repo-b HUB_SWEEP_SLOT_DIR=$tmp/slots-d \
HUB_SWEEP_DRY_RUN=1 HUB_SWEEP_NO_SEND=1 HUB_SWEEP_SLOT_TRIES=1 \
  zsh "$here/hub-sweep.zsh" "$q" > "$tmp/c.out" 2>&1
grep -q "reclaimed heavy-run.lock from dead pid $deadpid" "$tmp/c.out" || { cat "$tmp/c.out"; fail "(c) the dead heavy slot was not reclaimed"; }
grep -q 'dry run: 1 test files' "$tmp/c.out" || { cat "$tmp/c.out"; fail "(c) the sweep did not take a slot after the reclaim"; }
ok "(c) the hub sweep reclaims a dead heavy slot"

print -r -- "PASS: dead-pid locks are reclaimed, live and pid-less locks are not"
