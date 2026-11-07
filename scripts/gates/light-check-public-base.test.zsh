#!/bin/zsh
# The integration merge-base still selects tests, but the private scan must cover public
# history through HEAD. Run the real light check on a synthetic integration-based branch,
# with a local origin, isolated slots and HOME, real Bun/typecheck, and synthetic lists only.
# Run: zsh scripts/gates/light-check-public-base.test.zsh
set -eu
here=${0:A:h}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/light-public-base.XXXXXX")
trap '/usr/bin/trash "$tmp" 2>/dev/null' EXIT
fail() {
  print -r -- "FAIL: $*"
  [[ ! -f $tmp/check.out ]] || grep -E '^(light-check:|private-diff:check:)' "$tmp/check.out" || true
  exit 1
}
work=$tmp/work
mkdir -p "$work" "$tmp/home" "$tmp/slots"
git init -q -b main "$work"
git -C "$work" config user.name Synthetic
git -C "$work" config user.email synthetic@example.test
git -C "$work" config commit.gpgsign false
print -r -- 'node_modules'$'\n''scripts/' > "$work/.gitignore"
print -r -- '{"scripts":{"typecheck":"tsc --noEmit --skipLibCheck --types bun fixture.ts"}}' > "$work/package.json"
print -r -- 'export const fixture = true;' > "$work/fixture.ts"
git -C "$work" add -A
git -C "$work" commit -qm $'test: seed synthetic public history\n\nAgent: Claude Opus 5.5 · implementer'
public=$(git -C "$work" rev-parse HEAD)
git -C "$work" update-ref refs/remotes/origin/main "$public"
# Fetching main from this fixture itself is offline and preserves the original main branch.
git -C "$work" remote add origin "$work"
git -C "$work" checkout -qb integration/fixture
needle=qwrtz-diff-secret
print -r -- "$needle" > "$work/integration.txt"
git -C "$work" add integration.txt
git -C "$work" commit -qm $'test: add synthetic integration content\n\nAgent: Claude Opus 5.5 · implementer'
integration=$(git -C "$work" rev-parse HEAD)
git -C "$work" checkout -qb feature/fixture
print -r -- 'clean branch change' > "$work/feature.md"
git -C "$work" add feature.md
git -C "$work" commit -qm $'test: add synthetic branch content\n\nAgent: Claude Opus 5.5 · implementer'
mkdir -p "$work/scripts"
ln -s "$here/../check-private-diff.ts" "$work/scripts/check-private-diff.ts"
ln -s "$here/../../node_modules" "$work/node_modules"
# All list values here are synthetic; never consult the machine's external lists.
(umask 077; print -r -- "$needle" > "$tmp/names.txt"; print -r -- 'unrelated-synthetic-phrase' > "$tmp/phrases.txt")
cd "$work"
if env HOME="$tmp/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  GATE_INTEGRATION=integration/fixture GATE_PRIVATE_NAMES="$tmp/names.txt" \
  GATE_PRIVATE_PHRASES="$tmp/phrases.txt" LIGHT_SLOT_DIR="$tmp/slots" \
  LIGHT_NO_HUB_SWEEP=1 LIGHT_CHECK_MAX_SECONDS=60 \
  zsh "$here/light-check.sh" > "$tmp/check.out" 2>&1; then
  code=0
else
  code=$?
fi
(( code == 0 )) || fail "light check returned $code; output in $tmp/check.out"
grep -Fq "1 changed files vs $integration" "$tmp/check.out" || fail 'test selection lost its integration merge-base'
grep -Fq 'integration.txt:1: it matches private names entry 1' "$tmp/check.out" || fail 'private scan did not cover the integration content since the public base'
grep -Fq 'private scan vs origin/main..HEAD' "$tmp/check.out" || fail 'public scan range was not reported'
! grep -Fq 'base must be origin/main' "$tmp/check.out" || fail 'private scan received an arbitrary commit base'
! grep -Fq "$needle" "$tmp/check.out" || fail 'a synthetic matched value was printed'
[[ -z $(find "$tmp/slots" -mindepth 1 -print -quit) ]] || fail 'light check retained its fixture slot'
print -r -- 'PASS: integration merge-base selects one changed file; public private-scan range catches the earlier integration hit; real fixture typecheck passes'
