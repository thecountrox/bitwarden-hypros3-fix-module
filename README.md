# HyperOS Bitwarden Credential Fix

A KernelSU module for Chinese HyperOS builds that keep Bitwarden out of passkey flows. It does two things:

1. **Provider settings.** Keeps Bitwarden as the primary Credential Manager provider, adds it to the enabled-provider list without removing existing providers, and selects Bitwarden for password autofill.
2. **QR sign-in bridge.** When you scan a passkey sign-in QR code (for example Windows Hello's "use a phone"), Xiaomi's FIDO app (`com.fido.asm`) only checks Xiaomi's own passkey store and falls back to a Xiaomi Account prompt. The bridge hands the sign-in request to Android Credential Manager instead, so Bitwarden can answer it, and sends Bitwarden's assertion back to the PC over Xiaomi's existing Bluetooth tunnel. Passkey registration is unchanged.

## What it sets

| Android secure setting | Value |
| --- | --- |
| `credential_service` | Bitwarden first, followed by providers already enabled |
| `credential_service_primary` | Bitwarden CredentialProviderService |
| `autofill_service` | Bitwarden AutofillService |

The component names come from Bitwarden's Android manifest:

```text
com.x8bit.bitwarden/com.x8bit.bitwarden.Autofill.CredentialProviderService
com.x8bit.bitwarden/com.x8bit.bitwarden.Autofill.AutofillService
```

Bitwarden's APK must declare these services. The module enables them in Android's settings; it cannot add a missing service to the APK.

While enabled, the module checks these settings every 10 seconds and restores Bitwarden if HyperOS clears or changes them. Existing enabled providers are preserved. It stops checking when the module is disabled or removed.

## QR sign-in bridge

The bridge is a small script ([`hook.js`](hook.js)) injected with Frida's standalone `frida-inject` into `com.fido.asm` only. There is no Zygisk, LSPosed, or system-wide hook; `fido-watch.sh` attaches to each new `com.fido.asm` process and the agent stays inside that process.

- **Locked vault.** Xiaomi's credential picker can't show Bitwarden's "Unlock" entry and closes instead. When Bitwarden only offers an unlock entry, the bridge opens Bitwarden, waits for you to unlock it, then brings the QR screen back and shows the picker.
- **Background network.** Android 15+ cuts a backgrounded app's sockets after a few seconds, which would drop the PC connection while you unlock Bitwarden. The module adds `com.fido.asm` to the battery-optimization allowlist (`cmd deviceidle whitelist`) and re-adds it every 30 seconds, because HyperOS's PowerKeeper rewrites the allowlist after boot; uninstalling removes it.
- **Xiaomi's loading dialog.** "Performing security verification…" covers the Bluetooth/tunnel handshake. The bridge closes it once it takes the request; otherwise Xiaomi's 30-second watchdog would cancel a sign-in that waits on an unlock.
- **No matching passkey.** The PC is told there are no credentials. If nothing answers within 90 seconds, the bridge reports the same.
- **Build check.** `hook.js` relies on obfuscated names in one `com.fido.asm` build. The watcher compares the APK's SHA-256 with the known build and stays off (logging `HYPROS_FIDO_MISMATCH`) on any other build.

Progress is logged to logcat under the `HyprosBitwarden` tag, using fixed markers only, never credential data:

```sh
adb logcat -s HyprosBitwarden
```

## Install

1. Install the latest Bitwarden Android app and sign in.
2. In KernelSU, install `hyperos-bitwarden-passkey-fix-ksu.zip` from the [latest release](https://github.com/thecountrox/bitwarden-hypros3-fix-module/releases/latest).
3. Reboot.

The module starts after boot completes. It does not use Zygisk or LSPosed.

## Build

```sh
./build.sh
```

Requires Node.js, `curl`, `xz`, and `zip`. The script compiles `hook.js` with `frida-compile`, downloads `frida-inject` 17.22.1 for arm64 and checks its SHA-256, and writes `hyperos-bitwarden-passkey-fix-ksu.zip`.

## Verify

From ADB or a root shell:

```sh
settings get secure credential_service
settings get secure credential_service_primary
settings get secure autofill_service
```

The first value should include Bitwarden and retain other enabled providers. The other two should be Bitwarden's components listed above. If HyperOS resets these settings while the module is enabled, they should be restored within about 10 seconds.

## Related projects

- [HyperPasskey](https://github.com/Howard20181/HyperPasskey) and [HyperPasskeyFix](https://github.com/Chenyu550/HyperPasskeyFix): LSPosed-based fixes for the same flows.

## Device notes

Developed for CN HyperOS, including Dragon-X on the POCO X7 Pro (HyperOS 3 / Android 16). Behavior may vary by ROM build; verify the three settings on your device after installing.

The QR bridge was tested on Redmi `rodin`, `OS3.0.304.0.WOJCNXM`, with `com.fido.asm` 220251222 and Bitwarden 2026.9.1.
