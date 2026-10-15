# PF1007 frame setup and recovery

This guide covers the tested Android route for the AiMOR PF1007 photo frame and
the Hearth dashboard. It is intended for a careful human operator or an AI
agent following explicit steps. Commands are labeled by where to run them.

Replace every `<PLACEHOLDER>` (including the angle brackets) with a value you
just discovered. Do not paste placeholder text literally; `<` and `>` are
special shell characters.

## Read this first

- The recommended setup keeps the frame's original Android and AiMOR software.
  Hearth is an Android app that displays a web page served by a separate
  computer or Raspberry Pi.
- **No SD card is needed** for this Android setup. Do not write an operating
  system image or erase a card as part of these steps.
- Stock USB ADB access was obtained on this particular frame through a working
  USB data cable. No password was guessed and no exploit was used. This result
  is specific to the observed device and firmware; do not assume another frame
  exposes root ADB.
- The tested model reports `PF1007`, Allwinner A33, Android 6, and AiMOR. Treat
  these as clues for identifying this unit, not a promise that another unit has
  identical partitions, signatures, WebView libraries, or behavior.
- **Stop before any command that writes `/system`, boot/recovery partitions,
  or raw block devices.** The WebView replacement is a high-risk,
  firmware-specific system change and has no universal safe install command.
- This procedure is not a Linux installation guide. A separate Linux SD-card
  experiment was done; it is not the recommended Hearth setup.

## What runs where

| Part | Runs on | Purpose |
|---|---|---|
| Hearth server | Raspberry Pi or another trusted home host | Calendar, photos, weather, Spotify and school data APIs; serves the web page |
| Hearth Android APK | PF1007 frame | Full-screen WebView wrapper, native brightness control, return controls |
| Setup tools | Mac or Linux computer | Build/sign APK, connect ADB, and save private backups |

The frame and server must be on the same trusted home network, or be able to
reach each other through a private network you operate. Do not expose the
Hearth server or ADB port to the public Internet. The Hearth API has no user
login. Start with [the server guide](SETUP.md), then return here.

## Checkpoint 1: identify the frame and prepare the computer

### On the frame

Open the AiMOR device information/about screen and note the model and Android
version. On the unit used for this guide, those values were `PF1007` and
Android 6. Do not publish the frame's serial number, MAC address, or Frame ID.

### On the setup computer (Mac example)

Use a known-good USB **data** cable. A cable can power the frame without
carrying data. The observed setup used a USB-A-to-USB-C data cable from the Mac
to the frame's single USB-C port. Connect directly to the computer if possible;
avoid an unpowered hub while diagnosing.

Install Android Platform Tools if `adb` is not already available:

```sh
brew install android-platform-tools
adb version
```

