#!/system/bin/sh
# Undo the battery-optimization exemption fido-watch.sh adds for the QR bridge.
cmd deviceidle whitelist -com.fido.asm >/dev/null 2>&1
