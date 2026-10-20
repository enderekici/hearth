# Hearth

Hearth is a Node.js 24 calendar for a home photo frame. The default screen is a full-page weekly calendar with large event text, 24-hour times, and day/night themes. Month and Agenda views are also available. Calendar settings let you select which iCloud calendars to display.

The full dashboard, including photos, local MP4 videos, weather, school notifications, and Spotify Connect, remains at `/dashboard.html`. Open it from Calendar settings. The calendar home screen only requests calendar data and settings; it does not run the slideshow or poll Spotify and weather. Hearth is a web app served on the local network, not a device firmware image.

This repository starts from a fresh source tree and does not import the previous dashboard's Git history. [History](docs/HISTORY.md) is a narrative of one tested frame, not a universal hardware-repair guide. For reproducible setup, start with [server and account setup](docs/SETUP.md), then follow [PF1007 frame setup and recovery](docs/FRAME_SETUP.md). Architecture and privacy boundaries are in [Process](docs/PROCESS.md).

## Quick start

Requirements: Node.js 24 and npm. For the Raspberry Pi/Docker route and frame
instructions, use the setup guides linked above.

```sh
npm ci
npm test
npm start
```

The local server listens on port 8787 on all interfaces. Open `http://127.0.0.1:8787/` on the same machine. The API has no user authentication, and read routes return configured account data; run it only on a trusted network and use a host firewall. Docker Compose defaults to loopback; use `.env.example` as a guide before choosing a trusted LAN interface.

## Integrations

- iCloud Calendar uses an Apple app-specific password. The main Apple Account password is rejected.
- Spotify uses OAuth authorization code with PKCE. A Client ID is required; a Client Secret is optional.
- School messages are read-only. Calendar writes are limited to the explicitly selected calendar and Hearth-owned events.
- Photos and MP4 videos are served from the read-only media folder; generated photo thumbnails are stored in the private data directory. See [adding media](docs/SETUP.md#photos-and-videos).

All service data is local to the operator's deployment. No account credentials, calendar contents, school data, or personal photos belong in this repository. The HTTP API is designed for a trusted local network and does not provide user authentication; see the security limits in [Process](docs/PROCESS.md).

Project license: not yet selected. Dependency notices are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
