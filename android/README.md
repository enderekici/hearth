# Android kiosk

The app targets Android 6 (API 23) and loads `http://hearth.local:8787` by default. The host must resolve to the dashboard server from the frame.

Build with the local Android SDK and JDK 17:

```sh
DASHBOARD_URL=http://frame-host.local:8787 ./build.sh
```

`DASHBOARD_URL` accepts one `http` or `https` origin with a hostname or IPv4 address and an optional port. It cannot include credentials, a path, query, or fragment. The WebView bridge and navigation checks use that exact configured scheme, host, and effective port. External navigation stays blocked; the dashboard's Open-Meteo place search and Spotify artwork are the only external HTTPS subresources allowed.

The build signs with an existing local `~/.android/debug.keystore`. It never creates or stores a keystore in this repository. If that file is absent, the build emits `build/hearth-unsigned.apk`.
