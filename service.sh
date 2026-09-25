#!/system/bin/sh
MODDIR=${0%/*}
CONF="$MODDIR/provider.conf"
[ -r "$CONF" ] || exit 0
. "$CONF"

case "$PROVIDER:$AUTOFILL_PROVIDER" in
    *[!A-Za-z0-9._/$:]*|:*|*:) log -t HyperOSPasskeyFix "Invalid provider component; edit provider.conf"; exit 0 ;;
esac

CURRENT=$(settings get secure credential_service) || exit 1

case "$CURRENT" in
    null|None|none) CURRENT='' ;;
esac
case ":$CURRENT:" in
    *":$PROVIDER:"*) ;;
    *) CURRENT="$PROVIDER${CURRENT:+:$CURRENT}" ;;
esac

settings put secure credential_service "$CURRENT" || exit 1
settings put secure credential_service_primary "$PROVIDER" || exit 1
settings put secure autofill_service "$AUTOFILL_PROVIDER" || exit 1
log -t HyperOSPasskeyFix "Set Bitwarden as primary credential provider and autofill service"