On another operating system, install Platform Tools only from Google's
[Android developer site](https://developer.android.com/tools/releases/platform-tools).
Do not download ADB from third-party driver sites. Platform Tools are separate
from Android Studio and do not require a Google USB driver on macOS.

Install Android Studio if needed, open **Settings/Preferences → Languages &
Frameworks → Android SDK → SDK Tools**, and install **Android SDK Command-line
Tools** and **Android SDK Platform-Tools**. Under **SDK Platforms**, install
**Android 6.0 (Marshmallow), API 23**. Under **SDK Tools → Show Package
Details**, install **Android SDK Build-Tools 36.0.0**. The repository build
script's default Mac SDK path is `/opt/homebrew/share/android-commandlinetools`;
if your SDK lives elsewhere, set `ANDROID_HOME` as described in the build
section below. Install JDK 17 from <https://adoptium.net/temurin/releases/?version=17>.
On Mac, select it in this Terminal session and check the version:

```sh
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export PATH="$JAVA_HOME/bin:$PATH"
java -version
javac -version
```

If Android Studio used its default Mac SDK path, set it in this Terminal too:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

If the SDK is elsewhere, set `ANDROID_HOME` to that exact path.

## Checkpoint 2: check USB ADB without changing the device

First connect the cable, leave the frame powered on, then on the setup computer
run:

```sh
adb devices -l
```

Possible results:

- **A serial number followed by `device`:** USB ADB is available. Record the
  serial privately and use `-s <USB_SERIAL>` in every later ADB command. Continue
  to the read-only identity check.
- **`unauthorized`:** unlock the frame and accept the debugging prompt if one
  appears. Rerun `adb devices -l`. Do not accept a prompt on a computer you do
  not control.
- **Empty list:** try another known data-capable cable and a direct USB port,
  then run `adb kill-server` followed by `adb start-server` and check again.
  Also check whether the frame exposes a USB debugging setting. If it still
  stays empty, stop: this guide does not enable ADB through a hidden code or
  bypass a password.
- **`offline`:** unplug/reconnect the cable, restart the ADB server, and check
  once more. Do not proceed until the device shows `device`.

Use this read-only identity command, replacing the placeholder with the exact
serial from `adb devices -l`:

```sh
adb -s <USB_SERIAL> shell 'id; getprop ro.serialno; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.adb.secure'
```

The observed unit returned `uid=0(root)`, model `PF1007`, Android `6`, API
`23`, and `ro.adb.secure=0`. These are observations, not values to force onto
another device. If the output is not root, stop before backup or installation
steps that require root. Do not try passwords, bootloader exploits, or unknown
“ADB enabler” APKs.

## Checkpoint 3: make and verify private read-only backups

Do this before installing an APK or changing Android settings. Backups may
contain photos, account data, Wi-Fi details, and personal identifiers. Save
them on an encrypted disk in a private folder, outside the Git checkout. Never
upload or publish them.

### Inspect storage before copying

On the setup computer, make a private destination and confirm available space:

```sh
umask 077
mkdir -p "$HOME/frame-backups/pf1007"
chmod 700 "$HOME/frame-backups" "$HOME/frame-backups/pf1007"
df -h "$HOME/frame-backups/pf1007"
```

On the frame, list block devices and named partitions. These are read-only
commands:

```sh
adb -s <USB_SERIAL> shell 'cat /proc/partitions; ls -l /dev/block/by-name 2>/dev/null; ls -l /dev/block/platform/*/by-name 2>/dev/null'
```

The `by-name` links help identify labels such as `boot`, `recovery`, and
`system`. Verify each link target and its byte size before copying anything.
Do not assume the eMMC device is named `mmcblk0`, do not copy a partition map
from another frame, and do not run `dd` with an unverified input path. If you
cannot confidently map the device, stop and get a device-specific review.

### Copy selected partitions (read-only source)

For a partition whose path and size you have just verified, ask Android for
its exact size in bytes:

```sh
adb -s <USB_SERIAL> shell blockdev --getsize64 <VERIFIED_DEVICE_PARTITION>
```

If `blockdev` is unavailable, resolve the device link and read its sector count
from sysfs. Multiply the count by 512 to get bytes:

```sh
adb -s <USB_SERIAL> shell readlink -f <VERIFIED_DEVICE_PARTITION>
adb -s <USB_SERIAL> shell cat /sys/class/block/<RESOLVED_DEVICE_NAME>/size
```

Record the source path and expected byte size in your private manifest. Save
the bytes to the setup computer with `adb exec-out`. Replace the partition
placeholder and local filename. `dd` has an input (`if=`) only; never add an
`of=` argument:

```sh
adb -s <USB_SERIAL> exec-out 'dd if=<VERIFIED_DEVICE_PARTITION> bs=4M 2>/dev/null' > "$HOME/frame-backups/pf1007/<PARTITION_NAME>.img"
```

Check the exit status immediately (`echo $?` should print `0`), but do not rely
on the exit code alone: older ADB transports may not report a remote `dd`
failure correctly. Compare the local file size with the exact partition size
you read from the device; any mismatch means the capture is invalid:

```sh
wc -c < "$HOME/frame-backups/pf1007/<PARTITION_NAME>.img"
```

Record a local SHA-256 hash:

```sh
shasum -a 256 "$HOME/frame-backups/pf1007/<PARTITION_NAME>.img"
```

For stronger readback verification, capture the same partition a second time
to a separate file and compare the captures byte for byte:

```sh
adb -s <USB_SERIAL> exec-out 'dd if=<VERIFIED_DEVICE_PARTITION> bs=4M 2>/dev/null' > "$HOME/frame-backups/pf1007/<PARTITION_NAME>-second.img"
cmp "$HOME/frame-backups/pf1007/<PARTITION_NAME>.img" "$HOME/frame-backups/pf1007/<PARTITION_NAME>-second.img"
```

`cmp` prints nothing and exits `0` if the files match. This reads the device
twice; it does not prove that a live `userdata` filesystem was a consistent snapshot.
Keep the device powered and do not install or update apps during a capture.

The historical backup of this specific frame included the full eMMC user area
and independent captures of boot, recovery, system, boot0, and boot1. The
partition ranges were compared with the full capture. Its live userdata capture
was not an offline-consistent snapshot, and RPMB was not captured. This history
does not provide a generic command for discovering a safe full-device length;
never copy a guessed device size or run a write command against these paths.
Keep a manifest with device model/build, verified source path, expected and
actual size, hash, date, and whether the partition was live. Do not put the
manifest or backup files in this public repository if they reveal identifiers.

## Checkpoint 4: build a signed Hearth APK

Build on the setup computer, in a local clone of this repository. The script
uses Android API 23, Build Tools 36.0.0, and Java 17. A supported `DASHBOARD_URL`
is one HTTP(S) origin with a hostname or IPv4 address and optional port; do not
add a path, username, query, or fragment.

First confirm the Pi is running Hearth and find its stable LAN name/address.
Use the same exact value in the APK URL and `HEARTH_ALLOWED_HOSTS` on the
server. Example only:

```sh
export DASHBOARD_URL=http://hearth.local:8787
./android/build.sh
```

On macOS, if the SDK is not at the script's default path, set its actual path:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export DASHBOARD_URL=http://hearth.local:8787
./android/build.sh
```

Set `BUILD_TOOLS` or `PLATFORM` only if your SDK stores those versions outside
the default directories. The script prints the generated APK path. If it says
`hearth-unsigned.apk`, that APK is not ready to install. Sign it by arranging
for the script to use a local debug keystore; it does not make a release
keystore for you.

Check whether the standard debug keystore already exists. Do not overwrite an
existing key because it may be needed to update an APK signed earlier:

```sh
ls -l "$HOME/.android/debug.keystore"
```

Only if it is missing, create it on the setup computer outside the repository.
This is a development-only key, not a production signing identity:

```sh
mkdir -p "$HOME/.android"
keytool -genkeypair -v -keystore "$HOME/.android/debug.keystore" \
  -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"
```

The build script uses the standard Android debug keystore passwords when it
signs. Keep that keystore local and out of Git. Then rerun the build and confirm
the output is `android/build/hearth.apk`, not `hearth-unsigned.apk`. Verify its
signature using the SDK Build Tools:

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose android/build/hearth.apk
```

If the frame already has an app signed with a different key and Android rejects
an update, do not uninstall blindly: app data and the current Home selection
may be lost. Check package identity and backup status first. The repository
build output is ignored by Git; do not commit APKs or signing keys.

## Checkpoint 5: install Hearth over USB

Keep the USB cable attached. On the setup computer, confirm the selected serial
is still present, then install the signed APK:

```sh
adb devices -l
adb -s <USB_SERIAL> install -r android/build/hearth.apk
```

Expected result is `Success`. If Android reports a signature mismatch, stop and
inspect the existing package before removing anything. If it says the APK is
unsigned or invalid, return to the build step. If it reports insufficient
storage, check free space on the frame; do not delete app data as a shortcut.

The installed app's package is `com.enderekici.hearth`. To launch it from the
setup computer:

```sh
adb -s <USB_SERIAL> shell am start -n com.enderekici.hearth/.MainActivity
```

The screen should show the Hearth dashboard from the Pi. If it shows an offline
message, confirm that the frame can reach the host URL in the browser, the Pi
service is running, the APK's URL is correct, and `HEARTH_ALLOWED_HOSTS`
contains the exact hostname. A hostname must also resolve to the Pi on the
frame's network.

If the screen is in AiMOR or another Home app and USB ADB still works, launch
Hearth directly from the setup computer with the same `am start` command above.
This is a recovery shortcut, not proof that Hearth is the selected Home app.

## Return controls, settings, and brightness

Hearth opens full-screen. To reveal its native controls, put **two fingers** on
the dashboard, hold for about **1.5 seconds**, and make a slight movement while
keeping them down. The gesture is checked on a subsequent touch-move event and
rejects movement of about 24 screen pixels or more, so a perfectly motionless
hold may not trigger it. The native panel contains **Dashboard**, **Android
Settings**, and **AiMOR** controls plus a brightness slider. Brightness is saved
by Hearth on this device.

To return from Android Settings or AiMOR, the floating return control requires
Android's **Display over other apps** permission. If Android asks, allow
**Hearth**. If it was dismissed, open the two-finger panel, open Android
Settings, find the special app access / display-over-other-apps screen, and
allow Hearth. Menu wording varies by firmware. The app's overlay offers a
button to return to the dashboard. If the vendor firmware removes the overlay
or does not show the permission screen, use the frame's physical/power controls
to recover and stop; do not reset the frame.

The app is registered as an eligible Android Home app, but installing it does
not select it as the default. Hearth cold-boot startup has **not been verified**.
The earlier reboot test applied to the separate `com.wesbos.homehq` app and
does not prove Hearth starts after reboot.

To choose Hearth as Home, open Android's Home chooser (usually Home button, or
**Settings → Apps → Default apps → Home app**), select **Hearth**, and choose
**Always** only if you want it to be the default. Android 6 vendor menus differ;
if the chooser is unavailable, stop rather than running a guessed package
manager command. Keep another launcher available. To switch back, open the same
Home app setting/chooser and select AiMOR or the previous launcher. After
choosing, manually test the Home button and a controlled reboot while USB ADB
is still available; record the result. Do not describe cold-boot autostart as
confirmed until the dashboard is actually observed after reboot.

