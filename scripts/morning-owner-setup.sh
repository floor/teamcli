#!/bin/sh
# The morning owner setup, run by an agent (Iris). The owner types nothing: the owner's acts are
# the native prompts this script triggers on the owner's own Mac.
#
#   1. build the owner-seat helper (ad-hoc; with --identity it is codesigned: macOS keychain "Allow")
#   2. build this branch and install it ALONGSIDE the global team, as $HOME/.local/bin/team-branch
#      (the global /opt/homebrew/bin/team is replaced only with --replace-global)
#   3. register the owner seat (Secure Enclave key; Touch ID confirms it)
#   4. set the entity's owner-signers and grant-emission policies
#   5. team grant --client grok-bot … --request (the grant to orchestrator@<team>)
#   6. the owner seat answers oui (Touch ID) and the script runs --execute
#
# Every step is skipped when already done, so the script can be re-run after a cancelled prompt.
#
#   scripts/morning-owner-setup.sh [--home DIR] [--owner-team floor] [--entity teamcli] [--team teamcli] [--seat orchestrator]
#        [--client grok-bot] [--signer mac] [--identity SHA1 --team-id TEAMID [--profile FILE]]
#        [--test-signer] [--dev-mode] [--replace-global] [--set-policies] [--dry-run]
#
# --set-policies  when the owner seat already exists, (re)writes owner-signers and grant-emission
#                 (one owner-device Touch ID each); a fresh setup folds them into its own Touch ID.
#
# --test-signer  TEST ONLY: installs test/fixtures/owner-seat/fake-keystore.mjs instead of the real
#                helper (software keys, prompts logged to prompts.log). Refused outside /private/tmp.
# --dev-mode     exports TEAMCLI_DEV_MODE=1 for the team calls. Refused outside /private/tmp.
# --dry-run      prints the steps and the owner dialogs they will raise; changes nothing.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
home=$HOME; owner_team=floor; entity=teamcli; team=teamcli; seat=orchestrator; client=grok-bot; signer=mac
identity=""; team_id=""; profile=""; test_signer=0; dev_mode=0; replace_global=0; dry=0; set_policies=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home) home=$2; shift 2 ;;
    --entity) entity=$2; shift 2 ;;
    --owner-team) owner_team=$2; shift 2 ;;
    --team) team=$2; shift 2 ;;
    --seat) seat=$2; shift 2 ;;
    --client) client=$2; shift 2 ;;
    --signer) signer=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --team-id) team_id=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    --test-signer) test_signer=1; shift ;;
    --dev-mode) dev_mode=1; shift ;;
    --replace-global) replace_global=1; shift ;;
    --dry-run) dry=1; shift ;;
    --set-policies) set_policies=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$home" in /private/tmp/*|/tmp/*) isolated=1 ;; *) isolated=0 ;; esac
if [ "$test_signer" = 1 ] || [ "$dev_mode" = 1 ]; then
  [ "$isolated" = 1 ] || { echo "--test-signer and --dev-mode are for an isolated home under /private/tmp only" >&2; exit 2; }
fi
export HOME="$home"
[ "$dev_mode" = 1 ] && export TEAMCLI_DEV_MODE=1
seatdir="$HOME/.config/team-owner-seat"
bindir="$HOME/.local/bin"
team_bin="$bindir/team-branch"
pub="$HOME/.config/team-client/$client/client.pub"
say() { printf '%s\n' "== $*"; }
owner() { printf '%s\n' "   OWNER: $*"; }

