# Set up Hearth

This guide gets the Hearth dashboard running on a computer or Raspberry Pi and
connects its optional services. It is written for people setting it up by hand
and for an assistant following the same steps. Start with the server, then add
accounts, then connect the frame.

> **Frame owners:** follow [Frame setup and recovery](FRAME_SETUP.md) for the
PF1007 Android device, ADB, backups, APK installation, return controls, and
recovery. Hearth is an app that opens a web page; it is not replacement firmware.

## Before you start

You need a computer or Pi on your home network, Node.js 24 and npm (or Docker
with Compose), and a private folder for Hearth's data. Install Node.js from
<https://nodejs.org/en/download> if you choose the direct Node method. Optional features need
their own accounts: Apple Account, Spotify Premium plus a Spotify developer
app, and the school portal if you use its connector. You can run Hearth without
any of those accounts and add them later.

Hearth's API has no login. Keep it on your home network, do not forward port
8787 from your router, and do not put it directly on the public Internet. Its
data folder contains account credentials and tokens. See [privacy and operation
details](PROCESS.md).

## 1. Start Hearth on a computer or Raspberry Pi

If Hearth is not already on the host, install Git and clone the public
repository there. Run these commands in Terminal on the host:

```sh
git clone https://github.com/enderekici/hearth.git
cd hearth
```

For a fresh Pi, install Docker Engine and the Compose plugin using the official
instructions for the Pi's operating system at
<https://docs.docker.com/engine/install/>. Confirm `docker --version` and
`docker compose version` both work before continuing.