## Optional: Wi-Fi ADB for a wall-mounted frame

**Security warning:** on the tested Android 6 firmware, Wi-Fi ADB on port 5555
grants unauthenticated root to devices that can reach the frame. This is full
control of the frame. Leave USB connected as a recovery path while enabling
Wi-Fi ADB, use only a trusted private home Wi-Fi network, never forward port
5555 from the router, and disable Wi-Fi ADB when finished. Do not do this on
guest/public Wi-Fi.

### Enable it while USB works

On the setup computer, replace `<USB_SERIAL>` with the serial shown by
`adb devices -l`:

```sh
adb -s <USB_SERIAL> shell setprop persist.adb.tcp.port 5555
adb -s <USB_SERIAL> tcpip 5555
```

Find the frame's current LAN IP in the router's connected-device list or the
frame's network settings. Do not rely on an old address: the tested Wi-Fi
driver changed its MAC and DHCP address after reboot. Then connect and verify
root before unplugging USB:

```sh
adb connect <FRAME_LAN_IP>:5555
adb -s <FRAME_LAN_IP>:5555 shell 'id; getprop ro.serialno'
```

Expected result includes `uid=0(root)`. Compare the returned serial privately
with `ro.serialno` from the USB identity check; do not trust the IP until both
serial and root identity match. Reboot while USB is still connected only if
necessary, then rediscover the current IP and verify again. After confirming
Wi-Fi access, disconnect USB and power the frame from its normal wall supply.
Reconnect over Wi-Fi and compare serial and root identity again. Keep device
identity private.

