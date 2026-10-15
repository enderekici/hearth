# Project history

This is a sanitized chronology of the frame-dashboard work. It records the
decisions and verified outcomes that led to Hearth, not a device-specific repair
manual. It omits serials, MAC/IP addresses, credentials, private records, and
personal calendar, school, and music data.

## Starting with the frame

The work started from the public
[wesbos/photo-frame-dashboard](https://github.com/wesbos/photo-frame-dashboard)
prototype and the public Linux
[pangoleen/ormarch-picture-frame](https://github.com/pangoleen/ormarch-picture-frame)
project. The prototype informed the visual direction; neither repository establishes
compatibility with a particular frame. The tested unit was a PF1007 frame with an
Allwinner A33, Android 6, AiMOR vendor interface, and May 2026 firmware. These are
model/platform details, not unique device identifiers.

Early cable and settings attempts did not provide a reliable development
connection. A replacement data cable later enabled USB ADB; no password bypass or
firmware exploit was involved. Before changing boot media or system software, the
full eMMC user area and boot, recovery, system, boot0, and boot1 partitions were
copied, reread, and checked. RPMB was not captured, and the live user-data copy is
not an offline-consistent snapshot. All images and verification receipts remain
outside this repository.

## Linux removable-media experiment

A community Linux image was adapted for the frame's display, touch controller,
power-management chip, and Wi-Fi hardware. The experiment kept internal storage
disabled and read-only. An early minimal profile intentionally showed a black
screen; the fuller profile brought up the display, touch, networking, and a browser
kiosk. It ran from removable media and did not replace Android.

Touch measurements found a reflected vertical axis and a repeatable offset. A
calibration improved most test points, while one point remained visibly inaccurate.
The browser experience was slower than desired. A separate browser-engine trial
passed a small JavaScript probe but did not initialize the dashboard consistently.
The Linux image remains an isolated experiment, not an installation path for other
frames. The early minimal profile showed a black screen by design; the full image
later brought up the display, touch, network, and kiosk browser.

## Android WebView and hosted page

Returning to Android restored the stock boot path. The bundled WebView 44 was too
old for the dashboard, and a normal update to WebView 106 failed because its signing
key differed. A device-specific system-provider replacement was tested, its original
files retained privately, and the system partition returned to read-only. This is
historical work, not a recommendation to replace WebView on another frame.

A small native Android WebView host was then used to show a remotely served page.
It provided a full-screen view and simple recovery controls. The Linux display
calibration and Android WebView changes were separate experiments. Android's
WebView was more responsive in the measured dashboard interaction, so it became
the preferred display environment. The earlier measurement was a scripted route
and scroll comparison, not a controlled hardware benchmark.

An initial serverless calendar prototype used Cloudflare Workers. It proved that
authenticated private calendar reads could reach the frame. After that prototype
worked, hosting moved to the available Raspberry Pi at the operator's request; the
Worker resources and credentials were retired. During principal validation, Apple's
CalDAV endpoint returned HTTP 401 for the primary account password. The operator
was informed, that secret was removed, and a generated Apple app-specific password
was used instead. No deployed settings, credentials, or provider data were copied
into this repository. The current setup also requires an Apple app-specific
password, never the primary account password.

## Hearth on a local server

The design moved to a Node.js 24 service on a Raspberry Pi, with the frame acting as
a browser client. The service owns provider connections and local caches; the frame
does not receive provider credentials. Photos are mounted read-only, and optimized
thumbnails are written to the private data directory. A fresh source tree was
created without importing the prior repository's Git history.

The service gained real iCloud CalDAV discovery, explicit calendar selection,
recurrence expansion, timezone handling, and bounded calendar-range requests.
Date-only events remain civil dates, and ambiguous or nonexistent local times are
rejected. Settings are validated and written atomically. The dashboard shows stale
or provider-error state instead of substituting sample data.

Weather and place search use fixed Open-Meteo endpoints. The photo catalog scans
asynchronously and returns a bounded selection. School integration reads messages
and limited registered schedule sources; it does not send messages or mark them
read. Calendar writes are restricted to an explicitly selected destination and
Hearth-owned entries. A missing or partial source feed does not trigger broad
cancellation.

The school provider is MyChildAtSchool (MCAS). The adapter currently expects exactly
one linked pupil and fails closed when the portal returns multiple linked pupils.
Its registered schedule sources are partial; the adapter does not claim to expose a
complete school diary or term timetable.

Spotify Connect support began with OAuth authorization using PKCE. An early callback
regression referenced a renamed timeout-fetch helper; a controlled HTTP callback
test reached the real default-fetch path and caught it. Later work added
search, saved-library browsing, album and artist views, queue controls, artwork
proxying, and speaker selection. Artwork proxying was restricted to observed Spotify
image hosts and paths, with redirects and oversized responses rejected. The
provider's artist-albums endpoint rejected a 50-item request; the adapter now caps
that endpoint at 10 and paginates using the effective response size. Provider
permissions are shown from granted
scopes; access requiring an ungranted scope remains unavailable until the account
owner consents. The UI does not invent recommendations, lyrics, videos, or device
availability.

The final interface was tested on the frame viewport and a narrow phone viewport.
The service and Android host are now maintained in this fresh repository. The
frame's default Home-app selection and automatic launch after a cold boot are not
established by this project history.

## Wireless ADB finding

For one device-specific test, the TCP ADB port property was set to 5555 over USB,
then the daemon was switched to TCP mode. Serial and root access were verified
after reboot and again after USB was removed and the frame was powered from its
wall supply. The Wi-Fi driver changed the MAC address and DHCP lease across
reboots, so discovery used the verified serial rather than a cached IP. The build
reported `ro.adb.secure=0`, making that TCP service unauthenticated root access on
the trusted LAN. This is a serious device security risk, not a Hearth requirement.
Do not enable it for routine use or forward it through a router; the sequence is
recorded as a finding, not a setup instruction for another frame.

## Known gaps

- Android firmware and vendor settings differ. The documented hardware work does
  not establish a universal ADB, root, WebView replacement, or recovery procedure.
- A Linux image was tested only as an isolated removable-media experiment. It is
  not a supported fallback or installation guide.
- The kiosk displays the dashboard, but Hearth has not been verified as the device's
  default Home app or as an automatic cold-boot launch target.
- School schedule data is partial: coverage depends on the registered source feeds
  and may include only a club's next session. It is not a complete term timetable.
- Spotify's available library and playback features depend on the account's granted
  scopes, subscription, and currently available Connect devices.
