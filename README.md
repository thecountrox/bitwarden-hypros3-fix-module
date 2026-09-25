# HyperOS Bitwarden Credential Fix

A small KernelSU module for Chinese HyperOS builds that leave third-party credential providers out of Android's secure settings. It sets Bitwarden as the primary Credential Manager provider, adds it to the enabled-provider list without removing existing providers, and selects Bitwarden for password autofill.

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

The app must be installed and its APK must declare these services. The module registers the components in Android's settings; it cannot add missing services to the Bitwarden APK.

## Install

1. Install the latest Bitwarden Android app and sign in.
2. In KernelSU, install [`hyperos-bitwarden-passkey-fix-ksu.zip`](hyperos-bitwarden-passkey-fix-ksu.zip).
3. Reboot.

The module reapplies the settings at boot. It does not use Zygisk, LSPosed, or runtime code hooks.

## Verify

From ADB or a root shell:

```sh
settings get secure credential_service
settings get secure credential_service_primary
settings get secure autofill_service
```

The first value should include Bitwarden and retain prior enabled providers. The other two should be Bitwarden's components listed above.

## Scope

This fixes provider registration and selection. It does not include HyperPasskey's runtime chooser workaround, which hooks Android's credential flow and may still be needed if HyperOS continues showing or mishandling Xiaomi's chooser.

Related projects:

- [HyperPasskey LSPosed module](https://github.com/Xposed-Modules-Repo/io.github.howard20181.hyperpasskey)
- [HyperPasskey source repository](https://github.com/Howard20181/HyperPasskey)

## Device notes

Developed for CN HyperOS, including Dragon-X on the POCO X7 Pro (HyperOS 3 / Android 16). The boot script was checked with mocked Android settings on Windows; verify the three settings on your device after installing.