### Disable it and recover

If the Wi-Fi address changes, the frame is unreachable, or ADB stops responding,
reconnect USB and use the USB serial. USB recovery is why it stays connected
until the Wi-Fi path has been proven.

To turn off the persistent TCP setting, reconnect over Wi-Fi and run:

```sh
adb -s <FRAME_LAN_IP>:5555 shell 'setprop persist.adb.tcp.port ""'
adb -s <FRAME_LAN_IP>:5555 usb
```

The Wi-Fi connection will close. If the first command is sent over USB, select
`-s <USB_SERIAL>` for the `setprop` command, then run `adb -s <USB_SERIAL> usb`.
Confirm `adb devices -l` shows the USB transport and port 5555 is no longer
reachable from the home network. These rollback commands are documented from
the historical setup; their execution is not verified on other units. If you
cannot verify device identity, stop and use USB rather than an old IP.

## WebView updates: advanced and high risk

Hearth uses Android's installed WebView provider. A newer WebView may be needed
if the existing provider cannot render required browser features, but updating
it is a system maintenance task, not a normal Hearth install step. The tested
Android 6 frame rejected a normal provider APK update because its signing key
did not match the vendor package. The stock provider observed on this frame
was version `44.0.2403.119`; the later provider used in that historical trial
was `106.0.5249.126`. A historical, device-specific replacement used a pinned
ARM WebView package, copied three native libraries, preserved the original APK
and compiled `oat` directory, checked file hashes, and restored `/system` to
read-only. It was tested on one unit only; these version numbers are not a
recommendation or assurance for other frames.

To inspect a frame without changing it, list installed provider packages and
check the version of a package returned by the first command:

```sh
adb -s <USB_SERIAL> shell pm list packages | grep -E 'webview|chrome'
adb -s <USB_SERIAL> shell dumpsys package <VERIFIED_WEBVIEW_PACKAGE> | grep versionName
```

