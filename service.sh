#!/system/bin/sh
MODDIR=${0%/*}
CONF="$MODDIR/provider.conf"
[ -r "$CONF" ] || exit 0
. "$CONF"

case "$PROVIDER:$AUTOFILL_PROVIDER" in
    *[!A-Za-z0-9._/$:]*|:*|*:) log -t HyperOSPasskeyFix "Invalid provider component; edit provider.conf"; exit 0 ;;
esac

PACKAGE=${PROVIDER%%/*}

ensure_settings() {
    pm path "$PACKAGE" >/dev/null 2>&1 || return 0

    changed=0
    current=$(settings get secure credential_service 2>/dev/null) || return 1
    case "$current" in null|None|none) current='' ;; esac
    case ":$current:" in
        *":$PROVIDER:"*) ;;
        *) current="$PROVIDER${current:+:$current}"; settings put secure credential_service "$current" || return 1; changed=1 ;;
    esac

    primary=$(settings get secure credential_service_primary 2>/dev/null) || return 1
    if [ "$primary" != "$PROVIDER" ]; then
        settings put secure credential_service_primary "$PROVIDER" || return 1
        changed=1
    fi

    autofill=$(settings get secure autofill_service 2>/dev/null) || return 1
    if [ "$autofill" != "$AUTOFILL_PROVIDER" ]; then
        settings put secure autofill_service "$AUTOFILL_PROVIDER" || return 1
        changed=1
    fi

    [ "$changed" = 0 ] || log -t HyperOSPasskeyFix "Restored Bitwarden credential provider and autofill settings"
}

while [ -d "$MODDIR" ] && [ ! -e "$MODDIR/disable" ]; do
    if [ "$(getprop sys.boot_completed)" = 1 ]; then
        ensure_settings
    fi
    # ponytail: small sleep-based check avoids an Android helper or brittle settings-file watcher.
    sleep 10
done
