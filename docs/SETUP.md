# Setup

This guide runs Hearth as a local Node.js service or Docker Compose app and connects
optional provider accounts. Keep the service on a trusted network: its HTTP API has
no user login. See [Process](PROCESS.md) for the security boundary and
[History](HISTORY.md) for known device limitations.

## Requirements

- Node.js 24 and npm for local development.
- Docker Engine with the Compose plugin for container deployment.
- A writable private data directory and a read-only photo directory.
- Optional provider accounts for iCloud Calendar, Spotify, and the school portal.
- For a frame client, an Android WebView that supports the dashboard and network
  access to the server.

## Run locally

```sh
npm ci
npm test
npm start
```

Open `http://127.0.0.1:8787/` on the same computer. The Node server listens on all
container interfaces; use a host firewall and trusted network when running it
directly. For a local-only deployment, Compose publishes on loopback by default.

## Run with Docker Compose

Copy the sample environment file and review each path before starting:

```sh
cp .env.example .env
mkdir -p data photos
docker compose up --build -d
```

By default, Compose exposes the app only on `127.0.0.1:8787`, stores application
data in `./data`, and mounts `./photos` read-only. Put real photos in the selected
photo directory; the directory is ignored by Git. To let a frame on the LAN reach
the service, set `HEARTH_BIND_ADDRESS` to the server's trusted LAN interface address
and add the exact hostname/address used by the browser to `HEARTH_ALLOWED_HOSTS`.
Do not use a wildcard or expose port 8787 to the public Internet. `HEARTH_DATA_DIR`
and `HEARTH_PHOTO_DIR` can point to other host paths. The application data directory
contains plaintext credentials and tokens; back it up privately and restrict access.
Create and protect the data directory before setup. The app expects a private data
directory and a writable mount; the image runs as user `node` by default. Check the
actual UID mapping on your Docker engine before changing host ownership. Rootful and
rootless Docker map container users differently.

For a confirmed rootless Docker engine only, inspect the user-namespace mapping and
verify that container UID 0 maps to the unprivileged host account that owns the
data directory. If that mapping is confirmed, a local, untracked
`compose.override.yaml` can use this override so the process can access the
directory:

```yaml
services:
  hearth-dashboard:
    user: "0:0"
```

Do not use this override with rootful Docker: there it runs the app as host root.
Override files are ignored by Git and Docker's build context.

Check the service:

```sh
curl http://127.0.0.1:8787/api/health
docker compose logs --tail=100 hearth-dashboard
```

The curl example uses the loopback default. If you deliberately bind to a trusted
LAN interface, query that configured address instead.

## Connect the frame

The optional Android app is a simple WebView wrapper, not firmware. Build it with
JDK 17 and an Android SDK containing API 23 and the required build tools. Set
`ANDROID_HOME` and, if needed, `BUILD_TOOLS` and `PLATFORM`; the script's defaults
are local-development defaults and may need adjustment for your SDK installation.

```sh
DASHBOARD_URL=http://frame-host.local:8787 ./android/build.sh
```

Replace `frame-host.local` with a hostname or IPv4 address reachable from the
frame. The build writes an APK under `android/build/`. If a local Android debug
keystore already exists, the script uses it; otherwise it produces an unsigned APK.
Install using the Android SDK's normal device-management workflow and the exact
device identifier shown by your own `adb devices` command. This guide does not
enable ADB, unlock the bootloader, modify system partitions, or set the app as the
device's Home application. Those steps are firmware-specific and outside the
supported setup.

On the dashboard, open Settings to select photo folders, theme, and optional
providers. For a Pi deployment, use a local browser or the Android app on the same
trusted network. Keep the Compose bind address and `ALLOWED_HOSTS` consistent with
the address used by the browser.

## iCloud Calendar

In Apple Account security settings, generate an app-specific password for this
application. Do not enter the main Apple Account password. In Hearth Settings, enter
the account email and app-specific password, connect, then explicitly select the
calendars to show. Secrets are saved in the private data directory and are never
returned by the settings API. Re-enter credentials through the setup form if they
need to be replaced; do not edit or print credential files in a shell transcript.

Calendar selection can be changed later in Settings. Event ranges are bounded, and
provider errors or stale-cache state remain visible. iCloud setup does not grant the
dashboard access to every calendar unless each is selected.

## Spotify Connect

Create a Spotify developer application and add this redirect URI exactly:

```text
http://127.0.0.1:8787/api/spotify/callback
```

In Hearth Settings, save the application's Client ID. A Client Secret is optional;
authorization uses PKCE. To authorize from a computer while the service runs on a
remote host, open an SSH local-forward tunnel in one terminal:

```sh
hearth_host=frame-host.local
hearth_user=your-user
ssh -N -L "8787:${hearth_host}:8787" "${hearth_user}@${hearth_host}"
```

Then open `http://127.0.0.1:8787/#settings` in that same computer's browser and use
Connect Spotify. Do not start the OAuth flow from the frame browser: Spotify must
return to the loopback address through the tunnel. Library and playback capabilities
depend on the permissions granted during consent; use the settings flow to reconnect
if Hearth reports missing permissions. Playback also requires Premium and an
available Spotify Connect device.

## School messages and schedule

The school adapter is optional and reads portal messages for display; it does not
mark messages read or send replies. If enabled for your deployment, provision the
credential file at `DATA_DIR/mcas-credentials.json` with mode `0600` inside a
directory restricted to its owner. The JSON shape is:

```json
{
  "credentials": {
    "email": "<SCHOOL_LOGIN>",
    "password": "<SCHOOL_PASSWORD>"
  },
  "calendarDestinationURL": "<EXPLICIT_SELECTED_CALDAV_COLLECTION_URL>"
}
```

The adapter also accepts a `username` field instead of `email`. Supply the exact
destination collection selected by the operator; do not point it at an inferred or
first-discovered calendar. Never put a real password in shell arguments, command
history, this repository, or a support log. Calendar synchronization is conditional
on having both the school file and an iCloud connection. The source feeds are
partial and do not constitute a complete term schedule.

## Recovery and operation

- `docker compose restart` restarts the container without deleting data.
- `docker compose down` stops it but preserves the host data/photo directories.
- Before replacing or moving `DATA_DIR`, take a private backup and preserve its
  restrictive permissions. It contains plaintext secrets, tokens, and cache data.
- If a provider reports an error, use its Settings connection flow rather than
  copying tokens between machines. A restart can invalidate a pending Spotify
  authorization callback; start a fresh Connect flow if that occurs.
- Do not troubleshoot a frame by enabling Wi-Fi ADB on a general-purpose network.
  On the tested old Android firmware, the Wi-Fi ADB service granted unauthenticated
  root to clients on the trusted LAN. Keep that capability disabled and unexposed.