To find the Pi's Linux username, open a terminal on the Pi and run `whoami`.
To find its home-network address, run `hostname -I` and use the address in the
same range as your other home devices (or confirm the Pi's lease in your
router's connected-device list). Ask the router to reserve that address for the
Pi so it does not change. The Pi's network name is shown by `hostname`; test it
from another computer with `ping <PI_HOST>`. Use the exact username and host
name/address in the SSH examples below.

Choose one method.

### Option A: Docker Compose (recommended for a Pi)

On the computer that will host the dashboard, open Terminal and go to the
directory containing this repository. Copy the sample settings and create the
two folders Hearth uses:

```sh
cp .env.example .env
mkdir -p data photos
```

For the first launch, keep the default loopback-only address. Compose runs the
app as the `node` user (UID 1000 by default). On a **rootful Linux Docker** host,
prepare a new data directory before starting Compose:

```sh
sudo install -d -o 1000 -g 1000 -m 0700 ./data
```

Do not run this on an existing data directory until you have checked its owner
and contents. Docker Desktop and rootless Docker use different UID mappings;
do not apply this command blindly to those systems.

For **rootless Docker**, verify rootless mode in `docker info` (the security
options include `rootless`). Do not infer container permissions from the host's
`/proc/self/uid_map`. If your Docker setup maps container UID 0 to your
unprivileged host account, create an ignored local `compose.override.yaml` now:

```yaml
services:
  hearth-dashboard:
    user: "0:0"
```

Check the mount before starting the service:

```sh
docker compose run --build --rm --no-deps --entrypoint sh hearth-dashboard -c 'id; cat /proc/self/uid_map; test -w /app/data'
```

It must exit `0`; `test -w` prints nothing on success. Confirm the container
UID map against your rootless Docker configuration. Never use this override
with rootful Docker, where UID 0 means host root. If the mapping is unclear or
the test fails, stop before changing ownership or starting Hearth.

Now start Hearth:

```sh
docker compose up --build -d
```

The default binds port 8787 to the host itself. To open the dashboard from a
different computer for initial setup, use an SSH tunnel. Replace `pi` and
`pi.local` with the Linux username and network name of your host:

```sh
ssh -N -L 8787:127.0.0.1:8787 pi@pi.local
```

Leave that Terminal window open. On the computer running the tunnel, visit
<http://127.0.0.1:8787/>. If SSH asks whether to trust a new host key, verify
the host fingerprint with the Pi owner before accepting it.

To let the frame connect directly over Wi-Fi, first identify the Pi's stable
home-network address or DNS name. Then edit `.env` on the Pi:

```dotenv
HEARTH_BIND_ADDRESS=<PI_LAN_ADDRESS>
HEARTH_ALLOWED_HOSTS=127.0.0.1,localhost,<PI_LAN_ADDRESS>,<PI_DNS_NAME>
```

For example, if the Pi is `192.168.1.20` and its name is `hearth.local`, use
those exact values. Use only names you control on your home network. Do not use
`*` or a public address. Set the frame's `DASHBOARD_URL` to one of these exact
hosts when building its APK. Restart after editing `.env`:

```sh
docker compose up --build -d
```

If you change the data or photo folders in `.env`, use the full host paths.
The photo folder is mounted read-only. Add photos to it from the Pi or a
trusted file share; then select the folders in Hearth Settings.

### Option B: Run Node directly

Install Node.js 24 and npm, then from this repository run:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:8787/> on that same computer. The server listens on all
network interfaces. If other devices need to reach it, use a host firewall and
only a trusted home network. Do not expose port 8787 publicly.

### Confirm the server is ready

On the host, run:

```sh
curl http://127.0.0.1:8787/api/health
```

You should receive a small JSON health response. If the command fails, check
`docker compose logs --tail=100 hearth-dashboard` for Compose or the Terminal
where `npm start` is running. If Hearth is deliberately bound to a LAN address,
use that address in `curl` instead. Open the dashboard and confirm the Hearth
home page appears before entering account details.

## 2. Open Settings

On the computer or phone you are using, open the dashboard and select **Settings**.
For a direct settings link, use `http://<HOST>:8787/?settings=1`, replacing
`<HOST>` with the same name or address used to open Hearth. On a small screen,
open the settings button in the top bar. The settings page groups controls under
**Look and feel**, **Photo albums**, **Your calendar**, **Weather**, and
**Spotify Connect**.

Use the same exact hostname consistently. For example, do not open the page as
`hearth.local` and then use its IP for an OAuth callback. The server checks the
browser's host and origin against `HEARTH_ALLOWED_HOSTS`.

## 3. Connect Apple Calendar

Hearth signs in to iCloud with an **app-specific password**. Do not enter your
normal Apple Account password.

1. On a computer or phone, go to <https://account.apple.com/> and sign in to
   your Apple Account.
2. Open **Sign-In and Security**.
3. Select **App-Specific Passwords**. If Apple asks, approve with two-factor
   authentication.
4. Choose **Generate an app-specific password** (or **Generate password**),
   give it a label such as `Hearth photo frame`, and generate it.
5. Copy the password Apple shows. Keep this page open until you have saved it in
   Hearth. Apple only shows the generated password at creation time.
6. In Hearth Settings, find **Your calendar**, enter your Apple ID email and
   app-specific password, then select **Connect Apple calendar**.
7. When the list appears, tick the calendars you want, then select **Save
   selection** under **Choose calendars**.
8. Confirm that the calendar connection is shown as connected and that an event
   you recognize appears. Calendar data may take a short time to load.

If **App-Specific Passwords** is missing, confirm that two-factor
authentication is enabled on the Apple Account. If Apple rejects a password,
check that you pasted the generated app-specific password, not your normal
password, and that there are no extra spaces. Changing the main Apple Account
password revokes existing app-specific passwords; generate a new one and
reconnect Hearth if that happens. Apple instructions:
<https://support.apple.com/102654>.

Hearth stores this credential in its private data directory. It is not shown
again in Settings. To replace it, enter the replacement in Settings; do not put
it in a terminal command, document, screenshot, or Git file.

## 4. Connect Spotify

Spotify uses an official Spotify developer application and the account's own
Spotify Connect devices. Playback control requires Spotify Premium.

### Create the Spotify app

1. On a computer, sign in at <https://developer.spotify.com/dashboard> with
   the Spotify account you want Hearth to control.
2. Choose **Create app** and enter a name (for example, `Hearth at home`) and a
   short description. For the redirect URI, enter this exact value:

   ```text
   http://127.0.0.1:8787/api/spotify/callback
   ```

3. Save the app. Open its **Settings** and copy the **Client ID**. Do not copy
   the Client Secret into a public file. Hearth uses PKCE; a Client Secret is
   optional and should generally be left unset.
4. In Hearth Settings, find **Spotify Connect**, enter the Client ID, select
   **Save Client ID**, then select **Connect Spotify account**.

Spotify changes who can use developer apps from time to time. If Spotify asks
for a user allowlist or app-mode setting, add the Spotify account you will use
with Hearth and follow the current instructions shown in your Spotify
Developer Dashboard. The account needs Premium for playback control. Spotify
reference pages: [create and manage apps](https://developer.spotify.com/documentation/web-api/concepts/apps),
[redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri),
and [quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

### Authorize Spotify from a computer

For a Pi or other remote host using the default loopback-only Compose port,
open a second Terminal on your computer and start an SSH tunnel. Replace
`pi` and `pi.local` with your host's username and name:

```sh
ssh -N -L 8787:127.0.0.1:8787 pi@pi.local
```

Keep the tunnel open. In that same computer's browser, go to
<http://127.0.0.1:8787/?settings=1>, find **Spotify Connect**, and select
**Connect Spotify account**. Review the requested access on Spotify's page and approve.
When Spotify returns to the local callback, Hearth should report that Spotify
is connected. Do not start this authorization in the frame's browser: the
callback must return to the computer's `127.0.0.1` address through the tunnel.

If you changed the Compose bind address to the Pi's LAN address, set the SSH
forward target to that exact address:

```sh
ssh -N -L 8787:<PI_LAN_ADDRESS>:8787 pi@<PI_HOST>
```

Keep `127.0.0.1` and `localhost` in `HEARTH_ALLOWED_HOSTS` for the browser's
local Spotify callback, along with the LAN host or address used by the frame.

In **Spotify Connect** settings, select **Find speakers**. Open Spotify in the
Hearth dashboard and confirm your library loads. To play, turn on Spotify on the
living-room speaker (or another Spotify Connect device)
and choose that device in Hearth. If no speaker is listed, start Spotify on the
speaker once, confirm it is on the same home network, then refresh Hearth's
Spotify view. Spotify controls devices that Spotify itself reports; Hearth
does not pair Bluetooth speakers.

If the callback fails, check that the redirect URI matches character-for-
character, the tunnel is still running, the dashboard host and tunnel port are
correct, and your computer can open `http://127.0.0.1:8787/`. Start a fresh
authorization after correcting the issue.

## 5. Add photos, videos, and weather

### Photos and videos

Copy photos and `.mp4` files into the host's selected media folder. With the
default Compose configuration this is the repository's `photos/` directory.
Hearth includes MP4 files in the same folder and album selection as photos;
video-only folders are selectable too. The catalog is bounded, and each video
is streamed from the read-only source file with HTTP byte-range support. Hearth
does not transcode video or install a video conversion tool. Generated photo
thumbnails are stored in the private data directory.

For the tested PF1007 running Android 6 and WebView 106, begin with H.264
Baseline video and AAC audio at 480p and 24 fps. That combination visibly played
on the frame. H.264/AAC at 720p and 30 fps also played, but a short, uncontrolled
sample showed dropped frames, so it is a less reliable starting point. These
observations cover one frame and do not guarantee that every MP4, profile, or
bitrate will play. Server tests verify byte and range delivery separately from
device decoding. See [the frame test record](FRAME_SETUP.md#video-playback-check)
for the limits of the playback evidence.

On the dashboard, open **Settings → Photo folders and videos**, tick the
folders you want, and select **Save photo folders**. If the list is empty,
verify that the host folder contains supported image or MP4 files and that the
container can read them; the mount inside the container is read-only.

Videos start muted. Select the speaker control to turn on video audio. The
frame's audio service reported active PCM output routed to its speaker after
unmuting; in a later retest, a listener confirmed hearing three beeps. The
system route report and acoustic observation are separate checks. The
slideshow waits for a video to finish before advancing; the pause control pauses
the current video or the image slideshow. If a clip uses an unsupported format,
Hearth shows an error and offers **Next** to continue. Convert such files to a
compatible MP4 outside Hearth; the server does not transcode them.

### Weather and location

Open **Settings → Weather**, type your town or postcode in **City or place**,
select **Find**, choose the matching result, then select **Save location**.
Hearth displays current conditions and opens an expanded view with forecast
details when you select the weather panel.
Location search and weather data use Open-Meteo. If a location cannot be found,
try a nearby town or a fuller place name, and check that the host has Internet
access.

### Theme, date and time

Under **Look and feel**, choose a palette and select **Follow the day**,
**Always daylight**, or **Always night**. **Follow the day** switches at the
configured **Day begins** and **Night begins** times. Hearth displays the clock
and date in 24-hour format. On the Android wrapper, the frame also has a separate
screen brightness control; see [Frame setup](FRAME_SETUP.md).

## 6. Optional school messages and schedule

The school connector is optional and more technical than the other settings.
It reads school messages and available schedule data. It does not mark messages
read or send replies. The supported credentials are provisioned as a private
file on the server host; they are not entered in the public dashboard.

Only continue if the portal login is yours to use and you can store it securely
on the Pi. Create `mcas-credentials.json` inside Hearth's private data directory
with this structure, replacing placeholders locally:

```json
{
  "credentials": {
    "email": "<SCHOOL_LOGIN_EMAIL>",
    "password": "<SCHOOL_PASSWORD>"
  }
}
```

Use `username` instead of `email` if that is what the school portal requires.
Restrict the file to the account that runs Hearth (mode `0600`) and make sure
the data directory itself is private (mode `0700`). On the Pi, use a local text
editor to create the file, save it at `<HEARTH_DATA_DIR>/mcas-credentials.json`,
then set its permissions with `chmod 600 <HEARTH_DATA_DIR>/mcas-credentials.json`.
For a rootful Compose host using the default image user, ensure the file owner
is UID 1000 (`sudo chown 1000:1000 <HEARTH_DATA_DIR>/mcas-credentials.json`);
for rootless Docker, use the confirmed host mapping from the earlier setup step.
The file must be visible at that path and readable by the container's configured
user. Do not paste the real login into a shell
command, a support message, this guide, or Git. Restart the container after
creating or replacing the file, then check **School** in the dashboard.

By default, the connector reads and displays messages/schedule data but does
not write events to a calendar. Calendar writing requires an explicitly chosen
Apple CalDAV calendar collection URL. To find the URL for a particular
calendar, open your own trusted Hearth instance in a private browser window.
Open browser developer tools, choose **Console**, and run:

```js
fetch('/api/calendars').then(r => r.json()).then(x => console.table(x.calendars.map(c => ({name: c.name, id: c.id}))))
```

Match the displayed `name` to the exact calendar you intend to use, then use
that row's `id` as the URL. The `id` is a private CalDAV collection URL: do not
paste it into chat, logs, screenshots, Git, or this guide. Use it exactly if it
already ends in `/`; otherwise add one trailing `/`. If names are similar,
stop and identify the correct calendar in Apple Calendar first. Do not guess
the URL or choose the first calendar discovered. If you cannot verify the exact
collection, leave out `calendarDestinationURL` and use read-only school display.
To enable writes, add the selected URL to the credentials file, preserving the
trailing slash:

```json
{
  "credentials": {
    "email": "<SCHOOL_LOGIN_EMAIL>",
    "password": "<SCHOOL_PASSWORD>"
  },
  "calendarDestinationURL": "<THE_SELECTED_CALENDAR_ID_WITH_TRAILING_SLASH>"
}
```

After saving the file, restart Hearth, open **School**, and select **Refresh
school data**. Inspect the selected calendar for school events and compare them
with the portal. If you chose the wrong calendar, correct or remove the
destination field to prevent future writes, then inspect Apple Calendar and
manually remove any events already created in the wrong calendar. The connector
only imports schedule data that the school adapter exposes; it is not guaranteed
to be a complete academic or clubs calendar.

The credential file may contain sensitive school and family information. Back
it up only in encrypted/private storage and delete temporary copies securely.

## 7. Connect the Android frame

Use the [PF1007 frame setup and recovery guide](FRAME_SETUP.md). In brief, that
guide explains how to check the cable and USB ADB connection, make private
read-only backups, build and install the Hearth wrapper, grant Android's return
overlay permission, and set the Home app. It also marks which hardware steps
are device-specific or still unverified. The frame needs no SD card for the
recommended Android setup.

## Useful checks and safe recovery

- Check service health: `curl http://127.0.0.1:8787/api/health` on the host.
- View Compose logs: `docker compose logs --tail=100 hearth-dashboard`.
- Restart without deleting app data: `docker compose restart`.
- Stop the app and keep data/photos: `docker compose down`.
- Do not delete, rename, or replace the data directory to troubleshoot a
  provider. It contains credentials and tokens. Back it up privately first.
- If an account stops connecting, use that provider's Hearth Settings flow to
  reconnect. Never copy token files between deployments.

## Short glossary

| Term | Meaning here |
|---|---|
| Host / server | The Raspberry Pi or computer running Hearth's Node service and storing its data/photos. |
| Frame | The PF1007 screen running the Android Hearth wrapper. |
| LAN | Your private home network. Use its stable Pi address or name; do not forward Hearth or ADB ports through your router. |
| App-specific password | A password Apple creates for one app, separate from your normal Apple Account password. |
| Client ID | The public identifier for the Spotify developer app. Hearth needs it to start Spotify sign-in. |
| SSH tunnel | A temporary encrypted connection from your computer's `127.0.0.1:8787` to the Pi, used for Spotify's local callback. |
| ADB | Android Debug Bridge, a developer tool used to inspect/install apps on the frame. See the frame guide before connecting. |
| CalDAV collection URL | A private URL identifying one Apple calendar. Only use the exact URL for the calendar you selected. |

## References

- [Frame setup and recovery](FRAME_SETUP.md)
- [Architecture and privacy](PROCESS.md)
- [Project history and known limits](HISTORY.md)
- [Apple app-specific passwords](https://support.apple.com/102654)
- [Spotify developer dashboard](https://developer.spotify.com/dashboard)
