# Hearth

Hearth is a Node.js 24 dashboard for a home photo frame. It combines a photo slideshow with calendar, weather, school-notification, and Spotify Connect views. The dashboard is a web app served on the local network; it is not a device firmware image.

This repository starts from a fresh source tree and does not import the previous dashboard's Git history. For the project chronology, see [History](docs/HISTORY.md). For reproducible setup, see [Setup](docs/SETUP.md). Architecture and privacy boundaries are in [Process](docs/PROCESS.md).

## Quick start

Requirements: Node.js 24 and npm.

```sh
npm ci
npm test
npm start
```

The local server listens on port 8787. Open `http://127.0.0.1:8787/` on the same machine. Docker Compose also defaults to loopback; use `.env.example` as a guide before choosing a trusted LAN interface.

## Integrations

- iCloud Calendar uses an Apple app-specific password. The main Apple Account password is rejected.
- Spotify uses OAuth authorization code with PKCE. A Client ID is required; a Client Secret is optional.
- School messages are read-only. Calendar writes are limited to the explicitly selected calendar and Hearth-owned events.
- Photos are mounted read-only; generated thumbnails are stored in the private data directory.

All service data is local to the operator's deployment. No account credentials, calendar contents, school data, or personal photos belong in this repository. The HTTP API is designed for a trusted local network and does not provide user authentication; see the security limits in [Process](docs/PROCESS.md).
