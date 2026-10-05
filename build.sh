#!/bin/sh
# Builds hyperos-bitwarden-passkey-fix-ksu.zip: compiles hook.js and bundles frida-inject.
set -eu
cd "$(dirname "$0")"

FRIDA_VERSION=17.22.1
FRIDA_XZ_SHA256=9bf7ce67a77b43041f4be40a53f940018f78bd45a2b9e666f6558b7ceaa7da02
ZIP=hyperos-bitwarden-passkey-fix-ksu.zip
OUT=build/module

rm -rf "$OUT"
mkdir -p "$OUT/bin"

npm ci --no-audit --no-fund
./node_modules/.bin/frida-compile hook.js -o "$OUT/hook-bundle.js"

xz=build/frida-inject-$FRIDA_VERSION-android-arm64.xz
[ -f "$xz" ] || curl -fL -o "$xz" \
  "https://github.com/frida/frida/releases/download/$FRIDA_VERSION/frida-inject-$FRIDA_VERSION-android-arm64.xz"
echo "$FRIDA_XZ_SHA256  $xz" | sha256sum -c -
xz -dc "$xz" > "$OUT/bin/frida-inject"

cp module.prop provider.conf service.sh fido-watch.sh customize.sh uninstall.sh README.md "$OUT/"
rm -f "$ZIP"
(cd "$OUT" && zip -qr -9 -X "../../$ZIP" .)
echo "Built $ZIP"
