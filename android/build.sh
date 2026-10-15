#!/usr/bin/env bash
set -euo pipefail
ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
BUILD_TOOLS="${BUILD_TOOLS:-$ANDROID_HOME/build-tools/36.0.0}"
PLATFORM="${PLATFORM:-$ANDROID_HOME/platforms/android-23}"
JAR="$PLATFORM/android.jar"
OUT="$(cd "$(dirname "$0")" && pwd)/build"
SOURCE="$(cd "$(dirname "$0")" && pwd)"
DASHBOARD_URL="${DASHBOARD_URL:-http://hearth.local:8787}"

if [[ ! "$DASHBOARD_URL" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; then
  echo "DASHBOARD_URL must be an http(s) origin with a hostname or IPv4 address and optional port" >&2
  exit 2
fi
if [[ "$DASHBOARD_URL" =~ :([0-9]+)/?$ ]]; then
  URL_PORT="${BASH_REMATCH[1]}"
  if (( 10#$URL_PORT < 1 || 10#$URL_PORT > 65535 )); then
    echo "DASHBOARD_URL port is out of range" >&2
    exit 2
  fi
fi

if [[ ! -f "$JAR" ]]; then echo "Missing Android platform jar: $JAR" >&2; exit 2; fi
for tool in aapt2 d8 zipalign apksigner; do
  [[ -x "$BUILD_TOOLS/$tool" ]] || { echo "Missing build tool: $BUILD_TOOLS/$tool" >&2; exit 2; }
done
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes"
mkdir -p "$OUT/gen/com/enderekici/hearth"
cat > "$OUT/gen/com/enderekici/hearth/DashboardConfig.java" <<EOF
package com.enderekici.hearth;

final class DashboardConfig {
    static final String URL = "$DASHBOARD_URL";
    private DashboardConfig() {}
}
EOF
"$BUILD_TOOLS/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest "$SOURCE/AndroidManifest.xml" \
  --min-sdk-version 23 --target-sdk-version 23 --version-code 1 --version-name 1.0 \
  --java "$OUT/gen"
javac -nowarn -source 8 -target 8 -classpath "$JAR" -d "$OUT/classes" \
  "$SOURCE"/src/com/enderekici/hearth/*.java "$OUT/gen/com/enderekici/hearth/R.java" \
  "$OUT/gen/com/enderekici/hearth/DashboardConfig.java"
"$BUILD_TOOLS/d8" --min-api 23 --lib "$JAR" --output "$OUT" $(find "$OUT/classes" -name '*.class' -print)
(cd "$OUT" && zip -q base.apk classes.dex)
"$BUILD_TOOLS/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
KEYSTORE="${KEYSTORE:-$HOME/.android/debug.keystore}"
if [[ -f "$KEYSTORE" ]]; then
  "$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
    --out "$OUT/hearth.apk" "$OUT/aligned.apk"
  echo "$OUT/hearth.apk"
else
  cp "$OUT/aligned.apk" "$OUT/hearth-unsigned.apk"
  echo "$OUT/hearth-unsigned.apk (unsigned; no existing local debug keystore)"
fi
