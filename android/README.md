# Android kiosk

This native Android 6 (API 23) app is a WebView wrapper for the separately hosted Hearth dashboard. It loads `http://hearth.local:8787` by default. For a hostname configuration, the frame must resolve that name to the dashboard server, and the server's `ALLOWED_HOSTS` must include that exact hostname (set through `HEARTH_ALLOWED_HOSTS` in the Compose deployment). Requests with unlisted hosts receive HTTP 403.

```sh
DASHBOARD_URL=http://hearth.local:8787 ./build.sh
```

`DASHBOARD_URL` accepts one `http` or `https` origin with a hostname or IPv4 address and an optional port. It cannot include credentials, a path, query, or fragment. Configuring an `https` URL does not enable HTTPS on the dashboard server; the current LAN deployment uses HTTP. The WebView bridge and navigation checks use the exact configured scheme, host, and effective port. External navigation stays blocked; only the dashboard's Open-Meteo place search and Spotify artwork are allowed as external HTTPS subresources.

The manifest requests `INTERNET` for the dashboard WebView, permits cleartext traffic for the current LAN HTTP endpoint, and registers the app as a possible Android HOME launcher. That intent filter makes Hearth eligible to be selected as the home app; installation does not set it as the device's default or verify cold-boot startup. It also declares `SYSTEM_ALERT_WINDOW` for the Return overlay, which requires the device user/operator to grant overlay permission. The overlay provides a return control while Android Settings or AiMOR is open. These permissions support dashboard access and kiosk navigation.

WebView remote debugging is disabled on normal launches. It is enabled only when the app is explicitly started with the boolean `debug` intent extra set to `true`.

Build with the local Android SDK and JDK 17. The build signs with an existing local `~/.android/debug.keystore`; it never creates or stores a keystore in this repository. If that file is absent, the build emits `build/hearth-unsigned.apk`.
