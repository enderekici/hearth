# Architecture and operating boundaries

Hearth is a Node.js 24 web service with static files under `public/` and provider adapters under `server/`. Its optional Android app is a native WebView host, declares Android HOME and LAUNCHER intent filters, and can be selected as the Home app. Hearth does not flash firmware or select itself as Home; automatic startup is unverified. The project was built in a fresh repository without importing the prior dashboard's Git history.

## Runtime and storage

- Docker builds on the Node.js 24 slim image and runs the service on port 8787.
- Compose reads `.env` for interpolation. `npm start` does not load `.env`; export
  runtime variables explicitly when starting Node directly.
- `DATA_DIR` holds the JSON configuration, provider credentials, caches, and generated thumbnails. Compose mounts it from `HEARTH_DATA_DIR`, defaulting to `./data`.
- `PHOTO_DIR` points to a read-only photo mount. Compose mounts `HEARTH_PHOTO_DIR`, defaulting to `./photos`, at `/app/photos`.
- Compose publishes only to `127.0.0.1` by default. Configure a specific trusted LAN interface through `.env` only when another device needs access. `HEARTH_ALLOWED_HOSTS` must contain the hostname or address used by the browser.
- The container runs as the image's `node` user by default. Ensure the mounted data directory is writable by that runtime user. Do not copy host-specific user IDs or overrides without checking the target Docker setup.

The data directory is private. The configuration file is written atomically with mode `0600` under a directory with mode `0700`. Values are stored as plaintext JSON, not encrypted. Treat the directory and its backups as credential-bearing data. Never commit `.env`, `data/`, credentials, tokens, backups, or photos.

## Security boundary

The HTTP API is intended for one trusted local network and does not implement user login. Host and Origin checks on write routes reduce cross-site requests; they are not authentication and do not protect data from another machine on the same reachable network. The Compose default binds to loopback. Do not publish the service to the public Internet or through an unauthenticated reverse proxy.

Read APIs can return calendar events, school messages, and Spotify metadata for the configured account. Write APIs can change local settings and perform the selected provider operations. Secrets are not returned in API responses or logged by the service. Photo access is restricted to the configured mount; there is no general filesystem API. Original photos are read-only and only optimized copies are written to the data cache.

## Provider behavior

### Calendar

iCloud setup validates the CalDAV principal and requires explicit calendar selection. The service parses iCalendar data, expands recurrence, resolves IANA time zones, and rejects ambiguous or nonexistent local times. Date-only events remain civil dates; timed values are stored and returned as instants. Calendar responses identify stale data and provider errors. Range queries use an inclusive start and exclusive end and are bounded to 62 days.

### School messages and schedule

The school adapter reads messages for display; it does not mark them read or send replies. Registered schedule feeds are partial: they may include academic ranges, registered trip/activity entries, and a club's next session, not a complete term timetable. Unknown coverage remains unknown. A failed or incomplete read retains the last complete cache and skips destructive reconciliation. Calendar writes go only to the operator's explicitly selected destination and are conditional on Hearth ownership; missing rows do not imply cancellation.

The private credential file is `DATA_DIR/mcas-credentials.json`. It is a JSON
object containing `credentials` (an `email` or `username`, plus `password`). An
optional `calendarDestinationURL` enables writes to an explicitly selected CalDAV
collection; it must end in `/` and have no query or fragment. The file must have
mode `0600`, be readable by the service UID, and is never served through the API.
When configured, refresh runs at startup and periodically; the service avoids
overlapping refresh jobs.

### Spotify

Spotify uses OAuth authorization code with PKCE. The Client ID is required; the Client Secret is optional. The redirect URI is `http://127.0.0.1:8787/api/spotify/callback`; for a remote browser, use the SSH tunnel described in [Setup](SETUP.md). Playback control requires a Premium account and an available Spotify Connect device. The UI may be connected while the provider reports no selectable device.

Artwork URLs from Spotify are converted to local proxy references. The proxy allows only the exact image CDN hosts and path forms observed in Spotify responses, rejects redirects, and bounds response size. The artist-albums adapter caps provider requests at 10 items and advances its cursor from the returned page size.

### Weather and photos

Weather uses Open-Meteo for the saved coordinates and time zone. Place search calls a fixed provider endpoint; it does not accept arbitrary URLs. Photo discovery is bounded and asynchronous. Thumbnails are generated in the data directory, never written back to source folders.

## Useful endpoints

- `GET /api/health`, `/api/status`, and `/api/settings`
- `GET /api/calendar` and optional `from`/`to` range parameters
- `GET /api/weather`, `/api/photo-albums`, `/api/photos`
- `GET /api/spotify`, `/api/spotify/search`, `/api/spotify/playlists`, and library routes
- `GET /api/school` and cached message pages; `POST /api/school/sync`

See `server/index.js` for the current route list and request shapes. Error responses use provider status rather than substituting demo data.

## Verification and known limits

The latest local `npm test` run passed 45 tests. The local deployment was checked on a full-size frame viewport and at a narrow phone viewport. Read-only flows covered saved-library browsing, artist search/discography, album tracks, artwork delivery, Now Playing state, and speaker-sheet open/close. Playback and queue requests were browser-intercepted; no live playback or speaker mutation was issued. Real device availability depends on the account and the Connect devices online at the time.

The dashboard page is served successfully in the tested Android WebView, but this repository does not establish that Hearth is the device's default Home app or starts automatically after a cold boot. Android model, firmware, USB/ADB behavior, root status, display scaling, and vendor settings vary. See [History](HISTORY.md) for the tested device scope and gaps; do not infer an unlock, root, SD-card, or boot procedure for another model.
