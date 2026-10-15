# Android frame app

Hearth's Android app is a small native WebView wrapper for the separately
hosted dashboard. It is not firmware and does not contain the calendar, photo
library, or other server data. The tested target is the PF1007 running Android
6 (API 23); other models and firmware need their own verification.

For the full, step-by-step process—including server setup, USB ADB checks,
private backups, SDK setup, APK signing and installation, Home selection,
brightness/return controls, optional Wi-Fi ADB, and recovery—follow
[PF1007 frame setup](../docs/FRAME_SETUP.md). For account connections and
Raspberry Pi deployment, see [server setup](../docs/SETUP.md).

## Build

The local build script requires JDK 17, Android SDK Platform 23, and Build
Tools 36.0.0. It defaults to `http://hearth.local:8787`; replace that URL with
the exact reachable server origin, and add the same host to
`HEARTH_ALLOWED_HOSTS` in the Compose environment. The URL accepts only an
HTTP(S) origin with a hostname or IPv4 address and optional port. It cannot
include credentials, a path, query, or fragment.

```sh
export DASHBOARD_URL=http://hearth.local:8787
./android/build.sh
```

The script signs with an existing standard local debug keystore at
`~/.android/debug.keystore`. If absent, it emits an unsigned APK, which Android
cannot install as-is. Create a local development key using the instructions in
the [frame guide](../docs/FRAME_SETUP.md#checkpoint-4-build-a-signed-hearth-apk),
then rebuild. APKs, build output, and keystores must stay out of Git.

The app is eligible to be selected as the Android Home app, but installation
does not set it as default and Hearth cold-boot startup has not been verified.
The overlay return control needs Android's Display over other apps permission.
WebView remote debugging is off during normal launches. For a deliberate
diagnostic session only, start the activity with the boolean `debug` intent
extra set to `true`; restart without that extra to disable debugging again.