if [ "$dry" = 1 ]; then
  say "dry run for HOME=$HOME (owner seat owner@$owner_team, grant $client -> $seat@$team of entity $entity)"
  if [ -n "$identity" ]; then say "1 build + codesign helper"; owner "macOS dialog 'codesign wants to sign using key … in your keychain': click Allow (or Always Allow)";
  else say "1 build helper (ad-hoc, no dialog)"; fi
  say "2 build branch, install $team_bin"; [ "$replace_global" = 1 ] && owner "none (but /opt/homebrew/bin/team is replaced: only with your prior OK)"
  say "3+4 owner seat '$signer' (owner@$owner_team) with entity $entity policies owner-signers=$signer, grant-emission=conversational"
  owner "Touch ID: 'Create the TeamCLI owner seat for $owner_team and set owner-signers=$signer, grant-emission=conversational for entities $entity, $owner_team'"
  say "5 grant request $client -> $seat@$team"
  say "6 owner seat answers oui"; owner "Touch ID: 'TeamCLI: once for … ${client} …'"
  say "7 grant --execute"
  exit 0
fi

say "1 owner-seat helper"
if [ "$test_signer" = 1 ]; then
  mkdir -p "$seatdir"
  cp "$repo/test/fixtures/owner-seat/fake-keystore.mjs" "$seatdir/owner-seat-keystore"
  chmod 700 "$seatdir/owner-seat-keystore"
  "$seatdir/owner-seat-keystore" selftest
elif [ -x "$seatdir/owner-seat-keystore" ] && "$seatdir/owner-seat-keystore" selftest >/dev/null 2>&1; then
  echo "helper already installed and self-tested"
else
  set -- --dest "$seatdir"
  [ -n "$identity" ] && set -- "$@" --identity "$identity" --team-id "$team_id"
  [ -n "$profile" ] && set -- "$@" --profile "$profile"
  "$repo/scripts/build-owner-seat-helper.sh" "$@"
fi

say "2 branch build"
sha=$(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet HEAD -- src package.json || echo -dirty-$(date +%s))
dest="$seatdir/teamcli-$sha"
if [ ! -f "$dest/dist/cli.js" ]; then
  (cd "$repo" && bun run build >/dev/null)
  mkdir -p "$dest"
  cp -R "$repo/dist" "$dest/dist"
  cp "$repo/package.json" "$dest/package.json"
  [ -d "$dest/node_modules" ] || ln -s "$repo/node_modules" "$dest/node_modules"
fi
mkdir -p "$bindir"
printf '#!/bin/sh\nexec node "%s/dist/cli.js" "$@"\n' "$dest" > "$team_bin.new"
chmod 755 "$team_bin.new"; mv -f "$team_bin.new" "$team_bin"
if [ "$replace_global" = 1 ]; then
  [ "$isolated" = 0 ] || { echo "--replace-global is refused for an isolated home" >&2; exit 2; }
  ln -sf "$team_bin" /opt/homebrew/bin/team
fi
echo "installed $team_bin ($sha)"
T() { "$team_bin" "$@"; }

say "3+4 owner seat and entity policies (one Touch ID)"
if T owner-seat status | grep -q '^owner seat: owner@'; then
  echo "owner seat already registered"
  if [ "$set_policies" = 1 ]; then
    # one owner-device Touch ID per policy write
    T policy set entity owner-signers "$signer" --entity "$entity"
    T policy set entity grant-emission conversational --entity "$entity"
  fi
else
  T owner-seat setup --team "$owner_team" --signer "$signer" --policy-entity "$entity,$owner_team" --owner-signers "$signer" --grant-emission conversational
fi

say "5 grant request"
[ -f "$pub" ] || T client keygen --out "$(dirname "$pub")" >/dev/null
out=$(T grant --client "$client" --entity "$entity" --public-key "$pub" --team "$team" --seat "$seat" --inbox --request --json)
echo "$out"
id=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.request_id||j.target||"")})')
case "$id" in
  cg_*) echo "already granted by a standing rule: $id"; exit 0 ;;
  "") echo "no request id" >&2; exit 1 ;;
esac

say "6 owner answer (Touch ID)"
T grant --approve-as-owner-seat "$id" oui

say "7 execute"
T grant --execute "$id"
T owner-seat status
