#!/bin/zsh
# light-check-limit.test.zsh — the check's hard wall-clock limit, with a sleeping fake bun:
# at the limit the watchdog kills this check's own process tree (the fake bun and its sleep
# child, nothing else), writes the TIMEOUT line naming what was running, the check exits
# non-zero, and its slot is freed. Scratch repo, scratch slot dir, no real bun, no network.
# Run: zsh light-check-limit.test.zsh
set -u
here=${0:A:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/light-limit-test.XXXXXX")
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
git -C "$work" checkout -q -b test/limit
print -r -- 'export const y = 2;' >> "$work/src/x.ts"
git -C "$work" commit -qam 'change'

# The fake bun: a bun that never returns, holding a child of its own. It is run by zsh, so no
# executable bit is needed; the check takes the command words from LIGHT_BUN.
mkdir -p "$tmp/bin" "$tmp/slots"
print -r -- '#!/bin/zsh' > "$tmp/fake-bun.zsh"
print -r -- 'sleep 60 &' >> "$tmp/fake-bun.zsh"
print -r -- 'echo $! > "$FAKE_BUN_PIDFILE"' >> "$tmp/fake-bun.zsh"
print -r -- 'wait' >> "$tmp/fake-bun.zsh"

cd "$work" || fail "cannot cd to the scratch worktree"
FAKE_BUN_PIDFILE=$tmp/sleep.pid LIGHT_BUN="zsh $tmp/fake-bun.zsh" \
LIGHT_SLOT_DIR=$tmp/slots LIGHT_CHECK_MAX_SECONDS=5 LIGHT_NO_HUB_SWEEP=1 \
  zsh "$here/light-check.sh" > "$tmp/check.out" 2>&1
code=$?
(( code != 0 )) || { cat "$tmp/check.out"; fail "the check exited 0 despite the limit"; }
grep -q 'TIMEOUT after 5 s: running typecheck' "$tmp/check.out" || { cat "$tmp/check.out"; fail "no TIMEOUT line naming the typecheck"; }
[[ -d $tmp/slots/light-slot-1.lock ]] && fail "the timed-out check kept its light slot"
sleeppid=$(cat "$tmp/sleep.pid" 2>/dev/null)
[[ $sleeppid == <-> ]] || { cat "$tmp/check.out"; fail "the fake bun never recorded its sleep child"; }
for _ in {1..20}; do kill -0 $sleeppid 2>/dev/null || break; sleep 0.5; done
kill -0 $sleeppid 2>/dev/null && fail "the fake bun's child $sleeppid outlived the limit"
ok "the limit kills the check's own tree, frees the slot and exits non-zero"

print -r -- "PASS: the light-check wall-clock limit"
