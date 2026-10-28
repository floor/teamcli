#!/bin/zsh
# light-check-release-race.test.zsh — a TERM landing inside the check's slot release must not
# leak the light slot. The release ignores INT/TERM/HUP once it starts, frees the slot before
# it stops the watchdog, and the watchdog's own cleanup is guarded by the owner line, so a
# release cut short before its rmdir is still freed. Scratch repo, scratch slot dir, a fake
# bun that exits at once, and LIGHT_RELEASE_PAUSE holding the release open while the signals
# arrive. Run: zsh light-check-release-race.test.zsh
set -u
here=${0:A:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/light-race-test.XXXXXX")
trap 'trash "$tmp" 2>/dev/null' EXIT
fail() { print -r -- "FAIL: $*"; exit 1 }
ok() { print -r -- "ok: $*" }

# A scratch origin and a clone with a change the check will select.
origin=$tmp/origin.git
git init -q --bare "$origin"
work=$tmp/work
git clone -q "$origin" "$work" 2>/dev/null || fail "cannot clone the scratch origin"
git -C "$work" config user.email t@example.invalid
git -C "$work" config user.name t
git -C "$work" checkout -q -b main
mkdir -p "$work/src"
print -r -- 'export const x = 1;' > "$work/src/x.ts"
git -C "$work" add -A
git -C "$work" commit -qm 'base'
git -C "$work" push -q origin main
git -C "$work" checkout -q -b test/race
print -r -- 'export const y = 2;' >> "$work/src/x.ts"
git -C "$work" commit -qam 'change'

# The fake bun returns at once, so the check passes and reaches its release quickly.
mkdir -p "$tmp/bin" "$tmp/slots"
print -r -- '#!/bin/zsh' > "$tmp/fake-bun.zsh"
print -r -- 'exit 0' >> "$tmp/fake-bun.zsh"

cd "$work" || fail "cannot cd to the scratch worktree"
LIGHT_BUN="zsh $tmp/fake-bun.zsh" LIGHT_SLOT_DIR=$tmp/slots LIGHT_NO_HUB_SWEEP=1 \
LIGHT_RELEASE_PAUSE=3 zsh "$here/light-check.sh" > "$tmp/check.out" 2>&1 &
check=$!
# The last line the check prints before its EXIT trap is the pass line; the paused release
# begins right after it.
for _ in {1..150}; do
  grep -q 'light-check: passed in\|light-check: FAILED' "$tmp/check.out" && break
  /bin/sleep 0.1
done
grep -q 'light-check: passed in' "$tmp/check.out" || { cat "$tmp/check.out"; fail "the check did not pass"; }
[[ -f $tmp/slots/light-slot-1.lock/owner ]] || { cat "$tmp/check.out"; fail "the check never held a slot" }
# Signal every 200ms across the release window, as the watchdog's TIMEOUT TERM can land there.
for _ in {1..5}; do
  kill -TERM $check 2>/dev/null
  /bin/sleep 0.2
done
wait $check
code=$?
[[ -d $tmp/slots/light-slot-1.lock ]] && { ls -la $tmp/slots; fail "the released check kept its light slot" }
(( code == 0 )) || { cat "$tmp/check.out"; fail "the check exited $code after the signals" }
ok "a TERM inside the release leaves the slot freed"

print -r -- "PASS: the light-check release ignores signals"
