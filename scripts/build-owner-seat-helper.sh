#!/bin/sh
# Builds, signs, installs and self-tests the owner-seat helper. An agent runs it; the owner never
# types anything. The default build is ad-hoc signed and uses the enclave-blob backend: no
# identity, no entitlement, no dialog. Touch ID appears later, only when a key signs.
#
#   scripts/build-owner-seat-helper.sh [--dest DIR] [--list-identities]
#                                      [--identity SHA1 --team-id TEAMID [--profile FILE]]
#
# --dest DIR          install directory (default: $HOME/.config/team-owner-seat)
# --list-identities   prints `security find-identity -v -p codesigning` and exits
# --identity SHA1     signs with that Apple Development / Developer ID identity and the
#                     entitlements (keychain backend). codesign then asks macOS for the private
#                     key: the owner sees the keychain "codesign wants to sign using key…" dialog
#                     and clicks Allow (or Always Allow). With --profile, the helper is wrapped in
#                     a minimal .app bundle carrying the provisioning profile, which restricted
#                     entitlements need; without it the binary may be killed at launch, and the
#                     script falls back to the ad-hoc build.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/.config/team-owner-seat"
identity=""; team_id=""; profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) dest=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --team-id) team_id=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    --list-identities) security find-identity -v -p codesigning; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "macOS only" >&2; exit 1; }
work=$(mktemp -d /private/tmp/owner-seat-build.XXXXXX)
bin="$work/owner-seat-keystore"
swiftc -O "$here/helpers/owner-seat-keystore.swift" -o "$bin"
mkdir -p "$dest"; chmod 700 "$dest"
if [ -n "$identity" ]; then
  [ -n "$team_id" ] || { echo "--identity needs --team-id" >&2; exit 2; }
  ent="$work/entitlements.plist"
  sed "s/TEAMID/$team_id/g" "$here/helpers/owner-seat-keystore.entitlements" > "$ent"
  if [ -n "$profile" ]; then
    app="$work/OwnerSeatKeystore.app"
    mkdir -p "$app/Contents/MacOS"
    cp "$bin" "$app/Contents/MacOS/owner-seat-keystore"
    cp "$profile" "$app/Contents/embedded.provisionprofile"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.teamcli.owner-seat-keystore</string>
<key>CFBundleExecutable</key><string>owner-seat-keystore</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleName</key><string>OwnerSeatKeystore</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
    codesign --force --options runtime --timestamp=none --entitlements "$ent" --sign "$identity" "$app"
    [ -e "$dest/OwnerSeatKeystore.app" ] && /usr/bin/trash "$dest/OwnerSeatKeystore.app"
    cp -R "$app" "$dest/OwnerSeatKeystore.app"
    ln -sf "$dest/OwnerSeatKeystore.app/Contents/MacOS/owner-seat-keystore" "$dest/owner-seat-keystore.new"
  else
    codesign --force --options runtime --timestamp=none --entitlements "$ent" --sign "$identity" "$bin"
    cp "$bin" "$dest/owner-seat-keystore.new"
  fi
  if ! "$dest/owner-seat-keystore.new" selftest; then
    echo "the entitled build did not launch (a provisioning profile is likely missing); installing the ad-hoc build" >&2
    /usr/bin/trash "$dest/owner-seat-keystore.new"
    identity=""
  fi
fi
if [ -z "$identity" ]; then
  codesign --force --sign - "$bin"
  cp "$bin" "$dest/owner-seat-keystore.new"
fi
mv -f "$dest/owner-seat-keystore.new" "$dest/owner-seat-keystore"
/usr/bin/trash "$work"
"$dest/owner-seat-keystore" selftest
echo "installed: $dest/owner-seat-keystore"
