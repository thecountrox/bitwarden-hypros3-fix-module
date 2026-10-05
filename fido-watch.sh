#!/system/bin/sh
# Injects the QR sign-in bridge (hook-bundle.js) into each new com.fido.asm process.
# Only that process is touched; nothing else is hooked.
MODDIR=${0%/*}
INJECT=$MODDIR/bin/frida-inject
SCRIPT=$MODDIR/hook-bundle.js
TAG=HyprosBitwarden
FIDO_PACKAGE=com.fido.asm
# hook.js depends on this build's obfuscated class and field names.
FIDO_APK_SHA256=60b639ed8fd5c69a4c48eb4571416cf0caa654369102787af3638587b73be71c

apk=$(pm path "$FIDO_PACKAGE" 2>/dev/null | head -n 1)
apk=${apk#package:}
hash=$(sha256sum "$apk" 2>/dev/null)
hash=${hash%% *}
if [ "$hash" != "$FIDO_APK_SHA256" ]; then
  log -t "$TAG" "HYPROS_FIDO_MISMATCH: unknown $FIDO_PACKAGE build; QR bridge disabled"
  exit 0
fi

# Android 15+ destroys a backgrounded app's sockets after a few seconds. The QR session must
# survive the switch to Bitwarden when the vault needs unlocking. HyperOS's PowerKeeper rewrites
# the allowlist after boot, so keep re-adding the entry rather than setting it once.
allow_background_network() {
  cmd deviceidle whitelist +"$FIDO_PACKAGE" >/dev/null 2>&1
}

last=
ticks=60 # apply on the first pass
while [ -d "$MODDIR" ] && [ ! -e "$MODDIR/disable" ]; do
  ticks=$((ticks + 1))
  if [ "$ticks" -ge 60 ]; then
    ticks=0
    allow_background_network
  fi
  pid=$(pidof "$FIDO_PACKAGE")
  if [ -n "$pid" ] && [ "$pid" != "$last" ]; then
    last=$pid
    allow_background_network
    if "$INJECT" -p "$pid" -s "$SCRIPT" -e </dev/null >/dev/null 2>&1; then
      log -t "$TAG" "HYPROS_INJECTED:$pid"
    else
      log -t "$TAG" "HYPROS_INJECT_FAILED:$pid"
    fi
  fi
  sleep 0.5
done