The vendor package name can differ. Use the installed package found above;
do not assume `com.google.android.webview` is present.

Before considering a provider change, an experienced Android maintainer must
confirm all of the following for the exact frame and firmware: a complete,
verified rollback capture; provider package name and version; signer and
Android-6 compatibility; CPU ABI for every native library; required library
layout; SELinux labels and file modes; partition free space; and a tested
recovery route. Preserve the original APK, libraries, and compiled artifacts.
Do not remount `/system` writable, copy files, delete `oat`, or reboot based on
instructions for a different model. If any prerequisite is unknown, leave the
stock WebView in place. Hearth's Android source and this guide do not ship a
WebView replacement payload.

## Troubleshooting and stop conditions

| Symptom | Check | Stop when |
|---|---|---|
| `adb devices` is empty | Data cable, direct port, ADB server, frame debugging setting | Still empty after another verified data cable; no hidden-enabler workaround |
| Device is `unauthorized` | Unlock and accept only your own computer's prompt | No prompt or access is not yours to grant |
| Frame does not show Hearth | Server health, URL, DNS, exact allowed host | URL/host cannot be confirmed |
| APK install has signature error | Existing package identity and signing key; preserve its data | You cannot determine what package would be replaced |
| Overlay return button is missing | Grant Display over other apps permission; reopen app | Vendor menu differs or device becomes inaccessible |
| Frame boots to AiMOR | Hearth may not be the selected Home app | Do not reset; use Android Home chooser or USB recovery |
| Wi-Fi ADB cannot reconnect | Current router lease/IP; reconnect USB | Never guess a stale IP or expose port 5555 externally |
| Proposed fix writes a partition | Obtain a matching verified image and device-specific review | Do not execute generic raw-write steps |

## AI-agent execution contract

An AI agent following this guide should:

1. State which machine each command runs on, preserve placeholders until values
   have been discovered, and never print credentials or serial/MAC/IP details
   into a public log.
2. Run only read-only identity and storage discovery before backups. Verify
   source paths, expected sizes, output sizes, and hashes before claiming a
   backup exists.
3. Keep raw captures, keystores, and private manifests outside the repository.
   Generated APKs may stay in the ignored `android/build/` directory or a
   private output folder; never add them to Git. Never upload the captures or
   include their contents in a report.
4. Use a signed APK and the exact selected ADB serial for install operations.
   Do not uninstall an existing app or alter Android Home settings without an
   explicit operator request.
5. Stop before writes to system/boot/recovery/raw storage, credential changes,
   factory reset, firmware flashing, or a network ADB change that the operator
   has not explicitly authorized.
6. Report observed outputs and distinguish verified behavior from historical
   notes. Installation does not prove overlay permission, default Home, or
   cold-boot startup; each needs an on-device check.

## Setup acceptance check

Mark each item only after observing it:

- [ ] Server health endpoint returns JSON and the dashboard opens from the frame's network.
- [ ] Apple Calendar shows the selected calendars and a recognized event.
- [ ] Photos from the Pi's selected folders appear in the slideshow.
- [ ] Weather shows the selected place and opens its detailed forecast.
- [ ] Day/night choice and palette persist after reopening Settings.
- [ ] Spotify library loads and **Find speakers** lists the intended Connect device.
- [ ] Two-finger controls open; brightness changes; Android Settings/AiMOR return works if overlay permission was granted.
- [ ] If Home default was changed, verify the Home button and a real reboot separately; record Hearth startup as unverified until seen.

## Short glossary

| Term | Meaning |
|---|---|
| ADB | Android Debug Bridge, the computer tool used to inspect/install apps on the frame. |
| USB serial | Device identifier printed by `adb devices -l`; use it with `adb -s` when more than one device might be connected. |
| APK | Android app installation file. Use a signed APK for installation. |
| Home app | Android's screen shown by the Home button and often after boot. Installing Hearth does not select it. |
| WebView | Android component that displays Hearth's hosted web page inside its wrapper. |
| CalDAV | The protocol used to read and write Apple calendar events. |

## Official references

- [Android Debug Bridge](https://developer.android.com/tools/adb)
- [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools)
- [Android APK signing tool](https://developer.android.com/tools/apksigner)
- [Hearth server and provider setup](SETUP.md)
- [Project history and device limitations](HISTORY.md)
